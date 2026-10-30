import { createAccountSyncCoordinator } from "../extension/lib/sync-coordinator.js";
import { createSessionEligibility } from "../extension/lib/session-eligibility.js";
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";
const source = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function messageHarness() {
  let now = 0, nextId = 0;
  const timers = new Map(), calls = [], response = deferred();
  const runtime = vm.createContext({
    performance, recordLog: async () => {},
    sessionEligibility: createSessionEligibility({ setTimer: () => 1, clearTimer: () => {} }),
    PROVIDER_REQUEST_TIMEOUT_MS: 15_000,
    syncCancelledError: () => Object.assign(new Error("cancelled"), { name: "AbortError" }),
    providerMessageTimeout: () => Object.assign(new Error("silent"), { name: "TimeoutError" }),
    setTimeout: (fn, delay) => { const id = ++nextId; timers.set(id, { at: now + delay, fn }); return id; },
    clearTimeout: id => timers.delete(id),
    chrome: { tabs: { sendMessage: (_tab, message) => { calls.push(message); return message.type === "sync_now_v3" ? response.promise : Promise.resolve({ ok: true }); } } },
  });
  vm.runInContext(section('function sendProviderMessage(', 'function syncCancelledError('), runtime);
  return { runtime, calls, response, advance: ms => { now += ms; for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.fn(); } } };
}

test("recovery progressing beyond 90 seconds stays alive; silence cancels only its own request", async () => {
  const h = messageHarness(), control = {};
  const result = h.runtime.sendProviderMessage(42, { type: "sync_now_v3", request_id: "attempt" }, { timeoutMs: 60_000, recoveryControl: control });
  const failed = assert.rejects(result, { name: "TimeoutError" });
  await Promise.resolve();
  for (let i = 0; i < 3; i++) { h.advance(40_000); control.touchRecovery(); }
  assert.equal(h.calls.length, 1);
  h.advance(60_000);
  await failed;
  assert.equal(h.calls[1].type, "cancel_sync_v3");
  assert.equal(h.calls[1].request_id, "attempt");
  assert.equal(control.touchRecovery, null);
});

test("already-cancelled handoff never sends a provider request", async () => {
  const h = messageHarness(), controller = new AbortController();
  controller.abort();
  await assert.rejects(h.runtime.sendProviderMessage(42, { type: "sync_now_v3" }, { signal: controller.signal }), { name: "AbortError" });
  assert.equal(h.calls.length, 0);
});

test("stale attempts and other tabs cannot refresh the current recovery watchdog", () => {
  let touches = 0;
  const handle = vm.runInNewContext(`${section('function isCurrentSyncControl(', 'async function initializeAndStartSync(')}
(message, _sender) => { const respond = () => {}; ${section('  if (message?.type === "sync_activity")', '  if (message?.type === "sync_progress" || message?.type === "sync_phase")')} }`, {
    accountSyncs: new Map([["line_oa:A", { accountKey: "line_oa:A", controller: new AbortController(), tabId: 42, providerRequestId: "new", touchRecovery: () => touches++ }]]),
  });
  handle({ type: "sync_activity", request_id: "old" }, { tab: { id: 42 } });
  handle({ type: "sync_activity", request_id: "new" }, { tab: { id: 99 } });
  assert.equal(touches, 0);
  handle({ type: "sync_activity", request_id: "new" }, { tab: { id: 42 } });
  assert.equal(touches, 1);
});

test("an already-open old content bridge is reattached before the new watchdog is used", async () => {
  let pings = 0, reinjections = 0;
  const ensure = vm.runInNewContext(`${section('async function ensureProviderBridge(', 'async function prepareProviderTab(')}\nensureProviderBridge;`, {
    providerBridgeChecks: new Map(), providerTabEpochs: new Map(), BRIDGE_PROTOCOL_VERSION: 3, BRIDGE_SOURCE: "omnichat-realtime-bridge-v3", PROVIDER_STATUS_RESPONSE_TIMEOUT_MS: 5_000,
    providerLabel: () => "Shopee",
    sendProviderMessage: async () => ({ ok: true, bridge_protocol_version: 3, bridge_source: "omnichat-realtime-bridge-v3", ...(++pings > 1 ? { recovery_watchdog_version: 1 } : {}) }),
    reinjectProviderBridge: async () => { reinjections++; return true; },
    providerMainBridgeStatus: async () => ({ ready: true }),
    recordLog: async () => {},
  });
  await ensure(42, { id: "shopee" });
  assert.equal(pings, 2);
  assert.equal(reinjections, 1);
});


test("unattended OA activity reaches only its current control and sender tab", () => {
  const touches = [];
  const controls = ["oa-a", "oa-b"].map((id) => ({ accountKey: id, controller: new AbortController(),
    tabId: 42, providerRequestId: id, touchRecovery: () => touches.push(id) }));
  const runtime = vm.createContext({
    accountSyncs: new Map(controls.map(control => [control.accountKey, control])) });
  vm.runInContext(section('function isCurrentSyncControl(', 'async function initializeAndStartSync(')
    + `
function handle(message, _sender) { const respond = () => {}; ${section('  if (message?.type === "sync_activity")', '  if (message?.type === "sync_progress" || message?.type === "sync_phase")')} }`, runtime);
  runtime.handle({ request_id: "oa-a", type: "sync_activity" }, { tab: { id: 42 } });
  runtime.handle({ request_id: "oa-b", type: "sync_activity" }, { tab: { id: 99 } });
  runtime.handle({ request_id: "old", type: "sync_activity" }, { tab: { id: 42 } });
  controls[1].controller.abort();
  runtime.handle({ request_id: "oa-b", type: "sync_activity" }, { tab: { id: 42 } });
  assert.deepEqual(touches, ["oa-a"]);
  assert.equal(runtime.isCurrentSyncControl(controls[0]), true);
  runtime.accountSyncs.delete("oa-a");
  assert.equal(runtime.isCurrentSyncControl(controls[0]), false);
});


test("a healthy content ping cannot hide an old Shopee main bridge after upgrade", async () => {
  let replacements = 0;
  let current = false;
  const ensure = vm.runInNewContext(`${section('async function ensureProviderBridge(', 'async function prepareProviderTab(')}\nensureProviderBridge;`, {
    providerBridgeChecks: new Map(), providerTabEpochs: new Map(), BRIDGE_PROTOCOL_VERSION: 3, BRIDGE_SOURCE: "omnichat-realtime-bridge-v3", PROVIDER_STATUS_RESPONSE_TIMEOUT_MS: 5_000,
    providerLabel: () => "Shopee",
    sendProviderMessage: async () => ({ ok: true, bridge_protocol_version: 3, bridge_source: "omnichat-realtime-bridge-v3", recovery_watchdog_version: 1 }),
    providerMainBridgeStatus: async () => ({ ready: current }),
    reinjectProviderBridge: async () => { replacements++; current = true; return true; },
    recordLog: async () => {},
  });
  await ensure(42, { id: "shopee" });
  assert.equal(replacements, 1);
  await ensure(42, { id: "shopee" });
  assert.equal(replacements, 1, "compatible page bridges remain attached");
});


test("idle LINE recovery settles error and releases only its own account slot", async () => {
  const h = messageHarness();
  const syncCoordinator = createAccountSyncCoordinator();
  const recoveries = syncCoordinator.jobs, updates = [];
  recoveries.set("line_oa:B", { healthy: true });
  const account = { key: "line_oa:A", account: { provider: "line_oa", provider_account_id: "A" }, adapter: { id: "line_oa" } };
  Object.assign(h.runtime, {
    AbortController, STORAGE: {}, lineTabSyncs: new Map(), accountSyncs: recoveries, syncCoordinator, preemptAutomaticLogUpload() {},
    accountContextFor: () => account,
    hasServerInitialized: () => true, throwIfSyncCancelled() {},
    readStorage: async () => ({}), hasLocalConsent: () => true, configuredAccountContexts: () => [account],
    openSessionSyncContexts: async c => c, queueLiveStateWrite: async fn => fn(), writeStorage: async () => {},
    ensureLiveConnection: async () => {}, recordUnexpected: async () => {}, recordLog: async () => {},
    exclusive: async () => ({ context: account }), throwIfSyncCancelled() {},
    updateScopedState: async (_storage, key, patch) => updates.push({ key, ...patch }),
    attemptDelivery: async () => ({ sent: 0, pending: 0 }), providerLabel: () => "LINE OA",
    readAccountState: (_storage, _key, fallback) => fallback,
    isCurrentSyncControl: control => recoveries.get(control.accountKey) === control,
    syncOpenProvider: control => { control.providerRequestId = "attempt-A"; return h.runtime.sendProviderMessage(42,
      { type: "sync_now_v3", request_id: "attempt-A", provider_account_id: "A" },
      { recoveryControl: control, timeoutMs: 60_000 }); },
  });
  vm.runInContext(section('async function runAccountSync(', 'async function openSessionSyncContexts(')
    + section('function requestAccountSync(', 'async function cancelActiveSync('), h.runtime);
  const result = h.runtime.retryProviderAccount({ provider: "line_oa", provider_account_id: "A" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(recoveries.has("line_oa:A"), true);
  h.advance(60_000);
  assert.match((await result).error, /silent/);
  assert.equal(recoveries.has("line_oa:A"), false);
  assert.equal(recoveries.get("line_oa:B").healthy, true);
  assert.equal(updates.at(-1).state, "error");
  assert.equal(updates.at(-1).phase, null);
  const cancellation = h.calls.find(call => call.type === "cancel_sync_v3");
  assert.equal(cancellation.provider_account_id, "A");
  assert.equal(cancellation.request_id, "attempt-A");
});


test("explicit LINE Cancel reaches scoped retries without aborting another provider", async () => {
  const line = { controller: new AbortController(), accountKey: "line_oa:A", adapter: { id: "line_oa" }, providerAccountId: "A", providerRequestId: "run-A", tabId: 42 };
  const shopee = { controller: new AbortController(), adapter: { id: "shopee" } };
  const calls = [];
  const cancel = vm.runInNewContext(`(${section('async function cancelActiveSync(', 'async function clearPersistedSync(')})`, {
    lineTabSyncs: new Map(), accountSyncs: new Map([[line.accountKey, line], ["shopee:B", shopee]]), clearPersistedSync: async () => false,
    sendProviderMessage: async (_tab, message) => { calls.push(message); return { ok: true }; },
    PROVIDER_STATUS_RESPONSE_TIMEOUT_MS: 5000,
  });
  assert.equal((await cancel("line_oa")).cancelled, true);
  assert.equal(line.controller.signal.aborted, true);
  assert.equal(shopee.controller.signal.aborted, false);
  assert.equal(calls[0].provider_account_id, "A");
  assert.equal(calls[0].request_id, "run-A");
});

test('BFCache channel closure stays a failure with a short actionable message', async () => {
  const error = new Error('The page keeping the extension port is moved into back/forward cache, so the message channel is closed.');
  const scope = vm.createContext({
    chrome: { tabs: { sendMessage: async () => { throw error; } } },
    performance: { now: () => 0 }, PROVIDER_REQUEST_TIMEOUT_MS: 100,
    setTimeout, clearTimeout, recordLog: async () => {},
  });
  vm.runInContext(source.slice(source.indexOf('function providerMessageTimeout('), source.indexOf('function syncCancelledError(')), scope);
  await assert.rejects(scope.sendProviderMessage(7, { type: 'sync_now_v3' }), failure => {
    assert.equal(failure.message, 'Page changed. Sync again.');
    assert.equal(failure.reason_code, 'provider_page_changed');
    assert.notEqual(failure.name, 'AbortError');
    return true;
  });
});
