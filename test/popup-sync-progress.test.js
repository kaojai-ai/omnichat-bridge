import assert from "node:assert/strict";
import test from "node:test";

import {
  SYNC_PHASE_LABELS,
  createCoalescedRefresh,
  syncProgressPresentation,
} from "../extension/lib/popup-sync-progress.js";

test("shows phase copy while discovering before conversation totals exist", () => {
  assert.deepEqual(
    syncProgressPresentation({ state: "discovering", phase: "preparing" }),
    {
      active: true,
      showBar: true,
      value: null,
      text: SYNC_PHASE_LABELS.preparing,
    },
  );
});

test("shows a progress bar once conversation totals are known", () => {
  assert.deepEqual(
    syncProgressPresentation({
      state: "syncing",
      phase: "fetching_messages",
      completed_conversations: 3,
      total_conversations: 10,
    }),
    {
      active: true,
      showBar: true,
      value: 30,
      text: "Recovering conversation messages… 3 of 10 conversations · 30%",
    },
  );
});

test("falls back to counted copy when totals are still unknown", () => {
  assert.deepEqual(
    syncProgressPresentation({
      state: "syncing",
      phase: "conversation_complete",
      completed_conversations: 4,
      total_conversations: 0,
    }),
    {
      active: true,
      showBar: true,
      value: null,
      text: "Recovering conversation messages… 4 conversations checked",
    },
  );
});

test("ignores idle status", () => {
  assert.equal(syncProgressPresentation({ state: "ready" }), null);
  assert.equal(syncProgressPresentation(null), null);
});


test("reports actual optional work without inventing a total or ETA", () => {
  const state = {
    state: "syncing", phase: "fetching_messages", pages_fetched: 12,
    messages_captured: 42, pending: 7, last_progress_at: "2026-10-26T08:30:00Z",
  };
  const view = syncProgressPresentation(state);
  assert.equal(view.value, null);
  assert.match(view.text, /12 pages fetched · 42 messages captured · 7 pending · Last progress /);
  assert.doesNotMatch(view.text, /%|ETA/);
  const invalid = syncProgressPresentation({ ...state, pages_fetched: NaN, messages_captured: -1, last_progress_at: "invalid" });
  assert.doesNotMatch(invalid.text, /NaN|pages fetched|messages captured|Last progress/);
  assert.equal(syncProgressPresentation({ ...state, completed_conversations: 12, total_conversations: 10 }).value, 100);
});

test("coalesces bursts, limits starts to once per second, and retains changes during a read", async () => {
  let clock = 0;
  let starts = 0;
  let finish;
  const timers = [];
  const request = createCoalescedRefresh(() => {
    starts += 1;
    return new Promise(resolve => { finish = resolve; });
  }, { now: () => clock, schedule: (run, delay) => { timers.push({ run, delay }); return timers.length; } });
  request(); request(); request();
  assert.equal(timers.length, 1);
  const first = timers.shift();
  assert.equal(first.delay, 0);
  const firstRun = first.run();
  clock = 100;
  request(); request();
  assert.equal(timers.length, 0, "an in-flight refresh cannot overlap");
  finish(); await firstRun;
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 1000);
  clock = 1100;
  const secondRun = timers.shift().run();
  assert.equal(starts, 2);
  finish(); await secondRun;
  assert.equal(timers.length, 0);
});

test("compact progress omits zero metadata and never invents a percent for unknown work", () => {
  for (const total of [undefined, null, 0]) {
    const state = { state: "syncing", phase: "fetching_messages", total_conversations: total,
      completed_conversations: 4, pages_fetched: 0, messages_captured: 0, pending: 0 };
    const compact = syncProgressPresentation(state, { compact: true });
    assert.equal(compact.value, null);
    assert.equal(compact.showBar, true);
    assert.doesNotMatch(compact.text, /\d|%|pages|pending|Last progress|ETA/);
    assert.equal(compact.detail, syncProgressPresentation(state).text, "full diagnostics remain available outside the compact label");
    const captured = syncProgressPresentation({ ...state, messages_captured: 12 }, { compact: true });
    assert.match(captured.text, /12 captured/);
    assert.doesNotMatch(captured.text, /%|ETA/);
  }
});

test("compact percentages require a measured total in a counted phase", () => {
  const counted = syncProgressPresentation({ state: "syncing", phase: "fetching_messages",
    completed_conversations: 2, total_conversations: 8, pages_fetched: 3, messages_captured: 12,
  }, { compact: true });
  assert.equal(counted.value, 25);
  assert.match(counted.text, /25%/);
  assert.match(counted.detail, /2 of 8 conversations/);
  assert.match(counted.detail, /3 pages fetched · 12 messages captured/);
  const preflight = syncProgressPresentation({ state: "discovering", phase: "checking_session",
    completed_conversations: 2, total_conversations: 8,
  }, { compact: true });
  assert.equal(preflight.value, null);
  assert.doesNotMatch(preflight.text, /%/);
});


test("verified queued accounts wait without claiming an active access check or percentage", () => {
  const state = { state: "discovering", phase: "queued", total_conversations: 10, completed_conversations: 5 };
  const view = syncProgressPresentation(state, { compact: true });
  assert.equal(view.text, "Waiting…");
  assert.equal(view.value, null);
  assert.equal(view.showBar, false);
  assert.doesNotMatch(view.detail, /Checking|%/);
});
