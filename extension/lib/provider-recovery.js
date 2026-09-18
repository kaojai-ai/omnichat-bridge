export const PROVIDER_RECOVERY_STATES = Object.freeze({
  opening: "opening",
  ready: "ready",
  needsAttention: "needs_attention",
});

export const PROVIDER_RECOVERY_OPENING_TIMEOUT_MS = 5 * 60_000;

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

function reason(value) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 240) : null;
}

export function normalizeProviderRecoveryTabs(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const normalized = {};
  for (const [rawProvider, rawRecord] of Object.entries(value)) {
    const provider = providerId(rawProvider);
    if (!provider || !rawRecord || typeof rawRecord !== "object" || Array.isArray(rawRecord)) continue;
    const state = VALID_STATES.has(rawRecord.state)
      ? rawRecord.state
      : PROVIDER_RECOVERY_STATES.needsAttention;
    normalized[provider] = {
      state,
      tab_id: tabId(rawRecord.tab_id),
      opened_at: timestamp(rawRecord.opened_at),
      reason: reason(rawRecord.reason),
    };
  }
  return normalized;
}

export function providerRecoveryRecord(value, provider) {
  const normalizedProvider = providerId(provider);
  if (!normalizedProvider) return null;
  return normalizeProviderRecoveryTabs(value)[normalizedProvider] ?? null;
}

export function updateProviderRecoveryRecord(value, provider, patch = {}) {
  const normalized = normalizeProviderRecoveryTabs(value);
  const normalizedProvider = providerId(provider);
  if (!normalizedProvider) return normalized;
  const current = normalized[normalizedProvider] ?? {
    state: PROVIDER_RECOVERY_STATES.opening,
    tab_id: null,
    opened_at: null,
    reason: null,
  };
  const next = {
    ...current,
    ...patch,
  };
  normalized[normalizedProvider] = {
    state: VALID_STATES.has(next.state) ? next.state : current.state,
    tab_id: tabId(next.tab_id),
    opened_at: timestamp(next.opened_at),
    reason: reason(next.reason),
  };
  return normalized;
}

export function recoveryOpeningExpired(record, now = Date.now()) {
  if (!record || record.state !== PROVIDER_RECOVERY_STATES.opening) return false;
  if (!record.opened_at) return true;
  return now - record.opened_at >= PROVIDER_RECOVERY_OPENING_TIMEOUT_MS;
}
