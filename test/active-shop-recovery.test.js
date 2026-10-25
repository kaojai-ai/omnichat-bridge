import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { readAccountState, writeAccountState } from "../extension/lib/storage.js";
import { popupAccountsForSession } from "../extension/lib/popup-accounts.js";
const source = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");
function extract(start, end) { return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))); }

test("shared config connects only the signed-in shop, retires its predecessor, and preserves queued messages", async () => {
  const shopeeAdapter = { id: "shopee", sendCommands: ["send"] };
  const contexts = ["a", "b"].map(id => ({ key: `shopee:${id}`, account: { provider: "shopee", provider_account_id: id }, adapter: shopeeAdapter }));
  let active = "b";
  const connected = [], retired = [];
  const pending = { a: ["queued-message"] };
  let live = {};
  const liveConnections = new Map([["shopee:a", {}]]);
  const sandbox = vm.createContext({
    shopeeAdapter, liveConnections,
    STORAGE: { consent: "consent" },
    readStorage: async () => ({ consent: true, pending }),
    configuredAccountContexts: () => contexts,
    hasServerInitialized: () => true, hasLocalConsent: v => v,
    providerChatTabs: async () => [{ id: 1 }],
    providerTabStatus: async () => ({ current_provider_account_id: active }),
    updateLiveState: async (context, patch) => { live = writeAccountState(live, context.key, { ...readAccountState(live, context.key, {}), ...patch }); },
    apiPingContexts: c => c, ensureApiPingAlarm: async () => {}, ensureApiPings: () => {},
    ensureProviderHealthAlarm: async () => {}, clearProviderRecoveryLiveState: async () => {},
    stopAccountLiveConnection: key => { retired.push(key); liveConnections.delete(key); },
    stopLiveConnection: () => { liveConnections.clear(); }, recordLog: async () => {},
    ensureAccountLiveConnection: async c => { connected.push(c.key); liveConnections.set(c.key, {}); },
  });
  vm.runInContext(extract("function liveCommandContexts(", "function messageProviderAccountId(") + extract("async function ensureLiveConnection(", "async function ensureAccountLiveConnection("), sandbox);
  await sandbox.ensureLiveConnection();
  assert.deepEqual(connected, ["shopee:b"]);
  assert.deepEqual(retired, ["shopee:a"]);
  assert.equal(readAccountState(live, "shopee:a", {}).active_in_profile, false);
  assert.equal(popupAccountsForSession(contexts.map(c => c.account), live)[0].provider_account_id, "b");
  active = "a";
  await sandbox.ensureLiveConnection();
  assert.deepEqual(retired, ["shopee:a", "shopee:b"]);
  assert.deepEqual(pending, { a: ["queued-message"] });
  active = null;
  await sandbox.ensureLiveConnection();
  assert.equal(liveConnections.size, 0);
});

test("automatic delivery respects retry time while explicit retry bypasses it", async () => {
  let flushes = 0;
  const context = { key: "shop", account: { provider_account_id: "shop" } };
  const sandbox = vm.createContext({
    STORAGE: { consent: "consent", pending: "pending", deliveryRetry: "retry" },
    readStorage: async () => ({ consent: true, pending: { shop: ["message"] }, retry: { shop: { next_at: new Date(Date.now() + 60_000).toISOString() } } }),
    readAccountState: (container, key, fallback) => container?.[key] ?? fallback,
    hasServerInitialized: () => true, hasLocalConsent: v => v,
    resetDeliveryRetry: async () => {}, clearDeliveryRetry: async () => {},
    flushAll: async () => { flushes++; return { sent: 1, pending: 0 }; },
    updateScopedState: async () => {},
  });
  vm.runInContext(extract("const accountDeliveries =", "async function attemptAllDeliveries("), sandbox);
  assert.equal((await sandbox.attemptDelivery(context, { resetBackoff: false })).skipped, "backoff");
  assert.equal(flushes, 0);
  assert.equal((await sandbox.attemptDelivery(context, { resetBackoff: true })).sent, 1);
  assert.equal(flushes, 1);
});
