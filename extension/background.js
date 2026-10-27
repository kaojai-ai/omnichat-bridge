import { withRequestTimeout } from "./lib/request-timeout.js";
import { hmacHex, sha256Hex } from "./lib/crypto.js";
import { accountConfigKey, accountKey, findAccountConfig, historySinceMs, historySyncSettings } from "./lib/config.js";
import { accountMigration } from "./lib/config-migration.js";
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
  availableLogBudget,
  createRoutineLogFilter,
  diagnosticErrorDetails,
  sanitizeSendDiagnostics,
  logEntryForUpload,
  pruneLogs,
} from "./lib/logs.js";
import { createMetadataCache } from "./lib/metadata-cache.js";
import { participantForBatch } from "./lib/message-batch.js";
import { deliverWithIsolation } from "./lib/delivery-isolation.js";
import { createDiagnosticBuffer } from "./lib/diagnostic-buffer.js";
import { createSessionEligibility } from "./lib/session-eligibility.js";
import { createStatusReporter } from "./lib/status-reporter.js";
import { createDeliveryScheduler } from "./lib/delivery-scheduler.js";
import { createReplyQueue } from "./lib/reply-queue.js";
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
import {
  PROVIDER_RECOVERY_STATES,
  normalizeProviderRecoveryTabs,
  providerRecoveryRecord,
  recoveryRetryDelay,
  recoveryRetryDue,
  updateProviderRecoveryRecord,
} from "./lib/provider-recovery.js";
import "./lib/shopee-url.js";
import "./lib/provider-adapters.js";
import "./lib/shopee-adapter.js";
import "./lib/line-oa.js";

let metadataCacheWarningReported = false;
function newCustomerMetadataCache() {
  return createMetadataCache({
    load: async () => (await readStorage([STORAGE.customerMetadata]))[STORAGE.customerMetadata],
    save: (value) => writeStorage({ [STORAGE.customerMetadata]: value }),
    onError: () => {
      if (metadataCacheWarningReported) return;
      metadataCacheWarningReported = true;
      return recordLog("warn", "metadata", "cache_save_failed", "Display metadata could not be saved locally.");
    },
  });
}
let customerMetadata = newCustomerMetadataCache();
let metadataEpoch = 0;
let metadataErasing = false;
const metadataRefreshes = new Map();
// Persist only an opaque configuration fingerprint, never endpoint or credential values.
const metadataScopes = new WeakMap();
function metadataScope(context) {
  let scopes = metadataScopes.get(context.config);
  if (!scopes) { scopes = new Map(); metadataScopes.set(context.config, scopes); }
  const key = accountKey(context.account.provider, context.account.provider_account_id);
  if (!scopes.has(key)) scopes.set(key, sha256Hex(JSON.stringify([
    context.config.events_url, context.config.api_url ?? context.config.commands_url,
    context.config.tenant_id ?? null, context.config.user_id ?? null,
    context.config.hmac_secret, // Opaque configuration fingerprint only; never persist the credential.
    context.account.provider, context.account.provider_account_id,
  ])));
  return scopes.get(key);
}

const providerAdapters = globalThis.OmnichatProviderAdapters;
const shopeeAdapter = providerAdapters.get("shopee");
const DETECTED_ACCOUNTS_RESET_VERSION = "0.5.2";
const BRIDGE_PROTOCOL_VERSION = 10;
const BRIDGE_SOURCE = "omnichat-realtime-bridge-v3";
// Bump only when the LINE page bridge interface becomes incompatible.
const LINE_MAIN_BRIDGE_COMPATIBILITY_VERSION = 5;
// Bump when an open Shopee page must replace its main-world bridge.
const SHOPEE_MAIN_BRIDGE_COMPATIBILITY_VERSION = 3;
const MAX_BATCH_MESSAGES = 500;
const MAX_BATCH_CONVERSATIONS = 50;
const MAX_MESSAGES_PER_CONVERSATION = 100;
const MAX_FLUSH_BATCHES = 10;
const RESUME_SYNC_COOLDOWN_MS = 5 * 60_000;
const UPDATE_CHECK_CACHE_MS = 6 * 60 * 60_000;
const UPDATE_RETRY_DELAY_MS = 5 * 60_000;
const API_PING_COOLDOWN_MS = 5 * 60_000;
const API_PING_ALARM = "omnichat-api-ping";
const API_PING_INTERVAL_MINUTES = 5;
const PROVIDER_HEALTH_ALARM = "omnichat-provider-health";
const PROVIDER_HEALTH_INTERVAL_MINUTES = 1;
const PROVIDER_HEALTH_STALE_MS = 60_000;
// WebSocket traffic must stay within Chrome's 30-second worker activity window.
const KEEPALIVE_INTERVAL_MS = 20_000;
const API_PING_TIMEOUT_MS = 15_000;
const MAX_REPLY_TEXT_LENGTH = 2_000;
const MAX_REPLY_IMAGE_BYTES = 10 * 1024 * 1024;
const PROVIDER_REQUEST_TIMEOUT_MS = 15_000;
const RECOVERY_IDLE_TIMEOUT_MS = 60_000;
const PROVIDER_PREPARATION_TIMEOUT_MS = 35_000;
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
  "provider.send_failed": "Provider reply failed. See routing diagnostics.",
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
  "provider.recovery_superseded": "Provider recovery superseded by reconnect.",
  "provider.recovery_completed": "Provider recovery completed.",
  "provider.socket_observed": "Provider realtime socket detected.",
  "provider.recovery_started": "Provider recovery started.",
  "provider.recovery_plan": "Provider recovery plan prepared.",
  "provider.conversation_started": "Checking one conversation for missed messages.",
  "provider.conversation_completed": "Conversation recovery check completed.",
  "provider.history_template_ready": "Provider history request template captured.",
  "provider.history_backfill_completed": "Configured conversation history was loaded.",
  "provider.history_window_completed": "Configured history window was loaded.",
  "provider.history_conversation_skipped": "Configured history conversation was not in the chat list.",
  "provider.list_template_ready": "Provider conversation-list request template captured.",
  "provider.send_route_fallback": "Legacy Shopee route resolution is deprecated; supply omnichat.routing. Falling back to cache/lookup. See routing diagnostics.",
  "provider.send_route_resolution": "Shopee reply routing checked.",
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
const replyQueue = createReplyQueue();
const deliveryScheduler = createDeliveryScheduler(2);
let commandTabWriteQueue = Promise.resolve();
const rememberedCommandTabs = new Map();
const providerBridgeChecks = new Map();
let logMutationQueue = Promise.resolve();
let activeSync = null;
let activeSyncControl = null;
let syncRestart = null;
const liveConnections = new Map();
const liveCommandResults = new Map();
const apiPingAttempts = new Map();
const providerBridgeReinjections = new Map();
const sellerCentreLandingStarts = new Map();
const providerAutomaticRecoveries = new Map();
const providerAutomaticRetryAttempts = new Map();
const providerAutomaticRetryAt = new Map();
const providerRecoveryTabLocks = new Map();
let providerHealthWatchdogPromise = null;
const providerSessionEpochs = new Map();
const providerTabEpochs = new Map();
const providerPolicyTabIds = new Map();
const providerPolicyObservations = new Map();
let providerObservationSequence = 0;
const providerStatusProbes = new Map();
const providerPolicyContexts = new Map();
const sessionEligibility = createSessionEligibility({
  onRecheck: () => ensureLiveConnection(),
  onEvent: (key, event, details) => {
    const context = providerPolicyContexts.get(key);
    return recordLog(event === "needs_attention" ? "warn" : "info", "readiness", event,
      event === "grace_started" ? "Provider check is temporarily unavailable; retaining recent readiness."
        : event === "recovered" ? "Provider readiness check recovered."
          : event === "grace_expired" ? "Provider readiness grace expired; replies are unavailable."
            : event === "needs_attention" ? "Provider checks have remained unavailable for sixty seconds."
              : "Provider readiness verification started.", {
        provider: context?.account.provider, provider_account_id: context?.account.provider_account_id, ...details,
      });
  },
});

function mutateLogs(task) {
  const result = logMutationQueue.then(task, task);
  logMutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

const filterRoutineLog = createRoutineLogFilter();

let diagnosticsSuspended = false;
const diagnosticBuffer = createDiagnosticBuffer({
  persist: (rows) => mutateLogs(async () => {
    const stored = await readStorage([
      STORAGE.logs, STORAGE.logOutbox, STORAGE.serverInitialized,
      STORAGE.logUploadEnabled, STORAGE.config, STORAGE.detectedAccounts,
    ]);
    const local = chrome.storage.local;
    const [totalBytes, currentLogBytes] = await Promise.all([
      local.getBytesInUse(null), local.getBytesInUse([STORAGE.logs, STORAGE.logOutbox]),
    ]);
    const entries = rows.map(({ entry }) => {
      const context = accountContextFor(stored, entry.details?.provider_account_id, entry.details?.provider);
      return { ...entry, ...(context ? { account_key: context.key } : {}) };
    });
    const budget = availableLogBudget(totalBytes, currentLogBytes, local.QUOTA_BYTES);
    const logs = pruneLogs([...entries.reverse(), ...(Array.isArray(stored[STORAGE.logs]) ? stored[STORAGE.logs] : [])], Date.now(), budget);
    const retained = new Set(logs.map((entry) => entry.id));
    const outbox = new Set((Array.isArray(stored[STORAGE.logOutbox]) ? stored[STORAGE.logOutbox] : []).filter((id) => retained.has(id)));
    for (const { entry, remote } of rows) {
      const context = accountContextFor(stored, entry.details?.provider_account_id, entry.details?.provider);
      if (remote && entry.level !== "debug" && retained.has(entry.id)
        && hasServerInitialized(stored) && stored[STORAGE.logUploadEnabled] === true
        && context?.config.logs_url) outbox.add(entry.id);
    }
    await writeStorage({ [STORAGE.logs]: logs, [STORAGE.logOutbox]: [...outbox] });
  }),
});

async function recordLog(level, area, event, message, details = {}, { remote = true } = {}) {
  try {
    if (diagnosticsSuspended) return false;
    details = filterRoutineLog(level, area, event, details);
    if (details === null) return false;
    return diagnosticBuffer.enqueue({ level, area, event, message, details }, { remote });
  } catch {
    // Admission and persistence failures cannot interrupt message processing.
    return false;
  }
}

async function recordUnexpected(scope, error, details = {}) {
  const diagnostics = sanitizeSendDiagnostics(details) ?? sanitizeSendDiagnostics(error?.diagnostics);
  const structuredError = diagnostics ? {
    message: typeof error?.message === "string" ? error.message : String(error ?? "Unknown error."),
    name: error?.name,
    stack: error?.stack,
    cause: error?.cause,
    server_error_code: error?.server_error_code,
    http_status: error?.http_status,
    diagnostics,
  } : error;
  await recordLog("error", scope, "failed", "Extension operation failed.", {
    ...diagnosticErrorDetails(structuredError),
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
  const account = matches.length === 1 ? matches[0] : null;
  const config = account ? findAccountConfig(stored[STORAGE.config], account) : (stored[STORAGE.config]?.accounts ?? []).find(
    (candidate) => candidate?.provider === "line_oa"
      && canonicalProviderAccountId({ config: candidate, account: candidate }) === id
      && (!providerId || candidate.provider === providerId),
  );
  const configuredAccount = account ?? (config ? {
    provider: config.provider,
    provider_account_id: config.provider_account_id,
  } : null);
  if (!configuredAccount) return null;
  const key = accountConfigKey(configuredAccount);
  const adapter = providerAdapterForAccount(configuredAccount);
  if (config && accountMigration(config, stored[STORAGE.config]?.version).status === "invalid") return null;
  return key && config && adapter ? { key, config, account: configuredAccount, adapter } : null;
}

function configuredAccountContexts(stored) {
  const accounts = [...detectedAccounts(stored)];
  for (const config of stored[STORAGE.config]?.accounts ?? []) {
    if (config.provider !== "line_oa") continue;
    if (accounts.some((account) => account.provider === config.provider
      && account.provider_account_id === config.provider_account_id)) continue;
    accounts.push({ provider: config.provider, provider_account_id: config.provider_account_id });
  }
  return accounts.map((account) => {
    const config = findAccountConfig(stored[STORAGE.config], account);
    const key = accountConfigKey(account);
    const adapter = providerAdapterForAccount(account);
    const migration = config && accountMigration(config, stored[STORAGE.config]?.version);
    if (migration?.status === "invalid") {
      return null;
    }
    return key && config && adapter ? { key, config, account, adapter } : null;
  }).filter(Boolean);
}

function liveCommandContexts(contexts) {
  return contexts.filter((context) => (context?.adapter?.sendCommands?.length ?? 0) > 0);
}

// A single observation drives status, session eligibility and command selection.
// Only a missing response can use evidence from the same tab/session context.
function providerSessionEpoch(provider) {
  return providerSessionEpochs.get(provider) ?? 0;
}

function providerTabContext(tab, provider) {
  return `${provider}:${providerSessionEpoch(provider)}:${tab.id}:${providerTabEpochs.get(tab.id) ?? 0}:${tab.url ?? ""}`;
}

function providerCommandCapabilities(status, context) {
  if (context.adapter.id === "line_oa") return status?.command_capabilities_by_account?.[context.account.provider_account_id];
  return providerTabCanSend(status, context)
    ? context.adapter.sendCommands.filter((command) => command !== "send_video" || status?.capabilities?.send_video === true)
    : [];
}

function providerStatusMeetsPolicy(status, context) {
  const capabilities = providerCommandCapabilities(status, context);
  return providerTabCanSend(status, context) && providerTabHealthy(status, context.adapter)
    && Array.isArray(capabilities) && capabilities.includes("send_text");
}

function invalidateBridgeVerification(tabId) {
  const check = providerBridgeChecks.get(tabId);
  if (check) check.verified = false;
}

// A transport/probe failure is missing evidence, not a provider rejection.
function providerStatusEvidence(status) {
  return status?.provider_check_outcome === "unknown" ? null : status;
}

async function providerReadiness(context, { tabs, statuses, epoch, tabContexts, observation = ++providerObservationSequence } = {}) {
  const adapter = context.adapter;
  providerPolicyContexts.set(context.key, context);
  const observedEpoch = epoch ?? providerSessionEpoch(adapter.id);
  const observedTabs = tabs ?? await providerChatTabs(adapter);
  const observedTabContexts = tabContexts ?? observedTabs.map((tab) => providerTabContext(tab, adapter.id));
  const reportedStatuses = statuses ?? await Promise.all(observedTabs.map(providerTabStatus));
  const observedStatuses = reportedStatuses.map(providerStatusEvidence);
  // Navigation/replacement invalidates pending reads; a late response never restores readiness.
  if (observedEpoch !== providerSessionEpoch(adapter.id)
    || observedTabs.some((tab, index) => observedTabContexts[index] !== providerTabContext(tab, adapter.id))) return sessionEligibility.state(context.key);
  if ((providerPolicyObservations.get(context.key) ?? 0) > observation) return sessionEligibility.state(context.key);
  providerPolicyObservations.set(context.key, observation);
  const previous = sessionEligibility.state(context.key);
  const identityMatches = (status) => adapter.id === "shopee"
    ? status?.current_provider_account_id === context.account.provider_account_id
    : status?.account_access_verified === true && status.accessible_account_ids?.includes(context.account.provider_account_id);
  // A known different Shopee account still blocks even when its polling check is unavailable.
  const identities = new Set(reportedStatuses.map((status) => status?.current_provider_account_id).filter(Boolean));
  const conflict = adapter.id === "shopee" && identities.size > 1;
  const matchingTab = orderProviderTabs(adapter, observedTabs).find((candidate) => {
    const status = observedStatuses[observedTabs.findIndex((tab) => tab.id === candidate.id)];
    return identityMatches(status) && providerStatusMeetsPolicy(status, context);
  });
  const matchingIndex = matchingTab ? observedTabs.findIndex((tab) => tab.id === matchingTab.id) : -1;
  const previousTabId = previous?.last_evidence?.tab.id;
  const previousIndex = observedTabs.findIndex((tab) => tab.id === previousTabId);
  const matching = observedStatuses.findIndex(identityMatches);
  const index = matchingIndex >= 0 ? matchingIndex : previousIndex >= 0 ? previousIndex : matching >= 0 ? matching : 0;
  const tab = observedTabs[index];
  const status = observedStatuses[index] ?? null;
  const mismatch = conflict || (adapter.id === "shopee"
    ? identities.size > 0 && !identities.has(context.account.provider_account_id)
    : observedStatuses.some((item) => item?.account_access_verified === true) && matching < 0);
  const responded = Boolean(status);
  const verified = responded && identityMatches(status) && !conflict;
  const ready = verified && providerStatusMeetsPolicy(status, context);
  providerPolicyTabIds.set(context.key, tab?.id ?? null);
  const policy = sessionEligibility.observe(context.key, {
    hasTab: observedTabs.length > 0,
    verified: responded, // A confirmed negative cannot consume missing-response grace.
    account_verified: verified,
    explicitMismatch: mismatch,
    identity: mismatch ? adapter.id === "shopee" ? [...identities].sort().join(",") : "inaccessible" : context.account.provider_account_id,
    context: tab ? providerTabContext(tab, adapter.id) : `${adapter.id}:${observedEpoch}:missing`,
    ready,
    reason_code: !verified ? "provider_account_unverified" : !providerTabCanSend(status, context)
      ? "provider_capability_unavailable" : `${adapter.id}_realtime_disconnected`,
    evidence: ready ? { tab, status, command_capabilities: providerCommandCapabilities(status, context) } : null,
  });
  const active = policy.eligible;
  await updateLiveState(context, {
    eligibility_reason_code: policy.reason_code,
    session_generation: policy.generation,
    active_in_profile: active,
    active_provider_account_id: active ? context.account.provider_account_id : null,
    provider_session_reason_code: active ? null : conflict ? "session_conflict" : mismatch ? "account_mismatch" : policy.reason_code,
    readiness_grace_expires_at: policy.readiness_grace_expires_at ?? null,
    ...(!policy.retain_transport ? { socket: "inactive", leader: false, leader_installation_id: null,
      provider_recovery_state: null, provider_recovery_reason: null, provider_recovery_tab_id: null } : {}),
  });
  if (observedEpoch !== providerSessionEpoch(adapter.id)
    || observedTabs.some((tab, index) => observedTabContexts[index] !== providerTabContext(tab, adapter.id))) return sessionEligibility.state(context.key);
  return { ...policy, observed_status: status, observed_tab: tab };
}

async function lineSessionContexts(contexts, { refresh = false, forRecovery = true } = {}) {
  const line = contexts.filter((context) => context.adapter.id === "line_oa");
  if (!line.length) return contexts;
  const adapter = line[0].adapter;
  const epoch = providerSessionEpoch(adapter.id);
  const observation = ++providerObservationSequence;
  const tabs = await providerChatTabs(adapter);
  const tabContexts = tabs.map((tab) => providerTabContext(tab, adapter.id));
  const statuses = await Promise.all(tabs.map(async (tab) => {
    if (refresh) {
      try {
        await ensureProviderBridge(tab.id, adapter);
        const result = await sendProviderMessage(tab.id, { type: "detect_account_v3", provider: adapter.id }, {
          label: "LINE OA", operation: "access check", timeoutMs: 25_000,
        });
        if (!result?.ok) return { ok: false, provider_check_outcome: result?.provider_check_outcome };
      } catch { return null; }
    }
    return providerTabStatus(tab);
  }));
  const eligible = new Set();
  for (const context of line) {
    const policy = await providerReadiness(context, { tabs, statuses, epoch, tabContexts, observation });
    if (policy?.eligible || (forRecovery && policy?.account_verified)) eligible.add(context.key);
  }
  return contexts.filter((context) => context.adapter.id !== "line_oa" || eligible.has(context.key));
}

async function activeLiveCommandContexts(contexts, { forRecovery = false } = {}) {
  const candidates = await lineSessionContexts(liveCommandContexts(contexts), { forRecovery });
  const shopee = candidates.filter((context) => context.adapter.id === "shopee");
  if (!shopee.length) return candidates;
  const epoch = providerSessionEpoch("shopee");
  const observation = ++providerObservationSequence;
  const tabs = await providerChatTabs(shopeeAdapter);
  const tabContexts = tabs.map((tab) => providerTabContext(tab, "shopee"));
  let statuses = await Promise.all(tabs.map(providerTabStatus));
  if (new Set(statuses.map((status) => status?.current_provider_account_id).filter(Boolean)).size > 1) {
    const refreshed = await Promise.all(tabs.map(async (tab) => {
      try {
        const result = await sendProviderMessage(tab.id, { type: "detect_account_v3", provider: "shopee" }, {
          label: "Shopee", operation: "session check", timeoutMs: 15_000,
        });
        return result?.ok ? await providerTabStatus(tab) : null;
      } catch { return null; }
    }));
    if (refreshed.every((status) => status?.current_provider_account_id)) statuses = refreshed;
  }
  const eligible = new Set();
  for (const context of shopee) {
    const policy = await providerReadiness(context, { tabs, statuses, epoch, tabContexts, observation });
    if (policy?.eligible || (forRecovery && policy?.account_verified)) eligible.add(context.key);
  }
  return candidates.filter((context) => context.adapter.id !== "shopee" || eligible.has(context.key));
}

function messageProviderAccountId(message) {
  const value = message?.provider_account_id;
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function canonicalProviderAccountId(context) {
  const accountId = context?.account?.provider_account_id ?? "";
  if (context?.account?.provider !== "line_oa") return accountId;
  const canonical = context?.config?.canonical_provider_account_id;
  if (typeof canonical === "string" && canonical.trim()) return canonical.trim();
  const apiUrl = context?.config?.api_url;
  if (!apiUrl) return accountId;
  const route = new URL(apiUrl).pathname.match(/^\/api\/omnichat\/line_oa\/([^/]+)\/([^/]+)\/?$/);
  if (!route) return accountId;
  return decodeURIComponent(route[2]);
}

function hasServerInitialized(stored) {
  return stored[STORAGE.serverInitialized] === true;
}

// Account containers share storage keys. Keep their read/modify/write operations
// ordered independently of the workflow queue, without holding this queue over provider or delivery requests.
let accountStorageQueue = Promise.resolve();
function serializeAccountStorage(task) {
  const operation = accountStorageQueue.then(task);
  accountStorageQueue = operation.catch(() => undefined);
  return operation;
}

async function updateScopedState(storageKey, key, patch) {
  return serializeAccountStorage(async () => {
    const stored = await readStorage([storageKey]);
    const current = readAccountState(stored[storageKey], key, {});
    await writeStorage({
      [storageKey]: writeAccountState(stored[storageKey], key, {
        ...current,
        ...(typeof patch === "function" ? patch(current) : patch),
      }),
    });
  });
}

let liveStateWriteQueue = Promise.resolve();
function queueLiveStateWrite(write) {
  const operation = liveStateWriteQueue.then(write);
  liveStateWriteQueue = operation.catch(() => undefined);
  return operation;
}

function updateLiveState(context, patch) {
  return queueLiveStateWrite(() => writeLiveState(context, patch));
}

async function writeLiveState(context, patch) {
  const stored = await readStorage([STORAGE.live]);
  const current = readAccountState(stored[STORAGE.live], context.key, {});
  if (Object.entries(patch).every(([key, value]) => current[key] === value)) return;
  await writeStorage({
    [STORAGE.live]: writeAccountState(stored[STORAGE.live], context.key, {
      ...current,
      ...patch,
      updated_at: new Date().toISOString(),
    }),
  });
}

async function persistProviderSurfaceState(context, adapter, providerStatus, tab) {
  const surface = typeof providerStatus?.surface === "string" && providerStatus.surface.trim()
    ? providerStatus.surface.trim()
    : adapter?.surfaceForUrl?.(tab?.url) ?? null;
  if (!surface) return;
  await updateLiveState(context, {
    provider_surface: surface,
    provider_surface_ready: providerStatus?.surface_ready === true,
    provider_chat_open: typeof providerStatus?.chat_open === "boolean" ? providerStatus.chat_open : null,
    provider_realtime_connected: providerStatus?.realtime_connected === true,
    provider_realtime_transport: typeof providerStatus?.realtime_transport === "string"
      ? providerStatus.realtime_transport
      : null,
    provider_status_at: new Date().toISOString(),
    ...(providerTabCanSend(providerStatus, context) && providerTabHealthy(providerStatus, adapter) ? {
      provider_recovery_state: PROVIDER_RECOVERY_STATES.ready,
      provider_recovery_reason: null,
      provider_recovery_tab_id: tab?.id ?? null,
    } : {}),
  });
}

async function getAccountScanState(providerAccountId, provider = "") {
  return serializeAccountStorage(async () => {
    const stored = await readStorage([
      STORAGE.config,
      STORAGE.consent,
      STORAGE.detectedAccounts,
      STORAGE.pending,
      STORAGE.scanState,
      STORAGE.status,
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
  });
}

async function clearDeliveryRetryAlarmIfIdle() {
  const stored = await readStorage([
    STORAGE.config,
    STORAGE.detectedAccounts,
    STORAGE.pending,
  ]);
  const hasPending = configuredAccountContexts(stored).some((context) => (
    readAccountState(stored[STORAGE.pending], context.key, []).length > 0
  ));
  if (!hasPending) await clearDeliveryRetryAlarm();
}

async function discardPending(providerAccountId, provider = "") {
  const { context, discarded, discardWatermark } = await serializeAccountStorage(async () => {
    const stored = await readStorage([
      STORAGE.config,
      STORAGE.consent,
      STORAGE.detectedAccounts,
      STORAGE.pending,
      STORAGE.scanState,
      STORAGE.status,
      STORAGE.deliveryRetry,
    ]);
    const context = accountContextFor(stored, providerAccountId, provider);
    if (!hasLocalConsent(stored[STORAGE.consent]) || !context) {
      throw new Error("Provider browser bridge is not configured.");
    }
    const scanState = readAccountState(stored[STORAGE.scanState], context.key, null);
    const currentStatus = readAccountState(stored[STORAGE.status], context.key, {});
    if (scanState?.in_progress === true || ["discovering", "syncing"].includes(currentStatus.state)) {
      throw new Error("Cancel sync before discarding pending messages.");
    }
    const pending = readAccountState(stored[STORAGE.pending], context.key, []);
    const discarded = pending.length;
    const discardedAt = new Date().toISOString();
    const discardedAtMs = Date.parse(discardedAt);
    const currentWatermarkMs = Date.parse(scanState?.watermark ?? "");
    const discardWatermark = discarded > 0
      ? Number.isFinite(currentWatermarkMs) && currentWatermarkMs > discardedAtMs
        ? scanState.watermark
        : discardedAt
      : scanState?.watermark ?? null;
    const nextScanState = discarded > 0
      ? {
        ...(scanState && typeof scanState === "object" ? scanState : {}),
        version: 1,
        watermark: discardWatermark,
        conversations: scanState?.conversations ?? {},
        bootstrap: null,
        in_progress: false,
        last_auto_at: scanState?.last_auto_at ?? null,
        updated_at: discardedAt,
      }
      : scanState;
    const nextStatus = {
      ...currentStatus,
      ...(discarded > 0
        ? {
          state: "watching",
          phase: null,
          caught_up: true,
          sync_error: null,
          sync_error_at: null,
        }
        : {}),
      delivery_error: null,
      delivery_error_at: null,
      pending: 0,
      ...(currentStatus.last_result
        ? { last_result: { ...currentStatus.last_result, pending: 0 } }
        : {}),
    };
    const writes = {
      [STORAGE.pending]: writeAccountState(stored[STORAGE.pending], context.key, []),
      [STORAGE.deliveryRetry]: writeAccountState(
        stored[STORAGE.deliveryRetry],
        context.key,
        { attempt: 0, next_at: null },
      ),
      [STORAGE.status]: writeAccountState(stored[STORAGE.status], context.key, nextStatus),
    };
    if (nextScanState) {
      writes[STORAGE.scanState] = writeAccountState(
        stored[STORAGE.scanState],
        context.key,
        nextScanState,
      );
    }
    await writeStorage(writes);
    return { context, discarded, discardWatermark };
  });
  await clearDeliveryRetryAlarmIfIdle();
  if (discarded) {
    await recordLog("warn", "delivery", "discarded", "Pending messages discarded by user; sync watermark advanced.", {
      provider: context.account.provider,
      provider_account_id: context.account.provider_account_id,
      discarded,
      watermark: discardWatermark,
      watermark_advanced: true,
    });
  }
  return { discarded, pending: 0, watermark: discardWatermark };
}

async function writeAccountScanState(context, patch) {
  return updateScopedState(STORAGE.scanState, context.key, (current) => ({
    ...(typeof patch === "function" ? patch(current) : patch),
    version: 1,
    updated_at: new Date().toISOString(),
  }));
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
  const { context, state } = await getAccountScanState(providerAccountId, provider);
  if (state.watermark || state.bootstrap?.conversations?.length) return;
  const selected = (Array.isArray(conversations) ? conversations : [])
    .map(bootstrapConversation)
    .filter(Boolean)
    .slice(0, 10);
  if (!selected.length) return;
  await writeAccountScanState(context, {
    bootstrap: { conversations: selected },
    in_progress: true,
  });
}

async function recordHistoryWindow(providerAccountId, historyDays, provider = "") {
  const days = Number(historyDays);
  if (!Number.isInteger(days) || days < 1) return;
  const { context, state } = await getAccountScanState(providerAccountId, provider);
  const previous = Number(state.history_window_days) || 0;
  if (previous >= days) return;
  await writeAccountScanState(context, {
    history_window_days: days,
  });
}

async function recordHistoryBackfill(providerAccountId, conversationId, historyDays, provider = "") {
  const id = String(conversationId ?? "").trim();
  const days = Number(historyDays);
  if (!id || !Number.isInteger(days) || days < 1) return;
  const { context, state } = await getAccountScanState(providerAccountId, provider);
  const previous = Number(state.history_backfill?.[id]) || 0;
  if (previous >= days) return;
  await writeAccountScanState(context, (current) => ({
    history_backfill: {
      ...(current.history_backfill ?? {}),
      [id]: days,
    },
  }));
}

async function advanceScanCursor(providerAccountId, conversationId, cursor, provider = "") {
  const id = String(conversationId ?? "").trim();
  if (!id) return;
  const { context } = await getAccountScanState(providerAccountId, provider);
  await writeAccountScanState(context, (current) => {
    const previous = current.conversations?.[id];
    const next = cursor && compareMessageCursor(cursor, previous) > 0
      ? { event_timestamp: cursor.event_timestamp, message_id: cursor.message_id }
      : { ...(previous ?? {}) };
    delete next.summary_token;
    if (!next.event_timestamp) return {};
    return { conversations: { ...(current.conversations ?? {}), [id]: next } };
  });
}

function exclusive(task) {
  const result = mutationQueue.then(task, task);
  mutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

function currentExtensionVersion() {
  return chrome.runtime.getManifest().version;
}

function updateStateForCurrentVersion(state) {
  return state?.installed_version === currentExtensionVersion() ? state : null;
}

async function storeExtensionUpdate(state) {
  await writeStorage({ [STORAGE.extensionUpdate]: { ...state, installed_version: currentExtensionVersion() } });
}

async function checkForExtensionUpdate({ force = false } = {}) {
  const stored = await readStorage([STORAGE.extensionUpdate]);
  const state = updateStateForCurrentVersion(stored[STORAGE.extensionUpdate]);
  const now = Date.now();
  if (!force && state?.status === "current" && now - state.checked_at < UPDATE_CHECK_CACHE_MS) return state;
  if (!force && state?.attempted_at && now - state.attempted_at < UPDATE_RETRY_DELAY_MS) return state;

  try {
    const result = await chrome.runtime.requestUpdateCheck();
    const next = {
      status: result.status === "update_available" ? "available" : result.status === "no_update" ? "current" : "unknown",
      ...(typeof result.version === "string" ? { available_version: result.version } : {}),
      attempted_at: now,
      ...(result.status === "no_update" ? { checked_at: now } : {}),
    };
    await storeExtensionUpdate(next);
    return { ...next, installed_version: currentExtensionVersion() };
  } catch {
    const next = { status: "unknown", attempted_at: now };
    await storeExtensionUpdate(next);
    return { ...next, installed_version: currentExtensionVersion() };
  }
}

async function applyExtensionUpdate() {
  const stored = await readStorage([STORAGE.extensionUpdate]);
  if (updateStateForCurrentVersion(stored[STORAGE.extensionUpdate])?.status !== "available") {
    throw new Error("No extension update is ready to install.");
  }
  await storeExtensionUpdate({ status: "updating", attempted_at: Date.now() });
  try {
    await replyQueue.pauseAndDrain();
    await activeSync?.catch(() => undefined);
    await exclusive(async () => {
      chrome.runtime.reload();
    });
  } catch (error) {
    replyQueue.resume();
    throw error;
  }
}

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.type === "prepare_sync_tab") {
    void prepareSyncTab(message.provider, message.tab_id).then(respond,
      () => respond({ ok: false, error: "Could not refresh this tab. Open its provider chat and sync again." }));
    return true;
  }
  if (message?.type === "refresh_metadata") {
    void refreshAccountMetadata(message.provider, message.provider_account_id, message.tab_id).then(respond,
      () => respond({ ok: false, error: "Metadata refresh failed. Cached information was kept." }));
    return true;
  }
  if (message?.type === "cache_profiles") {
    void exclusive(async () => {
      const stored = await readStorage([STORAGE.config, STORAGE.consent, STORAGE.detectedAccounts]);
      if (metadataErasing || !hasLocalConsent(stored[STORAGE.consent])) return { ok: false };
      const adapter = providerAdapterForId(message.provider);
      if (!_sender.tab || !adapter?.matchesUrl(_sender.tab.url)) return { ok: false };
      for (const profile of (Array.isArray(message.profiles) ? message.profiles : []).slice(0, 100)) {
        const context = accountContextFor(stored, profile.provider_account_id, message.provider);
        if (context) await customerMetadata.enrich(await metadataScope(context), {
          conversation_id: profile.conversation_id, participant: profile,
        });
      }
      return { ok: true };
    }).then(respond, () => respond({ ok: false }));
    return true;
  }
  if (message?.type === "check_extension_update") {
    void checkForExtensionUpdate().then(
      (update) => respond({ ok: true, update }),
      (error) => respond({ ok: false, error: String(error) }),
    );
    return true;
  }
  if (message?.type === "apply_extension_update") {
    void applyExtensionUpdate().then(
      () => respond({ ok: true }),
      (error) => respond({ ok: false, error: String(error) }),
    );
    return true;
  }
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
      const previous = stored[STORAGE.detectedAccounts] ?? [];
      const detectedAccounts = mergeDetectedAccounts(previous, accounts);
      const needsWrite = accounts.some((account) => {
        const cached = previous.find((item) => item.provider === account.provider
          && item.provider_account_id === account.provider_account_id);
        return !cached || ["display_name", "avatar_url"].some((field) => !cached[field] && account[field]);
      });
      if (needsWrite) await writeStorage({ [STORAGE.detectedAccounts]: detectedAccounts });
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
    ).then((recorded) => respond({ ok: recorded === true }));
    return true;
  }
  if (message?.type === "erase_local_data") {
    diagnosticsSuspended = true;
    metadataErasing = true;
    metadataEpoch += 1;
    metadataRefreshes.clear();
    const metadataDisposed = customerMetadata.dispose();
    void Promise.all([diagnosticBuffer.discard(), metadataDisposed]).then(() => exclusive(() => mutateLogs(async () => {
      await chrome.alarms.clear(DELIVERY_RETRY_ALARM);
      await chrome.alarms.clear(PROVIDER_HEALTH_ALARM);
      await chrome.alarms.clear(LOG_UPLOAD_ALARM);
      await chrome.storage.local.clear();
    }))).then(
      () => respond({ ok: true }),
      () => respond({ ok: false, error: "Could not erase local extension data." }),
    ).finally(() => {
      customerMetadata = newCustomerMetadataCache();
      metadataErasing = false;
      diagnosticsSuspended = false;
    });
    return true;
  }
  if (message?.type === "submit_logs") {
    void submitLogs().then(respond, () => respond({ ok: false, submitted: 0, error: "Could not submit logs." }));
    return true;
  }
  if (message?.type === "flush_logs") {
    void diagnosticBuffer.drain().then(
      () => respond({ ok: true, diagnostics: diagnosticBuffer.stats() }),
      () => respond({ ok: false, error: "Diagnostic persistence is unavailable." }),
    );
    return true;
  }
  if (message?.type === "clear_logs") {
    void diagnosticBuffer.drain().then(() => mutateLogs(async () => {
      await chrome.alarms.clear(LOG_UPLOAD_ALARM);
      await writeStorage({
        [STORAGE.logs]: [],
        [STORAGE.logOutbox]: [],
      });
    })).then(
      () => respond({ ok: true }),
      (error) => respond({ ok: false, error: String(error) }),
    );
    return true;
  }
  if (message?.type === "get_sync_state") {
    void exclusive(async () => {
      const { state } = await getAccountScanState(message.provider_account_id, message.provider);
      const stored = await readStorage([STORAGE.config]);
      let history = null;
      try {
        history = historySyncSettings(stored[STORAGE.config]);
      } catch {
        history = null;
      }
      return {
        checkpoint: state,
        ...(history ? {
          history_days: history.days,
          history_since_ms: historySinceMs(history.days),
          ...(history.conversation_ids.length
            ? { history_conversation_ids: history.conversation_ids }
            : {}),
        } : {}),
      };
    }).then(
      (result) => respond({ ok: true, ...result }),
      (error) => respond({ ok: false, error: String(error) })
    );
    return true;
  }
  if (message?.type === "discard_pending") {
    void exclusive(() => discardPending(message.provider_account_id, message.provider)).then(
      (result) => respond({ ok: true, ...result }),
      (error) => respond({ ok: false, error: String(error) })
    );
    return true;
  }
  if (message?.type === "queue_messages") {
    void exclusive(() => queueMessages(
      message.messages,
      Boolean(message.flush),
      message.advance_cursor !== false,
    ).then(async (result) => {
      if (message.recovery_page === true) {
        const stored = await readStorage([STORAGE.config, STORAGE.detectedAccounts]);
        const context = accountContextFor(stored, message.provider_account_id, message.provider);
        if (context) await serializeAccountStorage(async () => {
          const current = await readStorage([STORAGE.status]);
          const status = readAccountState(current[STORAGE.status], context.key, {});
          await writeStorage({ [STORAGE.status]: writeAccountState(current[STORAGE.status], context.key, {
            ...status, pages_fetched: (status.pages_fetched ?? 0) + 1,
            last_progress_at: new Date().toISOString(),
          }) });
        });
      }
      return result;
    })).then(
      (result) => respond({ ok: true, ...result }),
      (error) => respond({ ok: false, error: String(error) })
    );
    return true;
  }
  if (message?.type === "flush_now") {
    void attemptAllDeliveries({ resetBackoff: true }).then(
      (result) => respond({ ok: true, ...result }),
      (error) => respond({ ok: false, error: String(error) })
    );
    return true;
  }
  if (message?.type === "flush_pending") {
    void flushAccountPending(message.provider_account_id, message.provider).then(
      (result) => respond({ ok: true, ...result }),
      (error) => respond({ ok: false, error: String(error) })
    );
    return true;
  }
  if (message?.type === "cancel_sync") {
    void cancelActiveSync(message.provider, message.tab_id).then(
      (result) => respond({ ok: true, ...result }),
      (error) => respond({ ok: false, error: String(error) })
    );
    return true;
  }
  if (message?.type === "sync_account") {
    void retryProviderAccount(message).then(
      (result) => respond({ ok: true, ...result }),
      (error) => respond({ ok: false, error: String(error) }),
    );
    return true;
  }
  if (message?.type === "sync_now") {
    void initializeAndStartSync("manual", message.provider).then(
      (result) => respond({ ok: true, ...result }),
      (error) => respond({ ok: false, error: String(error) })
    );
    return true;
  }
  if (message?.type === "auto_sync_now") {
    void startUnattendedSellerCentreSync(message.provider).then(
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
  if (message?.type === "sync_complete") {
    const control = syncControlForMessage(message, _sender?.tab?.id);
    const completion = control?.recoveryCompletion;
    if (!completion || message.provider !== control.adapter?.id
      || message.provider_account_id !== control.providerAccountId
      || message.request_id !== control.providerRequestId || typeof message.result?.ok !== "boolean") {
      respond({ ok: true, skipped: "superseded" });
      return false;
    }
    completion.resolve(message.result);
    respond({ ok: true });
    return false;
  }
  if (message?.type === "sync_activity") {
    const control = syncControlForMessage(message, _sender?.tab?.id);
    if (control) {
      control.touchRecovery?.();
    }
    respond({ ok: true });
    return false;
  }
  if (message?.type === "sync_progress" || message?.type === "sync_phase") {
    const attempt = syncControlForMessage(message, _sender?.tab?.id);
    if (!attempt || message.provider !== attempt.adapter?.id
      || message.provider_account_id !== attempt.providerAccountId) {
      respond({ ok: true, skipped: "superseded" });
      return false;
    }
    attempt.touchRecovery?.();
    void exclusive(() => readStorage([STORAGE.detectedAccounts, STORAGE.status]).then((stored) => {
      if (!isCurrentSyncControl(attempt) || attempt.controller.signal.aborted) return;
      const context = accountContextFor(stored, message.provider_account_id, message.provider);
      if (!context) throw new Error("Provider account is not detected.");
      return updateScopedState(STORAGE.status, context.key, current => {
        if (!["discovering", "syncing"].includes(current.state)) return {};
        const patch = { state: "syncing", last_progress_at: new Date().toISOString() };
        if (typeof message.phase === "string") patch.phase = message.phase;
        for (const field of ["completed_conversations", "total_conversations", "conversation_pages"]) {
          if (Number.isInteger(message[field]) && message[field] >= 0) patch[field] = message[field];
        }
        if (message.conversation_id) patch.active_conversation_id = message.conversation_id;
        return patch;
      });
    })).then(
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
  if (message?.type === "record_history_window") {
    void exclusive(() => recordHistoryWindow(
      message.provider_account_id,
      message.history_days,
      message.provider,
    )).then(
      () => respond({ ok: true }),
      (error) => respond({ ok: false, error: String(error) })
    );
    return true;
  }
  if (message?.type === "record_history_backfill") {
    void exclusive(() => recordHistoryBackfill(
      message.provider_account_id,
      message.conversation_id,
      message.history_days,
      message.provider,
    )).then(
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
    void detectOpenProviderAccount(message?.provider || shopeeAdapter.id, message?.tab_id).then(
      async (result) => {
        const stored = await readStorage([STORAGE.config, STORAGE.detectedAccounts]);
        await activeLiveCommandContexts(configuredAccountContexts(stored));
        respond(result);
        void ensureLiveConnection().catch((error) => recordUnexpected("live_connection", error));
      },
      (error) => respond({ ok: false, error: String(error) })
    ).catch((error) => respond({ ok: false, error: String(error) }));
    return true;
  }
  if (providerAdapterForCommand(message)?.supportsSend(message?.type)) {
    void sendViaProvider(message).then(
      (result) => respond(result),
      async (error) => {
        await recordUnexpected("send_message", error, {
          provider: providerAdapterForCommand(message)?.id,
          command_type: message.type,
          request_id: message.request_id,
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
    void claimLeader(message.tab_id, message.provider).then(respond, async (error) => {
      await recordUnexpected("claim_leader", error);
      respond({ ok: false, error: String(error) });
    });
    return true;
  }
  if (message?.type === "release_leader") {
    void releaseLeader(message.provider).then(respond, async (error) => {
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

function isCurrentSyncControl(control) {
  return Boolean(control && (activeSyncControl === control
    || providerAutomaticRecoveries.get(control.accountKey) === control));
}

function syncControlForMessage(message, tabId) {
  const requestId = String(message.request_id ?? "").split(":")[0];
  return [activeSyncControl, ...providerAutomaticRecoveries.values()].find((control) => control
    && !control.controller.signal.aborted
    && control.tabId === tabId && control.providerRequestId === requestId);
}

async function initializeAndStartSync(trigger, provider = null) {
  await queueLiveStateWrite(() => writeStorage({
    [STORAGE.serverInitialized]: true,
    [STORAGE.logUploadEnabled]: true,
  }));
  await recordLog(
    "info",
    "sync",
    trigger === "automatic" ? "automatic_requested" : "requested",
    trigger === "automatic"
      ? "Automatic sync requested by unattended recovery."
      : "Manual sync requested.",
  );
  if (trigger === "manual") {
    for (const connection of liveConnections.values()) {
      clearTimeout(connection.reconnectTimer);
      connection.reconnectTimer = null;
      connection.reconnectAttempt = 0;
    }
  }
  // Ticket/reconnect backoff must not hold up a user-requested retry.
  void ensureLiveConnection().catch((error) => recordUnexpected("live_connection", error));
  return trigger === "manual" && provider !== "line_oa"
    ? restartSync() : startSync(trigger, false, provider);
}

async function startUnattendedSellerCentreSync(provider) {
  const stored = await readStorage([
    STORAGE.unattendedRecovery,
    STORAGE.consent,
  ]);
  if (
    provider !== shopeeAdapter.id
    || stored[STORAGE.unattendedRecovery] !== true
    || !hasLocalConsent(stored[STORAGE.consent])
  ) {
    return { skipped: "automatic_sync_disabled" };
  }
  return initializeAndStartSync("automatic");
}

function rememberCommandTab(account, tabId) {
  if (rememberedCommandTabs.get(account) === tabId) return Promise.resolve();
  // A queued replacement makes the old memo stale immediately.
  rememberedCommandTabs.delete(account);
  // Different reply accounts can select tabs concurrently. Merge only while
  // holding this short storage queue, never during provider/network work.
  const result = commandTabWriteQueue.then(async () => {
    if (rememberedCommandTabs.get(account) === tabId) return;
    const stored = await readStorage([STORAGE.commandTab]);
    if (readAccountState(stored[STORAGE.commandTab], account, null) !== tabId) {
      await writeStorage({ [STORAGE.commandTab]: writeAccountState(stored[STORAGE.commandTab], account, tabId) });
    }
    rememberedCommandTabs.set(account, tabId);
  });
  commandTabWriteQueue = result.catch(() => undefined);
  return result;
}

async function selectSendContext(context, { expectedGeneration } = {}) {
  const adapter = context?.adapter ?? providerAdapterForAccount(context?.account);
  if (!adapter) throw new Error("Provider adapter is unavailable.");
  const policy = await providerReadiness({ ...context, adapter });
  const tab = policy?.evidence?.tab;
  if (!policy?.eligible || !tab?.id) throw new Error(`${providerLabel(adapter)} on the selected browser is not ready for this account. Verify the provider connection and retry.`);
  if (expectedGeneration !== undefined && policy.generation !== expectedGeneration) {
    throw new Error("Provider session changed while this command was queued. Verify the account and retry.");
  }
  await rememberCommandTab(context.key, tab.id);
  if (!sessionEligibility.isCurrent(context.key, policy.generation)) {
    throw new Error("Provider session changed during tab selection. Verify the account and retry.");
  }
  // Carry this generation through dispatch; never adopt a replacement session.
  return { tab, generation: policy.generation };
}

async function commandTab(context, { createIfMissing = false, prepareForSend = false } = {}) {
  const adapter = context?.adapter ?? providerAdapterForAccount(context?.account);
  if (!adapter) throw new Error("Provider adapter is unavailable.");
  if (prepareForSend) return (await selectSendContext(context)).tab;
  const label = providerLabel(adapter);
  const stored = await readStorage([STORAGE.commandTab, STORAGE.providerRecoveryTabs]);
  const tabId = readAccountState(stored[STORAGE.commandTab], context.key, null);
  const tabs = await providerChatTabs(adapter);
  const recoveryTabId = providerRecoveryRecord(stored[STORAGE.providerRecoveryTabs], adapter.id)?.tab_id;
  const trackedTab = await getTab(recoveryTabId);
  const selectedTab = trackedTab
    || (Number.isInteger(tabId) ? tabs.find((tab) => tab.id === tabId) ?? null : null);
  const orderedTabs = orderProviderTabs(
    adapter,
    trackedTab && !tabs.some((tab) => tab.id === trackedTab.id) ? [trackedTab, ...tabs] : tabs,
    trackedTab?.id ?? tabId,
  );
  let tab = null;
  for (const candidate of orderedTabs) {
    if (adapter.matchesUrl(candidate.url) && providerTabCanSend(await providerTabStatus(candidate), context)) {
      tab = candidate;
      break;
    }
  }
  if (!tab) tab = orderedTabs[0] ?? selectedTab ?? null;
  const chatUrl = typeof adapter.chatUrlForAccount === "function"
    ? adapter.chatUrlForAccount(context.account)
    : adapter.chatUrl;
  if (!tab && createIfMissing && typeof chatUrl === "string" && chatUrl.trim()) {
    const recovery = await ensureProviderRecoveryTab(adapter, context, true);
    tab = recovery.tab;
  }
  if (!tab?.id) {
    await recordLog("warn", "provider", "tab_missing", `${label} chat tab is unavailable for an outbound reply.`, {
      provider: adapter.id,
      provider_account_id: context.account.provider_account_id,
    });
    throw new Error(`The browser selected to send this reply has no ${label} tab open. Open the matching chat on that browser or use a ready browser as leader.`);
  }
  if (!providerTabCanSend(await providerTabStatus(tab), context)) {
    await recordLog("warn", "provider", "surface_unready", `${label} chat surface is not ready for commands.`, {
      provider: adapter.id,
      surface: adapter.surfaceForUrl?.(tab.url) ?? null,
    });
  }
  await rememberCommandTab(context.key, tab.id);
  return tab;
}

function providerAdapterForCommand(message) {
  return providerAdapterForId(messageProvider(message));
}

async function sendViaProvider(message, { expectedGeneration } = {}) {
  const adapter = providerAdapterForCommand(message);
  if (!adapter?.supportsSend(message?.type)) return { ok: false, error: "Unsupported provider reply command." };
  const requestId = typeof message?.request_id === "string" ? message.request_id : "";
  const conversationId = typeof message?.conversation_id === "string" ? message.conversation_id : "";
  const clientMessageId = typeof message?.client_message_id === "string" ? message.client_message_id : "";
  const commandType = typeof message?.type === "string" ? message.type : "";
  if (!requestId || !conversationId || !adapter.supportsSend(commandType)) {
    return { ok: false, error: "Reply command is invalid." };
  }
  if (Number.isFinite(message.deadline_at_ms) && message.deadline_at_ms <= Date.now()) return { ok: false, error: "Reply deadline expired before sending." };
  const stored = await readStorage([STORAGE.config, STORAGE.detectedAccounts]);
  const context = accountContextFor(stored, messageProviderAccountId(message), adapter.id);
  if (!context) return { ok: false, error: `${providerLabel(adapter)} browser bridge is not configured.` };
  const { tab, generation: selectedGeneration } = await selectSendContext(context, { expectedGeneration });
  await ensureProviderBridge(tab.id, adapter, { reuseVerified: true });
  let imagePayload = {};
  if (["send_image", "send_video", "send_file"].includes(commandType)) {
    const imageUrl = typeof (message.image_url ?? message.media_url) === "string" ? (message.image_url ?? message.media_url) : "";
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
    const response = await fetch(parsedUrl, { ...(adapter.id === "line_oa" ? { redirect: "error" } : {}), signal: AbortSignal.timeout(Math.max(1, Math.min(20_000, (message.deadline_at_ms ?? Date.now() + 20_000) - Date.now()))) });
    const imageType = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
    if (!response.ok || (commandType === "send_image" && !imageType.startsWith("image/")) || (adapter.id === "shopee" && commandType === "send_video" && imageType !== "video/mp4")) {
      return { ok: false, error: "Could not load reply image.", diagnostics: {
        diagnostic_version: 1, provider: adapter.id, operation: "upload", stage: "media_download", command_type: commandType,
        http_status: response.status, native_attempted: false, delivery_uncertain: false,
        failure_kind: "pre_dispatch_failure",
      } };
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.byteLength || bytes.byteLength > (commandType === "send_video" && adapter.id === "shopee" ? 5 * 1024 * 1024 : adapter.id === "line_oa" ? (commandType === "send_image" ? 20 : 32) * 1024 * 1024 : MAX_REPLY_IMAGE_BYTES)) {
      return { ok: false, error: adapter.id === "shopee" && commandType === "send_video" ? "Shopee video must be 5 MB or smaller." : adapter.id === "line_oa" ? `Reply attachment must be ${commandType === "send_image" ? 20 : 32} MB or smaller.` : "Reply image must be 10 MB or smaller." };
    }
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 32_768) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
    }
    imagePayload = commandType === "send_image"
      ? { image_base64: btoa(binary), image_type: imageType }
      : { media_base64: btoa(binary), media_type: imageType };
  }
  if (!sessionEligibility.isCurrent(context.key, selectedGeneration)) {
    return { ok: false, error: "Provider readiness or session changed before the reply attempt. Verify the account and retry." };
  }
  const result = await chrome.tabs.sendMessage(tab.id, {
    ...message,
    ...imagePayload,
    provider: adapter.id,
    type: "send_api_v3",
    command_type: commandType,
    request_id: requestId,
    conversation_id: conversationId,
    ...(adapter.id === "line_oa" ? { browser_provider_account_id: context.account.provider_account_id } : {}),
    ...(clientMessageId ? { client_message_id: clientMessageId } : {}),
  });
  if (!result || typeof result !== "object") return result;
  const { diagnostics, ...reply } = result;
  const safeDiagnostics = sanitizeSendDiagnostics(diagnostics);
  return { ...reply, ...(safeDiagnostics ? { diagnostics: safeDiagnostics } : {}) };
}

async function selectCommandTab(context, tabId) {
  if (!Number.isInteger(tabId)) return;
  const adapter = context?.adapter ?? providerAdapterForAccount(context?.account);
  const tab = await chrome.tabs.get(tabId);
  if (!Number.isInteger(tab.id) || !adapter?.matchesUrl(tab.url)) {
    throw new Error(`Open ${providerLabel(adapter)} chat in this tab first.`);
  }
  await rememberCommandTab(context.key, tab.id);
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
  const api = apiEndpoint(config, "tickets");
  if (api) return api;
  if (typeof config?.commands_url !== "string") return null;
  try {
    const url = new URL(config.commands_url);
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function apiEndpoint(config, action) {
  if (typeof config?.api_url !== "string") return null;
  try {
    const url = new URL(config.api_url);
    if (url.protocol !== "https:") return null;
    const basePath = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
    url.pathname = `${basePath}/${action}`;
    return url;
  } catch {
    return null;
  }
}

function leaderEndpoint(config) {
  const control = apiEndpoint(config, "control");
  if (control) return control;
  const url = liveEndpoint(config);
  if (!url) return null;
  const pathSegments = url.pathname.split("/").filter(Boolean);
  const fallbackPath = pathSegments.length >= 4 ? "/control" : "/leader";
  url.pathname = url.pathname.replace(/\/tickets$/, fallbackPath);
  return url;
}

async function signedApiPing(context) {
  const url = apiEndpoint(context.config, "ping");
  if (!url) throw new Error("API endpoint is not configured.");
  const body = JSON.stringify({
    schema: "omnichat.ping",
    version: 1,
    provider: context.account.provider,
    installation_id: await installationId(),
  });
  const timestamp = new Date().toISOString();
  const nonce = crypto.randomUUID();
  const bodyHash = await sha256Hex(body);
  const signature = await hmacHex(context.config.hmac_secret, `POST\n${url.pathname}\n${timestamp}\n${nonce}\n${bodyHash}`);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_PING_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-omnichat-timestamp": timestamp,
        "x-omnichat-nonce": nonce,
        "x-omnichat-signature": signature,
      },
      body,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`API ping returned ${response.status}.`);
    const result = await response.json();
    if (result?.schema !== "omnichat.ping_ack" || result?.version !== 1 || result?.ok !== true) {
      throw new Error("API ping returned an invalid acknowledgement.");
    }
    return result;
  } finally {
    clearTimeout(timeoutId);
  }
}

function pingAccountApi(context, { force = false } = {}) {
  const url = apiEndpoint(context.config, "ping");
  if (!url) return null;
  const urlString = url.toString();
  const previous = apiPingAttempts.get(context.key);
  if (previous?.url === urlString
    && (previous.promise || (!force && Date.now() - previous.at < API_PING_COOLDOWN_MS))) {
    return previous.promise;
  }
  const details = {
    provider: context.account.provider,
    provider_account_id: context.account.provider_account_id,
  };
  const promise = signedApiPing(context)
    .then(() => recordLog("debug", "api", "ping_succeeded", "Omnichat API ping succeeded.", details))
    .catch((error) => recordUnexpected("api_ping", error, details))
    .finally(() => {
      const current = apiPingAttempts.get(context.key);
      if (current?.promise === promise) {
        apiPingAttempts.set(context.key, { url: urlString, at: Date.now(), promise: null });
      }
    });
  apiPingAttempts.set(context.key, { url: urlString, at: Date.now(), promise });
  return promise;
}

function ensureApiPings(contexts, options) {
  for (const context of contexts) void pingAccountApi(context, options);
}

function apiPingContexts(contexts) {
  return contexts.filter((context) => apiEndpoint(context.config, "ping"));
}

async function ensureApiPingAlarm(shouldRun) {
  if (!shouldRun) {
    await chrome.alarms.clear(API_PING_ALARM);
    return;
  }
  const existing = await chrome.alarms.get(API_PING_ALARM);
  if (Number(existing?.periodInMinutes) === API_PING_INTERVAL_MINUTES) return;
  chrome.alarms.create(API_PING_ALARM, {
    delayInMinutes: API_PING_INTERVAL_MINUTES,
    periodInMinutes: API_PING_INTERVAL_MINUTES,
  });
}

async function ensureProviderHealthAlarm(shouldRun) {
  if (!shouldRun) {
    await chrome.alarms.clear(PROVIDER_HEALTH_ALARM);
    return;
  }
  const existing = await chrome.alarms.get(PROVIDER_HEALTH_ALARM);
  if (Number(existing?.periodInMinutes) === PROVIDER_HEALTH_INTERVAL_MINUTES) return;
  await chrome.alarms.create(PROVIDER_HEALTH_ALARM, {
    delayInMinutes: PROVIDER_HEALTH_INTERVAL_MINUTES,
    periodInMinutes: PROVIDER_HEALTH_INTERVAL_MINUTES,
  });
}

function providerRecoveryUrl(adapter, account) {
  if (typeof adapter?.recoveryUrlForAccount === "function") {
    return adapter.recoveryUrlForAccount(account);
  }
  if (typeof adapter?.chatUrlForAccount === "function") {
    return adapter.chatUrlForAccount(account);
  }
  return adapter?.chatUrl;
}

function providerRecoveryContexts(contexts, adapter) {
  return contexts.filter((context) => context.adapter.id === adapter.id);
}

async function updateProviderRecoveryLiveState(contexts, adapter, {
  state = null,
  reason = null,
  tabId = null,
} = {}) {
  for (const context of providerRecoveryContexts(contexts, adapter)) {
    await updateLiveState(context, {
      provider_recovery_state: state,
      provider_recovery_reason: reason,
      provider_recovery_tab_id: Number.isInteger(tabId) ? tabId : null,
    });
  }
}

async function updateProviderRecoveryTabState(provider, patch) {
  return exclusive(async () => {
    const stored = await readStorage([STORAGE.providerRecoveryTabs]);
    const next = updateProviderRecoveryRecord(stored[STORAGE.providerRecoveryTabs], provider, patch);
    await writeStorage({ [STORAGE.providerRecoveryTabs]: next });
    return providerRecoveryRecord(next, provider);
  });
}

async function clearProviderRecoveryLiveState() {
  // Share the readiness write queue with first Sync initialization so cleanup
  // cannot cross the point where the user enables a new connection.
  return queueLiveStateWrite(async () => {
    const stored = await readStorage([
      STORAGE.config, STORAGE.detectedAccounts, STORAGE.consent, STORAGE.serverInitialized,
    ]);
    const contexts = configuredAccountContexts(stored);
    if (contexts.length && hasServerInitialized(stored) && hasLocalConsent(stored[STORAGE.consent])) {
      return false;
    }
    for (const context of contexts) {
      await writeLiveState(context, {
        provider_recovery_state: null,
        provider_recovery_reason: null,
        provider_recovery_tab_id: null,
      });
    }
    stopLiveConnection();
    return true;
  });
}

async function getTab(tabId) {
  if (!Number.isInteger(tabId)) return null;
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
}

async function resolveProviderRecoveryTab(adapter, context, allowTabRecovery) {
  const stored = await readStorage([STORAGE.providerRecoveryTabs]);
  let record = providerRecoveryRecord(stored[STORAGE.providerRecoveryTabs], adapter.id);
  const listedTabs = await providerChatTabs(adapter);
  let trackedTab = await getTab(record?.tab_id);
  // A failed lookup alone does not prove closure. If Chrome cannot enumerate
  // tabs either, fail this check instead of creating a speculative replacement.
  if (!trackedTab && Number.isInteger(record?.tab_id)) {
    trackedTab = (await chrome.tabs.query({})).find((tab) => tab.id === record.tab_id) ?? null;
  }

  if (!trackedTab && record?.tab_id !== null && record?.tab_id !== undefined) {
    record = await updateProviderRecoveryTabState(adapter.id, {
      state: PROVIDER_RECOVERY_STATES.needsAttention,
      tab_id: null,
      reason: "The tracked provider tab is no longer open. A replacement will be created when recovery is enabled.",
    });
  }

  // Prefer the tracked tab, but adopt an already-open healthy matching tab
  // when it cannot recover. Never create another tab while the tracked one exists.
  const orderedTabs = orderProviderTabs(adapter, listedTabs, record?.tab_id);
  const tabs = trackedTab
    ? [trackedTab, ...orderedTabs.filter((tab) => tab.id !== trackedTab.id)]
    : orderedTabs;
  const candidates = [];
  const healthyCandidate = ({ status }) => providerTabHealthy(status, adapter)
    && (adapter.id !== "shopee"
      || status?.current_provider_account_id === context?.account?.provider_account_id);
  let blockedReason = null;
  for (const tab of tabs) {
    if (!adapter.matchesUrl(tab.url)) {
      if (tab.id === trackedTab?.id) {
        blockedReason = `${providerLabel(adapter)} recovery tab needs attention. Return to the provider or sign in using the existing tab.`;
      }
      continue;
    }
    const status = await providerTabStatus(tab);
    if (adapter.id === "shopee" && status?.current_provider_account_id
      && status.current_provider_account_id !== context?.account?.provider_account_id) {
      if (tab.id === trackedTab?.id) {
        blockedReason = `${providerLabel(adapter)} recovery tab is signed into a different account. Open the matching account in the existing tab.`;
      }
      continue;
    }
    candidates.push({ tab, status });
    if (healthyCandidate({ status })) break;
  }
  const selected = candidates.find(healthyCandidate)
    ?? (trackedTab ? candidates.find(({ tab }) => tab.id === trackedTab.id) : candidates[0]);
  if (!selected && trackedTab) {
    record = await updateProviderRecoveryTabState(adapter.id, {
      state: PROVIDER_RECOVERY_STATES.needsAttention, reason: blockedReason,
    });
    return { tab: null, record, reason: blockedReason };
  }
  trackedTab = selected?.tab ?? null;
  if (trackedTab) {
    const isHealthy = healthyCandidate(selected);
    if (record?.tab_id !== trackedTab.id
      || (isHealthy && record?.state !== PROVIDER_RECOVERY_STATES.ready)) {
      record = await updateProviderRecoveryTabState(adapter.id, {
        state: isHealthy ? PROVIDER_RECOVERY_STATES.ready : PROVIDER_RECOVERY_STATES.needsAttention,
        tab_id: trackedTab.id,
        opened_by_extension: record?.tab_id === trackedTab.id ? record?.opened_by_extension === true : false,
        opened_at: record?.opened_at ?? null,
        failure_count: isHealthy ? 0 : record?.failure_count ?? 0,
        last_failure_at: isHealthy ? null : record?.last_failure_at ?? null,
        next_retry_at: isHealthy ? null : record?.next_retry_at ?? null,
        reason: isHealthy ? null : "An existing provider tab needs recovery.",
      });
    }
    return { tab: trackedTab, record };
  }

  // An existing provider session for another account cannot be fixed by
  // opening more tabs into the same session.
  if (orderedTabs.length) {
    return { tab: null, record, reason: `${providerLabel(adapter)} is signed into a different shop or account. Open the matching account in the existing tab.` };
  }

  if (!allowTabRecovery) {
    return {
      tab: null,
      record,
      reason: `Open ${providerLabel(adapter)} in Chrome to start syncing.`,
    };
  }

  if (record && !recoveryRetryDue(record)) {
    return {
      tab: null,
      record,
      reason: record.reason || `${providerLabel(adapter)} recovery is waiting before the next retry.`,
    };
  }

  const openingAt = Date.now();
  record = await updateProviderRecoveryTabState(adapter.id, {
    state: PROVIDER_RECOVERY_STATES.opening,
    tab_id: null,
    opened_by_extension: true,
    opened_at: openingAt,
    failure_count: record?.failure_count ?? 0,
    reason: null,
  });
  let chatUrl;
  try {
    chatUrl = providerRecoveryUrl(adapter, context?.account);
  } catch (error) {
    record = await updateProviderRecoveryTabState(adapter.id, {
      state: PROVIDER_RECOVERY_STATES.needsAttention,
      reason: `${providerLabel(adapter)} recovery URL could not be resolved. ${String(error).slice(0, 180)}`,
      failure_count: (record?.failure_count ?? 0) + 1,
      last_failure_at: Date.now(),
      next_retry_at: Date.now() + recoveryRetryDelay((record?.failure_count ?? 0) + 1),
    });
    return { tab: null, record, reason: record.reason, error };
  }
  if (typeof chatUrl !== "string" || !chatUrl.trim()) {
    record = await updateProviderRecoveryTabState(adapter.id, {
      state: PROVIDER_RECOVERY_STATES.needsAttention,
      reason: `${providerLabel(adapter)} recovery URL is not configured.`,
      failure_count: (record?.failure_count ?? 0) + 1,
      last_failure_at: Date.now(),
      next_retry_at: Date.now() + recoveryRetryDelay((record?.failure_count ?? 0) + 1),
    });
    return { tab: null, record, reason: record.reason };
  }
  try {
    const created = await chrome.tabs.create({ url: chatUrl, active: false });
    if (!Number.isInteger(created?.id)) throw new Error("Chrome did not return a recovery tab ID.");
    record = await updateProviderRecoveryTabState(adapter.id, {
      state: PROVIDER_RECOVERY_STATES.opening,
      tab_id: created.id,
      opened_by_extension: true,
      opened_at: openingAt,
      failure_count: 0,
      last_failure_at: null,
      next_retry_at: null,
      reason: null,
    });
    await recordLog("info", "recovery", "provider_tab_opened", `${providerLabel(adapter)} tab opened for automatic recovery.`, {
      provider: adapter.id,
      tab_id: created.id,
    });
    return { tab: created, record };
  } catch (error) {
    record = await updateProviderRecoveryTabState(adapter.id, {
      state: PROVIDER_RECOVERY_STATES.needsAttention,
      reason: `${providerLabel(adapter)} tab could not be opened. ${String(error).slice(0, 180)}`,
      failure_count: (record?.failure_count ?? 0) + 1,
      last_failure_at: Date.now(),
      next_retry_at: Date.now() + recoveryRetryDelay((record?.failure_count ?? 0) + 1),
    });
    return { tab: null, record, reason: record.reason, error };
  }
}

function ensureProviderRecoveryTab(adapter, context, allowTabRecovery) {
  const existing = providerRecoveryTabLocks.get(adapter.id);
  if (existing) return existing;
  const operation = resolveProviderRecoveryTab(adapter, context, allowTabRecovery);
  providerRecoveryTabLocks.set(adapter.id, operation);
  void operation.then(() => {
    if (providerRecoveryTabLocks.get(adapter.id) === operation) providerRecoveryTabLocks.delete(adapter.id);
  }, () => {
    if (providerRecoveryTabLocks.get(adapter.id) === operation) providerRecoveryTabLocks.delete(adapter.id);
  });
  return operation;
}

function providerRecoveryFailureReason(adapter, tab, status, error) {
  if (tab?.status === "loading") return `${providerLabel(adapter)} is still loading.`;
  if (!adapter.matchesUrl(tab?.url)) {
    return `${providerLabel(adapter)} tab is on a redirect or sign-in page.`;
  }
  if (error) return `${providerLabel(adapter)} bridge is unavailable. ${String(error).slice(0, 180)}`;
  if (!status) return `${providerLabel(adapter)} bridge did not respond to a health check.`;
  if (status.realtime_connected !== true) return `${providerLabel(adapter)} is connected to the extension but not ready to sync.`;
  return `${providerLabel(adapter)} is not ready to sync.`;
}

async function markClosedProviderRecoveryTab(tabId) {
  const changedProviders = await exclusive(async () => {
    const stored = await readStorage([STORAGE.providerRecoveryTabs]);
    const states = normalizeProviderRecoveryTabs(stored[STORAGE.providerRecoveryTabs]);
    const changed = [];
    let next = states;
    for (const [provider, record] of Object.entries(states.providers)) {
      if (record.tab_id !== tabId) continue;
      next = updateProviderRecoveryRecord(next, provider, {
        state: PROVIDER_RECOVERY_STATES.needsAttention,
        tab_id: null,
        last_failure_at: Date.now(),
        next_retry_at: null,
        reason: "The tracked provider tab was closed. Recovery will create one replacement on its next retry.",
      });
      changed.push(provider);
    }
    if (changed.length) await writeStorage({ [STORAGE.providerRecoveryTabs]: next });
    return changed;
  });
  if (!changedProviders.length) return;
  const stored = await readStorage([STORAGE.config, STORAGE.detectedAccounts]);
  const contexts = configuredAccountContexts(stored);
  for (const provider of changedProviders) {
    const adapter = providerAdapters.get(provider);
    if (!adapter) continue;
    const record = providerRecoveryRecord((await readStorage([STORAGE.providerRecoveryTabs]))[STORAGE.providerRecoveryTabs], provider);
    const affected = await activeLiveCommandContexts(contexts);
    await updateProviderRecoveryLiveState(affected, adapter, {
      state: PROVIDER_RECOVERY_STATES.needsAttention,
      reason: record?.reason,
      tabId: null,
    });
    await recordLog("info", "recovery", "provider_tab_closed", `${providerLabel(adapter)} tracked recovery tab was closed.`, {
      provider,
      tab_id: tabId,
    });
  }
}

async function handleProviderRecoveryFailure(adapter, tab, status, recovery, error, contexts) {
  const previousCount = recovery.record?.failure_count ?? 0;
  const failureCount = previousCount + 1;
  const now = Date.now();
  const reason = providerRecoveryFailureReason(adapter, tab, status, error);
  const record = await updateProviderRecoveryTabState(adapter.id, {
    state: PROVIDER_RECOVERY_STATES.needsAttention,
    tab_id: tab?.id ?? recovery.record?.tab_id ?? null,
    failure_count: failureCount,
    last_failure_at: now,
    next_retry_at: null,
    reason,
  });
  await updateProviderRecoveryLiveState(
    contexts,
    adapter,
    { state: PROVIDER_RECOVERY_STATES.needsAttention, reason, tabId: record.tab_id },
  );
}

function startUnattendedProviderSync(tab, context) {
  const tabId = tab?.id;
  const recoveryKey = context?.key;
  if (
    !Number.isInteger(tabId)
    || !recoveryKey
    || activeSync
    || providerAutomaticRecoveries.has(recoveryKey)
  ) return;
  if ((providerAutomaticRetryAt.get(recoveryKey) ?? 0) > Date.now()) return;
  const adapter = context.adapter;
  const control = {
    controller: new AbortController(),
    tabId,
    adapter,
    preferredTabId: tabId,
    restorePolling: true,
    accountKey: recoveryKey,
    sessionGeneration: sessionEligibility.generation(context.key),
  };
  control.completion = runAccountSync("automatic", control, context).then((result) => {
    if (result?.error) throw new Error(result.error);
    providerAutomaticRetryAttempts.delete(recoveryKey);
    providerAutomaticRetryAt.delete(recoveryKey);
    return result;
  }).catch(async (error) => {
    if (control.controller.signal.aborted && error?.name === "AbortError") return;
    const attempts = (providerAutomaticRetryAttempts.get(recoveryKey) ?? 0) + 1;
    providerAutomaticRetryAttempts.set(recoveryKey, attempts);
    providerAutomaticRetryAt.set(recoveryKey, Date.now() + Math.min(30 * 60_000, 60_000 * (2 ** Math.min(attempts - 1, 5))));
    await recordUnexpected("provider_unattended_sync", error, {
      provider: adapter.id,
      provider_account_id: context.account.provider_account_id,
      tab_id: tabId,
      recovery_attempt: attempts,
    });
  }).finally(() => {
    if (providerAutomaticRecoveries.get(recoveryKey) === control) providerAutomaticRecoveries.delete(recoveryKey);
  });
  providerAutomaticRecoveries.set(recoveryKey, control);
  void recordLog("info", "recovery", "provider_sync_started", `${providerLabel(adapter)} unattended recovery sync started.`, {
    provider: adapter.id,
    provider_account_id: context.account.provider_account_id,
  });
}

async function runProviderHealthWatchdogOnce() {
  const stored = await readStorage([
    STORAGE.config,
    STORAGE.consent,
    STORAGE.detectedAccounts,
    STORAGE.serverInitialized,
    STORAGE.unattendedRecovery,
  ]);
  const contexts = configuredAccountContexts(stored);
  const enabled = contexts.length > 0
    && hasServerInitialized(stored)
    && hasLocalConsent(stored[STORAGE.consent]);
  if (!enabled) {
    if (await clearProviderRecoveryLiveState() === false) return runProviderHealthWatchdogOnce();
    await ensureProviderHealthAlarm(false);
    return;
  }
  const allowTabRecovery = stored[STORAGE.unattendedRecovery] === true;
  for (const adapter of providerAdapters.list()) {
    const providerContexts = providerRecoveryContexts(contexts, adapter);
    let matchingContexts = adapter.id === "line_oa"
      ? await lineSessionContexts(providerContexts, { refresh: true })
      : await activeLiveCommandContexts(providerContexts, { forRecovery: true });
    if (adapter.id === "shopee" && providerContexts.length && !matchingContexts.length) {
      // A missing content bridge is not an account conflict. Repair it before
      // deciding which shop can recover; never infer identity from configuration.
      let repaired = false;
      for (const tab of await providerChatTabs(adapter)) {
        if (await providerTabStatus(tab)) continue;
        try {
          await reconnectProviderTab(tab);
          repaired = true;
        } catch (error) {
          await recordUnexpected("provider_bridge_reinject", error, { provider: adapter.id, tab_id: tab.id });
        }
      }
      if (repaired) matchingContexts = await activeLiveCommandContexts(providerContexts, { forRecovery: true });
    }
    if (!matchingContexts.length) {
      // Missing tabs may still be restored by the existing opt-in recovery.
      // Opening a generic chat page does not make any configured shop ready.
      if (["shopee", "line_oa"].includes(adapter.id) && providerContexts.length && allowTabRecovery
        && !(await providerChatTabs(adapter)).length) {
        await ensureProviderRecoveryTab(adapter, providerContexts[0], true);
      }
      continue;
    }
    const context = matchingContexts[0];
    let recovery;
    try {
      recovery = await ensureProviderRecoveryTab(adapter, context, allowTabRecovery);
    } catch (error) {
      await recordUnexpected("provider_watchdog", error, { provider: adapter.id });
      await updateProviderRecoveryLiveState(matchingContexts, adapter, {
        state: PROVIDER_RECOVERY_STATES.needsAttention,
        reason: `${providerLabel(adapter)} recovery check failed. ${String(error).slice(0, 180)}`,
      });
      continue;
    }
    if (recovery.error) {
      await recordUnexpected("provider_watchdog", recovery.error, { provider: adapter.id });
    }
    if (!recovery.tab) {
      await updateProviderRecoveryLiveState(matchingContexts, adapter, {
        state: allowTabRecovery
          ? recovery.record?.state ?? PROVIDER_RECOVERY_STATES.needsAttention
          : PROVIDER_RECOVERY_STATES.needsAttention,
        reason: recovery.reason,
        tabId: recovery.record?.tab_id,
      });
      continue;
    }
    const tab = recovery.tab;
    const closedChatStatus = adapter.id === "shopee" ? await providerTabStatus(tab) : null;
    if (closedChatStatus?.surface === "seller-centre" && closedChatStatus.chat_open === false) {
      for (const item of matchingContexts) await persistProviderSurfaceState(item, adapter, closedChatStatus, tab);
      const reason = "Open Shopee mini-chat to continue syncing.";
      await updateProviderRecoveryTabState(adapter.id, {
        state: PROVIDER_RECOVERY_STATES.needsAttention,
        reason, failure_count: 0, last_failure_at: null, next_retry_at: null,
      });
      await updateProviderRecoveryLiveState(matchingContexts, adapter, {
        state: PROVIDER_RECOVERY_STATES.needsAttention, reason, tabId: tab.id,
      });
      continue;
    }
    try {
      if (!adapter.matchesUrl(tab.url)) {
        await recordLog("warn", "recovery", "provider_tab_redirected", `${providerLabel(adapter)} tracked tab is on a redirect or sign-in page.`, {
          provider: adapter.id,
          tab_id: tab.id,
        });
        throw new Error(`${providerLabel(adapter)} tab is on a redirect or sign-in page.`);
      }
      await reconnectProviderTab(tab);
      const status = await providerTabStatus(tab);
      if (adapter.id === "shopee" && status?.current_provider_account_id !== context.account.provider_account_id) {
        await activeLiveCommandContexts(providerContexts);
        continue;
      }
      if (!providerTabHealthy(status, adapter)) {
        throw new Error(`${providerLabel(adapter)} bridge is not responding to health checks.`);
      }
      const record = recovery.record?.tab_id === tab.id
        ? await updateProviderRecoveryTabState(adapter.id, {
          state: PROVIDER_RECOVERY_STATES.ready,
          reason: null,
          failure_count: 0,
          last_failure_at: null,
          next_retry_at: null,
        })
        : recovery.record;
      for (const item of matchingContexts) {
        const polling = adapter.id === "shopee"
          ? status.current_provider_account_id === item.account.provider_account_id
          : (status.provider_polling_active === true
          && Array.isArray(status.provider_polling_account_ids)
          && status.provider_polling_account_ids.includes(item.account.provider_account_id));
        if (!polling && allowTabRecovery) startUnattendedProviderSync(tab, item);
        await updateProviderRecoveryLiveState([item], adapter, {
          state: polling ? PROVIDER_RECOVERY_STATES.ready : PROVIDER_RECOVERY_STATES.needsAttention,
          reason: polling ? null : adapter.id === "shopee"
            ? "Shopee account changed. Check the connection for this browser."
            : "LINE OA polling is not running for this account. Sync this account to resume.",
          tabId: record?.tab_id ?? tab.id,
        });
      }
    } catch (error) {
      await recordUnexpected("provider_watchdog", error, {
        provider: adapter.id,
        tab_id: tab.id,
      });
      const status = await providerTabStatus(tab);
      await handleProviderRecoveryFailure(adapter, tab, status, recovery, error, matchingContexts);
    }
  }
  await ensureLiveConnection();
  void attemptAllDeliveries({ resetBackoff: false })
    .catch((error) => recordUnexpected("message_delivery", error));
}

async function runProviderHealthWatchdog() {
  if (providerHealthWatchdogPromise) return providerHealthWatchdogPromise;
  const operation = runProviderHealthWatchdogOnce();
  providerHealthWatchdogPromise = operation;
  try {
    return await operation;
  } finally {
    if (providerHealthWatchdogPromise === operation) providerHealthWatchdogPromise = null;
  }
}

async function pingConfiguredAccountApis() {
  const stored = await readStorage([
    STORAGE.config,
    STORAGE.consent,
    STORAGE.detectedAccounts,
    STORAGE.serverInitialized,
  ]);
  const contexts = apiPingContexts(await activeLiveCommandContexts(configuredAccountContexts(stored)));
  const shouldRun = contexts.length > 0
    && hasServerInitialized(stored)
    && hasLocalConsent(stored[STORAGE.consent]);
  if (!shouldRun) {
    await ensureApiPingAlarm(false);
    return;
  }
  ensureApiPings(contexts, { force: true });
}

async function signedLeaderRequest(context, action, signal) {
  if (!context) throw new Error("Provider browser bridge is not configured.");
  const initialized = await readStorage([STORAGE.serverInitialized]);
  if (!hasServerInitialized(initialized)) throw new Error("Sync messages before using live replies.");
  const url = leaderEndpoint(context.config);
  if (!context || !url) throw new Error("Leader endpoint is not configured.");
  const providerAccountId = canonicalProviderAccountId(context);
  const body = JSON.stringify({
    provider: context.account.provider,
    provider_account_id: providerAccountId,
    installation_id: await installationId(),
    action,
  });
  const timestamp = new Date().toISOString();
  const nonce = crypto.randomUUID();
  const signature = await hmacHex(context.config.hmac_secret, `POST\n${url.pathname}\n${timestamp}\n${nonce}\n${await sha256Hex(body)}`);
  const response = await fetch(url, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      "x-omnichat-provider-account-id": providerAccountId,
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
  const configuredContexts = providerAccountId
    ? [accountContextFor(stored, providerAccountId, provider)].filter(Boolean)
    : configuredAccountContexts(stored);
  const contexts = await activeLiveCommandContexts(configuredContexts);
  if (!contexts.length) return { ok: false, error: "No configured provider accounts support live commands." };
  const results = [];
  for (const context of contexts) {
    try {
      results.push(await signedLeaderRequest(context, "status"));
    } catch (error) {
      const connection = liveConnections.get(context.key);
      await updateLiveState(context, {
        socket: connection?.socket?.readyState === WebSocket.OPEN ? "connected" : "reconnecting",
        leader: false,
        leader_installation_id: null,
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

function providerLiveCommandContexts(contexts, provider) {
  const providerId = normalizedProviderId(provider);
  return liveCommandContexts(contexts).filter((context) => !providerId || context.adapter.id === providerId);
}

async function claimLeader(tabId, provider = "") {
  const stored = await readStorage([STORAGE.config, STORAGE.detectedAccounts]);
  const contexts = providerLiveCommandContexts(await activeLiveCommandContexts(configuredAccountContexts(stored)), provider);
  if (!contexts.length) throw new Error("No configured provider accounts support live commands.");
  const results = [];
  for (const context of contexts) {
    await selectCommandTab(context, tabId);
    results.push(await signedLeaderRequest(context, "claim"));
  }
  return results.at(-1) ?? { ok: true };
}

async function releaseLeader(provider = "") {
  const stored = await readStorage([STORAGE.config, STORAGE.detectedAccounts]);
  const contexts = providerLiveCommandContexts(await activeLiveCommandContexts(configuredAccountContexts(stored)), provider);
  if (!contexts.length) throw new Error("No configured provider accounts support live commands.");
  const results = [];
  for (const context of contexts) results.push(await signedLeaderRequest(context, "release"));
  return results.at(-1) ?? { ok: true };
}

async function openCommandTab() {
  const stored = await readStorage([STORAGE.config, STORAGE.detectedAccounts]);
  const context = liveCommandContexts(configuredAccountContexts(stored))[0];
  if (!context) throw new Error("No configured provider accounts support live commands.");
  const tab = await commandTab(context, { createIfMissing: true });
  if (!tab.id) throw new Error(`${providerLabel(context.adapter)} chat tab is unavailable.`);
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  return { ok: true };
}

function stopAccountLiveConnection(key, connection, reason = "provider_context_removed") {
  liveConnections.delete(key);
  void recordLog("info", "live", "local_cleanup", "Live channel closed after local context teardown.", {
    provider: connection.context?.account.provider, provider_account_id: connection.context?.account.provider_account_id,
    reason_code: reason,
  });
  connection.ticketController?.abort();
  clearTimeout(connection.ticketTimer);
  clearTimeout(connection.stableTimer);
  clearTimeout(connection.handshakeTimer);
  clearTimeout(connection.reconnectTimer);
  clearInterval(connection.heartbeatTimer);
  clearTimeout(connection.leaderStatusTimer);
  connection.statusReporter?.close();
  connection.socket?.close();
}

function stopLiveConnection(reason = "configuration_or_consent_unavailable") {
  for (const [key, connection] of liveConnections) stopAccountLiveConnection(key, connection, reason);
}

function scheduleLiveReconnect(context) {
  const connection = liveConnections.get(context.key);
  if (!connection) return;
  clearTimeout(connection.reconnectTimer);
  const cap = Math.min(60_000, 1_000 * 2 ** Math.min(connection.reconnectAttempt, 6));
  const delay = Math.round(cap * (0.5 + Math.random() * 0.5));
  connection.reconnectAttempt += 1;
  connection.reconnectTimer = setTimeout(() => {
    connection.reconnectTimer = null;
    if (liveConnections.get(context.key) === connection) void ensureAccountLiveConnection(context);
  }, delay);
}

async function signedLiveTicket(context, signal) {
  const { config, account } = context;
  const url = liveEndpoint(config);
  if (!url) throw new Error("Live reply endpoint is not configured.");
  const providerAccountId = canonicalProviderAccountId(context);
  const body = JSON.stringify({
    provider: account.provider,
    provider_account_id: providerAccountId,
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
      "x-omnichat-provider-account-id": providerAccountId,
      "x-omnichat-timestamp": timestamp,
      "x-omnichat-nonce": nonce,
      "x-omnichat-signature": signature,
    },
    body,
    signal,
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
  const policy = await providerReadiness({ ...context, adapter });
  const providerStatus = policy?.evidence?.status ?? policy?.observed_status ?? null;
  const providerStatusTab = policy?.evidence?.tab ?? policy?.observed_tab ?? null;
  await persistProviderSurfaceState(context, adapter, providerStatus, providerStatusTab);
  const status = readAccountState(stored[STORAGE.status], context.key, {});
  const pending = readAccountState(stored[STORAGE.pending], context.key, []);
  const deviceName = normalizeDeviceName(stored[STORAGE.deviceName]);
  const health = buildConnectionHealth({
    provider: context.account.provider,
    tabCount: providerStatusTab ? 1 : 0,
    contentReady: Boolean(policy?.eligible),
    accountDetected: Boolean(policy?.eligible),
    accountMatches: Boolean(policy?.eligible),
    realtimeConnected: Boolean(policy?.eligible),
    lastRealtimeConnectedAt: providerStatus?.last_realtime_connected_at,
    pendingMessages: pending.length,
    status,
  });
  const commandCapabilities = policy?.eligible ? policy.evidence?.command_capabilities : [];
  const platform = await chrome.runtime.getPlatformInfo();
  const id = await installationId();
  const current = sessionEligibility.state(context.key);
  const samePolicy = current?.generation === policy?.generation && current?.context === policy?.context;
  const ready = samePolicy && current?.eligible === true;

  return {
    type: "connection_status",
    schema: "omnichat.connection_status",
    version: 1,
    provider: context.account.provider,
    provider_account_id: canonicalProviderAccountId(context),
    installation_id: id,
    device_name: deviceName || null,
    extension_version: chrome.runtime.getManifest().version,
    reported_at: new Date().toISOString(),
    ready,
    reason_code: !samePolicy ? "checking_session" : current?.reason_code === "ready" ? health.reason_code : current?.reason_code ?? "checking_session",
    ...(ready && current?.readiness_grace_expires_at ? { readiness_grace_expires_at: current.readiness_grace_expires_at } : {}),
    client: { platform: platform.os },
    last_sync_at: health.last_sync_at,
    ...(Array.isArray(commandCapabilities) ? { command_capabilities: ready ? commandCapabilities : [] } : {}),
  };
}

function statusPublishKey(status) {
  return JSON.stringify({
    ready: status.ready,
    reason_code: status.reason_code,
    readiness_grace_expires_at: status.readiness_grace_expires_at ?? null,
    device_name: status.device_name,
    command_capabilities: status.command_capabilities ?? null,
    extension_version: status.extension_version ?? null,
    os: status.client?.platform ?? null,
    last_sync_at: status.last_sync_at ?? null,
  });
}

async function sendConnectionStatus(socket, context) {
  const status = await connectionStatusSnapshot(context);
  const connection = liveConnections.get(context.key);
  const key = statusPublishKey(status);
  if (socket.readyState !== WebSocket.OPEN || connection?.socket !== socket) return;
  if (!connection.statusReporter) {
    connection.statusReporter = createStatusReporter({
      send: (report) => {
        if (liveConnections.get(context.key)?.socket !== socket || socket.readyState !== WebSocket.OPEN) return;
        socket.send(JSON.stringify(report));
        connection.lastActivityAt = Date.now();
        scheduleKeepalive(context, socket);
      },
      onExhausted: () => void recordLog("warn", "live", "status_unacknowledged", "Readiness report was not acknowledged within the retry budget.", {
        provider: context.account.provider, provider_account_id: context.account.provider_account_id,
      }),
    });
  }
  if (!connection.statusReporter.publish(status, key)) return;
  scheduleLeaderStatusRefresh(context, socket);
  void recordLog("info", "live", "readiness_changed", "Live command channel readiness reported.", {
    provider: context.account.provider,
    provider_account_id: context.account.provider_account_id,
    ready: status.ready,
    reason_code: status.reason_code,
    readiness_grace_expires_at: status.readiness_grace_expires_at ?? null,
  });
}

function scheduleKeepalive(context, socket) {
  const connection = liveConnections.get(context.key);
  if (connection?.socket !== socket || socket.readyState !== WebSocket.OPEN) return;
  clearTimeout(connection.heartbeatTimer);
  const remaining = Math.max(1, KEEPALIVE_INTERVAL_MS - (Date.now() - connection.lastActivityAt));
  connection.heartbeatTimer = setTimeout(() => {
    if (liveConnections.get(context.key)?.socket !== socket) return;
    sendKeepalive(socket);
    scheduleKeepalive(context, socket);
  }, remaining);
}

function sendKeepalive(socket) {
  const connection = [...liveConnections.values()].find((item) => item.socket === socket);
  if (!connection || socket.readyState !== WebSocket.OPEN) return;
  if (Date.now() - (connection.lastActivityAt ?? 0) < KEEPALIVE_INTERVAL_MS) return;
  socket.send(JSON.stringify({ type: "keepalive" }));
  connection.lastActivityAt = Date.now();
}

async function ensureLiveConnection() {
  const stateKeys = [
    STORAGE.config,
    STORAGE.consent,
    STORAGE.detectedAccounts,
    STORAGE.serverInitialized,
    STORAGE.unattendedRecovery,
  ];
  const stored = await readStorage(stateKeys);
  const configuredContexts = configuredAccountContexts(stored);

  const contexts = hasServerInitialized(stored) && hasLocalConsent(stored[STORAGE.consent])
    ? await activeLiveCommandContexts(configuredContexts) : [];
  if (hasServerInitialized(stored) && hasLocalConsent(stored[STORAGE.consent])) {
    for (const context of configuredContexts) {
      if (contexts.some((item) => item.key === context.key)) continue;
      const existing = liveConnections.get(context.key);
      if (sessionEligibility.state(context.key)?.retain_transport
        && existing?.socket?.readyState === WebSocket.OPEN) {
        contexts.push(context);
      }
    }
  }
  const pingContexts = apiPingContexts(contexts);
  const canPing = pingContexts.length > 0
    && hasServerInitialized(stored)
    && hasLocalConsent(stored[STORAGE.consent]);
  await ensureApiPingAlarm(canPing);
  const canWatch = configuredContexts.length > 0
    && hasServerInitialized(stored)
    && hasLocalConsent(stored[STORAGE.consent]);
  await ensureProviderHealthAlarm(canWatch);
  // First Sync can initialize the extension while the alarm/status checks
  // above are pending. Never clean up sockets or readiness from that old view.
  const current = await readStorage(stateKeys);
  if (stateKeys.some((key) => JSON.stringify(current[key]) !== JSON.stringify(stored[key]))) {
    return ensureLiveConnection();
  }
  if (!canWatch && await clearProviderRecoveryLiveState() === false) return ensureLiveConnection();
  if (canPing) {
    ensureApiPings(pingContexts);
  }
  if (!hasServerInitialized(stored)
    || !hasLocalConsent(stored[STORAGE.consent])
    || !contexts.length) {
    if (canWatch) stopLiveConnection();
    void recordLog("debug", "live", "not_started", "Live connection is not ready.", {
      consented: hasLocalConsent(stored[STORAGE.consent]),
      configured: configuredContexts.length > 0,
      live_capable: contexts.length > 0,
    });
    return;
  }
  const contextKeys = new Set(contexts.map((context) => context.key));
  for (const [key, connection] of liveConnections) {
    if (contextKeys.has(key)) continue;
    stopAccountLiveConnection(key, connection);
  }
  for (const context of contexts) await ensureAccountLiveConnection(context);
}

const migrationRetries = new Map();
const migrationConnections = new Map();
let migrationWrites = Promise.resolve();
async function persistAccountMigration(context, source) {
  const write = migrationWrites.then(async () => {
    const stored = await readStorage([STORAGE.config]);
    const config = stored[STORAGE.config];
    const index = config?.accounts?.findIndex((account) => accountConfigKey(account) === context.key);
    if (index === undefined || index < 0 || JSON.stringify(config.accounts[index]) !== JSON.stringify(source)) return;
    const accounts = [...config.accounts];
    accounts[index] = context.config;
    await writeStorage({ [STORAGE.config]: { ...config, accounts } });
    migrationRetries.delete(context.key);
    await updateScopedState(STORAGE.status, context.key, { migration_pending: false, migration_error: null, migration_error_code: null,
      migration_attempt: 0, migration_retry_at: 0 });
  });
  migrationWrites = write.catch(() => {});
  return write;
}

async function ensureAccountLiveConnection(context) {
  if (migrationConnections.has(context.key)) return migrationConnections.get(context.key);
  const attempt = ensureMigratedAccountLiveConnection(context).finally(() => migrationConnections.delete(context.key));
  migrationConnections.set(context.key, attempt);
  return attempt;
}

async function markMigrationPending(context, error) {
  const stored = await readStorage([STORAGE.status]);
  const retry = readAccountState(stored[STORAGE.status], context.key, {});
  const attempt = (migrationRetries.get(context.key)?.attempt ?? retry.migration_attempt ?? 0) + 1;
  const nextAt = Date.now() + Math.min(3600000, 30000 * 2 ** Math.min(attempt, 7));
  migrationRetries.set(context.key, { attempt, nextAt });
  await updateScopedState(STORAGE.status, context.key, { migration_pending: true,
    migration_error: error.message, migration_error_code: error.code ?? null, migration_attempt: attempt, migration_retry_at: nextAt });
}

async function ensureMigratedAccountLiveConnection(context) {
  const migrationStored = await readStorage([STORAGE.config, STORAGE.status]);
  const storedConfig = migrationStored[STORAGE.config];
  const persistedRetry = readAccountState(migrationStored[STORAGE.status], context.key, {});
  let retryAt = migrationRetries.get(context.key)?.nextAt ?? persistedRetry.migration_retry_at ?? 0;
  const migration = accountMigration(context.config, storedConfig?.version);
  // Permission approval can arrive while a healthy legacy socket keeps migration
  // deferred. Reconcile the warning independently of the transport handover.
  const permissionWarning = persistedRetry.migration_error_code === "server_permission_required"
    || persistedRetry.migration_error === "Open configuration and save it to approve the new server access.";
  const migrationOrigins = migration.candidate
    ? [...new Set([migration.candidate.api_url, migration.candidate.logs_url].map((value) => `${new URL(value).origin}/*`))]
    : [];
  if ((permissionWarning && migration.candidate && await chrome.permissions.contains({ origins: migrationOrigins }))
    || (!migration.candidate && migration.status !== "invalid" && persistedRetry.migration_pending)) {
    migrationRetries.delete(context.key);
    retryAt = 0;
    await updateScopedState(STORAGE.status, context.key, { migration_pending: Boolean(migration.candidate),
      migration_error: null, migration_error_code: null, migration_attempt: 0, migration_retry_at: 0 });
  }
  const handover = liveConnections.get(context.key);
  if (handover?.migrationSource
    && JSON.stringify(handover.migrationSource) === JSON.stringify(context.config)) {
    // Storage notifications still contain the legacy URL until the candidate opens and is saved.
    // Keep the same connection through this interval rather than replacing its handshake.
    return;
  }
  if (migration.status === "invalid") {
    const connection = liveConnections.get(context.key);
    if (connection) stopAccountLiveConnection(context.key, connection);
    await updateScopedState(STORAGE.status, context.key, { error: migration.error });
    return;
  }
  // Handover only on a natural reconnect: never replace a working socket or its in-flight replies.
  let migrationSource = null;
  const currentConnection = liveConnections.get(context.key);
  if (migration.candidate && !currentConnection?.socket && !currentConnection?.connecting
    && !currentConnection?.reconnectTimer && Date.now() >= retryAt
    && ![...liveCommandResults].some(([key, command]) => key.startsWith(`${context.key}:`) && command.expiresAt === Infinity)) {
    const candidate = { ...context, config: migration.candidate };
    try {
      if (!await chrome.permissions.contains({ origins: migrationOrigins })) {
        const error = new Error("Open configuration and save it to approve the new server access.");
        error.code = "server_permission_required";
        throw error;
      }
      await signedApiPing(candidate);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      try { await signedLeaderRequest(candidate, "status", controller.signal); }
      finally { clearTimeout(timeout); }
      migrationSource = context.config;
      context = candidate;
    } catch (error) {
      await markMigrationPending(context, error);
    }
  }
  const endpoint = liveEndpoint(context.config);
  if (!endpoint) return;
  let existing = liveConnections.get(context.key) ?? {
    socket: null,
    reconnectTimer: null,
    heartbeatTimer: null,
    leaderStatusTimer: null,
    lastStatusKey: null,
    reconnectAttempt: 0,
    connecting: false,
  };
  if (existing.config && JSON.stringify(existing.config) !== JSON.stringify(context.config)) {
    stopAccountLiveConnection(context.key, existing, "configuration_changed");
    existing = { socket: null, reconnectTimer: null, heartbeatTimer: null, leaderStatusTimer: null,
      lastStatusKey: null, reconnectAttempt: 0, connecting: false };
  }
  existing.config = context.config;
  existing.context = context;
  existing.migrationSource = migrationSource;
  liveConnections.set(context.key, existing);
  if (existing.socket?.readyState === WebSocket.OPEN) {
    void sendConnectionStatus(existing.socket, context).catch((error) => recordUnexpected("connection_status", error, {
      provider_account_id: context.account.provider_account_id,
    }));
    return;
  }
  if (existing.connecting || existing.reconnectTimer || existing.socket?.readyState === WebSocket.CONNECTING) return;
  // Claim the attempt before storage or ticket requests can yield to another event.
  existing.connecting = true;
  const attemptStartedAt = Date.now();
  try {
    await updateLiveState(context, { socket: "connecting" });
    await recordLog("debug", "live", "connecting", "Connecting live command channel.", {
      provider_account_id: context.account.provider_account_id,
      reconnect_attempt: existing.reconnectAttempt,
    });
    existing.ticketController = new AbortController();
    const ticketTimeout = new Promise((_, reject) => {
      existing.ticketTimer = setTimeout(() => {
        existing.ticketController.abort();
        reject(new Error("Live reply ticket request timed out."));
      }, 10_000);
    });
    const { ticket, socketUrl } = await Promise.race([signedLiveTicket(context, existing.ticketController.signal), ticketTimeout]);
    clearTimeout(existing.ticketTimer);
    if (liveConnections.get(context.key) !== existing) return;
    socketUrl.searchParams.set("ticket", ticket);
    const socket = new WebSocket(socketUrl);
    existing.socket = socket;
    existing.handshakeTimer = setTimeout(() => {
      if (liveConnections.get(context.key)?.socket === socket && socket.readyState === WebSocket.CONNECTING) {
        disconnectReason = "handshake_timeout";
        socket.close();
      }
    }, 10_000);
    let openedAt = null;
    let disconnectReason = "connection_closed";
    socket.addEventListener("open", () => {
      if (liveConnections.get(context.key)?.socket !== socket) {
        socket.close();
        return;
      }
      clearTimeout(existing.handshakeTimer);
      openedAt = Date.now();
      existing.lastActivityAt = openedAt;
      existing.lastInboundAt = openedAt;
      existing.stableTimer = setTimeout(() => {
        if (liveConnections.get(context.key)?.socket === socket) existing.reconnectAttempt = 0;
      }, 30_000);
      void updateLiveState(context, { socket: "connected", endpoint_not_found: false });
      if (migrationSource) void persistAccountMigration(context, migrationSource)
        .catch((error) => recordUnexpected("config_migration", error))
        .finally(() => { existing.migrationSource = null; });
      void recordLog("info", "live", "connected", "Live command channel connected.", {
        provider_account_id: context.account.provider_account_id,
        connect_duration_ms: openedAt - attemptStartedAt,
      });
      existing.lastStatusKey = null;
      existing.statusReporter?.close();
      existing.statusReporter = null;
      scheduleKeepalive(context, socket);
      void sendConnectionStatus(socket, context)
        .catch((error) => recordUnexpected("connection_status", error, {
          provider_account_id: context.account.provider_account_id,
        }));
    });
    socket.addEventListener("message", (event) => {
      if (liveConnections.get(context.key)?.socket !== socket) return;
      existing.lastActivityAt = Date.now();
      existing.lastInboundAt = existing.lastActivityAt;
      scheduleKeepalive(context, socket);
      void handleLiveCommand(event.data, context, socket);
    });
    socket.addEventListener("close", (event) => {
      if (liveConnections.get(context.key)?.socket === socket) {
        clearTimeout(existing.handshakeTimer);
        clearTimeout(existing.stableTimer);
        existing.statusReporter?.close();
        existing.statusReporter = null;
        existing.socket = null;
        clearInterval(existing.heartbeatTimer);
        existing.heartbeatTimer = null;
        clearTimeout(existing.leaderStatusTimer);
        existing.leaderStatusTimer = null;
        void updateLiveState(context, { socket: "reconnecting", leader: false, leader_installation_id: null });
        void recordLog("warn", "live", "disconnected", "Live command channel disconnected.", {
          provider_account_id: context.account.provider_account_id,
          reconnect_attempt: existing.reconnectAttempt + 1,
          reason_code: disconnectReason,
          close_code: event.code,
          was_clean: event.wasClean,
          open_duration_ms: openedAt === null ? null : Date.now() - openedAt,
          since_last_inbound_ms: existing.lastInboundAt == null ? null : Date.now() - existing.lastInboundAt,
        });
        if (migrationSource && openedAt === null) {
          void markMigrationPending(context, new Error("New server connection could not be established. The previous configuration is still active."))
            .catch((error) => recordUnexpected("config_migration", error));
          existing.config = migrationSource;
          existing.context = { ...context, config: migrationSource };
        }
        existing.migrationSource = null;
        scheduleLiveReconnect(existing.context);
      }
    });
    socket.addEventListener("error", () => {
      disconnectReason = "transport_error";
      socket.close();
    });
  } catch (error) {
    if (liveConnections.get(context.key) !== existing) return;
    await updateLiveState(context, {
      socket: "reconnecting",
      endpoint_not_found: error?.message === "Live reply endpoint returned 404.",
    });
    await recordUnexpected("live_connection", error, {
      provider_account_id: context.account.provider_account_id,
    });
    if (migrationSource) {
      await markMigrationPending(context, error);
      existing.config = migrationSource;
      existing.context = { ...context, config: migrationSource };
    }
    existing.migrationSource = null;
    scheduleLiveReconnect(existing.context);
  } finally {
    clearTimeout(existing.ticketTimer);
    existing.ticketController = null;
    existing.connecting = false;
  }
}

function scheduleLeaderStatusRefresh(context, socket, attemptsRemaining = 2) {
  const connection = liveConnections.get(context.key);
  if (!connection || connection.socket !== socket) return;
  clearTimeout(connection.leaderStatusTimer);
  connection.leaderStatusTimer = setTimeout(() => {
    void getLiveState(context.account.provider_account_id, context.account.provider).then((result) => {
      if (result?.leader_installation_id || attemptsRemaining <= 0 || socket.readyState !== WebSocket.OPEN) return;
      scheduleLeaderStatusRefresh(context, socket, attemptsRemaining - 1);
    }).catch((error) => recordUnexpected("leader_status", error, {
      provider: context.account.provider,
      provider_account_id: context.account.provider_account_id,
    }));
  }, 1_000);
}

async function handleLiveCommand(raw, context, socket) {
  let command;
  try { command = JSON.parse(raw); } catch { return; }
  if (command?.type === "connection_status_ack") {
    const current = liveConnections.get(context.key);
    if (current?.socket === socket && current.statusReporter?.acknowledge(command) === true && command.ok === true) {
      // Persistence may succeed after the initial leader probes have finished.
      // Refresh the server's actual election result, never infer leadership from ACK.
      scheduleLeaderStatusRefresh(context, socket);
    }
    return;
  }
  const adapter = providerAdapterForCommand(command);
  if (!adapter?.supportsSend(command?.type) || adapter.id !== context.account.provider) return;
  if (messageProviderAccountId(command) !== canonicalProviderAccountId(context)) return;
  if (typeof command.request_id !== "string" || !command.request_id) return;
  const acknowledge = (result) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(result));
    const connection = liveConnections.get(context.key);
    if (connection?.socket === socket) {
      connection.lastActivityAt = Date.now();
      scheduleKeepalive(context, socket);
    }
  };
  const key = `${context.key}:${command.request_id}`;
  const now = Date.now();
  for (const [cachedKey, cached] of liveCommandResults) {
    if (cached.expiresAt <= now) liveCommandResults.delete(cachedKey);
  }
  let cached = liveCommandResults.get(key);
  const duplicate = Boolean(cached);
  const selectedGeneration = sessionEligibility.generation(context.key);
  if (!cached) {
    if (liveCommandResults.size >= 200) {
      acknowledge({ type: "send_result", request_id: command.request_id, ok: false, error: "Command channel is busy. Retry after current commands finish." });
      return;
    }
    cached = {
      expiresAt: Infinity,
      result: replyQueue.run(context.key, async () => {
        const sent = await sendViaProvider(command, { expectedGeneration: selectedGeneration });
        // A pending extension restart may run as soon as this reply operation exits.
        if (sent?.ok && socket.readyState === WebSocket.OPEN) {
          acknowledge({ type: "send_result", request_id: command.request_id,
            ok: true, provider_message_id: sent.provider_message_id });
        }
        return sent;
      }).catch((error) => ({
        ok: false, error: error instanceof Error ? error.message : String(error),
        ...(sanitizeSendDiagnostics(error?.diagnostics) ? { diagnostics: sanitizeSendDiagnostics(error.diagnostics) } : {}),
      })),
    };
    cached.result = cached.result.then((result) => {
      cached.expiresAt = Date.now() + 120_000;
      return result;
    });
    liveCommandResults.set(key, cached);
  }
  const result = await cached.result;
  if (duplicate && result?.ok && socket.readyState === WebSocket.OPEN) {
    acknowledge({ type: "send_result", request_id: command.request_id,
      ok: true, provider_message_id: result.provider_message_id });
  }
  if (!result?.ok) {
    await recordUnexpected("live_command", result?.error ?? "Reply failed.", {
      ...sanitizeSendDiagnostics(result?.diagnostics),
      provider: adapter.id,
      command_type: command.type,
      provider_account_id: context.account.provider_account_id,
      request_id: command.request_id,
      installation_id: await installationId(),
    });
    void sendConnectionStatus(socket, context).catch((error) => recordUnexpected("connection_status", error));
  }
  if (!result?.ok) acknowledge({
    type: "send_result", request_id: command.request_id, ok: false,
    error: result?.error ?? "Reply failed.",
    ...(result?.error_code ? { error_code: result.error_code } : {}),
    ...(result?.uncertain === true ? { uncertain: true } : {}),
  });
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes[STORAGE.commandTab] || changes[STORAGE.config]) rememberedCommandTabs.clear();
  if (changes[STORAGE.config] || changes[STORAGE.consent]) {
    for (const adapter of providerAdapters.list()) invalidateProviderSession(adapter.id, "configuration_or_consent_changed");
  }
  if (changes[STORAGE.unattendedRecovery]) {
    void runProviderHealthWatchdog().catch((error) => recordUnexpected("provider_watchdog", error));
  }
  const connectionKeys = [STORAGE.config, STORAGE.consent, STORAGE.detectedAccounts,
    STORAGE.unattendedRecovery, STORAGE.deviceName, STORAGE.status, STORAGE.pending];
  if (connectionKeys.some((key) => changes[key])) {
    void ensureLiveConnection().catch((error) => recordUnexpected("connection_status", error));
  }
});

chrome.permissions.onAdded.addListener(() => {
  void ensureLiveConnection().catch((error) => recordUnexpected("connection_status", error));
});

async function reconnectProviderTab(tab) {
  const tabId = tab?.id;
  if (!Number.isInteger(tabId)) return;
  const adapter = providerAdapters.list().find((candidate) => candidate.matchesUrl(tab.url));
  if (!adapter) return;
  await ensureProviderBridge(tabId, adapter);
  if (adapter.id === "line_oa" || adapter.id === "shopee") {
    const stored = await readStorage([STORAGE.consent]);
    if (hasLocalConsent(stored[STORAGE.consent])) {
      const result = await detectOpenProviderAccount(adapter.id, tabId);
      if (!result?.ok && adapter.id !== "shopee") {
        throw new Error(result?.error ?? `${providerLabel(adapter)} account detection failed.`);
      }
    }
  }
  await autoStartSellerCentreTab(tab);
  await ensureLiveConnection();
}

function invalidateProviderSession(provider, reason) {
  for (const [tabId, check] of providerBridgeChecks) {
    if (check.provider === provider) providerBridgeChecks.delete(tabId);
  }
  providerSessionEpochs.set(provider, providerSessionEpoch(provider) + 1);
  for (const [key, context] of providerPolicyContexts) {
    if (context.adapter.id !== provider) continue;
    sessionEligibility.reset(key);
    const connection = liveConnections.get(key);
    if (connection) stopAccountLiveConnection(key, connection, reason);
  }
}

function invalidateProviderTab(tabId, reason) {
  providerBridgeChecks.delete(tabId);
  providerTabEpochs.set(tabId, (providerTabEpochs.get(tabId) ?? 0) + 1);
  for (const control of [activeSyncControl, ...providerAutomaticRecoveries.values()]) {
    if (control?.tabId === tabId) control.recoveryCompletion?.reject(
      Object.assign(new Error("Page changed. Sync again."), { reason_code: "provider_page_changed" }));
  }
  // Unused tabs cannot tear down another tab's validated account connection.
  for (const [key, evidenceTabId] of providerPolicyTabIds) {
    if (evidenceTabId !== tabId) continue;
    sessionEligibility.reset(key);
    providerPolicyTabIds.delete(key);
    const connection = liveConnections.get(key);
    if (connection) stopAccountLiveConnection(key, connection, reason);
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === "loading") invalidateProviderTab(tabId, "provider_tab_navigated");
  if (changeInfo.url) {
    void ensureLiveConnection().catch((error) => recordUnexpected("connection_status", error));
  }
  if (changeInfo.status !== "complete") return;
  void reconnectProviderTab({ ...tab, id: tabId }).catch((error) => {
    const adapter = providerAdapters.list().find((candidate) => candidate.matchesUrl(tab.url));
    void recordUnexpected("provider_bridge_startup", error, { provider: adapter?.id });
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  invalidateProviderTab(tabId, "provider_tab_closed");
  sellerCentreLandingStarts.delete(tabId);
  void markClosedProviderRecoveryTab(tabId)
    .then(() => ensureLiveConnection())
    .catch((error) => recordUnexpected("provider_watchdog", error, { tab_id: tabId }));
});

chrome.tabs.onReplaced?.addListener((_addedTabId, removedTabId) => {
  invalidateProviderTab(removedTabId, "provider_tab_replaced");
  void ensureLiveConnection().catch((error) => recordUnexpected("connection_status", error));
});

chrome.runtime.onStartup.addListener(() => {
  void recordLog("info", "extension", "started", "Extension service worker started.");
  void chrome.alarms.clear(LOG_UPLOAD_ALARM);
  void ensureLiveConnection();
  void reattachOpenProviderBridges().catch((error) => recordUnexpected("provider_bridge_startup", error));
  void attemptAllDeliveries({ resetBackoff: false });
});

chrome.runtime.onUpdateAvailable.addListener((details) => {
  void storeExtensionUpdate({
    status: "available",
    available_version: details.version,
    attempted_at: Date.now(),
  });
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason !== "update" || !isVersionBefore(details.previousVersion, DETECTED_ACCOUNTS_RESET_VERSION)) return;
  void reinitializeAfterUpgrade().catch((error) => {
    void recordUnexpected("storage_upgrade", error);
  });
});

void recordLog("info", "extension", "loaded", "Extension service worker loaded.");
void chrome.alarms.clear(LOG_UPLOAD_ALARM);
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

async function providerChatTabById(adapter, tabId) {
  const id = Number(tabId);
  if (!Number.isInteger(id) || id <= 0) return null;
  try {
    const tab = await chrome.tabs.get(id);
    return tab?.id && adapter.matchesUrl(tab.url) ? tab : null;
  } catch {
    return null;
  }
}

const syncTabPreparations = new Map();
function prepareSyncTab(provider, tabId) {
  const key = `${provider}:${tabId}`;
  if (syncTabPreparations.has(key)) return syncTabPreparations.get(key);
  const task = refreshSyncTab(provider, tabId).finally(() => {
    if (syncTabPreparations.get(key) === task) syncTabPreparations.delete(key);
  });
  syncTabPreparations.set(key, task);
  return task;
}

async function refreshSyncTab(provider, tabId) {
  const adapter = providerAdapterForId(provider);
  if (!adapter || !Number.isInteger(tabId) || tabId <= 0) throw new Error("Open a provider chat to sync.");
  const stored = await readStorage([STORAGE.consent]);
  if (!hasLocalConsent(stored[STORAGE.consent])) throw new Error("Consent required.");
  const tab = await providerChatTabById(adapter, tabId);
  if (!tab) throw new Error("The selected provider tab is no longer open.");
  await cancelActiveSync(provider, tabId);
  providerBridgeChecks.delete(tabId);
  // Fence pending probes without closing a healthy command socket.
  providerTabEpochs.set(tabId, (providerTabEpochs.get(tabId) ?? 0) + 1);
  for (const [key, evidenceTabId] of providerPolicyTabIds) {
    if (evidenceTabId === tabId) sessionEligibility.reset(key);
  }
  const context = providerTabContext(tab, provider);
  await ensureProviderBridge(tabId, adapter);
  const cancelled = await sendProviderMessage(tabId, { type: "cancel_sync_v3", provider }, {
    label: providerLabel(adapter), operation: "prepare sync", timeoutMs: PROVIDER_STATUS_RESPONSE_TIMEOUT_MS,
  });
  if (!cancelled?.ok) throw new Error("Could not reset this tab's recovery.");
  await resetProviderRecovery(tabId);
  const current = await providerChatTabById(adapter, tabId);
  if (!current || context !== providerTabContext(current, provider)) throw new Error("Page changed. Sync again.");
  await recordLog("info", "sync", "tab_refreshed", "Temporary sync state refreshed for the selected tab.", { provider, tab_id: tabId });
  return { ok: true };
}

async function exactProviderAccountTab(context, tabId) {
  if (!Number.isInteger(tabId) || tabId <= 0) throw new Error("A valid provider tab is required.");
  const tab = await providerChatTabById(context.adapter, tabId);
  if (!tab) throw new Error("The selected provider tab is no longer open.");
  const tabContext = providerTabContext(tab, context.adapter.id);
  await ensureProviderBridge(tab.id, context.adapter);
  const status = await providerTabStatus(tab);
  const current = await providerChatTabById(context.adapter, tabId);
  if (!current || current.url !== tab.url || tabContext !== providerTabContext(tab, context.adapter.id)) {
    throw new Error("The selected provider tab changed. Retry from its current page.");
  }
  if (context.adapter.id === "line_oa") {
    const botId = context.account.bot_id || context.config.bot_id;
    let openBotId = "";
    try { openBotId = decodeURIComponent(new URL(tab.url).pathname.split("/")[1] ?? ""); } catch { /* Invalid URL cannot identify an account. */ }
    if (!botId || openBotId !== botId || status?.account_access_verified !== true
      || !status.accessible_account_ids?.includes(context.account.provider_account_id)) {
      throw new Error("Open this LINE account in the selected tab before syncing.");
    }
  } else if (status?.current_provider_account_id !== context.account.provider_account_id) {
    throw new Error("The selected provider tab is signed in to a different account.");
  }
  return tab;
}

async function refreshAccountMetadata(provider, providerAccountId, tabId = null) {
  const key = `${accountKey(provider, providerAccountId)}:${tabId ?? "any"}`;
  if (metadataRefreshes.has(key)) return metadataRefreshes.get(key);
  const task = runAccountMetadataRefresh(provider, providerAccountId, tabId)
    .finally(() => { if (metadataRefreshes.get(key) === task) metadataRefreshes.delete(key); });
  metadataRefreshes.set(key, task);
  return task;
}

async function runAccountMetadataRefresh(provider, providerAccountId, tabId = null) {
  if (metadataErasing) throw new Error("Local data is being erased.");
  const startedEpoch = metadataEpoch;
  const deadline = Date.now() + 30_000;
  const stored = await readStorage([STORAGE.config, STORAGE.consent, STORAGE.detectedAccounts]);
  if (!hasLocalConsent(stored[STORAGE.consent])) throw new Error("Consent required.");
  const context = accountContextFor(stored, providerAccountId, provider);
  if (!context) throw new Error("Configured account required.");
  const epoch = providerSessionEpoch(provider);
  let tab;
  if (tabId !== null && tabId !== undefined) {
    tab = await exactProviderAccountTab(context, tabId);
  } else {
    const tabs = await providerChatTabs(context.adapter);
    for (const candidate of orderProviderTabs(context.adapter, tabs)) {
      const status = await providerTabStatus(candidate);
      const ids = provider === "line_oa" ? status?.accessible_account_ids : [status?.current_provider_account_id];
      if (ids?.includes(providerAccountId)) { tab = candidate; break; }
    }
  }
  if (!tab || Date.now() >= deadline) throw new Error("Open the matching provider account.");
  const tabContext = providerTabContext(tab, provider);
  await ensureProviderBridge(tab.id, context.adapter);
  const result = await sendProviderMessage(tab.id, { type: "refresh_metadata_v3", provider,
    provider_account_id: providerAccountId, deadline_at: deadline, limit: 100 }, {
    label: "Metadata", operation: "refresh", timeoutMs: Math.max(1, deadline - Date.now()),
  });
  return exclusive(async () => {
    const current = await readStorage([STORAGE.config, STORAGE.consent, STORAGE.detectedAccounts]);
    const currentContext = accountContextFor(current, providerAccountId, provider);
    const scope = await metadataScope(context);
    const currentScope = currentContext ? await metadataScope(currentContext) : null;
    if (metadataErasing || startedEpoch !== metadataEpoch || Date.now() >= deadline || epoch !== providerSessionEpoch(provider)
      || tabContext !== providerTabContext(tab, provider) || !currentContext
      || !hasLocalConsent(current[STORAGE.consent]) || scope !== currentScope) {
      throw new Error("Account context changed during refresh.");
    }
    if (!result?.ok) return { ok: false, customer_count: 0, error: "Metadata refresh failed. Cached information was kept." };
    const account = result.account?.provider_account_id === providerAccountId
      ? { ...result.account, provider } : null;
    if (account) await writeStorage({ [STORAGE.detectedAccounts]: mergeDetectedAccounts(
      current[STORAGE.detectedAccounts], [account], { refreshMetadata: true }) });
    const profiles = (Array.isArray(result.profiles) ? result.profiles : []).slice(0, 100)
      .filter((profile) => profile.provider_account_id === providerAccountId);
    const count = await customerMetadata.refresh(scope, profiles);
    let persistenceFailed = false;
    try { await customerMetadata.flush(); } catch {
      persistenceFailed = true;
      if (!metadataCacheWarningReported) {
        metadataCacheWarningReported = true;
        void recordLog("warn", "metadata", "cache_save_failed", "Display metadata could not be saved locally.");
      }
    }
    return { ok: true, account_refreshed: Boolean(account), customer_count: count,
      partial: result.partial === true || persistenceFailed };
  });
}

async function detectOpenProviderAccount(provider = shopeeAdapter.id, preferredTabId = null) {
  const adapter = providerAdapterForId(provider);
  if (!adapter) return { ok: false, error: `Unsupported provider: ${provider}.` };
  if (!adapter.supports("account_detection")) {
    return { ok: false, error: `${providerLabel(adapter)} does not support account detection.` };
  }
  const label = providerLabel(adapter);
  const hasPreferredTab = preferredTabId !== null && preferredTabId !== undefined;
  const tab = hasPreferredTab
    ? await providerChatTabById(adapter, preferredTabId)
    : await findReadyProviderChatTab(adapter) ?? await findProviderChatTab(adapter);
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
  const adapter = providerAdapters.list().find((item) => item.matchesUrl(tab.url));
  if (!adapter) return null;
  const key = providerTabContext(tab, adapter.id);
  if (providerStatusProbes.has(key)) return providerStatusProbes.get(key);
  const probe = (async () => {
    try {
      const result = await sendProviderMessage(tab.id, { type: "get_provider_status_v3" }, {
        label: "Provider", operation: "status request", timeoutMs: PROVIDER_STATUS_RESPONSE_TIMEOUT_MS,
      });
      if (!result || result.ok === false) invalidateBridgeVerification(tab.id);
      return key === providerTabContext(tab, adapter.id) && result && typeof result === "object" ? result : null;
    } catch { invalidateBridgeVerification(tab.id); return null; }
  })().finally(() => { if (providerStatusProbes.get(key) === probe) providerStatusProbes.delete(key); });
  providerStatusProbes.set(key, probe);
  return probe;
}

function providerTabIsReady(status, adapter) {
  if (typeof adapter?.providerStatusReady === "function") {
    return adapter.providerStatusReady(status) === true;
  }
  return Boolean(status?.ok);
}

function providerTabCanSend(status, context) {
  const adapter = context.adapter ?? providerAdapterForAccount(context.account);
  return providerTabIsReady(status, adapter)
    && (adapter?.id !== "shopee"
      || status?.current_provider_account_id === context.account.provider_account_id)
    && (adapter?.id !== "line_oa" || (status?.account_access_verified === true
      && status.accessible_account_ids?.includes(context.account.provider_account_id)));
}

function providerTabHealthy(status, adapter) {
  if (typeof adapter?.providerStatusHealthy === "function") {
    return adapter.providerStatusHealthy(status, { staleMs: PROVIDER_HEALTH_STALE_MS }) === true;
  }
  if (!providerTabIsReady(status, adapter)) return false;
  if (status?.realtime_connected !== true) return false;
  const checkedAtValue = typeof status?.last_provider_check_at === "string"
    ? status.last_provider_check_at.trim()
    : "";
  if (!checkedAtValue) return true;
  const checkedAt = Date.parse(checkedAtValue);
  return Number.isFinite(checkedAt) && Date.now() - checkedAt <= PROVIDER_HEALTH_STALE_MS;
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

async function ensureProviderBridge(tabId, adapter, { reuseVerified = false } = {}) {
  if (!adapter) throw new Error("Provider adapter is unavailable.");
  const epoch = providerTabEpochs.get(tabId) ?? 0;
  const existing = providerBridgeChecks.get(tabId);
  if (existing?.provider === adapter.id && existing.epoch === epoch) {
    if (existing.pending) return existing.pending;
    if (reuseVerified && existing.verified) return;
  }
  const check = { provider: adapter.id, epoch, verified: false, pending: null };
  providerBridgeChecks.set(tabId, check);
  check.pending = verifyProviderBridge(tabId, adapter).then(() => {
    if ((providerTabEpochs.get(tabId) ?? 0) !== epoch || providerBridgeChecks.get(tabId) !== check) {
      throw new Error("Provider document changed during bridge verification. Retry after it is ready.");
    }
    check.verified = true;
  }).catch((error) => {
    if (providerBridgeChecks.get(tabId) === check) providerBridgeChecks.delete(tabId);
    throw error;
  }).finally(() => { check.pending = null; });
  return check.pending;
}

async function verifyProviderBridge(tabId, adapter) {
  if (!adapter) throw new Error("Provider adapter is unavailable.");
  const label = providerLabel(adapter);
  let response = null;
  let pingFailed = false;
  let bridgeReady = false;
  try {
    response = await sendProviderMessage(tabId, { type: "ping_v3" }, {
      label, operation: "bridge ping", timeoutMs: PROVIDER_STATUS_RESPONSE_TIMEOUT_MS,
    });
    bridgeReady = Boolean(
      response?.ok
      && response.bridge_protocol_version === BRIDGE_PROTOCOL_VERSION
      && response.bridge_source === BRIDGE_SOURCE
      && response.recovery_watchdog_version === 1,
    );
    if (bridgeReady) {
      try {
        bridgeReady = (await providerMainBridgeStatus(tabId, adapter)).ready === true;
      } catch {
        bridgeReady = false;
      }
    }
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
      response = await sendProviderMessage(tabId, { type: "ping_v3" }, {
        label, operation: "bridge ping", timeoutMs: PROVIDER_STATUS_RESPONSE_TIMEOUT_MS,
      });
      bridgeReady = Boolean(
        response?.ok
        && response.bridge_protocol_version === BRIDGE_PROTOCOL_VERSION
        && response.bridge_source === BRIDGE_SOURCE
        && response.recovery_watchdog_version === 1,
      );
      if (bridgeReady) {
        try {
          bridgeReady = (await providerMainBridgeStatus(tabId, adapter)).ready === true;
        } catch {
          bridgeReady = false;
        }
      }
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
    timeoutMs: PROVIDER_PREPARATION_TIMEOUT_MS,
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
      const control = window.__omnichatLineOABridgeControl ?? window.__omnichatRealtimeBridgeControl;
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

async function providerMainBridgeStatus(tabId, adapter) {
  const mainBridge = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [BRIDGE_SOURCE, adapter?.id, LINE_MAIN_BRIDGE_COMPATIBILITY_VERSION, SHOPEE_MAIN_BRIDGE_COMPATIBILITY_VERSION],
    func: (bridgeSource, providerId, lineCompatibilityVersion, shopeeCompatibilityVersion) => ({
      ready: Boolean(
        providerId === "line_oa"
          ? globalThis.OmnichatProviderAdapters?.get?.("line_oa")
            && window.__omnichatLineOABridgeControl?.source === bridgeSource
            && window.__omnichatLineOABridgeControl?.metadata_refresh === true
            && window.__omnichatLineOABridgeControl?.bounded_message_ids === true
            && window.__omnichatLineOABridgeControl?.grace_classification === true
            // Existing page scripts predate this field and use compatibility v1.
            && (window.__omnichatLineOABridgeControl?.compatibility_version ?? 1) === lineCompatibilityVersion
            && typeof window.__omnichatLineOABridgeControl?.dispose === "function"
          : globalThis.OmnichatShopeeUrl
            && globalThis.OmnichatProviderAdapters?.get?.("shopee")
            && window.__omnichatRealtimeState
            && window.__omnichatRealtimeBridgeControl?.source === bridgeSource
            && window.__omnichatRealtimeBridgeControl?.metadata_refresh === true
            && window.__omnichatRealtimeBridgeControl?.fresh_provider_status === true
            && window.__omnichatRealtimeBridgeControl?.bounded_message_ids === true
            && window.__omnichatRealtimeBridgeControl?.grace_classification === true
            && (window.__omnichatRealtimeBridgeControl?.compatibility_version ?? 1) === shopeeCompatibilityVersion
            && typeof window.__omnichatRealtimeBridgeControl?.dispose === "function"
            && typeof window.__omnichatRealtimeBridgeControl?.resetRecovery === "function"
            && typeof window.__omnichatRealtimeBridgeControl?.prepareSellerCentre === "function",
      ),
      hasUrl: Boolean(globalThis.OmnichatShopeeUrl),
      hasAdapters: Boolean(globalThis.OmnichatProviderAdapters?.get),
      hasProviderAdapter: Boolean(globalThis.OmnichatProviderAdapters?.get?.(providerId)),
      bridge_version: providerId === "line_oa"
        ? window.__omnichatLineOABridgeControl?.bridge_version ?? null
        : null,
    }),
  });
  return mainBridge?.[0]?.result ?? {};
}

async function retireProviderMainBridge(tabId) {
  invalidateBridgeVerification(tabId);
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
  invalidateBridgeVerification(tabId);
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
      const mainStatus = await providerMainBridgeStatus(tabId, adapter);
      if (mainStatus.ready !== true) {
        await retireProviderMainBridge(tabId);
        const mainFiles = adapter.id === "line_oa"
          ? [
            ...(mainStatus.hasAdapters ? [] : ["lib/provider-adapters.js"]),
            ...(mainStatus.hasProviderAdapter ? [] : ["lib/line-oa.js"]),
            "line-oa-realtime.js",
          ]
          : [
            ...(mainStatus.hasUrl ? [] : ["lib/shopee-url.js"]),
            ...(mainStatus.hasAdapters ? [] : ["lib/provider-adapters.js"]),
            ...(mainStatus.hasProviderAdapter ? [] : ["lib/shopee-adapter.js"]),
            "lib/shopee-video.js",
            "lib/message-id-cache.js",
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
        args: [adapter.id],
        func: (providerId) => ({
          hasUrl: Boolean(globalThis.OmnichatShopeeUrl),
          hasShopee: typeof globalThis.OmnichatShopee?.parseShopeeMessages === "function",
          hasAdapters: Boolean(globalThis.OmnichatProviderAdapters?.get),
          hasProviderAdapter: Boolean(globalThis.OmnichatProviderAdapters?.get?.(providerId)),
        }),
      });
      const isolatedStatus = isolatedBridge?.[0]?.result ?? {};
      const isolatedFiles = adapter.id === "line_oa"
        ? [
          ...(isolatedStatus.hasAdapters ? [] : ["lib/provider-adapters.js"]),
          ...(isolatedStatus.hasProviderAdapter ? [] : ["lib/line-oa.js"]),
          "lib/message-id-cache.js",
          "content.js",
        ]
        : [
          ...(isolatedStatus.hasUrl ? [] : ["lib/shopee-url.js"]),
          ...(isolatedStatus.hasShopee ? [] : ["lib/shopee.js"]),
          ...(isolatedStatus.hasAdapters ? [] : ["lib/provider-adapters.js"]),
          ...(isolatedStatus.hasProviderAdapter ? [] : ["lib/shopee-adapter.js"]),
          "lib/message-id-cache.js",
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
        await reconnectProviderTab(tab);
      } catch (error) {
        await recordUnexpected("provider_bridge_startup", error, { provider: adapter.id });
      }
    }
  }
  await ensureLiveConnection();
}

async function autoStartSellerCentreTab(tab) {
  const tabId = tab?.id;
  if (!Number.isInteger(tabId)) return { skipped: "tab_missing" };
  const existing = sellerCentreLandingStarts.get(tabId);
  if (existing) return existing;

  const start = (async () => {
    const currentTab = typeof tab?.url === "string" ? tab : await chrome.tabs.get(tabId);
    if (shopeeAdapter.surfaceForUrl?.(currentTab?.url) !== "seller-centre") {
      return { skipped: "not_seller_centre" };
    }
    const stored = await readStorage([
      STORAGE.unattendedRecovery,
      STORAGE.consent,
      STORAGE.config,
    ]);
    const configured = stored[STORAGE.config]?.accounts?.some(
      (account) => account?.provider === shopeeAdapter.id,
    );
    if (
      stored[STORAGE.unattendedRecovery] !== true
      || !hasLocalConsent(stored[STORAGE.consent])
      || !configured
    ) {
      return { skipped: "automatic_sync_disabled" };
    }

    await ensureProviderBridge(tabId, shopeeAdapter);
    const status = await providerTabStatus(currentTab);
    if (status?.chat_open === false) return { skipped: "mini_chat_closed" };
    const result = await sendProviderMessage(tabId, {
      type: "auto_open_chat_and_sync_v3",
      provider: shopeeAdapter.id,
    }, {
      label: providerLabel(shopeeAdapter),
      operation: "automatic Seller Centre startup",
      timeoutMs: PROVIDER_STATUS_RESPONSE_TIMEOUT_MS,
    });
    if (!result?.ok) {
      throw new Error(result?.error || "Shopee Seller Centre automatic startup failed.");
    }
    return result;
  })();

  sellerCentreLandingStarts.set(tabId, start);
  try {
    return await start;
  } finally {
    if (sellerCentreLandingStarts.get(tabId) === start) {
      sellerCentreLandingStarts.delete(tabId);
    }
  }
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
  timeoutMs = PROVIDER_REQUEST_TIMEOUT_MS,
  recoveryControl,
} = {}) {
  let timeout;
  let onAbort;
  const startedAt = performance.now();
  if (signal?.aborted) return Promise.reject(syncCancelledError());
  const response = Promise.resolve()
    .then(() => chrome.tabs.sendMessage(tabId, message)).catch((error) => {
      // Chrome supplies this specific lifecycle error. Keep it a failed operation,
      // with a useful message; never classify it as cancellation or retry a send.
      if (String(error?.message ?? error).includes("moved into back/forward cache")) {
        throw Object.assign(new Error("Page changed. Sync again."), { reason_code: "provider_page_changed", cause: error });
      }
      throw error;
    });
  const deadline = new Promise((_, reject) => {
    const touch = () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        if (recoveryControl) {
          void Promise.resolve().then(() => chrome.tabs.sendMessage(tabId, {
            type: "cancel_sync_v3", request_id: message.request_id,
            ...(message.provider_account_id ? { provider_account_id: message.provider_account_id } : {}),
          })).catch(() => undefined);
        }
        reject(providerMessageTimeout(label ?? "Provider", operation ?? "request"));
      }, timeoutMs);
    };
    if (recoveryControl) recoveryControl.touchRecovery = touch;
    touch();
  });
  const cancellation = new Promise((_, reject) => {
    if (!signal) return;
    onAbort = () => reject(syncCancelledError());
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([response, deadline, cancellation]).finally(() => {
    clearTimeout(timeout);
    if (recoveryControl) recoveryControl.touchRecovery = null;
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    void recordLog("debug", "timing", "provider_request", "Provider bridge request completed.", {
      provider: message.provider, provider_account_id: message.provider_account_id,
      operation, duration_ms: Math.round(performance.now() - startedAt),
    });
  });
}

function awaitProviderRecovery(tabId, message, control, signal) {
  if (signal.aborted) return Promise.reject(syncCancelledError());
  let timer;
  let onAbort;
  let resolve;
  let reject;
  const completion = new Promise((done, fail) => { resolve = done; reject = fail; });
  const waiter = { resolve, reject };
  control.recoveryCompletion = waiter;
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      reject(providerMessageTimeout("Provider", "recovery"));
      void sendProviderMessage(tabId, { type: "cancel_sync_v3", provider: message.provider,
        request_id: message.request_id, provider_account_id: message.provider_account_id }, {
        timeoutMs: PROVIDER_STATUS_RESPONSE_TIMEOUT_MS,
      }).catch(() => undefined);
    }, RECOVERY_IDLE_TIMEOUT_MS);
  };
  control.touchRecovery = touch;
  touch();
  onAbort = () => reject(syncCancelledError());
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  // Register completion before dispatch: a fast scan may finish before its ACK.
  // The Chrome response covers startup only, never the full recovery duration.
  const started = sendProviderMessage(tabId, message, {
    label: "Provider", operation: "start recovery", signal, timeoutMs: PROVIDER_STATUS_RESPONSE_TIMEOUT_MS,
  }).then(ack => {
    if (!ack?.ok || ack.started !== true || ack.request_id !== message.request_id) {
      throw new Error(ack?.error || "Provider recovery could not start.");
    }
  });
  return Promise.all([started, completion]).then(([, result]) => result).finally(() => {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    if (control.recoveryCompletion === waiter) {
      control.recoveryCompletion = null;
      control.touchRecovery = null;
    }
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
  if (context?.adapter?.id === "line_oa") {
    await updateScopedState(STORAGE.status, context.key, { phase: "connecting_provider" });
  }
  const adapter = context?.adapter ?? providerAdapterForAccount(context?.account);
  const label = providerLabel(adapter);
  const selectedGeneration = control.sessionGeneration;
  if (selectedGeneration != null) {
    const eligible = await activeLiveCommandContexts([context]);
    if (!eligible.some((item) => item.key === context.key)
      || !sessionEligibility.isCurrent(context.key, selectedGeneration)) {
      throw new Error("Provider session changed before recovery started. Verify the account and retry.");
    }
  }
  if (!adapter?.supports("message_recovery")) {
    throw new Error(`${label} does not support message recovery.`);
  }
  const { signal } = control.controller;
  throwIfSyncCancelled(signal);
  let tab = null;
  if (control.lockedTabId !== undefined) {
    tab = await exactProviderAccountTab(context, control.lockedTabId);
    if (control.lockedTabContext !== providerTabContext(tab, adapter.id)) {
      throw new Error("The selected provider tab changed. Retry from its current page.");
    }
  } else {
    const stored = await readStorage([STORAGE.providerRecoveryTabs]);
    const trackedTabId = providerRecoveryRecord(stored[STORAGE.providerRecoveryTabs], adapter.id)?.tab_id;
    const preferredTabId = control.preferredTabId ?? trackedTabId;
    const preferredTab = await providerChatTabById(adapter, preferredTabId);
    if (adapter.id === "shopee") {
      for (const candidate of orderProviderTabs(adapter, await providerChatTabs(adapter), preferredTabId)) {
        if (providerTabCanSend(await providerTabStatus(candidate), context)) { tab = candidate; break; }
      }
    } else if (preferredTab && await isReadyProviderTab(preferredTab, adapter)) tab = preferredTab;
    if (!tab && adapter.id !== "shopee") tab = await findReadyProviderChatTab(adapter);
    if (!tab) tab = preferredTab ?? await findProviderChatTab(adapter);
  }
  if (!tab) throw new Error(`Open ${label} to sync messages.`);
  control.tabId = tab.id;
  control.adapter = adapter;
  await ensureProviderBridge(tab.id, adapter);
  if (adapter.id === "shopee") {
    const status = await providerTabStatus(tab);
    await persistProviderSurfaceState(context, adapter, status, tab);
    if (status?.surface === "seller-centre" && status.chat_open === false) {
      throw new Error("Open Shopee mini-chat to continue syncing.");
    }
    if (status?.current_provider_account_id !== context.account.provider_account_id) {
      throw new Error("Shopee login changed. Retry sync for the currently open shop.");
    }
  }
  if (adapter.id === "line_oa" && !providerTabCanSend(await providerTabStatus(tab), context)) {
    throw new Error("This LINE account is not available to the current login. Check access and retry.");
  }
  throwIfSyncCancelled(signal);
  if (control.manualRestart) {
    await sendProviderMessage(tab.id, {
      type: "cancel_sync_v3", provider: adapter.id,
      provider_account_id: context.account.provider_account_id,
    }, {
      label, operation: "reset recovery", signal, timeoutMs: PROVIDER_STATUS_RESPONSE_TIMEOUT_MS,
    });
    if (adapter.id === "shopee") {
      await withRequestTimeout(() => resetProviderRecovery(tab.id), PROVIDER_STATUS_RESPONSE_TIMEOUT_MS, signal);
    }
    throwIfSyncCancelled(signal);
  }
  if (adapter.id === "line_oa") {
    await updateScopedState(STORAGE.status, context.key, { phase: "loading_conversations" });
  }
  if (control.lockedTabId !== undefined) {
    const current = await providerChatTabById(adapter, control.lockedTabId);
    if (!current || current.url !== tab.url || control.lockedTabContext !== providerTabContext(current, adapter.id)) {
      throw new Error("The selected provider tab changed. Retry from its current page.");
    }
  }
  control.providerRequestId = crypto.randomUUID();
  const syncMessage = {
    type: "sync_now_v3",
    request_id: control.providerRequestId,
    provider: context.account.provider,
    provider_account_id: context.account.provider_account_id,
    ...(context.config.bot_id || context.account.bot_id
      ? { bot_id: context.config.bot_id || context.account.bot_id }
      : {}),
  };
  const result = await awaitProviderRecovery(tab.id, syncMessage, control, signal);
  throwIfSyncCancelled(signal);
  if (!result?.ok) throw Object.assign(new Error(result?.error ?? `${label} recovery failed.`),
    { ...(result?.reason_code === "superseded" ? { reason_code: "superseded" } : {}),
      recovery_diagnostic_recorded: result?.recovery_diagnostic_recorded === true });
  return result;
}

async function retryProviderAccount(message) {
  if (!["line_oa", "shopee"].includes(message.provider)) throw new Error("Account retry is not supported for this provider.");
  const stored = await readStorage([STORAGE.config, STORAGE.detectedAccounts, STORAGE.consent, STORAGE.serverInitialized]);
  if (!hasLocalConsent(stored[STORAGE.consent])) throw new Error("Accept local consent before syncing.");
  const requested = configuredAccountContexts(stored).find((item) => item.adapter.id === message.provider
    && item.account.provider_account_id === message.provider_account_id);
  if (!requested) throw new Error("This provider account is not configured.");
  const alreadySyncing = () => (activeSyncControl?.providerAccountId === requested.account.provider_account_id
    && activeSyncControl?.adapter?.id === requested.adapter.id) || providerAutomaticRecoveries.has(requested.key);
  if (alreadySyncing()) return { skipped: "already_syncing" };
  const control = { controller: new AbortController(), manualRestart: true, accountKey: requested.key };
  let context;
  if (message.tab_id !== null && message.tab_id !== undefined) {
    const tab = await exactProviderAccountTab(requested, message.tab_id);
    control.lockedTabId = tab.id;
    control.lockedTabContext = providerTabContext(tab, requested.adapter.id);
    control.preferredTabId = tab.id;
    control.tabId = tab.id;
    context = requested;
  } else {
    // Legacy row retries retain provider-specific access verification and selection.
    const contexts = await openSessionSyncContexts([requested], control);
    context = contexts.find((item) => item.key === requested.key);
  }
  if (!context) throw new Error("This account is not available to the current login. Open its provider chat and retry.");
  if (alreadySyncing()) return { skipped: "already_syncing" };
  if (control.lockedTabId === undefined) control.sessionGeneration = sessionEligibility.generation(context.key);
  providerAutomaticRecoveries.set(context.key, control);
  try {
    await queueLiveStateWrite(() => writeStorage({ [STORAGE.serverInitialized]: true, [STORAGE.logUploadEnabled]: true }));
    control.completion = runAccountSync("manual", control, context);
    return await control.completion;
  } finally {
    if (providerAutomaticRecoveries.get(context.key) === control) providerAutomaticRecoveries.delete(context.key);
    void ensureLiveConnection().catch((error) => recordUnexpected("live_connection", error));
  }
}

function restartSync() {
  if (!syncRestart) {
    syncRestart = (async () => {
      const previous = activeSyncControl;
      previous?.controller.abort();
      // Detach immediately: a non-cooperative old request must not own the new run.
      activeSyncControl = null;
      activeSync = null;
      if (previous?.tabId) {
        await sendProviderMessage(previous.tabId, {
          type: "cancel_sync_v3",
          ...(previous.providerAccountId ? { provider_account_id: previous.providerAccountId } : {}),
          ...(previous.providerRequestId ? { request_id: previous.providerRequestId } : {}),
        }, {
          label: "Provider", operation: "cancel recovery", timeoutMs: PROVIDER_STATUS_RESPONSE_TIMEOUT_MS,
        }).catch(() => undefined);
      }
      return { sync: startSync("manual", true) };
    })().finally(() => { syncRestart = null; });
  }
  return syncRestart.then((result) => result.sync);
}

function startSync(trigger = "manual", restarting = false, provider = null) {
  if (syncRestart && !restarting) return syncRestart.then((result) => result.sync);
  if (activeSync) return activeSync;
  const control = {
    controller: new AbortController(),
    manualRestart: restarting,
    providerScope: provider === "line_oa" ? provider : null,
    tabId: null,
  };
  activeSyncControl = control;
  activeSync = runUnifiedSync(trigger, control)
    .finally(() => {
      if (activeSyncControl === control) {
        activeSyncControl = null;
        activeSync = null;
      }
    });
  return activeSync;
}

async function cancelActiveSync(provider = null, requestedTabId = null) {
  if (requestedTabId !== null && requestedTabId !== undefined) {
    if (!Number.isInteger(requestedTabId) || requestedTabId <= 0) throw new Error("A valid provider tab is required.");
    const controls = [...new Set([activeSyncControl, ...providerAutomaticRecoveries.values()])]
      .filter((control) => control && control.tabId === requestedTabId
        && (!provider || control.adapter?.id === provider || control.accountKey?.startsWith(`${provider}:`)));
    const completions = controls.map(control => control === activeSyncControl ? activeSync : control.completion).filter(Boolean);
    for (const control of controls) control.controller.abort();
    await Promise.allSettled(controls.map((control) => sendProviderMessage(requestedTabId, {
      type: "cancel_sync_v3", provider,
      ...(control.providerAccountId ? { provider_account_id: control.providerAccountId } : {}),
      ...(control.providerRequestId ? { request_id: control.providerRequestId } : {}),
    }, { label: "Provider", operation: "cancel recovery", timeoutMs: PROVIDER_STATUS_RESPONSE_TIMEOUT_MS })));
    await Promise.allSettled(completions);
    return { cancelled: controls.length > 0 };
  }
  if (provider === "line_oa") {
    const controls = [activeSyncControl, ...providerAutomaticRecoveries.values()].filter((control) => control
      && (control.adapter?.id === "line_oa" || control.providerScope === "line_oa"
        || control.accountKey?.startsWith("line_oa:")));
    for (const control of controls) control.controller.abort();
    await Promise.allSettled(controls.filter((control) => control.tabId).map((control) => sendProviderMessage(control.tabId, {
      type: "cancel_sync_v3", provider: "line_oa",
      ...(control.providerAccountId ? { provider_account_id: control.providerAccountId } : {}),
      ...(control.providerRequestId ? { request_id: control.providerRequestId } : {}),
    }, { label: "LINE OA", operation: "cancel recovery", timeoutMs: PROVIDER_STATUS_RESPONSE_TIMEOUT_MS })));
    return { cancelled: controls.length > 0 };
  }
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
  return exclusive(() => serializeAccountStorage(async () => {
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
  }));
}

async function runAccountSync(trigger, control, context) {
  const { signal } = control.controller;
  control.adapter = context.adapter;
  control.providerAccountId = context.account.provider_account_id;
  const automatic = trigger === "automatic";
  const providerAccountId = context.account.provider_account_id;
  const prepared = await exclusive(async () => {
    throwIfSyncCancelled(signal);
    const { state, stored } = await getAccountScanState(providerAccountId, context.account.provider);
    throwIfSyncCancelled(signal);
    const lastAutoAt = Date.parse(state.last_auto_at ?? "");
    const lastSyncAt = Date.parse(
      readAccountState(stored[STORAGE.status], context.key, {}).last_sync_at ?? "",
    );
    const lastCompletedAt = Math.max(
      Number.isFinite(lastAutoAt) ? lastAutoAt : 0,
      Number.isFinite(lastSyncAt) ? lastSyncAt : 0,
    );
    if (automatic
      && !control.restorePolling
      && !state.in_progress
      && lastCompletedAt > 0
      && Date.now() - lastCompletedAt < RESUME_SYNC_COOLDOWN_MS) {
      return { skipped: "cooldown" };
    }
    const startedAt = new Date().toISOString();
    await writeAccountScanState(context, {
      in_progress: true,
      started_at: startedAt,
      ...(automatic ? { last_auto_at: startedAt } : {}),
    });
    await updateScopedState(STORAGE.status, context.key, {
      state: "discovering",
      phase: "preparing",
      sync_attempt_id: null,
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
    void attemptDelivery(context, { resetBackoff: true })
      .catch((error) => recordUnexpected("message_delivery", error));
    throwIfSyncCancelled(signal);
    await updateScopedState(STORAGE.status, context.key, {
      state: "syncing",
      phase: context.adapter.id === "line_oa" ? "connecting_provider" : "checking_conversations",
      completed_conversations: 0,
      total_conversations: 0,
      pages_fetched: 0,
      conversation_pages: 0,
      messages_captured: 0,
      last_progress_at: null,
    });
    await recordLog("info", "sync", "provider_recovery", `Requesting missed messages from ${providerLabel(context.adapter)}.`, {
      provider: context.account.provider,
      provider_account_id: providerAccountId,
    });
    const recovered = await syncOpenProvider(control, context);
    throwIfSyncCancelled(signal);
    await exclusive(async () => {
      throwIfSyncCancelled(signal);
      const { state } = await getAccountScanState(providerAccountId, context.account.provider);
      throwIfSyncCancelled(signal);
      await writeAccountScanState(context, {
        watermark: recovered.watermark ?? state.watermark,
        bootstrap: null,
        in_progress: false,
        completed_at: new Date().toISOString(),
      });
    });
    await updateScopedState(STORAGE.status, context.key, {
      state: "discovering",
      phase: "sending_recovered",
      completed_conversations: null,
      total_conversations: null,
    });
    const delivered = await attemptDelivery(context, { resetBackoff: true, signal });
    throwIfSyncCancelled(signal);
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
    const live = liveConnections.get(context.key);
    if (live?.socket) {
      void sendConnectionStatus(live.socket, context)
        .catch((error) => recordUnexpected("connection_status", error));
    }
    return result;
  } catch (error) {
    if (!isCurrentSyncControl(control)) throw syncCancelledError();
    const cancelled = signal.aborted || error?.name === "AbortError";
    const message = cancelled
      ? "Sync cancelled."
      : error instanceof Error ? error.message : String(error);
    const stored = await readStorage([STORAGE.pending, STORAGE.scanState]);
    const pending = readAccountState(stored[STORAGE.pending], context.key, []);
    const state = readAccountState(stored[STORAGE.scanState], context.key, null);
    if (state) {
      await writeAccountScanState(context, {
        in_progress: false,
        ...(cancelled
          ? { cancelled_at: new Date().toISOString() }
          : { failed_at: new Date().toISOString() }),
      });
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
    if (error?.reason_code === "superseded") {
      await recordLog("info", "sync", "superseded", "Sync superseded by provider reconnect.", {
        provider_account_id: providerAccountId, reason_code: "superseded",
      });
    } else if (error?.recovery_diagnostic_recorded !== true) {
      await recordUnexpected("message_sync", error, { provider_account_id: providerAccountId });
    }
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

async function openSessionSyncContexts(contexts, control) {
  contexts = await lineSessionContexts(contexts, { refresh: true });
  const shopee = contexts.filter((context) => context.adapter.id === "shopee");
  if (!shopee.length) return contexts;
  let tab = null;
  let currentId = null;
  let observedStatus = null;
  let tabContext = null;
  const epoch = providerSessionEpoch("shopee");
  const observation = ++providerObservationSequence;
  try {
    tab = await findReadyProviderChatTab(shopeeAdapter) ?? await findProviderChatTab(shopeeAdapter);
    tabContext = tab ? providerTabContext(tab, "shopee") : null;
    const detected = tab ? await detectOpenProviderAccount("shopee", tab.id) : null;
    observedStatus = detected?.ok ? await providerTabStatus(tab) : null;
    currentId = observedStatus?.current_provider_account_id ?? null;
  } catch (error) {
    await recordUnexpected("session_detection", error, { provider: "shopee" });
  }
  // Reload configuration after detection: the owner may have switched shop since the last sync.
  const stored = await readStorage([STORAGE.config, STORAGE.detectedAccounts]);
  const currentContexts = configuredAccountContexts(stored).filter((context) =>
    contexts.some((selected) => selected.key === context.key));
  throwIfSyncCancelled(control.controller.signal);
  const selected = currentContexts.filter((context) => context.adapter.id !== "shopee"
    || (currentId && context.account.provider_account_id === currentId));
  for (const context of shopee) {
    if (context.account.provider_account_id === currentId) continue;
    await recordLog("info", "sync", "skipped", currentId
      ? "Shopee sync skipped: a different shop is open."
      : "Shopee sync skipped: the current shop could not be verified.", {
      provider: "shopee",
      provider_account_id: context.account.provider_account_id,
      current_provider_account_id: currentId,
      reason_code: currentId ? "account_mismatch" : "session_unverified",
    });
    await updateScopedState(STORAGE.status, context.key, {
      state: "watching", phase: null, caught_up: false,
      sync_error: currentId ? "This shop is not active in this browser. Use a separate Chrome profile for each Shopee shop."
        : "Could not verify the current Shopee shop. Refresh Seller Chat and try again.",
      sync_error_at: null,
    });
  }
  for (const context of shopee) await providerReadiness(context, {
    tabs: tab ? [tab] : [], statuses: tab ? [observedStatus] : [], epoch, tabContexts: tab ? [tabContext] : [], observation,
  });
  if (tab) control.preferredTabId = tab.id;
  return selected;
}

async function runUnifiedSync(trigger, control) {
  const stored = await readStorage([STORAGE.config, STORAGE.consent, STORAGE.detectedAccounts]);
  if (!hasLocalConsent(stored[STORAGE.consent])) {
    throw new Error("Provider browser bridge is not configured.");
  }
  const candidates = configuredAccountContexts(stored).filter((context) => !control.providerScope
    || context.adapter.id === control.providerScope);
  const accounts = [];
  const attemptId = control.syncAttemptId ??= crypto.randomUUID();
  const preflight = new Map();
  const settlePreflight = async (context) => {
    const previous = preflight.get(context.key);
    if (!previous) return;
    await updateScopedState(STORAGE.status, context.key, (current) => {
      if (current.sync_attempt_id !== attemptId) return {};
      if (!["checking_session", "queued"].includes(current.phase)) return { sync_attempt_id: null };
      return { state: ["discovering", "syncing"].includes(previous.state) ? "watching" : previous.state ?? "watching",
        phase: ["discovering", "syncing"].includes(previous.state) ? null : previous.phase ?? null,
        sync_attempt_id: null };
    });
    preflight.delete(context.key);
  };
  const providers = [...new Set(candidates.map((item) => item.adapter.id))]
    .sort((left, right) => (left === "shopee" ? -1 : right === "shopee" ? 1 : 0));
  try {
    for (const provider of providers) {
      const providerCandidates = candidates.filter((item) => item.adapter.id === provider
        && !providerAutomaticRecoveries.has(item.key));
      if (!providerCandidates.length) continue;
      for (const context of providerCandidates) await updateScopedState(STORAGE.status, context.key, (current) => {
        preflight.set(context.key, { context, state: current.state, phase: current.phase });
        return { state: "discovering", phase: "checking_session", sync_attempt_id: attemptId };
      });
      const contexts = await openSessionSyncContexts(providerCandidates, control);
      for (const context of providerCandidates) {
        if (!contexts.some((selected) => selected.key === context.key)) await settlePreflight(context);
        else await updateScopedState(STORAGE.status, context.key, (current) =>
          current.sync_attempt_id === attemptId && current.phase === "checking_session"
            ? { phase: "queued" } : {});
      }
      for (const context of contexts) {
        throwIfSyncCancelled(control.controller.signal);
        if (providerAutomaticRecoveries.has(context.key)) continue;
        control.sessionGeneration = sessionEligibility.generation(context.key);
        accounts.push(await runAccountSync(trigger, control, context));
        await settlePreflight(context);
      }
    }
    if (!accounts.length && !candidates.some((item) => providerAutomaticRecoveries.has(item.key))) {
      throw new Error("Log in to a configured provider account and open its chat to sync.");
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
  } finally {
    for (const { context } of preflight.values()) await settlePreflight(context);
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
  const startedAt = performance.now();
  const captured = await serializeAccountStorage(async () => {
    const stored = await readStorage([
      STORAGE.consent,
      STORAGE.pending,
      STORAGE.scanState,
      STORAGE.targetCursor,
      STORAGE.lastResumeSyncAt,
      STORAGE.serverInitialized,
      STORAGE.status,
    ]);
    if (!hasLocalConsent(stored[STORAGE.consent])) return null;
    const scope = await metadataScope(context);
    const scopedMessages = [];
    for (const message of Array.isArray(messages) ? messages : []) {
      scopedMessages.push(await customerMetadata.enrich(scope, message));
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
          messages_captured: (currentStatus.messages_captured ?? 0) + added.length,
          ...(added.length ? { last_progress_at: new Date().toISOString() } : {}),
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
    return { scopedMessages, added, pendingCount, latestCursor, deferCursorAdvance, initialized: hasServerInitialized(stored) };
  });
  if (!captured) {
    await recordLog("debug", "queue", "ignored", "Captured messages were ignored because setup is incomplete.", {
      consented: false,
      provider_account_id: context.account.provider_account_id,
    });
    return { queued: 0, sent: 0, pending: 0 };
  }
  const { scopedMessages, added, pendingCount, latestCursor, deferCursorAdvance, initialized } = captured;
  // The caller acknowledges only local durable capture. Forwarding owns its
  // account queue and must never extend the global capture/storage lock.
  if (initialized) {
    void attemptDelivery(context, { resetBackoff: false })
      .catch((error) => recordUnexpected("message_delivery", error, {
        provider: context.account.provider,
        provider_account_id: context.account.provider_account_id,
      }));
  }
  void recordLog("info", "queue", "stored", "Captured messages stored for delivery.", {
    provider_account_id: context.account.provider_account_id,
    received: scopedMessages.length, queued: added.length,
    pending: pendingCount, deferred: deferCursorAdvance,
    duration_ms: Math.round(performance.now() - startedAt),
  });
  return {
    queued: added.length, sent: 0, pending: pendingCount,
    deferred: deferCursorAdvance, latest_cursor: latestCursor,
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
    const routing = adapter.normalizeRouting?.(message.omnichat?.routing);
    if (routing && (!conversation.omnichat?.routing
      || Date.parse(routing.observed_at) >= Date.parse(conversation.omnichat.routing.observed_at))) {
      conversation.omnichat = { routing };
    }
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
      ...(message.provider_content ? { provider_content: message.provider_content } : {}),
      ...(message.sticker ? { sticker: message.sticker } : {}),
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
  const startedAt = performance.now();
  const url = new URL(config.events_url);
  if (url.protocol !== "https:") throw new Error("Target server must use HTTPS.");
  const body = JSON.stringify(payload);
  const timestamp = new Date().toISOString();
  const nonce = crypto.randomUUID();
  const bodyHash = await sha256Hex(body);
  const signature = await hmacHex(config.hmac_secret, `POST\n${url.pathname}\n${timestamp}\n${nonce}\n${bodyHash}`);
  return withRequestTimeout(async (requestSignal) => {
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
      signal: requestSignal,
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
  }, 15_000, signal).finally(() => {
    void recordLog("debug", "timing", "target_request", "Target server request completed.", {
      provider: payload.provider, provider_account_id: providerAccountId,
      duration_ms: Math.round(performance.now() - startedAt),
    });
  });
}

async function sendLogBatch(context, logs) {
  const url = new URL(context.config.logs_url);
  if (url.protocol !== "https:") throw new Error("Logs server must use HTTPS.");
  const managedLogs = ["https://ingress.kaojai.ai", "https://ingress.kaojai.dev"].includes(url.origin)
    && url.pathname === "/logs/omnichat";
  const payload = {
    schema: "omnichat.log_batch",
    version: 1,
    batch_id: crypto.randomUUID(),
    installation_id: await installationId(),
    provider: context.account.provider,
    provider_account_id: context.account.provider_account_id,
    extension_version: chrome.runtime.getManifest().version,
    ...(managedLogs ? {
      ...(context.config.tenant_id ? { tenant_id: context.config.tenant_id } : {}),
      canonical_provider_account_id: canonicalProviderAccountId(context),
    } : {}),
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
  return withRequestTimeout(async (requestSignal) => {
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
      signal: requestSignal,
    });
    if (!response.ok) throw new Error(`Logs server returned ${response.status}.`);
    return payload.batch_id;
  }, 15_000);
}

let logSubmission = null;
function submitLogs() {
  if (logSubmission) return logSubmission;
  logSubmission = flushLogBatch().finally(() => { logSubmission = null; });
  return logSubmission;
}

async function flushLogBatch() {
  await diagnosticBuffer.drain();
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
    || stored[STORAGE.logUploadEnabled] !== true) return { ok: false, submitted: 0, error: "Complete account setup before submitting logs." };
  const contexts = configuredAccountContexts(stored).filter((context) => context.config.logs_url);
  if (!contexts.length) return { ok: false, submitted: 0, error: "No configured log destination." };
  const queuedIds = new Set(Array.isArray(stored[STORAGE.logOutbox]) ? stored[STORAGE.logOutbox] : []);
  const entries = pruneLogs(stored[STORAGE.logs]);
  let submitted = 0;
  let failed = false;
  for (const context of contexts) {
    const pending = entries
      .filter((entry) => entry.account_key === context.key && queuedIds.has(entry.id))
      .reverse();
    for (let offset = 0; offset < pending.length; offset += MAX_LOG_UPLOAD_BATCH) {
      const selected = pending.slice(offset, offset + MAX_LOG_UPLOAD_BATCH);
      try {
        await sendLogBatch(context, selected);
        const deliveredIds = new Set(selected.map((entry) => entry.id));
        await mutateLogs(async () => {
          const current = await readStorage([STORAGE.logOutbox]);
          const outbox = (Array.isArray(current[STORAGE.logOutbox]) ? current[STORAGE.logOutbox] : [])
            .filter((id) => !deliveredIds.has(id));
          await writeStorage({ [STORAGE.logOutbox]: outbox });
        });
        submitted += selected.length;
        await recordLog("info", "logs", "uploaded", "Operational logs uploaded.", {
          provider_account_id: context.account.provider_account_id,
          count: selected.length,
        }, { remote: false });
      } catch (error) {
        failed = true;
        await recordLog("warn", "logs", "upload_failed", "Operational log upload failed.", {
          provider_account_id: context.account.provider_account_id,
          ...diagnosticErrorDetails(error),
        }, { remote: false });
        break; // Manual submission never retries a failed batch.
      }
    }
  }
  const remaining = entries.filter((entry) => queuedIds.has(entry.id)).length - submitted;
  return { ok: !failed && remaining === 0, submitted, remaining,
    ...(failed || remaining ? { error: "Some logs could not be submitted. Submit again to try the remaining logs." } : {}) };
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

async function deliveryMessageDetails(context, message, index, extra = {}) {
  const details = {
    provider_account_id: context.account.provider_account_id,
    provider: messageProvider(message),
    message_key: messageKey(message),
    message_id: messageIdentifier(message.id),
    conversation_id: messageIdentifier(message.conversation_id),
    sender_id: messageIdentifier(message.sender_id),
    recipient_id: messageIdentifier(message.recipient_id),
    sender_account_id: messageIdentifier(message.sender_account_id),
    recipient_account_id: messageIdentifier(message.recipient_account_id),
    type: messageIdentifier(message.type),
    provider_type: messageIdentifier(message.provider_type),
    has_text: typeof message.text === "string" && message.text.length > 0,
    text_length: typeof message.text === "string" ? message.text.length : 0,
    has_media: typeof message.media_url === "string" && message.media_url.trim().length > 0,
    event_timestamp: messageIdentifier(message.event_timestamp),
    capture_method: messageIdentifier(message.capture_method),
    message_index: index + 1,
  };
  try {
    details.message_fingerprint = await sha256Hex(JSON.stringify(details));
  } catch {
    // The identifiers above are still useful if Web Crypto is unavailable.
  }
  return { ...details, ...extra };
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
  let acknowledgedMessages = 0;
  let duplicateMessages = 0;
  let skippedMessages = 0;
  const deliveryBatchDetails = new WeakMap();
  const skippedMessageDetails = new Map();
  const batchDetailsFor = (error) => (
    error && typeof error === "object" ? deliveryBatchDetails.get(error) ?? {} : {}
  );
  const outcome = await deliverWithIsolation(
    selected,
    async (messages) => {
      const payload = batchFor(messages, installId);
      const serializedPayload = JSON.stringify(payload);
      const batchDetails = {
        batch_id: payload.batch_id,
        batch_size: messages.length,
        conversation_count: payload.conversations.length,
        request_bytes: serializedPayload.length,
        pending_before: pending.length,
      };
      try {
        if (serializedPayload.length > 1_000_000) {
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
        const skippedFromServer = Array.isArray(acknowledgement.skipped_messages)
          ? acknowledgement.skipped_messages
          : [];
        const groupReferences = new Set(messages.map(messageReference));
        const skippedByReference = new Map();
        for (const skipped of skippedFromServer) {
          const reference = `${skipped?.conversation_id ?? ""}\u0000${skipped?.message_id ?? ""}`;
          if (!skipped?.conversation_id
            || !skipped?.message_id
            || !groupReferences.has(reference)
            || skippedByReference.has(reference)) {
            throw new Error("Target server acknowledgement is invalid.");
          }
          skippedByReference.set(reference, skipped);
          skippedMessageDetails.set(reference, {
            ...batchDetails,
            server_error_code: messageIdentifier(skipped.reason) ?? "unknown_skip_reason",
          });
        }
        if (acknowledgement.accepted_messages
          + acknowledgement.duplicate_messages
          + skippedFromServer.length !== messages.length) {
          throw new Error("Target server acknowledgement is invalid.");
        }
        acknowledgedMessages += acknowledgement.accepted_messages;
        duplicateMessages += acknowledgement.duplicate_messages;
        skippedMessages += skippedFromServer.length;
        await recordLog("debug", "delivery", "batch_acknowledged", "Target server acknowledged a queued message batch.", {
          provider_account_id: context.account.provider_account_id,
          ...batchDetails,
          accepted_messages: acknowledgement.accepted_messages,
          duplicate_messages: acknowledgement.duplicate_messages,
          skipped_messages: skippedFromServer.length,
        });
        return {
          skipped: messages.filter((message) => skippedByReference.has(messageReference(message))),
        };
      } catch (error) {
        if (error && typeof error === "object") deliveryBatchDetails.set(error, batchDetails);
        throw error;
      }
    },
    isMessageScopedDeliveryError,
  );
  const deliveredKeys = new Set(outcome.delivered.map(messageKey));
  for (const message of outcome.skipped) deliveredKeys.add(messageKey(message));
  const failure = outcome.failed[0]?.error ?? outcome.blocked?.error ?? null;
  const failureMessage = failure instanceof Error ? failure.message : String(failure ?? "");
  const now = new Date().toISOString();
  const remaining = await serializeAccountStorage(async () => {
    const current = await readStorage([STORAGE.pending, STORAGE.status]);
    const remaining = readAccountState(current[STORAGE.pending], context.key, [])
      .filter((message) => !deliveredKeys.has(messageKey(message)));
    const currentStatus = readAccountState(current[STORAGE.status], context.key, {});
    await writeStorage({
      [STORAGE.pending]: writeAccountState(current[STORAGE.pending], context.key, remaining),
      [STORAGE.status]: writeAccountState(current[STORAGE.status], context.key, {
        ...currentStatus,
        state: ["discovering", "syncing"].includes(currentStatus.state) ? currentStatus.state : "watching",
        delivery_error: failureMessage || null,
        delivery_error_at: failureMessage ? now : null,
        ...(outcome.delivered.length ? { last_delivery_at: now } : {}),
        pending: remaining.length,
      }),
    });
    return remaining;
  });
  for (const failed of outcome.failed) {
    await recordLog("error", "message_delivery", "failed", "A queued message could not be delivered.", {
      ...diagnosticErrorDetails(failed.error),
      ...(await deliveryMessageDetails(
        context,
        failed.message,
        selected.indexOf(failed.message),
        {
          queue_index: pending.indexOf(failed.message) + 1,
          delivery_scope: "message",
          ...batchDetailsFor(failed.error),
        },
      )),
    });
  }
  for (const message of outcome.skipped) {
    await recordLog("error", "message_delivery", "server_skipped", "Target server skipped a queued message.", {
      ...(await deliveryMessageDetails(
        context,
        message,
        selected.indexOf(message),
        {
          queue_index: pending.indexOf(message) + 1,
          delivery_scope: "server_skip",
          ...(skippedMessageDetails.get(messageReference(message)) ?? {
            server_error_code: "unknown_skip_reason",
          }),
        },
      )),
    });
  }
  if (outcome.blocked) {
    const batchDetails = {
      batch_size: outcome.blocked.messages.length,
      pending_before: pending.length,
      ...batchDetailsFor(outcome.blocked.error),
    };
    await recordLog("error", "message_delivery", "batch_blocked", "A queued message batch could not be delivered; its messages remain pending.", {
      ...diagnosticErrorDetails(outcome.blocked.error),
      provider_account_id: context.account.provider_account_id,
      ...batchDetails,
    });
    for (const message of outcome.blocked.messages) {
      await recordLog("error", "message_delivery", "message_blocked", "A queued message remains pending because its batch failed.", {
        ...diagnosticErrorDetails(outcome.blocked.error),
        ...(await deliveryMessageDetails(
          context,
          message,
          selected.indexOf(message),
          {
            queue_index: pending.indexOf(message) + 1,
            delivery_scope: "batch",
            ...batchDetails,
          },
        )),
      });
    }
  }
  if (outcome.delivered.length) {
    await recordLog("info", "delivery", "batch_sent", "Message batch accepted by target server.", {
      provider_account_id: context.account.provider_account_id,
      sent: outcome.delivered.length,
      accepted_messages: acknowledgedMessages,
      duplicate_messages: duplicateMessages,
      skipped_messages: skippedMessages,
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
    const result = await deliveryScheduler.run(() => flushBatch(context, signal));
    sent += result.sent;
    pending = result.pending;
    if (!pending || (!result.sent && !result.skipped) || result.failed || result.blocked) break;
  }
  return { sent, pending };
}

async function resetDeliveryRetry(context) {
  await updateScopedState(STORAGE.deliveryRetry, context.key, { attempt: 0, next_at: null });
}

async function clearDeliveryRetryAlarm() {
  await chrome.alarms.clear(DELIVERY_RETRY_ALARM);
}

async function clearDeliveryRetry(context) {
  await serializeAccountStorage(async () => {
    const stored = await readStorage([STORAGE.pending, STORAGE.status, STORAGE.deliveryRetry]);
    const current = readAccountState(stored[STORAGE.status], context.key, {});
    await writeStorage({
      [STORAGE.deliveryRetry]: writeAccountState(stored[STORAGE.deliveryRetry], context.key, { attempt: 0, next_at: null }),
      [STORAGE.status]: writeAccountState(stored[STORAGE.status], context.key, {
        ...current,
        delivery_error: null,
        delivery_error_at: null,
        pending: readAccountState(stored[STORAGE.pending], context.key, []).length,
      }),
    });
  });
}

async function scheduleDeliveryRetry(context) {
  let attempt;
  let nextAt;
  await updateScopedState(STORAGE.deliveryRetry, context.key, (current) => {
    attempt = Number(current?.attempt) || 0;
    nextAt = Date.now() + deliveryRetryDelay(attempt);
    return { attempt: attempt + 1, next_at: new Date(nextAt).toISOString() };
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

const accountDeliveries = new Map();
const accountDeliveryWakeups = new Set();
function attemptDelivery(context, options) {
  const key = context?.key;
  const previous = accountDeliveries.get(key);
  if (previous) {
    accountDeliveryWakeups.add(key);
    return previous;
  }
  const operation = Promise.resolve().then(async () => {
    let result;
    let sent = 0;
    do {
      accountDeliveryWakeups.delete(key);
      result = await deliverPendingForAccount(context, options);
      sent += Number(result.sent) || 0;
    } while (accountDeliveryWakeups.has(key) && !options.signal?.aborted);
    return { ...result, sent };
  });
  accountDeliveries.set(key, operation);
  void operation.finally(() => {
    if (accountDeliveries.get(key) === operation) {
      accountDeliveries.delete(key);
      if (accountDeliveryWakeups.delete(key)) void attemptDelivery(context, { resetBackoff: false })
        .catch((error) => recordUnexpected("message_delivery", error));
    }
  }).catch(() => undefined);
  return operation;
}

async function deliverPendingForAccount(context, { resetBackoff, signal }) {
  const stored = await readStorage([
    STORAGE.consent,
    STORAGE.pending,
    STORAGE.serverInitialized,
    STORAGE.deliveryRetry,
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
  const retry = readAccountState(stored[STORAGE.deliveryRetry], context.key, {});
  const nextAt = Date.parse(retry.next_at ?? "");
  if (!resetBackoff && Number.isFinite(nextAt) && nextAt > Date.now()) {
    return { sent: 0, pending: pending.length, skipped: "backoff" };
  }
  try {
    const result = await flushAll(context, signal);
    if (result.pending) await scheduleDeliveryRetry(context);
    else await clearDeliveryRetry(context);
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
  const results = await Promise.all(contexts.map((context) => attemptDelivery(context, options)));
  const pending = results.reduce((total, result) => total + (Number(result.pending) || 0), 0);
  if (!pending) await clearDeliveryRetryAlarm();
  return {
    sent: results.reduce((total, result) => total + (Number(result.sent) || 0), 0),
    pending,
    accounts: results.length,
  };
}

async function flushAccountPending(providerAccountId, provider = "") {
  const stored = await readStorage([
    STORAGE.config,
    STORAGE.consent,
    STORAGE.detectedAccounts,
  ]);
  const context = accountContextFor(stored, providerAccountId, provider);
  if (!hasLocalConsent(stored[STORAGE.consent]) || !context) {
    throw new Error("Provider browser bridge is not configured.");
  }
  return attemptDelivery(context, { resetBackoff: false });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === API_PING_ALARM) {
    void pingConfiguredAccountApis().catch((error) => recordUnexpected("api_ping_schedule", error));
  } else if (alarm.name === DELIVERY_RETRY_ALARM) {
    void recordLog("info", "delivery", "retry_started", "Retrying queued message delivery.");
    void attemptAllDeliveries({ resetBackoff: false });
  } else if (alarm.name === PROVIDER_HEALTH_ALARM) {
    // Transport repair must not wait for provider checks or queued uploads.
    void ensureLiveConnection().catch((error) => recordUnexpected("live_connection", error));
    void runProviderHealthWatchdog().catch((error) => recordUnexpected("provider_watchdog", error));
  }
});

// One immediate recovery attempt after the machine regains network access.
self.addEventListener("online", () => {
  for (const connection of liveConnections.values()) {
    clearTimeout(connection.reconnectTimer);
    connection.reconnectTimer = null;
  }
  void ensureLiveConnection().catch((error) => recordUnexpected("live_connection", error));
});
