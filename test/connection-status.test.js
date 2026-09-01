import assert from "node:assert/strict";
import test from "node:test";

import { buildConnectionHealth } from "../extension/lib/connection-status.js";

const healthy = {
  tabCount: 1,
  contentReady: true,
  accountDetected: true,
  accountMatches: true,
  realtimeConnected: true,
  lastRealtimeConnectedAt: "2026-07-31T00:00:00.000Z",
  pendingMessages: 0,
  status: {
    last_capture_at: "2026-07-31T00:00:01.000Z",
    last_delivery_at: "2026-07-31T00:00:02.000Z",
    last_sync_at: "2026-07-31T00:00:03.000Z",
  },
};

test("reports online only when all required Shopee conditions pass", () => {
  const result = buildConnectionHealth(healthy);
  assert.equal(result.reason_code, "healthy");
  assert.deepEqual(result.checks.map((check) => check.status), ["pass", "pass", "pass", "pass"]);
});

test("reports a connected installation as inactive when Seller Chat is closed", () => {
  const result = buildConnectionHealth({
    ...healthy,
    tabCount: 0,
    contentReady: false,
    realtimeConnected: false,
  });
  assert.equal(result.reason_code, "seller_chat_tab_closed");
});

test("prioritizes delivery failure and keeps its timestamp", () => {
  const result = buildConnectionHealth({
    ...healthy,
    pendingMessages: 3,
    status: {
      ...healthy.status,
      delivery_error: "Target server returned 500",
      delivery_error_at: "2026-07-31T00:00:04.000Z",
    },
  });
  assert.equal(result.reason_code, "message_delivery_failed");
  assert.deepEqual(result.last_error, {
    code: "message_delivery_failed",
    occurred_at: "2026-07-31T00:00:04.000Z",
  });
  assert.equal(result.metrics.pending_messages, 3);
});

test("reports a mismatched Shopee account without provider-specific server logic", () => {
  const result = buildConnectionHealth({ ...healthy, accountMatches: false });
  assert.equal(result.reason_code, "seller_account_mismatch");
});

test("names realtime failures after the active provider", () => {
  const result = buildConnectionHealth({
    ...healthy,
    provider: "line_oa",
    realtimeConnected: false,
  });
  assert.equal(result.reason_code, "line_oa_realtime_disconnected");
  assert.equal(result.checks[3].reason_code, "line_oa_realtime_disconnected");
});
