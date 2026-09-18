import assert from "node:assert/strict";
import test from "node:test";

import {
  PROVIDER_RECOVERY_OPENING_TIMEOUT_MS,
  PROVIDER_RECOVERY_STATES,
  normalizeProviderRecoveryTabs,
  providerRecoveryRecord,
  recoveryOpeningExpired,
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
      line_oa: { state: "opening", tab_id: 42, opened_at: 100, reason: "waiting" },
      shopee: { state: "needs_attention", tab_id: null, opened_at: null, reason: "x".repeat(240) },
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
    opened_at: 200,
    reason: null,
  });
});

test("does not allow an unfinished opening record to create forever", () => {
  const record = {
    state: "opening",
    tab_id: null,
    opened_at: 1_000,
    reason: null,
  };
  assert.equal(recoveryOpeningExpired(record, 1_000 + PROVIDER_RECOVERY_OPENING_TIMEOUT_MS - 1), false);
  assert.equal(recoveryOpeningExpired(record, 1_000 + PROVIDER_RECOVERY_OPENING_TIMEOUT_MS), true);
  assert.equal(recoveryOpeningExpired({ ...record, opened_at: null }), true);
});
