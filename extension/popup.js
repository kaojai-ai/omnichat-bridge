import {
  CONFIG_VERSION,
  accountConfigKey,
  accountOrigins,
  findAccountConfig,
  validateConfigFile,
} from "./lib/config.js";
import { diagnosticErrorDetails, pruneLogs } from "./lib/logs.js";
import { accountMigration, assertMigratableConfig, migrationOrigins } from "./lib/config-migration.js";
import {
  STORAGE,
  hasLocalConsent,
  installationId,
  generateDeviceName,
  normalizeDeviceName,
  readAccountState,
  readStorage,
  writeStorage,
} from "./lib/storage.js";
import "./lib/shopee-url.js";
import "./lib/provider-adapters.js";
import "./lib/shopee-adapter.js";
import "./lib/line-oa.js";
import { hydrateDetectedAccounts, popupAccountsForSession } from "./lib/popup-accounts.js";
import { createCoalescedRefresh, syncProgressPresentation } from "./lib/popup-sync-progress.js";
import { currentAccountSyncFailure, accountConnectionStatus, accountDiscoveryStatus, sessionConnectionStatus } from "./lib/popup-status.js";

const providerAdapters = globalThis.OmnichatProviderAdapters;
const shopeeAdapter = globalThis.OmnichatProviderAdapters.get("shopee");
const emptyConfig = () => ({ version: CONFIG_VERSION, accounts: [] });
const sampleConfig = {
  version: CONFIG_VERSION,
  accounts: [{
    provider: shopeeAdapter.id,
    provider_account_id: "123456789",
    events_url: "https://your-server.example.com/omnichat/events",
    api_url: "https://your-server.example.com/omnichat/api",
    image_server_url: "https://your-images.example.com",
    logs_url: "https://your-server.example.com/omnichat/logs",
    hmac_secret: "replace-with-your-secret",
  }],
};

const consentInput = document.querySelector("#consent");
const consentError = document.querySelector("#consent-error");
const continueButton = document.querySelector("#continue");
const loadingScreen = document.querySelector("#loading-screen");
const consentScreen = document.querySelector("#consent-screen");
const hintScreen = document.querySelector("#hint-screen");
const dashboardScreen = document.querySelector("#dashboard-screen");
const configScreen = document.querySelector("#config-screen");
const brandHeader = document.querySelector(".brand");
const clearButton = document.querySelector("#clear");
const settingsButton = document.querySelector("#open-config");
const exportButton = document.querySelector("#export-config");
const accountList = document.querySelector("#account-list");
const accountListEmpty = document.querySelector("#account-list-empty");
const lastSync = document.querySelector("#last-sync");
const syncButton = document.querySelector("#sync");
const unattendedRecoveryInput = document.querySelector("#unattended-recovery");
const cancelSyncButton = document.querySelector("#cancel-sync");
const progressArea = document.querySelector("#progress-area");
const status = document.querySelector("#status");
const configCount = document.querySelector("#config-count");
const configInput = document.querySelector("#config");
const deviceNameInput = document.querySelector("#device-name");
const deviceNameBadge = document.querySelector("#device-name-badge");
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
const updateExtensionButton = document.querySelector("#update-extension");
const consentRecord = document.querySelector("#consent-record");
const languageButtons = [...document.querySelectorAll(".language-button")];
const consentLabel = consentScreen.querySelector(".consent");

let detectingAccount = true;
let pendingAction = "";
let storedConfig = emptyConfig();
let detectedAccounts = [];
let pageAccounts = [];
const retryingAccounts = new Set();
const accountRetryErrors = new Map();
let storedStatus = null;
let liveState = null;
let scanStates = null;
let pendingStates = null;
let extensionUpdate = null;
let logs = [];
const MAX_VISIBLE_LOGS = 200;
let popupTabId = null;
let storedConsent = null;
let storedDeviceName = "";
let unattendedRecovery = false;
let viewingPrivacy = false;
let activeProviderAdapter = null;
let activeProviderSurface = null;
let isProviderChatTab = false;
let language = defaultLanguage();

function renderExtensionUpdate(update) {
  const installedVersion = chrome.runtime.getManifest().version;
  const version = document.querySelector("#version");
  version.textContent = `v${installedVersion}`;
  version.removeAttribute("title");
  updateExtensionButton.hidden = true;
  updateExtensionButton.disabled = false;
  updateExtensionButton.removeAttribute("data-state");
  updateExtensionButton.removeAttribute("aria-label");
  updateExtensionButton.removeAttribute("title");
  if (update?.installed_version !== installedVersion) return;
  if (update.status === "current") {
    const checkedAt = new Date(update.checked_at).toLocaleString();
    version.title = `${t("upToDate")} · ${checkedAt}`;
  } else if (update.status === "available") {
    updateExtensionButton.hidden = false;
    updateExtensionButton.textContent = `! ${t("updateNow")}`;
    updateExtensionButton.setAttribute("aria-label", t("updateNow"));
    updateExtensionButton.title = update.available_version ? `${t("updateNow")} v${update.available_version}` : t("updateNow");
  } else if (update.status === "updating") {
    updateExtensionButton.hidden = false;
    updateExtensionButton.disabled = true;
    updateExtensionButton.textContent = t("updatingExtension");
    updateExtensionButton.setAttribute("aria-label", t("updatingExtension"));
  }
}

const TRANSLATIONS = {
  en: {
    language: "Language", subtitle: "Secured bridge to your server", beforeContinue: "Before you continue", configure: "Configure",
    review: "Review what leaves this browser.", privacyTitle: "Privacy and consent", privacyDescription: "What this extension transfers from this browser.",
    transfers: "This extension transfers", transfersRest: "chat messages, media links, buyer profiles, IDs, timestamps, your device label, installation ID, and provider connection health to the server you configure.",
    never: "It never collects or transfers", neverRest: "passwords, cookies, login tokens, or other browser credentials.", learnMore: "Learn more about this extension on", consent: "I understand and consent to this transfer.", continue: "Continue",
    supported: "Supported providers", chooseProvider: "Choose a provider to manage its account here.", openChat: "Open Chat", help: "Need help? See the", documentation: "documentation on GitHub", detectedAccounts: "ACCOUNTS", noAccounts: "No provider accounts detected yet.", deviceName: "Device name", deviceNamePlaceholder: "e.g. Front desk MacBook", configuration: "Configuration", currentConfig: "Current saved configuration", noSavedAccounts: "No saved accounts · sample shown below", logsDescription: "Logs kept up to 2 days · exports include all levels", filterLogs: "Filter logs by level", clearLogs: "Clear logs", installationId: (id) => `Installation ID: ${id}`, installationCopied: "Installation ID copied",
    sync: "Sync messages", cancel: "Cancel sync", settings: "Settings", thisBrowser: "This browser", logs: "Logs", privacy: "Privacy Policy", erase: "Erase all data", save: "Save configuration", import: "Import configuration", export: "Export configuration", download: "Download", copy: "Copy", allLevels: "All levels", info: "Info", warnings: "Warnings", errors: "Errors", debug: "Debug", upToDate: "Up to date", updateNow: "Update now", updatingExtension: "Updating…",
    lineAccessUnknown: "No configured LINE accounts are verified for this login. Open LINE Chat and check access again.",
    checkConnection: "Check connection", inactiveShop: "Not active in this browser", activeShopContext: (shop) => `Active Shopee shop: ${shop}.`, separateProfiles: "Use a separate Chrome profile for each Shopee login to keep shops connected at the same time.", sessionUnverified: "The active Shopee shop is not verified yet. Open its chat to check the session.", sessionConflict: "Shopee tabs report different shops. Keep one Shopee login per Chrome profile, then refresh its chat.",
    failed: "FAILED", syncFailed: "Sync failed", detectingShop: "Detecting account…", waitingForShop: "WAITING FOR ACCOUNT", configurationMissing: "No configuration is saved for this provider.", restarting: "Starting a fresh sync…", shopUnknown: "Cannot detect the signed-in shop. Open its Shopee chat and retry.", ready: "READY", syncing: "SYNCING", connected: "CONNECTED", offline: "OFFLINE", needConfig: "NEED CONFIG", leader: "LEADER", standby: "STANDBY", noLeader: "NOT READY", pending: (count) => `${count} pending`, discard: "Discard", openLogs: "Open Logs", openWebchat: "Open Webchat mini", retry: "Retry now", unattendedRecovery: "Recover provider tabs automatically", openingWebchat: "Opening Webchat mini…", checking: "Checking for missed messages…", webchatOpened: "Webchat mini opened.", syncCancelled: "Sync cancelled.", noSyncInProgress: "No sync in progress.", cancelling: "Cancelling…", cancellingSync: "Cancelling sync…", unattendedEnabled: "Unattended recovery enabled.", unattendedDisabled: "Unattended recovery disabled.",
    loadFailed: "Could not load extension data. Close and reopen the popup.", loadingLogs: "Loading logs…", logsLoadFailed: "Could not load logs.", noNew: "No new messages.", sent: (count) => `Sent ${count} message${count === 1 ? "" : "s"}.`, messagesPending: (count) => `${count} message${count === 1 ? "" : "s"} pending.`, lastSynced: (value) => `Last synced ${value}`, noLogsMatch: "No logs match this level.", noLogsRecorded: "No logs recorded yet.", copied: "Copied", couldNotCopy: "Could not copy", copyId: (label) => `Copy ${label} ID`, openProviderChat: "Open a supported provider chat to detect your accounts.", openShopeeChat: "Open Webchat mini to detect your Shopee accounts.",
  },
  th: {
    language: "ภาษา", subtitle: "เชื่อมต่อเซิร์ฟเวอร์อย่างปลอดภัย", beforeContinue: "ก่อนดำเนินการต่อ", configure: "ตั้งค่า", review: "ตรวจสอบข้อมูลที่จะออกจากเบราว์เซอร์นี้", privacyTitle: "ความเป็นส่วนตัวและความยินยอม", privacyDescription: "ข้อมูลที่ส่วนขยายนี้ส่งจากเบราว์เซอร์นี้",
    transfers: "ส่วนขยายนี้ส่ง", transfersRest: "ข้อความแชต ลิงก์สื่อ โปรไฟล์ผู้ซื้อ ID เวลา ป้ายชื่ออุปกรณ์ รหัสติดตั้ง และสถานะการเชื่อมต่อผู้ให้บริการไปยังเซิร์ฟเวอร์ที่คุณกำหนด", never: "ส่วนขยายนี้จะไม่เก็บหรือส่ง", neverRest: "รหัสผ่าน คุกกี้ โทเค็นเข้าสู่ระบบ หรือข้อมูลรับรองเบราว์เซอร์อื่น ๆ", learnMore: "ดูข้อมูลเพิ่มเติมเกี่ยวกับส่วนขยายนี้ที่", consent: "ฉันเข้าใจและยินยอมให้ส่งข้อมูลนี้", continue: "ดำเนินการต่อ",
    supported: "ผู้ให้บริการที่รองรับ", chooseProvider: "เลือกผู้ให้บริการเพื่อจัดการบัญชีที่นี่", openChat: "เปิดแชต", help: "ต้องการความช่วยเหลือหรือไม่ ดู", documentation: "เอกสารบน GitHub", detectedAccounts: "บัญชี", noAccounts: "ยังไม่พบบัญชีผู้ให้บริการ", deviceName: "ชื่ออุปกรณ์", deviceNamePlaceholder: "เช่น MacBook ฝ่ายต้อนรับ", configuration: "การตั้งค่า", currentConfig: "การตั้งค่าที่บันทึกไว้", noSavedAccounts: "ยังไม่มีบัญชีที่บันทึก · แสดงตัวอย่างด้านล่าง", logsDescription: "เก็บบันทึกสูงสุด 2 วัน · ส่งออกครบทุกระดับ", filterLogs: "กรอง Logs ตามระดับ", clearLogs: "ล้าง Logs", installationId: (id) => `รหัสติดตั้ง: ${id}`, installationCopied: "คัดลอกรหัสติดตั้งแล้ว", sync: "ซิงค์ข้อความ", cancel: "ยกเลิกการซิงค์", settings: "การตั้งค่า", logs: "Logs", privacy: "นโยบายความเป็นส่วนตัว", erase: "ลบข้อมูลทั้งหมด", save: "บันทึกการตั้งค่า", import: "นำเข้าการตั้งค่า", export: "ส่งออกการตั้งค่า", download: "ดาวน์โหลด", copy: "คัดลอก", allLevels: "ทุกระดับ", info: "ข้อมูล", warnings: "คำเตือน", errors: "ข้อผิดพลาด", debug: "ดีบัก",
    lineAccessUnknown: "ยังยืนยันสิทธิ์บัญชี LINE ที่ตั้งค่าไว้ไม่ได้ เปิด LINE Chat แล้วตรวจสอบสิทธิ์อีกครั้ง",
    checkConnection: "ตรวจสอบการเชื่อมต่อ", inactiveShop: "ไม่ได้ใช้งานในเบราว์เซอร์นี้", activeShopContext: (shop) => `ร้าน Shopee ที่ใช้งานอยู่: ${shop}`, separateProfiles: "ใช้โปรไฟล์ Chrome แยกสำหรับแต่ละบัญชี Shopee เพื่อเชื่อมต่อหลายร้านพร้อมกัน", sessionUnverified: "ยังยืนยันร้าน Shopee ที่ใช้งานอยู่ไม่ได้ เปิดแชตของร้านเพื่อตรวจสอบเซสชัน", sessionConflict: "แท็บ Shopee รายงานร้านไม่ตรงกัน ใช้บัญชี Shopee เดียวต่อโปรไฟล์ Chrome แล้วรีเฟรชแชตของร้าน",
    failed: "ไม่สำเร็จ", syncFailed: "ซิงค์ไม่สำเร็จ", detectingShop: "กำลังตรวจหาบัญชี…", waitingForShop: "รอบัญชี", configurationMissing: "ยังไม่มีการตั้งค่าสำหรับผู้ให้บริการนี้", restarting: "กำลังเริ่มซิงค์ใหม่…", shopUnknown: "ยังตรวจไม่พบร้านค้าที่เข้าสู่ระบบ เปิดแชต Shopee แล้วลองอีกครั้ง", ready: "พร้อม", syncing: "กำลังซิงค์", connected: "เชื่อมต่อแล้ว", offline: "ออฟไลน์", needConfig: "ต้องตั้งค่า", leader: "ตัวหลัก", standby: "รอ", noLeader: "ยังไม่พร้อม", pending: (count) => `รอดำเนินการ ${count} รายการ`, discard: "ละทิ้ง", openLogs: "เปิด Logs", openWebchat: "เปิด Webchat mini", retry: "ลองใหม่", unattendedRecovery: "กู้คืนแท็บผู้ให้บริการอัตโนมัติ", openingWebchat: "กำลังเปิด Webchat mini…", checking: "กำลังตรวจหาข้อความที่พลาด…", webchatOpened: "เปิด Webchat mini แล้ว", syncCancelled: "ยกเลิกการซิงค์แล้ว", noSyncInProgress: "ไม่มีการซิงค์ที่กำลังทำงาน", cancelling: "กำลังยกเลิก…", cancellingSync: "กำลังยกเลิกการซิงค์…", unattendedEnabled: "เปิดการกู้คืนอัตโนมัติแล้ว", unattendedDisabled: "ปิดการกู้คืนอัตโนมัติแล้ว", loadFailed: "โหลดข้อมูลส่วนขยายไม่สำเร็จ กรุณาปิดแล้วเปิดป๊อปอัปใหม่", loadingLogs: "กำลังโหลด Logs…", logsLoadFailed: "โหลด Logs ไม่สำเร็จ", noNew: "ไม่มีข้อความใหม่", sent: (count) => `ส่งแล้ว ${count} ข้อความ`, messagesPending: (count) => `มีข้อความรอดำเนินการ ${count} รายการ`, lastSynced: (value) => `ซิงค์ล่าสุด ${value}`, noLogsMatch: "ไม่มี Logs ที่ตรงกับระดับนี้", noLogsRecorded: "ยังไม่มี Logs", copied: "คัดลอกแล้ว", couldNotCopy: "คัดลอกไม่ได้", copyId: (label) => `คัดลอก ID ${label}`, openProviderChat: "เปิดแชตของผู้ให้บริการที่รองรับเพื่อค้นหาบัญชี", openShopeeChat: "เปิด Webchat mini เพื่อค้นหาบัญชี Shopee", thisBrowser: "เบราว์เซอร์นี้", upToDate: "เป็นเวอร์ชันล่าสุด", updateNow: "อัปเดตตอนนี้", updatingExtension: "กำลังอัปเดต…",
  },
};

function t(key, ...args) {
  const value = TRANSLATIONS[language]?.[key] ?? TRANSLATIONS.en[key] ?? key;
  return typeof value === "function" ? value(...args) : value;
}

function defaultLanguage() {
  return String(navigator.language ?? "").toLowerCase().startsWith("th") ? "th" : "en";
}

function applyTranslations() {
  document.documentElement.lang = language;
  for (const button of languageButtons) {
    const selected = button.dataset.language === language;
    button.setAttribute("aria-pressed", String(selected));
    button.disabled = selected;
  }
  const text = new Map([
    [".brand-copy span", t("subtitle")],
    ["#consent-screen .screen-intro h2", viewingPrivacy ? t("privacyTitle") : t("beforeContinue")],
    ["#consent-screen .screen-intro p", viewingPrivacy ? t("privacyDescription") : t("review")],
    ["#consent-screen .consent-copy p:first-child", `<strong>${t("transfers")}</strong> ${t("transfersRest")}`],
    ["#consent-screen .consent-copy p:nth-child(2)", `<strong>${t("never")}</strong> ${t("neverRest")}`],
    ["#privacy-github", `${t("learnMore")} <a href="https://github.com/kaojai-ai/omnichat-bridge" target="_blank" rel="noreferrer">GitHub</a>.`],
    ["label.consent span", t("consent")], ["#continue", t("continue")], ["#provider-links-title", t("supported")],
    ["#hint-screen .screen-intro p", t("chooseProvider")], ["#detected-shops-title", t("detectedAccounts")],
    ["#account-list-empty", t("noAccounts")], ["#unattended-recovery-label", t("unattendedRecovery")], ["#cancel-sync", t("cancel")],
    ["#open-logs", t("logs")], ["#open-config", t("settings")], ["#open-privacy", t("privacy")], ["#clear", t("erase")],
    ["#config-screen h2", t("settings")], ["#save-config", t("save")], ["#logs-screen h2", t("logs")],
    ["#device-name-label", t("deviceName")], ["#config-label", t("configuration")],
    ["#download-logs", t("download")], ["#copy-logs", t("copy")], ["#logs-description", t("logsDescription")], ["#log-level", t("filterLogs")], ["#clear-logs", t("clearLogs")], ["#footer-privacy", t("privacy")],
  ]);
  for (const [selector, value] of text) {
    const element = document.querySelector(selector);
    if (!element) continue;
    if (selector === "#open-config") {
      element.setAttribute("aria-label", value);
      element.title = value;
    } else if (selector === "#clear") {
      const label = element.querySelector("span");
      if (label) label.textContent = value;
      element.title = value;
    } else if (selector === "#open-logs" || selector === "#open-privacy") element.textContent = value;
    else if (selector === "#log-level" || selector === "#clear-logs") {
      element.setAttribute("aria-label", value);
      element.title = value;
    }
    else element.innerHTML = value;
  }
  deviceNameInput.placeholder = t("deviceNamePlaceholder");
  for (const [value, key] of [["info", "info"], ["warn", "warnings"], ["error", "errors"], ["debug", "debug"]]) {
    const option = logLevel.querySelector(`option[value="${value}"]`);
    if (option) option.textContent = t(key);
  }
  for (const link of document.querySelectorAll(".provider-link small")) link.textContent = t("openChat");
  if (document.querySelector("#hint-screen .hint-guide")) {
    document.querySelector("#hint-screen .hint-guide").innerHTML = `${t("help")} <a href="https://github.com/kaojai-ai/omnichat-bridge" target="_blank" rel="noreferrer">${t("documentation")}</a>.`;
  }
  renderExtensionUpdate(extensionUpdate);
}

function adapterForAccount(account) {
  return providerAdapters.get(account?.provider);
}

function consented() {
  return hasLocalConsent(storedConsent);
}

function defaultScreen() {
  if (!consented()) return "consent";
  return isProviderChatTab ? "dashboard" : "hint";
}

function routeTo(target) {
  let screen = target;
  if (!consented() && screen !== "consent" && screen !== "privacy") {
    screen = "consent";
  }
  viewingPrivacy = screen === "privacy";
  const onConsentGate = screen === "consent" || screen === "privacy";
  loadingScreen.hidden = true;
  brandHeader.hidden = screen === "config" || screen === "logs" || screen === "privacy";
  consentScreen.hidden = !onConsentGate;
  hintScreen.hidden = screen !== "hint";
  dashboardScreen.hidden = screen !== "dashboard";
  configScreen.hidden = screen !== "config";
  logsScreen.hidden = screen !== "logs";
  setHeaderActionsVisible(screen === "dashboard");
  setSettingsButtonVisible(consented() && !onConsentGate && screen !== "config" && screen !== "logs");
  if (onConsentGate) renderConsentScreen();
}

async function currentActiveTabUrl() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return activeTab?.url ?? "";
}

function bestEffortAccounts(storedAccounts, tabUrl = "") {
  return hydrateDetectedAccounts({
    storedAccounts,
    config: storedConfig,
    providerId: activeProviderAdapter?.id,
    activeTabUrl: tabUrl,
  });
}

function accountLabel(adapter) {
  return adapter?.accountName || adapter?.displayName || `${adapter?.id || "Provider"} account`;
}

function providerBadgeLabel(provider, adapter) {
  const label = { line_oa: "LINE", shopee: "SHOPEE" }[provider] ?? adapter?.displayName ?? provider;
  return String(label).toUpperCase();
}

function accountDisplayLabel(account, adapter) {
  const displayName = String(account?.display_name ?? "").trim();
  return displayName || accountLabel(adapter);
}

function lineChatUrl(account) {
  const botId = account?.provider === "line_oa" ? String(account.bot_id ?? "").trim() : "";
  return botId ? `https://chat.line.biz/${encodeURIComponent(botId)}` : "";
}

function logPopup(level, event, message, details = {}) {
  try {
    void chrome.runtime.sendMessage({
      type: "record_log",
      level,
      area: "popup",
      event,
      message,
      details,
    }).catch(() => undefined);
  } catch {
    // Logging must not throw while handling another popup error.
  }
}

function reportPopupError(scope, error) {
  logPopup("error", "async_error", "Extension async operation failed.", {
    scope,
    ...diagnosticErrorDetails(error),
  });
}

window.addEventListener("error", (event) => {
  logPopup("error", "uncaught_error", "Unhandled popup error.", {
    scope: "popup",
    error_kind: "error_event",
    ...diagnosticErrorDetails(event?.error ?? event?.message),
  });
});
window.addEventListener("unhandledrejection", (event) => {
  logPopup("error", "uncaught_error", "Unhandled popup error.", {
    scope: "popup",
    error_kind: "unhandled_rejection",
    ...diagnosticErrorDetails(event?.reason),
  });
});

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
  applyTranslations();
  const hasConsent = consented();
  const recordedAt = formatConsentDate(storedConsent?.accepted_at);
  closePrivacyButton.hidden = !viewingPrivacy || !hasConsent;
  consentRecord.hidden = !hasConsent;
  consentRecord.textContent = recordedAt
    ? `✔️ ${language === "th" ? `บันทึกความยินยอม ${recordedAt} บนอุปกรณ์นี้` : `Consent recorded ${recordedAt} on this device.`}`
    : `✔️ ${language === "th" ? "บันทึกความยินยอมบนอุปกรณ์นี้แล้ว" : "Consent recorded on this device."}`;
  consentLabel.hidden = hasConsent;
  continueButton.hidden = hasConsent;
  consentInput.disabled = hasConsent;
  consentInput.checked = hasConsent;
  continueButton.disabled = hasConsent || !consentInput.checked;
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
  leaderStatus.dataset.action = action || "";
  leaderStatus.disabled = !action;
  leaderStatus.dataset.leader = String(isLeader);
  leaderCurrent.textContent = label;
  leaderStatus.setAttribute("aria-label", label);
  leaderStatus.title = action === "config"
    ? "Open settings"
    : isLeader
      ? "Hand over to another ready browser; keep this browser if it is the only one ready"
      : action ? "Set this tab as leader" : "";
}

function setStatusAppearance(state = "neutral", loading = false) {
  status.dataset.state = state;
  status.dataset.loading = String(loading);
  status.classList.toggle("error", state === "error");
  status.setAttribute("aria-busy", String(loading));
}

function renderDeviceNameBadge() {
  const deviceName = normalizeDeviceName(storedDeviceName);
  deviceNameBadge.textContent = deviceName || t("thisBrowser");
  deviceNameBadge.hidden = false;
  deviceNameBadge.title = deviceName ? `Node name: ${deviceName}` : "";
  deviceNameBadge.setAttribute("aria-label", deviceName ? `Node name ${deviceName}` : "Node name");
}

function setConfigStatus(message, isError = false) {
  configStatus.textContent = message;
  configStatus.classList.toggle("error", isError);
}

function formatLastSync(value) {
  const timestamp = Date.parse(value ?? "");
  if (!Number.isFinite(timestamp)) return "";
  const formatted = new Date(timestamp).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return t("lastSynced", formatted);
}

function formatSyncResult(result) {
  if (!result) return "";
  const sent = Number(result.sent) || 0;
  const pending = Number(result.pending) || 0;
  if (pending) return `${t("messagesPending", pending)}`;
  if (sent) return `${t("sent", sent)}.`;
  return t("noNew");
}

function accountIsActiveHere(account) {
  return !["shopee", "line_oa"].includes(account.provider)
    || readAccountState(liveState, accountConfigKey(account), {}).active_in_profile === true;
}

function inactiveShopHint(live) {
  const session = sessionConnectionStatus(live);
  if (session) return session.hint;
  if (live?.provider_session_reason_code === "session_conflict") return t("sessionConflict");
  const activeId = live?.active_provider_account_id;
  if (!activeId) return t("sessionUnverified");
  const active = detectedAccounts.find((item) => item.provider === "shopee" && item.provider_account_id === activeId);
  return `${t("activeShopContext", active?.display_name || activeId)} ${t("separateProfiles")}`;
}

function accountRowStatus(account) {
  const key = accountConfigKey(account);
  const config = findAccountConfig(storedConfig, account);
  if (!config) return { label: t("needConfig"), state: "neutral", action: "config" };
  const syncState = readAccountState(storedStatus, key, null);
  const live = readAccountState(liveState, key, null);
  const session = sessionConnectionStatus(live);
  if (session) return session;
  if (account.provider === "shopee" && !accountIsActiveHere(account)) {
    return { label: t("inactiveShop"), state: "neutral", hint: inactiveShopHint(live) };
  }
  const retryError = accountRetryErrors.get(key);
  if (retryError && Date.parse(syncState?.last_sync_at ?? "") > retryError.at) accountRetryErrors.delete(key);
  else if (retryError) return { label: t("syncFailed"), state: "error", hint: retryError.message, action: "logs" };
  if (retryingAccounts.has(key) || ["discovering", "syncing"].includes(syncState?.state)) {
    const progress = syncProgressPresentation({ ...syncState, pending: readAccountState(pendingStates, key, []).length }, { locale: language, compact: true });
    return { label: progress?.text || t("syncing"), hint: progress?.detail,
      state: "neutral", loading: syncState?.phase !== "queued" };
  }
  if (live?.endpoint_not_found && live.socket !== "connected") return accountConnectionStatus(live);
  const failure = currentAccountSyncFailure(syncState, live);
  if (failure) return { label: t("syncFailed"), state: "error", hint: failure, action: "logs" };
  return accountConnectionStatus(live);
}

async function retryAccount(account) {
  const key = accountConfigKey(account);
  if (retryingAccounts.has(key)) return;
  retryingAccounts.add(key);
  accountRetryErrors.delete(key);
  renderDashboard();
  try {
    const config = findAccountConfig(storedConfig, account);
    await requestTargetPermission(accountOrigins({ ...storedConfig, accounts: [config] }));
    const result = await chrome.runtime.sendMessage({
      type: "sync_account",
      provider: account.provider,
      provider_account_id: account.provider_account_id,
    });
    if (!result?.ok || result?.error) throw new Error(result?.error || "Could not retry this account.");
    await refreshStoredState();
  } catch (error) {
    accountRetryErrors.set(key, { message: error.message, at: Date.now() });
    reportPopupError("retry_account", error);
  } finally {
    retryingAccounts.delete(key);
    renderDashboard();
  }
}

async function copyProviderAccountId(providerAccountId, label, button, valueElement) {
  try {
    await navigator.clipboard.writeText(providerAccountId);
    valueElement.textContent = t("copied");
    button.title = t("copied");
  } catch {
    valueElement.textContent = t("couldNotCopy");
    button.title = `${t("couldNotCopy")} ${t("copyId", label)}`;
  }
  setTimeout(() => {
    valueElement.textContent = providerAccountId;
    button.title = t("copyId", label);
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

async function discardPending(account, button, count) {
  const adapter = adapterForAccount(account);
  const providerAccountId = String(account?.provider_account_id ?? "").trim();
  const label = accountLabel(adapter);
  if (!providerAccountId || !count) return;
  if (!confirm(`Discard ${count} pending message${count === 1 ? "" : "s"} for ${label}? This skips older messages for this account and cannot be undone.`)) return;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  try {
    const result = await chrome.runtime.sendMessage({
      type: "discard_pending",
      provider: account.provider,
      provider_account_id: providerAccountId,
    });
    if (!result?.ok) throw new Error(result?.error ?? "Could not discard pending messages.");
    await refreshStoredState();
    const reportedCount = Number(result.discarded);
    const discarded = Number.isFinite(reportedCount) ? reportedCount : count;
    renderDashboard(`Discarded ${discarded} pending message${discarded === 1 ? "" : "s"}.`);
  } catch (error) {
    reportPopupError("discard_pending", error);
    renderDashboard(error.message, true);
  }
}

function createAccountActionIcon(action) {
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.classList.add("account-action-icon");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("aria-hidden", "true");
  const paths = action === "retry"
    ? ["M20 7v5h-5", "M19.1 12a7.2 7.2 0 1 0-1.7 5.1", "M20 12l-3-4"]
    : ["M4 7h16", "M9 7V4h6v3", "M6 7l1 13h10l1-13", "M10 10v6", "M14 10v6"];
  for (const d of paths) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    icon.append(path);
  }
  return icon;
}

function renderDetectedAccounts() {
  const accounts = popupAccountsForSession(detectedAccounts, liveState, pageAccounts).filter((account) => (
    adapterForAccount(account) && String(account.provider_account_id ?? "").trim()
  ));
  accountList.replaceChildren();
  accountListEmpty.hidden = accounts.length !== 0;
  accountListEmpty.dataset.loading = String(detectingAccount);
  accountListEmpty.setAttribute("aria-busy", String(detectingAccount));
  accountListEmpty.textContent = detectingAccount ? t("detectingShop")
    : activeProviderAdapter?.id === "shopee" ? t("shopUnknown") : t("noAccounts");
  accountList.append(...accounts.map(renderAccountRow).filter(Boolean));
}

// One row layout; provider adapters supply identity and capabilities.
function renderAccountRow(account) {
  const adapter = adapterForAccount(account);
  const id = adapter ? String(account.provider_account_id ?? "").trim() : "";
  if (!id) return null;
  const label = accountLabel(adapter);
  const cardState = accountRowStatus(account);
  const card = document.createElement("div");
  card.className = "account-row";
  card.dataset.provider = account.provider;
  card.dataset.accountId = id;
  card.dataset.state = cardState.state;
  const select = document.createElement("div");
  select.className = "account-row-select";
  const copy = document.createElement("span");
  copy.className = "account-row-copy";
  const lineUrl = lineChatUrl(account);
  const name = document.createElement(lineUrl ? "a" : "strong");
  name.className = "account-row-name";
  name.textContent = accountDisplayLabel(account, adapter);
  name.title = name.textContent;
  if (lineUrl) {
    name.href = lineUrl;
    name.target = "_blank";
    name.rel = "noreferrer";
    name.classList.add("account-row-line-link");
    name.title = `Open LINE Chat · ${name.textContent}`;
  }
  const statusLabel = document.createElement(cardState.action ? "a" : "span");
  statusLabel.className = "account-row-status";
  statusLabel.dataset.state = cardState.state;
  statusLabel.dataset.loading = String(cardState.loading === true);
  statusLabel.setAttribute("aria-busy", String(cardState.loading === true));
  statusLabel.textContent = cardState.label;
  if (cardState.hint) statusLabel.title = cardState.hint;
  if (cardState.action) {
    statusLabel.href = cardState.action === "config" ? "#config" : "#logs";
    statusLabel.classList.add("account-row-status-link");
    const actionHint = cardState.action === "config" ? "Open settings" : "Open error logs";
    statusLabel.title = cardState.hint ? `${cardState.hint} · ${actionHint}` : actionHint;
    statusLabel.setAttribute(
      "aria-label",
      cardState.action === "config"
        ? `Open settings to configure ${account.display_name || label}`
        : `Open error logs for ${account.display_name || label}`,
    );
    statusLabel.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (cardState.action === "config") openConfig();
      else openLogs("error");
    });
  }
  const heading = document.createElement("span");
  heading.className = "account-row-heading";
  const badge = document.createElement("span");
  badge.className = "provider-badge";
  badge.dataset.provider = account.provider;
  badge.textContent = providerBadgeLabel(account.provider, adapter);
  heading.append(badge, name);
  copy.append(heading, statusLabel);
  const actions = document.createElement("div");
  actions.className = "account-row-actions";
  if (cardState.loading) {
    const progress = syncProgressPresentation(readAccountState(storedStatus, accountConfigKey(account), null));
    if (progress?.showBar) {
      const bar = document.createElement("progress");
      bar.max = 100;
      if (progress.value !== null) bar.value = progress.value;
      bar.setAttribute("aria-label", cardState.label);
      copy.append(bar);
    }
  }
  if (adapter.supports?.("message_recovery") && (cardState.state === "error" || cardState.loading)) {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.disabled = retryingAccounts.has(accountConfigKey(account));
    retry.className = "account-action";
    retry.title = t("retry");
    retry.append(createAccountActionIcon("retry"));
    retry.setAttribute("aria-label", `${t("retry")}: ${account.display_name || id}`);
    retry.addEventListener("click", () => void retryAccount(account));
    actions.append(retry);
  }
  select.append(copy);
  const shopId = document.createElement("button");
  shopId.type = "button";
  shopId.className = "account-row-id";
  shopId.title = `${t("copyId", label)} ${id}`;
  shopId.setAttribute("aria-label", `${t("copyId", label)} ${id}`);
  const shopIdValue = document.createElement("span");
  shopIdValue.textContent = id;
  shopId.append(shopIdValue, createCopyIcon());
  shopId.addEventListener("click", () => void copyProviderAccountId(id, label, shopId, shopIdValue));
  const pending = readAccountState(pendingStates, accountConfigKey(account), []);
  if (pending.length) {
    const pendingRow = document.createElement("div");
    pendingRow.className = "account-row-pending";
    const pendingLabel = document.createElement("span");
    pendingLabel.textContent = t("pending", pending.length);
    const discardButton = document.createElement("button");
    discardButton.type = "button";
    discardButton.className = "account-action";
    discardButton.append(createAccountActionIcon("discard"));
    discardButton.setAttribute(
      "aria-label",
      `Discard ${pending.length} pending message${pending.length === 1 ? "" : "s"} for ${label}`,
    );
    const accountSyncState = readAccountState(storedStatus, accountConfigKey(account), null);
    const accountScanState = readAccountState(scanStates, accountConfigKey(account), null);
    const syncInProgress = accountScanState?.in_progress === true
      || ["discovering", "syncing"].includes(accountSyncState?.state);
    discardButton.disabled = syncInProgress;
    discardButton.title = syncInProgress
      ? "Cancel sync before discarding pending messages."
      : "Discard pending messages for this account";
    discardButton.addEventListener("click", () => void discardPending(account, discardButton, pending.length));
    pendingRow.append(pendingLabel);
    actions.append(discardButton);
    copy.append(pendingRow);
  }
  const meta = document.createElement("div");
  meta.className = "account-row-meta";
  meta.append(actions, shopId);
  card.append(select, meta);
  return card;
}

function renderDashboard(message = "", isError = false) {
  syncButton.dataset.provider = activeProviderAdapter?.id || detectedAccounts[0]?.provider || "";
  renderDeviceNameBadge();
  renderDetectedAccounts();
  status.replaceChildren();
  setStatusAppearance(isError ? "error" : "neutral");
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
  const configuredStates = accountStates.filter((item) => item.config && accountIsActiveHere(item.account));
  const pendingTotal = configuredStates.reduce((total, item) => total + item.pending.length, 0);
  const configuredAccountIds = new Set(configuredStates.map((item) => item.account.provider_account_id));
  const latestLoggedDeliveryFailure = logs.find((item) => (
    item.level === "error"
      && item.area === "message_delivery"
      && ["failed", "batch_blocked", "message_blocked"].includes(item.event)
      && configuredAccountIds.has(item.details?.provider_account_id)
      && item.details?.error_message
  ));
  const anySyncing = configuredStates.some((item) => (
    ["discovering", "syncing"].includes(item.syncState?.state)
    || item.scanState?.in_progress === true
  ));
  const anyPending = configuredStates.some((item) => item.pending.length > 0 || item.scanState?.in_progress);
  const statusFailure = configuredStates.map((item) => currentAccountSyncFailure({
    ...item.syncState,
    account_label: accountDisplayLabel(item.account, adapterForAccount(item.account)),
  }, item.live)).find(Boolean) || "";
  const endpointFailure = configuredStates
    .filter((item) => item.live?.endpoint_not_found && item.live.socket !== "connected")
    .map((item) => accountConnectionStatus(item.live).hint)[0];
  const migrationFailure = storedConfig.accounts.map((account) => accountMigration(account, storedConfig.version).error).find(Boolean);
  const migrationPending = configuredStates.map((item) => item.syncState?.migration_error).find(Boolean);
  const latestFailure = migrationFailure || migrationPending || endpointFailure
    || statusFailure
    || (pendingTotal ? latestLoggedDeliveryFailure?.details.error_message : "")
    || "";
  const anyError = Boolean(latestFailure);
  const sellerCentreChatClosed = activeProviderSurface === "seller-centre"
    && configuredStates.some((item) => (
      item.account.provider === "shopee" && item.live?.provider_chat_open === false
    ));
  const progressAccount = configuredStates.find((item) => (
    ["discovering", "syncing"].includes(item.syncState?.state)
  ));
  const latestResult = configuredStates
    .map((item) => item.syncState?.last_result)
    .filter(Boolean)
    .at(-1);
  const anyLeader = configuredStates.some((item) => item.live?.leader);
  const hasLeader = configuredStates.some((item) => item.live?.leader_installation_id);
  const surfaceHint = configuredStates
    .map((item) => accountConnectionStatus(item.live))
    .find((item) => item?.state !== "ready" && item?.hint);
  const latestSync = configuredStates
    .map((item) => item.syncState?.last_sync_at)
    .filter(Boolean)
    .sort()
    .at(-1);

  if (!configuredStates.length) {
    const inactiveShopee = accountStates.find((item) => item.config && item.account.provider === "shopee"
      && !accountIsActiveHere(item.account));
    const inactiveLine = activeProviderAdapter?.id === "line_oa"
      && storedConfig.accounts.some((account) => account.provider === "line_oa");
    const discovery = accountDiscoveryStatus({
      detecting: detectingAccount,
      hasConfiguration: storedConfig.accounts.some((account) => account.provider === activeProviderAdapter?.id),
      inactiveShopee: Boolean(inactiveShopee),
    });
    if (inactiveLine && !detectingAccount) {
      discovery.hint = "lineAccessUnknown";
      discovery.action = "detect";
    }
    setLeaderStatus(t("noLeader"), "neutral", "");
    setStatusAppearance(isError ? "error" : "neutral", !isError && Boolean(pendingAction || detectingAccount));
    status.textContent = message || (pendingAction ? t(pendingAction)
      : inactiveShopee ? inactiveShopHint(inactiveShopee.live) : t(discovery.hint));
    syncButton.disabled = detectingAccount;
    syncButton.dataset.action = discovery.action;
    syncButton.textContent = t(discovery.action === "configure" ? "configure" : discovery.action === "detect" ? "checkConnection" : "retry");
    syncButton.setAttribute("aria-label", syncButton.textContent);
    syncButton.title = "";
    cancelSyncButton.hidden = true;
    progressArea.hidden = false;
    return;
  }

  status.classList.toggle("error", isError);
  setLeaderStatus(anyLeader ? t("leader") : hasLeader ? t("standby") : t("noLeader"), anyLeader ? "ready" : "neutral", "leader", anyLeader);
  syncButton.disabled = activeProviderAdapter?.id === "line_oa" && Boolean(pendingAction);
  syncButton.dataset.action = sellerCentreChatClosed ? "open_webchat_mini" : "sync";
  syncButton.textContent = sellerCentreChatClosed
    ? t("openWebchat")
    : activeProviderAdapter?.id === "line_oa" ? t("sync")
    : anySyncing || anyPending || anyError || surfaceHint ? t("retry") : t("sync");
  syncButton.setAttribute("aria-label", syncButton.textContent);
  syncButton.title = "";
  cancelSyncButton.hidden = !anySyncing;
  cancelSyncButton.disabled = false;
  cancelSyncButton.textContent = t("cancel");
  const lastSyncText = formatLastSync(latestSync);
  if (lastSyncText) {
    lastSync.textContent = lastSyncText;
    lastSync.hidden = false;
  }

  if (progressAccount && !message && !isError) {
    // Both providers own progress in their account row; avoid a second copy.
    progressArea.hidden = true;
    setStatusAppearance("neutral");
  } else {
    const resultMessage = message
      || (pendingAction ? t(pendingAction) : "")
      || surfaceHint?.hint
      || formatSyncResult(latestResult);
    progressArea.hidden = !lastSyncText && !resultMessage && !anyError;
    if (message || pendingAction || !anyError) {
      setStatusAppearance(isError ? "error" : pendingAction ? "neutral" : surfaceHint?.state || (latestResult && !message && !latestResult.pending ? "ready" : "neutral"), !isError && Boolean(pendingAction || (!message && surfaceHint?.loading)));
      status.textContent = resultMessage;
    } else {
      setStatusAppearance("error");
      const error = document.createElement("span");
      error.className = "status-error";
      error.textContent = latestFailure;
      status.append(error);
      const details = document.createElement("span");
      details.className = "status-error-details";
      if (pendingTotal) {
        const pending = document.createElement("span");
        pending.className = "status-pending";
        pending.textContent = t("pending", pendingTotal);
        details.append(pending, document.createTextNode(" · "));
      }
      const logsLink = document.createElement("a");
      logsLink.href = "#logs";
      logsLink.className = "status-log-link";
      logsLink.textContent = t("openLogs");
      logsLink.addEventListener("click", (event) => {
        event.preventDefault();
        openLogs("error");
      });
      details.append(logsLink);
      status.append(details);
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

function formatSupportLogs() {
  const header = `Omnichat support logs · version=${chrome.runtime.getManifest().version} · exported_at=${new Date().toISOString()} · provider=all-providers · accounts=all-shops · levels=all · display_filter=${logLevel.value}`;
  return `${header}\n${logs
    .map((item) => [
      item.at || "Unknown time",
      item.level || "info",
      item.area || "extension",
      item.event || "unknown",
      item.message || "Extension event",
      formatLogDetails(item.details),
    ].filter(Boolean).join(" · "))
    .join("\n")}`;
}

function safeFilenamePart(value, fallback) {
  const sanitized = String(value ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || fallback;
}

function logsFilename() {
  const provider = "all-providers";
  const accountId = "all-shops";
  const version = safeFilenamePart(chrome.runtime.getManifest().version, "unknown");
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  return `omnichat-bridge-${provider}-${accountId}-v${version}-logs-${timestamp}.log`;
}

function renderLogs() {
  const visible = visibleLogs();
  openLogsButton.title = logs.length ? `Logs (${logs.length})` : "Logs";
  logList.replaceChildren();
  const windowNote = document.querySelector("#log-window-note");
  windowNote.hidden = visible.length <= MAX_VISIBLE_LOGS;
  windowNote.textContent = language === "th"
    ? `แสดง ${MAX_VISIBLE_LOGS} รายการล่าสุดจาก ${visible.length} รายการที่ตรงกับตัวกรอง · ส่งออก Logs ได้ครบทั้งหมด`
    : `Showing latest ${MAX_VISIBLE_LOGS} of ${visible.length} matching entries · exports include all retained logs`;
  for (const item of visible.slice(0, MAX_VISIBLE_LOGS)) {
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
    ? t("noLogsMatch")
    : t("noLogsRecorded");
  logEmpty.hidden = visible.length !== 0;
  copyLogsButton.disabled = visible.length === 0;
  downloadLogsButton.disabled = visible.length === 0;
  clearLogsButton.disabled = logs.length === 0;
}

async function refreshStoredState() {
  const stored = await readStorage([
    STORAGE.config,
    STORAGE.consent,
    STORAGE.detectedAccounts,
    STORAGE.status,
    STORAGE.scanState,
    STORAGE.pending,
    STORAGE.live,
    STORAGE.deviceName,
    STORAGE.unattendedRecovery,
    STORAGE.language,
    STORAGE.extensionUpdate,
  ]);
  storedConsent = stored[STORAGE.consent] ?? null;
  language = stored[STORAGE.language] === "th"
    ? "th"
    : stored[STORAGE.language] === "en" ? "en" : defaultLanguage();
  if (!consented()) {
    applyTranslations();
    routeTo("consent");
    return;
  }
  storedConfig = configOrEmpty(stored[STORAGE.config]);
  storedStatus = stored[STORAGE.status] ?? null;
  scanStates = stored[STORAGE.scanState] ?? null;
  pendingStates = stored[STORAGE.pending] ?? null;
  extensionUpdate = stored[STORAGE.extensionUpdate] ?? null;
  liveState = stored[STORAGE.live] ?? null;
  storedDeviceName = typeof stored[STORAGE.deviceName] === "string"
    ? stored[STORAGE.deviceName]
    : "";
  unattendedRecovery = stored[STORAGE.unattendedRecovery] === true;
  unattendedRecoveryInput.checked = unattendedRecovery;
  applyTranslations();
  renderExtensionUpdate(extensionUpdate);
  detectedAccounts = bestEffortAccounts(
    stored[STORAGE.detectedAccounts],
    await currentActiveTabUrl(),
  );
  if (!configScreen.hidden || !logsScreen.hidden || viewingPrivacy) {
    return;
  }
  renderDashboard();
}

async function detectAccount() {
  pageAccounts = [];
  detectingAccount = true;
  renderDashboard();
  try {
    const result = await chrome.runtime.sendMessage({
      type: "detect_account",
      tab_id: popupTabId,
      ...(activeProviderAdapter ? { provider: activeProviderAdapter.id } : {}),
    });
    if (result?.ok) {
      pageAccounts = Array.isArray(result.accounts) ? result.accounts : [];
      const tabUrl = await currentActiveTabUrl();
      detectedAccounts = bestEffortAccounts(
        Array.isArray(result.accounts) ? result.accounts : [],
        tabUrl,
      );
      return detectedAccounts.length > 0;
    }
  } catch (error) {
    reportPopupError("detect_account", error);
  } finally {
    detectingAccount = false;
    renderDashboard();
  }
  // Keep best-effort hydrated accounts so provider/config UI stays visible.
  return detectedAccounts.length > 0;
}

function renderConfigEditor() {
  const empty = storedConfig.accounts.length === 0;
  deviceNameInput.value = storedDeviceName;
  unattendedRecoveryInput.checked = unattendedRecovery;
  configInput.value = empty ? "" : JSON.stringify(storedConfig, null, 2);
  configInput.placeholder = JSON.stringify(sampleConfig, null, 2);
  configInput.disabled = false;
  document.querySelector("#save-config").disabled = false;
  configCount.textContent = empty ? t("noSavedAccounts") : t("currentConfig");
  exportButton.disabled = empty;
}

function openConfig() {
  if (!consented()) {
    routeTo("consent");
    return;
  }
  routeTo("config");
  setConfigStatus("");
  renderConfigEditor();
}

function closeConfig() {
  const screen = defaultScreen();
  routeTo(screen);
  if (screen === "dashboard") renderDashboard();
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
  if (!isProviderChatTab) return false;
  if (!(await detectAccount())) throw new Error("Could not detect provider accounts. Try again from the provider chat.");
  const configuredAccount = detectedAccounts.some((account) => config.accounts.some((configured) => (
    configured.provider === account.provider
      && configured.provider_account_id === account.provider_account_id
  )));
  if (!configuredAccount) throw new Error("Saved configuration does not include any detected provider account.");

  void chrome.runtime.sendMessage({ type: "sync_now" }).then((result) => {
    if (!result?.ok) reportConfigurationStatus(`Configuration saved. ${result?.error ?? "Sync failed."}`, true);
  }).catch((error) => {
    reportConfigurationStatus(`Configuration saved. ${error.message}`, true);
  });
  return true;
}

async function load() {
  renderExtensionUpdate(extensionUpdate);
  void installationId().then((installId) => {
    installationIdButton.dataset.installationId = installId;
    installationIdButton.textContent = t("installationId", installId);
  }).catch((error) => reportPopupError("installation_id", error));
  const [stored, [activeTab]] = await Promise.all([
    readStorage([
      STORAGE.config,
      STORAGE.consent,
      STORAGE.detectedAccounts,
      STORAGE.status,
      STORAGE.scanState,
      STORAGE.pending,
      STORAGE.live,
      STORAGE.deviceName,
      STORAGE.unattendedRecovery,
      STORAGE.language,
      STORAGE.extensionUpdate,
    ]),
    chrome.tabs.query({ active: true, currentWindow: true }),
  ]);
  storedConsent = stored[STORAGE.consent] ?? null;
  storedConfig = configOrEmpty(stored[STORAGE.config]);
  storedStatus = stored[STORAGE.status] ?? null;
  scanStates = stored[STORAGE.scanState] ?? null;
  pendingStates = stored[STORAGE.pending] ?? null;
  extensionUpdate = stored[STORAGE.extensionUpdate] ?? null;
  liveState = stored[STORAGE.live] ?? null;
  storedDeviceName = typeof stored[STORAGE.deviceName] === "string"
    ? stored[STORAGE.deviceName]
    : "";
  language = stored[STORAGE.language] === "th" ? "th" : stored[STORAGE.language] === "en" ? "en" : defaultLanguage();
  unattendedRecovery = stored[STORAGE.unattendedRecovery] === true;
  unattendedRecoveryInput.checked = unattendedRecovery;
  applyTranslations();
  renderExtensionUpdate(extensionUpdate);
  if (installationIdButton.dataset.installationId) {
    installationIdButton.textContent = t("installationId", installationIdButton.dataset.installationId);
  }
  popupTabId = activeTab?.id ?? null;
  activeProviderAdapter = providerAdapters.forPage(activeTab?.url);
  activeProviderSurface = activeProviderAdapter?.surfaceForUrl?.(activeTab?.url) ?? null;
  isProviderChatTab = Boolean(activeProviderAdapter?.matchesUrl(activeTab?.url));
  detectedAccounts = bestEffortAccounts(stored[STORAGE.detectedAccounts], activeTab?.url);
  viewingPrivacy = false;
  routeTo(defaultScreen());
  if (consented() && isProviderChatTab) {
    renderDashboard();
    void detectAccount().catch((error) => reportPopupError("detect_account", error));
  }
  void chrome.runtime.sendMessage({ type: "check_extension_update" }).then((result) => {
    if (!result?.ok) return;
    extensionUpdate = result.update;
    renderExtensionUpdate(extensionUpdate);
  }).catch(() => undefined);
}

consentInput.addEventListener("change", () => {
  continueButton.disabled = !consentInput.checked;
  if (consentInput.checked) consentError.textContent = "";
});

for (const button of languageButtons) {
  button.addEventListener("click", async () => {
    const nextLanguage = button.dataset.language === "th" ? "th" : "en";
    if (nextLanguage === language) return;
    const previousLanguage = language;
    language = nextLanguage;
    applyTranslations();
    try {
      await writeStorage({ [STORAGE.language]: language });
      renderConsentScreen();
      if (!dashboardScreen.hidden) renderDashboard();
    } catch (error) {
      language = previousLanguage;
      applyTranslations();
      reportPopupError("language_change", error);
    }
  });
}

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
  routeTo(consented() ? "privacy" : "consent");
});

closePrivacyButton.addEventListener("click", () => {
  const screen = defaultScreen();
  routeTo(screen);
  if (screen === "dashboard") renderDashboard();
});

let syncActionId = 0;
syncButton.addEventListener("click", async () => {
  const actionId = ++syncActionId;
  if (syncButton.dataset.action === "configure") {
    openConfig();
    return;
  }
  if (syncButton.dataset.action === "detect") {
    syncButton.disabled = true;
    try {
      await detectAccount();
      await refreshStoredState();
      renderDashboard();
    } catch (error) {
      renderDashboard(error.message, true);
    }
    return;
  }
  if (syncButton.dataset.action === "open_webchat_mini") {
    pendingAction = "openingWebchat";
    syncButton.disabled = true;
    progressArea.hidden = false;
    status.classList.remove("error");
    status.textContent = t("openingWebchat");
    setStatusAppearance("neutral", true);
    try {
      const result = await chrome.tabs.sendMessage(popupTabId, {
        type: "prepare_provider_v3",
        provider: "shopee",
        request_id: `popup-open:${crypto.randomUUID()}`,
      });
      if (!result?.ok) throw new Error(result?.error ?? "Could not open Webchat mini.");
      await detectAccount();
      await refreshStoredState();
      pendingAction = "";
      renderDashboard(t("webchatOpened"));
    } catch (error) {
      pendingAction = "";
      renderDashboard(error.message, true);
    }
    return;
  }
  syncButton.disabled = true;
  progressArea.hidden = false;
  status.classList.remove("error");
  pendingAction = activeProviderAdapter?.id === "line_oa" ? "checking" : "restarting";
  renderDashboard();
  try {
    await requestTargetPermission(accountOrigins(storedConfig));
    const result = await chrome.runtime.sendMessage({
      type: "sync_now",
      ...(activeProviderAdapter?.id === "line_oa" ? { provider: "line_oa" } : {}),
    });
    if (actionId === syncActionId) {
      pendingAction = "";
      await showSyncResult(result);
    }
  } catch (error) {
    if (actionId === syncActionId) {
      pendingAction = "";
      renderDashboard(error.message, true);
    }
  }
});

unattendedRecoveryInput.addEventListener("change", async () => {
  const enabled = unattendedRecoveryInput.checked;
  unattendedRecoveryInput.disabled = true;
  try {
    await writeStorage({ [STORAGE.unattendedRecovery]: enabled });
    unattendedRecovery = enabled;
    setConfigStatus(enabled ? t("unattendedEnabled") : t("unattendedDisabled"));
  } catch (error) {
    unattendedRecoveryInput.checked = unattendedRecovery;
    setConfigStatus(error.message, true);
  } finally {
    unattendedRecoveryInput.disabled = false;
  }
});

cancelSyncButton.addEventListener("click", async () => {
  syncActionId++;
  pendingAction = "";
  cancelSyncButton.disabled = true;
  cancelSyncButton.textContent = t("cancelling");
  status.classList.remove("error");
  status.textContent = t("cancellingSync");
  setStatusAppearance("neutral", true);
  try {
    const result = await chrome.runtime.sendMessage({
      type: "cancel_sync",
      ...(activeProviderAdapter?.id === "line_oa" ? { provider: "line_oa" } : {}),
    });
    await refreshStoredState();
    renderDashboard(
      result?.ok && result.cancelled ? t("syncCancelled") : result?.error ?? t("noSyncInProgress"),
      !result?.ok,
    );
  } catch (error) {
    renderDashboard(error.message, true);
  }
});

document.querySelector("#open-config").addEventListener("click", openConfig);
leaderStatus.addEventListener("click", async () => {
  if (!leaderStatus.dataset.action) return;
  if (leaderStatus.dataset.action === "config") {
    openConfig();
    return;
  }
  const isLeader = leaderStatus.dataset.leader === "true";
  const result = await chrome.runtime.sendMessage(isLeader
    ? { type: "release_leader", provider: activeProviderAdapter?.id }
    : { type: "claim_leader", provider: activeProviderAdapter?.id, tab_id: popupTabId });
  if (!result?.ok) renderDashboard(result?.error ?? "Could not update leader.", true);
});
document.querySelector("#close-config").addEventListener("click", closeConfig);
function showLogsLoading() {
  logList.replaceChildren();
  logEmpty.textContent = t("loadingLogs");
  logEmpty.hidden = false;
  copyLogsButton.disabled = true;
  downloadLogsButton.disabled = true;
  clearLogsButton.disabled = true;
}

async function loadLogs() {
  const stored = await readStorage([STORAGE.logs]);
  logs = pruneLogs(stored[STORAGE.logs]);
  renderLogs();
}

function openLogs(level = null) {
  if (!consented()) {
    routeTo("consent");
    return;
  }
  routeTo("logs");
  if (level) logLevel.value = level;
  showLogsLoading();
  void loadLogs().catch((error) => {
    reportPopupError("load_logs", error);
    logEmpty.textContent = t("logsLoadFailed");
  });
}
openLogsButton.addEventListener("click", () => openLogs("all"));
document.querySelector("#close-logs").addEventListener("click", () => {
  const screen = defaultScreen();
  routeTo(screen);
  if (screen === "dashboard") renderDashboard();
});
async function prepareLogExport() {
  const result = await chrome.runtime.sendMessage({ type: "flush_logs" });
  if (!result?.ok) throw new Error("Could not persist the latest diagnostics. Retry the export.");
  await loadLogs();
}

copyLogsButton.addEventListener("click", async () => {
  try {
    await prepareLogExport();
    await navigator.clipboard.writeText(formatSupportLogs());
    copyLogsButton.textContent = t("copied");
  } catch {
    copyLogsButton.textContent = t("couldNotCopy");
  }
  setTimeout(() => { copyLogsButton.textContent = t("copy"); }, 1_200);
});

downloadLogsButton.addEventListener("click", async () => {
  try {
    await prepareLogExport();
  } catch (error) {
    reportPopupError("export_logs", error);
    return;
  }
  const url = URL.createObjectURL(new Blob([`${formatSupportLogs()}\n`], { type: "text/plain" }));
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
    const input = JSON.parse(configInput.value);
    assertMigratableConfig(input);
    const config = validateConfigFile(input);
    const deviceName = normalizeDeviceName(deviceNameInput.value) || generateDeviceName();
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
    renderDeviceNameBadge();
    logPopup("info", "configuration_saved", "Configuration saved.", {
      accounts: config.accounts.length,
      logs_enabled: config.accounts.some((account) => Boolean(account.logs_url)),
    });
    renderConfigEditor();
    try {
      await requestTargetPermission([...accountOrigins(config), ...migrationOrigins(config)]);
      const syncStarted = configurationChanged && await autoStartSync(config);
      setConfigStatus(
        syncStarted
          ? "Configuration saved. Sync started."
          : configurationChanged
            ? "Configuration saved. Open a supported provider chat to start sync."
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
    const input = JSON.parse(await file.text());
    assertMigratableConfig(input);
    const config = validateConfigFile(input);
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
      await requestTargetPermission([...accountOrigins(config), ...migrationOrigins(config)]);
      message += " Server access approved.";
      if (await autoStartSync(config)) message += " Sync started.";
      else message += " Open a supported provider chat to start sync.";
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
  const erased = await chrome.runtime.sendMessage({ type: "erase_local_data" });
  if (!erased?.ok) throw new Error(erased?.error || "Could not erase local extension data.");
  storedConsent = null;
  storedConfig = emptyConfig();
  detectedAccounts = [];
  pageAccounts = [];
  retryingAccounts.clear();
  accountRetryErrors.clear();
  storedStatus = null;
  liveState = null;
  scanStates = null;
  pendingStates = null;
  logs = [];
  storedDeviceName = "";
  unattendedRecovery = false;
  language = defaultLanguage();
  viewingPrivacy = false;
  routeTo("consent");
  await load();
});

installationIdButton.addEventListener("click", async () => {
  const id = installationIdButton.dataset.installationId;
  if (!id) return;
  await navigator.clipboard.writeText(id);
  installationIdButton.textContent = t("installationCopied");
  setTimeout(() => {
    installationIdButton.textContent = t("installationId", installationIdButton.dataset.installationId);
  }, 900);
});

updateExtensionButton.addEventListener("click", async () => {
  if (extensionUpdate?.status !== "available") return;
  extensionUpdate = { ...extensionUpdate, status: "updating" };
  renderExtensionUpdate(extensionUpdate);
  try {
    const result = await chrome.runtime.sendMessage({ type: "apply_extension_update" });
    if (result?.ok) return;
    extensionUpdate = { ...extensionUpdate, status: "available" };
    renderExtensionUpdate(extensionUpdate);
  } catch {
    extensionUpdate = { ...extensionUpdate, status: "available" };
    renderExtensionUpdate(extensionUpdate);
  }
});

let stateRefreshPending = false;
let logsRefreshPending = false;
const scheduleStoredRefresh = createCoalescedRefresh(async () => {
  const refreshState = stateRefreshPending;
  const refreshLogs = logsRefreshPending;
  stateRefreshPending = false;
  logsRefreshPending = false;
  if (refreshState) await refreshStoredState().catch((error) => reportPopupError("refresh_state", error));
  if (refreshLogs && !logsScreen.hidden) await loadLogs().catch((error) => reportPopupError("load_logs", error));
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes[STORAGE.config] || changes[STORAGE.consent] || changes[STORAGE.deviceName] || changes[STORAGE.detectedAccounts] || changes[STORAGE.status] || changes[STORAGE.scanState] || changes[STORAGE.pending] || changes[STORAGE.live] || changes[STORAGE.commandTab] || changes[STORAGE.unattendedRecovery] || changes[STORAGE.language] || changes[STORAGE.extensionUpdate]) {
    stateRefreshPending = true;
    scheduleStoredRefresh();
  }
  if (changes[STORAGE.logs] && !logsScreen.hidden) {
    logsRefreshPending = true;
    scheduleStoredRefresh();
  }
});

void load().then(() => {
  if (consented()) void chrome.runtime.sendMessage({ type: "get_live_state" })
    .catch((error) => reportPopupError("leader_status", error));
}).catch((error) => {
  reportPopupError("load", error);
  storedConsent = null;
  routeTo("consent");
  consentError.textContent = t("loadFailed");
});
