const { invoke } = window.__TAURI__.core;
const { openUrl } = window.__TAURI__["opener"];
const { check } = window.__TAURI__["updater"];
const { relaunch } = window.__TAURI__["process"];
const { getVersion } = window.__TAURI__["app"];

// ── DOM refs ────────────────────────────────────────────────

const logArea = () => document.getElementById("log-area");
const statusDot = () => document.getElementById("status-dot");
const statusText = () => document.getElementById("status-text");
const countSelected = () => document.getElementById("count-selected");
const countRestored = () => document.getElementById("count-restored");

const btnLaunch = () => document.getElementById("btn-launch");
const btnSelect = () => document.getElementById("btn-select");
const btnRestore = () => document.getElementById("btn-restore");
const btnClearLog = () => document.getElementById("btn-clear-log");
const btnAuto = () => document.getElementById("btn-auto");

// ── State ───────────────────────────────────────────────────

let browserLaunched = false;
let totalRestored = 0;

// Auto mode state
let autoModeActive = false;
let autoTimerInterval = null;
let autoTimeoutId = null;
let autoCycleCount = 0;
// Bumped on every start, so a cycle still waiting on iCloud from before a
// Stop can tell it has been replaced and bow out.
let autoRunId = 0;

// Called from Rust when the iCloud window is closed
window.__onICloudClosed = () => {
  browserLaunched = false;
  if (autoModeActive) stopAutoMode();
  setStatus("disconnected", "Disconnected");
  enableActionButtons(false);
  btnLaunch().disabled = false;
  log("iCloud window closed.", "warn");
};

// Scripts in the iCloud window report what they actually did. Each request
// carries an id, so a report that turns up after its wait has timed out is
// ignored rather than counted against the next request.
const pendingReports = new Map();
let nextRequestId = 1;

window.__onICloudReport = (report) => {
  const pending = pendingReports.get(report?.id);
  if (!pending) return;
  pendingReports.delete(report.id);
  clearTimeout(pending.timer);
  pending.resolve(report);
};

/** Runs an iCloud command and resolves with its report, or null on timeout. */
async function invokeWithReport(command, args, timeoutMs) {
  const id = nextRequestId++;
  const result = new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingReports.delete(id);
      resolve(null);
    }, timeoutMs);
    pendingReports.set(id, { resolve, timer });
  });
  try {
    await invoke(command, { ...args, requestId: id });
  } catch (err) {
    clearTimeout(pendingReports.get(id)?.timer);
    pendingReports.delete(id);
    throw err;
  }
  return result;
}

// How long Select waits for iCloud's file list to finish loading, and how long
// the list must hold still to count as loaded. Auto Mode is stricter because it
// selects after a restore, when the old list can still be showing before
// iCloud reloads it.
const MANUAL_LIST_WAIT_MS = 30 * 1000;
const MANUAL_SETTLE_MS = 3 * 1000;
const AUTO_LIST_WAIT_MS = 3 * 60 * 1000;
const AUTO_SETTLE_MS = 20 * 1000;
// Times Select clicks Apple's Try Again when the file list fails to load.
const MANUAL_RETRIES = 1;
const AUTO_RETRIES = 3;
// Clicking through a batch after the wait. Generous; 500 takes a few seconds.
const SELECT_CLICK_MS = 90 * 1000;
const RESTORE_REPORT_MS = 10 * 1000;

/** Selects a batch. Resolves with the report, or null if none came back. */
function selectInICloud(count, waitMs, settleMs, maxRetries) {
  return invokeWithReport(
    "select_batch",
    { count, waitMs, settleMs, maxRetries },
    waitMs + SELECT_CLICK_MS,
  );
}

/** Logs a selection report and updates the Selected counter. */
function logSelection(report, count, prefix = "") {
  if (!report) {
    log(`${prefix}Selection sent, but iRevive couldn't read how many were ticked. Check the iCloud window.`, "warn");
    return;
  }
  updateCounters(report.total_selected, null);
  if (report.retries > 0) {
    log(`${prefix}iCloud failed to load the file list. Clicked Try Again ${report.retries === 1 ? "once" : `${report.retries} times`}.`, "warn");
  }
  if (report.apple_error) {
    log(`${prefix}Apple's servers still can't load your deleted files, so nothing was selected.`, "error");
    showAppleError();
    return;
  }
  appleErrorShown = false;
  if (report.selected === 0) {
    log(`${prefix}Nothing new was selected. iCloud may still be loading, or there's nothing left to restore.`, "warn");
  } else if (report.selected < count) {
    log(`${prefix}Selected ${report.selected} of ${count}. That's all iCloud had loaded.`, "warn");
  } else {
    log(`${prefix}Selected ${report.selected} items.`, "success");
  }
}

/** Clicks Restore (or OK) and adds what was actually restored to the total. */
async function restoreInICloud(prefix = "") {
  const report = await invokeWithReport("click_restore", {}, RESTORE_REPORT_MS);
  if (!report) {
    log(`${prefix}Restore clicked, but iRevive couldn't read how many items were in it, so the total wasn't changed.`, "warn");
    return;
  }
  if (report.apple_error && report.action !== "restore") {
    log(`${prefix}Apple's servers can't load your deleted files right now, so there was nothing to restore.`, "error");
    showAppleError();
    return;
  }
  switch (report.action) {
    case "restore":
      if (report.selected > 0) {
        totalRestored += report.selected;
        updateCounters(0, totalRestored);
        log(`${prefix}Restore clicked for ${report.selected} items. Total: ${totalRestored}`, "success");
      } else {
        log(`${prefix}Restore clicked, but no items were selected.`, "warn");
      }
      break;
    case "confirm":
      log(`${prefix}Confirmation closed.`, "success");
      break;
    case "disabled":
      log(`${prefix}The Restore button was greyed out, so nothing was restored.`, "warn");
      break;
    default:
      log(`${prefix}Couldn't find a Restore or OK button in the iCloud window.`, "warn");
  }
}


// ── Logging ─────────────────────────────────────────────────

function log(message, level = "") {
  const area = logArea();
  const entry = document.createElement("div");
  entry.className = "log-entry" + (level ? ` log-${level}` : "");

  const now = new Date();
  const time = now.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  entry.innerHTML = `<span class="log-time">${time}</span>${escapeHtml(String(message))}`;
  area.appendChild(entry);
  area.scrollTop = area.scrollHeight;
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// ── Status ──────────────────────────────────────────────────

function setStatus(state, text) {
  const dot = statusDot();
  const label = statusText();
  dot.className = "status-dot";
  if (state === "connected" || state === "working") {
    dot.classList.add(state);
  }
  label.textContent = text;
}

function updateCounters(selected, restored) {
  if (selected !== undefined && selected !== null) countSelected().textContent = selected;
  if (restored !== undefined && restored !== null) countRestored().textContent = restored;
}

function enableActionButtons(enabled) {
  btnSelect().disabled = !enabled;
  btnRestore().disabled = !enabled;
  btnAuto().disabled = !enabled;
}

function showLoader(on) {
  document.getElementById("loader-bar").classList.toggle("active", on);
}

// ── Actions ─────────────────────────────────────────────────

async function launchBrowser() {
  if (browserLaunched) {
    log("Browser already launched.", "warn");
    return;
  }
  try {
    setStatus("working", "Launching...");
    showLoader(true);
    btnLaunch().disabled = true;
    log("Opening iCloud window...");
    const result = await invoke("open_icloud_window");
    browserLaunched = true;
    setStatus("connected", "Connected");
    enableActionButtons(true);
    log(result?.status || "iCloud window opened.", "success");
  } catch (err) {
    setStatus("disconnected", "Disconnected");
    btnLaunch().disabled = false;
    log(`Failed to open iCloud window: ${err}`, "error");
  } finally {
    showLoader(false);
  }
}

async function selectBatch() {
  const count = parseInt(document.getElementById("batch-size").value) || 500;
  icloudBusy = true;
  try {
    setStatus("working", `Selecting ${count}...`);
    showLoader(true);
    enableActionButtons(false);
    log(`Selecting up to ${count} items...`);
    logSelection(await selectInICloud(count, MANUAL_LIST_WAIT_MS, MANUAL_SETTLE_MS, MANUAL_RETRIES), count);
  } catch (err) {
    log(`Selection failed: ${err}`, "error");
  } finally {
    icloudBusy = false;
    setStatus("connected", "Connected");
    showLoader(false);
    enableActionButtons(true);
  }
}

async function clickRestore() {
  icloudBusy = true;
  try {
    log("Clicking restore/confirm...");
    await restoreInICloud();
  } catch (err) {
    log(`Restore failed: ${err}`, "error");
  } finally {
    icloudBusy = false;
  }
}

// ── Auto Mode ──────────────────────────────────────────────

function getAutoWaitMs() {
  const mins = parseInt(document.getElementById("auto-wait-time").value) || 5;
  return mins * 60 * 1000;
}

function showAutoCounters(show) {
  document.getElementById("counters-normal").classList.toggle("hidden", show);
  document.getElementById("counters-auto").classList.toggle("active", show);
}

function updateAutoCycleCount() {
  document.getElementById("auto-cycle-count").textContent = autoCycleCount;
}

function startAutoMode() {
  autoModeActive = true;
  autoCycleCount = 0;
  autoRunId++;
  showAutoCounters(true);
  updateAutoCycleCount();
  btnAuto().textContent = "Stop Auto";
  btnAuto().classList.add("active");
  btnSelect().disabled = true;
  btnRestore().disabled = true;
  const waitMins = (getAutoWaitMs() / 60000);
  log(`Auto mode started. Will cycle: Wait for iCloud to load → Select → Wait ${waitMins}m → Restore → Wait ${waitMins}m → Repeat`, "info");
  runAutoCycle();
}

function stopAutoMode() {
  autoModeActive = false;
  clearInterval(autoTimerInterval);
  clearTimeout(autoTimeoutId);
  autoTimerInterval = null;
  autoTimeoutId = null;
  hideAutoTimer();
  showAutoCounters(false);
  btnAuto().textContent = "Auto Mode";
  btnAuto().classList.remove("active");
  if (browserLaunched) {
    btnSelect().disabled = false;
    btnRestore().disabled = false;
  }
  showLoader(false);
  setStatus("connected", "Connected");
  log(`Auto mode stopped. Completed ${autoCycleCount} full cycles.`, "warn");
}

function toggleAutoMode() {
  if (autoModeActive) {
    stopAutoMode();
  } else {
    startAutoMode();
  }
}

async function runAutoCycle(run = autoRunId) {
  const active = () => autoModeActive && run === autoRunId;
  if (!active() || !browserLaunched) return;

  // Step 1: Wait for iCloud to finish loading, then select
  const count = parseInt(document.getElementById("batch-size").value) || 500;
  const prefix = "[Auto] ";
  try {
    setStatus("working", `Auto: Selecting ${count}...`);
    showLoader(true);
    log(`${prefix}Cycle ${autoCycleCount + 1}: Waiting for iCloud to load, then selecting ${count} items...`);
    showListWaitTimer();
    const report = await selectInICloud(count, AUTO_LIST_WAIT_MS, AUTO_SETTLE_MS, AUTO_RETRIES);
    if (!active()) return;
    logSelection(report, count, prefix);
  } catch (err) {
    log(`${prefix}Selection failed: ${err}`, "error");
  } finally {
    if (active()) {
      stopListWaitTimer();
      showLoader(false);
    }
  }

  if (!active()) return;

  // Step 2: Give iCloud time to register the selection
  log(`${prefix}Waiting ${(getAutoWaitMs() / 60000)} minutes for selection to settle...`);
  setStatus("connected", "Auto: Waiting (select)");
  await autoWait("Selecting... Restore in");

  if (!active()) return;

  // Step 3: Click restore
  try {
    setStatus("working", "Auto: Restoring...");
    showLoader(true);
    log(`${prefix}Clicking restore/confirm...`);
    await restoreInICloud(prefix);
  } catch (err) {
    log(`${prefix}Restore failed: ${err}`, "error");
  }
  showLoader(false);

  if (!active()) return;

  autoCycleCount++;
  updateAutoCycleCount();

  // Step 4: Wait before next cycle
  log(`${prefix}Waiting ${(getAutoWaitMs() / 60000)} minutes before next cycle...`);
  setStatus("connected", "Auto: Waiting (restore)");
  await autoWait("Restoring... Next select in");

  if (!active()) return;

  // Repeat
  runAutoCycle(run);
}

// The list wait has no fixed length, so the bar fills towards the time limit
// and shows how long it has waited so far.
function showListWaitTimer() {
  const startTime = Date.now();
  showAutoTimer();
  clearInterval(autoTimerInterval);
  autoTimerInterval = setInterval(() => {
    const elapsed = Date.now() - startTime;
    const mins = Math.floor(elapsed / 60000);
    const secs = Math.floor((elapsed % 60000) / 1000);
    updateAutoTimer(
      Math.min(1, elapsed / AUTO_LIST_WAIT_MS),
      `Waiting for iCloud to load... ${mins}:${secs.toString().padStart(2, "0")}`,
    );
  }, 250);
}

function stopListWaitTimer() {
  clearInterval(autoTimerInterval);
  autoTimerInterval = null;
  hideAutoTimer();
}

function autoWait(label) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const endTime = startTime + getAutoWaitMs();

    showAutoTimer();

    autoTimerInterval = setInterval(() => {
      const now = Date.now();
      const remaining = Math.max(0, endTime - now);
      const elapsed = now - startTime;
      const progress = Math.min(1, elapsed / getAutoWaitMs());

      const mins = Math.floor(remaining / 60000);
      const secs = Math.floor((remaining % 60000) / 1000);
      const timeStr = `${mins}:${secs.toString().padStart(2, "0")}`;

      updateAutoTimer(progress, `${label} ${timeStr}`);

      if (remaining <= 0) {
        clearInterval(autoTimerInterval);
        autoTimerInterval = null;
        hideAutoTimer();
        resolve();
      }
    }, 250);

    autoTimeoutId = setTimeout(() => {
      clearInterval(autoTimerInterval);
      autoTimerInterval = null;
      hideAutoTimer();
      resolve();
    }, getAutoWaitMs());
  });
}

function showAutoTimer() {
  document.getElementById("auto-timer-bar").classList.add("active");
}

function hideAutoTimer() {
  document.getElementById("auto-timer-bar").classList.remove("active");
  document.getElementById("auto-timer-fill").style.width = "0%";
  document.getElementById("auto-timer-label").textContent = "";
}

function updateAutoTimer(progress, label) {
  document.getElementById("auto-timer-fill").style.width = `${progress * 100}%`;
  document.getElementById("auto-timer-label").textContent = label;
}

// ── Init ────────────────────────────────────────────────────

window.addEventListener("DOMContentLoaded", () => {
  btnLaunch().addEventListener("click", launchBrowser);
  btnSelect().addEventListener("click", selectBatch);
  btnRestore().addEventListener("click", clickRestore);
  btnAuto().addEventListener("click", toggleAutoMode);
  btnClearLog().addEventListener("click", () => {
    logArea().innerHTML = "";
  });

  // Welcome splash - show on first launch
  const modalWelcome = document.getElementById("modal-welcome");
  document.getElementById("btn-welcome-start").addEventListener("click", () => {
    modalWelcome.classList.remove("active");
  });

  // Open external links in welcome screen
  modalWelcome.querySelectorAll(".donate-link, .brand-link, .mail-link").forEach((link) => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      openUrl(link.href);
    });
  });

  // Modal handlers
  const modalHelp = document.getElementById("modal-help");
  const modalDonate = document.getElementById("modal-donate");

  document.getElementById("btn-help").addEventListener("click", () => {
    modalHelp.classList.add("active");
  });
document.getElementById("close-help").addEventListener("click", () => {
    modalHelp.classList.remove("active");
  });
  document.getElementById("btn-donate").addEventListener("click", () => {
    modalDonate.classList.add("active");
  });

  // Open external links in system browser
  document.querySelectorAll(".donate-link, .brand-link").forEach((link) => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      openUrl(link.href);
    });
  });
  document.getElementById("close-donate").addEventListener("click", () => {
    modalDonate.classList.remove("active");
  });

  // Privacy: opened from the header, welcome screen and support form
  const modalPrivacy = document.getElementById("modal-privacy");
  document.querySelectorAll("[data-open-privacy]").forEach((btn) => {
    btn.addEventListener("click", () => modalPrivacy.classList.add("active"));
  });
  document.getElementById("close-privacy").addEventListener("click", () => {
    modalPrivacy.classList.remove("active");
  });
  modalPrivacy.querySelectorAll("[data-external]").forEach((link) => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      openUrl(link.href);
    });
  });

  initClearData();
  initAppleError();
  setInterval(checkICloudIdle, IDLE_CHECK_MS);
  initSupport();

  // Close modals on overlay click
  [modalHelp, modalDonate, modalPrivacy].forEach((modal) => {
    modal.addEventListener("click", (e) => {
      if (e.target === modal) modal.classList.remove("active");
    });
  });

  // Auto mode slider label
  const autoSlider = document.getElementById("auto-wait-time");
  const autoSliderValue = document.getElementById("auto-slider-value");
  autoSlider.addEventListener("input", () => {
    autoSliderValue.textContent = `${autoSlider.value} min`;
  });

  setStatus("disconnected", "Disconnected");
  getVersion().then(v => {
    document.getElementById("app-version").textContent = `v${v}`;
  });
  log("iRevive ready.", "info");

  // Check for updates silently
  checkForUpdates();
  document.getElementById("btn-check-updates").addEventListener("click", () => checkForUpdates(true));
});

// ── Apple server error ─────────────────────────────────────
//
// Shown when iCloud's Restore Files list fails to load even after Try Again.
// Only once until the list loads again, so an overnight Auto Mode run that
// keeps hitting it doesn't stack the same notice every cycle.

let appleErrorShown = false;

/** `retried`: whether iRevive already clicked Try Again. False when the idle check spotted it. */
function showAppleError(retried = true) {
  if (appleErrorShown) return;
  appleErrorShown = true;
  $("apple-error-detail").textContent = retried
    ? "iRevive clicked Try Again but it's still failing."
    : "Click Try Again in the iCloud window, or wait a while and try later.";
  $("apple-error-auto").hidden = !autoModeActive;
  $("modal-apple-error").classList.add("active");
}

// While iCloud is open and nothing else is running, look at the page every
// 15s so the notice appears without the user having to press Select first.
// Read-only: it never clicks anything.
const IDLE_CHECK_MS = 15 * 1000;
let icloudBusy = false;

async function checkICloudIdle() {
  if (!browserLaunched || icloudBusy || autoModeActive) return;
  let report;
  try {
    report = await invokeWithReport("check_icloud", {}, 5000);
  } catch {
    return;
  }
  // Something may have started while this was waiting; its own report wins.
  if (!report || icloudBusy || autoModeActive) return;
  if (report.apple_error) {
    if (!appleErrorShown) log("Apple's servers can't load your deleted files right now.", "error");
    showAppleError(false);
  } else if (report.loaded > 0) {
    appleErrorShown = false;
  }
}

function initAppleError() {
  const modal = $("modal-apple-error");
  const close = () => modal.classList.remove("active");
  $("btn-apple-error-close").addEventListener("click", close);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) close();
  });
  $("btn-apple-error-browser").addEventListener("click", () => {
    openUrl("https://www.icloud.com/recovery");
  });
  $("btn-apple-error-report").addEventListener("click", () => {
    close();
    openReport("bug", "Restore Files loads in my browser but not in iRevive");
  });
}

// ── Clear browsing data ────────────────────────────────────
//
// Two clicks, since it signs the user out and closes the iCloud window
// (stopping Auto Mode). No confirm() — the webview's dialogs block the app.

const CLEAR_DATA_HINT =
  "Deletes Apple's cookies, cache and saved site data from iRevive. You'll sign in again next time.";

function initClearData() {
  const btn = document.getElementById("btn-clear-data");
  const hint = document.getElementById("clear-data-hint");
  let confirmTimer = null;

  const reset = () => {
    clearTimeout(confirmTimer);
    confirmTimer = null;
    btn.classList.remove("confirming");
    btn.textContent = "Clear";
    hint.textContent = CLEAR_DATA_HINT;
  };

  btn.addEventListener("click", async () => {
    if (!confirmTimer) {
      btn.classList.add("confirming");
      btn.textContent = "Confirm";
      hint.textContent = autoModeActive
        ? "This stops Auto Mode and closes the iCloud window. Click Confirm to go ahead."
        : browserLaunched
          ? "This closes the iCloud window. Click Confirm to go ahead."
          : "Click Confirm to sign out and clear everything.";
      confirmTimer = setTimeout(reset, 5000);
      return;
    }

    reset();
    btn.disabled = true;
    try {
      await invoke("clear_browsing_data");
      hint.textContent = "Done. You're signed out, and the cookies and cache are gone.";
      log("Signed out: cookies, cache and site data cleared.", "success");
    } catch (err) {
      hint.textContent = `Couldn't clear data: ${err}`;
      log(`Clear data failed: ${err}`, "error");
    } finally {
      btn.disabled = false;
    }
  });
}

// ── Support tickets ────────────────────────────────────────
//
// The form only collects the report. It's filed by `submit_ticket` in
// src-tauri/src/tickets.rs, because the ticket API won't take a request
// straight from the webview. If you change what's sent, update the Privacy
// modal in index.html too.

const SUPPORT_MAX_FILES = 5;
const SUPPORT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const SUPPORT_MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const SUPPORT_ALLOWED_EXT = [
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf",
  ".txt", ".log", ".csv", ".json", ".har",
];

const SEVERITY_HINTS = {
  low: "Cosmetic — nothing is blocked",
  medium: "Annoying, but there's a way around it",
  high: "Something important is broken",
  critical: "Can't restore at all",
};

const support = {
  mode: null, // "bug" | "feature"
  severity: "medium",
  files: [],
  sending: false,
};

const $ = (id) => document.getElementById(id);

const extOf = (name) => {
  const i = (name || "").lastIndexOf(".");
  return i < 0 ? "" : name.slice(i).toLowerCase();
};

const prettyBytes = (n) =>
  n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

/** Returns an error string, or null. Mirrors the server's rules. */
function checkSupportFiles(files) {
  if (files.length > SUPPORT_MAX_FILES) {
    return `Attach ${SUPPORT_MAX_FILES} files at most — you've picked ${files.length}.`;
  }
  let total = 0;
  for (const f of files) {
    if (!SUPPORT_ALLOWED_EXT.includes(extOf(f.name))) {
      return `${f.name}: screenshots, PDFs and logs only.`;
    }
    if (!f.size) return `${f.name}: the file is empty.`;
    if (f.size > SUPPORT_MAX_FILE_BYTES) {
      return `${f.name}: too large at ${prettyBytes(f.size)} — 10 MB is the limit.`;
    }
    total += f.size;
  }
  if (total > SUPPORT_MAX_TOTAL_BYTES) {
    return `Those come to ${prettyBytes(total)} together — 25 MB is the limit.`;
  }
  return null;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function showSupportError(el, message) {
  el.textContent = message || "";
  el.hidden = !message;
}

function renderSupportFiles() {
  const list = $("support-file-list");
  list.innerHTML = "";
  support.files.forEach((f, i) => {
    const li = document.createElement("li");
    li.className = "file-item";
    li.innerHTML = `<span class="file-name"></span><span class="file-size"></span><button type="button" class="file-remove" aria-label="Remove">&times;</button>`;
    li.querySelector(".file-name").textContent = f.name;
    li.querySelector(".file-name").title = f.name;
    li.querySelector(".file-size").textContent = prettyBytes(f.size);
    li.querySelector(".file-remove").addEventListener("click", () => {
      support.files.splice(i, 1);
      showSupportError($("support-file-error"), null);
      renderSupportFiles();
    });
    list.appendChild(li);
  });
  $("support-attach-label").hidden = support.files.length >= SUPPORT_MAX_FILES;
  $("support-attach-text").textContent = support.files.length ? "Add another" : "Attach a file";
}

function setSeverity(value) {
  support.severity = value;
  document.querySelectorAll("#support-severity .severity-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.severity === value);
  });
  $("support-severity-hint").textContent = SEVERITY_HINTS[value];
}

function updateSupportSubmit() {
  $("support-submit").disabled = support.sending || !$("support-title").value.trim();
}

function showSupportStep(step) {
  $("support-choice").hidden = step !== "choice";
  $("support-form").hidden = step !== "form";
  $("support-done").hidden = step !== "done";

  const heading = $("support-heading");
  const sub = $("support-subheading");
  if (step === "choice") {
    heading.textContent = "How can we help?";
    sub.textContent = "Goes straight to the person who can fix it.";
  } else if (step === "form") {
    const bug = support.mode === "bug";
    heading.textContent = bug ? "Report a Bug" : "Request a Feature";
    sub.textContent = "We'll take a look as soon as we can.";
    $("support-title").placeholder = bug ? "What went wrong?" : "What would you like to see?";
    $("support-description").placeholder = bug
      ? "What you did, what you expected, and what happened instead."
      : "Describe the feature...";
    $("support-severity-field").hidden = !bug;
    $("support-urgent-field").hidden = bug;
    setTimeout(() => $("support-title").focus(), 0);
  }
  $("support-header").hidden = step === "done";
}

function resetSupport() {
  support.mode = null;
  support.files = [];
  support.sending = false;
  $("support-form").reset();
  $("support-include-log").checked = true;
  setSeverity("medium");
  renderSupportFiles();
  showSupportError($("support-file-error"), null);
  showSupportError($("support-error"), null);
  $("support-submit").textContent = "Submit";
  updateSupportSubmit();
  showSupportStep("choice");
}

function closeSupport() {
  if (support.sending) return;
  $("modal-support").classList.remove("active");
  // After the modal is gone, so the content doesn't change while it fades.
  setTimeout(resetSupport, 150);
}

async function submitSupport(e) {
  e.preventDefault();
  const title = $("support-title").value.trim();
  if (!title || support.sending) return;

  const email = $("support-email").value.trim();
  if (email && !$("support-email").checkValidity()) {
    showSupportError($("support-error"), "That email address doesn't look right. Fix it or leave it blank.");
    return;
  }

  support.sending = true;
  showSupportError($("support-error"), null);
  $("support-submit").textContent = "Sending…";
  updateSupportSubmit();

  try {
    const attachments = await Promise.all(
      support.files.map(async (f) => ({ name: f.name, data: await fileToBase64(f) })),
    );
    const includeLog = $("support-include-log").checked;
    const result = await invoke("submit_ticket", {
      ticket: {
        type: support.mode,
        title,
        description: $("support-description").value.trim(),
        severity: support.severity,
        is_urgent: $("support-urgent").checked,
        email: email || null,
        log: includeLog ? logArea().innerText : null,
        attachments,
      },
    });

    const ref = result?.id ? ` (ticket #${result.id})` : "";
    const bug = support.mode === "bug";
    $("support-done-title").textContent = bug ? "Bug reported. Thank you." : "Feature request sent.";
    $("support-done-text").textContent = email
      ? `We'll email ${email} with any updates${ref}.`
      : `Your report was sent anonymously${ref}.`;
    log(`${bug ? "Bug report" : "Feature request"} sent${ref}.`, "success");
    support.sending = false;
    showSupportStep("done");
  } catch (err) {
    support.sending = false;
    $("support-submit").textContent = "Submit";
    updateSupportSubmit();
    showSupportError($("support-error"), `Couldn't send that: ${err}`);
  }
}

/** Opens the Report form, optionally straight to a bug or feature with a title. */
function openReport(mode = null, title = "") {
  resetSupport();
  if (mode) {
    support.mode = mode;
    showSupportStep("form");
    $("support-title").value = title;
    updateSupportSubmit();
  }
  $("modal-support").classList.add("active");
}

function initSupport() {
  const modal = $("modal-support");

  $("btn-support").addEventListener("click", () => openReport());
  $("close-support").addEventListener("click", closeSupport);
  $("support-done-close").addEventListener("click", closeSupport);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeSupport();
  });

  document.querySelectorAll("[data-support-mode]").forEach((btn) => {
    btn.addEventListener("click", () => {
      support.mode = btn.dataset.supportMode;
      showSupportStep("form");
    });
  });
  $("support-back").addEventListener("click", () => {
    if (!support.sending) showSupportStep("choice");
  });

  document.querySelectorAll("#support-severity .severity-btn").forEach((btn) => {
    btn.addEventListener("click", () => setSeverity(btn.dataset.severity));
  });

  $("support-title").addEventListener("input", updateSupportSubmit);

  $("support-files").addEventListener("change", (e) => {
    // Adds to the existing picks, since the dialog only returns its latest selection.
    const next = [...support.files, ...Array.from(e.target.files)];
    const err = checkSupportFiles(next);
    showSupportError($("support-file-error"), err);
    if (!err) {
      support.files = next;
      renderSupportFiles();
    }
    // Cleared so re-picking a removed file still fires change.
    e.target.value = "";
  });

  $("support-form").addEventListener("submit", submitSupport);
  resetSupport();
}

/**
 * Checks the update manifest. The launch check stays silent; the "Check for
 * updates" link reports every outcome in the log and on the link itself.
 */
let checkingForUpdates = false;

async function checkForUpdates(manual = false) {
  if (checkingForUpdates) return;
  checkingForUpdates = true;
  const btn = document.getElementById("btn-check-updates");
  const setLink = (text, disabled) => {
    btn.textContent = text;
    btn.disabled = disabled;
  };
  if (manual) setLink("Checking...", true);

  let result;
  try {
    const update = await check();
    if (update) {
      log(`Update available: v${update.version}`, "info");
      showUpdateModal(update);
      result = "Update available";
    } else {
      if (manual) log(`You're on the latest version (v${await getVersion()}).`, "success");
      result = "Up to date";
    }
  } catch (err) {
    if (manual) log(`Couldn't check for updates: ${err}`, "error");
    result = "Couldn't check";
  } finally {
    checkingForUpdates = false;
  }

  if (manual) {
    setLink(result, true);
    setTimeout(() => setLink("Check for updates", false), 3000);
  }
}

function showUpdateModal(update) {
  const modal = document.getElementById("modal-update");
  document.getElementById("update-version").textContent = `v${update.version}`;
  modal.classList.add("active");

  document.getElementById("btn-update-now").onclick = async () => {
    const fallback = document.getElementById("update-fallback");
    fallback.innerHTML = "";
    log("Downloading update...", "info");
    showLoader(true);

    // Show fallback link after 15 seconds
    const fallbackTimer = setTimeout(() => {
      fallback.innerHTML = `Download taking too long? <a href="https://github.com/Fleebee/irevive-icloud-restore/releases/latest/download/iRevive_aarch64.dmg" class="update-fallback-link">Download manually</a>`;
      fallback.querySelector(".update-fallback-link").addEventListener("click", (e) => {
        e.preventDefault();
        openUrl("https://github.com/Fleebee/irevive-icloud-restore/releases/latest/download/iRevive_aarch64.dmg");
      });
    }, 15000);

    try {
      await update.downloadAndInstall();
      clearTimeout(fallbackTimer);
      showLoader(false);
      modal.classList.remove("active");
      showRestartModal();
    } catch (err) {
      clearTimeout(fallbackTimer);
      showLoader(false);
      log(`Update download failed: ${err}`, "error");
      fallback.innerHTML = `Download failed. <a href="https://github.com/Fleebee/irevive-icloud-restore/releases/latest/download/iRevive_aarch64.dmg" class="update-fallback-link">Download manually</a>`;
      fallback.querySelector(".update-fallback-link").addEventListener("click", (e) => {
        e.preventDefault();
        openUrl("https://github.com/Fleebee/irevive-icloud-restore/releases/latest/download/iRevive_aarch64.dmg");
      });
    }
  };

  document.getElementById("btn-update-ignore").onclick = () => {
    modal.classList.remove("active");
    log("Update skipped.", "warn");
  };
}

function showRestartModal() {
  const modal = document.getElementById("modal-restart");
  modal.classList.add("active");

  document.getElementById("btn-restart-now").onclick = async () => {
    await relaunch();
  };

  document.getElementById("btn-restart-later").onclick = () => {
    modal.classList.remove("active");
    log("Update installed. Restart to apply.", "info");
  };
}
