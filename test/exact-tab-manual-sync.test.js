import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
function section(start, end) { const first = source.indexOf(start); const last = source.indexOf(end, first); assert.ok(first >= 0 && last > first); return source.slice(first, last); }
function fixture(provider = "line_oa") {
  const adapter = { id: provider, supports: () => true };
  const contexts = ["A", "B"].map(id => ({ key: `${provider}:${id}`, adapter,
    account: { provider, provider_account_id: id, bot_id: `bot-${id}` }, config: {} }));
  let tab = { id: 42, url: provider === "line_oa" ? "https://chat.line.biz/bot-A/chats" : "https://seller.shopee.co.th/new-webchat" };
  let status = { account_access_verified: true, accessible_account_ids: ["A", "B"], current_provider_account_id: "A" };
  let epoch = 1;
  const calls = [];
  const recoveries = new Map();
  const runtime = vm.createContext({ URL, AbortController, Map, Set,
    STORAGE: {}, hasLocalConsent: () => true, readStorage: async () => ({}),
    configuredAccountContexts: () => contexts, providerAutomaticRecoveries: recoveries, activeSyncControl: null,
    providerChatTabById: async (_adapter, id) => tab?.id === id ? { ...tab } : null,
    providerTabStatus: async () => status, providerTabContext: candidate => `${candidate.id}:${candidate.url}:${epoch}`,
    ensureProviderBridge: async () => {},
    openSessionSyncContexts: async items => { calls.push("legacy-selection"); return items; },
    sessionEligibility: { generation: () => 1 },
    queueLiveStateWrite: operation => operation(), writeStorage: async () => {},
    runAccountSync: async (_trigger, control, context) => { calls.push({ control, account: context.account.provider_account_id }); return { recovered: 0 }; },
    ensureLiveConnection: async () => {}, recordUnexpected: async () => {},
    sendProviderMessage: async (id, message) => { calls.push({ id, message }); return { ok: true }; },
    PROVIDER_STATUS_RESPONSE_TIMEOUT_MS: 5000,
    providerLabel: () => provider, updateScopedState: async () => {}, throwIfSyncCancelled: () => {},
    providerTabCanSend: () => true, RECOVERY_IDLE_TIMEOUT_MS: 60000, crypto: { randomUUID: () => "sync-request" },
    findReadyProviderChatTab: () => assert.fail("Must not fall back to another tab"),
    findProviderChatTab: () => assert.fail("Must not fall back to another tab"),
    providerChatTabs: () => assert.fail("Must not enumerate alternative tabs"),
  });
  vm.runInContext(section("async function exactProviderAccountTab(", "async function refreshAccountMetadata(")
    + section("async function retryProviderAccount(", "function restartSync(")
    + section("async function cancelActiveSync(", "async function clearPersistedSync("), runtime);
  return { runtime, contexts, calls, recoveries,
    close() { tab = null; }, navigate(url) { tab.url = url; epoch++; }, setStatus(value) { status = value; },
    control() { return { controller: new AbortController(), lockedTabId: 42,
      lockedTabContext: `${tab.id}:${tab.url}:${epoch}` }; },
    installRecovery() { vm.runInContext(section("async function syncOpenProvider(", "async function retryProviderAccount("), runtime); },
  };
}

test("exact LINE retry selects the open bot, not every accessible account", async () => {
  const h = fixture();
  await h.runtime.retryProviderAccount({ provider: "line_oa", provider_account_id: "A", tab_id: 42 });
  assert.equal(h.calls[0].account, "A");
  assert.equal(h.calls[0].control.lockedTabId, 42);
  assert.equal(h.calls[0].control.tabId, 42);
  assert.equal(h.calls[0].control.sessionGeneration, undefined);
  await assert.rejects(h.runtime.retryProviderAccount({ provider: "line_oa", provider_account_id: "B", tab_id: 42 }), /Open this LINE account/);
  assert.equal(h.calls.length, 1);
});

test("retry without a tab retains legacy account selection", async () => {
  const h = fixture();
  await h.runtime.retryProviderAccount({ provider: "line_oa", provider_account_id: "B" });
  assert.equal(h.calls[0], "legacy-selection");
  assert.equal(h.calls[1].account, "B");
  assert.equal(h.calls[1].control.lockedTabId, undefined);
});

test("exact Shopee retry rejects a different signed-in account", async () => {
  const h = fixture("shopee");
  await assert.rejects(h.runtime.retryProviderAccount({ provider: "shopee", provider_account_id: "B", tab_id: 42 }), /different account/);
  assert.equal(h.calls.length, 0);
});

for (const change of ["closed", "navigated"]) {
  test(`locked recovery ${change} tab fails without selecting another tab`, async () => {
    const h = fixture(); const control = h.control(); h.installRecovery();
    if (change === "closed") h.close(); else h.navigate("https://chat.line.biz/bot-B/chats");
    await assert.rejects(h.runtime.syncOpenProvider(control, h.contexts[0]), /no longer open|Open this LINE account|changed/);
    assert.equal(h.calls.length, 0);
  });
}

test("tab-scoped cancellation stops only its matching account recovery", async () => {
  const h = fixture("shopee");
  const target = { controller: new AbortController(), tabId: 42, adapter: { id: "shopee" }, providerAccountId: "A", providerRequestId: "attempt-A" };
  const other = { controller: new AbortController(), tabId: 43, adapter: { id: "shopee" }, providerAccountId: "B", providerRequestId: "attempt-B" };
  h.recoveries.set("shopee:A", target); h.recoveries.set("shopee:B", other);
  const result = await h.runtime.cancelActiveSync("shopee", 42);
  assert.equal(result.cancelled, true);
  assert.equal(target.controller.signal.aborted, true);
  assert.equal(other.controller.signal.aborted, false);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].message.request_id, "attempt-A");
  assert.equal(h.calls[0].id, 42);
});

test("exact metadata refresh cannot adopt another tab's in-flight refresh", async () => {
  const h = fixture();
  const requests = [];
  let finish;
  Object.assign(h.runtime, { metadataRefreshes: new Map(), metadataErasing: false, metadataEpoch: 1,
    accountKey: (provider, account) => `${provider}:${account}`,
    accountContextFor: (_stored, id) => h.contexts.find(context => context.account.provider_account_id === id),
    providerSessionEpoch: () => 1, metadataScope: async context => context.key,
    exclusive: operation => operation(), mergeDetectedAccounts: () => [],
    customerMetadata: { refresh: async () => 0, flush: async () => {} },
    sendProviderMessage: async (id, message) => { requests.push({ id, message }); return new Promise(resolve => { finish = resolve; }); },
  });
  vm.runInContext(section("async function refreshAccountMetadata(", "async function detectOpenProviderAccount("), h.runtime);
  const first = h.runtime.refreshAccountMetadata("line_oa", "A", 42);
  const other = h.runtime.refreshAccountMetadata("line_oa", "A", 43);
  const outcomes = Promise.allSettled([first, other]);
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  finish({ ok: true, profiles: [] });
  const [valid, invalid] = await outcomes;
  assert.equal(valid.status, "fulfilled");
  assert.equal(invalid.status, "rejected");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].id, 42);
});

test("exact LINE metadata refresh rejects another accessible bot without fallback", async () => {
  const h = fixture();
  Object.assign(h.runtime, { metadataRefreshes: new Map(), metadataErasing: false, metadataEpoch: 1,
    accountKey: (provider, account) => `${provider}:${account}`,
    accountContextFor: (_stored, id) => h.contexts.find(context => context.account.provider_account_id === id),
    providerSessionEpoch: () => 1,
  });
  vm.runInContext(section("async function refreshAccountMetadata(", "async function detectOpenProviderAccount("), h.runtime);
  await assert.rejects(h.runtime.refreshAccountMetadata("line_oa", "B", 42), /Open this LINE account/);
  assert.equal(h.calls.length, 0);
});
