import { createLogEntry, logStorageBytes } from "./logs.js";

// Diagnostic admission is synchronous; persistence must never hold up message delivery.
// The byte limit covers serialized pending AND in-flight rows, not JS heap overhead.
export function createDiagnosticBuffer({
  persist,
  onError = () => {},
  now = Date.now,
  flushIntervalMs = 1_000,
  batchSize = 100,
  maxBytes = 256 * 1024,
  reserveRatio = 0.25,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (typeof persist !== "function") throw new TypeError("Diagnostic persistence is required.");
  if (!Number.isFinite(maxBytes) || maxBytes <= 0
    || !Number.isInteger(batchSize) || batchSize <= 0
    || !Number.isFinite(flushIntervalMs) || flushIntervalMs <= 0
    || !Number.isFinite(reserveRatio) || reserveRatio < 0 || reserveRatio > 1) {
    throw new TypeError("Invalid diagnostic buffer limits.");
  }
  const routineLimit = Math.floor(maxBytes * (1 - reserveRatio));
  let pending = [];
  let inFlightRows = [];
  let inFlight = null;
  let timer = null;
  let bytes = 0;
  let routineBytes = 0;
  const timing = { lastQueueWaitMs: 0, lastPersistMs: 0 };
  const counters = { accepted: 0, persisted: 0, evictedRoutine: 0, droppedRoutine: 0, droppedFailure: 0, persistenceFailures: 0 };

  function cancelTimer() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  function schedule() {
    if (timer !== null || inFlight || !pending.length) return;
    timer = setTimer(() => {
      timer = null;
      void flush().catch(reportError);
    }, flushIntervalMs);
  }

  function reportError(error) {
    // Error reporting is advisory and must not create an unhandled rejection.
    try { Promise.resolve(onError(error)).catch(() => {}); } catch {}
  }

  function release(row) {
    bytes -= row.bytes;
    if (!row.failure) routineBytes -= row.bytes;
  }

  function enqueue(value, { remote = true } = {}) {
    const entry = createLogEntry(value, now());
    const row = { entry, remote: remote === true };
    const size = logStorageBytes(row);
    const failure = entry.level === "warn" || entry.level === "error";
    const droppedKey = failure ? "droppedFailure" : "droppedRoutine";
    if (size > maxBytes || (!failure && size > routineLimit)) {
      counters[droppedKey] += 1;
      return false;
    }
    while (bytes + size > maxBytes || (!failure && routineBytes + size > routineLimit)) {
      const index = pending.findIndex((candidate) => !candidate.failure);
      if (index < 0) {
        counters[droppedKey] += 1;
        return false;
      }
      release(pending.splice(index, 1)[0]);
      counters.evictedRoutine += 1;
    }
    pending.push({ ...row, bytes: size, failure, queuedAt: performance.now() });
    bytes += size;
    if (!failure) routineBytes += size;
    counters.accepted += 1;
    if (pending.length >= batchSize && !inFlight) void flush().catch(reportError);
    else schedule();
    return true;
  }

  function flush() {
    if (inFlight) return inFlight;
    cancelTimer();
    if (!pending.length) return Promise.resolve();
    const batch = pending.splice(0, batchSize);
    inFlightRows = batch;
    // Defer the callback so admission never executes storage work synchronously.
    let startedAt;
    inFlight = Promise.resolve().then(() => {
      startedAt = performance.now();
      timing.lastQueueWaitMs = Math.max(0, startedAt - batch[0].queuedAt);
      return persist(batch.map(({ entry, remote }) => ({ entry, remote })));
    })
      .then(() => {
        for (const row of batch) release(row);
        counters.persisted += batch.length;
      }, (error) => {
        pending = [...batch, ...pending];
        counters.persistenceFailures += 1;
        throw error;
      }).finally(() => {
        timing.lastPersistMs = Math.max(0, performance.now() - startedAt);
        inFlight = null;
        inFlightRows = [];
        schedule();
      });
    return inFlight;
  }

  async function drain() {
    // Caller must serialize its subsequent export/upload/clear with its storage writes.
    while (inFlight || pending.length) await flush();
    cancelTimer();
  }

  async function discard() {
    cancelTimer();
    for (const row of pending) release(row);
    pending = [];
    try { if (inFlight) await inFlight; } catch { /* Discard failed batch too. */ }
    cancelTimer();
    for (const row of pending) release(row);
    pending = [];
  }

  function stats() {
    return { ...counters, ...timing, pending: pending.length, inFlight: inFlightRows.length,
      bytes, routineBytes, maxBytes, routineLimit };
  }

  return { enqueue, flush, drain, discard, stats };
}
