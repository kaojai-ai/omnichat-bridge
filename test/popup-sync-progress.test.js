import assert from "node:assert/strict";
import test from "node:test";

import {
  SYNC_PHASE_LABELS,
  syncProgressPresentation,
} from "../extension/lib/popup-sync-progress.js";

test("shows phase copy while discovering before conversation totals exist", () => {
  assert.deepEqual(
    syncProgressPresentation({ state: "discovering", phase: "preparing" }),
    {
      active: true,
      showBar: false,
      value: 0,
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
      text: "Checking conversation 3 of 10 · 30%",
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
      showBar: false,
      value: 0,
      text: "Checking provider conversations… 4 checked",
    },
  );
});

test("ignores idle status", () => {
  assert.equal(syncProgressPresentation({ state: "ready" }), null);
  assert.equal(syncProgressPresentation(null), null);
});
