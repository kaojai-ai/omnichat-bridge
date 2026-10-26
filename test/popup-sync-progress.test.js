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
