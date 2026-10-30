import { createSessionEligibility } from "../extension/lib/session-eligibility.js";
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

function harness({ provider = "line_oa", recoveryEnabled = false, tabOpen = true, healthy = true, record = null, consent = true, chatOpen = null, alternativeHealthyTab = false, redirected = false, accounts = ["account"], pollingAccounts = accounts, activeShop = accounts[0], missingBridge = false } = {}) {
  const adapter = { id: provider, matchesUrl: () => !redirected,
    surfaceForUrl: url => url.includes("/new-webchat") ? "new-webchat" : "seller-centre" };
  const contexts = accounts.map(id => ({ key: `${provider}:${id}`, adapter, account: { provider_account_id: id } }));
  const primaryUrl = "https://seller.shopee.co.th/new-webchat/conversations";
  const tab = { id: 42, url: provider === "shopee" ? (chatOpen === null ? primaryUrl : "https://seller.shopee.co.th/portal") : "https://provider.example/chat", status: "complete" };
  const alternative = { ...tab, id: 43, url: primaryUrl };
  const calls = { created: 0, reloaded: 0, checked: 0, cleared: 0, polling: [], alarm: null, live: null, lives: {} };
  const stored = { config: {}, consent, serverInitialized: true, unattendedRecovery: recoveryEnabled };
  const globals = {
    sessionEligibility: createSessionEligibility({ setTimer: () => 1, clearTimer: () => {} }),
    STORAGE: { config: "config", consent: "consent", serverInitialized: "serverInitialized", unattendedRecovery: "unattendedRecovery" },
    readStorage: async () => stored,
    configuredAccountContexts: () => contexts,
    lineSessionContexts: async (items) => items,
    providerAutomaticRecoveries: new Map(),
    hasServerInitialized: () => true,
    hasLocalConsent: (value) => value === true,
    providerAdapters: { list: () => [adapter] },
    providerRecoveryContexts: (contexts) => contexts,
    providerRecoveryRecord: () => record,
    providerChatTabs: async () => tabOpen && !redirected ? [tab, ...(alternativeHealthyTab ? [alternative] : [])] : [],
    getTab: async (id) => tabOpen && id === tab.id ? tab : null,
    orderProviderTabs: (_adapter, tabs) => tabs,
    providerTabStatus: async (candidate) => { calls.checked++; if (missingBridge) return null; if (candidate?.id === alternative.id) return { healthy: true, current_provider_account_id: activeShop, surface: "new-webchat", chat_open: true }; return { healthy, provider_polling_active: pollingAccounts.length > 0, provider_polling_account_ids: pollingAccounts, current_provider_account_id: activeShop, ...(chatOpen === null ? {} : { surface: "seller-centre", chat_open: chatOpen }) }; },
    providerTabHealthy: (status) => status.healthy,
    reconnectProviderTab: async () => { missingBridge = false; },
    persistProviderSurfaceState: async () => {},
    updateProviderRecoveryLiveState: async (contexts, _adapter, state) => {
      calls.live = state;
      for (const context of contexts) calls.lives[context.account.provider_account_id] = state;
    },
    updateProviderRecoveryTabState: async (_provider, patch) => (record = { ...record, ...patch }),
    clearProviderRecoveryLiveState: async () => { calls.cleared++; },
    ensureProviderHealthAlarm: async (enabled) => { calls.alarm = enabled; },
    PROVIDER_RECOVERY_STATES,
    recoveryRetryDue: (value) => !value?.next_retry_at || value.next_retry_at <= Date.now(),
    recoveryRetryDelay: () => 60_000,
    providerRecoveryFailureReason: () => "Provider unavailable",
    providerRecoveryUrl: () => provider === "shopee" ? primaryUrl : tab.url,
    providerLabel: () => provider,
    recordLog: async () => {},
    recordUnexpected: async () => {},
    startUnattendedProviderSync: (_tab, context) => { calls.polling.push(context.account.provider_account_id); },
    exclusive: async (operation) => operation(),
    attemptAllDeliveries: async () => {},
    apiPingContexts: () => [],
    ensureApiPingAlarm: async () => {},
    liveCommandContexts: () => [],
    activeLiveCommandContexts: async (items) => {
      if (provider !== "shopee") return items;
      if (missingBridge) return [];
      for (const item of items) {
        if (item.account.provider_account_id !== activeShop) calls.lives[item.account.provider_account_id] = { state: null };
      }
      return items.filter((item) => item.account.provider_account_id === activeShop);
    },
    liveConnections: new Map(),
    ensureAccountLiveConnection: async () => {},
    stopAccountLiveConnection: () => {},
    stopLiveConnection: () => {},
    chrome: { tabs: {
      query: async () => tabOpen ? [tab] : [],
      create: async () => { calls.created++; tabOpen = true; return tab; },
      reload: async () => { calls.reloaded++; },
    } },
  };
  const runtime = vm.createContext({ recoveryTemplateReloads: new Map(), activeProviderSendAccounts: new Set(), ...globals });
  vm.runInContext(source.slice(source.indexOf("function providerRecoveryKey("), source.indexOf("function providerRecoveryUrl(")), runtime);
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
    assert.equal(providerConnectionStatus({ socket: "connected", provider_recovery_state: calls.live.state }).label, "Ready");
    assert.equal(calls.alarm, true);
    assert.equal(calls.cleared, 0);
    assert.equal(calls.created, 0);
    assert.equal(calls.reloaded, 0);
    assert.equal(calls.polling.length, 0);
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
  test(`automatic recovery ${recoveryEnabled} never reloads a repeatedly unhealthy tab`, async () => {
    const { run, calls } = harness({ recoveryEnabled, healthy: false, record: { tab_id: 42, failure_count: 2 } });
    for (let tick = 0; tick < 10; tick++) await run();
    assert.ok(calls.checked >= 10);
    assert.equal(calls.live.state, "needs_attention");
    assert.equal(calls.reloaded, 0);
    assert.equal(calls.created, 0);
  });
}

test("turning recovery off still checks a recovered tab during an old retry backoff", async () => {
  const { run, calls } = harness({ record: { tab_id: 42, state: "needs_attention", next_retry_at: Date.now() + 60_000 } });
  await run();
  assert.equal(calls.live.state, "ready");
  assert.ok(calls.checked > 0);
});

test("automatic recovery opens one missing provider tab and reuses its replacement", async () => {
  const { run, calls } = harness({ recoveryEnabled: true, tabOpen: false });
  for (let tick = 0; tick < 4; tick++) await run();
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

test("closed Shopee mini-chat waits for user action when recovery is disabled", async () => {
  const { run, calls } = harness({ provider: "shopee", recoveryEnabled: false, healthy: false, chatOpen: false,
    record: { tab_id: 42, state: "needs_attention", failure_count: 3, next_retry_at: Date.now() + 60_000 } });
  await run();
  assert.equal(calls.reloaded, 0);
  assert.equal(calls.created, 0);
  assert.match(calls.live.reason, /Open Shopee mini-chat/);
  assert.equal(calls.live.state, PROVIDER_RECOVERY_STATES.needsAttention);
});

for (const provider of ["shopee", "line_oa"]) {
  test(`${provider}: a healthy tab clears old backoff with automatic recovery enabled`, async () => {
    const { run, calls } = harness({ provider, recoveryEnabled: true, healthy: true,
      record: { tab_id: 42, state: "needs_attention", failure_count: 8, next_retry_at: Date.now() + 30 * 60_000 } });
    await run();
    assert.equal(calls.live.state, "ready");
    assert.equal(calls.reloaded, 0);
  });
  test(`${provider}: unhealthy tabs are probed but not reloaded during backoff`, async () => {
    const { run, calls } = harness({ provider, recoveryEnabled: true, healthy: false,
      record: { tab_id: 42, state: "needs_attention", failure_count: 8, next_retry_at: Date.now() + 30 * 60_000 } });
    await run();
    assert.ok(calls.checked > 0);
    assert.equal(calls.reloaded, 0);
  });
}


for (const recoveryEnabled of [false, true]) {
  test(`Shopee adopts an existing healthy matching tab over a tracked closed mini-chat (recovery ${recoveryEnabled})`, async () => {
    const { run, calls } = harness({ provider: "shopee", recoveryEnabled, healthy: false, chatOpen: false,
      alternativeHealthyTab: true, record: { tab_id: 42, state: "needs_attention" } });
    await run();
    assert.equal(calls.live.state, "ready");
    assert.equal(calls.live.tabId, 43);
    assert.equal(calls.live.reason, null);
    assert.equal(calls.reloaded, 0);
    assert.equal(calls.created, 0);
  });
}

test("fresh matching provider health clears stale attention without hiding unhealthy or mismatched tabs", async () => {
  let patch;
  const runtime = vm.createContext({ recoveryTemplateReloads: new Map(), activeProviderSendAccounts: new Set(),
    PROVIDER_RECOVERY_STATES,
    updateLiveState: async (_context, value) => { patch = value; },
    providerTabCanSend: (status) => status.matches === true,
    providerTabHealthy: (status) => status.healthy === true,
  });
  vm.runInContext(functionSource("persistProviderSurfaceState", "async function getAccountScanState("), runtime);
  for (const [healthy, matches] of [[false, true], [true, false], [true, true]]) {
    await runtime.persistProviderSurfaceState({}, {}, { surface: "seller-centre", healthy, matches }, { id: 43 });
    if (healthy && matches) {
      assert.equal(patch.provider_recovery_state, "ready");
      assert.equal(patch.provider_recovery_reason, null);
      assert.equal(patch.provider_recovery_tab_id, 43);
    } else {
      assert.equal(Object.hasOwn(patch, "provider_recovery_state"), false);
    }
  }
});

for (const provider of ["shopee", "line_oa"]) {
  test(`${provider}: repeated signed-out checks retain the existing login tab`, async () => {
    const { run, calls } = harness({ provider, recoveryEnabled: true, redirected: true,
      healthy: false, record: { tab_id: 42, opened_by_extension: true } });
    for (let tick = 0; tick < 4; tick++) await run();
    assert.equal(calls.created, 0);
    assert.equal(calls.reloaded, 0);
    assert.equal(calls.live.tabId, 42);
    assert.equal(calls.live.state, "needs_attention");
    assert.match(calls.live.reason, /sign in using the existing tab/);
  });
}

test("Shopee: a tracked same-origin sign-in page does not open another chat", async () => {
  const { run, calls } = harness({ provider: "shopee", recoveryEnabled: true,
    healthy: false, chatOpen: false, record: { tab_id: 42 } });
  for (let tick = 0; tick < 4; tick++) await run();
  assert.equal(calls.created, 0);
  assert.equal(calls.reloaded, 0);
  assert.equal(calls.live.tabId, 42);
});


test("LINE watchdog restores every missing OA without marking them ready from another account's polling", async () => {
  const { run, calls } = harness({ recoveryEnabled: true,
    accounts: ["oa-a", "oa-b", "oa-c"], pollingAccounts: ["oa-a"] });
  await run();
  assert.deepEqual(calls.polling, ["oa-b", "oa-c"]);
  assert.equal(calls.lives["oa-a"].state, "ready");
  assert.equal(calls.lives["oa-b"].state, "needs_attention");
  assert.equal(calls.lives["oa-c"].state, "needs_attention");
});

test("LINE watchdog leaves missing OA polling stopped when automatic recovery is disabled", async () => {
  const { run, calls } = harness({ accounts: ["oa-a", "oa-b"], pollingAccounts: ["oa-a"] });
  await run();
  assert.equal(calls.polling.length, 0);
  assert.equal(calls.lives["oa-a"].state, "ready");
  assert.equal(calls.lives["oa-b"].state, "needs_attention");
});

for (const restorePolling of [false, true]) {
  test(`recent successful sync ${restorePolling ? "still restores missing polling" : "keeps normal automatic cooldown"}`, async () => {
    const context = { key: "line_oa:oa-a", account: { provider: "line_oa", provider_account_id: "oa-a" }, adapter: { id: "line_oa" } };
    const control = { controller: new AbortController(), restorePolling };
    const state = { in_progress: false, last_auto_at: new Date().toISOString() };
    let recoveries = 0;
    const runtime = vm.createContext({ STORAGE: { status: "status", scanState: "scan" }, RESUME_SYNC_COOLDOWN_MS: 60_000,
      exclusive: async operation => operation(), throwIfSyncCancelled: () => {},
      getAccountScanState: async () => ({ state, stored: {} }),
      readAccountState: (_stored, _key, fallback) => fallback,
      writeAccountScanState: async (_context, patch) => Object.assign(state, patch),
      updateScopedState: async () => {}, recordLog: async () => {},
      attemptDelivery: async () => ({ sent: 0, pending: 0 }),
      providerLabel: () => "LINE OA", liveConnections: new Map(),
      syncOpenProvider: async () => { recoveries++; return { recovered: 0 }; },
    });
    vm.runInContext(functionSource("runAccountSync", "async function openSessionSyncContexts("), runtime);
    const result = await runtime.runAccountSync("automatic", control, context);
    assert.equal(recoveries, restorePolling ? 1 : 0);
    assert.equal(result.skipped, restorePolling ? undefined : "cooldown");
    assert.equal(state.in_progress, false);
  });
}

test("unattended failure clears in-progress scan state instead of treating its own control as superseded", async () => {
  const context = { key: "line_oa:oa-a", account: { provider: "line_oa", provider_account_id: "oa-a" }, adapter: { id: "line_oa" } };
  const control = { accountKey: context.key, controller: new AbortController(), restorePolling: true };
  const state = {};
  let status;
  const runtime = vm.createContext({ activeSyncControl: null, providerAutomaticRecoveries: new Map([[context.key, control]]),
    STORAGE: { status: "status", scanState: "scan" }, RESUME_SYNC_COOLDOWN_MS: 60_000,
    exclusive: async operation => operation(), throwIfSyncCancelled: () => {},
    getAccountScanState: async () => ({ state, stored: {} }),
    readAccountState: (stored, key, fallback) => stored?.[key] ?? fallback,
    writeAccountScanState: async (_context, patch) => Object.assign(state, patch),
    updateScopedState: async (_key, _context, patch) => { status = patch; },
    recordLog: async () => {}, recordUnexpected: async () => {},
    readStorage: async () => ({ scan: { [context.key]: state } }), providerLabel: () => "LINE OA",
    attemptDelivery: async () => ({ sent: 0, pending: 0 }),
    syncOpenProvider: async () => { throw new Error("Provider unavailable"); },
  });
  const helpers = source.slice(source.indexOf("function isCurrentSyncControl("), source.indexOf("async function initializeAndStartSync("));
  vm.runInContext(helpers + functionSource("runAccountSync", "async function openSessionSyncContexts("), runtime);
  const result = await runtime.runAccountSync("automatic", control, context);
  assert.match(result.error, /Provider unavailable/);
  assert.equal(state.in_progress, false);
  assert.equal(status.state, "error");
});


test("Shopee recovery follows the active second shop without marking inactive shops ready or failed", async () => {
  for (const healthy of [true, false]) {
    const { run, calls } = harness({ provider: "shopee", accounts: ["a", "b"], activeShop: "b", healthy });
    await run();
    assert.equal(calls.lives.a.state, null);
    assert.equal(calls.lives.b.state, healthy ? "ready" : "needs_attention");
  }
});

test("unverified Shopee session pauses all shops without reloading or opening a tab", async () => {
  const { run, calls } = harness({ provider: "shopee", accounts: ["a", "b"], activeShop: null, recoveryEnabled: true });
  await run();
  assert.equal(calls.lives.a.state, null);
  assert.equal(calls.lives.b.state, null);
  assert.equal(calls.created, 0);
  assert.equal(calls.reloaded, 0);
});


test("Shopee unattended recovery may restore a missing tab without advertising an unverified shop", async () => {
  const { run, calls } = harness({ provider: "shopee", accounts: ["a", "b"], activeShop: null, tabOpen: false, recoveryEnabled: true });
  await run();
  assert.equal(calls.created, 1);
  assert.equal(calls.lives.a.state, null);
  assert.equal(calls.lives.b.state, null);
});


test("Shopee repairs a missing bridge before selecting its active shop", async () => {
  const { run, calls } = harness({ provider: "shopee", accounts: ["a", "b"], activeShop: "b", missingBridge: true });
  await run();
  assert.equal(calls.lives.a.state, null);
  assert.equal(calls.lives.b.state, "ready");
  assert.equal(calls.created, 0);
});
