import {
  CONFIG_VERSION,
  accountConfigKey,
  accountOrigins,
  findAccountConfig,
  validateConfigFile,
} from "./lib/config.js";
import { pruneLogs } from "./lib/logs.js";
import {
  STORAGE,
  hasLocalConsent,
  installationId,
  normalizeDeviceName,
  readAccountState,
  readStorage,
  writeStorage,
} from "./lib/storage.js";

const emptyConfig = () => ({ version: CONFIG_VERSION, accounts: [] });
const SYNC_PHASE_LABELS = {
  preparing: "Preparing sync…",
  sending_pending: "Sending previously queued messages…",
  loading_conversations: "Loading Shopee conversations…",
  checking_conversations: "Checking conversations for missed messages…",
  sending_recovered: "Sending recovered messages to your server…",
};
const sampleConfig = {
  version: CONFIG_VERSION,
  accounts: [{
    provider: "shopee",
    provider_account_id: "123456789",
    events_url: "https://your-server.example.com/omnichat/events",
    commands_url: "https://your-server.example.com/omnichat/tickets",
    image_server_url: "https://your-images.example.com",
    logs_url: "https://your-server.example.com/omnichat/logs",
    hmac_secret: "replace-with-your-secret",
  }],
};

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
const cancelSyncButton = document.querySelector("#cancel-sync");
const syncProgress = document.querySelector("#sync-progress");
const progressArea = document.querySelector("#progress-area");
const status = document.querySelector("#status");
const configCount = document.querySelector("#config-count");
const configInput = document.querySelector("#config");
const deviceNameInput = document.querySelector("#device-name");
const configStatus = document.querySelector("#config-status");
const configFile = document.querySelector("#config-file");
const leaderStatus = document.querySelector("#leader-status");
const leaderCurrent = leaderStatus.querySelector(".leader-current");
const openLogsButton = document.querySelector("#open-logs");
const logsScreen = document.querySelector("#logs-screen");
const logList = document.querySelector("#log-list");
const logEmpty = document.querySelector("#log-empty");
const copyLogsButton = document.querySelector("#copy-logs");
const downloadLogsButton = document.querySelector("#download-logs");
const clearLogsButton = document.querySelector("#clear-logs");
const logLevel = document.querySelector("#log-level");
const openPrivacyButton = document.querySelector("#open-privacy");
const closePrivacyButton = document.querySelector("#close-privacy");
const installationIdButton = document.querySelector("#installation-id");
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
let logs = [];
let popupTabId = null;
let storedConsent = null;
let storedDeviceName = "";
let viewingPrivacy = false;
let isShopeeChatTab = false;

function logPopup(level, event, message, details = {}) {
  void chrome.runtime.sendMessage({
    type: "record_log",
    level,
    area: "popup",
    event,
    message,
    details,
  }).catch(() => undefined);
}

function setHeaderActionsVisible(visible) {
  for (const button of [openLogsButton, settingsButton]) {
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
      ? "Open logs"
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
    syncButton.setAttribute("aria-label", "Sync messages");
    syncButton.title = "";
    cancelSyncButton.hidden = true;
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
    syncButton.setAttribute("aria-label", "Configure");
    syncButton.title = "";
    cancelSyncButton.hidden = true;
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
  syncButton.setAttribute("aria-label", syncButton.textContent);
  syncButton.title = "";
  cancelSyncButton.hidden = !syncing;
  cancelSyncButton.disabled = false;
  cancelSyncButton.textContent = "Cancel sync";
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
    status.textContent = `Checking conversation ${completed} of ${total} · ${percentage}%`;
  } else if (syncState?.state === "discovering") {
    syncProgress.hidden = true;
    progressArea.hidden = false;
    status.textContent = SYNC_PHASE_LABELS[syncState.phase] ?? "Starting sync…";
  } else {
    const resultMessage = message
      || (currentError
        ? `${pending.length ? `${pending.length} pending. ` : ""}Open Logs for details.`
        : "")
      || (hasCheckpoint ? formatSyncResult(syncState?.last_result) : "");
    syncProgress.hidden = true;
    progressArea.hidden = !lastSyncText && !resultMessage;
    status.textContent = resultMessage;
  }
}

function visibleLogs() {
  return logLevel.value === "all"
    ? logs
    : logs.filter((item) => item.level === logLevel.value);
}

function formatLogDetails(details) {
  return Object.entries(details ?? {})
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" · ");
}

function formatVisibleLogs() {
  return visibleLogs()
    .map((item) => [
      item.at || "Unknown time",
      item.level || "info",
      item.area || "extension",
      item.event || "unknown",
      item.message || "Extension event",
      formatLogDetails(item.details),
    ].filter(Boolean).join(" · "))
    .join("\n");
}

function safeFilenamePart(value, fallback) {
  const sanitized = String(value ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || fallback;
}

function logsFilename() {
  const provider = safeFilenamePart(detectedAccount?.provider, "unknown-provider");
  const accountId = safeFilenamePart(detectedAccount?.provider_account_id, "unknown-account");
  const version = safeFilenamePart(chrome.runtime.getManifest().version, "unknown");
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  return `omnichat-bridge-${provider}-${accountId}-v${version}-logs-${timestamp}.log`;
}

function renderLogs() {
  const visible = visibleLogs();
  openLogsButton.title = logs.length ? `Logs (${logs.length})` : "Logs";
  logList.replaceChildren();
  for (const item of visible) {
    const row = document.createElement("div");
    const timestamp = Number.isFinite(Date.parse(item.at ?? ""))
      ? new Date(item.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
      : "Unknown time";
    const details = formatLogDetails(item.details);
    row.dataset.level = item.level || "info";
    row.textContent = [
      timestamp,
      (item.level || "info").toUpperCase(),
      `${item.area || "extension"}.${item.event || "unknown"}`,
      item.message || "Extension event",
      details,
    ].filter(Boolean).join(" · ");
    logList.append(row);
  }
  logEmpty.textContent = logs.length
    ? "No logs match this level."
    : "No logs recorded yet.";
  logEmpty.hidden = visible.length !== 0;
  copyLogsButton.disabled = visible.length === 0;
  downloadLogsButton.disabled = visible.length === 0;
  clearLogsButton.disabled = logs.length === 0;
}

async function refreshStoredState() {
  const stored = await readStorage([
    STORAGE.config,
    STORAGE.detectedAccount,
    STORAGE.status,
    STORAGE.scanState,
    STORAGE.pending,
    STORAGE.live,
    STORAGE.logs,
    STORAGE.deviceName,
  ]);
  storedConfig = configOrEmpty(stored[STORAGE.config]);
  detectedAccount = stored[STORAGE.detectedAccount] ?? null;
  storedStatus = stored[STORAGE.status] ?? null;
  scanStates = stored[STORAGE.scanState] ?? null;
  pendingStates = stored[STORAGE.pending] ?? null;
  liveState = stored[STORAGE.live] ?? null;
  logs = pruneLogs(stored[STORAGE.logs]);
  storedDeviceName = typeof stored[STORAGE.deviceName] === "string"
    ? stored[STORAGE.deviceName]
    : "";
  renderDashboard();
  renderLogs();
}

async function detectAccount() {
  try {
    const result = await chrome.runtime.sendMessage({ type: "detect_account" });
    if (result?.ok) {
      detectedAccount = result.account;
      renderDashboard();
      return true;
    }
  } catch {
    // The retry state below remains available.
  }
  if (accountButton.dataset.accountId) return false;
  accountIdValue.textContent = "Retry";
  accountButton.disabled = false;
  accountButton.title = "Try detecting the Shop ID again";
  setAccountStatus("Not detected", "warning");
  progressArea.hidden = true;
  return false;
}

function renderConfigEditor() {
  const empty = storedConfig.accounts.length === 0;
  deviceNameInput.value = storedDeviceName;
  configInput.value = empty ? "" : JSON.stringify(storedConfig, null, 2);
  configInput.placeholder = JSON.stringify(sampleConfig, null, 2);
  configInput.disabled = false;
  document.querySelector("#save-config").disabled = false;
  configCount.textContent = empty ? "No saved accounts · sample shown below" : "Current saved configuration";
  exportButton.disabled = empty;
}

function openConfig() {
  brandHeader.hidden = true;
  dashboardScreen.hidden = true;
  logsScreen.hidden = true;
  configScreen.hidden = false;
  setHeaderActionsVisible(false);
  setConfigStatus("");
  renderConfigEditor();
}

function closeConfig() {
  brandHeader.hidden = false;
  configScreen.hidden = true;
  logsScreen.hidden = true;
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

function reportConfigurationStatus(message, isError = false) {
  if (configScreen.hidden) renderDashboard(message, isError);
  else setConfigStatus(message, isError);
}

async function autoStartSync(config) {
  if (!isShopeeChatTab) return false;
  if (!(await detectAccount())) throw new Error("Could not detect the Shop ID. Try again from Shopee Seller Chat.");
  const configuredAccount = config.accounts.some((account) => (
    account.provider === detectedAccount?.provider
    && account.provider_account_id === detectedAccount?.provider_account_id
  ));
  if (!configuredAccount) throw new Error("Saved configuration does not include the current Shop ID.");

  void chrome.runtime.sendMessage({ type: "sync_now" }).then((result) => {
    if (!result?.ok) reportConfigurationStatus(`Configuration saved. ${result?.error ?? "Sync failed."}`, true);
  }).catch((error) => {
    reportConfigurationStatus(`Configuration saved. ${error.message}`, true);
  });
  return true;
}

async function load() {
  document.querySelector("#version").textContent = `v${chrome.runtime.getManifest().version}`;
  const installId = await installationId();
  installationIdButton.dataset.installationId = installId;
  installationIdButton.textContent = `Installation ID: ${installId}`;
  const stored = await readStorage([
    STORAGE.config,
    STORAGE.consent,
    STORAGE.detectedAccount,
    STORAGE.status,
    STORAGE.scanState,
    STORAGE.pending,
    STORAGE.live,
    STORAGE.logs,
    STORAGE.deviceName,
  ]);
  const consented = hasLocalConsent(stored[STORAGE.consent]);
  storedConsent = stored[STORAGE.consent] ?? null;
  storedConfig = configOrEmpty(stored[STORAGE.config]);
  detectedAccount = stored[STORAGE.detectedAccount] ?? null;
  storedStatus = stored[STORAGE.status] ?? null;
  scanStates = stored[STORAGE.scanState] ?? null;
  pendingStates = stored[STORAGE.pending] ?? null;
  liveState = stored[STORAGE.live] ?? null;
  logs = pruneLogs(stored[STORAGE.logs]);
  storedDeviceName = typeof stored[STORAGE.deviceName] === "string"
    ? stored[STORAGE.deviceName]
    : "";
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
  logsScreen.hidden = true;
  setHeaderActionsVisible(consented && isShopeeChatTab);
  viewingPrivacy = false;
  renderConsentScreen();
  renderDashboard();
  renderLogs();
  if (consented) void detectAccount();
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
  logsScreen.hidden = true;
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

cancelSyncButton.addEventListener("click", async () => {
  cancelSyncButton.disabled = true;
  cancelSyncButton.textContent = "Cancelling…";
  status.classList.remove("error");
  status.textContent = "Cancelling sync…";
  try {
    const result = await chrome.runtime.sendMessage({ type: "cancel_sync" });
    await refreshStoredState();
    renderDashboard(
      result?.ok && result.cancelled ? "Sync cancelled." : result?.error ?? "No active sync.",
      !result?.ok,
    );
  } catch (error) {
    renderDashboard(error.message, true);
  }
});

document.querySelector("#open-config").addEventListener("click", openConfig);
accountStatus.addEventListener("click", () => {
  if (accountStatus.dataset.action === "config") openConfig();
  else if (accountStatus.dataset.action === "logs") openLogs();
});
leaderStatus.addEventListener("click", async () => {
  const isLeader = leaderStatus.dataset.leader === "true";
  const result = await chrome.runtime.sendMessage(isLeader
    ? { type: "release_leader" }
    : { type: "claim_leader", tab_id: popupTabId });
  if (!result?.ok) renderDashboard(result?.error ?? "Could not update leader.", true);
});
document.querySelector("#close-config").addEventListener("click", closeConfig);
function openLogs() {
  brandHeader.hidden = true;
  dashboardScreen.hidden = true;
  setHeaderActionsVisible(false);
  logsScreen.hidden = false;
  renderLogs();
}
openLogsButton.addEventListener("click", openLogs);
document.querySelector("#close-logs").addEventListener("click", () => {
  brandHeader.hidden = false;
  logsScreen.hidden = true;
  dashboardScreen.hidden = false;
  setHeaderActionsVisible(true);
});
copyLogsButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(formatVisibleLogs());
    copyLogsButton.textContent = "Copied";
  } catch {
    copyLogsButton.textContent = "Could not copy";
  }
  setTimeout(() => { copyLogsButton.textContent = "Copy"; }, 1_200);
});

downloadLogsButton.addEventListener("click", () => {
  const url = URL.createObjectURL(new Blob([`${formatVisibleLogs()}\n`], { type: "text/plain" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = logsFilename();
  link.click();
  URL.revokeObjectURL(url);
});

logLevel.addEventListener("change", renderLogs);

clearLogsButton.addEventListener("click", async () => {
  if (!confirm("Clear all local operational logs?")) return;
  const result = await chrome.runtime.sendMessage({ type: "clear_logs" });
  if (!result?.ok) return;
  logs = [];
  renderLogs();
});

document.querySelector("#save-config").addEventListener("click", async () => {
  try {
    const config = validateConfigFile(JSON.parse(configInput.value));
    const deviceName = normalizeDeviceName(deviceNameInput.value);
    const configurationChanged = JSON.stringify(config) !== JSON.stringify(storedConfig);
    await writeStorage({
      [STORAGE.config]: config,
      [STORAGE.deviceName]: deviceName,
      ...(configurationChanged ? {
        [STORAGE.serverInitialized]: false,
        [STORAGE.logUploadEnabled]: false,
        [STORAGE.logOutbox]: [],
      } : {}),
    });
    storedConfig = config;
    storedDeviceName = deviceName;
    logPopup("info", "configuration_saved", "Configuration saved.", {
      accounts: config.accounts.length,
      logs_enabled: config.accounts.some((account) => Boolean(account.logs_url)),
    });
    renderConfigEditor();
    try {
      await requestTargetPermission(accountOrigins(config));
      const syncStarted = configurationChanged && await autoStartSync(config);
      setConfigStatus(
        syncStarted
          ? "Configuration saved. Sync started."
          : configurationChanged
            ? "Configuration saved. Open Shopee Seller Chat to start sync."
            : "Configuration saved.",
      );
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
    await writeStorage({
      [STORAGE.config]: config,
      [STORAGE.serverInitialized]: false,
      [STORAGE.logUploadEnabled]: false,
      [STORAGE.logOutbox]: [],
    });
    storedConfig = config;
    logPopup("info", "configuration_imported", "Configuration imported.", {
      accounts: config.accounts.length,
      logs_enabled: config.accounts.some((account) => Boolean(account.logs_url)),
    });
    let message = `Imported ${config.accounts.length} account${config.accounts.length === 1 ? "" : "s"}.`;
    let permissionError = false;
    try {
      await requestTargetPermission(accountOrigins(config));
      message += " Server access approved.";
      if (await autoStartSync(config)) message += " Sync started.";
      else message += " Open Shopee Seller Chat to start sync.";
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
  logPopup("info", "configuration_exported", "Configuration exported.");
  if (configScreen.hidden) renderDashboard("Configuration exported.");
  else setConfigStatus("Configuration exported.");
});

clearButton.addEventListener("click", async () => {
  if (!confirm("Erase all local extension data, including device name, accounts, consent, pending messages, sync cursors, and logs?")) return;
  await chrome.alarms.clear("omnichat-delivery-retry");
  await chrome.alarms.clear("omnichat-log-upload");
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

installationIdButton.addEventListener("click", async () => {
  const id = installationIdButton.dataset.installationId;
  if (!id) return;
  await navigator.clipboard.writeText(id);
  installationIdButton.textContent = "Installation ID copied";
  setTimeout(() => {
    installationIdButton.textContent = `Installation ID: ${installationIdButton.dataset.installationId}`;
  }, 900);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes[STORAGE.config] || changes[STORAGE.deviceName] || changes[STORAGE.detectedAccount] || changes[STORAGE.status] || changes[STORAGE.scanState] || changes[STORAGE.pending] || changes[STORAGE.live] || changes[STORAGE.logs] || changes[STORAGE.commandTab]) {
    void refreshStoredState();
  }
});

void load();
