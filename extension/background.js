import { hmacHex, sha256Hex } from "./lib/crypto.js";
import { accountConfigKey, findAccountConfig } from "./lib/config.js";
import { buildConnectionHealth } from "./lib/connection-status.js";
import {
  advanceConversationCursors,
  compareMessageCursor,
  deliveryRetryDelay,
  hasScanBacklog,
  isAfterMessageCursor,
  latestMessageCursor,
  migrateScanState,
} from "./lib/sync-state.js";
import {
  createLogEntry,
  logEntryForUpload,
  pruneLogs,
} from "./lib/logs.js";
import {
  STORAGE,
  hasLocalConsent,
  installationId,
  normalizeDeviceName,
  readAccountState,
  readStorage,
  writeAccountState,
  writeStorage,
} from "./lib/storage.js";
import "./lib/shopee-url.js";

const { isShopeeChatUrl } = globalThis.OmnichatShopeeUrl;
const SHOPEE_URL_PATTERN = "https://seller.shopee.co.th/*";
const SHOPEE_CHAT_URL = "https://seller.shopee.co.th/new-webchat/conversations";
const MAX_BATCH_MESSAGES = 500;
const MAX_BATCH_CONVERSATIONS = 50;
const MAX_MESSAGES_PER_CONVERSATION = 100;
const MAX_FLUSH_BATCHES = 10;
const RESUME_SYNC_COOLDOWN_MS = 5 * 60_000;
const MAX_REPLY_TEXT_LENGTH = 2_000;
const MAX_REPLY_IMAGE_BYTES = 10 * 1024 * 1024;
const DELIVERY_RETRY_ALARM = "omnichat-delivery-retry";
const LOG_UPLOAD_ALARM = "omnichat-log-upload";
const MAX_LOG_UPLOAD_BATCH = 100;
const INBOUND_LOG_MESSAGES = {
  "popup.configuration_saved": "Configuration saved.",
  "popup.configuration_imported": "Configuration imported.",
  "popup.configuration_exported": "Configuration exported.",
  "provider.content_loaded": "Shopee content bridge loaded.",
  "provider.recovery_not_configured": "Provider recovery could not start because setup is incomplete.",
  "provider.checkpoint_failed": "Could not load the sync checkpoint.",
  "provider.recovery_requested": "Provider recovery request sent.",
  "provider.account_detection_timeout": "Shopee account detection timed out.",
  "provider.account_detected": "Shopee account detected on provider page.",
  "provider.account_detection_failed": "Shopee account detection failed.",
  "provider.recovery_batch_processed": "Recovered message page processed.",
  "provider.recovery_batch_failed": "Recovered message page failed.",
  "provider.resume_failed": "Automatic sync resume failed.",
  "provider.realtime_processed": "Realtime provider event processed.",
  "provider.recovery_failed": "Shopee recovery failed.",
  "provider.recovery_timeout": "Shopee recovery stopped responding.",
  "provider.recovery_completed": "Shopee recovery completed.",
  "provider.socket_observed": "Shopee realtime socket detected.",
  "provider.recovery_started": "Shopee recovery started.",
  "provider.recovery_plan": "Shopee recovery plan prepared.",
  "provider.conversation_started": "Checking one conversation for missed messages.",
  "provider.conversation_completed": "Conversation recovery check completed.",
  "provider.history_template_ready": "Shopee history request template captured.",
  "provider.list_template_ready": "Shopee conversation-list request template captured.",
  "provider.socket_connected": "Shopee realtime socket connected.",
};
let mutationQueue = Promise.resolve();
let logMutationQueue = Promise.resolve();
let activeSync = null;
let activeSyncControl = null;
let liveSocket = null;
let liveReconnectTimer = null;
let liveHeartbeatTimer = null;
let liveReconnectAttempt = 0;
let liveConnectionKey = null;

function mutateLogs(task) {
  const result = logMutationQueue.then(task, task);
  logMutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function scheduleLogUpload(delayInMinutes = 1) {
  if (await chrome.alarms.get(LOG_UPLOAD_ALARM)) return;
  chrome.alarms.create(LOG_UPLOAD_ALARM, { delayInMinutes });
}

async function resumeLogUpload() {
  const stored = await readStorage([
    STORAGE.serverInitialized,
    STORAGE.logUploadEnabled,
    STORAGE.logOutbox,
  ]);
  if (
    hasServerInitialized(stored)
    && stored[STORAGE.logUploadEnabled] === true
    && Array.isArray(stored[STORAGE.logOutbox])
    && stored[STORAGE.logOutbox].length
  ) {
    await scheduleLogUpload();
  }
}

async function recordLog(level, area, event, message, details = {}, { remote = true } = {}) {
  try {
    await mutateLogs(async () => {
      const stored = await readStorage([
        STORAGE.logs,
        STORAGE.logOutbox,
        STORAGE.serverInitialized,
        STORAGE.logUploadEnabled,
        STORAGE.config,
        STORAGE.detectedAccount,
      ]);
      const context = currentAccountContext(stored);
      const entry = createLogEntry({
        level,
        area,
        event,
        message,
        details,
        account_key: context?.key,
      });
      const logs = pruneLogs([entry, ...(Array.isArray(stored[STORAGE.logs]) ? stored[STORAGE.logs] : [])]);
      const retainedIds = new Set(logs.map((item) => item.id));
      const outbox = (Array.isArray(stored[STORAGE.logOutbox]) ? stored[STORAGE.logOutbox] : [])
        .filter((id) => retainedIds.has(id));
      const shouldUpload = remote
        && hasServerInitialized(stored)
        && stored[STORAGE.logUploadEnabled] === true
        && Boolean(context?.config.logs_url);
      if (shouldUpload) outbox.push(entry.id);
      await writeStorage({
        [STORAGE.logs]: logs,
        [STORAGE.logOutbox]: outbox,
      });
      if (shouldUpload) void scheduleLogUpload();
    });
  } catch {
    // Logging must never interrupt bridge behavior.
  }
}

function diagnosticErrorDetails(error) {
  const text = error instanceof Error ? error.message : String(error);
  const status = text.match(/\b([1-5]\d{2})\b/)?.[1];
  let category = "unknown";
  if (/not configured|setup is required/i.test(text)) category = "not_configured";
  else if (/timed out|timeout/i.test(text)) category = "timeout";
  else if (/429|rate limit/i.test(text)) category = "rate_limited";
  else if (/401|403|unauthorized|forbidden/i.test(text)) category = "unauthorized";
  else if (/acknowledgement is invalid/i.test(text)) category = "invalid_acknowledgement";
  else if (/refresh|loading|initializ/i.test(text)) category = "provider_not_ready";
  else if (/returned [5]\d{2}|unavailable|network|fetch/i.test(text)) category = "network";
  return {
    category,
    ...(status ? { http_status: Number(status) } : {}),
    ...(error instanceof Error ? { error_type: error.name } : {}),
  };
}

async function recordUnexpected(scope, error) {
  await recordLog("error", scope, "failed", "Extension operation failed.", diagnosticErrorDetails(error));
}

function currentAccountContext(stored) {
  const key = accountConfigKey(stored[STORAGE.detectedAccount]);
  const config = findAccountConfig(stored[STORAGE.config], stored[STORAGE.detectedAccount]);
  return key && config ? { key, config, account: stored[STORAGE.detectedAccount] } : null;
}

function hasServerInitialized(stored) {
  return stored[STORAGE.serverInitialized] === true;
}

async function updateScopedState(storageKey, key, patch) {
  const stored = await readStorage([storageKey]);
  const current = readAccountState(stored[storageKey], key, {});
  await writeStorage({
    [storageKey]: writeAccountState(stored[storageKey], key, {
      ...current,
      ...patch,
    }),
  });
}

async function updateLiveState(context, patch) {
  const stored = await readStorage([STORAGE.live]);
  const current = readAccountState(stored[STORAGE.live], context.key, {});
  await writeStorage({
    [STORAGE.live]: writeAccountState(stored[STORAGE.live], context.key, {
      ...current,
      ...patch,
      updated_at: new Date().toISOString(),
    }),
  });
}

async function getAccountScanState() {
  const stored = await readStorage([
    STORAGE.config,
    STORAGE.consent,
    STORAGE.detectedAccount,
    STORAGE.pending,
    STORAGE.scanState,
    STORAGE.targetCursor,
    STORAGE.lastResumeSyncAt,
  ]);
  const context = currentAccountContext(stored);
  if (!hasLocalConsent(stored[STORAGE.consent]) || !context) {
    throw new Error("Shopee browser bridge is not configured.");
  }
  const existing = readAccountState(stored[STORAGE.scanState], context.key, null);
  if (existing?.version === 1) return { context, state: existing, stored };
  const pending = readAccountState(stored[STORAGE.pending], context.key, []);
  const legacyCursor = readAccountState(stored[STORAGE.targetCursor], context.key, null);
  const legacyLastAutoAt = readAccountState(
    stored[STORAGE.lastResumeSyncAt],
    context.key,
    null,
  );
  const state = migrateScanState(legacyCursor, pending, legacyLastAutoAt);
  const scanState = writeAccountState(
    stored[STORAGE.scanState],
    context.key,
    state,
  );
  await writeStorage({ [STORAGE.scanState]: scanState });
  stored[STORAGE.scanState] = scanState;
  return { context, state, stored };
}

async function writeAccountScanState(context, state, container = null) {
  const currentContainer = container ?? (await readStorage([STORAGE.scanState]))[STORAGE.scanState];
  await writeStorage({
    [STORAGE.scanState]: writeAccountState(
      currentContainer,
      context.key,
      { ...state, version: 1, updated_at: new Date().toISOString() },
    ),
  });
}

function bootstrapConversation(value) {
  const id = String(value?.id ?? "").trim();
  if (!id) return null;
  return {
    id,
    shop_id: String(value?.shop_id ?? "").trim(),
    biz_id: String(value?.biz_id ?? "0").trim() || "0",
    last_message_time: value?.last_message_time ?? null,
    created_timestamp: value?.created_timestamp ?? null,
    to_id: String(value?.to_id ?? "").trim(),
    to_shop_id: String(value?.to_shop_id ?? "").trim(),
    to_name: String(value?.to_name ?? "").trim(),
    to_avatar: String(value?.to_avatar ?? "").trim(),
  };
}

async function saveBootstrapSelection(conversations) {
  const { context, state, stored } = await getAccountScanState();
  if (state.watermark || state.bootstrap?.conversations?.length) return;
  const selected = (Array.isArray(conversations) ? conversations : [])
    .map(bootstrapConversation)
    .filter(Boolean)
    .slice(0, 10);
  if (!selected.length) return;
  await writeAccountScanState(context, {
    ...state,
    bootstrap: { conversations: selected },
    in_progress: true,
  }, stored[STORAGE.scanState]);
}

async function advanceScanCursor(conversationId, cursor, summaryToken) {
  const id = String(conversationId ?? "").trim();
  if (!id) return;
  const { context, state, stored } = await getAccountScanState();
  const previous = state.conversations?.[id];
  const next = cursor && compareMessageCursor(cursor, previous) > 0
    ? {
      event_timestamp: cursor.event_timestamp,
      message_id: cursor.message_id,
    }
    : { ...(previous ?? {}) };
  if (typeof summaryToken === "string" && summaryToken) {
    next.summary_token = summaryToken;
  }
  if (!next.event_timestamp) return;
  await writeAccountScanState(context, {
    ...state,
    conversations: {
      ...(state.conversations ?? {}),
      [id]: next,
    },
  }, stored[STORAGE.scanState]);
}

function exclusive(task) {
  const result = mutationQueue.then(task, task);
  mutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.type === "record_log") {
    const area = message.area === "popup" ? "popup" : "provider";
    const safeMessage = INBOUND_LOG_MESSAGES[`${area}.${message.event}`];
    if (!safeMessage) {
      respond({ ok: false, error: "Unsupported log event." });
      return false;
    }
    void recordLog(
      message.level,
      area,
      message.event,
      safeMessage,
      message.details,
    ).then(() => respond({ ok: true }));
    return true;
  }
  if (message?.type === "clear_logs") {
    void mutateLogs(async () => {
      await chrome.alarms.clear(LOG_UPLOAD_ALARM);
      await writeStorage({
        [STORAGE.logs]: [],
        [STORAGE.logOutbox]: [],
      });
    }).then(
      () => respond({ ok: true }),
      (error) => respond({ ok: false, error: String(error) }),
    );
    return true;
  }
  if (message?.type === "get_sync_state") {
    void exclusive(() => getAccountScanState()).then(
      ({ state }) => respond({ ok: true, checkpoint: state }),
      (error) => respond({ ok: false, error: String(error) })
    );
    return true;
  }
  if (message?.type === "queue_messages") {
    void exclusive(() => queueMessages(
      message.messages,
      Boolean(message.flush),
      message.advance_cursor !== false,
    )).then(
      (result) => respond({ ok: true, ...result }),
      (error) => respond({ ok: false, error: String(error) })
    );
    return true;
  }
  if (message?.type === "flush_now") {
    void exclusive(() => attemptDelivery({ resetBackoff: true })).then(
      (result) => respond({ ok: true, ...result }),
      (error) => respond({ ok: false, error: String(error) })
    );
    return true;
  }
  if (message?.type === "cancel_sync") {
    void cancelActiveSync().then(
      (result) => respond({ ok: true, ...result }),
      (error) => respond({ ok: false, error: String(error) })
    );
    return true;
  }
  if (message?.type === "sync_now") {
    void writeStorage({
      [STORAGE.serverInitialized]: true,
      [STORAGE.logUploadEnabled]: true,
    })
      .then(() => recordLog("info", "sync", "requested", "Manual sync requested."))
      .then(() => ensureLiveConnection())
      .then(() => startSync("manual"))
      .then(
        (result) => respond({ ok: true, ...result }),
        (error) => respond({ ok: false, error: String(error) })
      );
    return true;
  }
  if (message?.type === "resume_sync") {
    void resumeSync().then(
      (result) => respond({ ok: true, ...result }),
      (error) => respond({ ok: false, error: String(error) })
    );
    return true;
  }
  if (message?.type === "sync_progress") {
    void exclusive(() => readStorage([STORAGE.detectedAccount, STORAGE.status]).then((stored) => {
      const key = accountConfigKey(stored[STORAGE.detectedAccount]);
      if (!key) throw new Error("Shopee account is not detected.");
      const current = readAccountState(stored[STORAGE.status], key, {});
      if (!["discovering", "syncing"].includes(current.state)) return;
      return updateScopedState(STORAGE.status, key, {
        state: "syncing",
        phase: "checking_conversations",
        completed_conversations: message.completed_conversations,
        total_conversations: message.total_conversations
      });
    })).then(
      () => recordLog("info", "sync", "progress", "Sync progress updated.", {
        completed: Number(message.completed_conversations) || 0,
        total: Number(message.total_conversations) || 0,
      }),
    ).then(
      () => respond({ ok: true }),
      (error) => respond({ ok: false, error: String(error) })
    );
    return true;
  }
  if (message?.type === "record_sync_plan") {
    const conversations = Array.isArray(message.conversations) ? message.conversations.slice(0, 50) : [];
    const details = {
      mode: message.mode === "bootstrap" ? "bootstrap" : "incremental",
      candidates: conversations.length,
      history_jobs: conversations.filter((item) => item?.decision === "history_job").length,
      probes: conversations.filter((item) => item?.decision === "probe").length,
      skipped: conversations.filter((item) => item?.decision === "skip").length,
      checkpoint_present: Boolean(message.checkpoint),
    };
    void recordLog("info", "sync", "plan_created", "Sync plan created.", details).then(
      () => respond({ ok: true }),
      (error) => respond({ ok: false, error: String(error) })
    );
    return true;
  }
  if (message?.type === "advance_scan_cursor") {
    void exclusive(() => advanceScanCursor(
      message.conversation_id,
      message.cursor,
      message.summary_token,
    )).then(
      () => respond({ ok: true }),
      (error) => respond({ ok: false, error: String(error) })
    );
    return true;
  }
  if (message?.type === "save_bootstrap") {
    void exclusive(() => saveBootstrapSelection(message.conversations)).then(
      () => respond({ ok: true }),
      (error) => respond({ ok: false, error: String(error) })
    );
    return true;
  }
  if (message?.type === "detect_account") {
    void detectOpenShopeeAccount().then(
      (result) => respond(result),
      (error) => respond({ ok: false, error: String(error) })
    );
    return true;
  }
  if (["send_text", "send_image", "send_product"].includes(message?.type)) {
    void sendViaShopeeApi(message).then(
      (result) => respond(result),
      async (error) => {
        await recordUnexpected("send_message", error);
        respond({ ok: false, error: String(error) });
      }
    );
    return true;
  }
  if (message?.type === "get_live_state") {
    void readStorage([STORAGE.serverInitialized]).then((stored) => {
      if (!hasServerInitialized(stored)) return { ok: true, initialized: false };
      return ensureLiveConnection().then(() => getLiveState());
    }).then(respond, async (error) => {
      await recordUnexpected("live_state", error);
      respond({ ok: false, error: String(error) });
    });
    return true;
  }
  if (message?.type === "claim_leader") {
    void claimLeader(message.tab_id).then(respond, async (error) => {
      await recordUnexpected("claim_leader", error);
      respond({ ok: false, error: String(error) });
    });
    return true;
  }
  if (message?.type === "release_leader") {
    void releaseLeader().then(respond, async (error) => {
      await recordUnexpected("release_leader", error);
      respond({ ok: false, error: String(error) });
    });
    return true;
  }
  if (message?.type === "open_leader_tab") {
    void openCommandTab().then(respond, (error) => respond({ ok: false, error: String(error) }));
    return true;
  }
  return undefined;
});

async function commandTab(context) {
  const stored = await readStorage([STORAGE.commandTab]);
  const tabId = readAccountState(stored[STORAGE.commandTab], context.key, null);
  if (Number.isInteger(tabId)) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.url?.startsWith("https://seller.shopee.co.th/")) return tab;
    } catch {
      // The tab was closed; select another seller tab below.
    }
  }
  let tab = await findShopeeChatTab();
  if (!tab) tab = await chrome.tabs.create({ url: SHOPEE_CHAT_URL, active: false });
  if (!tab.id) throw new Error("Shopee Seller Chat tab is unavailable.");
  await writeStorage({ [STORAGE.commandTab]: writeAccountState(stored[STORAGE.commandTab], context.key, tab.id) });
  return tab;
}

async function selectCommandTab(context, tabId) {
  if (!Number.isInteger(tabId)) return;
  const tab = await chrome.tabs.get(tabId);
  if (!Number.isInteger(tab.id) || !isShopeeChatUrl(tab.url)) {
    throw new Error("Open Shopee Seller Chat in this tab first.");
  }
  const stored = await readStorage([STORAGE.commandTab]);
  await writeStorage({ [STORAGE.commandTab]: writeAccountState(stored[STORAGE.commandTab], context.key, tab.id) });
}

async function sendViaShopeeApi(message) {
  const requestId = typeof message?.request_id === "string" ? message.request_id : "";
  const conversationId = typeof message?.conversation_id === "string" ? message.conversation_id : "";
  const clientMessageId = typeof message?.client_message_id === "string" ? message.client_message_id : "";
  const commandType = typeof message?.type === "string" ? message.type : "";
  if (!requestId || !conversationId || !["send_text", "send_image", "send_product"].includes(commandType)) {
    return { ok: false, error: "Reply command is invalid." };
  }
  const stored = await readStorage([STORAGE.config, STORAGE.detectedAccount]);
  const context = currentAccountContext(stored);
  if (!context) return { ok: false, error: "Shopee browser bridge is not configured." };
  const tab = await commandTab(context);
  await ensureShopeeBridge(tab.id);
  let imagePayload = {};
  if (commandType === "send_image") {
    const imageUrl = typeof message.image_url === "string" ? message.image_url : "";
    let parsedUrl;
    try { parsedUrl = new URL(imageUrl); } catch { /* Validated below. */ }
    if (parsedUrl?.protocol !== "https:") {
      return { ok: false, error: "Reply image URL is invalid." };
    }
    if (!context.config.image_server_url) {
      return { ok: false, error: "Reply image server is not configured." };
    }
    if (parsedUrl.origin !== new URL(context.config.image_server_url).origin) {
      return { ok: false, error: "Reply image URL is not from the configured image server." };
    }
    const response = await fetch(parsedUrl);
    const imageType = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
    if (!response.ok || !imageType.startsWith("image/")) {
      return { ok: false, error: "Could not load reply image." };
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.byteLength || bytes.byteLength > MAX_REPLY_IMAGE_BYTES) {
      return { ok: false, error: "Reply image must be 10 MB or smaller." };
    }
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 32_768) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
    }
    imagePayload = { image_base64: btoa(binary), image_type: imageType };
  }
  return chrome.tabs.sendMessage(tab.id, {
    ...message,
    ...imagePayload,
    type: "send_api",
    command_type: commandType,
    request_id: requestId,
    conversation_id: conversationId,
    ...(clientMessageId ? { client_message_id: clientMessageId } : {}),
  });
}

// WIP alternative only. Do not call this from the command path: it needs the target
// conversation open and competes with the user's Shopee UI.
async function sendTextByUiClick_WIP(message) {
  const stored = await readStorage([STORAGE.config, STORAGE.detectedAccount]);
  const context = currentAccountContext(stored);
  if (!context) return { ok: false, error: "Shopee browser bridge is not configured." };
  const tab = await commandTab(context);
  await ensureShopeeBridge(tab.id);
  return chrome.tabs.sendMessage(tab.id, { ...message, type: "send_text_ui_click_wip" });
}

function liveEndpoint(config) {
  if (typeof config?.commands_url !== "string") return null;
  const url = new URL(config.commands_url);
  return url.protocol === "https:" ? url : null;
}

function leaderEndpoint(config) {
  const url = liveEndpoint(config);
  if (!url) return null;
  url.pathname = url.pathname.replace(/\/tickets$/, "/leader");
  return url;
}

async function signedLeaderRequest(action) {
  const stored = await readStorage([
    STORAGE.config,
    STORAGE.detectedAccount,
    STORAGE.serverInitialized,
  ]);
  if (!hasServerInitialized(stored)) throw new Error("Sync messages before using live replies.");
  const context = currentAccountContext(stored);
  const url = leaderEndpoint(context?.config);
  if (!context || !url) throw new Error("Leader endpoint is not configured.");
  const body = JSON.stringify({
    provider: "shopee",
    provider_account_id: context.account.provider_account_id,
    installation_id: await installationId(),
    action,
  });
  const timestamp = new Date().toISOString();
  const nonce = crypto.randomUUID();
  const signature = await hmacHex(context.config.hmac_secret, `POST\n${url.pathname}\n${timestamp}\n${nonce}\n${await sha256Hex(body)}`);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-omnichat-provider-account-id": context.account.provider_account_id,
      "x-omnichat-timestamp": timestamp,
      "x-omnichat-nonce": nonce,
      "x-omnichat-signature": signature,
    },
    body,
  });
  if (!response.ok) throw new Error(`Leader endpoint returned ${response.status}.`);
  const result = await response.json();
  await updateLiveState(context, {
    socket: liveSocket?.readyState === WebSocket.OPEN ? "connected" : "connecting",
    leader: result?.leader_installation_id === await installationId(),
    leader_installation_id: result?.leader_installation_id ?? null,
  });
  return { ok: true, ...result };
}

async function getLiveState() {
  try { return await signedLeaderRequest("status"); }
  catch (error) {
    const stored = await readStorage([STORAGE.config, STORAGE.detectedAccount]);
    const context = currentAccountContext(stored);
    if (context) await updateLiveState(context, {
      socket: liveSocket?.readyState === WebSocket.OPEN ? "connected" : "reconnecting",
      leader: false,
    });
    throw error;
  }
}

async function claimLeader(tabId) {
  const stored = await readStorage([STORAGE.config, STORAGE.detectedAccount]);
  const context = currentAccountContext(stored);
  if (!context) throw new Error("Shopee browser bridge is not configured.");
  await selectCommandTab(context, tabId);
  return signedLeaderRequest("claim");
}

async function releaseLeader() {
  const stored = await readStorage([STORAGE.config, STORAGE.detectedAccount]);
  if (!currentAccountContext(stored)) throw new Error("Shopee browser bridge is not configured.");
  return signedLeaderRequest("release");
}

async function openCommandTab() {
  const stored = await readStorage([STORAGE.config, STORAGE.detectedAccount]);
  const context = currentAccountContext(stored);
  if (!context) throw new Error("Shopee browser bridge is not configured.");
  const tab = await commandTab(context);
  if (!tab.id) throw new Error("Shopee Seller Chat tab is unavailable.");
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  return { ok: true };
}

function stopLiveConnection() {
  clearTimeout(liveReconnectTimer);
  clearInterval(liveHeartbeatTimer);
  liveReconnectTimer = null;
  liveHeartbeatTimer = null;
  liveSocket?.close();
  liveSocket = null;
  liveConnectionKey = null;
}

function scheduleLiveReconnect() {
  clearTimeout(liveReconnectTimer);
  const delay = Math.min(60_000, 1_000 * 2 ** Math.min(liveReconnectAttempt, 6));
  liveReconnectAttempt += 1;
  liveReconnectTimer = setTimeout(() => { void ensureLiveConnection(); }, delay);
}

async function signedLiveTicket(config, providerAccountId) {
  const url = liveEndpoint(config);
  if (!url) throw new Error("Live reply endpoint is not configured.");
  const body = JSON.stringify({ provider: "shopee", provider_account_id: providerAccountId, installation_id: await installationId() });
  const timestamp = new Date().toISOString();
  const nonce = crypto.randomUUID();
  const bodyHash = await sha256Hex(body);
  const signature = await hmacHex(config.hmac_secret, `POST\n${url.pathname}\n${timestamp}\n${nonce}\n${bodyHash}`);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-omnichat-provider-account-id": providerAccountId,
      "x-omnichat-timestamp": timestamp,
      "x-omnichat-nonce": nonce,
      "x-omnichat-signature": signature,
    },
    body,
  });
  if (!response.ok) throw new Error(`Live reply endpoint returned ${response.status}.`);
  const ticket = await response.json();
  if (typeof ticket?.ticket !== "string" || !ticket.ticket) throw new Error("Live reply endpoint returned an invalid ticket.");
  let socketUrl;
  try {
    socketUrl = new URL(ticket.socket_url);
  } catch {
    throw new Error("Live reply endpoint returned an invalid socket URL.");
  }
  if (socketUrl.protocol !== "wss:") throw new Error("Live reply endpoint returned an invalid socket URL.");
  return { ticket: ticket.ticket, socketUrl };
}

async function connectionStatusSnapshot(context) {
  const stored = await readStorage([
    STORAGE.deviceName,
    STORAGE.detectedAccount,
    STORAGE.pending,
    STORAGE.status,
  ]);
  const tabs = (await chrome.tabs.query({ url: SHOPEE_URL_PATTERN }))
    .filter((tab) => isShopeeChatUrl(tab.url));
  let providerStatus = null;
  for (const tab of tabs) {
    if (!tab.id) continue;
    try {
      const result = await chrome.tabs.sendMessage(tab.id, { type: "get_provider_status" });
      if (result?.ok) {
        providerStatus = result;
        break;
      }
    } catch {
      // A Shopee tab can exist while its content bridge is still loading.
    }
  }

  const detected = stored[STORAGE.detectedAccount];
  const accountDetected = detected?.provider === "shopee"
    && typeof detected.provider_account_id === "string";
  const accountMatches = accountDetected
    && detected.provider_account_id === context.account.provider_account_id;
  const status = readAccountState(stored[STORAGE.status], context.key, {});
  const pending = readAccountState(stored[STORAGE.pending], context.key, []);
  const deviceName = normalizeDeviceName(stored[STORAGE.deviceName]);
  const health = buildConnectionHealth({
    tabCount: tabs.length,
    contentReady: Boolean(providerStatus),
    accountDetected,
    accountMatches,
    realtimeConnected: providerStatus?.realtime_connected === true,
    lastRealtimeConnectedAt: providerStatus?.last_realtime_connected_at,
    pendingMessages: pending.length,
    status,
  });

  return {
    type: "connection_status",
    schema: "omnichat.connection_status",
    version: 1,
    provider: context.account.provider,
    provider_account_id: context.account.provider_account_id,
    installation_id: await installationId(),
    device_name: deviceName || null,
    extension_version: chrome.runtime.getManifest().version,
    reported_at: new Date().toISOString(),
    client: {
      platform: String(navigator.platform ?? "").slice(0, 120),
      language: String(navigator.language ?? "").slice(0, 32),
    },
    health,
  };
}

async function sendConnectionStatus(socket, context) {
  const status = await connectionStatusSnapshot(context);
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(status));
}

async function ensureLiveConnection() {
  const stored = await readStorage([
    STORAGE.config,
    STORAGE.consent,
    STORAGE.detectedAccount,
    STORAGE.serverInitialized,
  ]);
  const context = currentAccountContext(stored);
  const endpoint = liveEndpoint(context?.config);
  if (!hasServerInitialized(stored)
    || !hasLocalConsent(stored[STORAGE.consent])
    || !context
    || !endpoint) {
    stopLiveConnection();
    void recordLog("debug", "live", "not_started", "Live connection is not ready.", {
      consented: hasLocalConsent(stored[STORAGE.consent]),
      configured: Boolean(context),
      endpoint_configured: Boolean(endpoint),
    });
    return;
  }
  const connectionKey = `${context.key}:${endpoint}`;
  if (liveConnectionKey && liveConnectionKey !== connectionKey) stopLiveConnection();
  if (liveSocket?.readyState === WebSocket.OPEN || liveSocket?.readyState === WebSocket.CONNECTING) return;
  await updateLiveState(context, { socket: "connecting" });
  await recordLog("info", "live", "connecting", "Connecting live command channel.");
  try {
    const { ticket, socketUrl } = await signedLiveTicket(
      context.config,
      context.account.provider_account_id,
    );
    socketUrl.searchParams.set("ticket", ticket);
    const socket = new WebSocket(socketUrl);
    liveSocket = socket;
    liveConnectionKey = connectionKey;
    socket.addEventListener("open", () => {
      liveReconnectAttempt = 0;
      void updateLiveState(context, { socket: "connected" });
      void recordLog("info", "live", "connected", "Live command channel connected.");
      clearInterval(liveHeartbeatTimer);
      liveHeartbeatTimer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          void sendConnectionStatus(socket, context)
            .catch((error) => recordUnexpected("connection_status", error));
        }
      }, 20_000);
      void sendConnectionStatus(socket, context)
        .catch((error) => recordUnexpected("connection_status", error));
      void getLiveState().catch((error) => recordUnexpected("leader_status", error));
    });
    socket.addEventListener("message", (event) => { void handleLiveCommand(event.data); });
    socket.addEventListener("close", () => {
      if (liveSocket === socket) {
        liveSocket = null;
        liveConnectionKey = null;
        clearInterval(liveHeartbeatTimer);
        void updateLiveState(context, { socket: "reconnecting", leader: false });
        void recordLog("warn", "live", "disconnected", "Live command channel disconnected.", {
          reconnect_attempt: liveReconnectAttempt + 1,
        });
        scheduleLiveReconnect();
      }
    });
    socket.addEventListener("error", () => socket.close());
  } catch (error) {
    await updateLiveState(context, { socket: "reconnecting" });
    await recordUnexpected("live_connection", error);
    scheduleLiveReconnect();
  }
}

async function handleLiveCommand(raw) {
  let command;
  try { command = JSON.parse(raw); } catch { return; }
  if (!["send_text", "send_image", "send_product"].includes(command?.type) || command.provider !== "shopee") return;
  const stored = await readStorage([STORAGE.detectedAccount]);
  if (stored[STORAGE.detectedAccount]?.provider_account_id !== command.provider_account_id) return;
  let result;
  try {
    result = await exclusive(() => sendViaShopeeApi(command));
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!result?.ok) await recordUnexpected("live_command", result?.error ?? "Reply failed.");
  if (liveSocket?.readyState === WebSocket.OPEN) {
    liveSocket.send(JSON.stringify({
      type: "send_result",
      request_id: command.request_id,
      ok: Boolean(result?.ok),
      ...(result?.ok
        ? { provider_message_id: result.provider_message_id }
        : { error: result?.error ?? "Reply failed." }),
    }));
  }
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes[STORAGE.config] || changes[STORAGE.consent] || changes[STORAGE.detectedAccount]) void ensureLiveConnection();
  if (
    changes[STORAGE.deviceName]
    || changes[STORAGE.detectedAccount]
    || changes[STORAGE.status]
    || changes[STORAGE.pending]
  ) {
    void readStorage([STORAGE.config, STORAGE.detectedAccount]).then((stored) => {
      const context = currentAccountContext(stored);
      if (context && liveSocket?.readyState === WebSocket.OPEN) {
        return sendConnectionStatus(liveSocket, context);
      }
      return undefined;
    }).catch((error) => recordUnexpected("connection_status", error));
  }
});

chrome.runtime.onStartup.addListener(() => {
  void recordLog("info", "extension", "started", "Extension service worker started.");
  void resumeLogUpload();
  void ensureLiveConnection();
  void exclusive(() => attemptDelivery({ resetBackoff: false }));
});
void recordLog("info", "extension", "loaded", "Extension service worker loaded.");
void resumeLogUpload();
void ensureLiveConnection();

async function detectOpenShopeeAccount() {
  let tab = await findShopeeChatTab();
  if (!tab) {
    await recordLog("warn", "account", "tab_missing", "Shopee Seller Chat tab was not found.");
    return { ok: false, error: "Open Shopee Seller Chat to detect the Shop ID." };
  }
  await recordLog("info", "account", "detection_started", "Detecting Shopee account.");
  await ensureShopeeBridge(tab.id);
  const result = await chrome.tabs.sendMessage(tab.id, { type: "detect_account" });
  await recordLog(
    result?.ok ? "info" : "warn",
    "account",
    result?.ok ? "detected" : "detection_failed",
    result?.ok ? "Shopee account detected." : "Shopee account was not detected.",
    result?.ok ? {} : diagnosticErrorDetails(result?.error),
  );
  return result;
}

async function findShopeeChatTab() {
  const tabs = await chrome.tabs.query({ url: SHOPEE_URL_PATTERN });
  return tabs.find((item) => item.id && isShopeeChatUrl(item.url));
}

async function ensureShopeeBridge(tabId) {
  try {
    const result = await chrome.tabs.sendMessage(tabId, { type: "ping" });
    if (result?.ok) {
      await recordLog("debug", "provider", "content_ready", "Shopee content bridge is ready.");
      return;
    }
  } catch {
    // Reload below when an installed/reloaded extension is not attached to the existing page.
  }
  await recordLog("warn", "provider", "content_reload", "Reloading Shopee Seller Chat to attach the bridge.");
  await chrome.tabs.reload(tabId);
  await waitForShopeeBridge(tabId);
  await recordLog("info", "provider", "content_attached", "Shopee content bridge attached after reload.");
}

async function waitForShopeeBridge(tabId) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const result = await chrome.tabs.sendMessage(tabId, { type: "ping" });
      if (result?.ok) return;
    } catch {
      // The page or content script is still loading.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Shopee Seller Chat did not finish loading.");
}

function syncCancelledError() {
  const error = new Error("Sync cancelled.");
  error.name = "AbortError";
  return error;
}

function throwIfSyncCancelled(signal) {
  if (signal?.aborted) throw syncCancelledError();
}

async function syncOpenShopee(control) {
  const { signal } = control.controller;
  throwIfSyncCancelled(signal);
  const tab = await findShopeeChatTab();
  if (!tab) throw new Error("Open Shopee Seller Chat to sync messages.");
  control.tabId = tab.id;
  await ensureShopeeBridge(tab.id);
  throwIfSyncCancelled(signal);
  const result = await chrome.tabs.sendMessage(tab.id, { type: "sync_now" });
  throwIfSyncCancelled(signal);
  if (!result?.ok) throw new Error(result?.error ?? "Shopee recovery failed.");
  return result;
}

function startSync(trigger = "manual") {
  if (activeSync) return activeSync;
  const control = {
    controller: new AbortController(),
    tabId: null,
  };
  activeSyncControl = control;
  activeSync = runUnifiedSync(trigger, control)
    .finally(() => {
      if (activeSyncControl === control) activeSyncControl = null;
      activeSync = null;
    });
  return activeSync;
}

async function cancelActiveSync() {
  const control = activeSyncControl;
  const running = activeSync;
  control?.controller.abort();
  const tabId = control?.tabId ?? (await findShopeeChatTab())?.id;
  let providerCancelled = false;
  if (tabId) {
    const result = await chrome.tabs.sendMessage(tabId, { type: "cancel_sync" }).catch(() => null);
    providerCancelled = result?.cancelled === true;
  }
  if (!control || !running) {
    const persistedCancelled = await clearPersistedSync();
    if (providerCancelled || persistedCancelled) {
      await recordLog("info", "sync", "cancelled", "Sync cancelled by user.");
    }
    return { cancelled: providerCancelled || persistedCancelled };
  }
  await running.catch(() => undefined);
  return { cancelled: true };
}

async function clearPersistedSync() {
  return exclusive(async () => {
    const stored = await readStorage([
      STORAGE.detectedAccount,
      STORAGE.pending,
      STORAGE.scanState,
      STORAGE.status,
    ]);
    const key = accountConfigKey(stored[STORAGE.detectedAccount]);
    if (!key) return false;
    const scanState = readAccountState(stored[STORAGE.scanState], key, null);
    const status = readAccountState(stored[STORAGE.status], key, {});
    if (!scanState?.in_progress && !["discovering", "syncing"].includes(status.state)) {
      return false;
    }
    const writes = {
      [STORAGE.status]: writeAccountState(stored[STORAGE.status], key, {
        ...status,
        state: "watching",
        phase: null,
        caught_up: false,
        sync_error: null,
        sync_error_at: null,
        completed_conversations: null,
        total_conversations: null,
        pending: readAccountState(stored[STORAGE.pending], key, []).length,
      }),
    };
    if (scanState) {
      writes[STORAGE.scanState] = writeAccountState(stored[STORAGE.scanState], key, {
        ...scanState,
        in_progress: false,
        cancelled_at: new Date().toISOString(),
      });
    }
    await writeStorage(writes);
    return true;
  });
}

async function runUnifiedSync(trigger, control) {
  const { signal } = control.controller;
  const automatic = trigger === "automatic";
  const prepared = await exclusive(async () => {
    throwIfSyncCancelled(signal);
    const { context, state, stored } = await getAccountScanState();
    const lastAutoAt = Date.parse(state.last_auto_at ?? "");
    if (automatic
      && !state.in_progress
      && Number.isFinite(lastAutoAt)
      && Date.now() - lastAutoAt < RESUME_SYNC_COOLDOWN_MS) {
      return { skipped: "cooldown" };
    }
    const startedAt = new Date().toISOString();
    await writeAccountScanState(context, {
      ...state,
      in_progress: true,
      started_at: startedAt,
      ...(automatic ? { last_auto_at: startedAt } : {}),
    }, stored[STORAGE.scanState]);
    await updateScopedState(STORAGE.status, context.key, {
      state: "discovering",
      phase: "preparing",
      caught_up: false,
      sync_error: null,
      sync_error_at: null,
      completed_conversations: null,
      total_conversations: null,
    });
    return { context };
  });
  if (prepared.skipped) {
    await recordLog("debug", "sync", "skipped", "Automatic sync skipped during cooldown.", {
      reason: prepared.skipped,
    });
    return prepared;
  }
  await recordLog("info", "sync", "started", "Sync started.", { trigger });

  try {
    throwIfSyncCancelled(signal);
    await updateScopedState(STORAGE.status, prepared.context.key, {
      phase: "sending_pending",
    });
    await recordLog("debug", "delivery", "pre_sync_flush", "Checking queued messages before recovery.");
    await exclusive(() => attemptDelivery({ resetBackoff: true, signal }));
    throwIfSyncCancelled(signal);
    await updateScopedState(STORAGE.status, prepared.context.key, {
      phase: "loading_conversations",
    });
    await recordLog("info", "sync", "provider_recovery", "Requesting missed messages from Shopee.");
    const recovered = await syncOpenShopee(control);
    throwIfSyncCancelled(signal);
    await exclusive(async () => {
      const { context, state, stored } = await getAccountScanState();
      await writeAccountScanState(context, {
        ...state,
        watermark: recovered.watermark ?? state.watermark,
        bootstrap: null,
        in_progress: false,
        completed_at: new Date().toISOString(),
      }, stored[STORAGE.scanState]);
    });
    await updateScopedState(STORAGE.status, prepared.context.key, {
      state: "discovering",
      phase: "sending_recovered",
      completed_conversations: null,
      total_conversations: null,
    });
    const delivered = await exclusive(() => attemptDelivery({ resetBackoff: true, signal }));
    throwIfSyncCancelled(signal);
    const result = {
      recovered: recovered.recovered ?? 0,
      queued: recovered.queued ?? 0,
      sent: delivered.sent,
      pending: delivered.pending,
    };
    const syncedAt = new Date().toISOString();
    await updateScopedState(STORAGE.status, prepared.context.key, {
      state: "watching",
      phase: null,
      last_sync_at: syncedAt,
      caught_up: result.pending === 0,
      sync_error: null,
      sync_error_at: null,
      completed_conversations: null,
      total_conversations: null,
      last_result: result,
    });
    await recordLog("info", "sync", "completed", "Sync completed.", result);
    return result;
  } catch (error) {
    const cancelled = signal.aborted || error?.name === "AbortError";
    const message = cancelled
      ? "Sync cancelled."
      : error instanceof Error ? error.message : String(error);
    const stored = await readStorage([STORAGE.pending, STORAGE.scanState]);
    const pending = readAccountState(stored[STORAGE.pending], prepared.context.key, []);
    const state = readAccountState(stored[STORAGE.scanState], prepared.context.key, null);
    if (state) {
      await writeAccountScanState(prepared.context, {
        ...state,
        in_progress: false,
        ...(cancelled
          ? { cancelled_at: new Date().toISOString() }
          : { failed_at: new Date().toISOString() }),
      }, stored[STORAGE.scanState]);
    }
    await updateScopedState(STORAGE.status, prepared.context.key, {
      state: cancelled ? "watching" : "error",
      phase: null,
      caught_up: false,
      sync_error: cancelled ? null : message,
      sync_error_at: cancelled ? null : new Date().toISOString(),
      completed_conversations: null,
      total_conversations: null,
      pending: pending.length,
    });
    if (cancelled) {
      await recordLog("info", "sync", "cancelled", "Sync cancelled by user.");
      throw syncCancelledError();
    }
    await recordUnexpected("message_sync", error);
    throw error;
  }
}

async function resumeSync() {
  if (activeSync) return activeSync;
  const stored = await readStorage([STORAGE.serverInitialized]);
  if (!hasServerInitialized(stored)) return { skipped: "not_initialized" };
  try {
    return await startSync("automatic");
  } catch (error) {
    if (String(error).includes("not configured")) return { skipped: "not_configured" };
    throw error;
  }
}

function messageKey(message) {
  return `${message.provider}:${message.conversation_id}:${message.id}`;
}

async function queueMessages(messages, shouldFlush, advanceCursor = true) {
  const stored = await readStorage([
    STORAGE.config,
    STORAGE.consent,
    STORAGE.detectedAccount,
    STORAGE.pending,
    STORAGE.scanState,
    STORAGE.targetCursor,
    STORAGE.lastResumeSyncAt,
    STORAGE.serverInitialized,
    STORAGE.status,
  ]);
  const context = currentAccountContext(stored);
  if (!hasLocalConsent(stored[STORAGE.consent]) || !context) {
    await recordLog("debug", "queue", "ignored", "Captured messages were ignored because setup is incomplete.", {
      consented: hasLocalConsent(stored[STORAGE.consent]),
      configured: Boolean(context),
    });
    return { queued: 0, sent: 0, pending: 0 };
  }
  let scanState = readAccountState(stored[STORAGE.scanState], context.key, null);
  const pending = readAccountState(stored[STORAGE.pending], context.key, []);
  const migrated = scanState?.version !== 1;
  if (scanState?.version !== 1) {
    scanState = migrateScanState(
      readAccountState(stored[STORAGE.targetCursor], context.key, null),
      pending,
      readAccountState(stored[STORAGE.lastResumeSyncAt], context.key, null),
    );
  }
  const deferCursorAdvance = advanceCursor && hasScanBacklog(scanState);
  const known = new Set(pending.map(messageKey));
  const eligible = [];
  const added = [];
  for (const message of messages ?? []) {
    const cursor = scanState.conversations?.[message?.conversation_id];
    if (message?.provider !== "shopee"
      || !isAfterMessageCursor(message, cursor)) continue;
    eligible.push(message);
    if (known.has(messageKey(message))) continue;
    known.add(messageKey(message));
    added.push(message);
  }
  const writes = {};
  if (added.length) {
    writes[STORAGE.pending] = writeAccountState(
      stored[STORAGE.pending],
      context.key,
      [...pending, ...added],
    );
  }
  if (eligible.length) {
    const currentStatus = readAccountState(stored[STORAGE.status], context.key, {});
    writes[STORAGE.status] = writeAccountState(
      stored[STORAGE.status],
      context.key,
      {
        ...currentStatus,
        last_capture_at: new Date().toISOString(),
        pending: pending.length + added.length,
      },
    );
  }
  if (!deferCursorAdvance && advanceCursor && added.length) {
    writes[STORAGE.scanState] = writeAccountState(
      stored[STORAGE.scanState],
      context.key,
      {
        ...scanState,
        conversations: advanceConversationCursors(scanState, added),
        updated_at: new Date().toISOString(),
      },
    );
  } else if (migrated) {
    writes[STORAGE.scanState] = writeAccountState(
      stored[STORAGE.scanState],
      context.key,
      scanState,
    );
  }
  if (Object.keys(writes).length) await writeStorage(writes);
  const pendingCount = pending.length + added.length;
  const latestCursor = latestMessageCursor(eligible);
  if (!shouldFlush || !hasServerInitialized(stored)) {
    await recordLog("info", "queue", "stored", "Recovered messages stored for delivery.", {
      received: Array.isArray(messages) ? messages.length : 0,
      queued: added.length,
      pending: pendingCount,
      deferred: deferCursorAdvance,
    });
    return {
      queued: added.length,
      sent: 0,
      pending: pendingCount,
      deferred: deferCursorAdvance,
      latest_cursor: latestCursor,
    };
  }
  const delivered = await attemptDelivery({ resetBackoff: false });
  await recordLog("info", "queue", "realtime_processed", "Realtime messages processed.", {
    received: Array.isArray(messages) ? messages.length : 0,
    queued: added.length,
    sent: delivered.sent,
    pending: delivered.pending,
    deferred: deferCursorAdvance,
  });
  return {
    queued: added.length,
    deferred: deferCursorAdvance,
    ...delivered,
    latest_cursor: latestCursor,
  };
}

function batchFor(messages, installId) {
  const conversations = new Map();
  for (const message of messages) {
    const conversation = conversations.get(message.conversation_id) ?? {
      id: message.conversation_id,
      ...(message.participant ? { participants: [message.participant] } : {}),
      messages: []
    };
    if (!conversation.participants && message.participant) conversation.participants = [message.participant];
    conversation.messages.push({
      id: message.id,
      event_timestamp: message.event_timestamp,
      observed_at: message.observed_at,
      sender_id: message.sender_id,
      recipient_id: message.recipient_id,
      ...(message.sender_account_id ? { sender_account_id: message.sender_account_id } : {}),
      ...(message.recipient_account_id ? { recipient_account_id: message.recipient_account_id } : {}),
      type: message.type,
      ...(message.text ? { text: message.text } : {}),
      ...(message.media_url ? { media_url: message.media_url } : {}),
      ...(message.provider_type ? { provider_type: message.provider_type } : {}),
      ...(message.command_id ? { command_id: message.command_id } : {}),
      ...(message.client_message_id ? { client_message_id: message.client_message_id } : {}),
      ...(message.product ? { product: message.product } : {}),
      capture_method: message.capture_method
    });
    conversations.set(message.conversation_id, conversation);
  }
  return {
    schema: "omnichat.message_batch",
    version: 1,
    batch_id: crypto.randomUUID(),
    installation_id: installId,
    provider: "shopee",
    extension_version: chrome.runtime.getManifest().version,
    adapter_version: "shopee-realtime-2",
    conversations: [...conversations.values()]
  };
}

function selectBatchMessages(pending) {
  const conversationCounts = new Map();
  const selected = [];
  for (const message of pending) {
    const count = conversationCounts.get(message.conversation_id) ?? 0;
    if (count >= MAX_MESSAGES_PER_CONVERSATION) continue;
    if (!conversationCounts.has(message.conversation_id)
      && conversationCounts.size >= MAX_BATCH_CONVERSATIONS) continue;
    conversationCounts.set(message.conversation_id, count + 1);
    selected.push(message);
    if (selected.length >= MAX_BATCH_MESSAGES) break;
  }
  return selected;
}

async function signedRequest(config, providerAccountId, payload, signal) {
  const url = new URL(config.events_url);
  if (url.protocol !== "https:") throw new Error("Target server must use HTTPS.");
  const body = JSON.stringify(payload);
  const timestamp = new Date().toISOString();
  const nonce = crypto.randomUUID();
  const bodyHash = await sha256Hex(body);
  const signature = await hmacHex(config.hmac_secret, `POST\n${url.pathname}\n${timestamp}\n${nonce}\n${bodyHash}`);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-omnichat-provider-account-id": providerAccountId,
      "x-omnichat-timestamp": timestamp,
      "x-omnichat-nonce": nonce,
      "x-omnichat-signature": signature
    },
    body,
    signal,
  });
  if (!response.ok) {
    let code = "";
    try {
      const error = await response.json();
      if (typeof error?.error === "string") code = `: ${error.error}`;
    } catch {
      // The HTTP status remains actionable when the target has no JSON error body.
    }
    throw new Error(`Target server returned ${response.status}${code}`);
  }
  return response.json();
}

async function sendLogBatch(context, logs) {
  const url = new URL(context.config.logs_url);
  if (url.protocol !== "https:") throw new Error("Logs server must use HTTPS.");
  const payload = {
    schema: "omnichat.log_batch",
    version: 1,
    batch_id: crypto.randomUUID(),
    installation_id: await installationId(),
    provider: context.account.provider,
    provider_account_id: context.account.provider_account_id,
    extension_version: chrome.runtime.getManifest().version,
    sent_at: new Date().toISOString(),
    logs: logs.map(logEntryForUpload),
  };
  const body = JSON.stringify(payload);
  const timestamp = new Date().toISOString();
  const nonce = crypto.randomUUID();
  const signature = await hmacHex(
    context.config.hmac_secret,
    `POST\n${url.pathname}\n${timestamp}\n${nonce}\n${await sha256Hex(body)}`,
  );
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-omnichat-provider-account-id": context.account.provider_account_id,
      "x-omnichat-timestamp": timestamp,
      "x-omnichat-nonce": nonce,
      "x-omnichat-signature": signature,
    },
    body,
  });
  if (!response.ok) throw new Error(`Logs server returned ${response.status}.`);
  return payload.batch_id;
}

async function flushLogBatch() {
  await logMutationQueue;
  const stored = await readStorage([
    STORAGE.logs,
    STORAGE.logOutbox,
    STORAGE.config,
    STORAGE.detectedAccount,
    STORAGE.consent,
    STORAGE.serverInitialized,
    STORAGE.logUploadEnabled,
  ]);
  const context = currentAccountContext(stored);
  if (!hasLocalConsent(stored[STORAGE.consent])
    || !hasServerInitialized(stored)
    || stored[STORAGE.logUploadEnabled] !== true
    || !context?.config.logs_url) return;
  const queuedIds = new Set(Array.isArray(stored[STORAGE.logOutbox]) ? stored[STORAGE.logOutbox] : []);
  const selected = pruneLogs(stored[STORAGE.logs])
    .filter((entry) => entry.account_key === context.key && queuedIds.has(entry.id))
    .reverse()
    .slice(0, MAX_LOG_UPLOAD_BATCH);
  if (!selected.length) return;

  try {
    await sendLogBatch(context, selected);
    const deliveredIds = new Set(selected.map((entry) => entry.id));
    let remaining = 0;
    await mutateLogs(async () => {
      const current = await readStorage([STORAGE.logOutbox]);
      const outbox = (Array.isArray(current[STORAGE.logOutbox]) ? current[STORAGE.logOutbox] : [])
        .filter((id) => !deliveredIds.has(id));
      remaining = outbox.length;
      await writeStorage({ [STORAGE.logOutbox]: outbox });
    });
    await recordLog("info", "logs", "uploaded", "Operational logs uploaded.", {
      count: selected.length,
    }, { remote: false });
    if (remaining) void scheduleLogUpload();
  } catch (error) {
    await recordLog("warn", "logs", "upload_failed", "Operational log upload failed.", diagnosticErrorDetails(error), {
      remote: false,
    });
    void scheduleLogUpload(5);
  }
}

async function flushBatch(signal) {
  const stored = await readStorage([
    STORAGE.config,
    STORAGE.consent,
    STORAGE.pending,
    STORAGE.detectedAccount,
    STORAGE.status,
  ]);
  const context = currentAccountContext(stored);
  const pending = readAccountState(stored[STORAGE.pending], context?.key, []);
  if (!hasLocalConsent(stored[STORAGE.consent]) || !context || !pending.length) {
    return { sent: 0, pending: pending.length };
  }
  await recordLog("debug", "delivery", "batch_preparing", "Preparing queued message batch.", {
    pending: pending.length,
  });
  let selected;
  let payload;
  try {
    const installId = await installationId();
    selected = selectBatchMessages(pending);
    if (!selected.length) return { sent: 0, pending: pending.length };
    payload = batchFor(selected, installId);
    if (JSON.stringify(payload).length > 1_000_000) throw new Error("Queued batch exceeds the 1 MiB limit.");
    const acknowledgement = await signedRequest(
      context.config,
      context.account.provider_account_id,
      payload,
      signal,
    );
    if (acknowledgement.schema !== "omnichat.message_batch_ack"
      || acknowledgement.batch_id !== payload.batch_id
      || acknowledgement.accepted_messages + acknowledgement.duplicate_messages !== selected.length) {
      throw new Error("Target server acknowledgement is invalid.");
    }
  } catch (error) {
    if (signal?.aborted) throw syncCancelledError();
    const message = error instanceof Error ? error.message : String(error);
    await updateScopedState(STORAGE.status, context.key, {
      delivery_error: message,
      delivery_error_at: new Date().toISOString(),
    });
    await recordUnexpected("message_delivery", error);
    throw error;
  }
  const deliveredKeys = new Set(selected.map(messageKey));
  const remaining = pending.filter((message) => !deliveredKeys.has(messageKey(message)));
  const currentStatus = readAccountState(stored[STORAGE.status], context.key, {});
  await writeStorage({
    [STORAGE.pending]: writeAccountState(stored[STORAGE.pending], context.key, remaining),
    [STORAGE.status]: writeAccountState(stored[STORAGE.status], context.key, {
      ...currentStatus,
      state: ["discovering", "syncing"].includes(currentStatus.state)
        ? currentStatus.state
        : "watching",
      delivery_error: null,
      delivery_error_at: null,
      last_delivery_at: new Date().toISOString(),
      pending: remaining.length,
    }),
  });
  await recordLog("info", "delivery", "batch_sent", "Message batch accepted by target server.", {
    sent: selected.length,
    pending: remaining.length,
  });
  return { sent: selected.length, pending: remaining.length };
}

async function flushAll(signal) {
  let sent = 0;
  let pending = 0;
  for (let batch = 0; batch < MAX_FLUSH_BATCHES; batch += 1) {
    throwIfSyncCancelled(signal);
    const result = await flushBatch(signal);
    sent += result.sent;
    pending = result.pending;
    if (!pending || !result.sent) break;
  }
  return { sent, pending };
}

async function resetDeliveryRetry(context) {
  await chrome.alarms.clear(DELIVERY_RETRY_ALARM);
  const stored = await readStorage([STORAGE.deliveryRetry]);
  await writeStorage({
    [STORAGE.deliveryRetry]: writeAccountState(
      stored[STORAGE.deliveryRetry],
      context.key,
      { attempt: 0, next_at: null },
    ),
  });
}

async function clearDeliveryRetry(context) {
  await resetDeliveryRetry(context);
  await updateScopedState(STORAGE.status, context.key, {
    delivery_error: null,
    delivery_error_at: null,
    pending: 0,
  });
}

async function scheduleDeliveryRetry(context) {
  const stored = await readStorage([STORAGE.deliveryRetry]);
  const current = readAccountState(stored[STORAGE.deliveryRetry], context.key, {});
  const attempt = Number(current?.attempt) || 0;
  const nextAt = Date.now() + deliveryRetryDelay(attempt);
  await writeStorage({
    [STORAGE.deliveryRetry]: writeAccountState(
      stored[STORAGE.deliveryRetry],
      context.key,
      {
        attempt: attempt + 1,
        next_at: new Date(nextAt).toISOString(),
      },
    ),
  });
  chrome.alarms.create(DELIVERY_RETRY_ALARM, { when: nextAt });
  await recordLog("warn", "delivery", "retry_scheduled", "Message delivery retry scheduled.", {
    attempt: attempt + 1,
    delay_ms: deliveryRetryDelay(attempt),
  });
}

async function attemptDelivery({ resetBackoff, signal }) {
  const stored = await readStorage([
    STORAGE.config,
    STORAGE.consent,
    STORAGE.detectedAccount,
    STORAGE.pending,
    STORAGE.serverInitialized,
  ]);
  const context = currentAccountContext(stored);
  const pending = readAccountState(stored[STORAGE.pending], context?.key, []);
  if (!hasServerInitialized(stored)
    || !hasLocalConsent(stored[STORAGE.consent])
    || !context) {
    return { sent: 0, pending: pending.length };
  }
  if (signal?.aborted) throw syncCancelledError();
  if (resetBackoff) await resetDeliveryRetry(context);
  if (!pending.length) {
    await clearDeliveryRetry(context);
    return { sent: 0, pending: 0 };
  }
  try {
    const result = await flushAll(signal);
    if (result.pending) await scheduleDeliveryRetry(context);
    else await clearDeliveryRetry(context);
    await updateScopedState(STORAGE.status, context.key, { pending: result.pending });
    return result;
  } catch (error) {
    if (signal?.aborted) throw syncCancelledError();
    await scheduleDeliveryRetry(context);
    return {
      sent: 0,
      pending: pending.length,
      delivery_error: error instanceof Error ? error.message : String(error),
    };
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === DELIVERY_RETRY_ALARM) {
    void recordLog("info", "delivery", "retry_started", "Retrying queued message delivery.");
    void exclusive(() => attemptDelivery({ resetBackoff: false }));
  } else if (alarm.name === LOG_UPLOAD_ALARM) {
    void flushLogBatch();
  }
});
