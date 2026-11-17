import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { accountConfigKey, accountKey, findAccountConfig } from "../extension/lib/config.js";
import { STORAGE, readAccountState } from "../extension/lib/storage.js";

const source = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const account = id => ({ provider: "line_oa", provider_account_id: id });
const adapter = { id: "line_oa", matchesUrl: () => true };

function contextScope() {
  const scope = vm.createContext({ accountConfigKey, accountKey, findAccountConfig,
    STORAGE, detectedAccounts: stored => stored[STORAGE.detectedAccounts] ?? [],
    normalizedProviderId: value => value, canonicalProviderAccountId: ({ config }) => config.provider_account_id,
    providerAdapterForAccount: () => adapter,
  });
  vm.runInContext(section("function accountContextFor(", "function liveCommandContexts("), scope);
  return scope;
}

test("off or deleted accounts cannot enter runtime contexts while legacy configs remain enabled", () => {
  const scope = contextScope();
  const stored = {
    [STORAGE.config]: { accounts: [account("healthy"), { ...account("off"), enabled: false }, account("undetected")] },
    [STORAGE.detectedAccounts]: [account("healthy"), account("off"), account("deleted")],
  };
  assert.deepEqual(Array.from(scope.configuredAccountContexts(stored), context => context.key), ["line_oa:healthy", "line_oa:undetected"]);
  assert.equal(scope.accountContextFor(stored, "off", "line_oa"), null);
  assert.equal(scope.accountContextFor(stored, "deleted", "line_oa"), null);
  assert.equal(scope.accountContextFor(stored, "healthy", "line_oa").key, "line_oa:healthy");
});

for (const removed of [false, true]) {
  test(`${removed ? "deleting" : "disabling"} one account stops only its work and keeps peers active`, async () => {
    const first = account("first"), peer = account("peer");
    const jobs = new Map(["first", "peer"].map(id => [`line_oa:${id}`, { controller: new AbortController(), tabId: 4 }]));
    const sockets = new Map(["first", "peer"].map(id => [`line_oa:${id}`, {}]));
    const resets = [], messages = [], closed = [];
    const scope = vm.createContext({ accountConfigKey, providerAdapterForAccount: () => adapter,
      accountSyncs: jobs, sessionEligibility: { reset: key => resets.push(key) },
      providerPolicyTabIds: new Map([["line_oa:first", 4], ["line_oa:peer", 4]]),
      providerPolicyContexts: new Map(), providerAutomaticRetryAttempts: new Map(), providerAutomaticRetryAt: new Map(),
      liveConnections: sockets,
      stopAccountLiveConnection: key => { closed.push(key); sockets.delete(key); },
      providerChatTabs: async () => [{ id: 4 }],
      sendProviderMessage: async (_tab, message) => messages.push(message),
      PROVIDER_STATUS_RESPONSE_TIMEOUT_MS: 1000,
      ensureLiveConnection: async () => {}, clearDeliveryRetryAlarmIfIdle: async () => {},
    });
    vm.runInContext(section("async function reconcileAccountConfiguration(", "async function refreshRegionalShopeePermissions("), scope);
    await scope.reconcileAccountConfiguration({ oldValue: { accounts: [first, peer] }, newValue: {
      accounts: removed ? [peer] : [{ ...first, enabled: false }, peer],
    } });
    assert.equal(jobs.get("line_oa:first").controller.signal.aborted, true);
    assert.equal(jobs.get("line_oa:peer").controller.signal.aborted, false);
    assert.deepEqual(resets, ["line_oa:first"]);
    assert.deepEqual(closed, ["line_oa:first"]);
    assert.deepEqual(messages.map(message => message.provider_account_id), ["first"]);
  });
}

for (const disabled of [false, true]) {
  test(`stale ${disabled ? "disabled" : "deleted"} context cannot capture or forward queued data`, async () => {
    const configured = disabled ? { ...account("first"), enabled: false } : null;
    const state = { [STORAGE.config]: { accounts: configured ? [configured] : [] },
      [STORAGE.consent]: true, [STORAGE.pending]: { version: 2, accounts: { "line_oa:first": ["retained"] } },
    };
    const scope = vm.createContext({ STORAGE, readAccountState, findAccountConfig,
      readStorage: async () => state, serializeAccountStorage: action => action(),
      hasLocalConsent: value => value, performance, recordLog: async () => {},
    });
    vm.runInContext(section("async function queueMessagesForContext(", "async function queueMessages(")
      + section("async function flushBatch(", "async function flushAll("), scope);
    const context = { key: "line_oa:first", account: account("first") };
    assert.equal((await scope.queueMessagesForContext(["new"], context, true)).queued, 0);
    const result = await scope.flushBatch(context);
    assert.equal(result.sent, 0);
    assert.equal(result.pending, 1);
    assert.deepEqual(state[STORAGE.pending].accounts["line_oa:first"], ["retained"]);
  });
}

test("persisted access denial prevents automatic polling without blocking a manual checkpoint", async () => {
  let selected = 0;
  let scans = 0;
  const start = source.indexOf('  if (message?.type === "get_sync_state")');
  const end = source.indexOf('  if (message?.type === "discard_pending")', start);
  const read = vm.runInNewContext(`message => new Promise(resolve => { const respond = resolve; ${source.slice(start, end)} })`, {
    _sender: { tab: { id: 4 } }, STORAGE, readAccountState,
    readStorage: async () => ({ [STORAGE.status]: { version: 2, accounts: { "line_oa:first": { account_access_denied: true } } } }),
    accountContextFor: () => ({ key: "line_oa:first" }), hasLocalConsent: () => true,
    pollingOwner: { select: async () => { selected++; return { tab: { id: 4 } }; } },
    exclusive: action => action(), getAccountScanState: async () => { scans++; return { state: {} }; },
    historySyncSettings: () => null,
  });
  assert.equal((await read({ type: "get_sync_state", request_id: "poll:one" })).polling_allowed, false);
  assert.equal(selected, 0);
  assert.equal(scans, 0);
  assert.equal((await read({ type: "get_sync_state", request_id: "manual:one" })).ok, true);
  assert.equal(scans, 1);
});

test("only the matching active manual retry may clear a persisted access denial", async () => {
  const control = { retryAccess: true, providerRequestId: "current", tabId: 4, controller: new AbortController() };
  const writes = [];
  const start = source.indexOf('  if (message?.type === "account_access_denied")');
  const end = source.indexOf('  if (message?.type === "get_sync_state")', start);
  const report = vm.runInNewContext(`message => new Promise(resolve => { const respond = resolve; ${source.slice(start, end)} })`, {
    _sender: { tab: { id: 4, url: "https://chat.line.biz/" } }, STORAGE,
    readStorage: async () => ({}), accountContextFor: () => ({ key: "line_oa:first", adapter }),
    accountSyncs: new Map([["line_oa:first", control]]),
    updateScopedState: async (_storage, key, patch) => writes.push({ key, ...patch }),
  });
  const message = { type: "account_access_denied", provider: "line_oa", provider_account_id: "first", denied: false };
  assert.equal((await report({ ...message, request_id: "old" })).ok, false);
  assert.equal(writes.length, 0);
  assert.equal((await report({ ...message, request_id: "current" })).ok, true);
  assert.equal(writes[0].account_access_denied, false);
  control.controller.abort();
  assert.equal((await report({ ...message, request_id: "current" })).ok, false);
  assert.equal(writes.length, 1);
});

test("configuration-save sync cannot retry denied access, but an explicit Sync click can", async () => {
  const context = { key: "line_oa:first", adapter: { id: "line_oa" }, account: account("first"), config: {} };
  let scanned = 0;
  const scope = vm.createContext({ manualBridgeRepair: null, accountSyncs: new Map(), AbortController,
    STORAGE, readAccountState, throwIfSyncCancelled: () => {},
    syncCoordinator: { run: (_key, _provider, _control, action) => action() },
    readStorage: async () => ({ [STORAGE.status]: { version: 2, accounts: { "line_oa:first": { account_access_denied: true } } } }),
    accountContextFor: () => context, hasLocalConsent: () => true,
    hasServerInitialized: () => true, openSessionSyncContexts: async () => [context],
    sessionEligibility: { generation: () => 1 }, queueLiveStateWrite: action => action(), writeStorage: async () => {},
    runAccountSync: async (_trigger, control) => { scanned++; return { retryAccess: control.retryAccess }; },
    ensureLiveConnection: async () => {}, recordUnexpected: async () => {},
  });
  vm.runInContext(section("function requestAccountSync(", "async function retryProviderAccount("), scope);
  assert.equal((await scope.requestAccountSync(context, "manual", { retry_access: false })).skipped, "provider_access_denied");
  assert.equal((await scope.requestAccountSync(context, "automatic")).skipped, "provider_access_denied");
  assert.equal(scanned, 0);
  assert.equal((await scope.requestAccountSync(context, "manual")).retryAccess, true);
  assert.equal(scanned, 1);
});

test("LINE tab config-save sync preserves its no-access-retry flag", async () => {
  let received;
  const scope = vm.createContext({ lineTabSyncs: new Map(), AbortController,
    syncAccountsForTab: async (_provider, _tab, _trigger, options) => { received = options.retry_access; },
  });
  vm.runInContext(section("function syncLineTab(", "async function exactProviderAccountTab("), scope);
  await scope.syncLineTab(4, { retry_access: false });
  assert.equal(received, false);
  await scope.syncLineTab(4);
  assert.equal(received, true);
});
