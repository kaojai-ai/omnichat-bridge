import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { createAccountSyncCoordinator } from "../extension/lib/sync-coordinator.js";
const source = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
const part = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
function harness({ pauseSync = false } = {}) {
  const adapter = { id: "line_oa" };
  const contexts = ["A", "B", "C"].map(id => ({ key: `line_oa:${id}`, adapter,
    account: { provider: "line_oa", provider_account_id: id }, config: {} }));
  contexts.push({ key: "shopee:A", adapter: { id: "shopee" }, account: { provider: "shopee", provider_account_id: "A" }, config: {} });
  const calls = [], batches = new Map(), syncCoordinator = createAccountSyncCoordinator();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const tab = { id: 42, url: "https://chat.line.biz/bot-A/chats" };
  const runtime = vm.createContext({ AbortController, Set, Map, crypto, lineTabSyncs: batches, syncCoordinator,
    providerAdapterForId: () => adapter, providerChatTabById: async () => tab, providerAccountMatchesTab: () => true,
    providerTabContext: () => "fixed-session", STORAGE: { status: "status" },
    throwIfSyncCancelled: signal => { if (signal?.aborted) throw Object.assign(new Error("cancelled"), { name: "AbortError" }); },
    readStorage: async () => ({}), hasLocalConsent: () => true, hasServerInitialized: () => true,
    ensureProviderBridge: async () => {}, detectOpenProviderAccount: async () => ({ ok: true }),
    providerTabStatus: async () => ({ account_access_verified: true, accessible_account_ids: ["A", "B", "unconfigured"] }),
    exactProviderAccountTab: async () => tab,
    configuredAccountContexts: () => contexts, accountSyncs: syncCoordinator.jobs,
    accountContextFor: (_stored, id, provider) => contexts.find(context => context.adapter.id === provider && context.account.provider_account_id === id),
    queueLiveStateWrite: fn => fn(), writeStorage: async () => {}, preemptAutomaticLogUpload() {},
    ensureLiveConnection: async () => {}, recordUnexpected: async () => {},
    sendProviderMessage: async () => ({ ok: true }), PROVIDER_STATUS_RESPONSE_TIMEOUT_MS: 5000,
    runAccountSync: async (_trigger, control, context) => {
      assert.equal(control.controller.signal.aborted, false);
      assert.equal(control.refreshMetadata, true);
      calls.push([context.adapter.id, context.account.provider_account_id, control.lockedTabId, control.sharedSession]);
      if (pauseSync) await gate;
      if (control.controller.signal.aborted) throw new Error("cancelled");
      return { provider: "line_oa", provider_account_id: context.account.provider_account_id, recovered: 1 };
    },
  });
  vm.runInContext(part("function syncLineTab(", "async function exactProviderAccountTab(")
    + part("function requestAccountSync(", "async function clearPersistedSync(")
    + part("async function syncAccountsForTab(", "async function resumeSync("), runtime);
  return { runtime, calls, batches, release };
}

test("shared LINE tab batch coalesces and sequentially syncs every accessible configured account", async () => {
  const h = harness();
  const first = h.runtime.syncLineTab(42), second = h.runtime.syncLineTab(42);
  assert.equal(first, second);
  const result = await first;
  assert.equal(result.partial, false);
  assert.deepEqual(h.calls, [["line_oa", "A", 42, true], ["line_oa", "B", 42, true]]);
  assert.equal(h.batches.size, 0);
  assert.equal(h.runtime.accountSyncs.size, 0);
});

test("cancelling shared LINE batch prevents queued account scans and releases its jobs", async () => {
  const h = harness({ pauseSync: true });
  const task = h.runtime.syncLineTab(42);
  await new Promise(resolve => setImmediate(resolve));
  const cancellation = h.runtime.cancelActiveSync("line_oa", 42);
  h.release();
  const result = await task;
  assert.equal(result.partial, true);
  assert.equal(result.accounts.every(account => account.error === "cancelled"), true);
  assert.equal((await cancellation).cancelled, true);
  assert.deepEqual(h.calls, [["line_oa", "A", 42, true]]);
  assert.equal(h.batches.size, 0);
  assert.equal(h.runtime.accountSyncs.size, 0);
});

test("a LINE batch joins busy accounts and waits for their actual result", async () => {
  const h = harness();
  let complete;
  const existing = { accountKey: "line_oa:A", adapter: { id: "line_oa" }, tabId: 42,
    controller: new AbortController(), completion: new Promise(resolve => { complete = resolve; }) };
  h.runtime.accountSyncs.set(existing.accountKey, existing);
  let settled = false;
  const task = h.runtime.syncLineTab(42).then(result => { settled = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(existing.controller.signal.aborted, false);
  assert.equal(existing.refreshMetadata, true);
  complete({ provider: "line_oa", provider_account_id: "A", error: "provider failed" });
  const result = await task;
  assert.equal(result.partial, true);
  assert.equal(result.accounts[0].error, "provider failed");
  assert.deepEqual(h.calls, [["line_oa", "B", 42, true]]);
});
