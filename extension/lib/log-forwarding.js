// Installation-local scheduling policy; diagnostics never own customer work.
export const automaticLogForwardingEnabled = (stored) => stored.forward_log !== false;
export function forwardingBackoff(failures) {
  return Math.min(15, 2 ** Math.max(0, Math.min(4, failures - 1))) * 60_000;
}
export function selectLogBatch(contexts, entries, queuedIds, cursor = 0, max = 100, pending = {}) {
  for (let step = 0; step < contexts.length; step++) {
    const index = (cursor + step) % contexts.length;
    const context = contexts[index];
    const available = entries.filter(entry => entry.account_key === context.key && entry.level !== "debug" && queuedIds.has(entry.id));
    const saved = pending[context.key];
    const byId = new Map(available.map(entry => [entry.id, entry]));
    const retained = Array.isArray(saved?.entry_ids) && typeof saved.batch_id === "string"
      && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(saved.batch_id)
      ? saved.entry_ids.slice(0, max).map(id => byId.get(id)).filter(Boolean) : [];
    // Entries evicted by normal retention remain lost; never add new entries to
    // an uncertain batch or change its id when only part of it is retained.
    const logs = retained.length ? retained : available.reverse().slice(0, max);
    if (logs.length) return { context, logs, cursor: (index + 1) % contexts.length,
      ...(retained.length ? { batchId: saved.batch_id } : {}) };
  }
  return null;
}
