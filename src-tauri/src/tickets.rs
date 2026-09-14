//! Bug reports and feature requests, filed with the Gilroy Digital ticket API.
//!
//! Sent from here rather than from the page because the API doesn't answer
//! CORS preflights from `tauri://localhost`, so a `fetch` in the webview never
//! reaches it.
//!
//! The only key in this file is `BUSINESS_REF`, which can create tickets and
//! nothing else, so it's safe in a public repo. The read key must never be
//! added here. It lives in the gitignored TICKETS.md.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;

const TICKET_API: &str = "https://backend.gilroy.digital/api/public/tickets/";
const BUSINESS_REF: &str = "c13c6133-b023-4c75-828e-6fd2307fd70a";

// Copies of the server's limits, checked again here so a bad file is refused
// before it is uploaded. Keep these the same as or stricter than the server's.
const MAX_FILES: usize = 5;
const MAX_FILE_BYTES: usize = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES: usize = 25 * 1024 * 1024;
const ALLOWED_EXT: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "pdf", "txt", "log", "csv", "json", "har",
];

#[derive(Deserialize)]
pub struct Attachment {
    name: String,
    /// File contents, base64-encoded by the page.
    data: String,
}

#[derive(Deserialize)]
pub struct TicketInput {
    #[serde(rename = "type")]
    kind: String,
    title: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    severity: Option<String>,
    #[serde(default)]
    is_urgent: bool,
    #[serde(default)]
    email: Option<String>,
    /// The Log panel's text, present only if the reporter left it ticked.
    #[serde(default)]
    log: Option<String>,
    #[serde(default)]
    attachments: Vec<Attachment>,
}

fn macos_version() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("sw_vers")
            .arg("-productVersion")
            .output()
            .ok()?;
        let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
        (!v.is_empty()).then_some(v)
    }
    #[cfg(not(target_os = "macos"))]
    None
}

/// Pulls a readable reason out of an error response. The API uses `message`
/// or `detail`, or DRF-style `{field: [errors]}`.
fn error_message(status: reqwest::StatusCode, body: &str) -> String {
    if let Ok(v) = serde_json::from_str::<Value>(body) {
        for key in ["message", "detail", "error"] {
            if let Some(s) = v.get(key).and_then(Value::as_str) {
                return s.to_string();
            }
        }
        if let Some(obj) = v.as_object() {
            for (field, errs) in obj {
                let first = errs
                    .as_array()
                    .and_then(|a| a.first())
                    .and_then(Value::as_str)
                    .or_else(|| errs.as_str());
                if let Some(msg) = first {
                    return format!("{field}: {msg}");
                }
            }
        }
    }
    if status.as_u16() == 429 {
        return "Too many reports sent recently. Please try again later.".into();
    }
    format!("The support service returned {status}.")
}

fn decode_attachments(files: &[Attachment]) -> Result<Vec<(String, Vec<u8>)>, String> {
    if files.len() > MAX_FILES {
        return Err(format!("Attach {MAX_FILES} files at most."));
    }
    let mut total = 0;
    let mut out = Vec::with_capacity(files.len());
    for f in files {
        let name = f.name.rsplit(['/', '\\']).next().unwrap_or(&f.name).to_string();
        let ext = name.rsplit_once('.').map(|(_, e)| e.to_lowercase()).unwrap_or_default();
        if !ALLOWED_EXT.contains(&ext.as_str()) {
            return Err(format!("{name}: that file type isn't accepted."));
        }
        let bytes = B64
            .decode(&f.data)
            .map_err(|_| format!("{name}: couldn't read the file."))?;
        if bytes.is_empty() {
            return Err(format!("{name}: the file is empty."));
        }
        if bytes.len() > MAX_FILE_BYTES {
            return Err(format!("{name}: too large — 10 MB is the limit."));
        }
        total += bytes.len();
        out.push((name, bytes));
    }
    if total > MAX_TOTAL_BYTES {
        return Err("Attachments come to more than 25 MB together.".into());
    }
    Ok(out)
}

#[tauri::command]
pub async fn submit_ticket(app_handle: tauri::AppHandle, ticket: TicketInput) -> Result<Value, String> {
    let title = ticket.title.trim();
    if title.is_empty() {
        return Err("Give it a one-line title.".into());
    }
    let kind = if ticket.kind == "feature" { "feature" } else { "bug" };
    let email = ticket
        .email
        .as_deref()
        .map(str::trim)
        .filter(|e| !e.is_empty())
        .map(str::to_string);

    let mut data = json!({
        "app_version": app_handle.package_info().version.to_string(),
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "macos_version": macos_version(),
    });
    if let Some(log) = ticket.log.filter(|l| !l.trim().is_empty()) {
        data["log"] = Value::String(log);
    }

    let files = decode_attachments(&ticket.attachments)?;

    // Nothing else in the app sets a rustls provider.
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    let client = reqwest::Client::builder()
        // Long enough for 25 MB of attachments on a slow connection.
        .timeout(Duration::from_secs(if files.is_empty() { 20 } else { 120 }))
        .build()
        .map_err(|e| format!("Couldn't start the request: {e}"))?;

    let request = if files.is_empty() {
        let mut body = json!({
            "business_ref": BUSINESS_REF,
            "type": kind,
            "title": title,
            "description": ticket.description.trim(),
            "data": data,
        });
        if kind == "bug" {
            body["severity"] = json!(ticket.severity.as_deref().unwrap_or("medium"));
        } else {
            body["is_urgent"] = json!(ticket.is_urgent);
        }
        if let Some(e) = &email {
            body["email"] = json!(e);
        }
        client.post(TICKET_API).json(&body)
    } else {
        // Files only arrive over multipart. A JSON request drops them.
        let mut form = reqwest::multipart::Form::new()
            .text("business_ref", BUSINESS_REF)
            .text("type", kind)
            .text("title", title.to_string())
            .text("description", ticket.description.trim().to_string())
            .text("data", data.to_string());
        form = if kind == "bug" {
            form.text("severity", ticket.severity.unwrap_or_else(|| "medium".into()))
        } else {
            form.text("is_urgent", ticket.is_urgent.to_string())
        };
        if let Some(e) = email {
            form = form.text("email", e);
        }
        for (name, bytes) in files {
            let part = reqwest::multipart::Part::bytes(bytes).file_name(name);
            form = form.part("attachments", part);
        }
        client.post(TICKET_API).multipart(form)
    };

    let resp = request
        .send()
        .await
        .map_err(|_| "Couldn't reach the support service. Check your connection and try again.".to_string())?;

    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(error_message(status, &body));
    }
    Ok(serde_json::from_str(&body).unwrap_or_else(|_| json!({})))
}
