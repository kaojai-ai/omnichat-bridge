import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { PROVIDER_RECOVERY_STATES } from "../extension/lib/provider-recovery.js";
import { providerConnectionStatus } from "../extension/lib/popup-status.js";

const source = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");

function functionSource(name, next) {
  const start = source.indexOf(`async function ${name}(`);
  const end = source.indexOf(`\n${next}`, start);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}

function harness({ provider = "line_oa", recoveryEnabled = false, tabOpen = true, healthy = true, record = null, consent = true } = {}) {
  const adapter = { id: provider, matchesUrl: () => true };
  const context = { key: `${provider}:account`, adapter, account: { provider_account_id: "account" } };
  const tab = { id: 42, url: "https://provider.example/chat", status: "complete" };
  const calls = { created: 0, reloaded: 0, checked: 0, cleared: 0, polling: 0, alarm: null, live: null };
  const stored = { config: {}, consent, serverInitialized: true, unattendedRecovery: recoveryEnabled };
  const globals = {
    STORAGE: { config: "config", consent: "consent", serverInitialized: "serverInitialized", unattendedRecovery: "unattendedRecovery" },
    readStorage: async () => stored,
    configuredAccountContexts: () => [context],
    hasServerInitialized: () => true,
    hasLocalConsent: (value) => value === true,
    providerAdapters: { list: () => [adapter] },
    providerRecoveryContexts: (contexts) => contexts,
    providerRecoveryRecord: () => record,
    providerChatTabs: async () => tabOpen ? [tab] : [],
    getTab: async (id) => tabOpen && id === tab.id ? tab : null,
    orderProviderTabs: (_adapter, tabs) => tabs,
    providerTabStatus: async () => { calls.checked++; return { healthy, provider_polling_active: true }; },
    providerTabHealthy: (status) => status.healthy,
    reconnectProviderTab: async () => {},
    updateProviderRecoveryLiveState: async (_contexts, _adapter, state) => { calls.live = state; },
    updateProviderRecoveryTabState: async (_provider, patch) => (record = { ...record, ...patch }),
    clearProviderRecoveryLiveState: async () => { calls.cleared++; },
    ensureProviderHealthAlarm: async (enabled) => { calls.alarm = enabled; },
    PROVIDER_RECOVERY_STATES,
    PROVIDER_RECOVERY_FAILURE_THRESHOLD: 2,
    recoveryRetryDue: (value) => !value?.next_retry_at || value.next_retry_at <= Date.now(),
    recoveryRetryDelay: () => 60_000,
    providerRecoveryFailureReason: () => "Provider unavailable",
    providerRecoveryUrl: () => tab.url,
    providerLabel: () => provider,
    recordLog: async () => {},
    recordUnexpected: async () => {},
    startUnattendedProviderSync: () => { calls.polling++; },
    exclusive: async (operation) => operation(),
    attemptAllDeliveries: async () => {},
    apiPingContexts: () => [],
    ensureApiPingAlarm: async () => {},
    liveCommandContexts: () => [],
    stopLiveConnection: () => {},
    chrome: { tabs: {
      create: async () => { calls.created++; return tab; },
      reload: async () => { calls.reloaded++; },
    } },
  };
  const runtime = vm.createContext(globals);
  vm.runInContext([
    functionSource("resolveProviderRecoveryTab", "function ensureProviderRecoveryTab("),
    functionSource("handleProviderRecoveryFailure", "function startUnattendedProviderSync("),
    functionSource("runProviderHealthWatchdogOnce", "async function runProviderHealthWatchdog("),
    functionSource("ensureLiveConnection", "async function ensureAccountLiveConnection("),
    "const ensureProviderRecoveryTab = resolveProviderRecoveryTab;",
  ].join("\n"), runtime);
  return { calls, run: () => runtime.runProviderHealthWatchdogOnce(), connect: () => runtime.ensureLiveConnection() };
}

for (const provider of ["line_oa", "shopee"]) {
  test(`${provider}: an open healthy tab reports ready with automatic recovery off`, async () => {
    const { run, calls } = harness({ provider });
    await run();
    assert.ok(calls.checked > 0);
    assert.equal(calls.live.state, "ready");
    assert.equal(providerConnectionStatus({ socket: "connected", provider_recovery_state: calls.live.state }).label, "CONNECTED · PROVIDER READY");
    assert.equal(calls.alarm, true);
    assert.equal(calls.cleared, 0);
    assert.equal(calls.created, 0);
    assert.equal(calls.reloaded, 0);
    assert.equal(calls.polling, 0);
  });
}

test("a missing tab requests attention without opening a tab when recovery is off", async () => {
  const { run, calls } = harness({ tabOpen: false });
  await run();
  assert.equal(calls.live.state, "needs_attention");
  assert.match(calls.live.reason, /Open line_oa in Chrome/);
  assert.equal(calls.created, 0);
  assert.equal(calls.reloaded, 0);
});

for (const recoveryEnabled of [false, true]) {
  test(`automatic recovery ${recoveryEnabled ? "reloads" : "does not reload"} a repeatedly unhealthy tab`, async () => {
    const { run, calls } = harness({ recoveryEnabled, healthy: false, record: { tab_id: 42, failure_count: 2 } });
    await run();
    assert.equal(calls.live.state, "needs_attention");
    assert.equal(calls.reloaded, recoveryEnabled ? 1 : 0);
    assert.equal(calls.created, 0);
  });
}

test("turning recovery off still checks a recovered tab during an old retry backoff", async () => {
  const { run, calls } = harness({ record: { tab_id: 42, state: "needs_attention", next_retry_at: Date.now() + 60_000 } });
  await run();
  assert.equal(calls.live.state, "ready");
  assert.ok(calls.checked > 0);
});

test("automatic recovery still opens one missing provider tab", async () => {
  const { run, calls } = harness({ recoveryEnabled: true, tabOpen: false });
  await run();
  assert.equal(calls.created, 1);
  assert.equal(calls.live.state, "ready");
});

test("an unconsented installation does not check provider tabs or schedule health checks", async () => {
  const { run, calls } = harness({ consent: false });
  await run();
  assert.equal(calls.checked, 0);
  assert.equal(calls.alarm, false);
  assert.equal(calls.cleared, 1);
});

test("connecting schedules provider health checks before the first watchdog run with recovery off", async () => {
  const { connect, calls } = harness();
  await connect();
  assert.equal(calls.alarm, true);
  assert.equal(calls.cleared, 0);
});
