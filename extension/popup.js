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
const consentScreen = document.querySelector("#consent-screen");
const dashboardScreen = document.querySelector("#dashboard-screen");
const configScreen = document.querySelector("#config-screen");
const clearButton = document.querySelector("#clear");
const settingsButton = document.querySelector("#open-config");
const accountButton = document.querySelector("#account-id");
const accountIdValue = document.querySelector("#account-id-value");
const accountName = document.querySelector("#account-name");
const accountAvatar = document.querySelector("#account-avatar");
const accountStatus = document.querySelector("#account-status");
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

let storedConfig = emptyConfig();
let detectedAccount = null;
let storedStatus = null;

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
    hmac_secret: "BASE64_SECRET",
  };
}

async function requestTargetPermission(urls) {
  const origins = [...new Set(urls.map((value) => {
    const url = new URL(value);
    return `${url.protocol === "wss:" ? "https:" : url.protocol}//${url.host}/*`;
  }))];
  if (await chrome.permissions.contains({ origins })) return;
  if (!await chrome.permissions.request({ origins })) {
    throw new Error("Server permission was not granted.");
  }
}

function setAccountStatus(label, state) {
  accountStatus.dataset.state = state;
  accountStatus.querySelector("span").textContent = label;
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

  if (!key) {
    setAccountStatus("Detecting", "neutral");
    status.textContent = message;
    syncButton.disabled = true;
    syncProgress.hidden = true;
    progressArea.hidden = !message;
    return;
  }

  if (!config) {
    setAccountStatus("Need config", "warning");
    status.textContent = message;
    syncButton.disabled = true;
    syncProgress.hidden = true;
    progressArea.hidden = !message;
    return;
  }

  setAccountStatus("Ready", "ready");
  syncButton.disabled = false;
  syncButton.textContent = syncState?.caught_up ? "Refresh messages" : "Sync messages";
  const lastSyncText = formatLastSync(syncState?.last_sync_at);
  if (lastSyncText) {
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
    const resultMessage = message || formatSyncResult(syncState?.last_result);
    syncProgress.hidden = true;
    progressArea.hidden = !lastSyncText && !resultMessage;
    status.textContent = resultMessage;
  }
}

async function refreshStoredState() {
  const stored = await readStorage([STORAGE.config, STORAGE.detectedAccount, STORAGE.status]);
  storedConfig = configOrEmpty(stored[STORAGE.config]);
  detectedAccount = stored[STORAGE.detectedAccount] ?? null;
  storedStatus = stored[STORAGE.status] ?? null;
  renderDashboard();
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
    configInput.disabled = true;
    document.querySelector("#save-config").disabled = true;
  } else {
    const selectedKey = preferredKey && accounts.some((account) => accountConfigKey(account) === preferredKey)
      ? preferredKey
      : detectedKey ?? accountConfigKey(accounts[0]);
    configSelect.value = selectedKey;
    const selected = accounts.find((account) => accountConfigKey(account) === selectedKey);
    configInput.value = JSON.stringify(selected, null, 2);
    configInput.disabled = false;
    document.querySelector("#save-config").disabled = false;
  }
  configCount.textContent = `${storedConfig.accounts.length} account${storedConfig.accounts.length === 1 ? "" : "s"} saved`;
  document.querySelector("#export-config").disabled = storedConfig.accounts.length === 0;
}

function openConfig() {
  dashboardScreen.hidden = true;
  configScreen.hidden = false;
  settingsButton.hidden = true;
  setConfigStatus("");
  renderConfigEditor(accountConfigKey(detectedAccount));
}

function closeConfig() {
  configScreen.hidden = true;
  dashboardScreen.hidden = false;
  settingsButton.hidden = false;
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
  ]);
  const consented = hasLocalConsent(stored[STORAGE.consent]);
  storedConfig = configOrEmpty(stored[STORAGE.config]);
  detectedAccount = stored[STORAGE.detectedAccount] ?? null;
  storedStatus = stored[STORAGE.status] ?? null;
  consentScreen.hidden = consented;
  dashboardScreen.hidden = !consented;
  configScreen.hidden = true;
  clearButton.hidden = !consented;
  settingsButton.hidden = !consented;
  consentInput.checked = consented;
  renderDashboard();
  if (consented) void detectAccount();
}

document.querySelector("#continue").addEventListener("click", async () => {
  try {
    if (!consentInput.checked) throw new Error("Please agree to continue.");
    await writeStorage({
      [STORAGE.consent]: { policy_version: 2, accepted_at: new Date().toISOString() },
    });
    await load();
  } catch (error) {
    consentError.textContent = error.message;
  }
});

syncButton.addEventListener("click", async () => {
  syncButton.disabled = true;
  progressArea.hidden = false;
  syncProgress.hidden = false;
  syncProgress.removeAttribute("value");
  status.classList.remove("error");
  status.textContent = "Starting sync…";
  try {
    await showSyncResult(await chrome.runtime.sendMessage({ type: "sync_now" }));
  } catch (error) {
    renderDashboard(error.message, true);
  }
});

document.querySelector("#open-config").addEventListener("click", openConfig);
accountStatus.addEventListener("click", () => {
  if (!accountStatus.disabled) openConfig();
});
document.querySelector("#close-config").addEventListener("click", closeConfig);

configSelect.addEventListener("change", () => {
  const account = storedConfig.accounts.find(
    (item) => accountConfigKey(item) === configSelect.value,
  ) ?? (configSelect.value === accountConfigKey(detectedAccount) ? configTemplate(detectedAccount) : null);
  configInput.value = account ? JSON.stringify(account, null, 2) : "";
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
    await requestTargetPermission(accountOrigins(config));
    await writeStorage({ [STORAGE.config]: config });
    storedConfig = config;
    setConfigStatus(`Imported ${config.accounts.length} account${config.accounts.length === 1 ? "" : "s"}.`);
    renderConfigEditor(accountConfigKey(detectedAccount));
  } catch (error) {
    setConfigStatus(error.message, true);
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
  link.download = "omnichat-browser-bridge-config.json";
  link.click();
  URL.revokeObjectURL(url);
  setConfigStatus("Configuration exported.");
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
  if (changes[STORAGE.config] || changes[STORAGE.detectedAccount] || changes[STORAGE.status]) {
    void refreshStoredState();
  }
});

void load();
