import assert from "node:assert/strict";
import test from "node:test";

import {
  advanceConversationCursors,
  deliveryRetryDelay,
  hasScanBacklog,
  isAfterMessageCursor,
  migrateScanState,
} from "../extension/lib/sync-state.js";

test("cursor compares timestamp then message id", () => {
  const cursor = {
    event_timestamp: "2026-07-25T12:00:00.000Z",
    message_id: "10",
  };
  assert.equal(isAfterMessageCursor({
    event_timestamp: cursor.event_timestamp,
    id: "11",
  }, cursor), true);
  assert.equal(isAfterMessageCursor({
    event_timestamp: cursor.event_timestamp,
    id: "09",
  }, cursor), false);
});

test("advancing cursors keeps the newest message per conversation", () => {
  const conversations = advanceConversationCursors(null, [
    { conversation_id: "a", event_timestamp: "2026-07-25T12:00:00.000Z", id: "10" },
    { conversation_id: "a", event_timestamp: "2026-07-25T12:00:00.000Z", id: "11" },
    { conversation_id: "b", event_timestamp: "2026-07-25T11:00:00.000Z", id: "2" },
  ]);
  assert.equal(conversations.a.message_id, "11");
  assert.equal(conversations.b.message_id, "2");
});

test("migration includes legacy acknowledgement and pending messages", () => {
  const migrated = migrateScanState({
    conversations: {
      a: { event_timestamp: "2026-07-25T12:00:00.000Z", message_id: "10" },
    },
  }, [
    { conversation_id: "a", event_timestamp: "2026-07-25T12:01:00.000Z", id: "11" },
  ]);
  assert.equal(migrated.watermark, null);
  assert.equal(migrated.conversations.a.message_id, "11");
});

test("delivery retry backs off and caps at thirty minutes", () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 20].map(deliveryRetryDelay),
    [60_000, 120_000, 300_000, 900_000, 1_800_000, 1_800_000],
  );
});

test("realtime remains deferred until backlog recovery completes", () => {
  assert.equal(hasScanBacklog(null), true);
  assert.equal(hasScanBacklog({ watermark: null, in_progress: false }), true);
  assert.equal(hasScanBacklog({
    watermark: "2026-07-25T12:00:00.000Z",
    in_progress: true,
  }), true);
  assert.equal(hasScanBacklog({
    watermark: "2026-07-25T12:00:00.000Z",
    in_progress: false,
  }), false);
});


test("failed or cancelled scan keeps later realtime cursors deferred until successful recovery", () => {
  const state = { watermark: "2026-07-01T00:00:00Z", in_progress: false,
    started_at: "2026-08-01T00:00:00Z", completed_at: "2026-07-01T00:00:00Z" };
  assert.equal(hasScanBacklog({ ...state, failed_at: "2026-08-01T00:01:00Z" }), true);
  assert.equal(hasScanBacklog({ ...state, cancelled_at: "2026-08-01T00:01:00Z" }), true);
  assert.equal(hasScanBacklog({ ...state, completed_at: "2026-08-01T00:02:00Z" }), false);
});
