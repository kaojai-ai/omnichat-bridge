import test from "node:test";
import assert from "node:assert/strict";
import { createDiagnosticBuffer } from "../extension/lib/diagnostic-buffer.js";

function setup(options = {}) {
  const timers = new Map();
  let timerId = 0;
  const buffer = createDiagnosticBuffer({
    setTimer: (callback) => { timers.set(++timerId, callback); return timerId; },
    clearTimer: (id) => timers.delete(id),
    ...options,
  });
  return { buffer, timers };
}
const event = (level = "info") => ({ level, area: "delivery", event: "observed", message: "Diagnostic event" });

test("admission captures occurrence time and sanitizes before a slow single-flight flush", async () => {
  let clock = 1_000;
  let release;
  const batches = [];
  const { buffer } = setup({ batchSize: 2, now: () => clock, persist: async (rows) => {
    batches.push(rows);
    if (batches.length === 1) await new Promise((resolve) => { release = resolve; });
  } });
  assert.equal(buffer.enqueue({ ...event(), details: { password: "private", count: 1 } }), true);
  clock = 2_000;
  buffer.enqueue(event("warn"));
  assert.equal(batches.length, 0, "storage callback is deferred beyond admission");
  await Promise.resolve();
  assert.equal(batches.length, 1);
  buffer.enqueue(event());
  const first = buffer.flush();
  assert.equal(buffer.flush(), first);
  assert.equal(batches.length, 1);
  assert.equal(batches[0][0].entry.at, "1970-01-01T00:00:01.000Z");
  assert.equal(batches[0][0].entry.details.password, undefined);
  assert.deepEqual(Object.keys(batches[0][1]), ["entry"]);
  release();
  await buffer.drain();
  assert.equal(batches.length, 2);
  assert.equal(buffer.stats().bytes, 0);
  assert.equal(buffer.stats().persisted, 3);
});

test("burst memory includes in-flight rows and reserves room for failures", async () => {
  let release;
  const { buffer } = setup({ maxBytes: 2_000, batchSize: 2, persist: () => new Promise((resolve) => { release = resolve; }) });
  buffer.enqueue(event());
  buffer.enqueue(event());
  await Promise.resolve();
  for (let i = 0; i < 100; i += 1) buffer.enqueue(event());
  assert.ok(buffer.stats().routineBytes <= 1_500);
  assert.ok(buffer.stats().evictedRoutine > 0);
  assert.equal(buffer.enqueue(event("error")), true);
  for (let i = 0; i < 100; i += 1) buffer.enqueue(event("warn"));
  assert.ok(buffer.stats().bytes <= 2_000);
  assert.ok(buffer.stats().droppedFailure > 0);
  assert.equal(buffer.stats().inFlight, 2);
  // Release each batch without allowing overlapping storage operations.
  while (buffer.stats().pending || buffer.stats().inFlight) {
    const flush = buffer.flush();
    await Promise.resolve();
    release();
    await flush;
  }
  await buffer.drain();
  assert.equal(buffer.stats().bytes, 0);
});

test("failed persistence retains the bounded batch and drain rejects without retry spinning", async () => {
  let fails = true;
  let calls = 0;
  const seen = [];
  const { buffer, timers } = setup({ persist: async (rows) => {
    calls += 1;
    seen.push(rows.map((row) => row.entry.id));
    if (fails) throw new Error("storage unavailable");
  } });
  buffer.enqueue(event("error"));
  const bytes = buffer.stats().bytes;
  await assert.rejects(buffer.drain(), /storage unavailable/);
  assert.equal(calls, 1);
  assert.equal(buffer.stats().bytes, bytes);
  assert.equal(timers.size, 1, "failure schedules one bounded-delay retry");
  fails = false;
  await buffer.drain();
  assert.deepEqual(seen[0], seen[1]);
  assert.equal(buffer.stats().persisted, 1);
  assert.equal(timers.size, 0);
});

test("low traffic flushes on the interval and oversize records do not consume memory", async () => {
  const batches = [];
  const { buffer, timers } = setup({ maxBytes: 1_024, persist: async (rows) => batches.push(rows) });
  assert.equal(buffer.enqueue({ ...event(), account_key: "a".repeat(2_000) }), false);
  assert.equal(buffer.stats().bytes, 0);
  buffer.enqueue(event());
  const callback = [...timers.values()][0];
  timers.clear();
  callback();
  await buffer.drain();
  assert.equal(batches.length, 1);
  assert.equal(buffer.stats().droppedRoutine, 1);
});

test("discard waits for an in-flight failure then removes its retry and pending tail", async () => {
  let reject;
  const { buffer, timers } = setup({ persist: () => new Promise((_, no) => { reject = no; }) });
  buffer.enqueue(event());
  const flushing = buffer.flush();
  await Promise.resolve();
  buffer.enqueue(event("warn"));
  const erased = buffer.discard();
  reject(new Error("storage unavailable"));
  await assert.rejects(flushing);
  await erased;
  assert.equal(buffer.stats().pending, 0);
  assert.equal(buffer.stats().bytes, 0);
  assert.equal(timers.size, 0);
});
