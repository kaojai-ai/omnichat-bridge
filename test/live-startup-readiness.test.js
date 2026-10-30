import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");
const start = source.indexOf("async function ensureLiveConnection() {");
const end = source.indexOf("\nasync function ensureAccountLiveConnection", start);
assert.ok(start >= 0 && end > start);

function harness({ initialized = false, pause = false } = {}) {
  const context = { key: "shopee:fixture", account: { provider_account_id: "fixture" } };
  const state = { config: { accounts: [context.account] }, consent: true, initialized, detected: [context.account] };
  const calls = { cleared: 0, stopped: 0, connected: 0, alarms: [] };
  const liveConnections = new Map();
  let readiness = "ready";
  let pauseOnce = pause;
  let release;
  let paused;
  const reachedPause = new Promise((resolve) => { paused = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const ensure = vm.runInNewContext(`(() => { ${source.slice(start, end)}; return ensureLiveConnection; })()`, {
    STORAGE: { config: "config", consent: "consent", detectedAccounts: "detected", serverInitialized: "initialized", unattendedRecovery: "recovery" },
    readStorage: async () => structuredClone(state),
    configuredAccountContexts: () => [context],
    hasServerInitialized: (stored) => stored.initialized === true,
    hasLocalConsent: (value) => value === true,
    activeLiveCommandContexts: async (contexts) => contexts,
    apiPingContexts: (contexts) => contexts,
    ensureApiPingAlarm: async (enabled) => {
      calls.alarms.push(enabled);
      if (pauseOnce) { pauseOnce = false; paused(); await gate; }
    },
    ensureProviderHealthAlarm: async () => {},
    clearProviderRecoveryLiveState: async () => {
      calls.cleared++; readiness = null;
      calls.stopped++; liveConnections.clear();
      return true;
    },
    ensureApiPings: () => {},
    liveConnections,
    stopLiveConnection: () => { calls.stopped++; liveConnections.clear(); },
    stopAccountLiveConnection: (key) => liveConnections.delete(key),
    ensureAccountLiveConnection: async () => { calls.connected++; },
    recordLog: async () => {},
  });
  return { ensure, state, calls, liveConnections, reachedPause, release, readiness: () => readiness, context };
}

test("a stale startup check cannot clear first Sync readiness or its new socket", async () => {
  const h = harness({ pause: true });
  const startup = h.ensure();
  await h.reachedPause;
  // First Sync enables the bridge while an older disabled reconciliation awaits Chrome alarms.
  h.state.initialized = true;
  const socket = { readyState: 1 };
  h.liveConnections.set(h.context.key, { socket });
  h.release();
  await startup;
  assert.equal(h.calls.cleared, 0);
  assert.equal(h.calls.stopped, 0);
  assert.equal(h.readiness(), "ready");
  assert.equal(h.liveConnections.get(h.context.key).socket, socket);
  assert.equal(h.calls.connected, 1);
  assert.deepEqual(h.calls.alarms, [false, true]);
});

test("a bridge that remains disabled still clears readiness and stops its sockets", async () => {
  const h = harness();
  h.liveConnections.set(h.context.key, { socket: { readyState: 1 } });
  await h.ensure();
  assert.equal(h.calls.cleared, 1);
  assert.equal(h.calls.stopped, 1);
  assert.equal(h.readiness(), null);
  assert.equal(h.liveConnections.size, 0);
  assert.equal(h.calls.connected, 0);
});

test("a stale enabled check cannot reconnect after consent is revoked", async () => {
  const h = harness({ initialized: true, pause: true });
  h.liveConnections.set(h.context.key, { socket: { readyState: 1 } });
  const startup = h.ensure();
  await h.reachedPause;
  h.state.consent = false;
  h.release();
  await startup;
  assert.equal(h.calls.connected, 0);
  assert.equal(h.calls.cleared, 1);
  assert.equal(h.calls.stopped, 1);
  assert.equal(h.liveConnections.size, 0);
  assert.equal(h.readiness(), null);
  assert.deepEqual(h.calls.alarms, [true, false]);
});

test("actual cleanup and first Sync initialization serialize without erasing the new connection", async () => {
  const queue = source.slice(source.indexOf("let liveStateWriteQueue ="), source.indexOf("function updateLiveState("));
  const cleanup = source.slice(source.indexOf("async function clearProviderRecoveryLiveState()"), source.indexOf("async function getTab("));
  const initialize = source.slice(source.indexOf("async function initializeAndStartSync("), source.indexOf("async function startUnattendedSellerCentreSync("));
  const state = { config: {}, initialized: false, consent: true };
  const events = [];
  const liveConnections = new Map();
  let readiness = "ready";
  let pauseRead = true;
  let release;
  let paused;
  const reachedPause = new Promise((resolve) => { paused = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const api = vm.runInNewContext(`(() => { ${queue}\n${cleanup}\n${initialize}; return { clearProviderRecoveryLiveState, initializeAndStartSync }; })()`, {
    STORAGE: { config: "config", detectedAccounts: "detected", consent: "consent", serverInitialized: "initialized", logUploadEnabled: "logs" },
    readStorage: async () => {
      const snapshot = structuredClone(state);
      if (pauseRead) { pauseRead = false; paused(); await gate; }
      return snapshot;
    },
    writeStorage: async (values) => { events.push("initialize"); Object.assign(state, values); },
    configuredAccountContexts: () => [{ key: "shopee:fixture" }],
    hasServerInitialized: (stored) => stored.initialized === true,
    hasLocalConsent: (consent) => consent === true,
    writeLiveState: async (_context, patch) => { events.push("clear"); readiness = patch.provider_recovery_state; },
    stopLiveConnection: () => { events.push("stop"); liveConnections.clear(); },
    recordLog: async () => {}, liveConnections, clearTimeout: () => {},
    ensureLiveConnection: async () => {}, recordUnexpected: async () => {},
    restartSync: async () => { events.push("sync"); readiness = "ready"; liveConnections.set("shopee:fixture", { socket: "new" }); },
    startSync: async () => {},
  });
  const clearing = api.clearProviderRecoveryLiveState();
  await reachedPause;
  const syncing = api.initializeAndStartSync("manual");
  await new Promise(setImmediate);
  assert.equal(state.initialized, false, "initialization must wait until old cleanup finishes");
  release();
  assert.equal(await clearing, true);
  await syncing;
  assert.deepEqual(events, ["clear", "stop", "initialize", "sync"]);
  assert.equal(readiness, "ready");
  assert.equal(liveConnections.get("shopee:fixture").socket, "new");
  assert.equal(await api.clearProviderRecoveryLiveState(), false, "later stale cleanup must observe initialization and decline");
  assert.equal(readiness, "ready");
  assert.equal(events.filter((event) => event === "stop").length, 1);
});
