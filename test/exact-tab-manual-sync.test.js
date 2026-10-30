import { createAccountSyncCoordinator } from "../extension/lib/sync-coordinator.js";
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
  const syncCoordinator = createAccountSyncCoordinator();
  const recoveries = syncCoordinator.jobs;
  const runtime = vm.createContext({ URL, AbortController, Map, Set,
    STORAGE: {}, hasLocalConsent: () => true, readStorage: async () => ({}),
    configuredAccountContexts: () => contexts, accountSyncs: recoveries, syncCoordinator, preemptAutomaticLogUpload() {},
    accountContextFor: (_stored, id, provider) => contexts.find(c => c.account.provider_account_id === id && c.adapter.id === provider),
    hasServerInitialized: () => true, throwIfSyncCancelled() {}, lineTabSyncs: new Map(),
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
  vm.runInContext(section("async function exactProviderAccountTab(", "// Display metadata is applied")
    + section("function requestAccountSync(", "async function cancelActiveSync(")
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

test("tab-scoped cancellation waits for old recovery cleanup before a fresh sync", async () => {
  const h = fixture("shopee");
  let finish;
  const completion = new Promise(resolve => { finish = resolve; });
  const control = { controller: new AbortController(), tabId: 42, adapter: { id: "shopee" }, completion };
  h.recoveries.set("shopee:A", control);
  let settled = false;
  const cancelled = h.runtime.cancelActiveSync("shopee", 42).then(result => { settled = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(control.controller.signal.aborted, true);
  assert.equal(settled, false);
  finish();
  assert.equal((await cancelled).cancelled, true);
});


test("shared LINE retry accepts another configured accessible account on the same login tab", async () => {
  const h = fixture();
  await h.runtime.retryProviderAccount({ provider: "line_oa", provider_account_id: "B", tab_id: 42, shared_session: true });
  assert.equal(h.calls[0].account, "B");
  assert.equal(h.calls[0].control.lockedTabId, 42);
  assert.equal(h.calls[0].control.sharedSession, true);
  h.setStatus({ account_access_verified: true, accessible_account_ids: ["A"] });
  await assert.rejects(h.runtime.retryProviderAccount({ provider: "line_oa", provider_account_id: "B", tab_id: 42, shared_session: true }), /Open this LINE account/);
});
