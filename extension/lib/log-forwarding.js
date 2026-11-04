// Installation-local scheduling policy; diagnostics never own customer work.
export const automaticLogForwardingEnabled = (stored) => stored.forward_log !== false;
export function forwardingBackoff(failures) {
  return Math.min(15, 2 ** Math.max(0, Math.min(4, failures - 1))) * 60_000;
}
// Route installation-wide and removed-account logs once, without changing
// their stored attribution. The route supplies authentication, not ownership.
export function routeLogEntries(contexts, entries) {
  const keys = new Set(contexts.map(context => context.key));
  return entries.map(entry => keys.has(entry.account_key) ? entry
    : { ...entry, account_key: contexts[0]?.key, scope: "installation" });
}
export function selectLogBatch(contexts, entries, queuedIds, cursor = 0, max = 100, pending = {}, automatic = false) {
  for (let step = 0; step < contexts.length; step++) {
    const index = (cursor + step) % contexts.length;
    const context = contexts[index];
    const available = entries.filter(entry => entry.account_key === context.key && queuedIds.has(entry.id));
    const saved = pending[context.key];
    const byId = new Map(available.map(entry => [entry.id, entry]));
    const retained = Array.isArray(saved?.entry_ids) && typeof saved.batch_id === "string"
      && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(saved.batch_id)
      ? saved.entry_ids.slice(0, max).map(id => byId.get(id)).filter(Boolean) : [];
    // Entries evicted by normal retention remain lost; never add new entries to
    // an uncertain batch or change its id when only part of it is retained.
    const candidates = available.reverse().filter(entry => !automatic || entry.level !== "debug");
    if (automatic) candidates.sort((a, b) => priority(b) - priority(a));
    const logs = retained.length ? retained : candidates.slice(0, max);
    if (logs.length) return { context, logs, cursor: (index + 1) % contexts.length,
      ...(retained.length ? { batchId: saved.batch_id } : {}) };
  }
  return null;
}

function priority(entry) {
  if (entry.area === "live" && ["readiness_changed", "readiness_snapshot", "connected", "disconnected", "leader_changed"].includes(entry.event)) return 2;
  return entry.level === "warn" || entry.level === "error" ? 1 : 0;
}
