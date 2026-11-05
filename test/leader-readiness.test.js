import { installProviderPolicy } from "./helpers/provider-policy.js";
import { createSessionEligibility } from "../extension/lib/session-eligibility.js";
import { createStatusReporter } from "../extension/lib/status-reporter.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
function fn(name, next, globals) {
  const scope = vm.createContext({ preemptAutomaticLogUpload: () => {}, ...globals });
  installProviderPolicy(scope);
  return vm.runInContext(`(${source.slice(source.indexOf(`async function ${name}(`), source.indexOf(next)).trim()})`, scope);
}
const context = { key: "shopee:shop", account: { provider: "shopee", provider_account_id: "shop" },
  adapter: { id: "shopee", tabQueryPattern: "https://seller.shopee.co.th/*", matchesUrl: () => true, sendCommands: ["send_text"] } };
const ready = { send_verified_at: new Date().toISOString(), ok: true, surface_ready: true, capabilities: { send_text: true, message_recovery: true }, provider_account_ids: ["shop"], current_provider_account_id: "shop", realtime_connected: true };
const canSend = vm.runInNewContext(`(${source.slice(source.indexOf("function providerTabCanSend("), source.indexOf("\nfunction providerTabHealthy(")).trim()})`, { preemptAutomaticLogUpload: () => {},
  providerTabIsReady: (status) => status?.ok === true,
});

test("live presence advertises sends only for a responding tab belonging to this shop", async () => {
  let status = ready;
  let tabs = [{ id: 1 }];
  const snapshot = fn("connectionStatusSnapshot", "\nfunction statusPublishKey", {
    sessionEligibility: createSessionEligibility({ setTimer: () => 1, clearTimer: () => {} }),
    STORAGE: {}, readStorage: async () => ({}), chrome: { tabs: { query: async () => tabs }, runtime: { getManifest: () => ({ version: "test" }), getPlatformInfo: async () => ({ os: "mac" }) } },
    providerChatTabs: async () => tabs, orderProviderTabs: (_adapter, input) => input, providerTabStatus: async () => status,
    providerTabHealthy: (input) => input?.ok === true && input?.realtime_connected === true,
    providerTabCanSend: canSend, providerTabIsReady: (input) => input?.ok === true,
    persistProviderSurfaceState: async () => {}, detectedAccounts: () => [context.account],
    readAccountState: (_state, _key, fallback) => fallback, normalizeDeviceName: () => "", buildConnectionHealth: () => ({ checks: ["provider_tab", "content_bridge", "provider_account", "provider_realtime"].map((key) => ({ key, status: "pass" })) }),
    canonicalProviderAccountId: () => "shop", installationId: async () => "installation", navigator: {}, PROVIDER_HEALTH_STALE_MS: 60_000,
  });
  assert.deepEqual(Array.from((await snapshot(context)).command_capabilities), ["send_text"]);
  status = { ...ready, provider_account_ids: ["shop", "another-shop"], current_provider_account_id: "another-shop" };
  assert.equal((await snapshot(context)).command_capabilities.length, 0);
  status = null;
  assert.equal((await snapshot(context)).command_capabilities.length, 0);
  tabs = [];
  assert.equal((await snapshot(context)).command_capabilities.length, 0);
});

test("unchanged readiness does not add status writes or repeated leader checks", async () => {
  let scheduled = 0;
  let sent = 0;
  const socket = { readyState: 1, send: () => sent++ };
  const connection = { socket };
  const sendStatus = fn("sendConnectionStatus", "\nfunction scheduleKeepalive", {
    connectionStatusSnapshot: async () => ({ ready: true }), WebSocket: { OPEN: 1 },
    liveConnections: new Map([[context.key, connection]]), statusPublishKey: JSON.stringify,
    createStatusReporter: options => createStatusReporter({ ...options, id: () => "report", setTimer: () => 1, clearTimer: () => {} }),
    scheduleLeaderStatusRefresh: () => scheduled++, scheduleKeepalive: () => {}, recordLog: async () => {},
  });
  await sendStatus(socket, context);
  await sendStatus(socket, context);
  assert.equal(sent, 1);
  assert.equal(scheduled, 1);
});

test("an outbound command cannot use a tab for another shop", async () => {
  const selectContext = fn("selectSendContext", "\nasync function commandTab", {
    runProviderHealthWatchdog: async () => {}, recordUnexpected: async () => {},
    STORAGE: {}, providerLabel: () => "Shopee Seller Chat", readStorage: async () => ({}), readAccountState: () => null,
    providerChatTabs: async () => [{ id: 1, url: "https://seller.shopee.co.th/" }], providerRecoveryRecord: () => null,
    getTab: async () => null, orderProviderTabs: (_adapter, tabs) => tabs,
    providerTabHealthy: (input) => input?.ok === true && input?.realtime_connected === true,
    providerTabCanSend: canSend, providerTabStatus: async () => ({ ...ready, provider_account_ids: ["shop", "another-shop"], current_provider_account_id: "another-shop" }),
    recordLog: async () => {}, writeStorage: async () => assert.fail("must not select a mismatched tab"),
  });
  await assert.rejects(() => selectContext(context), /readiness is unavailable or stale/);
});

test("a delayed persisted readiness ACK refreshes real leader status, with stale socket/report fencing", async () => {
  const currentSocket = { readyState: 1 }, oldSocket = { readyState: 1 };
  const sent = [], scheduled = [];
  const reporter = createStatusReporter({ send: report => sent.push(report), id: () => "report-current",
    setTimer: () => 1, clearTimer: () => {} });
  reporter.publish({ ready: true }, "ready");
  const handle = fn("handleLiveCommand", "\nchrome.storage.onChanged", {
    liveConnections: new Map([[context.key, { socket: currentSocket, statusReporter: reporter }]]),
    scheduleLeaderStatusRefresh: (account, socket) => scheduled.push({ account, socket }),
  });
  const ack = { type: "connection_status_ack", report_id: sent[0].report_id, sequence: sent[0].sequence, ok: true };
  await handle(JSON.stringify(ack), context, oldSocket);
  await handle(JSON.stringify({ ...ack, report_id: "older-report" }), context, currentSocket);
  await handle(JSON.stringify({ ...ack, ok: false, retryable: true }), context, currentSocket);
  assert.equal(scheduled.length, 0);
  await handle(JSON.stringify(ack), context, currentSocket);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].account, context);
  assert.equal(scheduled[0].socket, currentSocket);
  await handle(JSON.stringify(ack), context, currentSocket);
  assert.equal(scheduled.length, 1, "duplicate ACK must not start another refresh");
});

for (const config of [
  { canonical_provider_account_id: 'channel-1' },
  { api_url: 'https://target.example/api/omnichat/line_oa/tenant/channel-1' },
  {},
]) {
  test(`LINE receive evidence stays browser-scoped while reporting configured identity: ${JSON.stringify(config)}`, async () => {
    const canonicalStart = source.indexOf('function canonicalProviderAccountId(');
    const canonicalEnd = source.indexOf('\nfunction hasServerInitialized', canonicalStart);
    const canonicalProviderAccountId = vm.runInNewContext(`(${source.slice(canonicalStart, canonicalEnd)})`, { URL });
    const lineContext = { key: 'line_oa:@first', account: { provider: 'line_oa', provider_account_id: '@first' },
      adapter: { id: 'line_oa' }, config };
    let polls = { '@first': new Date().toISOString() };
    const snapshot = fn('connectionStatusSnapshot', '\nfunction statusPublishKey', {
      STORAGE: {}, readStorage: async () => ({}), readAccountState: (_state, _key, fallback) => fallback,
      normalizeDeviceName: () => '', buildConnectionHealth: () => ({ reason_code: 'healthy' }),
      persistProviderSurfaceState: async () => {}, installationId: async () => 'installation',
      chrome: { runtime: { getManifest: () => ({ version: 'test' }), getPlatformInfo: async () => ({ os: 'mac' }) } },
      PROVIDER_HEALTH_STALE_MS: 60_000, canonicalProviderAccountId,
      providerTabStatus: async () => ({ ok: true, account_access_verified: true,
        accessible_account_ids: ['@first', '@second'], realtime_connected: true,
        command_capabilities_by_account: { '@first': ['send_text'] }, last_successful_poll_at_by_account: polls }),
    });
    const fresh = await snapshot(lineContext);
    assert.equal(fresh.provider_account_id, config.canonical_provider_account_id || (config.api_url ? 'channel-1' : '@first'));
    assert.equal(fresh.send_ready, true);
    assert.equal(fresh.receive_ready, true);
    assert.equal(fresh.receive_reason_code, 'healthy');

    polls = { '@second': new Date().toISOString(), 'channel-1': new Date().toISOString() };
    assert.equal((await snapshot(lineContext)).receive_ready, false, 'another browser account or server ID cannot supply poll evidence');
    polls = { '@first': new Date(Date.now() - 61_000).toISOString() };
    assert.equal((await snapshot(lineContext)).receive_reason_code, 'inbound_poll_unverified');
  });
}
