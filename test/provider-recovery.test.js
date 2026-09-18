import assert from "node:assert/strict";
import test from "node:test";

import {
  PROVIDER_RECOVERY_RETRY_BASE_MS,
  PROVIDER_RECOVERY_RETRY_MAX_MS,
  PROVIDER_RECOVERY_STATES,
  normalizeProviderRecoveryTabs,
  providerRecoveryRecord,
  recoveryRetryDelay,
  recoveryRetryDue,
  updateProviderRecoveryRecord,
} from "../extension/lib/provider-recovery.js";

test("normalizes persisted provider recovery records without accepting invalid tab IDs", () => {
  assert.deepEqual(
    normalizeProviderRecoveryTabs({
      line_oa: {
        state: "opening",
        tab_id: 42,
        opened_at: 100,
        reason: "  waiting  ",
      },
      shopee: {
        state: "unknown",
        tab_id: -1,
        opened_at: "not-a-time",
        reason: "x".repeat(300),
      },
      invalid: null,
    }),
    {
      version: 1,
      providers: {
        line_oa: {
          state: "opening",
          tab_id: 42,
          opened_by_extension: false,
          opened_at: 100,
          failure_count: 0,
          last_failure_at: null,
          next_retry_at: null,
          last_reload_at: null,
          reason: "waiting",
        },
        shopee: {
          state: "needs_attention",
          tab_id: null,
          opened_by_extension: false,
          opened_at: null,
          failure_count: 0,
          last_failure_at: null,
          next_retry_at: null,
          last_reload_at: null,
          reason: "x".repeat(240),
        },
      },
    },
  );
});

test("updates one provider without discarding another provider's recovery tab", () => {
  const next = updateProviderRecoveryRecord({
    line_oa: { state: "ready", tab_id: 7, opened_at: 100, reason: null },
  }, "shopee", {
    state: PROVIDER_RECOVERY_STATES.opening,
    tab_id: 8,
    opened_at: 200,
  });
  assert.equal(providerRecoveryRecord(next, "line_oa").tab_id, 7);
  assert.deepEqual(providerRecoveryRecord(next, "shopee"), {
    state: "opening",
    tab_id: 8,
    opened_by_extension: false,
    opened_at: 200,
    failure_count: 0,
    last_failure_at: null,
    next_retry_at: null,
    last_reload_at: null,
    reason: null,
  });
});

test("normalizes legacy records and keeps retry state bounded", () => {
  const record = {
    state: "needs_attention",
    tab_id: 12,
    failure_count: 4,
    next_retry_at: 2_000,
    reason: null,
  };
  assert.equal(recoveryRetryDue(record, 1_999), false);
  assert.equal(recoveryRetryDue(record, 2_000), true);
  assert.equal(recoveryRetryDelay(2), PROVIDER_RECOVERY_RETRY_BASE_MS);
  assert.equal(recoveryRetryDelay(100), PROVIDER_RECOVERY_RETRY_MAX_MS);
});
