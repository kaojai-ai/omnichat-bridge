import { installProviderPolicy } from "./helpers/provider-policy.js";
import { createSessionEligibility } from "../extension/lib/session-eligibility.js";
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";
const source = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
const extract = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const contexts = ["A", "B", "C"].map(id => ({ key: `line_oa:${id}`, adapter: { id: "line_oa", sendCommands: ["send_text"] }, account: { provider: "line_oa", provider_account_id: id } }));

test("LINE shared configuration selects verified access, preserves failures and clears revoked eligibility", async () => {
  let status = { account_access_verified: true, accessible_account_ids: ["A", "B"], command_capabilities_by_account: { A: ["send_text"], B: ["send_text"] } };
  const live = { "line_oa:B": { sync_error: "failed" } };
  const scope = vm.createContext({
    sessionEligibility: createSessionEligibility({ setTimer: () => 1, clearTimer: () => {} }),
    providerChatTabs: async () => [{ id: 1 }], providerTabStatus: async () => status,
    updateLiveState: async (context, patch) => { live[context.key] = { ...live[context.key], ...patch }; },
  });
  installProviderPolicy(scope);
  vm.runInContext(extract("async function lineSessionContexts(", "async function activeLiveCommandContexts("), scope);
  assert.deepEqual(Array.from(await scope.lineSessionContexts(contexts), c => c.key), ["line_oa:A", "line_oa:B"]);
  assert.equal(live["line_oa:B"].sync_error, "failed");
  assert.equal(live["line_oa:B"].active_in_profile, true);
  assert.equal(live["line_oa:C"].active_in_profile, false);
  status = { account_access_verified: true, accessible_account_ids: ["A"], command_capabilities_by_account: { A: ["send_text"] } };
  assert.deepEqual(Array.from(await scope.lineSessionContexts(contexts), c => c.key), ["line_oa:A"]);
  assert.equal(live["line_oa:B"].provider_session_reason_code, "account_mismatch");
  status = { account_access_verified: false, accessible_account_ids: ["A"], command_capabilities_by_account: { A: ["send_text"] } };
  assert.equal((await scope.lineSessionContexts(contexts)).length, 0);
  assert.equal(live["line_oa:A"].provider_session_reason_code, "provider_account_unverified");
});

test("failed fresh LINE access check cannot reuse stale tab access", async () => {
  const scope = vm.createContext({
    sessionEligibility: createSessionEligibility({ setTimer: () => 1, clearTimer: () => {} }),
    providerChatTabs: async () => [{ id: 1 }], ensureProviderBridge: async () => {},
    sendProviderMessage: async () => ({ ok: false }),
    providerTabStatus: async () => assert.fail("must not read stale access"),
    updateLiveState: async () => {},
  });
  installProviderPolicy(scope);
  vm.runInContext(extract("async function lineSessionContexts(", "async function activeLiveCommandContexts("), scope);
  assert.equal((await scope.lineSessionContexts(contexts, { refresh: true })).length, 0);
});

test("retry B while A syncs never restarts A and retains B failure as an account result", async () => {
  const calls = [];
  const recoveries = new Map();
  const scope = vm.createContext({
    sessionEligibility: createSessionEligibility({ setTimer: () => 1, clearTimer: () => {} }),
    AbortController, STORAGE: {}, readStorage: async () => ({}), hasLocalConsent: () => true,
    configuredAccountContexts: () => contexts, openSessionSyncContexts: async c => c.filter(item => item.account.provider_account_id !== "C"),
    activeSyncControl: { providerAccountId: "A", adapter: { id: "line_oa", sendCommands: ["send_text"] } },
    providerAutomaticRecoveries: recoveries,
    queueLiveStateWrite: async fn => { assert.equal(recoveries.has("line_oa:B"), true); return fn(); }, writeStorage: async () => {},
    runAccountSync: async (_trigger, control, context) => {
      assert.equal(recoveries.get(context.key), control);
      calls.push(context.key); return { error: "B failed" };
    },
    ensureLiveConnection: async () => {}, recordUnexpected: async () => {},
  });
  installProviderPolicy(scope);
  vm.runInContext(extract("async function retryProviderAccount(", "function restartSync("), scope);
  assert.equal((await scope.retryProviderAccount({ provider: "line_oa", provider_account_id: "B" })).error, "B failed");
  assert.deepEqual(calls, ["line_oa:B"]);
  assert.equal(recoveries.size, 0);
  await assert.rejects(scope.retryProviderAccount({ provider: "line_oa", provider_account_id: "C" }), /not available/);
});

function shopeeRetryHarness(currentId) {
  const shopee = ["A", "B"].map(id => ({ key: `shopee:${id}`, adapter: { id: "shopee", sendCommands: ["send_text"] },
    account: { provider: "shopee", provider_account_id: id } }));
  const calls = [];
  const verified = [];
  const recoveries = new Map();
  const scope = vm.createContext({
    sessionEligibility: createSessionEligibility({ setTimer: () => 1, clearTimer: () => {} }),
    AbortController, STORAGE: {}, readStorage: async () => ({}), hasLocalConsent: () => true,
    configuredAccountContexts: () => [...contexts, ...shopee],
    lineSessionContexts: async selected => { verified.push(selected.map(item => item.key)); return selected; },
    shopeeAdapter: { id: "shopee" },
    findReadyProviderChatTab: async () => ({ id: 7 }), findProviderChatTab: async () => ({ id: 7 }),
    detectOpenProviderAccount: async () => ({ ok: true }),
    providerTabStatus: async () => ({ current_provider_account_id: currentId }),
    throwIfSyncCancelled: () => {}, updateScopedState: async () => {}, recordLog: async () => {},
    activeSyncControl: { providerAccountId: "A", adapter: { id: "line_oa", sendCommands: ["send_text"] } },
    providerAutomaticRecoveries: recoveries,
    queueLiveStateWrite: async fn => fn(), writeStorage: async () => {},
    runAccountSync: async (_trigger, control, context) => {
      assert.equal(recoveries.get(context.key), control);
      assert.equal(control.preferredTabId, 7);
      assert.equal(scope.sessionEligibility.isCurrent(context.key, control.sessionGeneration), true);
      calls.push(context.key); return { recovered: 1 };
    },
    ensureLiveConnection: async () => {}, recordUnexpected: async () => {},
  });
  installProviderPolicy(scope);
  vm.runInContext(extract("async function openSessionSyncContexts(", "async function runUnifiedSync("), scope);
  installProviderPolicy(scope);
  vm.runInContext(extract("async function retryProviderAccount(", "function restartSync("), scope);
  return { scope, calls, verified, recoveries };
}

test("Shopee row retry freshly verifies only that shop and does not interrupt an active LINE account", async () => {
  const { scope, calls, verified, recoveries } = shopeeRetryHarness("A");
  assert.equal((await scope.retryProviderAccount({ provider: "shopee", provider_account_id: "A" })).recovered, 1);
  assert.deepEqual(calls, ["shopee:A"]);
  assert.deepEqual(Array.from(verified[0]), ["shopee:A"]);
  assert.equal(recoveries.size, 0);
  assert.equal(scope.activeSyncControl.adapter.id, "line_oa");
});

test("Shopee row retry rejects a different signed-in shop instead of silently recovering it", async () => {
  const { scope, calls, verified, recoveries } = shopeeRetryHarness("B");
  await assert.rejects(scope.retryProviderAccount({ provider: "shopee", provider_account_id: "A" }), /not available/);
  assert.deepEqual(calls, []);
  assert.deepEqual(Array.from(verified[0]), ["shopee:A"]);
  assert.equal(recoveries.size, 0);
});

test("per-account retry preserves an existing recovery and rejects unconfigured identities", async () => {
  const { scope, calls, verified, recoveries } = shopeeRetryHarness("A");
  const existing = { controller: new AbortController() };
  recoveries.set("shopee:A", existing);
  assert.equal((await scope.retryProviderAccount({ provider: "shopee", provider_account_id: "A" })).skipped, "already_syncing");
  assert.equal(recoveries.get("shopee:A"), existing);
  assert.equal(existing.controller.signal.aborted, false);
  assert.deepEqual(verified, []);
  assert.deepEqual(calls, []);
  await assert.rejects(scope.retryProviderAccount({ provider: "shopee", provider_account_id: "unconfigured" }), /not configured/);
});
