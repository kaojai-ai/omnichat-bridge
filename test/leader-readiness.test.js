import { createSessionEligibility } from "../extension/lib/session-eligibility.js";
import { createStatusReporter } from "../extension/lib/status-reporter.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
function fn(name, next, globals) {
  return vm.runInNewContext(`(${source.slice(source.indexOf(`async function ${name}(`), source.indexOf(next)).trim()})`, globals);
}
const context = { key: "shopee:shop", account: { provider: "shopee", provider_account_id: "shop" },
  adapter: { id: "shopee", tabQueryPattern: "https://seller.shopee.co.th/*", matchesUrl: () => true, sendCommands: ["send_text"] } };
const ready = { ok: true, provider_account_ids: ["shop"], current_provider_account_id: "shop", realtime_connected: true };
const canSend = vm.runInNewContext(`(${source.slice(source.indexOf("function providerTabCanSend("), source.indexOf("\nfunction providerTabHealthy(")).trim()})`, {
  providerTabIsReady: (status) => status?.ok === true,
});

test("live presence advertises sends only for a responding tab belonging to this shop", async () => {
  let status = ready;
  let tabs = [{ id: 1 }];
  const snapshot = fn("connectionStatusSnapshot", "\nfunction statusPublishKey", {
    sessionEligibility: createSessionEligibility({ setTimer: () => 1, clearTimer: () => {} }),
    STORAGE: {}, readStorage: async () => ({}), chrome: { tabs: { query: async () => tabs }, runtime: { getManifest: () => ({ version: "test" }), getPlatformInfo: async () => ({ os: "mac" }) } },
    orderProviderTabs: (_adapter, input) => input, providerTabStatus: async () => status,
    providerTabHealthy: (input) => input?.ok === true && input?.realtime_connected === true,
    providerTabCanSend: canSend, providerTabIsReady: (input) => input?.ok === true,
    persistProviderSurfaceState: async () => {}, detectedAccounts: () => [context.account],
    readAccountState: (_state, _key, fallback) => fallback, normalizeDeviceName: () => "", buildConnectionHealth: () => ({ checks: ["provider_tab", "content_bridge", "provider_account", "provider_realtime"].map((key) => ({ key, status: "pass" })) }),
    canonicalProviderAccountId: () => "shop", installationId: async () => "installation", navigator: {},
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
  const commandTab = fn("commandTab", "\nfunction providerAdapterForCommand", {
    STORAGE: {}, providerLabel: () => "Shopee Seller Chat", readStorage: async () => ({}), readAccountState: () => null,
    providerChatTabs: async () => [{ id: 1, url: "https://seller.shopee.co.th/" }], providerRecoveryRecord: () => null,
    getTab: async () => null, orderProviderTabs: (_adapter, tabs) => tabs,
    providerTabHealthy: (input) => input?.ok === true && input?.realtime_connected === true,
    providerTabCanSend: canSend, providerTabStatus: async () => ({ ...ready, provider_account_ids: ["shop", "another-shop"], current_provider_account_id: "another-shop" }),
    recordLog: async () => {}, writeStorage: async () => assert.fail("must not select a mismatched tab"),
  });
  await assert.rejects(() => commandTab(context, { prepareForSend: true }), /not ready for this account/);
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
