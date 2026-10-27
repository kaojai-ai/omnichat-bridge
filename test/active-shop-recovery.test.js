import { installProviderPolicy } from "./helpers/provider-policy.js";
import { createSessionEligibility } from "../extension/lib/session-eligibility.js";
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { readAccountState, writeAccountState } from "../extension/lib/storage.js";
import { popupAccountsForSession } from "../extension/lib/popup-accounts.js";
const source = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");
function extract(start, end) { return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))); }

test("shared config connects only the signed-in shop, retires its predecessor, and preserves queued messages", async () => {
  const shopeeAdapter = { id: "shopee", sendCommands: ["send_text"] };
  const contexts = ["a", "b"].map(id => ({ key: `shopee:${id}`, account: { provider: "shopee", provider_account_id: id }, adapter: shopeeAdapter }));
  let active = "b";
  let now = 0;
  const eligibility = createSessionEligibility({ now: () => now, setTimer: () => 1, clearTimer: () => {} });
  const connected = [], retired = [];
  const pending = { a: ["queued-message"] };
  let live = {};
  const liveConnections = new Map([["shopee:a", {}]]);
  const sandbox = vm.createContext({
    sessionEligibility: eligibility,
    shopeeAdapter, liveConnections, WebSocket: { OPEN: 1 },
    STORAGE: { consent: "consent" },
    readStorage: async () => ({ consent: true, pending }),
    configuredAccountContexts: () => contexts,
    hasServerInitialized: () => true, hasLocalConsent: v => v,
    providerChatTabs: async () => [{ id: 1 }],
    providerTabStatus: async () => active === null ? null : ({ current_provider_account_id: active }),
    updateLiveState: async (context, patch) => { live = writeAccountState(live, context.key, { ...readAccountState(live, context.key, {}), ...patch }); },
    apiPingContexts: c => c, ensureApiPingAlarm: async () => {}, ensureApiPings: () => {},
    ensureProviderHealthAlarm: async () => {}, clearProviderRecoveryLiveState: async () => {},
    stopAccountLiveConnection: key => { retired.push(key); liveConnections.delete(key); },
    stopLiveConnection: () => { liveConnections.clear(); }, recordLog: async () => {},
    ensureAccountLiveConnection: async c => { connected.push(c.key); liveConnections.set(c.key, { socket: { readyState: 1 } }); },
  });
  installProviderPolicy(sandbox);
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
  assert.equal(liveConnections.size, 1, "transient uncertainty retains an already-open transport");
  assert.equal(eligibility.state("shopee:a").eligible, true, "recent unchanged session remains eligible during grace");
  assert.equal(readAccountState(live, "shopee:a", {}).active_in_profile, true);
  now = 30_001;
  await sandbox.ensureLiveConnection();
  assert.equal(liveConnections.size, 1, "expired readiness does not tear down a healthy transport");
  assert.equal(eligibility.state("shopee:a").eligible, false);
  now = 40_000;
  eligibility.reset();
  liveConnections.clear(); // A restarted worker has neither readiness evidence nor sockets.
  const before = connected.length;
  await sandbox.ensureLiveConnection();
  assert.equal(connected.length, before, "uncertainty must not create a fresh transport");
});

test("automatic delivery respects retry time while explicit retry bypasses it", async () => {
  let flushes = 0;
  const context = { key: "shop", account: { provider_account_id: "shop" } };
  const sandbox = vm.createContext({
    sessionEligibility: createSessionEligibility({ setTimer: () => 1, clearTimer: () => {} }),
    STORAGE: { consent: "consent", pending: "pending", deliveryRetry: "retry" },
    readStorage: async () => ({ consent: true, pending: { shop: ["message"] }, retry: { shop: { next_at: new Date(Date.now() + 60_000).toISOString() } } }),
    readAccountState: (container, key, fallback) => container?.[key] ?? fallback,
    hasServerInitialized: () => true, hasLocalConsent: v => v,
    resetDeliveryRetry: async () => {}, clearDeliveryRetry: async () => {},
    flushAll: async () => { flushes++; return { sent: 1, pending: 0 }; },
    updateScopedState: async () => {},
  });
  installProviderPolicy(sandbox);
  vm.runInContext(extract("const accountDeliveries =", "async function attemptAllDeliveries("), sandbox);
  assert.equal((await sandbox.attemptDelivery(context, { resetBackoff: false })).skipped, "backoff");
  assert.equal(flushes, 0);
  assert.equal((await sandbox.attemptDelivery(context, { resetBackoff: true })).sent, 1);
  assert.equal(flushes, 1);
});


test("conflicting Shopee pages pause both shops until fresh account detection agrees", async () => {
  const shopeeAdapter = { id: "shopee", sendCommands: ["send_text"] };
  const contexts = ["a", "b"].map(id => ({ key: id, account: { provider_account_id: id }, adapter: shopeeAdapter }));
  let refreshed = false;
  let agrees = false;
  const patches = {};
  const sandbox = vm.createContext({
    sessionEligibility: createSessionEligibility({ setTimer: () => 1, clearTimer: () => {} }),
    shopeeAdapter,
    providerChatTabs: async () => [{ id: 1 }, { id: 2 }],
    providerTabStatus: async tab => ({ current_provider_account_id: refreshed && agrees ? "b" : tab.id === 1 ? "a" : "b" }),
    sendProviderMessage: async () => { refreshed = true; return { ok: true }; },
    updateLiveState: async (context, patch) => { patches[context.key] = patch; },
    recordLog: async () => {},
  });
  installProviderPolicy(sandbox);
  vm.runInContext(extract("function liveCommandContexts(", "function messageProviderAccountId("), sandbox);
  assert.equal((await sandbox.activeLiveCommandContexts(contexts)).length, 0);
  assert.equal(patches.a.provider_session_reason_code, "session_conflict");
  assert.equal(patches.b.leader, false);
  agrees = true;
  const active = await sandbox.activeLiveCommandContexts(contexts);
  assert.equal(active.length, 1);
  assert.equal(active[0].key, "b");
  assert.equal(patches.a.provider_session_reason_code, "account_mismatch");
  assert.equal(patches.b.active_provider_account_id, "b");
});
