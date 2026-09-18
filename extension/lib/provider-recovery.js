export const PROVIDER_RECOVERY_STATES = Object.freeze({
  opening: "opening",
  ready: "ready",
  needsAttention: "needs_attention",
});

export const PROVIDER_RECOVERY_STORAGE_VERSION = 1;
export const PROVIDER_RECOVERY_FAILURE_THRESHOLD = 2;
export const PROVIDER_RECOVERY_RETRY_BASE_MS = 60_000;
export const PROVIDER_RECOVERY_RETRY_MAX_MS = 30 * 60_000;

const VALID_STATES = new Set(Object.values(PROVIDER_RECOVERY_STATES));

function providerId(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function tabId(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function timestamp(value) {
  return Number.isFinite(value) && value > 0 ? value : null;
}

function count(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function reason(value) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 240) : null;
}

export function normalizeProviderRecoveryTabs(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { version: PROVIDER_RECOVERY_STORAGE_VERSION, providers: {} };
  }
  const source = value.version === PROVIDER_RECOVERY_STORAGE_VERSION
    && value.providers && typeof value.providers === "object" && !Array.isArray(value.providers)
    ? value.providers
    : value;
  const providers = {};
  for (const [rawProvider, rawRecord] of Object.entries(source)) {
    const provider = providerId(rawProvider);
    if (!provider || !rawRecord || typeof rawRecord !== "object" || Array.isArray(rawRecord)) continue;
    const state = VALID_STATES.has(rawRecord.state)
      ? rawRecord.state
      : PROVIDER_RECOVERY_STATES.needsAttention;
    providers[provider] = {
      state,
      tab_id: tabId(rawRecord.tab_id),
      opened_by_extension: rawRecord.opened_by_extension === true,
      opened_at: timestamp(rawRecord.opened_at),
      failure_count: count(rawRecord.failure_count),
      last_failure_at: timestamp(rawRecord.last_failure_at),
      next_retry_at: timestamp(rawRecord.next_retry_at),
      last_reload_at: timestamp(rawRecord.last_reload_at),
      reason: reason(rawRecord.reason),
    };
  }
  return { version: PROVIDER_RECOVERY_STORAGE_VERSION, providers };
}

export function providerRecoveryRecord(value, provider) {
  const normalizedProvider = providerId(provider);
  if (!normalizedProvider) return null;
  return normalizeProviderRecoveryTabs(value).providers[normalizedProvider] ?? null;
}

export function updateProviderRecoveryRecord(value, provider, patch = {}) {
  const normalized = normalizeProviderRecoveryTabs(value);
  const normalizedProvider = providerId(provider);
  if (!normalizedProvider) return normalized;
  const current = normalized.providers[normalizedProvider] ?? {
    state: PROVIDER_RECOVERY_STATES.opening,
    tab_id: null,
    opened_by_extension: false,
    opened_at: null,
    failure_count: 0,
    last_failure_at: null,
    next_retry_at: null,
    last_reload_at: null,
    reason: null,
  };
  const next = {
    ...current,
    ...patch,
  };
  normalized.providers[normalizedProvider] = {
    state: VALID_STATES.has(next.state) ? next.state : current.state,
    tab_id: tabId(next.tab_id),
    opened_by_extension: next.opened_by_extension === true,
    opened_at: timestamp(next.opened_at),
    failure_count: count(next.failure_count),
    last_failure_at: timestamp(next.last_failure_at),
    next_retry_at: timestamp(next.next_retry_at),
    last_reload_at: timestamp(next.last_reload_at),
    reason: reason(next.reason),
  };
  return normalized;
}

export function recoveryRetryDelay(failureCount) {
  const exponent = Math.max(0, count(failureCount) - PROVIDER_RECOVERY_FAILURE_THRESHOLD);
  return Math.min(PROVIDER_RECOVERY_RETRY_MAX_MS, PROVIDER_RECOVERY_RETRY_BASE_MS * (2 ** exponent));
}

export function recoveryRetryDue(record, now = Date.now()) {
  return !record?.next_retry_at || record.next_retry_at <= now;
}
