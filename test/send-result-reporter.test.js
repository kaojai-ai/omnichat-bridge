import assert from "node:assert/strict";
import test from "node:test";
import { createSendResultReporter } from "../extension/lib/send-result-reporter.js";

function clock() {
  let now = 0;
  let id = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimer(callback, delay) { const key = ++id; timers.set(key, { callback, at: now + delay }); return key; },
    clearTimer(key) { timers.delete(key); },
    advance(ms) {
      const until = now + ms;
      while (true) {
        const next = [...timers].filter(([, value]) => value.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].callback();
      }
      now = until;
    },
    get size() { return timers.size; },
  };
}

test("final result retries identically until its matching ACK and never republishes a conflicting result", () => {
  const time = clock();
  const sent = [];
  const settled = [];
  const reporter = createSendResultReporter({ ...time, requestId: "command-1", deadlineAt: 30_000,
    send: value => sent.push(value), onSettled: value => settled.push(value) });
  assert.equal(reporter.publish({ ok: true, provider_message_id: "real-id" }), true);
  assert.equal(reporter.publish({ ok: false }), false);
  time.advance(750);
  assert.equal(sent.length, 3);
  assert.ok(sent.every(value => value.provider_message_id === "real-id"));
  assert.equal(reporter.acknowledge({ type: "send_result_ack", request_id: "other" }), false);
  assert.equal(reporter.acknowledge({ type: "send_result_ack", request_id: "command-1" }), true);
  time.advance(30_000);
  assert.equal(sent.length, 3);
  assert.deepEqual(settled, [true]);
  assert.equal(time.size, 0);
});

test("socket submission failures only retry the cached final result inside a fixed tracking window", () => {
  const time = clock();
  const settled = [];
  let submissions = 0;
  const reporter = createSendResultReporter({ ...time, requestId: "command-1", deadlineAt: 30_000,
    send() { submissions++; throw new Error("socket unavailable"); }, onSettled: value => settled.push(value) });
  reporter.publish({ ok: false, uncertain: true, error_code: "OMNICHAT_CONFIRMATION_FAILED" });
  time.advance(30_000);
  const attempts = submissions;
  assert.ok(attempts > 1);
  assert.deepEqual(settled, [false]);
  assert.equal(time.size, 0);
  time.advance(30_000);
  assert.equal(submissions, attempts);
});

test("a missing page result releases tracking by the same bounded deadline", () => {
  const time = clock();
  const settled = [];
  createSendResultReporter({ ...time, requestId: "command-1", deadlineAt: 30_000,
    send() { assert.fail("no final result was published"); }, onSettled: value => settled.push(value) });
  time.advance(30_000);
  assert.deepEqual(settled, [false]);
  assert.equal(time.size, 0);
});
