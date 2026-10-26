import { createSessionEligibility } from "../extension/lib/session-eligibility.js";
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";
const source = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
const extract = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const contexts = ["A", "B", "C"].map(id => ({ key: `line_oa:${id}`, adapter: { id: "line_oa" }, account: { provider: "line_oa", provider_account_id: id } }));

test("LINE shared configuration selects verified access, preserves failures and clears revoked eligibility", async () => {
  let status = { account_access_verified: true, accessible_account_ids: ["A", "B"] };
  const live = { "line_oa:B": { sync_error: "failed" } };
  const scope = vm.createContext({
    sessionEligibility: createSessionEligibility({ setTimer: () => 1, clearTimer: () => {} }),
    providerChatTabs: async () => [{ id: 1 }], providerTabStatus: async () => status,
    updateLiveState: async (context, patch) => { live[context.key] = { ...live[context.key], ...patch }; },
  });
  vm.runInContext(extract("async function lineSessionContexts(", "let activeShopeeStatusPromise"), scope);
  assert.deepEqual(Array.from(await scope.lineSessionContexts(contexts), c => c.key), ["line_oa:A", "line_oa:B"]);
  assert.equal(live["line_oa:B"].sync_error, "failed");
  assert.equal(live["line_oa:B"].active_in_profile, true);
  assert.equal(live["line_oa:C"].active_in_profile, false);
  status = { account_access_verified: true, accessible_account_ids: ["A"] };
  assert.deepEqual(Array.from(await scope.lineSessionContexts(contexts), c => c.key), ["line_oa:A"]);
  assert.equal(live["line_oa:B"].provider_session_reason_code, "wrong_account");
  status = { account_access_verified: false, accessible_account_ids: ["A"] };
  assert.equal((await scope.lineSessionContexts(contexts)).length, 0);
  assert.equal(live["line_oa:A"].provider_session_reason_code, "checking_session");
});

test("failed fresh LINE access check cannot reuse stale tab access", async () => {
  const scope = vm.createContext({
    sessionEligibility: createSessionEligibility({ setTimer: () => 1, clearTimer: () => {} }),
    providerChatTabs: async () => [{ id: 1 }], ensureProviderBridge: async () => {},
    sendProviderMessage: async () => ({ ok: false }),
    providerTabStatus: async () => assert.fail("must not read stale access"),
    updateLiveState: async () => {},
  });
  vm.runInContext(extract("async function lineSessionContexts(", "let activeShopeeStatusPromise"), scope);
  assert.equal((await scope.lineSessionContexts(contexts, { refresh: true })).length, 0);
});

test("retry B while A syncs never restarts A and retains B failure as an account result", async () => {
  const calls = [];
  const recoveries = new Map();
  const scope = vm.createContext({
    sessionEligibility: createSessionEligibility({ setTimer: () => 1, clearTimer: () => {} }),
    AbortController, STORAGE: {}, readStorage: async () => ({}), hasLocalConsent: () => true,
    configuredAccountContexts: () => contexts, lineSessionContexts: async c => c.slice(0, 2),
    activeSyncControl: { providerAccountId: "A", adapter: { id: "line_oa" } },
    providerAutomaticRecoveries: recoveries,
    queueLiveStateWrite: async fn => { assert.equal(recoveries.has("line_oa:B"), true); return fn(); }, writeStorage: async () => {},
    runAccountSync: async (_trigger, control, context) => {
      assert.equal(recoveries.get(context.key), control);
      calls.push(context.key); return { error: "B failed" };
    },
    ensureLiveConnection: async () => {}, recordUnexpected: async () => {},
  });
  vm.runInContext(extract("async function retryLineAccount(", "function restartSync("), scope);
  assert.equal((await scope.retryLineAccount({ provider: "line_oa", provider_account_id: "B" })).error, "B failed");
  assert.deepEqual(calls, ["line_oa:B"]);
  assert.equal(recoveries.size, 0);
  await assert.rejects(scope.retryLineAccount({ provider: "line_oa", provider_account_id: "C" }), /not available/);
});
