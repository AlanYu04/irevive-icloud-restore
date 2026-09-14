use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::Manager;

mod tickets;

struct AppState {
    icloud_open: Mutex<bool>,
}

/// Fire JS in the iCloud webview without waiting for a result.
///
/// The script can call `report({...})` to send what it actually did back to
/// the main window (see `icloud_report`). Nothing here waits on that, so a
/// report that never arrives can't hang anything; the main window times out.
fn fire_js(app_handle: &tauri::AppHandle, js_code: &str) -> Result<(), String> {
    let icloud_win = app_handle
        .get_webview_window("icloud")
        .ok_or("iCloud window not open. Click 'Open iCloud' first.")?;

    let wrapped_js = format!(
        r#"(async () => {{
            const report = (r) => {{
                try {{ window.__TAURI_INTERNALS__.invoke("icloud_report", {{ report: r }}); }}
                catch (e) {{ console.error("iRevive report failed:", e); }}
            }};
            try {{ {js_code} }} catch(e) {{ console.error("iRevive error:", e); }}
        }})();"#,
    );

    icloud_win
        .eval(&wrapped_js)
        .map_err(|e| format!("eval failed: {}", e))
}

#[tauri::command]
async fn open_icloud_window(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Value, String> {
    // Check if already open
    if let Some(win) = app_handle.get_webview_window("icloud") {
        win.set_focus().map_err(|e| e.to_string())?;
        return Ok(json!({"ok": true, "status": "iCloud window focused"}));
    }

    #[allow(unused_mut)]
    let mut url = "https://www.icloud.com/recovery".to_string();
    // Debug builds can load a stand-in page instead, to try the selection
    // scripts without an Apple ID: IREVIVE_ICLOUD_URL=file:///... npm run tauri dev
    #[cfg(debug_assertions)]
    if let Ok(test_url) = std::env::var("IREVIVE_ICLOUD_URL") {
        url = test_url;
    }

    let win = tauri::WebviewWindowBuilder::new(
        &app_handle,
        "icloud",
        tauri::WebviewUrl::External(url.parse().map_err(|e| format!("Bad iCloud URL: {}", e))?),
    )
    .title("iCloud Recovery - Sign In")
    .inner_size(800.0, 700.0)
    .position(50.0, 50.0)
    .build()
    .map_err(|e| format!("Failed to create iCloud window: {}", e))?;

    // Listen for the iCloud window being closed
    let handle = app_handle.clone();
    win.on_window_event(move |event| {
        if let tauri::WindowEvent::Destroyed = event {
            // Notify the main window that iCloud window was closed
            if let Some(main_win) = handle.get_webview_window("main") {
                let _ = main_win.eval("window.__onICloudClosed && window.__onICloudClosed()");
            }
        }
    });

    *state.icloud_open.lock().map_err(|e| e.to_string())? = true;

    Ok(json!({"ok": true, "status": "iCloud window opened"}))
}

/// Page helpers shared by the selection and restore scripts. iCloud's markup
/// isn't ours, so each looks for real checkboxes first, then ARIA ones, then
/// selectable rows.
const PAGE_HELPERS: &str = r#"
    const delay = ms => new Promise(r => setTimeout(r, ms));

    const unselected = () => {
        const boxes = document.querySelectorAll('input[type="checkbox"]:not(:checked)');
        if (boxes.length) return Array.from(boxes);
        const aria = document.querySelectorAll('[role="checkbox"][aria-checked="false"]');
        if (aria.length) return Array.from(aria);
        for (const sel of ['[role="row"]:not([aria-selected="true"])', '[role="listitem"]', '[role="option"]']) {
            const els = document.querySelectorAll(sel);
            if (els.length) return Array.from(els);
        }
        return [];
    };

    const selectedCount = () =>
        document.querySelectorAll('input[type="checkbox"]:checked').length ||
        document.querySelectorAll('[role="checkbox"][aria-checked="true"]').length ||
        document.querySelectorAll('[role="row"][aria-selected="true"]').length;

    // Apple's "There was a problem loading all restorable files. Try Again",
    // shown when its server fails to list deleted files (HTTP 500). Returns
    // the Try Again button, or null. While the Restore Files dialog is open
    // only its own counts: the tile behind it has a Try Again of its own that
    // can stay up after the dialog's list has loaded. English only, like the rest.
    const appleErrorRetry = () => {
        const scope = document.querySelector(".file-recovery-modal-content") || document;
        return Array.from(scope.querySelectorAll('button, [role="button"], a'))
            .find(el => (el.textContent || "").trim().toLowerCase() === "try again") || null;
    };
"#;

/// Ticks up to `count` items, then reports how many are actually selected.
///
/// With `wait_ms`, it first waits for iCloud's file list to hold still for
/// `settle_ms`, so it doesn't select from a list that's still loading after a
/// restore. It gives up waiting after `wait_ms` and selects whatever is there.
///
/// If Apple's loading error shows while it waits, it clicks Try Again, up to
/// `max_retries` times and no more than every 20s. It reports an Apple error
/// if the error is still up at the end, or if it showed and no files have
/// loaded since: after Try Again, Apple's page can spin for a long time
/// before failing again.
#[tauri::command]
async fn select_batch(
    app_handle: tauri::AppHandle,
    count: Option<u32>,
    wait_ms: Option<u64>,
    settle_ms: Option<u64>,
    max_retries: Option<u32>,
    request_id: u64,
) -> Result<Value, String> {
    let n = count.unwrap_or(500);
    let wait_ms = wait_ms.unwrap_or(0);
    let settle_ms = settle_ms.unwrap_or(3000);
    let max_retries = max_retries.unwrap_or(0);
    let js = format!(
        r#"
        {PAGE_HELPERS}
        const limit = {n};
        const started = Date.now();

        // A short list might still be growing, so it gets at least 10s.
        let available = unselected().length;
        let stableSince = Date.now();
        let retries = 0;
        let lastRetry = 0;
        let sawAppleError = false;
        while (Date.now() - started < {wait_ms}) {{
            await delay(1000);
            const retry = appleErrorRetry();
            if (retry) sawAppleError = true;
            if (retry && Date.now() - lastRetry >= 20000) {{
                // Out of retries and Apple still can't load the list.
                if (retries >= {max_retries}) break;
                retry.click();
                retries++;
                lastRetry = Date.now();
                stableSince = Date.now();
                continue;
            }}
            const now = unselected().length;
            if (now !== available) {{
                available = now;
                stableSince = Date.now();
                continue;
            }}
            const settle = available >= limit ? {settle_ms} : Math.max({settle_ms}, 10000);
            if (available > 0 && Date.now() - stableSince >= settle) break;
        }}
        const waited = Date.now() - started;
        const loaded = unselected().length;

        const before = selectedCount();
        let clicked = 0;
        for (const el of unselected().slice(0, limit)) {{
            if (!el.isConnected) continue;
            el.scrollIntoView({{ block: "center" }});
            el.click();
            clicked++;
            if (clicked % 10 === 0) await delay(5);
        }}
        await delay(500);

        report({{
            kind: "select",
            id: {request_id},
            requested: limit,
            clicked,
            selected: Math.max(0, selectedCount() - before),
            total_selected: selectedCount(),
            waited_ms: waited,
            retries,
            apple_error: !!appleErrorRetry() || (sawAppleError && loaded === 0),
        }});
        "#,
    );

    fire_js(&app_handle, &js)?;
    Ok(json!({"ok": true, "requested": n}))
}

/// Clicks OK on a confirmation dialog if one is up, otherwise Restore. Reports
/// which it clicked and how many items were selected at that moment, which is
/// the number actually sent to be restored.
#[tauri::command]
async fn click_restore(app_handle: tauri::AppHandle, request_id: u64) -> Result<Value, String> {
    let js = format!(
        r#"
        {PAGE_HELPERS}
        const send = (action, selected) =>
            report({{ kind: "restore", id: {request_id}, action, selected, apple_error: !!appleErrorRetry() }});

        const allBtns = Array.from(document.querySelectorAll('button, [role="button"]'));

        // First check for a confirmation dialog (OK / Done / Got it)
        const confirmBtn = allBtns.find(btn => {{
            const text = (btn.textContent || "").trim().toLowerCase();
            return text === "ok" || text === "done" || text === "got it" || text === "close";
        }});
        if (confirmBtn) {{
            confirmBtn.click();
            send("confirm", 0);
            return;
        }}

        // Otherwise look for the restore/recover button
        const restoreBtn = allBtns.find(btn => {{
            const text = (btn.textContent || "").toLowerCase();
            if (!text.includes("restore") && !text.includes("recover")) return false;
            if (btn.closest(".tile-article")) return false;
            if (btn.closest(".nav-link")) return false;
            return true;
        }});

        if (!restoreBtn) {{
            send("none", selectedCount());
            return;
        }}

        // Scroll modal/dialog container to bottom first
        const modal =
            restoreBtn.closest('[role="dialog"]') ||
            restoreBtn.closest(".modal") ||
            restoreBtn.closest('[class*="modal"]') ||
            restoreBtn.closest('[class*="dialog"]');
        if (modal) {{
            modal.scrollTop = modal.scrollHeight;
        }}

        // Also scroll any overflow parent
        let parent = restoreBtn.parentElement;
        while (parent) {{
            if (parent.scrollHeight > parent.clientHeight) {{
                parent.scrollTop = parent.scrollHeight;
                break;
            }}
            parent = parent.parentElement;
        }}

        // Both read before the click, since the page clears the selection and
        // greys the button out again once the restore starts.
        const selected = selectedCount();
        const disabled = restoreBtn.disabled || restoreBtn.getAttribute("aria-disabled") === "true";
        restoreBtn.scrollIntoView({{ block: "center", behavior: "instant" }});
        restoreBtn.click();
        send(disabled ? "disabled" : "restore", selected);
        "#,
    );

    fire_js(&app_handle, &js)?;
    Ok(json!({"ok": true, "status": "Restore/confirm clicked"}))
}

/// A read-only look at the iCloud page, run while iRevive is idle: whether
/// Apple's loading error is showing, and how many items are there to select.
#[tauri::command]
async fn check_icloud(app_handle: tauri::AppHandle, request_id: u64) -> Result<(), String> {
    let js = format!(
        r#"
        {PAGE_HELPERS}
        report({{
            kind: "status",
            id: {request_id},
            apple_error: !!appleErrorRetry(),
            loaded: unselected().length,
        }});
        "#,
    );
    fire_js(&app_handle, &js)
}

/// Receives `report(...)` calls from scripts running in the iCloud window and
/// passes them to the main window. Only the iCloud window may call it.
#[tauri::command]
fn icloud_report(
    app_handle: tauri::AppHandle,
    webview: tauri::Webview,
    report: Value,
) -> Result<(), String> {
    if webview.label() != "icloud" {
        return Err("Not allowed".into());
    }
    let main_win = app_handle
        .get_webview_window("main")
        .ok_or("Main window not found")?;
    main_win
        .eval(&format!(
            "window.__onICloudReport && window.__onICloudReport({report})"
        ))
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn close_icloud_window(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Value, String> {
    if let Some(win) = app_handle.get_webview_window("icloud") {
        win.close().map_err(|e| format!("Failed to close: {}", e))?;
    }
    *state.icloud_open.lock().map_err(|e| e.to_string())? = false;
    Ok(json!({"ok": true, "status": "iCloud window closed"}))
}

/// Signs out of iCloud by wiping the webviews' cookies, cache and storage.
/// Every window shares one WebKit data store, so clearing it from the main
/// window covers the iCloud one too. The iCloud window is closed first so it
/// isn't left sitting on a page whose session has just gone.
#[tauri::command]
async fn clear_browsing_data(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Value, String> {
    if let Some(win) = app_handle.get_webview_window("icloud") {
        win.close().map_err(|e| format!("Failed to close: {}", e))?;
    }
    *state.icloud_open.lock().map_err(|e| e.to_string())? = false;

    let main_win = app_handle
        .get_webview_window("main")
        .ok_or("Main window not found")?;
    main_win
        .clear_all_browsing_data()
        .map_err(|e| format!("Failed to clear browsing data: {}", e))?;

    Ok(json!({"ok": true, "status": "Browsing data cleared"}))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            icloud_open: Mutex::new(false),
        })
        .invoke_handler(tauri::generate_handler![
            open_icloud_window,
            select_batch,
            click_restore,
            icloud_report,
            check_icloud,
            close_icloud_window,
            clear_browsing_data,
            tickets::submit_ticket,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if window.label() == "main" {
                    // Close the iCloud window when the main window is closed
                    if let Some(icloud_win) = window.app_handle().get_webview_window("icloud") {
                        let _ = icloud_win.close();
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
