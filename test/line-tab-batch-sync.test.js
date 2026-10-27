import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
const source = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
const part = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
function harness({ pauseMetadata = false } = {}) {
  const adapter = { id: "line_oa" };
  const contexts = ["A", "B", "C"].map(id => ({ key: `line_oa:${id}`, adapter, account: { provider_account_id: id } }));
  contexts.push({ key: "shopee:A", adapter: { id: "shopee" }, account: { provider_account_id: "A" } });
  const states = new Map(), calls = [], batches = new Map();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const runtime = vm.createContext({ AbortController, Set, Map, crypto, lineTabSyncs: batches,
    providerAdapterForId: () => adapter, providerChatTabById: async (_adapter, id) => ({ id, url: "https://chat.line.biz/bot-A/chats" }),
    providerTabContext: () => "fixed-session", STORAGE: { status: "status" },
    throwIfSyncCancelled: signal => { if (signal?.aborted) throw Object.assign(new Error("cancelled"), { name: "AbortError" }); },
    readStorage: async () => ({}), hasLocalConsent: () => true, ensureProviderBridge: async () => {},
    sendProviderMessage: async () => ({ ok: true, accounts: [{ provider_account_id: "A" }, { provider_account_id: "B" }] }),
    configuredAccountContexts: () => contexts, providerAutomaticRecoveries: new Map(), activeSyncControl: null, activeSync: null,
    updateScopedState: async (_storage, key, patch) => { const current = states.get(key) ?? {}; states.set(key, { ...current, ...(typeof patch === "function" ? patch(current) : patch) }); },
    refreshAccountMetadata: async (provider, id, tab, options) => {
      calls.push(["metadata", provider, id, tab, options.shared_session]);
      if (pauseMetadata) await gate;
      return { ok: true };
    },
    retryProviderAccount: async (message, { controller }) => {
      assert.equal(controller.signal.aborted, false);
      calls.push(["sync", message.provider, message.provider_account_id, message.tab_id, message.shared_session]);
      states.set(`line_oa:${message.provider_account_id}`, { ...states.get(`line_oa:${message.provider_account_id}`), state: "watching", phase: null });
      return { recovered: 1 };
    },
  });
  vm.runInContext(part("function syncLineTab(", "async function exactProviderAccountTab(")
    + part("async function cancelActiveSync(", "async function clearPersistedSync("), runtime);
  return { runtime, calls, states, batches, release };
}

test("shared LINE tab batch coalesces and sequentially refreshes/syncs accessible configured accounts only", async () => {
  const h = harness();
  const first = h.runtime.syncLineTab(42), second = h.runtime.syncLineTab(42);
  assert.equal(first, second);
  const result = await first;
  assert.equal(result.ok, true);
  assert.deepEqual(h.calls, [["metadata", "line_oa", "A", 42, true], ["sync", "line_oa", "A", 42, true],
    ["metadata", "line_oa", "B", 42, true], ["sync", "line_oa", "B", 42, true]]);
  assert.equal(h.batches.size, 0);
  for (const state of h.states.values()) assert.equal(state.sync_batch_id, null);
});

test("cancelling shared LINE batch during metadata prevents current and future syncs and clears owned queue states", async () => {
  const h = harness({ pauseMetadata: true });
  const task = h.runtime.syncLineTab(42);
  await new Promise(resolve => setImmediate(resolve));
  const cancellation = h.runtime.cancelActiveSync("line_oa", 42);
  h.release();
  await assert.rejects(task, /cancelled/);
  assert.equal((await cancellation).cancelled, true);
  assert.deepEqual(h.calls, [["metadata", "line_oa", "A", 42, true]]);
  assert.equal(h.batches.size, 0);
  for (const state of h.states.values()) {
    assert.equal(state.sync_batch_id, null);
    assert.equal(state.phase, null);
    assert.equal(state.state, "watching");
  }
});

test("busy LINE accounts are reported rather than treated as completed work", async () => {
  const h = harness();
  h.runtime.providerAutomaticRecoveries.set("line_oa:A", {});
  h.runtime.providerAutomaticRecoveries.set("line_oa:B", {});
  await assert.rejects(h.runtime.syncLineTab(42), /already syncing/);
  assert.equal(h.calls.length, 0);
  assert.equal(h.batches.size, 0);
});

test("partly busy LINE batch reports skipped accounts and processes the available account", async () => {
  const h = harness();
  h.runtime.providerAutomaticRecoveries.set("line_oa:A", {});
  const result = await h.runtime.syncLineTab(42);
  assert.equal(result.partial, true);
  assert.equal(result.accounts[0].skipped, "already_syncing");
  assert.deepEqual(h.calls.map(call => call[2]), ["B", "B"]);
});
