import { installProviderPolicy } from "./helpers/provider-policy.js";
import { webcrypto as crypto } from "node:crypto";
import { createSessionEligibility } from "../extension/lib/session-eligibility.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
const source = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
function runWithPolicy(code, globals) {
  const scope = vm.createContext({ preemptAutomaticLogUpload: () => {}, ...globals });
  installProviderPolicy(scope);
  return vm.runInContext(code, scope);
}
const start = source.indexOf("async function openSessionSyncContexts(");
const end = source.indexOf("\nasync function syncAccountsForTab", start);
const context = (provider, id) => ({ key: id, adapter: { id: provider, sendCommands: ["send_text"] }, account: { provider, provider_account_id: id } });
for (const currentId of ["A", "B", null]) {
  test(`sync follows current Shopee session ${currentId} and retains all LINE accounts`, async () => {
    const contexts = [context("shopee", "A"), context("shopee", "B"), context("line_oa", "L1"), context("line_oa", "L2")];
    const skipped = [];
    const select = runWithPolicy(`(${source.slice(start, end)})`, { preemptAutomaticLogUpload: () => {},
      throwIfSyncCancelled: () => {},
      lineSessionContexts: async (contexts) => contexts,
      accountSyncs: new Map(),
      sessionEligibility: createSessionEligibility({ setTimer: () => 1, clearTimer: () => {} }),
      shopeeAdapter: { id: "shopee" }, crypto, STORAGE: {},
      findReadyProviderChatTab: async () => ({ id: 42 }), findProviderChatTab: async () => null,
      detectOpenProviderAccount: async () => ({ ok: Boolean(currentId) }),
      providerTabStatus: async () => ({ current_provider_account_id: currentId, provider_account_ids: ["A", "B"] }),
      readStorage: async () => ({}), configuredAccountContexts: () => contexts,
      recordLog: async (_level, _area, _event, _message, data) => skipped.push(data.provider_account_id),
      updateScopedState: async (_storage, _key, patch) => { if (typeof patch === "function") patch({}); },
    });
    const selected = await select(contexts, { controller: { signal: {} } });
    assert.deepEqual(Array.from(selected, (entry) => entry.key), [...(currentId ? [currentId] : []), "L1", "L2"]);
    assert.deepEqual(skipped, ["A", "B"].filter((id) => id !== currentId));
  });
}
test("LINE-only sync does not inspect a Shopee session", async () => {
  const select = runWithPolicy(`(${source.slice(start, end)})`, { preemptAutomaticLogUpload: () => {},
      throwIfSyncCancelled: () => {},
      lineSessionContexts: async (contexts) => contexts,
      accountSyncs: new Map(),
      sessionEligibility: createSessionEligibility({ setTimer: () => 1, clearTimer: () => {} }),});
  const contexts = [context("line_oa", "L1"), context("line_oa", "L2")];
  assert.equal(await select(contexts, { controller: { signal: {} } }), contexts);
});

test("a failed fresh lookup cannot reuse the previous shop ID", async () => {
  const contexts = [context("shopee", "A"), context("line_oa", "L1")];
  const select = runWithPolicy(`(${source.slice(start, end)})`, { preemptAutomaticLogUpload: () => {},
      throwIfSyncCancelled: () => {},
      lineSessionContexts: async (contexts) => contexts,
      accountSyncs: new Map(),
      sessionEligibility: createSessionEligibility({ setTimer: () => 1, clearTimer: () => {} }),
    shopeeAdapter: {}, crypto, STORAGE: {}, findReadyProviderChatTab: async () => ({ id: 42 }),
    detectOpenProviderAccount: async () => ({ ok: false }),
    providerTabStatus: async () => assert.fail("stale status must not be read"),
    readStorage: async () => ({}), configuredAccountContexts: () => contexts,
    recordLog: async () => {}, updateScopedState: async (_storage, _key, patch) => { if (typeof patch === "function") patch({}); },
  });
  assert.deepEqual(Array.from(await select(contexts, { controller: { signal: {} } }), (entry) => entry.key), ["L1"]);
});

test("Shopee tab recovery continues when the owner is between logins", async () => {
  const start = source.indexOf("async function reconnectProviderTab(tab)");
  const end = source.indexOf("\nfunction invalidateProviderSession", start);
  const calls = [];
  const reconnect = runWithPolicy(`(${source.slice(start, end)})`, { preemptAutomaticLogUpload: () => {},
    providerAdapters: { list: () => [{ id: "shopee", matchesUrl: () => true }] },
    crypto, STORAGE: {}, readStorage: async () => ({}), hasLocalConsent: () => true,
    ensureProviderBridge: async () => calls.push("bridge"),
    detectOpenProviderAccount: async () => ({ ok: false, error: "Logged out" }),
    autoStartSellerCentreTab: async () => calls.push("recovery"),
    ensureLiveConnection: async () => calls.push("connection"),
  });
  await reconnect({ id: 42 });
  assert.deepEqual(calls, ["bridge", "recovery", "connection"]);
});

for (const failureAt of ["tab_lookup", "detection", "status"]) {
  test(`LINE candidates remain available when Shopee ${failureAt} throws`, async () => {
    const contexts = [context("shopee", "A"), context("line_oa", "L1"), context("line_oa", "L2")];
    const synced = [];
    const errors = [];
    const failure = new Error("Receiving end does not exist");
    const lookup = async (stage, result) => {
      if (stage === failureAt) throw failure;
      return result;
    };

    const run = runWithPolicy(`(${source.slice(start, end)})`, { preemptAutomaticLogUpload: () => {},
      shopeeAdapter: {}, crypto, STORAGE: {},
      findReadyProviderChatTab: () => lookup("tab_lookup", { id: 42 }),
      detectOpenProviderAccount: () => lookup("detection", { ok: true }),
      providerTabStatus: () => lookup("status", { current_provider_account_id: "A" }),
      readStorage: async () => ({}), configuredAccountContexts: () => contexts,
      recordUnexpected: async (area, error, details) => errors.push({ area, error, details }),
      recordLog: async () => {}, updateScopedState: async (_storage, _key, patch) => { if (typeof patch === "function") patch({}); },
      hasLocalConsent: () => true, throwIfSyncCancelled: () => {},
      lineSessionContexts: async (contexts) => contexts,
      accountSyncs: new Map(),
      sessionEligibility: createSessionEligibility({ setTimer: () => 1, clearTimer: () => {} }),
      runAccountSync: async (_trigger, _control, account) => {
        synced.push(account.key);
        return { sent: 1 };
      },
    });
    const result = await run(contexts, { controller: new AbortController() });
    assert.deepEqual(Array.from(result, item => item.key), ["L1", "L2"]);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].error, failure);
    assert.equal(errors[0].details.provider, "shopee");
  });
}

for (const outcome of ["superseded", "failure", "recorded_failure"]) {
  const superseded = outcome === "superseded";
  const recorded = outcome === "recorded_failure";
  test(`sync outcome preserves failure state and logs ${superseded ? "typed supersession as INFO" : "a genuine failure according to its recorded boundary"}`, async () => {
    const control = { controller: new AbortController() };
    const logs = [];
    const states = [];
    const run = runWithPolicy(source.slice(source.indexOf("async function runAccountSync("), source.indexOf("\nasync function openSessionSyncContexts")) + "\nrunAccountSync", {
      isCurrentSyncControl: candidate => candidate === control,
      crypto, STORAGE: {}, RESUME_SYNC_COOLDOWN_MS: 0,
      exclusive: async () => ({ context: context("shopee", "A") }),
      throwIfSyncCancelled: () => {},
      lineSessionContexts: async (contexts) => contexts,
      accountSyncs: new Map(),
      sessionEligibility: createSessionEligibility({ setTimer: () => 1, clearTimer: () => {} }),
      recordLog: async (level, area, event) => logs.push({ level, area, event }),
      recordUnexpected: async () => logs.push({ level: "error", event: "failed" }),
      updateScopedState: async (_key, _account, value) => states.push(value),
      attemptDelivery: async () => ({ sent: 0, pending: 0 }),
      providerLabel: adapter => adapter.id,
      syncOpenProvider: async () => { throw Object.assign(new Error("Provider recovery ended."), superseded ? { reason_code: "superseded" } : { recovery_diagnostic_recorded: recorded }); },
      readStorage: async () => ({}), readAccountState: (_stored, _key, fallback) => fallback,
    });
    const result = await run("manual", control, context("shopee", "A"));
    assert.ok(result.error);
    assert.equal(states.at(-1).state, "error");
    assert.equal(logs.filter(log => log.level === "error").length, superseded || recorded ? 0 : 1);
    assert.equal(logs.some(log => log.event === "superseded" && log.level === "info"), superseded);
  });
}
