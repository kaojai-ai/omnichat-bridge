import test from "node:test";
import assert from "node:assert/strict";
import { createSessionEligibility } from "../extension/lib/session-eligibility.js";

function fixture() {
  let clock = 0;
  let id = 0;
  const timers = new Map();
  const calls = [];
  const session = createSessionEligibility({ now: () => clock,
    setTimer: (fn, delay) => { timers.set(++id, { fn, at: clock + delay }); return id; },
    clearTimer: (key) => timers.delete(key),
    onRecheck: (key, state) => calls.push({ key, ...state }),
  });
  return { session, timers, calls, advance(time) {
    clock = time;
    for (const [key, timer] of [...timers]) {
      if (timer.at <= clock) { timers.delete(key); timer.fn(); }
    }
  } };
}

test("unknown probes never grant access or restart the bounded verification window", () => {
  const { session, calls, advance } = fixture();
  const initial = session.observe("account", { hasTab: true });
  assert.equal(initial.eligible, false);
  assert.equal(initial.reason_code, "checking_session");
  advance(5_000);
  assert.equal(calls.length, 1);
  assert.equal(session.observe("account", { hasTab: true }).generation, initial.generation);
  advance(15_000);
  assert.equal(calls.length, 2);
  advance(30_000);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].reason_code, "checking_session");
  advance(60_000);
  assert.equal(calls[3].reason_code, "needs_attention");
  assert.equal(session.observe("account", { hasTab: true }).reason_code, "needs_attention");
  assert.equal(session.isCurrent("account", initial.generation), false);
});

test("loss, identity change and explicit mismatch invalidate previously queued work", () => {
  const { session } = fixture();
  const verified = session.observe("account", { hasTab: true, verified: true, identity: "session-a" });
  assert.equal(verified.reason_code, "ready");
  assert.equal(session.isCurrent("account", verified.generation), true);
  const unknown = session.observe("account", { hasTab: true, identity: "session-a" });
  assert.equal(unknown.generation, verified.generation);
  assert.equal(unknown.reason_code, "provider_check_grace");
  assert.equal(session.isCurrent("account", verified.generation), true);
  assert.equal(session.observe("account", { hasTab: true, identity: "session-a" }).generation, unknown.generation);
  const restored = session.observe("account", { hasTab: true, verified: true, identity: "session-a" });
  const switched = session.observe("account", { hasTab: true, verified: true, identity: "session-b" });
  assert.equal(session.isCurrent("account", restored.generation), false);
  assert.equal(session.isCurrent("account", switched.generation), true);
  const mismatch = session.observe("account", { hasTab: true, verified: true, explicitMismatch: true, identity: "session-b" });
  assert.equal(mismatch.reason_code, "wrong_account");
  assert.equal(mismatch.eligible, false);
  assert.equal(session.isCurrent("account", switched.generation), false);
  const missing = session.observe("account", { hasTab: false, verified: true });
  assert.equal(missing.reason_code, "waiting_for_tab");
  assert.equal(missing.eligible, false);
});

test("recovery and reset cancel stale callbacks without reusing generations", () => {
  const { session, timers, calls, advance } = fixture();
  session.observe("first", { hasTab: true });
  session.observe("second", { hasTab: true });
  const ready = session.observe("first", { hasTab: true, verified: true });
  assert.equal(timers.size, 4);
  session.reset("second");
  assert.equal(timers.size, 0);
  advance(40_000);
  assert.deepEqual(calls, []);
  session.reset();
  assert.equal(session.generation("first"), null);
  const replacement = session.observe("first", { hasTab: true, verified: true });
  assert.notEqual(replacement.generation, ready.generation);
  assert.equal(session.isCurrent("first", ready.generation), false);
});
