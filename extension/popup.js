import {
  CONFIG_VERSION,
  accountConfigKey,
  accountOrigins,
  findAccountConfig,
  validateAccountConfig,
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
const configSelect = document.querySelector("#config-account");
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
let targetCursors = null;
let unexpected = [];
let commandTabs = null;
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

function configTemplate(account) {
  return {
    provider: account?.provider ?? "shopee",
    provider_account_id: account?.provider_account_id ?? "",
    events_url: "https://collector.example.com/omnichat/events",
    commands_url: "https://admin.example.com/api/omnichat/tickets",
    hmac_secret: "YOUR_HMAC_SECRET",
  };
}

const configPlaceholder = JSON.stringify({
  provider: "shopee",
  provider_account_id: "SHOP_ID",
  events_url: "https://collector.example.com/omnichat/events",
  commands_url: "https://admin.example.com/api/omnichat/tickets",
  hmac_secret: "YOUR_HMAC_SECRET",
}, null, 2);

async function requestTargetPermission(urls) {
  const origins = [...new Set(urls.map((value) => {
    const url = new URL(value);
    return `${url.protocol === "wss:" ? "https:" : url.protocol}//${url.host}/*`;
  }))];
  if (!await chrome.permissions.request({ origins })) {
    throw new Error("Server permission was not granted.");
  }
}

function setAccountStatus(label, state) {
  accountStatus.dataset.state = state;
  connectionStatus.textContent = label;
  accountStatus.disabled = label !== "Need config";
  accountStatus.title = accountStatus.disabled ? "" : "Open settings";
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
  const recovered = Number(result.recovered) || 0;
  const sent = Number(result.sent) || 0;
  const pending = Number(result.pending) || 0;
  if (!recovered && !sent && !pending) return "Checked Shopee. No newer messages.";
  return `Scanned ${recovered}. Sent ${sent}. Pending ${pending}.`;
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
  const targetCursor = readAccountState(targetCursors, key, null);
  const hasCursor = Object.keys(targetCursor?.conversations ?? {}).length > 0;
  const live = readAccountState(liveState, key, null);
  const commandTabId = readAccountState(commandTabs, key, null);
  const isSelectedCommandTab = Number.isInteger(commandTabId) && commandTabId === popupTabId;
  const isLeaderTab = Boolean(live?.leader) && isSelectedCommandTab;
  const socketConnected = live?.socket === "connected";
  leaderStatus.hidden = !key || !config;
  leaderCurrent.textContent = isLeaderTab ? "Leader" : "Standby";
  leaderStatus.querySelector(".leader-action").textContent = isLeaderTab ? "Unset leader" : "Set leader";
  leaderStatus.dataset.leader = String(isLeaderTab);
  leaderStatus.title = isLeaderTab ? "Unset this tab as leader" : "Set this tab as leader";

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
    setAccountStatus("Need config", "warning");
    status.textContent = message;
    syncButton.disabled = false;
    syncButton.dataset.action = "configure";
    syncButton.textContent = "Configure";
    syncProgress.hidden = true;
    progressArea.hidden = !message;
    return;
  }

  setAccountStatus(socketConnected ? "Connected" : live ? "Offline" : "Connecting", socketConnected ? "ready" : "neutral");
  syncButton.disabled = false;
  syncButton.dataset.action = "sync";
  syncButton.textContent = syncState?.caught_up ? "Refresh messages" : "Sync messages";
  const lastSyncText = formatLastSync(syncState?.last_sync_at);
  if (hasCursor && lastSyncText) {
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
  } else {
    const resultMessage = message || (hasCursor ? formatSyncResult(syncState?.last_result) : "");
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

async function refreshStoredState() {
  const stored = await readStorage([STORAGE.config, STORAGE.detectedAccount, STORAGE.status, STORAGE.targetCursor, STORAGE.live, STORAGE.unexpected, STORAGE.commandTab]);
  storedConfig = configOrEmpty(stored[STORAGE.config]);
  detectedAccount = stored[STORAGE.detectedAccount] ?? null;
  storedStatus = stored[STORAGE.status] ?? null;
  targetCursors = stored[STORAGE.targetCursor] ?? null;
  liveState = stored[STORAGE.live] ?? null;
  unexpected = Array.isArray(stored[STORAGE.unexpected]) ? stored[STORAGE.unexpected] : [];
  commandTabs = stored[STORAGE.commandTab] ?? null;
  renderDashboard();
  renderUnexpected();
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

function configOptionLabel(account) {
  const isDetected = account.provider === detectedAccount?.provider
    && account.provider_account_id === detectedAccount?.provider_account_id;
  return `${isDetected ? "Current · " : ""}${account.provider.toUpperCase()} · ${account.provider_account_id}`;
}

function renderConfigEditor(preferredKey) {
  const detectedKey = accountConfigKey(detectedAccount);
  const accounts = [...storedConfig.accounts];
  if (detectedKey && !accounts.some((account) => accountConfigKey(account) === detectedKey)) {
    accounts.unshift(configTemplate(detectedAccount));
  }

  configSelect.replaceChildren();
  for (const account of accounts) {
    const option = document.createElement("option");
    option.value = accountConfigKey(account);
    option.textContent = configOptionLabel(account);
    configSelect.append(option);
  }

  if (!accounts.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Detect a Shopee account first";
    configSelect.append(option);
    configInput.value = "";
    configInput.placeholder = "";
    configInput.disabled = true;
    document.querySelector("#save-config").disabled = true;
  } else {
    const selectedKey = preferredKey && accounts.some((account) => accountConfigKey(account) === preferredKey)
      ? preferredKey
      : detectedKey ?? accountConfigKey(accounts[0]);
    configSelect.value = selectedKey;
    const selected = storedConfig.accounts.find((account) => accountConfigKey(account) === selectedKey);
    configInput.value = selected ? JSON.stringify(selected, null, 2) : "";
    configInput.placeholder = selected ? "" : configPlaceholder;
    configInput.disabled = false;
    document.querySelector("#save-config").disabled = false;
  }
  configCount.textContent = `${storedConfig.accounts.length} account${storedConfig.accounts.length === 1 ? "" : "s"} saved`;
  exportButton.disabled = storedConfig.accounts.length === 0;
}

function openConfig() {
  brandHeader.hidden = true;
  dashboardScreen.hidden = true;
  errorsScreen.hidden = true;
  configScreen.hidden = false;
  setHeaderActionsVisible(false);
  setConfigStatus("");
  renderConfigEditor(accountConfigKey(detectedAccount));
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
    STORAGE.targetCursor,
    STORAGE.live,
    STORAGE.unexpected,
    STORAGE.commandTab,
  ]);
  const consented = hasLocalConsent(stored[STORAGE.consent]);
  storedConsent = stored[STORAGE.consent] ?? null;
  storedConfig = configOrEmpty(stored[STORAGE.config]);
  detectedAccount = stored[STORAGE.detectedAccount] ?? null;
  storedStatus = stored[STORAGE.status] ?? null;
  targetCursors = stored[STORAGE.targetCursor] ?? null;
  liveState = stored[STORAGE.live] ?? null;
  unexpected = Array.isArray(stored[STORAGE.unexpected]) ? stored[STORAGE.unexpected] : [];
  commandTabs = stored[STORAGE.commandTab] ?? null;
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
  syncProgress.hidden = false;
  syncProgress.removeAttribute("value");
  status.classList.remove("error");
  status.textContent = "Starting sync…";
  try {
    await requestTargetPermission(accountOrigins(storedConfig));
    await showSyncResult(await chrome.runtime.sendMessage({ type: "sync_now" }));
  } catch (error) {
    renderDashboard(error.message, true);
  }
});

document.querySelector("#open-config").addEventListener("click", openConfig);
accountStatus.addEventListener("click", () => {
  if (!accountStatus.disabled) openConfig();
});
leaderStatus.addEventListener("click", async () => {
  const isLeader = leaderStatus.dataset.leader === "true";
  const result = await chrome.runtime.sendMessage(isLeader
    ? { type: "release_leader" }
    : { type: "claim_leader", tab_id: popupTabId });
  if (!result?.ok) renderDashboard(result?.error ?? "Could not update leader.", true);
});
document.querySelector("#close-config").addEventListener("click", closeConfig);
openErrorsButton.addEventListener("click", () => {
  brandHeader.hidden = true;
  dashboardScreen.hidden = true;
  setHeaderActionsVisible(false);
  errorsScreen.hidden = false;
});
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

configSelect.addEventListener("change", () => {
  const account = storedConfig.accounts.find((item) => accountConfigKey(item) === configSelect.value);
  configInput.value = account ? JSON.stringify(account, null, 2) : "";
  configInput.placeholder = account ? "" : configPlaceholder;
  setConfigStatus("");
});

document.querySelector("#save-config").addEventListener("click", async () => {
  try {
    const account = validateAccountConfig(JSON.parse(configInput.value));
    const selectedKey = configSelect.value;
    if (selectedKey && accountConfigKey(account) !== selectedKey) {
      throw new Error("Shop ID cannot be changed while editing this account.");
    }
    const accounts = storedConfig.accounts.filter(
      (item) => accountConfigKey(item) !== accountConfigKey(account),
    );
    const config = validateConfigFile({
      version: CONFIG_VERSION,
      accounts: [...accounts, account],
    });
    await requestTargetPermission(accountOrigins(config));
    await writeStorage({ [STORAGE.config]: config });
    storedConfig = config;
    setConfigStatus("Account saved.");
    renderConfigEditor(accountConfigKey(account));
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
    const message = `Imported ${config.accounts.length} account${config.accounts.length === 1 ? "" : "s"}. Sync to approve the configured server.`;
    if (configScreen.hidden) renderDashboard(message);
    else {
      setConfigStatus(message);
      renderConfigEditor(accountConfigKey(detectedAccount));
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
  if (!confirm("Clear all accounts, consent, pending messages, and sync cursors?")) return;
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
  if (changes[STORAGE.config] || changes[STORAGE.detectedAccount] || changes[STORAGE.status] || changes[STORAGE.targetCursor] || changes[STORAGE.live] || changes[STORAGE.unexpected] || changes[STORAGE.commandTab]) {
    void refreshStoredState();
  }
});

void load();
