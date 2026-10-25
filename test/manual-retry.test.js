import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";
const source = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test("manual retry replaces a stuck run; late completion cannot clear the replacement", async () => {
  const runs = [];
  const cancellation = deferred();
  const runtime = vm.createContext({ AbortController, PROVIDER_STATUS_RESPONSE_TIMEOUT_MS: 5,
    sendProviderMessage: () => cancellation.promise,
    runUnifiedSync: (_trigger, control) => { const result = deferred(); control.tabId = 42; runs.push({ control, ...result }); return result.promise; },
  });
  vm.runInContext('let activeSync = null, activeSyncControl = null, syncRestart = null;\n' + section('function restartSync(', 'async function cancelActiveSync('), runtime);
  const old = runtime.startSync("automatic");
  const retry = runtime.restartSync();
  const doubleClick = runtime.restartSync();
  assert.equal(runs[0].control.controller.signal.aborted, true);
  cancellation.resolve({ ok: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(runs.length, 2);
  assert.equal(runs[1].control.manualRestart, true);
  runs[0].resolve({ old: true });
  await old;
  const automatic = runtime.startSync("automatic");
  assert.equal(runs.length, 2, "old finalizer must not clear the current attempt");
  runs[1].resolve({ fresh: true });
  assert.deepEqual(await retry, { fresh: true });
  assert.deepEqual(await doubleClick, { fresh: true });
  assert.deepEqual(await automatic, { fresh: true });
});

function messageHarness() {
  let now = 0, nextId = 0;
  const timers = new Map(), calls = [], response = deferred();
  const runtime = vm.createContext({
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
(message, _sender) => { const respond = () => {}; ${section('  if (message?.type === "sync_activity")', '  if (message?.type === "sync_progress")')} }`, {
    activeSyncControl: { controller: new AbortController(), tabId: 42, providerRequestId: "new", touchRecovery: () => touches++ },
    providerAutomaticRecoveries: new Map(),
  });
  handle({ type: "sync_activity", request_id: "old" }, { tab: { id: 42 } });
  handle({ type: "sync_activity", request_id: "new" }, { tab: { id: 99 } });
  assert.equal(touches, 0);
  handle({ type: "sync_activity", request_id: "new" }, { tab: { id: 42 } });
  assert.equal(touches, 1);
});

test("an already-open old content bridge is reattached before the new watchdog is used", async () => {
  let pings = 0, reinjections = 0;
  const ensure = vm.runInNewContext(`(${section('async function ensureProviderBridge(', 'async function prepareProviderTab(')})`, {
    BRIDGE_PROTOCOL_VERSION: 3, BRIDGE_SOURCE: "omnichat-realtime-bridge-v3", PROVIDER_STATUS_RESPONSE_TIMEOUT_MS: 5_000,
    providerLabel: () => "Shopee",
    sendProviderMessage: async () => ({ ok: true, bridge_protocol_version: 3, bridge_source: "omnichat-realtime-bridge-v3", ...(++pings > 1 ? { recovery_watchdog_version: 1 } : {}) }),
    reinjectProviderBridge: async () => { reinjections++; return true; },
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
  const runtime = vm.createContext({ activeSyncControl: null,
    providerAutomaticRecoveries: new Map(controls.map(control => [control.accountKey, control])) });
  vm.runInContext(section('function isCurrentSyncControl(', 'async function initializeAndStartSync(')
    + `
function handle(message, _sender) { const respond = () => {}; ${section('  if (message?.type === "sync_activity")', '  if (message?.type === "sync_progress")')} }`, runtime);
  runtime.handle({ request_id: "oa-a", type: "sync_activity" }, { tab: { id: 42 } });
  runtime.handle({ request_id: "oa-b", type: "sync_activity" }, { tab: { id: 99 } });
  runtime.handle({ request_id: "old", type: "sync_activity" }, { tab: { id: 42 } });
  controls[1].controller.abort();
  runtime.handle({ request_id: "oa-b", type: "sync_activity" }, { tab: { id: 42 } });
  assert.deepEqual(touches, ["oa-a"]);
  assert.equal(runtime.isCurrentSyncControl(controls[0]), true);
  runtime.providerAutomaticRecoveries.delete("oa-a");
  assert.equal(runtime.isCurrentSyncControl(controls[0]), false);
});
