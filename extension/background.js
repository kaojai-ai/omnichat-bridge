import { hmacHex, sha256Hex } from "./lib/crypto.js";
import { accountConfigKey, accountKey, findAccountConfig } from "./lib/config.js";
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
  diagnosticErrorDetails,
  logEntryForUpload,
  pruneLogs,
} from "./lib/logs.js";
import { participantForBatch } from "./lib/message-batch.js";
import { deliverWithIsolation } from "./lib/delivery-isolation.js";
import {
  LEGACY_STORAGE,
  STORAGE,
  hasLocalConsent,
  installationId,
  mergeDetectedAccounts,
  normalizeDeviceName,
  readAccountState,
  readStorage,
  resetDetectedAccountsFromConfig,
  writeAccountState,
  writeStorage,
} from "./lib/storage.js";
import "./lib/shopee-url.js";
import "./lib/provider-adapters.js";
import "./lib/shopee-adapter.js";

const providerAdapters = globalThis.OmnichatProviderAdapters;
const shopeeAdapter = providerAdapters.get("shopee");
const DETECTED_ACCOUNTS_RESET_VERSION = "0.5.2";
const BRIDGE_PROTOCOL_VERSION = 5;
const BRIDGE_SOURCE = "omnichat-realtime-bridge-v3";
const MAX_BATCH_MESSAGES = 500;
const MAX_BATCH_CONVERSATIONS = 50;
const MAX_MESSAGES_PER_CONVERSATION = 100;
const MAX_FLUSH_BATCHES = 10;
const RESUME_SYNC_COOLDOWN_MS = 5 * 60_000;
const MAX_REPLY_TEXT_LENGTH = 2_000;
const MAX_REPLY_IMAGE_BYTES = 10 * 1024 * 1024;
const PROVIDER_SYNC_RESPONSE_TIMEOUT_MS = 90_000;
const PROVIDER_STATUS_RESPONSE_TIMEOUT_MS = 5_000;
const DELIVERY_RETRY_ALARM = "omnichat-delivery-retry";
const LOG_UPLOAD_ALARM = "omnichat-log-upload";
const MAX_LOG_UPLOAD_BATCH = 100;
const INBOUND_LOG_MESSAGES = {
  "popup.configuration_saved": "Configuration saved.",
  "popup.configuration_imported": "Configuration imported.",
  "popup.configuration_exported": "Configuration exported.",
  "popup.async_error": "Extension async operation failed.",
  "popup.uncaught_error": "Unhandled popup error.",
  "provider.content_loaded": "Provider content bridge loaded.",
  "provider.async_error": "Extension async operation failed.",
  "provider.uncaught_error": "Unhandled provider error.",
  "provider.recovery_not_configured": "Provider recovery could not start because setup is incomplete.",
  "provider.checkpoint_failed": "Could not load the sync checkpoint.",
  "provider.recovery_requested": "Provider recovery request sent.",
  "provider.account_detection_timeout": "Provider account detection timed out.",
  "provider.account_detected": "Provider account detected on provider page.",
  "provider.account_detection_failed": "Provider account detection failed.",
  "provider.recovery_batch_processed": "Recovered message page processed.",
  "provider.recovery_batch_failed": "Recovered message page failed.",
  "provider.resume_failed": "Automatic sync resume failed.",
  "provider.realtime_processed": "Realtime provider event processed.",
  "provider.recovery_failed": "Provider recovery failed.",
  "provider.recovery_timeout": "Provider recovery stopped responding.",
  "provider.recovery_completed": "Provider recovery completed.",
  "provider.socket_observed": "Provider realtime socket detected.",
  "provider.recovery_started": "Provider recovery started.",
  "provider.recovery_plan": "Provider recovery plan prepared.",
  "provider.conversation_started": "Checking one conversation for missed messages.",
  "provider.conversation_completed": "Conversation recovery check completed.",
  "provider.history_template_ready": "Provider history request template captured.",
  "provider.list_template_ready": "Provider conversation-list request template captured.",
  "provider.content_unready": "Provider content bridge is not ready. Refresh the provider tab manually before retrying.",
  "provider.seller_centre_messages_observed": "Seller Centre realtime messages observed.",
  "provider.seller_centre_conversation_parse": "Seller Centre conversation response could not be parsed.",
  "provider.seller_centre_message_poll": "Seller Centre message polling failed.",
  "provider.seller_centre_sync_response": "Seller Centre realtime polling status updated.",
  "provider.seller_centre_chat_open_started": "Seller Centre mini-chat opening started.",
  "provider.seller_centre_chat_opened": "Seller Centre mini-chat opened before sync.",
  "provider.seller_centre_chat_open_failed": "Seller Centre mini-chat could not be opened.",
  "provider.surface_unready": "Provider chat surface is not ready for commands.",
  "provider.socket_connected": "Provider realtime socket connected.",
  "provider.bridge_reinjected": "Provider content bridge was reattached without refreshing the page.",
};
let mutationQueue = Promise.resolve();
let logMutationQueue = Promise.resolve();
let activeSync = null;
let activeSyncControl = null;
const liveConnections = new Map();
const providerBridgeReinjections = new Map();

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
        STORAGE.detectedAccounts,
      ]);
      const context = accountContextFor(stored, details?.provider_account_id, details?.provider);
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

async function recordUnexpected(scope, error, details = {}) {
  await recordLog("error", scope, "failed", "Extension operation failed.", {
    ...diagnosticErrorDetails(error),
    ...details,
  });
}

function registerGlobalErrorHandlers() {
  if (typeof globalThis.addEventListener !== "function") return;
  globalThis.addEventListener("error", (event) => {
    void recordUnexpected("runtime", event?.error ?? event?.message ?? "Unhandled runtime error.", {
      error_kind: "error_event",
    });
  });
  globalThis.addEventListener("unhandledrejection", (event) => {
    void recordUnexpected("runtime", event?.reason ?? "Unhandled promise rejection.", {
      error_kind: "unhandled_rejection",
    });
  });
}

registerGlobalErrorHandlers();

function detectedAccounts(stored) {
  return Array.isArray(stored[STORAGE.detectedAccounts])
    ? stored[STORAGE.detectedAccounts]
      .filter((account) => providerAdapterForAccount(account) && messageProviderAccountId(account))
      .map((account) => ({
        ...account,
        provider: normalizedProviderId(account.provider),
        provider_account_id: messageProviderAccountId(account),
      }))
    : [];
}

function normalizedProviderId(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function providerAdapterForId(value) {
  const provider = normalizedProviderId(value);
  return provider ? providerAdapters.get(provider) : null;
}

function providerAdapterForAccount(account) {
  return providerAdapterForId(account?.provider);
}

function providerLabel(adapter) {
  return adapter?.displayName || adapter?.id || "Provider";
}

function messageProvider(message) {
  if (Object.hasOwn(message ?? {}, "provider")) return normalizedProviderId(message.provider);
  return shopeeAdapter.id;
}

function accountContextFor(stored, providerAccountId, provider = "") {
  const id = typeof providerAccountId === "string" || typeof providerAccountId === "number"
    ? String(providerAccountId).trim()
    : "";
  const providerId = normalizedProviderId(provider);
  if (!id) return null;
  const matches = detectedAccounts(stored).filter((item) => item.provider_account_id === id
    && (!providerId || item.provider === providerId));
  if (matches.length !== 1) return null;
  const account = matches[0];
  const config = findAccountConfig(stored[STORAGE.config], account);
  if (!account) return null;
  const key = accountConfigKey(account);
  const adapter = providerAdapterForAccount(account);
  return key && config && adapter ? { key, config, account, adapter } : null;
}

function configuredAccountContexts(stored) {
  return detectedAccounts(stored)
    .map((account) => accountContextFor(stored, account.provider_account_id, account.provider))
    .filter(Boolean);
}

function messageProviderAccountId(message) {
  const value = message?.provider_account_id;
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
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

async function getAccountScanState(providerAccountId, provider = "") {
  const stored = await readStorage([
    STORAGE.config,
    STORAGE.consent,
    STORAGE.detectedAccounts,
    STORAGE.pending,
    STORAGE.scanState,
    STORAGE.targetCursor,
    STORAGE.lastResumeSyncAt,
  ]);
  const context = accountContextFor(stored, providerAccountId, provider);
  if (!hasLocalConsent(stored[STORAGE.consent]) || !context) {
    throw new Error("Provider browser bridge is not configured.");
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

async function saveBootstrapSelection(providerAccountId, conversations, provider = "") {
  const { context, state, stored } = await getAccountScanState(providerAccountId, provider);
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

async function advanceScanCursor(providerAccountId, conversationId, cursor, summaryToken, provider = "") {
  const id = String(conversationId ?? "").trim();
  if (!id) return;
  const { context, state, stored } = await getAccountScanState(providerAccountId, provider);
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
  if (message?.type === "accounts_detected") {
    void exclusive(async () => {
      const provider = normalizedProviderId(message.provider);
      const adapter = providerAdapterForId(provider);
      if (!adapter?.supports("account_detection")) {
        throw new Error(`Unsupported provider account detection: ${provider || "<unknown>"}.`);
      }
      const accounts = Array.isArray(message.accounts) ? message.accounts : [];
      if (!accounts.length || accounts.some((account) => account?.provider !== provider)) {
        throw new Error("Detected provider accounts are invalid.");
      }
      const stored = await readStorage([STORAGE.consent, STORAGE.detectedAccounts]);
      if (!hasLocalConsent(stored[STORAGE.consent])) {
        throw new Error("Provider browser bridge is not configured.");
      }
      const detectedAccounts = mergeDetectedAccounts(stored[STORAGE.detectedAccounts], accounts);
      await writeStorage({ [STORAGE.detectedAccounts]: detectedAccounts });
      return { accounts: detectedAccounts };
    }).then(
      (result) => respond({ ok: true, ...result }),
      (error) => respond({ ok: false, error: String(error) }),
    );
    return true;
  }
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
    void exclusive(() => getAccountScanState(message.provider_account_id, message.provider)).then(
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
    void exclusive(() => attemptAllDeliveries({ resetBackoff: true })).then(
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
    void exclusive(() => readStorage([STORAGE.detectedAccounts, STORAGE.status]).then((stored) => {
      const context = accountContextFor(stored, message.provider_account_id, message.provider);
      const key = context?.key;
      if (!key) throw new Error("Provider account is not detected.");
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
        provider: message.provider,
        provider_account_id: message.provider_account_id,
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
      provider: message.provider,
      provider_account_id: message.provider_account_id,
    };
    void recordLog("info", "sync", "plan_created", "Sync plan created.", details).then(
      () => respond({ ok: true }),
      (error) => respond({ ok: false, error: String(error) })
    );
    return true;
  }
  if (message?.type === "advance_scan_cursor") {
    void exclusive(() => advanceScanCursor(
      message.provider_account_id,
      message.conversation_id,
      message.cursor,
      message.summary_token,
      message.provider,
    )).then(
      () => respond({ ok: true }),
      (error) => respond({ ok: false, error: String(error) })
    );
    return true;
  }
  if (message?.type === "save_bootstrap") {
    void exclusive(() => saveBootstrapSelection(
      message.provider_account_id,
      message.conversations,
      message.provider,
    )).then(
      () => respond({ ok: true }),
      (error) => respond({ ok: false, error: String(error) })
    );
    return true;
  }
  if (message?.type === "detect_account") {
    void detectOpenProviderAccount(message?.provider || shopeeAdapter.id).then(
      (result) => respond(result),
      (error) => respond({ ok: false, error: String(error) })
    );
    return true;
  }
  if (providerAdapterForCommand(message)?.supportsSend(message?.type)) {
    void sendViaProvider(message).then(
      (result) => respond(result),
      async (error) => {
        await recordUnexpected("send_message", error, {
          provider_account_id: messageProviderAccountId(message),
        });
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

async function commandTab(context, { createIfMissing = false, prepareForSend = false } = {}) {
  const adapter = context?.adapter ?? providerAdapterForAccount(context?.account);
  if (!adapter) throw new Error("Provider adapter is unavailable.");
  const label = providerLabel(adapter);
  const stored = await readStorage([STORAGE.commandTab]);
  const tabId = readAccountState(stored[STORAGE.commandTab], context.key, null);
  const tabs = await providerChatTabs(adapter);
  const selectedTab = Number.isInteger(tabId)
    ? tabs.find((tab) => tab.id === tabId) ?? null
    : null;
  const orderedTabs = orderProviderTabs(adapter, tabs, tabId);
  if (prepareForSend && adapter.id === "shopee") {
    for (const candidate of orderedTabs.filter((tab) => adapter.surfaceForUrl?.(tab.url) === "seller-centre")) {
      if (await isReadyProviderTab(candidate, adapter)) continue;
      try {
        await prepareProviderTab(candidate, adapter);
      } catch (error) {
        await recordLog("warn", "provider", "surface_unready", `${label} Seller Centre could not be prepared for an outbound reply.`, {
          provider: adapter.id,
          surface: "seller-centre",
          ...diagnosticErrorDetails(error),
        });
      }
    }
  }
  let tab = null;
  for (const candidate of orderedTabs) {
    if (await isReadyProviderTab(candidate, adapter)) {
      tab = candidate;
      break;
    }
  }
  if (!tab) tab = orderedTabs[0] ?? selectedTab ?? null;
  if (!tab && createIfMissing && typeof adapter.chatUrl === "string" && adapter.chatUrl.trim()) {
    tab = await chrome.tabs.create({ url: adapter.chatUrl, active: false });
  }
  if (!tab?.id) {
    await recordLog("warn", "provider", "tab_missing", `${label} chat tab is unavailable for an outbound reply.`, {
      provider: adapter.id,
      provider_account_id: context.account.provider_account_id,
    });
    throw new Error(`Open ${label} in Chrome before sending a reply.`);
  }
  if (!(await isReadyProviderTab(tab, adapter))) {
    await recordLog("warn", "provider", "surface_unready", `${label} chat surface is not ready for commands.`, {
      provider: adapter.id,
      surface: adapter.surfaceForUrl?.(tab.url) ?? null,
    });
  }
  await writeStorage({ [STORAGE.commandTab]: writeAccountState(stored[STORAGE.commandTab], context.key, tab.id) });
  return tab;
}

function providerAdapterForCommand(message) {
  return providerAdapterForId(messageProvider(message));
}

async function sendViaProvider(message) {
  const adapter = providerAdapterForCommand(message);
  if (!adapter?.supportsSend(message?.type)) return { ok: false, error: "Unsupported provider reply command." };
  const requestId = typeof message?.request_id === "string" ? message.request_id : "";
  const conversationId = typeof message?.conversation_id === "string" ? message.conversation_id : "";
  const clientMessageId = typeof message?.client_message_id === "string" ? message.client_message_id : "";
  const commandType = typeof message?.type === "string" ? message.type : "";
  if (!requestId || !conversationId || !adapter.supportsSend(commandType)) {
    return { ok: false, error: "Reply command is invalid." };
  }
  const stored = await readStorage([STORAGE.config, STORAGE.detectedAccounts]);
  const context = accountContextFor(stored, messageProviderAccountId(message), adapter.id);
  if (!context) return { ok: false, error: `${providerLabel(adapter)} browser bridge is not configured.` };
  const tab = await commandTab(context, { createIfMissing: false, prepareForSend: true });
  await ensureProviderBridge(tab.id, adapter);
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
    provider: adapter.id,
    type: "send_api_v3",
    command_type: commandType,
    request_id: requestId,
    conversation_id: conversationId,
    ...(clientMessageId ? { client_message_id: clientMessageId } : {}),
  });
}

async function selectCommandTab(context, tabId) {
  if (!Number.isInteger(tabId)) return;
  const adapter = context?.adapter ?? providerAdapterForAccount(context?.account);
  const tab = await chrome.tabs.get(tabId);
  if (!Number.isInteger(tab.id) || !adapter?.matchesUrl(tab.url)) {
    throw new Error(`Open ${providerLabel(adapter)} chat in this tab first.`);
  }
  const stored = await readStorage([STORAGE.commandTab]);
  await writeStorage({ [STORAGE.commandTab]: writeAccountState(stored[STORAGE.commandTab], context.key, tab.id) });
}

// WIP alternative only. Do not call this from the command path: it needs the target
// conversation open and competes with the user's provider UI.
async function sendTextByUiClick_WIP(message) {
  const stored = await readStorage([STORAGE.config, STORAGE.detectedAccounts]);
  const adapter = providerAdapterForCommand(message);
  const context = accountContextFor(stored, messageProviderAccountId(message), adapter?.id);
  if (!context) return { ok: false, error: `${providerLabel(adapter)} browser bridge is not configured.` };
  const tab = await commandTab(context, { createIfMissing: false, prepareForSend: true });
  await ensureProviderBridge(tab.id, context.adapter);
  return chrome.tabs.sendMessage(tab.id, { ...message, type: "send_text_ui_click_wip_v3" });
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

async function signedLeaderRequest(context, action) {
  if (!context) throw new Error("Provider browser bridge is not configured.");
  const initialized = await readStorage([STORAGE.serverInitialized]);
  if (!hasServerInitialized(initialized)) throw new Error("Sync messages before using live replies.");
  const url = leaderEndpoint(context.config);
  if (!context || !url) throw new Error("Leader endpoint is not configured.");
  const body = JSON.stringify({
    provider: context.account.provider,
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
  const connection = liveConnections.get(context.key);
  await updateLiveState(context, {
    socket: connection?.socket?.readyState === WebSocket.OPEN ? "connected" : "connecting",
    leader: result?.leader_installation_id === await installationId(),
    leader_installation_id: result?.leader_installation_id ?? null,
  });
  return { ok: true, ...result };
}

async function getLiveState(providerAccountId, provider = "") {
  const stored = await readStorage([STORAGE.config, STORAGE.detectedAccounts, STORAGE.serverInitialized]);
  const contexts = providerAccountId
    ? [accountContextFor(stored, providerAccountId, provider)].filter(Boolean)
    : configuredAccountContexts(stored);
  if (!contexts.length) return { ok: false, error: "No configured provider accounts are detected." };
  const results = [];
  for (const context of contexts) {
    try {
      results.push(await signedLeaderRequest(context, "status"));
    } catch (error) {
      const connection = liveConnections.get(context.key);
      await updateLiveState(context, {
        socket: connection?.socket?.readyState === WebSocket.OPEN ? "connected" : "reconnecting",
        leader: false,
      });
      if (providerAccountId) throw error;
      results.push({
        ok: false,
        provider: context.account.provider,
        provider_account_id: context.account.provider_account_id,
        error: String(error),
      });
    }
  }
  if (providerAccountId) return results[0];
  return {
    ok: results.some((result) => result.ok),
    leader: results.some((result) => result.leader),
    accounts: results,
  };
}

async function claimLeader(tabId) {
  const stored = await readStorage([STORAGE.config, STORAGE.detectedAccounts]);
  const contexts = configuredAccountContexts(stored);
  if (!contexts.length) throw new Error("Provider browser bridge is not configured.");
  const results = [];
  for (const context of contexts) {
    await selectCommandTab(context, tabId);
    results.push(await signedLeaderRequest(context, "claim"));
  }
  return results.at(-1) ?? { ok: true };
}

async function releaseLeader() {
  const stored = await readStorage([STORAGE.config, STORAGE.detectedAccounts]);
  const contexts = configuredAccountContexts(stored);
  if (!contexts.length) throw new Error("Provider browser bridge is not configured.");
  const results = [];
  for (const context of contexts) results.push(await signedLeaderRequest(context, "release"));
  return results.at(-1) ?? { ok: true };
}

async function openCommandTab() {
  const stored = await readStorage([STORAGE.config, STORAGE.detectedAccounts]);
  const context = configuredAccountContexts(stored)[0];
  if (!context) throw new Error("Provider browser bridge is not configured.");
  const tab = await commandTab(context, { createIfMissing: true });
  if (!tab.id) throw new Error(`${providerLabel(context.adapter)} chat tab is unavailable.`);
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  return { ok: true };
}

function stopLiveConnection() {
  for (const connection of liveConnections.values()) {
    clearTimeout(connection.reconnectTimer);
    clearInterval(connection.heartbeatTimer);
    connection.socket?.close();
  }
  liveConnections.clear();
}

function scheduleLiveReconnect(context) {
  const connection = liveConnections.get(context.key);
  if (!connection) return;
  clearTimeout(connection.reconnectTimer);
  const delay = Math.min(60_000, 1_000 * 2 ** Math.min(connection.reconnectAttempt, 6));
  connection.reconnectAttempt += 1;
  connection.reconnectTimer = setTimeout(() => { void ensureAccountLiveConnection(context); }, delay);
}

async function signedLiveTicket(context) {
  const { config, account } = context;
  const url = liveEndpoint(config);
  if (!url) throw new Error("Live reply endpoint is not configured.");
  const body = JSON.stringify({
    provider: account.provider,
    provider_account_id: account.provider_account_id,
    installation_id: await installationId(),
  });
  const timestamp = new Date().toISOString();
  const nonce = crypto.randomUUID();
  const bodyHash = await sha256Hex(body);
  const signature = await hmacHex(config.hmac_secret, `POST\n${url.pathname}\n${timestamp}\n${nonce}\n${bodyHash}`);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-omnichat-provider-account-id": account.provider_account_id,
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
    STORAGE.detectedAccounts,
    STORAGE.pending,
    STORAGE.status,
  ]);
  const adapter = context.adapter ?? providerAdapterForAccount(context.account);
  const tabs = adapter
    ? (await chrome.tabs.query({ url: adapter.tabQueryPattern }))
      .filter((tab) => adapter.matchesUrl(tab.url))
    : [];
  let providerStatus = null;
  for (const tab of orderProviderTabs(adapter, tabs)) {
    if (!tab.id) continue;
    const result = await providerTabStatus(tab);
    if (!result) continue;
    providerStatus ??= result;
    if (providerTabIsReady(result, adapter)) {
      providerStatus = result;
      break;
    }
  }

  const accountDetected = detectedAccounts(stored).some(
    (account) => account.provider === context.account.provider
      && account.provider_account_id === context.account.provider_account_id,
  );
  const accountMatches = accountDetected;
  const status = readAccountState(stored[STORAGE.status], context.key, {});
  const pending = readAccountState(stored[STORAGE.pending], context.key, []);
  const deviceName = normalizeDeviceName(stored[STORAGE.deviceName]);
  const health = buildConnectionHealth({
    provider: context.account.provider,
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
    STORAGE.detectedAccounts,
    STORAGE.serverInitialized,
  ]);
  const contexts = configuredAccountContexts(stored);
  if (!hasServerInitialized(stored)
    || !hasLocalConsent(stored[STORAGE.consent])
    || !contexts.length) {
    stopLiveConnection();
    void recordLog("debug", "live", "not_started", "Live connection is not ready.", {
      consented: hasLocalConsent(stored[STORAGE.consent]),
      configured: contexts.length > 0,
    });
    return;
  }
  const contextKeys = new Set(contexts.map((context) => context.key));
  for (const [key, connection] of liveConnections) {
    if (contextKeys.has(key)) continue;
    clearTimeout(connection.reconnectTimer);
    clearInterval(connection.heartbeatTimer);
    connection.socket?.close();
    liveConnections.delete(key);
  }
  for (const context of contexts) await ensureAccountLiveConnection(context);
}

async function ensureAccountLiveConnection(context) {
  const endpoint = liveEndpoint(context.config);
  if (!endpoint) return;
  const existing = liveConnections.get(context.key) ?? {
    socket: null,
    reconnectTimer: null,
    heartbeatTimer: null,
    reconnectAttempt: 0,
  };
  liveConnections.set(context.key, existing);
  if (existing.socket?.readyState === WebSocket.OPEN) {
    void sendConnectionStatus(existing.socket, context).catch((error) => recordUnexpected("connection_status", error, {
      provider_account_id: context.account.provider_account_id,
    }));
    return;
  }
  if (existing.socket?.readyState === WebSocket.CONNECTING) return;
  clearTimeout(existing.reconnectTimer);
  existing.reconnectTimer = null;
  await updateLiveState(context, { socket: "connecting" });
  await recordLog("info", "live", "connecting", "Connecting live command channel.", {
    provider_account_id: context.account.provider_account_id,
  });
  try {
    const { ticket, socketUrl } = await signedLiveTicket(context);
    socketUrl.searchParams.set("ticket", ticket);
    const socket = new WebSocket(socketUrl);
    existing.socket = socket;
    socket.addEventListener("open", () => {
      existing.reconnectAttempt = 0;
      void updateLiveState(context, { socket: "connected" });
      void recordLog("info", "live", "connected", "Live command channel connected.", {
        provider_account_id: context.account.provider_account_id,
      });
      clearInterval(existing.heartbeatTimer);
      existing.heartbeatTimer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          void sendConnectionStatus(socket, context)
            .catch((error) => recordUnexpected("connection_status", error, {
              provider_account_id: context.account.provider_account_id,
            }));
        }
      }, 20_000);
      void sendConnectionStatus(socket, context)
        .catch((error) => recordUnexpected("connection_status", error, {
          provider_account_id: context.account.provider_account_id,
        }));
      void getLiveState(context.account.provider_account_id, context.account.provider).catch((error) => recordUnexpected("leader_status", error, {
        provider: context.account.provider,
        provider_account_id: context.account.provider_account_id,
      }));
    });
    socket.addEventListener("message", (event) => { void handleLiveCommand(event.data, context, socket); });
    socket.addEventListener("close", () => {
      if (liveConnections.get(context.key)?.socket === socket) {
        existing.socket = null;
        clearInterval(existing.heartbeatTimer);
        existing.heartbeatTimer = null;
        void updateLiveState(context, { socket: "reconnecting", leader: false });
        void recordLog("warn", "live", "disconnected", "Live command channel disconnected.", {
          provider_account_id: context.account.provider_account_id,
          reconnect_attempt: existing.reconnectAttempt + 1,
        });
        scheduleLiveReconnect(context);
      }
    });
    socket.addEventListener("error", () => socket.close());
  } catch (error) {
    await updateLiveState(context, { socket: "reconnecting" });
    await recordUnexpected("live_connection", error, {
      provider_account_id: context.account.provider_account_id,
    });
    scheduleLiveReconnect(context);
  }
}

async function handleLiveCommand(raw, context, socket) {
  let command;
  try { command = JSON.parse(raw); } catch { return; }
  const adapter = providerAdapterForCommand(command);
  if (!adapter?.supportsSend(command?.type) || adapter.id !== context.account.provider) return;
  if (messageProviderAccountId(command) !== context.account.provider_account_id) return;
  let result;
  try {
    result = await exclusive(() => sendViaProvider(command));
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!result?.ok) await recordUnexpected("live_command", result?.error ?? "Reply failed.", {
    provider_account_id: context.account.provider_account_id,
  });
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({
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
  if (changes[STORAGE.config] || changes[STORAGE.consent] || changes[STORAGE.detectedAccounts]) void ensureLiveConnection();
  if (
    changes[STORAGE.deviceName]
    || changes[STORAGE.detectedAccounts]
    || changes[STORAGE.status]
    || changes[STORAGE.pending]
  ) {
    void ensureLiveConnection().then(() => {
      return undefined;
    }).catch((error) => recordUnexpected("connection_status", error));
  }
});

chrome.runtime.onStartup.addListener(() => {
  void recordLog("info", "extension", "started", "Extension service worker started.");
  void resumeLogUpload();
  void ensureLiveConnection();
  void reattachOpenProviderBridges().catch((error) => recordUnexpected("provider_bridge_startup", error));
  void exclusive(() => attemptAllDeliveries({ resetBackoff: false }));
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason !== "update" || !isVersionBefore(details.previousVersion, DETECTED_ACCOUNTS_RESET_VERSION)) return;
  void reinitializeAfterUpgrade().catch((error) => {
    void recordUnexpected("storage_upgrade", error);
  });
});

void recordLog("info", "extension", "loaded", "Extension service worker loaded.");
void resumeLogUpload();
void ensureLiveConnection();
void reattachOpenProviderBridges().catch((error) => recordUnexpected("provider_bridge_startup", error));
void resumeInterruptedSync().catch((error) => recordUnexpected("sync_resume", error));

function isVersionBefore(value, target) {
  const current = String(value ?? "").split(".").map(Number);
  const expected = String(target).split(".").map(Number);
  if (current.length !== expected.length || current.some((part) => !Number.isInteger(part))) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (current[index] !== expected[index]) return current[index] < expected[index];
  }
  return false;
}

async function reinitializeAfterUpgrade() {
  if (!await resetDetectedAccountsFromConfig()) return;
  let bridgesReady = true;
  for (const adapter of providerAdapters.list()) {
    if (!adapter.supports("account_detection")) continue;
    const tabs = await chrome.tabs.query(
      adapter.tabQueryPattern ? { url: adapter.tabQueryPattern } : {},
    );
    const chatTabs = tabs.filter((tab) => tab.id && adapter.matchesUrl(tab.url));
    for (const tab of chatTabs) {
      try {
        await ensureProviderBridge(tab.id, adapter);
        const result = await chrome.tabs.sendMessage(tab.id, {
          type: "detect_account_v3",
          provider: adapter.id,
        });
        if (!result?.ok) {
          await recordLog("warn", "account", "detection_failed", `${providerLabel(adapter)} account was not detected after extension upgrade.`, {
            provider: adapter.id,
          });
        }
      } catch (error) {
        bridgesReady = false;
        await recordUnexpected("storage_upgrade", error, { provider: adapter.id });
      }
    }
  }
  if (bridgesReady) await chrome.storage.local.remove(LEGACY_STORAGE.detectedAccount);
}

async function detectOpenProviderAccount(provider = shopeeAdapter.id) {
  const adapter = providerAdapterForId(provider);
  if (!adapter) return { ok: false, error: `Unsupported provider: ${provider}.` };
  if (!adapter.supports("account_detection")) {
    return { ok: false, error: `${providerLabel(adapter)} does not support account detection.` };
  }
  const label = providerLabel(adapter);
  const tab = await findReadyProviderChatTab(adapter) ?? await findProviderChatTab(adapter);
  if (!tab) {
    await recordLog("warn", "account", "tab_missing", `${label} tab was not found.`, { provider: adapter.id });
    return { ok: false, error: `Open ${label} to detect the account ID.` };
  }
  await recordLog("info", "account", "detection_started", `Detecting ${label} account.`, { provider: adapter.id });
  await ensureProviderBridge(tab.id, adapter);
  const result = await chrome.tabs.sendMessage(tab.id, {
    type: "detect_account_v3",
    provider: adapter.id,
  });
  await recordLog(
    result?.ok ? "info" : "warn",
    "account",
    result?.ok ? "detected" : "detection_failed",
    result?.ok ? `${label} account detected.` : `${label} account was not detected.`,
    { provider: adapter.id, ...(result?.ok ? {} : diagnosticErrorDetails(result?.error)) },
  );
  return result;
}

async function findProviderChatTab(adapter) {
  const tabs = await providerChatTabs(adapter);
  return orderProviderTabs(adapter, tabs)[0] ?? null;
}

async function providerChatTabs(adapter) {
  if (!adapter) return [];
  const tabs = await chrome.tabs.query(
    adapter.tabQueryPattern ? { url: adapter.tabQueryPattern } : {},
  );
  return tabs.filter((tab) => tab.id && adapter.matchesUrl(tab.url));
}

function orderProviderTabs(adapter, tabs, preferredTabId = null) {
  const priority = new Map((adapter?.surfacePriority ?? []).map((surface, index) => [surface, index]));
  return [...tabs].sort((left, right) => {
    const leftRank = priority.get(adapter?.surfaceForUrl?.(left.url)) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = priority.get(adapter?.surfaceForUrl?.(right.url)) ?? Number.MAX_SAFE_INTEGER;
    if (leftRank !== rightRank) return leftRank - rightRank;
    const leftActive = left.active === true ? 1 : 0;
    const rightActive = right.active === true ? 1 : 0;
    if (leftActive !== rightActive) return rightActive - leftActive;
    const leftPreferred = left.id === preferredTabId ? 1 : 0;
    const rightPreferred = right.id === preferredTabId ? 1 : 0;
    return rightPreferred - leftPreferred || Number(left.id ?? 0) - Number(right.id ?? 0);
  });
}

async function providerTabStatus(tab) {
  if (!tab?.id) return null;
  try {
    const result = await sendProviderMessage(tab.id, { type: "get_provider_status_v3" }, {
      label: "Provider",
      operation: "status request",
      timeoutMs: PROVIDER_STATUS_RESPONSE_TIMEOUT_MS,
    });
    return result?.ok ? result : null;
  } catch {
    return null;
  }
}

function providerTabIsReady(status, adapter) {
  if (adapter?.id !== "shopee") return Boolean(status?.ok);
  return Boolean(
    status?.surface_ready === true
    && status?.capabilities?.account_detection === true
    && status?.capabilities?.message_observation === true
    && status?.capabilities?.message_recovery === true
    && status?.capabilities?.send_text === true
    && status?.capabilities?.send_image === true
    && status?.capabilities?.send_product === true,
  );
}

async function isReadyProviderTab(tab, adapter) {
  if (!tab?.id || !adapter?.matchesUrl(tab.url)) return false;
  return providerTabIsReady(await providerTabStatus(tab), adapter);
}

async function findReadyProviderChatTab(adapter) {
  const tabs = await providerChatTabs(adapter);
  for (const tab of orderProviderTabs(adapter, tabs)) {
    if (await isReadyProviderTab(tab, adapter)) return tab;
  }
  return null;
}

async function ensureProviderBridge(tabId, adapter) {
  if (!adapter) throw new Error("Provider adapter is unavailable.");
  const label = providerLabel(adapter);
  let response = null;
  let pingFailed = false;
  let bridgeReady = false;
  try {
    response = await chrome.tabs.sendMessage(tabId, { type: "ping_v3" });
    bridgeReady = Boolean(
      response?.ok
      && response.bridge_protocol_version === BRIDGE_PROTOCOL_VERSION
      && response.bridge_source === BRIDGE_SOURCE,
    );
    if (bridgeReady) {
      await recordLog("debug", "provider", "content_ready", `${label} content bridge is ready.`, {
        provider: adapter.id,
      });
      return;
    }
  } catch {
    pingFailed = true;
  }

  if (!bridgeReady && await reinjectProviderBridge(tabId, adapter)) {
    try {
      response = await chrome.tabs.sendMessage(tabId, { type: "ping_v3" });
      bridgeReady = Boolean(
        response?.ok
        && response.bridge_protocol_version === BRIDGE_PROTOCOL_VERSION
        && response.bridge_source === BRIDGE_SOURCE,
      );
      if (bridgeReady) {
        await recordLog("info", "provider", "bridge_reinjected", `${label} content bridge was reattached without refreshing the page.`, {
          provider: adapter.id,
          surface: adapter.surfaceForUrl?.((await chrome.tabs.get(tabId)).url) ?? null,
        });
        return;
      }
    } catch {
      // The injected bridge did not attach; report the actionable failure below.
    }
  }

  const observedProtocol = Number.isInteger(response?.bridge_protocol_version)
    ? response.bridge_protocol_version
    : null;
  await recordLog("warn", "provider", "content_unready", `${label} content bridge is not ready. Refresh the tab manually before retrying.`, {
    provider: adapter.id,
    reason: pingFailed
      ? "no_response"
      : observedProtocol === null
        ? "invalid_response"
        : "protocol_mismatch",
    expected_bridge_protocol: BRIDGE_PROTOCOL_VERSION,
    expected_bridge_source: BRIDGE_SOURCE,
    ...(observedProtocol === null ? {} : { observed_bridge_protocol: observedProtocol }),
    ...(typeof response?.bridge_source === "string" ? { observed_bridge_source: response.bridge_source } : {}),
  });
  throw new Error(`${label} content bridge is not ready. Refresh the tab manually and try again.`);
}

async function prepareProviderTab(tab, adapter) {
  if (!tab?.id || adapter?.id !== "shopee") return { ok: true };
  if (adapter.surfaceForUrl?.(tab.url) !== "seller-centre") return { ok: true };
  await ensureProviderBridge(tab.id, adapter);
  const requestId = `prepare:${Date.now()}:${tab.id}`;
  const result = await sendProviderMessage(tab.id, {
    type: "prepare_provider_v3",
    provider: adapter.id,
    request_id: requestId,
  }, {
    label: providerLabel(adapter),
    operation: "surface preparation",
    timeoutMs: PROVIDER_SYNC_RESPONSE_TIMEOUT_MS,
  });
  if (!result?.ok) {
    throw new Error(result?.error || "Shopee Seller Centre could not be prepared for an outbound reply.");
  }
  return result;
}

async function resetProviderRecovery(tabId) {
  if (!chrome.scripting?.executeScript) return false;
  const resetResult = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      const reason = "Provider bridge reconnected; retrying recovery.";
      const control = window.__omnichatRealtimeBridgeControl;
      if (typeof control?.resetRecovery === "function") {
        return { ok: true, hadRecovery: Boolean(control.resetRecovery(reason)) };
      }
      const state = window.__omnichatRealtimeState;
      if (!state) return { ok: false, hadRecovery: false };
      const hadRecovery = Boolean(
        state.recoveryInFlight
        || state.recoveryRequestId
        || state.acknowledgements?.size,
      );
      state.recoveryAbortController?.abort();
      for (const [acknowledgementId, acknowledge] of state.acknowledgements ?? []) {
        state.acknowledgements.delete(acknowledgementId);
        try {
          acknowledge({ ok: false, error: reason });
        } catch {
          // A stale acknowledgement must not prevent bridge reattachment.
        }
      }
      state.recoveryRequestId = null;
      state.recoveryInFlight = false;
      state.recoveryAbortController = null;
      const currentEpoch = Number(state.recoveryEpoch);
      state.recoveryEpoch = (Number.isFinite(currentEpoch) ? currentEpoch : 0) + 1;
      return { ok: true, hadRecovery };
    },
  });
  const hadRecovery = resetResult?.[0]?.result?.hadRecovery === true;
  if (hadRecovery) {
    // Let an interrupted page-side recovery observe the cancellation before
    // a newly requested recovery starts.
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return hadRecovery;
}

async function providerMainBridgeStatus(tabId) {
  const mainBridge = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [BRIDGE_SOURCE],
    func: (bridgeSource) => ({
      ready: Boolean(
        globalThis.OmnichatShopeeUrl
        && globalThis.OmnichatProviderAdapters?.get?.("shopee")
        && window.__omnichatRealtimeState
        && window.__omnichatRealtimeBridgeControl?.source === bridgeSource
        && typeof window.__omnichatRealtimeBridgeControl?.dispose === "function"
        && typeof window.__omnichatRealtimeBridgeControl?.resetRecovery === "function"
        && typeof window.__omnichatRealtimeBridgeControl?.prepareSellerCentre === "function",
      ),
      hasUrl: Boolean(globalThis.OmnichatShopeeUrl),
      hasAdapters: Boolean(globalThis.OmnichatProviderAdapters?.get),
      hasShopeeAdapter: Boolean(globalThis.OmnichatProviderAdapters?.get?.("shopee")),
    }),
  });
  return mainBridge?.[0]?.result ?? {};
}

async function retireProviderMainBridge(tabId) {
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      const reason = "Provider bridge reattached.";
      const state = window.__omnichatRealtimeState;
      const hadRecovery = Boolean(
        state?.recoveryInFlight
        || state?.recoveryRequestId
        || state?.acknowledgements?.size,
      );
      const control = window.__omnichatRealtimeBridgeControl;
      if (typeof control?.dispose === "function") {
        return {
          hadRecovery,
          disposed: Boolean(control.dispose(reason)),
          source: typeof control.source === "string" ? control.source : null,
        };
      }
      if (!state) return { hadRecovery, disposed: false, source: null };
      state.recoveryAbortController?.abort();
      for (const [acknowledgementId, acknowledge] of state.acknowledgements ?? []) {
        state.acknowledgements.delete(acknowledgementId);
        try {
          acknowledge({ ok: false, error: reason });
        } catch {
          // A stale acknowledgement must not prevent bridge reattachment.
        }
      }
      state.recoveryRequestId = null;
      state.recoveryInFlight = false;
      state.recoveryAbortController = null;
      const currentEpoch = Number(state.recoveryEpoch);
      state.recoveryEpoch = (Number.isFinite(currentEpoch) ? currentEpoch : 0) + 1;
      if (state.sellerCentrePollingTimer != null) clearInterval(state.sellerCentrePollingTimer);
      state.sellerCentrePollingTimer = null;
      state.sellerCentrePollingStarted = false;
      state.pollingRefreshInFlight = false;
      state.pollingConnected = false;
      state.pollingConnectedAt = null;
      state.sellerCentreChatOpenPromise = null;
      state.socket = null;
      return {
        hadRecovery,
        disposed: false,
        source: typeof control?.source === "string" ? control.source : null,
      };
    },
  });
  const retired = result?.[0]?.result ?? {};
  if (retired.hadRecovery === true) {
    // Let an interrupted page-side recovery observe the cancellation before
    // a newly attached content bridge begins another recovery.
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return retired;
}

async function retireProviderContentBridge(tabId) {
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    world: "ISOLATED",
    func: () => {
      const control = globalThis.__omnichatContentBridgeControl;
      if (typeof control?.dispose !== "function") return { disposed: false, source: null };
      return {
        disposed: Boolean(control.dispose("Content bridge reattached.")),
        source: typeof control.source === "string" ? control.source : null,
      };
    },
  });
  return result?.[0]?.result ?? {};
}

async function reinjectProviderBridge(tabId, adapter) {
  if (!chrome.scripting?.executeScript || !adapter) return false;
  const inFlight = providerBridgeReinjections.get(tabId);
  if (inFlight) return inFlight;
  const reinjection = (async () => {
    try {
      const mainStatus = await providerMainBridgeStatus(tabId);
      if (mainStatus.ready !== true) {
        await retireProviderMainBridge(tabId);
        const mainFiles = [
          ...(mainStatus.hasUrl ? [] : ["lib/shopee-url.js"]),
          ...(mainStatus.hasAdapters ? [] : ["lib/provider-adapters.js"]),
          ...(mainStatus.hasShopeeAdapter ? [] : ["lib/shopee-adapter.js"]),
          "shopee-realtime.js",
        ];
        await chrome.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          files: mainFiles,
        });
      } else {
        await resetProviderRecovery(tabId);
      }
      await retireProviderContentBridge(tabId);
      const isolatedBridge = await chrome.scripting.executeScript({
        target: { tabId },
        world: "ISOLATED",
        func: () => ({
          hasUrl: Boolean(globalThis.OmnichatShopeeUrl),
          hasShopee: typeof globalThis.OmnichatShopee?.parseShopeeMessages === "function",
          hasAdapters: Boolean(globalThis.OmnichatProviderAdapters?.get),
          hasShopeeAdapter: Boolean(globalThis.OmnichatProviderAdapters?.get?.("shopee")),
        }),
      });
      const isolatedStatus = isolatedBridge?.[0]?.result ?? {};
      const isolatedFiles = [
        ...(isolatedStatus.hasUrl ? [] : ["lib/shopee-url.js"]),
        ...(isolatedStatus.hasShopee ? [] : ["lib/shopee.js"]),
        ...(isolatedStatus.hasAdapters ? [] : ["lib/provider-adapters.js"]),
        ...(isolatedStatus.hasShopeeAdapter ? [] : ["lib/shopee-adapter.js"]),
        "content.js",
      ];
      await chrome.scripting.executeScript({
        target: { tabId },
        world: "ISOLATED",
        files: isolatedFiles,
      });
      return true;
    } catch (error) {
      await recordUnexpected("provider_bridge_reinject", error, {
        provider: adapter.id,
        tab_id: tabId,
      });
      return false;
    }
  })();
  providerBridgeReinjections.set(tabId, reinjection);
  try {
    return await reinjection;
  } finally {
    if (providerBridgeReinjections.get(tabId) === reinjection) {
      providerBridgeReinjections.delete(tabId);
    }
  }
}

async function reattachOpenProviderBridges() {
  for (const adapter of providerAdapters.list()) {
    const tabs = await chrome.tabs.query(
      adapter.tabQueryPattern ? { url: adapter.tabQueryPattern } : {},
    );
    for (const tab of tabs.filter((item) => item.id && adapter.matchesUrl(item.url))) {
      try {
        await ensureProviderBridge(tab.id, adapter);
      } catch (error) {
        await recordUnexpected("provider_bridge_startup", error, { provider: adapter.id });
      }
    }
  }
  await ensureLiveConnection();
}

function providerMessageTimeout(label, operation) {
  const error = new Error(`${label} ${operation} timed out. Refresh the provider tab and try again.`);
  error.name = "TimeoutError";
  return error;
}

function sendProviderMessage(tabId, message, {
  label,
  operation,
  signal,
  timeoutMs = PROVIDER_SYNC_RESPONSE_TIMEOUT_MS,
} = {}) {
  let timeout;
  let onAbort;
  const response = Promise.resolve()
    .then(() => chrome.tabs.sendMessage(tabId, message));
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(providerMessageTimeout(label ?? "Provider", operation ?? "request")), timeoutMs);
  });
  const cancellation = new Promise((_, reject) => {
    if (!signal) return;
    onAbort = () => reject(syncCancelledError());
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([response, deadline, cancellation]).finally(() => {
    clearTimeout(timeout);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  });
}

function syncCancelledError() {
  const error = new Error("Sync cancelled.");
  error.name = "AbortError";
  return error;
}

function throwIfSyncCancelled(signal) {
  if (signal?.aborted) throw syncCancelledError();
}

async function syncOpenProvider(control, context) {
  const adapter = context?.adapter ?? providerAdapterForAccount(context?.account);
  const label = providerLabel(adapter);
  if (!adapter?.supports("message_recovery")) {
    throw new Error(`${label} does not support message recovery.`);
  }
  const { signal } = control.controller;
  throwIfSyncCancelled(signal);
  const tab = await findReadyProviderChatTab(adapter) ?? await findProviderChatTab(adapter);
  if (!tab) throw new Error(`Open ${label} to sync messages.`);
  control.tabId = tab.id;
  control.adapter = adapter;
  await ensureProviderBridge(tab.id, adapter);
  throwIfSyncCancelled(signal);
  const syncMessage = {
    type: "sync_now_v3",
    provider: context.account.provider,
    provider_account_id: context.account.provider_account_id,
  };
  let result = await sendProviderMessage(tab.id, syncMessage, {
    label,
    operation: "sync request",
    signal,
  });
  throwIfSyncCancelled(signal);
  if (!result?.ok && result?.error === "Recovery is already running.") {
    await resetProviderRecovery(tab.id);
    throwIfSyncCancelled(signal);
    result = await sendProviderMessage(tab.id, syncMessage, {
      label,
      operation: "retry sync request",
      signal,
    });
    throwIfSyncCancelled(signal);
  }
  if (!result?.ok) throw new Error(result?.error ?? `${label} recovery failed.`);
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
  const tabId = control?.tabId ?? (await findProviderChatTab(control?.adapter ?? shopeeAdapter))?.id;
  let providerCancelled = false;
  if (tabId) {
    const result = await chrome.tabs.sendMessage(tabId, {
      type: "cancel_sync_v3",
      ...(control?.adapter ? { provider: control.adapter.id } : {}),
    }).catch(() => null);
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
      STORAGE.config,
      STORAGE.consent,
      STORAGE.detectedAccounts,
      STORAGE.pending,
      STORAGE.scanState,
      STORAGE.status,
    ]);
    const contexts = configuredAccountContexts(stored);
    if (!contexts.length) return false;
    const writes = {};
    let cancelled = false;
    for (const context of contexts) {
      const scanState = readAccountState(stored[STORAGE.scanState], context.key, null);
      const status = readAccountState(stored[STORAGE.status], context.key, {});
      if (!scanState?.in_progress && !["discovering", "syncing"].includes(status.state)) continue;
      cancelled = true;
      writes[STORAGE.status] = writeAccountState(
        writes[STORAGE.status] ?? stored[STORAGE.status],
        context.key,
        {
          ...status,
          state: "watching",
          phase: null,
          caught_up: false,
          sync_error: null,
          sync_error_at: null,
          completed_conversations: null,
          total_conversations: null,
          pending: readAccountState(stored[STORAGE.pending], context.key, []).length,
        },
      );
      if (scanState) {
        writes[STORAGE.scanState] = writeAccountState(
          writes[STORAGE.scanState] ?? stored[STORAGE.scanState],
          context.key,
          {
            ...scanState,
            in_progress: false,
            cancelled_at: new Date().toISOString(),
          },
        );
      }
    }
    if (!cancelled) return false;
    await writeStorage(writes);
    return true;
  });
}

async function runAccountSync(trigger, control, context) {
  const { signal } = control.controller;
  control.adapter = context.adapter;
  const automatic = trigger === "automatic";
  const providerAccountId = context.account.provider_account_id;
  const prepared = await exclusive(async () => {
    throwIfSyncCancelled(signal);
    const { state, stored } = await getAccountScanState(providerAccountId, context.account.provider);
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
      provider_account_id: providerAccountId,
      reason: prepared.skipped,
    });
    return { provider: context.account.provider, provider_account_id: providerAccountId, ...prepared };
  }
  await recordLog("info", "sync", "started", "Sync started.", {
    provider_account_id: providerAccountId,
    trigger,
  });

  try {
    throwIfSyncCancelled(signal);
    await updateScopedState(STORAGE.status, context.key, {
      phase: "sending_pending",
    });
    await recordLog("debug", "delivery", "pre_sync_flush", "Checking queued messages before recovery.", {
      provider_account_id: providerAccountId,
    });
    await attemptDelivery(context, { resetBackoff: true, signal });
    throwIfSyncCancelled(signal);
    await updateScopedState(STORAGE.status, context.key, {
      phase: "loading_conversations",
    });
    await recordLog("info", "sync", "provider_recovery", `Requesting missed messages from ${providerLabel(context.adapter)}.`, {
      provider: context.account.provider,
      provider_account_id: providerAccountId,
    });
    const recovered = await syncOpenProvider(control, context);
    throwIfSyncCancelled(signal);
    await exclusive(async () => {
      const { state, stored } = await getAccountScanState(providerAccountId, context.account.provider);
      await writeAccountScanState(context, {
        ...state,
        watermark: recovered.watermark ?? state.watermark,
        bootstrap: null,
        in_progress: false,
        completed_at: new Date().toISOString(),
      }, stored[STORAGE.scanState]);
    });
    await updateScopedState(STORAGE.status, context.key, {
      state: "discovering",
      phase: "sending_recovered",
      completed_conversations: null,
      total_conversations: null,
    });
    const delivered = await attemptDelivery(context, { resetBackoff: true, signal });
    throwIfSyncCancelled(signal);
    const result = {
      provider: context.account.provider,
      provider_account_id: providerAccountId,
      recovered: recovered.recovered ?? 0,
      queued: recovered.queued ?? 0,
      sent: delivered.sent,
      pending: delivered.pending,
    };
    await updateScopedState(STORAGE.status, context.key, {
      state: "watching",
      phase: null,
      last_sync_at: new Date().toISOString(),
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
    const pending = readAccountState(stored[STORAGE.pending], context.key, []);
    const state = readAccountState(stored[STORAGE.scanState], context.key, null);
    if (state) {
      await writeAccountScanState(context, {
        ...state,
        in_progress: false,
        ...(cancelled
          ? { cancelled_at: new Date().toISOString() }
          : { failed_at: new Date().toISOString() }),
      }, stored[STORAGE.scanState]);
    }
    await updateScopedState(STORAGE.status, context.key, {
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
      await recordLog("info", "sync", "cancelled", "Sync cancelled by user.", {
        provider_account_id: providerAccountId,
      });
      throw syncCancelledError();
    }
    await recordUnexpected("message_sync", error, {
      provider_account_id: providerAccountId,
    });
    return {
      provider: context.account.provider,
      provider_account_id: providerAccountId,
      recovered: 0,
      queued: 0,
      sent: 0,
      pending: pending.length,
      error: message,
    };
  }
}

async function runUnifiedSync(trigger, control) {
  const stored = await readStorage([STORAGE.config, STORAGE.consent, STORAGE.detectedAccounts]);
  if (!hasLocalConsent(stored[STORAGE.consent])) {
    throw new Error("Provider browser bridge is not configured.");
  }
  const contexts = configuredAccountContexts(stored);
  if (!contexts.length) throw new Error("No configured provider accounts are detected.");
  const accounts = [];
  for (const context of contexts) {
    throwIfSyncCancelled(control.controller.signal);
    accounts.push(await runAccountSync(trigger, control, context));
  }
  const errors = accounts.filter((account) => account.error);
  const result = {
    recovered: accounts.reduce((total, account) => total + (Number(account.recovered) || 0), 0),
    queued: accounts.reduce((total, account) => total + (Number(account.queued) || 0), 0),
    sent: accounts.reduce((total, account) => total + (Number(account.sent) || 0), 0),
    pending: accounts.reduce((total, account) => total + (Number(account.pending) || 0), 0),
    accounts,
    ...(errors.length ? { errors } : {}),
  };
  await recordLog("info", "sync", "all_completed", "All configured provider account syncs completed.", {
    accounts: accounts.length,
    errors: errors.length,
    recovered: result.recovered,
    queued: result.queued,
    sent: result.sent,
    pending: result.pending,
  });
  return result;
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

async function resumeInterruptedSync() {
  if (activeSync) return activeSync;
  const stored = await readStorage([
    STORAGE.serverInitialized,
    STORAGE.consent,
    STORAGE.config,
    STORAGE.detectedAccounts,
    STORAGE.status,
    STORAGE.scanState,
  ]);
  if (!hasServerInitialized(stored) || !hasLocalConsent(stored[STORAGE.consent])) {
    return { skipped: "not_initialized" };
  }
  const interrupted = configuredAccountContexts(stored).some((context) => {
    const scanState = readAccountState(stored[STORAGE.scanState], context.key, null);
    const status = readAccountState(stored[STORAGE.status], context.key, null);
    return scanState?.in_progress === true
      || ["discovering", "syncing"].includes(status?.state);
  });
  if (!interrupted) return { skipped: "no_interrupted_sync" };
  return resumeSync();
}

function messageKey(message) {
  return `${messageProvider(message)}:${message.conversation_id}:${message.id}`;
}

async function queueMessagesForContext(messages, context, shouldFlush, advanceCursor = true) {
  const stored = await readStorage([
    STORAGE.consent,
    STORAGE.pending,
    STORAGE.scanState,
    STORAGE.targetCursor,
    STORAGE.lastResumeSyncAt,
    STORAGE.serverInitialized,
    STORAGE.status,
  ]);
  if (!hasLocalConsent(stored[STORAGE.consent])) {
    await recordLog("debug", "queue", "ignored", "Captured messages were ignored because setup is incomplete.", {
      consented: hasLocalConsent(stored[STORAGE.consent]),
      provider_account_id: context.account.provider_account_id,
    });
    return { queued: 0, sent: 0, pending: 0 };
  }
  const scopedMessages = Array.isArray(messages) ? messages : [];
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
  for (const message of scopedMessages) {
    const cursor = scanState.conversations?.[message?.conversation_id];
    if (messageProvider(message) !== context.account.provider
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
      provider_account_id: context.account.provider_account_id,
      received: scopedMessages.length,
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
  const delivered = await attemptDelivery(context, { resetBackoff: false });
  await recordLog("info", "queue", "realtime_processed", "Realtime messages processed.", {
    provider_account_id: context.account.provider_account_id,
    received: scopedMessages.length,
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

async function queueMessages(messages, shouldFlush, advanceCursor = true) {
  const stored = await readStorage([
    STORAGE.config,
    STORAGE.consent,
    STORAGE.detectedAccounts,
  ]);
  if (!hasLocalConsent(stored[STORAGE.consent])) {
    await recordLog("debug", "queue", "ignored", "Captured messages were ignored because setup is incomplete.", {
      consented: false,
    });
    return { queued: 0, sent: 0, pending: 0 };
  }
  const contexts = new Map(
    configuredAccountContexts(stored).map((context) => [
      accountKey(context.account.provider, context.account.provider_account_id),
      context,
    ]),
  );
  const groups = new Map();
  let missingAccountMessages = 0;
  let unconfiguredAccountMessages = 0;
  for (const message of Array.isArray(messages) ? messages : []) {
    const provider = messageProvider(message);
    const providerAccountId = messageProviderAccountId(message);
    if (!provider || !providerAccountId) {
      missingAccountMessages += 1;
      continue;
    }
    const contextKey = accountKey(provider, providerAccountId);
    if (!contexts.has(contextKey)) {
      unconfiguredAccountMessages += 1;
      continue;
    }
    const group = groups.get(contextKey) ?? [];
    group.push(message);
    groups.set(contextKey, group);
  }
  if (missingAccountMessages) {
    await recordLog("warn", "queue", "account_missing", "Captured messages were ignored because no provider account ID was identified.", {
      received: missingAccountMessages,
    });
  }
  if (unconfiguredAccountMessages) {
    await recordLog("warn", "queue", "account_not_configured", "Captured messages were ignored because their provider account is not configured.", {
      received: unconfiguredAccountMessages,
    });
  }
  const results = [];
  for (const [contextKey, group] of groups) {
    results.push(await queueMessagesForContext(
      group,
      contexts.get(contextKey),
      shouldFlush,
      advanceCursor,
    ));
  }
  return {
    queued: results.reduce((total, result) => total + (Number(result.queued) || 0), 0),
    sent: results.reduce((total, result) => total + (Number(result.sent) || 0), 0),
    pending: results.reduce((total, result) => total + (Number(result.pending) || 0), 0),
    deferred: results.some((result) => result.deferred),
    ...(results.length === 1 ? { latest_cursor: results[0].latest_cursor } : {}),
  };
}

function batchFor(messages, installId) {
  const provider = messageProvider(messages[0]);
  const adapter = providerAdapterForId(provider);
  if (!adapter) throw new Error(`Unsupported provider: ${provider || "<unknown>"}.`);
  if (messages.some((message) => messageProvider(message) !== provider)) {
    throw new Error("A message batch cannot contain multiple providers.");
  }
  const conversations = new Map();
  for (const message of messages) {
    const participant = participantForBatch(message.participant);
    const conversation = conversations.get(message.conversation_id) ?? {
      id: message.conversation_id,
      ...(participant ? { participants: [participant] } : {}),
      messages: []
    };
    if (!conversation.participants && participant) conversation.participants = [participant];
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
    provider: adapter.id,
    extension_version: chrome.runtime.getManifest().version,
    adapter_version: adapter.adapterVersion ?? `${adapter.id}-1`,
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
      code = [error?.error, error?.error_code, error?.code]
        .find((value) => typeof value === "string" && value.trim())
        ?.trim() ?? "";
    } catch {
      // The HTTP status remains actionable when the target has no JSON error body.
    }
    const failure = new Error(
      "Target server returned " + response.status + (code ? ": " + code : ""),
    );
    failure.http_status = response.status;
    if (code) failure.server_error_code = code;
    throw failure;
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
    STORAGE.detectedAccounts,
    STORAGE.consent,
    STORAGE.serverInitialized,
    STORAGE.logUploadEnabled,
  ]);
  if (!hasLocalConsent(stored[STORAGE.consent])
    || !hasServerInitialized(stored)
    || stored[STORAGE.logUploadEnabled] !== true) return;
  const contexts = configuredAccountContexts(stored).filter((context) => context.config.logs_url);
  if (!contexts.length) return;
  const queuedIds = new Set(Array.isArray(stored[STORAGE.logOutbox]) ? stored[STORAGE.logOutbox] : []);
  const entries = pruneLogs(stored[STORAGE.logs]);
  let remaining = queuedIds.size;
  for (const context of contexts) {
    const selected = entries
      .filter((entry) => entry.account_key === context.key && queuedIds.has(entry.id))
      .reverse()
      .slice(0, MAX_LOG_UPLOAD_BATCH);
    if (!selected.length) continue;
    try {
      await sendLogBatch(context, selected);
      const deliveredIds = new Set(selected.map((entry) => entry.id));
      await mutateLogs(async () => {
        const current = await readStorage([STORAGE.logOutbox]);
        const outbox = (Array.isArray(current[STORAGE.logOutbox]) ? current[STORAGE.logOutbox] : [])
          .filter((id) => !deliveredIds.has(id));
        remaining = outbox.length;
        await writeStorage({ [STORAGE.logOutbox]: outbox });
      });
      await recordLog("info", "logs", "uploaded", "Operational logs uploaded.", {
        provider_account_id: context.account.provider_account_id,
        count: selected.length,
      }, { remote: false });
    } catch (error) {
      await recordLog("warn", "logs", "upload_failed", "Operational log upload failed.", {
        provider_account_id: context.account.provider_account_id,
        ...diagnosticErrorDetails(error),
      }, { remote: false });
    }
  }
  if (remaining) void scheduleLogUpload(5);
}

function isMessageScopedDeliveryError(error) {
  return error?.server_error_code === "provider_account_not_participant"
    || error?.server_error_code === "batch_too_large";
}

function messageIdentifier(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function messageReference(message) {
  return `${message.conversation_id}\u0000${message.id}`;
}

async function deliveryMessageDetails(context, message, index) {
  const details = {
    provider_account_id: context.account.provider_account_id,
    message_key: messageKey(message),
    message_id: messageIdentifier(message.id),
    conversation_id: messageIdentifier(message.conversation_id),
    sender_id: messageIdentifier(message.sender_id),
    recipient_id: messageIdentifier(message.recipient_id),
    sender_account_id: messageIdentifier(message.sender_account_id),
    recipient_account_id: messageIdentifier(message.recipient_account_id),
    type: messageIdentifier(message.type),
    event_timestamp: messageIdentifier(message.event_timestamp),
    capture_method: messageIdentifier(message.capture_method),
    message_index: index + 1,
  };
  try {
    details.message_fingerprint = await sha256Hex(JSON.stringify(details));
  } catch {
    // The identifiers above are still useful if Web Crypto is unavailable.
  }
  return details;
}

async function flushBatch(context, signal) {
  const stored = await readStorage([
    STORAGE.consent,
    STORAGE.pending,
    STORAGE.status,
  ]);
  const pending = readAccountState(stored[STORAGE.pending], context?.key, []);
  if (!hasLocalConsent(stored[STORAGE.consent]) || !context || !pending.length) {
    return { sent: 0, pending: pending.length };
  }
  await recordLog("debug", "delivery", "batch_preparing", "Preparing queued message batch.", {
    provider_account_id: context.account.provider_account_id,
    pending: pending.length,
  });
  let selected;
  let installId;
  try {
    installId = await installationId();
    selected = selectBatchMessages(pending);
    if (!selected.length) return { sent: 0, pending: pending.length };
  } catch (error) {
    if (signal?.aborted) throw syncCancelledError();
    const message = error instanceof Error ? error.message : String(error);
    await updateScopedState(STORAGE.status, context.key, {
      delivery_error: message,
      delivery_error_at: new Date().toISOString(),
    });
    throw error;
  }
  const outcome = await deliverWithIsolation(
    selected,
    async (messages) => {
      const payload = batchFor(messages, installId);
      if (JSON.stringify(payload).length > 1_000_000) {
        const error = new Error("Queued batch exceeds the 1 MiB limit.");
        error.server_error_code = "batch_too_large";
        throw error;
      }
      const acknowledgement = await signedRequest(
        context.config,
        context.account.provider_account_id,
        payload,
        signal,
      );
      if (acknowledgement.schema !== "omnichat.message_batch_ack"
        || acknowledgement.batch_id !== payload.batch_id
        || !Number.isInteger(acknowledgement.accepted_messages)
        || !Number.isInteger(acknowledgement.duplicate_messages)) {
        throw new Error("Target server acknowledgement is invalid.");
      }
      const skippedMessages = Array.isArray(acknowledgement.skipped_messages)
        ? acknowledgement.skipped_messages
        : [];
      const groupReferences = new Set(messages.map(messageReference));
      const skippedByReference = new Map();
      for (const skipped of skippedMessages) {
        const reference = `${skipped?.conversation_id ?? ""}\u0000${skipped?.message_id ?? ""}`;
        if (!skipped?.conversation_id
          || !skipped?.message_id
          || !groupReferences.has(reference)
          || skippedByReference.has(reference)) {
          throw new Error("Target server acknowledgement is invalid.");
        }
        skippedByReference.set(reference, skipped);
      }
      if (acknowledgement.accepted_messages
        + acknowledgement.duplicate_messages
        + skippedMessages.length !== messages.length) {
        throw new Error("Target server acknowledgement is invalid.");
      }
      return {
        skipped: messages.filter((message) => skippedByReference.has(messageReference(message))),
      };
    },
    isMessageScopedDeliveryError,
  );
  const deliveredKeys = new Set(outcome.delivered.map(messageKey));
  for (const message of outcome.skipped) deliveredKeys.add(messageKey(message));
  const remaining = pending.filter((message) => !deliveredKeys.has(messageKey(message)));
  const currentStatus = readAccountState(stored[STORAGE.status], context.key, {});
  const failure = outcome.failed[0]?.error ?? outcome.blocked?.error ?? null;
  const failureMessage = failure instanceof Error ? failure.message : String(failure ?? "");
  const now = new Date().toISOString();
  await writeStorage({
    [STORAGE.pending]: writeAccountState(stored[STORAGE.pending], context.key, remaining),
    [STORAGE.status]: writeAccountState(stored[STORAGE.status], context.key, {
      ...currentStatus,
      state: ["discovering", "syncing"].includes(currentStatus.state)
        ? currentStatus.state
        : "watching",
      delivery_error: failureMessage || null,
      delivery_error_at: failureMessage ? now : null,
      ...(outcome.delivered.length ? { last_delivery_at: now } : {}),
      pending: remaining.length,
    }),
  });
  for (const failed of outcome.failed) {
    await recordUnexpected("message_delivery", failed.error, {
      ...(await deliveryMessageDetails(
        context,
        failed.message,
        selected.indexOf(failed.message),
      )),
    });
  }
  for (const message of outcome.skipped) {
    await recordLog("error", "message_delivery", "server_skipped", "Target server skipped a malformed message.", {
      ...(await deliveryMessageDetails(context, message, selected.indexOf(message))),
      server_error_code: "provider_account_not_participant",
    });
  }
  if (outcome.blocked) {
    await recordUnexpected("message_delivery", outcome.blocked.error, {
      provider_account_id: context.account.provider_account_id,
      batch_size: outcome.blocked.messages.length,
    });
  }
  if (outcome.delivered.length) {
    await recordLog("info", "delivery", "batch_sent", "Message batch accepted by target server.", {
      provider_account_id: context.account.provider_account_id,
      sent: outcome.delivered.length,
      pending: remaining.length,
    });
  }
  return {
    sent: outcome.delivered.length,
    pending: remaining.length,
    skipped: outcome.skipped.length,
    failed: outcome.failed.length,
    blocked: Boolean(outcome.blocked),
  };
}

async function flushAll(context, signal) {
  let sent = 0;
  let pending = 0;
  for (let batch = 0; batch < MAX_FLUSH_BATCHES; batch += 1) {
    throwIfSyncCancelled(signal);
    const result = await flushBatch(context, signal);
    sent += result.sent;
    pending = result.pending;
    if (!pending || (!result.sent && !result.skipped) || result.failed || result.blocked) break;
  }
  return { sent, pending };
}

async function resetDeliveryRetry(context) {
  const stored = await readStorage([STORAGE.deliveryRetry]);
  await writeStorage({
    [STORAGE.deliveryRetry]: writeAccountState(
      stored[STORAGE.deliveryRetry],
      context.key,
      { attempt: 0, next_at: null },
    ),
  });
}

async function clearDeliveryRetryAlarm() {
  await chrome.alarms.clear(DELIVERY_RETRY_ALARM);
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
  const existingAlarm = await chrome.alarms.get(DELIVERY_RETRY_ALARM);
  if (!existingAlarm || Number(existingAlarm.scheduledTime) > nextAt) {
    chrome.alarms.create(DELIVERY_RETRY_ALARM, { when: nextAt });
  }
  await recordLog("warn", "delivery", "retry_scheduled", "Message delivery retry scheduled.", {
    provider_account_id: context.account.provider_account_id,
    attempt: attempt + 1,
    delay_ms: deliveryRetryDelay(attempt),
  });
}

async function attemptDelivery(context, { resetBackoff, signal }) {
  const stored = await readStorage([
    STORAGE.consent,
    STORAGE.pending,
    STORAGE.serverInitialized,
  ]);
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
    const result = await flushAll(context, signal);
    if (result.pending) await scheduleDeliveryRetry(context);
    else await clearDeliveryRetry(context);
    await updateScopedState(STORAGE.status, context.key, { pending: result.pending });
    return result;
  } catch (error) {
    if (signal?.aborted) throw syncCancelledError();
    await recordUnexpected("message_delivery", error, {
      provider_account_id: context.account.provider_account_id,
    });
    await scheduleDeliveryRetry(context);
    return {
      sent: 0,
      pending: pending.length,
      delivery_error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function attemptAllDeliveries(options) {
  const stored = await readStorage([STORAGE.config, STORAGE.consent, STORAGE.detectedAccounts]);
  const contexts = configuredAccountContexts(stored);
  const results = [];
  for (const context of contexts) {
    results.push(await attemptDelivery(context, options));
  }
  const pending = results.reduce((total, result) => total + (Number(result.pending) || 0), 0);
  if (!pending) await clearDeliveryRetryAlarm();
  return {
    sent: results.reduce((total, result) => total + (Number(result.sent) || 0), 0),
    pending,
    accounts: results.length,
  };
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === DELIVERY_RETRY_ALARM) {
    void recordLog("info", "delivery", "retry_started", "Retrying queued message delivery.");
    void exclusive(() => attemptAllDeliveries({ resetBackoff: false }));
  } else if (alarm.name === LOG_UPLOAD_ALARM) {
    void flushLogBatch();
  }
});
