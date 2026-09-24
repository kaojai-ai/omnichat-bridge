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
const ready = { ok: true, provider_account_ids: ["shop"], realtime_connected: true };
const canSend = vm.runInNewContext(`(${source.slice(source.indexOf("function providerTabCanSend("), source.indexOf("\nfunction providerTabHealthy(")).trim()})`, {
  providerTabIsReady: (status) => status?.ok === true,
});

test("live presence advertises sends only for a responding tab belonging to this shop", async () => {
  let status = ready;
  let tabs = [{ id: 1 }];
  const snapshot = fn("connectionStatusSnapshot", "\nasync function sendConnectionStatus", {
    STORAGE: {}, readStorage: async () => ({}), chrome: { tabs: { query: async () => tabs }, runtime: { getManifest: () => ({ version: "test" }) } },
    orderProviderTabs: (_adapter, input) => input, providerTabStatus: async () => status,
    providerTabCanSend: canSend, providerTabIsReady: (input) => input?.ok === true,
    persistProviderSurfaceState: async () => {}, detectedAccounts: () => [context.account],
    readAccountState: (_state, _key, fallback) => fallback, normalizeDeviceName: () => "", buildConnectionHealth: (input) => input,
    canonicalProviderAccountId: () => "shop", installationId: async () => "installation", navigator: {},
  });
  assert.deepEqual(Array.from((await snapshot(context)).command_capabilities), ["send_text"]);
  status = { ...ready, provider_account_ids: ["another-shop"] };
  assert.equal((await snapshot(context)).command_capabilities.length, 0);
  status = null;
  assert.equal((await snapshot(context)).command_capabilities.length, 0);
  tabs = [];
  assert.equal((await snapshot(context)).command_capabilities.length, 0);
});

test("every heartbeat schedules leader recovery without requiring a popup", async () => {
  let scheduled = 0;
  let sent = 0;
  const sendStatus = fn("sendConnectionStatus", "\nasync function ensureLiveConnection", {
    connectionStatusSnapshot: async () => ({}), WebSocket: { OPEN: 1 },
    scheduleLeaderStatusRefresh: () => scheduled++,
  });
  const socket = { readyState: 1, send: () => sent++ };
  await sendStatus(socket, context);
  await sendStatus(socket, context);
  assert.equal(sent, 2);
  assert.equal(scheduled, 2);
});

test("an outbound command cannot use a tab for another shop", async () => {
  const commandTab = fn("commandTab", "\nfunction providerAdapterForCommand", {
    STORAGE: {}, providerLabel: () => "Shopee Seller Chat", readStorage: async () => ({}), readAccountState: () => null,
    providerChatTabs: async () => [{ id: 1, url: "https://seller.shopee.co.th/" }], providerRecoveryRecord: () => null,
    getTab: async () => null, orderProviderTabs: (_adapter, tabs) => tabs,
    providerTabCanSend: canSend, providerTabStatus: async () => ({ ...ready, provider_account_ids: ["another-shop"] }),
    recordLog: async () => {}, writeStorage: async () => assert.fail("must not select a mismatched tab"),
  });
  await assert.rejects(() => commandTab(context, { prepareForSend: true }), /not ready for this account/);
});
