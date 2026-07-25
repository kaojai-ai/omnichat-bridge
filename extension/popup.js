import {
  CONFIG_VERSION,
  accountConfigKey,
  accountOrigins,
  findAccountConfig,
  validateConfigFile,
} from "./lib/config.js";
import { STORAGE, hasLocalConsent, readAccountState, readStorage, writeStorage } from "./lib/storage.js";

const emptyConfig = () => ({ version: CONFIG_VERSION, accounts: [] });

const consentInput = document.querySelector("#consent");
const consentError = document.querySelector("#consent-error");
const continueButton = document.querySelector("#continue");
const consentScreen = document.querySelector("#consent-screen");
const hintScreen = document.querySelector("#hint-screen");
const dashboardScreen = document.querySelector("#dashboard-screen");
const configScreen = document.querySelector("#config-screen");
const brandHeader = document.querySelector(".brand");
const clearButton = document.querySelector("#clear");
const settingsButton = document.querySelector("#open-config");
const importButton = document.querySelector("#import-config");
const exportButton = document.querySelector("#export-config");
const accountButton = document.querySelector("#account-id");
const accountIdValue = document.querySelector("#account-id-value");
const accountName = document.querySelector("#account-name");
const accountAvatar = document.querySelector("#account-avatar");
const accountStatus = document.querySelector("#account-status");
const connectionStatus = accountStatus.querySelector(".connection-status");
const lastSync = document.querySelector("#last-sync");
const syncButton = document.querySelector("#sync");
const syncProgress = document.querySelector("#sync-progress");
const progressArea = document.querySelector("#progress-area");
const status = document.querySelector("#status");
const configCount = document.querySelector("#config-count");
const configInput = document.querySelector("#config");
const configStatus = document.querySelector("#config-status");
const configFile = document.querySelector("#config-file");
const leaderStatus = document.querySelector("#leader-status");
const leaderCurrent = leaderStatus.querySelector(".leader-current");
const openErrorsButton = document.querySelector("#open-errors");
const errorsScreen = document.querySelector("#errors-screen");
const errorLog = document.querySelector("#error-log");
const errorLogEmpty = document.querySelector("#error-log-empty");
const copyErrorsButton = document.querySelector("#copy-errors");
const copyDiagnosticsButton = document.querySelector("#copy-diagnostics");
const diagnosticsEmpty = document.querySelector("#diagnostics-empty");
const openPrivacyButton = document.querySelector("#open-privacy");
const closePrivacyButton = document.querySelector("#close-privacy");
const consentRecord = document.querySelector("#consent-record");
const consentIntroTitle = consentScreen.querySelector("h2");
const consentIntroDescription = consentScreen.querySelector(".screen-intro p");
const consentLabel = consentScreen.querySelector(".consent");

let storedConfig = emptyConfig();
let detectedAccount = null;
let storedStatus = null;
let liveState = null;
let scanStates = null;
let pendingStates = null;
let unexpected = [];
let storedSyncDiagnostics = null;
let popupTabId = null;
let storedConsent = null;
let viewingPrivacy = false;
let isShopeeChatTab = false;

function setHeaderActionsVisible(visible) {
  for (const button of [openErrorsButton, settingsButton]) {
    button.hidden = !visible;
  }
}

function formatConsentDate(value) {
  const timestamp = Date.parse(value ?? "");
  if (!Number.isFinite(timestamp)) return "";
  return new Date(timestamp).toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function renderConsentScreen() {
  const consented = hasLocalConsent(storedConsent);
  const recordedAt = formatConsentDate(storedConsent?.accepted_at);
  consentIntroTitle.textContent = viewingPrivacy ? "Privacy and consent" : "Before you continue";
  consentIntroDescription.textContent = viewingPrivacy ? "What this extension transfers from this browser." : "Review what leaves this browser.";
  closePrivacyButton.hidden = !viewingPrivacy;
  consentRecord.hidden = !consented;
  consentRecord.textContent = recordedAt ? `✔️ Consent recorded ${recordedAt} on this device.` : "✔️ Consent recorded on this device.";
  consentLabel.hidden = consented;
  continueButton.hidden = consented;
  consentInput.disabled = consented;
  consentInput.checked = consented;
  continueButton.disabled = consented || !consentInput.checked;
}

function configOrEmpty(value) {
  try {
    return validateConfigFile(value);
  } catch {
    return emptyConfig();
  }
}

async function requestTargetPermission(urls) {
  const origins = [...new Set(urls.map((value) => {
    const url = new URL(value);
    return `${url.protocol === "wss:" ? "https:" : url.protocol}//${url.host}/*`;
  }))];
  if (!await chrome.permissions.request({ origins })) {
    throw new Error("Server permission was not granted.");
  }
}

function setAccountStatus(label, state, action = "") {
  accountStatus.dataset.state = state;
  accountStatus.dataset.action = action;
  connectionStatus.textContent = label;
  accountStatus.disabled = !action;
  accountStatus.title = action === "config"
    ? "Open settings"
    : action === "logs"
      ? "Open error logs"
      : "";
}

function setConfigStatus(message, isError = false) {
  configStatus.textContent = message;
  configStatus.classList.toggle("error", isError);
}

function formatLastSync(value) {
  const timestamp = Date.parse(value ?? "");
  if (!Number.isFinite(timestamp)) return "";
  return `Last synced ${new Date(timestamp).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

function formatSyncResult(result) {
  if (!result) return "";
  const sent = Number(result.sent) || 0;
  const pending = Number(result.pending) || 0;
  if (pending) return `${pending} message${pending === 1 ? "" : "s"} pending.`;
  if (sent) return `Sent ${sent} message${sent === 1 ? "" : "s"}.`;
  return "No new messages.";
}

function showAccount(account) {
  const id = account?.provider === "shopee" ? account.provider_account_id : null;
  const name = typeof account?.display_name === "string" && account.display_name.trim()
    ? account.display_name.trim()
    : "Shopee account";
  const avatarUrl = typeof account?.avatar_url === "string" && account.avatar_url.startsWith("https://")
    ? account.avatar_url
    : "";
  accountName.textContent = id ? name : "Detecting…";
  accountAvatar.src = avatarUrl;
  accountAvatar.hidden = !avatarUrl;
  accountAvatar.alt = avatarUrl ? `${name} avatar` : "";
  accountIdValue.textContent = id || "Detecting…";
  accountButton.disabled = !id;
  accountButton.dataset.accountId = id || "";
  accountButton.title = id ? "Copy Shop ID" : "";
}

function renderDashboard(message = "", isError = false) {
  showAccount(detectedAccount);
  status.classList.toggle("error", isError);
  lastSync.hidden = true;
  lastSync.textContent = "";
  const key = accountConfigKey(detectedAccount);
  const config = findAccountConfig(storedConfig, detectedAccount);
  const syncState = readAccountState(storedStatus, key, null);
  const scanState = readAccountState(scanStates, key, null);
  const pending = readAccountState(pendingStates, key, []);
  const hasCheckpoint = Boolean(scanState?.watermark);
  const live = readAccountState(liveState, key, null);
  const isLeader = Boolean(live?.leader);
  const socketConnected = live?.socket === "connected";
  leaderStatus.hidden = !key || !config;
  leaderCurrent.textContent = isLeader ? "Leader" : "Standby";
  leaderStatus.querySelector(".leader-action").textContent = isLeader ? "Unset leader" : "Set leader";
  leaderStatus.dataset.leader = String(isLeader);
  leaderStatus.title = isLeader ? "Unset this installation as leader" : "Set this tab as leader";

  if (!key) {
    const openSellerChat = !isShopeeChatTab;
    setAccountStatus(openSellerChat ? "Open Seller Chat" : "Detecting", openSellerChat ? "warning" : "neutral");
    status.textContent = message || (openSellerChat ? "Open Shopee Seller Chat to detect your Shop ID." : "");
    syncButton.disabled = true;
    syncButton.dataset.action = "";
    syncButton.textContent = "Sync messages";
    syncProgress.hidden = true;
    progressArea.hidden = !status.textContent;
    return;
  }

  if (!config) {
    setAccountStatus("Need config", "warning", "config");
    status.textContent = message;
    syncButton.disabled = false;
    syncButton.dataset.action = "configure";
    syncButton.textContent = "Configure";
    syncProgress.hidden = true;
    progressArea.hidden = !message;
    return;
  }

  const deliveryError = typeof syncState?.delivery_error === "string" && syncState.delivery_error;
  const syncError = typeof syncState?.sync_error === "string" && syncState.sync_error;
  const currentError = deliveryError || syncError;
  status.classList.toggle("error", isError || Boolean(currentError));
  const syncing = ["discovering", "syncing"].includes(syncState?.state);
  const needsRetry = pending.length > 0 || scanState?.in_progress || currentError;
  setAccountStatus(
    currentError
      ? `Error${pending.length ? ` · ${pending.length} pending` : ""}`
      : socketConnected
        ? "Connected"
        : ["disconnected", "reconnecting"].includes(live?.socket)
          ? "Offline"
          : "Connecting",
    currentError ? "error" : socketConnected ? "ready" : "neutral",
    currentError ? "logs" : "",
  );
  syncButton.disabled = syncing;
  syncButton.dataset.action = "sync";
  syncButton.textContent = syncing ? "Syncing…" : needsRetry ? "Retry now" : "Sync messages";
  const lastSyncText = formatLastSync(syncState?.last_sync_at);
  if (hasCheckpoint && lastSyncText) {
    lastSync.textContent = lastSyncText;
    lastSync.hidden = false;
  }

  if (syncState?.state === "syncing") {
    const completed = Number(syncState.completed_conversations) || 0;
    const total = Number(syncState.total_conversations) || 0;
    const percentage = total ? Math.round((completed / total) * 100) : 0;
    syncProgress.hidden = false;
    syncProgress.value = percentage;
    progressArea.hidden = false;
    status.textContent = `Syncing ${completed} of ${total} conversations · ${percentage}%`;
  } else if (syncState?.state === "discovering") {
    syncProgress.hidden = true;
    progressArea.hidden = false;
    status.textContent = "Checking for missed messages…";
  } else {
    const resultMessage = message
      || (currentError
        ? `${pending.length ? `${pending.length} pending. ` : ""}Select Error to view logs.`
        : "")
      || (hasCheckpoint ? formatSyncResult(syncState?.last_result) : "");
    syncProgress.hidden = true;
    progressArea.hidden = !lastSyncText && !resultMessage;
    status.textContent = resultMessage;
  }
}

function renderUnexpected() {
  openErrorsButton.title = unexpected.length ? `logs (${unexpected.length})` : "logs";
  errorLog.replaceChildren();
  for (const item of unexpected) {
    const row = document.createElement("li");
    const heading = document.createElement("div");
    const scope = document.createElement("strong");
    const time = document.createElement("time");
    const message = document.createElement("p");
    scope.textContent = item.scope || "Extension";
    time.dateTime = item.at || "";
    time.textContent = Number.isFinite(Date.parse(item.at ?? ""))
      ? new Date(item.at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
      : "Unknown time";
    message.textContent = item.message || "Unknown error";
    heading.append(scope, time);
    row.append(heading, message);
    errorLog.append(row);
  }
  errorLogEmpty.hidden = unexpected.length !== 0;
  copyErrorsButton.disabled = unexpected.length === 0;
}

function currentSyncDiagnostics() {
  return readAccountState(storedSyncDiagnostics, accountConfigKey(detectedAccount), null);
}

function renderSyncDiagnostics() {
  const diagnostics = currentSyncDiagnostics();
  const available = Boolean(diagnostics?.conversations?.length);
  copyDiagnosticsButton.disabled = !available;
  diagnosticsEmpty.hidden = available;
}

function formatSyncDiagnostics(diagnostics) {
  const rows = [
    ["conversation_id", "summary_timestamp", "cursor_timestamp", "cursor_message_id", "decision", "reason"],
    ...diagnostics.conversations.map((item) => [
      item.conversation_id,
      item.summary_timestamp ?? "",
      item.cursor_timestamp ?? "",
      item.cursor_message_id ?? "",
      item.decision,
      item.reason,
    ]),
  ];
  return [
    `captured_at\t${diagnostics.captured_at ?? ""}`,
    `mode\t${diagnostics.mode ?? ""}`,
    `checkpoint\t${diagnostics.checkpoint ?? ""}`,
    ...rows.map((row) => row.join("\t")),
  ].join("\n");
}

async function refreshStoredState() {
  const stored = await readStorage([
    STORAGE.config,
    STORAGE.detectedAccount,
    STORAGE.status,
    STORAGE.scanState,
    STORAGE.pending,
    STORAGE.live,
    STORAGE.unexpected,
    STORAGE.syncDiagnostics,
  ]);
  storedConfig = configOrEmpty(stored[STORAGE.config]);
  detectedAccount = stored[STORAGE.detectedAccount] ?? null;
  storedStatus = stored[STORAGE.status] ?? null;
  scanStates = stored[STORAGE.scanState] ?? null;
  pendingStates = stored[STORAGE.pending] ?? null;
  liveState = stored[STORAGE.live] ?? null;
  unexpected = Array.isArray(stored[STORAGE.unexpected]) ? stored[STORAGE.unexpected] : [];
  storedSyncDiagnostics = stored[STORAGE.syncDiagnostics] ?? null;
  renderDashboard();
  renderUnexpected();
  renderSyncDiagnostics();
}

async function detectAccount() {
  try {
    const result = await chrome.runtime.sendMessage({ type: "detect_account" });
    if (result?.ok) {
      detectedAccount = result.account;
      renderDashboard();
      return;
    }
  } catch {
    // The retry state below remains available.
  }
  if (accountButton.dataset.accountId) return;
  accountIdValue.textContent = "Retry";
  accountButton.disabled = false;
  accountButton.title = "Try detecting the Shop ID again";
  setAccountStatus("Not detected", "warning");
  progressArea.hidden = true;
}

function renderConfigEditor() {
  configInput.value = JSON.stringify(storedConfig, null, 2);
  configInput.disabled = false;
  document.querySelector("#save-config").disabled = false;
  configCount.textContent = "Current saved configuration";
  exportButton.disabled = storedConfig.accounts.length === 0;
}

function openConfig() {
  brandHeader.hidden = true;
  dashboardScreen.hidden = true;
  errorsScreen.hidden = true;
  configScreen.hidden = false;
  setHeaderActionsVisible(false);
  setConfigStatus("");
  renderConfigEditor();
}

function closeConfig() {
  brandHeader.hidden = false;
  configScreen.hidden = true;
  errorsScreen.hidden = true;
  dashboardScreen.hidden = false;
  setHeaderActionsVisible(true);
  renderDashboard();
}

async function showSyncResult(result) {
  if (!result?.ok) {
    renderDashboard(result?.error ?? "Sync failed.", true);
  } else {
    await refreshStoredState();
  }
}

async function load() {
  document.querySelector("#version").textContent = `v${chrome.runtime.getManifest().version}`;
  const stored = await readStorage([
    STORAGE.config,
    STORAGE.consent,
    STORAGE.detectedAccount,
    STORAGE.status,
    STORAGE.scanState,
    STORAGE.pending,
    STORAGE.live,
    STORAGE.unexpected,
    STORAGE.syncDiagnostics,
  ]);
  const consented = hasLocalConsent(stored[STORAGE.consent]);
  storedConsent = stored[STORAGE.consent] ?? null;
  storedConfig = configOrEmpty(stored[STORAGE.config]);
  detectedAccount = stored[STORAGE.detectedAccount] ?? null;
  storedStatus = stored[STORAGE.status] ?? null;
  scanStates = stored[STORAGE.scanState] ?? null;
  pendingStates = stored[STORAGE.pending] ?? null;
  liveState = stored[STORAGE.live] ?? null;
  unexpected = Array.isArray(stored[STORAGE.unexpected]) ? stored[STORAGE.unexpected] : [];
  storedSyncDiagnostics = stored[STORAGE.syncDiagnostics] ?? null;
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  popupTabId = activeTab?.id ?? null;
  isShopeeChatTab = activeTab?.url?.startsWith("https://seller.shopee.co.th/new-webchat/conversations") ?? false;
  const showConsentScreen = !consented;
  const showHintScreen = consented && !isShopeeChatTab;
  const showDashboard = consented && isShopeeChatTab;
  consentScreen.hidden = !showConsentScreen;
  hintScreen.hidden = !showHintScreen;
  brandHeader.hidden = false;
  dashboardScreen.hidden = !showDashboard;
  configScreen.hidden = true;
  errorsScreen.hidden = true;
  setHeaderActionsVisible(consented && isShopeeChatTab);
  viewingPrivacy = false;
  renderConsentScreen();
  renderDashboard();
  renderUnexpected();
  renderSyncDiagnostics();
  if (consented) void detectAccount();
  if (consented) void chrome.runtime.sendMessage({ type: "get_live_state" }).catch(() => undefined);
}

consentInput.addEventListener("change", () => {
  continueButton.disabled = !consentInput.checked;
  if (consentInput.checked) consentError.textContent = "";
});

continueButton.addEventListener("click", async () => {
  try {
    if (!consentInput.checked) throw new Error("Please agree to continue.");
    const stored = await readStorage([STORAGE.consent]);
    if (!hasLocalConsent(stored[STORAGE.consent])) {
      await writeStorage({
        [STORAGE.consent]: { policy_version: 2, accepted_at: new Date().toISOString() },
      });
    }
    await load();
  } catch (error) {
    consentError.textContent = error.message;
  }
});

openPrivacyButton.addEventListener("click", () => {
  brandHeader.hidden = true;
  viewingPrivacy = true;
  dashboardScreen.hidden = true;
  hintScreen.hidden = true;
  configScreen.hidden = true;
  errorsScreen.hidden = true;
  consentScreen.hidden = false;
  setHeaderActionsVisible(false);
  renderConsentScreen();
});

closePrivacyButton.addEventListener("click", () => {
  const consented = hasLocalConsent(storedConsent);
  const showConsentScreen = !consented;
  const showHintScreen = consented && !isShopeeChatTab;
  brandHeader.hidden = false;
  viewingPrivacy = false;
  consentScreen.hidden = !showConsentScreen;
  hintScreen.hidden = !showHintScreen;
  dashboardScreen.hidden = !isShopeeChatTab || showConsentScreen;
  setHeaderActionsVisible(consented && isShopeeChatTab);
});

syncButton.addEventListener("click", async () => {
  if (syncButton.dataset.action === "configure") {
    openConfig();
    return;
  }
  syncButton.disabled = true;
  progressArea.hidden = false;
  syncProgress.hidden = true;
  status.classList.remove("error");
  status.textContent = "Checking for missed messages…";
  try {
    await requestTargetPermission(accountOrigins(storedConfig));
    await showSyncResult(await chrome.runtime.sendMessage({ type: "sync_now" }));
  } catch (error) {
    renderDashboard(error.message, true);
  }
});

document.querySelector("#open-config").addEventListener("click", openConfig);
accountStatus.addEventListener("click", () => {
  if (accountStatus.dataset.action === "config") openConfig();
  else if (accountStatus.dataset.action === "logs") openErrors();
});
leaderStatus.addEventListener("click", async () => {
  const isLeader = leaderStatus.dataset.leader === "true";
  const result = await chrome.runtime.sendMessage(isLeader
    ? { type: "release_leader" }
    : { type: "claim_leader", tab_id: popupTabId });
  if (!result?.ok) renderDashboard(result?.error ?? "Could not update leader.", true);
});
document.querySelector("#close-config").addEventListener("click", closeConfig);
function openErrors() {
  brandHeader.hidden = true;
  dashboardScreen.hidden = true;
  setHeaderActionsVisible(false);
  errorsScreen.hidden = false;
}
openErrorsButton.addEventListener("click", openErrors);
document.querySelector("#close-errors").addEventListener("click", () => {
  brandHeader.hidden = false;
  errorsScreen.hidden = true;
  dashboardScreen.hidden = false;
  setHeaderActionsVisible(true);
});
copyErrorsButton.addEventListener("click", async () => {
  const report = unexpected
    .map((item) => [item.at || "Unknown time", item.scope || "Extension", item.message || "Unknown error"].join(" · "))
    .join("\n");
  try {
    await navigator.clipboard.writeText(report);
    copyErrorsButton.textContent = "Copied";
  } catch {
    copyErrorsButton.textContent = "Could not copy";
  }
  setTimeout(() => { copyErrorsButton.textContent = "Copy all"; }, 1_200);
});

copyDiagnosticsButton.addEventListener("click", async () => {
  const diagnostics = currentSyncDiagnostics();
  if (!diagnostics?.conversations?.length) return;
  try {
    await navigator.clipboard.writeText(formatSyncDiagnostics(diagnostics));
    copyDiagnosticsButton.textContent = "Copied";
  } catch {
    copyDiagnosticsButton.textContent = "Could not copy";
  }
  setTimeout(() => { copyDiagnosticsButton.textContent = "Copy sync diagnostics"; }, 1_200);
});

document.querySelector("#save-config").addEventListener("click", async () => {
  try {
    const config = validateConfigFile(JSON.parse(configInput.value));
    await writeStorage({ [STORAGE.config]: config });
    storedConfig = config;
    renderConfigEditor();
    try {
      await requestTargetPermission(accountOrigins(config));
      setConfigStatus("Configuration saved.");
    } catch (error) {
      setConfigStatus(`Configuration saved. ${error.message}`, true);
    }
  } catch (error) {
    setConfigStatus(error.message, true);
  }
});

document.querySelector("#import-config").addEventListener("click", () => configFile.click());

configFile.addEventListener("change", async () => {
  const file = configFile.files?.[0];
  if (!file) return;
  try {
    const config = validateConfigFile(JSON.parse(await file.text()));
    await writeStorage({ [STORAGE.config]: config });
    storedConfig = config;
    let message = `Imported ${config.accounts.length} account${config.accounts.length === 1 ? "" : "s"}.`;
    let permissionError = false;
    try {
      await requestTargetPermission(accountOrigins(config));
      message += " Server access approved.";
    } catch (error) {
      message += ` ${error.message}`;
      permissionError = true;
    }
    if (configScreen.hidden) renderDashboard(message, permissionError);
    else {
      setConfigStatus(message, permissionError);
      renderConfigEditor();
    }
  } catch (error) {
    if (configScreen.hidden) renderDashboard(error.message, true);
    else setConfigStatus(error.message, true);
  } finally {
    configFile.value = "";
  }
});

document.querySelector("#export-config").addEventListener("click", () => {
  if (!confirm("Export includes HMAC secrets. Save the file somewhere secure?")) return;
  const blob = new Blob([`${JSON.stringify(storedConfig, null, 2)}\n`], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "omnichat-bridge-config.json";
  link.click();
  URL.revokeObjectURL(url);
  if (configScreen.hidden) renderDashboard("Configuration exported.");
  else setConfigStatus("Configuration exported.");
});

clearButton.addEventListener("click", async () => {
  if (!confirm("Erase all local extension data, including accounts, consent, pending messages, sync cursors, and logs?")) return;
  await chrome.alarms.clear("omnichat-delivery-retry");
  await chrome.storage.local.clear();
  await load();
});

accountButton.addEventListener("click", async () => {
  const id = accountButton.dataset.accountId;
  if (!id) {
    await detectAccount();
    return;
  }
  await navigator.clipboard.writeText(id);
  accountIdValue.textContent = "Copied";
  setTimeout(() => {
    accountIdValue.textContent = id;
  }, 900);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes[STORAGE.config] || changes[STORAGE.detectedAccount] || changes[STORAGE.status] || changes[STORAGE.scanState] || changes[STORAGE.pending] || changes[STORAGE.live] || changes[STORAGE.unexpected] || changes[STORAGE.commandTab] || changes[STORAGE.syncDiagnostics]) {
    void refreshStoredState();
  }
});

void load();
