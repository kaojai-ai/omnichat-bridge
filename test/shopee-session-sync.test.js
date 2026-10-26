import { webcrypto as crypto } from "node:crypto";
import { createSessionEligibility } from "../extension/lib/session-eligibility.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
const source = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
const start = source.indexOf("async function openSessionSyncContexts(");
const end = source.indexOf("\nasync function runUnifiedSync", start);
const context = (provider, id) => ({ key: id, adapter: { id: provider }, account: { provider, provider_account_id: id } });
for (const currentId of ["A", "B", null]) {
  test(`sync follows current Shopee session ${currentId} and retains all LINE accounts`, async () => {
    const contexts = [context("shopee", "A"), context("shopee", "B"), context("line_oa", "L1"), context("line_oa", "L2")];
    const skipped = [];
    const select = vm.runInNewContext(`(${source.slice(start, end)})`, {
      throwIfSyncCancelled: () => {},
      lineSessionContexts: async (contexts) => contexts,
      providerAutomaticRecoveries: new Map(),
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
  const select = vm.runInNewContext(`(${source.slice(start, end)})`, {
      throwIfSyncCancelled: () => {},
      lineSessionContexts: async (contexts) => contexts,
      providerAutomaticRecoveries: new Map(),
      sessionEligibility: createSessionEligibility({ setTimer: () => 1, clearTimer: () => {} }),});
  const contexts = [context("line_oa", "L1"), context("line_oa", "L2")];
  assert.equal(await select(contexts, { controller: { signal: {} } }), contexts);
});

test("a failed fresh lookup cannot reuse the previous shop ID", async () => {
  const contexts = [context("shopee", "A"), context("line_oa", "L1")];
  const select = vm.runInNewContext(`(${source.slice(start, end)})`, {
      throwIfSyncCancelled: () => {},
      lineSessionContexts: async (contexts) => contexts,
      providerAutomaticRecoveries: new Map(),
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
  const end = source.indexOf("\nchrome.tabs.onUpdated", start);
  const calls = [];
  const reconnect = vm.runInNewContext(`(${source.slice(start, end)})`, {
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
  test(`LINE sync continues when Shopee ${failureAt} throws`, async () => {
    const contexts = [context("shopee", "A"), context("line_oa", "L1"), context("line_oa", "L2")];
    const synced = [];
    const errors = [];
    const failure = new Error("Receiving end does not exist");
    const lookup = async (stage, result) => {
      if (stage === failureAt) throw failure;
      return result;
    };
    const syncEnd = source.indexOf("\nasync function resumeSync", end);
    const run = vm.runInNewContext(`${source.slice(start, syncEnd)}\nrunUnifiedSync`, {
      shopeeAdapter: {}, crypto, STORAGE: {},
      findReadyProviderChatTab: () => lookup("tab_lookup", { id: 42 }),
      detectOpenProviderAccount: () => lookup("detection", { ok: true }),
      providerTabStatus: () => lookup("status", { current_provider_account_id: "A" }),
      readStorage: async () => ({}), configuredAccountContexts: () => contexts,
      recordUnexpected: async (area, error, details) => errors.push({ area, error, details }),
      recordLog: async () => {}, updateScopedState: async (_storage, _key, patch) => { if (typeof patch === "function") patch({}); },
      hasLocalConsent: () => true, throwIfSyncCancelled: () => {},
      lineSessionContexts: async (contexts) => contexts,
      providerAutomaticRecoveries: new Map(),
      sessionEligibility: createSessionEligibility({ setTimer: () => 1, clearTimer: () => {} }),
      runAccountSync: async (_trigger, _control, account) => {
        synced.push(account.key);
        return { sent: 1 };
      },
    });
    const result = await run("manual", { controller: new AbortController() });
    assert.deepEqual(synced, ["L1", "L2"]);
    assert.equal(result.sent, 2);
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
    const run = vm.runInNewContext(source.slice(source.indexOf("async function runAccountSync("), source.indexOf("\nasync function openSessionSyncContexts")) + "\nrunAccountSync", {
      activeSyncControl: control, isCurrentSyncControl: candidate => candidate === control,
      crypto, STORAGE: {}, RESUME_SYNC_COOLDOWN_MS: 0,
      exclusive: async () => ({ context: context("shopee", "A") }),
      throwIfSyncCancelled: () => {},
      lineSessionContexts: async (contexts) => contexts,
      providerAutomaticRecoveries: new Map(),
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

for (const outcome of ["selected", "failed"]) {
  test(`blocked account access probe shows early progress and clears ${outcome === "selected" ? "skipped" : "failed"} candidates`, async () => {
    const candidates = [context("line_oa", "A"), context("line_oa", "B")];
    let resolveProbe, rejectProbe;
    const probe = new Promise((resolve, reject) => { resolveProbe = resolve; rejectProbe = reject; });
    const states = new Map(), synced = [];
    const syncEnd = source.indexOf("\nasync function resumeSync", end);
    const run = vm.runInNewContext(`${source.slice(start, syncEnd)}\nrunUnifiedSync`, {
      crypto, STORAGE: { status: "status" }, readStorage: async () => ({}),
      configuredAccountContexts: () => candidates, hasLocalConsent: () => true,
      throwIfSyncCancelled: () => {},
      lineSessionContexts: () => {
        for (const candidate of candidates) {
          assert.equal(states.get(candidate.key)?.phase, "checking_session", "publish progress before beginning a slow probe");
        }
        return probe;
      },
      updateScopedState: async (_storage, key, patch) => { const current = states.get(key) ?? {}; states.set(key, { ...current, ...(typeof patch === "function" ? patch(current) : patch) }); },
      providerAutomaticRecoveries: new Map(),
      sessionEligibility: createSessionEligibility({ setTimer: () => 1, clearTimer: () => {} }),
      recordLog: async () => {},
      runAccountSync: async (_trigger, _control, account) => {
        synced.push(account.key);
        return { sent: 1 };
      },
    });
    const running = run("manual", { controller: new AbortController() });
    const failure = outcome === "failed" ? assert.rejects(running, /access probe failed/) : null;
    await new Promise(setImmediate);
    assert.deepEqual(synced, [], "capture/recovery must not start before access is verified");
    for (const candidate of candidates) {
      const state = states.get(candidate.key);
      assert.equal(state.state, "discovering");
      assert.equal(state.phase, "checking_session");
      assert.equal(state.total_conversations, undefined);
      assert.equal(state.pages_fetched, undefined);
      assert.equal(state.messages_captured, undefined);
      assert.equal(state.last_progress_at, undefined);
    }
    if (outcome === "failed") {
      rejectProbe(new Error("access probe failed"));
      await failure;
      assert.deepEqual(synced, []);
      for (const state of states.values()) {
        assert.equal(state.state, "watching");
        assert.equal(state.phase, null);
      }
    } else {
      resolveProbe([candidates[0]]);
      assert.equal((await running).sent, 1);
      assert.deepEqual(synced, ["A"]);
      assert.equal(states.get("B").state, "watching");
      assert.equal(states.get("B").phase, null);
    }
  });
}

test("manual sync preserves an account already recovering automatically", async () => {
  const candidate = context("line_oa", "A");
  const syncEnd = source.indexOf("\nasync function resumeSync", end);
  const run = vm.runInNewContext(`${source.slice(start, syncEnd)}\nrunUnifiedSync`, {
    crypto, STORAGE: {}, readStorage: async () => ({}),
    configuredAccountContexts: () => [candidate], hasLocalConsent: () => true,
    providerAutomaticRecoveries: new Map([[candidate.key, {}]]),
    updateScopedState: () => assert.fail("must preserve the automatic recovery's progress"),
    lineSessionContexts: () => assert.fail("must not probe a running recovery again"),
    runAccountSync: () => assert.fail("must not start duplicate recovery"),
    recordLog: async () => {},
  });
  assert.equal((await run("manual", { controller: new AbortController() })).accounts.length, 0);
});

function preflightHarness({ accounts = [context("line_oa", "A")], runAccount, actualAccountSync = false } = {}) {
  const states = new Map(accounts.map(account => [account.key, {
    state: "watching", phase: null, last_sync_at: new Date().toISOString(),
    pending: 3, messages_captured: 7, last_capture_at: "before", sync_error: "previous failure",
  }]));
  const runtime = vm.createContext({
    crypto, STORAGE: { status: "status" }, readStorage: async () => ({}),
    configuredAccountContexts: () => accounts, hasLocalConsent: () => true,
    providerAutomaticRecoveries: new Map(), sessionEligibility: { generation: () => 1 },
    openSessionSyncContexts: async selected => selected,
    throwIfSyncCancelled: signal => { if (signal.aborted) throw new Error("cancelled"); },
    updateScopedState: async (_storage, key, patch) => {
      const current = states.get(key) ?? {};
      states.set(key, { ...current, ...(typeof patch === "function" ? patch(current) : patch) });
    },
    recordLog: async () => {},
    exclusive: async task => task(), RESUME_SYNC_COOLDOWN_MS: 300_000,
    getAccountScanState: async id => ({ state: { in_progress: false }, stored: { status: states.get(id) } }),
    readAccountState: value => value,
    runAccountSync: runAccount,
  });
  const unified = source.slice(source.indexOf("async function runUnifiedSync("), source.indexOf("\nasync function resumeSync("));
  const accountSync = actualAccountSync
    ? source.slice(source.indexOf("async function runAccountSync("), source.indexOf("\nasync function openSessionSyncContexts(")) : "";
  vm.runInContext(accountSync + unified, runtime);
  return { runtime, states, accounts };
}

test("automatic cooldown settles its own access preflight instead of leaving Checking access persisted", async () => {
  const { runtime, states } = preflightHarness({ actualAccountSync: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await runtime.runUnifiedSync("automatic", { controller: new AbortController() });
    assert.equal(result.accounts[0].skipped, "cooldown");
    const state = states.get("A");
    assert.equal(state.state, "watching");
    assert.equal(state.phase, null);
    assert.equal(state.sync_attempt_id, null);
    assert.equal(state.pending, 3);
    assert.equal(state.messages_captured, 7);
    assert.equal(state.sync_error, "previous failure");
  }
});

test("cancelling one sequential recovery settles queued siblings while preserving concurrent capture", async () => {
  const accounts = [context("line_oa", "A"), context("line_oa", "B")];
  const control = { controller: new AbortController() };
  const { runtime, states } = preflightHarness({ accounts, runAccount: async (_trigger, _control, account) => {
    assert.equal(account.key, "A");
    assert.equal(states.get("B").phase, "queued");
    states.set("A", { ...states.get("A"), state: "watching", phase: null, sync_attempt_id: null });
    states.set("B", { ...states.get("B"), pending: 4, messages_captured: 8, last_capture_at: "during" });
    control.controller.abort();
    return {};
  } });
  await assert.rejects(runtime.runUnifiedSync("manual", control), /cancelled/);
  assert.equal(states.get("B").state, "watching");
  assert.equal(states.get("B").phase, null);
  assert.equal(states.get("B").sync_attempt_id, null);
  assert.equal(states.get("B").pending, 4);
  assert.equal(states.get("B").messages_captured, 8);
  assert.equal(states.get("B").last_capture_at, "during");
});

test("old preflight finalization cannot overwrite a newer recovery owner", async () => {
  const accounts = [context("line_oa", "A"), context("line_oa", "B")];
  const control = { controller: new AbortController() };
  const { runtime, states } = preflightHarness({ accounts, runAccount: async () => {
    states.set("B", { ...states.get("B"), state: "discovering", phase: "checking_session", sync_attempt_id: "newer-owner" });
    control.controller.abort();
    return {};
  } });
  await assert.rejects(runtime.runUnifiedSync("manual", control), /cancelled/);
  assert.equal(states.get("B").state, "discovering");
  assert.equal(states.get("B").phase, "checking_session");
  assert.equal(states.get("B").sync_attempt_id, "newer-owner");
});
