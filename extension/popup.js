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
import "./lib/shopee-url.js";

const { isShopeeChatUrl } = globalThis.OmnichatShopeeUrl;
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
const providerUserId = document.querySelector("#provider-user-id");
const shopUserId = document.querySelector("#shop-user-id");
const accountList = document.querySelector("#account-list");
const accountListEmpty = document.querySelector("#account-list-empty");
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
let detectedAccounts = [];
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

function setSettingsButtonVisible(visible) {
  settingsButton.hidden = !visible;
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

function setLeaderStatus(label, state, action, isLeader = false) {
  leaderStatus.dataset.state = state;
  leaderStatus.dataset.action = action;
  leaderStatus.dataset.leader = String(isLeader);
  leaderCurrent.textContent = label;
  leaderStatus.setAttribute("aria-label", label);
  leaderStatus.title = action === "config"
    ? "Open settings"
    : isLeader
      ? "Unset this installation as leader"
      : "Set this tab as leader";
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

function showAccounts(accounts) {
  const values = (key) => [...new Set(
    accounts
      .map((account) => account?.[key])
      .filter((value) => typeof value === "string" || typeof value === "number")
      .map((value) => String(value).trim())
      .filter(Boolean),
  )];
  setUserBadges(providerUserId, values("provider_user_id"));
  setUserBadges(shopUserId, values("shop_user_id"));
}

function setUserBadges(element, values) {
  const normalized = Array.isArray(values)
    ? values.map((value) => String(value).trim()).filter(Boolean)
    : [];
  const row = element.closest(".account-identifier");
  if (row) row.hidden = normalized.length === 0;
  element.hidden = normalized.length === 0;
  element.replaceChildren(...normalized.map((value) => {
    const badge = document.createElement("span");
    badge.className = "user-id-badge";
    badge.textContent = value;
    return badge;
  }));
}

function accountRowStatus(account) {
  const key = accountConfigKey(account);
  const config = findAccountConfig(storedConfig, account);
  if (!config) return { label: "NEED CONFIG", state: "warning", action: "config" };
  const syncState = readAccountState(storedStatus, key, null);
  const live = readAccountState(liveState, key, null);
  const currentError = syncState?.delivery_error || syncState?.sync_error;
  if (currentError) return { label: "Error · open Logs", state: "error", action: "logs" };
  if (["discovering", "syncing"].includes(syncState?.state)) return { label: "SYNCING", state: "ready" };
  if (live?.socket === "connected") return { label: "CONNECTED", state: "ready" };
  if (["disconnected", "reconnecting"].includes(live?.socket)) return { label: "OFFLINE", state: "warning" };
  return { label: "READY", state: "ready" };
}

async function copyShopId(providerAccountId, button, valueElement) {
  try {
    await navigator.clipboard.writeText(providerAccountId);
    valueElement.textContent = "Copied";
    button.title = "Copied";
  } catch {
    valueElement.textContent = "Could not copy";
    button.title = "Could not copy Shop ID";
  }
  setTimeout(() => {
    valueElement.textContent = providerAccountId;
    button.title = "Copy Shop ID";
  }, 900);
}

function createCopyIcon() {
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.classList.add("copy-icon");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("aria-hidden", "true");
  for (const d of [
    "M9 8.5A2.5 2.5 0 0 1 11.5 6h6A2.5 2.5 0 0 1 20 8.5v8a2.5 2.5 0 0 1-2.5 2.5h-6A2.5 2.5 0 0 1 9 16.5z",
    "M15 6V5.5A2.5 2.5 0 0 0 12.5 3h-6A2.5 2.5 0 0 0 4 5.5v8A2.5 2.5 0 0 0 6.5 16H9",
  ]) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    icon.append(path);
  }
  return icon;
}

function renderDetectedAccounts() {
  const accounts = detectedAccounts;
  accountList.replaceChildren();
  accountListEmpty.hidden = accounts.length !== 0;
  for (const account of accounts) {
    const id = account.provider === "shopee" ? String(account.provider_account_id ?? "").trim() : "";
    if (!id) continue;
    const cardState = accountRowStatus(account);
    const card = document.createElement("div");
    card.className = "account-row";
    card.dataset.accountId = id;
    card.dataset.state = cardState.state;
    const select = document.createElement("div");
    select.className = "account-row-select";
    const copy = document.createElement("span");
    copy.className = "account-row-copy";
    const name = document.createElement("strong");
    name.textContent = account.display_name || "Shopee shop";
    const statusLabel = document.createElement(cardState.action ? "a" : "span");
    statusLabel.className = "account-row-status";
    statusLabel.dataset.state = cardState.state;
    statusLabel.textContent = cardState.label;
    if (cardState.action) {
      statusLabel.href = cardState.action === "config" ? "#config" : "#logs";
      statusLabel.classList.add("account-row-status-link");
      statusLabel.title = cardState.action === "config" ? "Open settings" : "Open error logs";
      statusLabel.setAttribute(
        "aria-label",
        cardState.action === "config"
          ? `Open settings to configure ${account.display_name || "Shopee shop"}`
          : `Open error logs for ${account.display_name || "Shopee shop"}`,
      );
      statusLabel.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (cardState.action === "config") openConfig();
        else openLogs("error");
      });
    }
    copy.append(name, statusLabel);
    select.append(copy);
    const shopId = document.createElement("button");
    shopId.type = "button";
    shopId.className = "account-row-id";
    shopId.title = "Copy Shop ID";
    shopId.setAttribute("aria-label", `Copy Shop ID ${id}`);
    const shopIdValue = document.createElement("span");
    shopIdValue.textContent = id;
    shopId.append(shopIdValue, createCopyIcon());
    shopId.addEventListener("click", () => void copyShopId(id, shopId, shopIdValue));
    card.append(select, shopId);
    accountList.append(card);
  }
}

function renderDashboard(message = "", isError = false) {
  showAccounts(detectedAccounts);
  renderDetectedAccounts();
  status.replaceChildren();
  status.classList.toggle("error", isError);
  lastSync.hidden = true;
  lastSync.textContent = "";
  const accountStates = detectedAccounts.map((account) => {
    const key = accountConfigKey(account);
    return {
      account,
      key,
      config: findAccountConfig(storedConfig, account),
      syncState: readAccountState(storedStatus, key, null),
      scanState: readAccountState(scanStates, key, null),
      pending: readAccountState(pendingStates, key, []),
      live: readAccountState(liveState, key, null),
    };
  });
  const configuredStates = accountStates.filter((item) => item.config);
  const anySyncing = configuredStates.some((item) => ["discovering", "syncing"].includes(item.syncState?.state));
  const anyPending = configuredStates.some((item) => item.pending.length > 0 || item.scanState?.in_progress);
  const anyError = configuredStates.some((item) => item.syncState?.delivery_error || item.syncState?.sync_error);
  const pendingTotal = configuredStates.reduce((total, item) => total + item.pending.length, 0);
  const progressState = configuredStates.find((item) => ["discovering", "syncing"].includes(item.syncState?.state))?.syncState;
  const latestResult = configuredStates
    .map((item) => item.syncState?.last_result)
    .filter(Boolean)
    .at(-1);
  const anyLeader = configuredStates.some((item) => item.live?.leader);
  const latestSync = configuredStates
    .map((item) => item.syncState?.last_sync_at)
    .filter(Boolean)
    .sort()
    .at(-1);

  if (!detectedAccounts.length) {
    const openSellerChat = !isShopeeChatTab;
    setLeaderStatus("NEED CONFIG", "warning", "config");
    status.textContent = message || (openSellerChat ? "Open Shopee Seller Chat to detect your Shop IDs." : "");
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

  if (!configuredStates.length) {
    setLeaderStatus("NEED CONFIG", "warning", "config");
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

  status.classList.toggle("error", isError || anyError);
  setLeaderStatus(anyLeader ? "LEADER" : "STANDBY", anyLeader ? "ready" : "neutral", "leader", anyLeader);
  syncButton.disabled = anySyncing;
  syncButton.dataset.action = "sync";
  syncButton.textContent = anySyncing ? "Syncing…" : anyPending || anyError ? "Retry now" : "Sync messages";
  syncButton.setAttribute("aria-label", syncButton.textContent);
  syncButton.title = "";
  cancelSyncButton.hidden = !anySyncing;
  cancelSyncButton.disabled = false;
  cancelSyncButton.textContent = "Cancel sync";
  const lastSyncText = formatLastSync(latestSync);
  if (lastSyncText) {
    lastSync.textContent = lastSyncText;
    lastSync.hidden = false;
  }

  if (progressState?.state === "syncing") {
    const completed = Number(progressState.completed_conversations) || 0;
    const total = Number(progressState.total_conversations) || 0;
    const percentage = total ? Math.round((completed / total) * 100) : 0;
    syncProgress.hidden = false;
    syncProgress.value = percentage;
    progressArea.hidden = false;
    status.textContent = `Checking conversation ${completed} of ${total} · ${percentage}%`;
  } else if (progressState?.state === "discovering") {
    syncProgress.hidden = true;
    progressArea.hidden = false;
    status.textContent = SYNC_PHASE_LABELS[progressState.phase] ?? "Starting sync…";
  } else {
    const resultMessage = message
      || (anyError
        ? `${pendingTotal ? `${pendingTotal} pending. ` : ""}Open Logs for details.`
        : "")
      || formatSyncResult(latestResult);
    syncProgress.hidden = true;
    progressArea.hidden = !lastSyncText && !resultMessage;
    if (message || !anyError) {
      status.textContent = resultMessage;
    } else {
      if (pendingTotal) status.append(`${pendingTotal} pending. `);
      const logsLink = document.createElement("a");
      logsLink.href = "#logs";
      logsLink.className = "status-log-link";
      logsLink.textContent = "Open Logs for details";
      logsLink.addEventListener("click", (event) => {
        event.preventDefault();
        openLogs("error");
      });
      status.append(logsLink);
    }
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
  const provider = "shopee";
  const accountId = "all-shops";
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
    STORAGE.detectedAccounts,
    STORAGE.status,
    STORAGE.scanState,
    STORAGE.pending,
    STORAGE.live,
    STORAGE.logs,
    STORAGE.deviceName,
  ]);
  storedConfig = configOrEmpty(stored[STORAGE.config]);
  detectedAccounts = Array.isArray(stored[STORAGE.detectedAccounts])
    ? stored[STORAGE.detectedAccounts]
    : [];
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
      detectedAccounts = Array.isArray(result.accounts) ? result.accounts : [];
      renderDashboard();
      return true;
    }
  } catch {
    // The retry state below remains available.
  }
  setLeaderStatus("NEED CONFIG", "warning", "config");
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
  hintScreen.hidden = true;
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
  const consented = hasLocalConsent(storedConsent);
  const showHintScreen = consented && !isShopeeChatTab;
  const showDashboard = consented && isShopeeChatTab;
  hintScreen.hidden = !showHintScreen;
  dashboardScreen.hidden = !showDashboard;
  setHeaderActionsVisible(showDashboard);
  setSettingsButtonVisible(consented);
  if (showDashboard) renderDashboard();
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
  if (!(await detectAccount())) throw new Error("Could not detect Shopee Shop IDs. Try again from Shopee Seller Chat.");
  const configuredAccount = detectedAccounts.some((account) => config.accounts.some((configured) => (
    configured.provider === account.provider
      && configured.provider_account_id === account.provider_account_id
  )));
  if (!configuredAccount) throw new Error("Saved configuration does not include any detected Shop ID.");

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
    STORAGE.detectedAccounts,
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
  detectedAccounts = Array.isArray(stored[STORAGE.detectedAccounts])
    ? stored[STORAGE.detectedAccounts]
    : [];
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
  isShopeeChatTab = isShopeeChatUrl(activeTab?.url);
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
  setSettingsButtonVisible(consented);
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
  setSettingsButtonVisible(consented);
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
      result?.ok && result.cancelled ? "Sync cancelled." : result?.error ?? "No sync in progress.",
      !result?.ok,
    );
  } catch (error) {
    renderDashboard(error.message, true);
  }
});

document.querySelector("#open-config").addEventListener("click", openConfig);
leaderStatus.addEventListener("click", async () => {
  if (leaderStatus.dataset.action === "config") {
    openConfig();
    return;
  }
  const isLeader = leaderStatus.dataset.leader === "true";
  const result = await chrome.runtime.sendMessage(isLeader
    ? { type: "release_leader" }
    : { type: "claim_leader", tab_id: popupTabId });
  if (!result?.ok) renderDashboard(result?.error ?? "Could not update leader.", true);
});
document.querySelector("#close-config").addEventListener("click", closeConfig);
function openLogs(level = null) {
  brandHeader.hidden = true;
  dashboardScreen.hidden = true;
  setHeaderActionsVisible(false);
  logsScreen.hidden = false;
  if (level) logLevel.value = level;
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
  if (changes[STORAGE.config] || changes[STORAGE.deviceName] || changes[STORAGE.detectedAccounts] || changes[STORAGE.status] || changes[STORAGE.scanState] || changes[STORAGE.pending] || changes[STORAGE.live] || changes[STORAGE.logs] || changes[STORAGE.commandTab]) {
    void refreshStoredState();
  }
});

void load();
