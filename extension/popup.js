import { STORAGE, hasLocalConsent, readStorage, writeStorage } from "./lib/storage.js";

const configInput = document.querySelector("#config");
const consentInput = document.querySelector("#consent");
const consentError = document.querySelector("#consent-error");
const consentScreen = document.querySelector("#consent-screen");
const setupScreen = document.querySelector("#setup-screen");
const status = document.querySelector("#status");
const saveButton = document.querySelector("#save");
const clearButton = document.querySelector("#clear");
const accountButton = document.querySelector("#account-id");
const accountName = document.querySelector("#account-name");
const accountAvatar = document.querySelector("#account-avatar");

function validateConfig(value) {
  if (value?.version !== 1 || value.provider !== "shopee") throw new Error("Setup must be version 1 for Shopee.");
  if (!value.destination?.events_url || new URL(value.destination.events_url).protocol !== "https:") throw new Error("Setup requires an HTTPS events URL.");
  if (!value.hmac_secret) throw new Error("Setup requires an HMAC secret.");
  const { key_id: _legacyKeyId, ...config } = value;
  return config;
}

async function requestTargetPermission(eventsUrl) {
  const url = new URL(eventsUrl);
  const origin = `${url.protocol}//${url.host}/*`;
  if (await chrome.permissions.contains({ origins: [origin] })) return;
  if (!await chrome.permissions.request({ origins: [origin] })) throw new Error("Target-server permission was not granted.");
}

function showResult(result) {
  status.hidden = false;
  if (!result?.ok) {
    status.textContent = result?.error ?? "Sync failed.";
  } else if (result.recovered > 0 || result.sent > 0) {
    status.textContent = `Scanned ${result.recovered}. Sent ${result.sent}. Pending ${result.pending}.`;
    if (result.sent === 0 && result.pending === 0) saveButton.textContent = "Refresh";
  } else {
    status.textContent = "Realtime active. No newer messages.";
    saveButton.textContent = "Refresh";
  }
}

function showProgress(syncStatus) {
  if (syncStatus?.state !== "syncing") return false;
  const completed = Number(syncStatus.completed_conversations) || 0;
  const total = Number(syncStatus.total_conversations) || 0;
  const percentage = total ? Math.round((completed / total) * 100) : 0;
  status.hidden = false;
  status.textContent = `Syncing messages · ${completed} / ${total} conversations · ${percentage}%`;
  return true;
}

async function load() {
  document.querySelector("#version").textContent = `v${chrome.runtime.getManifest().version}`;
  const stored = await readStorage([STORAGE.config, STORAGE.consent, STORAGE.detectedAccount, STORAGE.status]);
  const consented = hasLocalConsent(stored[STORAGE.consent]);
  consentScreen.hidden = consented;
  setupScreen.hidden = !consented;
  clearButton.hidden = !consented;
  consentInput.checked = consented;
  if (stored[STORAGE.config]) {
    const config = validateConfig(stored[STORAGE.config]);
    configInput.value = JSON.stringify(config, null, 2);
    if ("key_id" in stored[STORAGE.config]) await writeStorage({ [STORAGE.config]: config });
  }
  saveButton.textContent = stored[STORAGE.status]?.caught_up ? "Refresh" : "Sync messages";
  showAccount(stored[STORAGE.detectedAccount]);
  if (!showProgress(stored[STORAGE.status])) {
    status.hidden = true;
    status.textContent = "";
  }
  if (consented) void detectAccount();
}

function showAccount(account) {
  const id = account?.provider === "shopee" ? account.provider_account_id : null;
  const name = typeof account?.display_name === "string" && account.display_name.trim() ? account.display_name.trim() : "Shopee account";
  const avatarUrl = typeof account?.avatar_url === "string" && account.avatar_url.startsWith("https://") ? account.avatar_url : "";
  accountName.textContent = id ? name : "Detecting…";
  accountAvatar.src = avatarUrl;
  accountAvatar.hidden = !avatarUrl;
  accountAvatar.alt = avatarUrl ? `${name} avatar` : "";
  accountButton.textContent = id || "Detecting…";
  accountButton.disabled = !id;
  accountButton.dataset.accountId = id || "";
  accountButton.title = id ? "Click to copy" : "";
}

async function detectAccount() {
  const existingId = accountButton.dataset.accountId;
  if (!existingId) {
    accountButton.textContent = "Detecting…";
    accountButton.disabled = true;
  }
  try {
    const result = await chrome.runtime.sendMessage({ type: "detect_account" });
    if (result?.ok) {
      showAccount(result.account);
      return;
    }
  } catch {
    // Retry remains available below.
  }
  if (existingId) {
    accountButton.textContent = existingId;
    accountButton.disabled = false;
  } else {
    accountButton.textContent = "Retry";
    accountButton.disabled = false;
    accountButton.title = "Try detecting the Shop ID again";
  }
}

document.querySelector("#continue").addEventListener("click", async () => {
  try {
    if (!consentInput.checked) throw new Error("Please agree to continue.");
    await writeStorage({ [STORAGE.consent]: { policy_version: 2, accepted_at: new Date().toISOString() } });
    await load();
  } catch (error) { consentError.textContent = error.message; }
});

document.querySelector("#save").addEventListener("click", async () => {
  try {
    const config = validateConfig(JSON.parse(configInput.value));
    await requestTargetPermission(config.destination.events_url);
    await writeStorage({ [STORAGE.config]: config, [STORAGE.status]: { state: "starting" } });
    saveButton.textContent = "Sync messages";
    status.hidden = false;
    status.textContent = "Syncing messages…";
    showResult(await chrome.runtime.sendMessage({ type: "sync_now" }));
  } catch (error) {
    status.hidden = false;
    status.textContent = error.message;
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes[STORAGE.status]) showProgress(changes[STORAGE.status].newValue);
});

clearButton.addEventListener("click", async () => {
  if (!confirm("Clear configuration, consent, pending messages, and sync cursors?")) return;
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
  accountButton.textContent = "Copied";
  setTimeout(() => { accountButton.textContent = id; }, 900);
});

void load();
