// Installation-local scheduling policy; diagnostics never own customer work.
export const automaticLogForwardingEnabled = (stored) => stored.forward_log !== false;
export function forwardingBackoff(failures) {
  return Math.min(15, 2 ** Math.max(0, Math.min(4, failures - 1))) * 60_000;
}
export function selectLogBatch(contexts, entries, queuedIds, cursor = 0, max = 100) {
  for (let step = 0; step < contexts.length; step++) {
    const index = (cursor + step) % contexts.length;
    const context = contexts[index];
    const logs = entries.filter(entry => entry.account_key === context.key && entry.level !== "debug" && queuedIds.has(entry.id)).reverse().slice(0, max);
    if (logs.length) return { context, logs, cursor: (index + 1) % contexts.length };
  }
  return null;
}
