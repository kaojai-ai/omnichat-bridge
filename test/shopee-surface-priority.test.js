import { installProviderPolicy } from "./helpers/provider-policy.js";
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");
const extract = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const adapter = {
  id: "shopee", sendCommands: ["send_text"], surfacePriority: ["new-webchat", "webchat", "seller-centre"],
  surfaceForUrl: url => url.includes("/new-webchat") ? "new-webchat" : url.includes("/webchat/") ? "webchat" : "seller-centre",
  matchesUrl: url => url.startsWith("https://seller.shopee.co.th/"),
};
const mini = { id: 1, url: "https://seller.shopee.co.th/portal", active: true };
const primary = { id: 2, url: "https://seller.shopee.co.th/new-webchat/conversations", active: false };
function sandbox(tabs, statuses) {
  const created = [];
  let record = { tab_id: mini.id, state: "ready", opened_by_extension: false };
  const context = vm.createContext({ recoveryTemplateReloads: new Map(), activeProviderSendAccounts: new Set(),
    STORAGE: { providerRecoveryTabs: "recovery" },
    PROVIDER_RECOVERY_STATES: { ready: "ready", needsAttention: "needs_attention", opening: "opening" },
    Date, Number, Map,
    readStorage: async () => ({ recovery: record }), providerRecoveryRecord: () => record,
    getTab: async id => tabs.find(tab => tab.id === id), providerChatTabs: async () => tabs,
    providerTabStatus: async tab => statuses[tab.id], providerTabHealthy: status => status?.ready === true,
    updateProviderRecoveryTabState: async (_, patch) => (record = { ...record, ...patch }),
    recoveryRetryDue: () => true, providerRecoveryUrl: () => primary.url,
    chrome: { tabs: { query: async () => tabs, create: async options => { created.push(options); return { ...options, id: 3 }; } } },
    recordLog: async () => {}, providerLabel: () => "Shopee",
  });
  installProviderPolicy(context);
  vm.runInContext(extract("function orderProviderTabs(", "async function providerTabStatus(")
    + extract("async function resolveProviderRecoveryTab(", "function ensureProviderRecoveryTab("), context);
  return { context, created };
}
const shop = { account: { provider_account_id: "shop" } };
const healthy = { ready: true, current_provider_account_id: "shop" };

test("recovery keeps the tracked mini-chat even when a preferred primary exists", async () => {
  const { context } = sandbox([mini, primary], { 1: healthy, 2: { ...healthy, ready: false } });
  assert.equal(context.orderProviderTabs(adapter, [mini, primary], 1)[0].id, 2);
  assert.equal((await context.resolveProviderRecoveryTab(adapter, shop, true)).tab.id, mini.id);
});

test("both recovery settings reuse mini-chat instead of opening a missing primary", async () => {
  const enabled = sandbox([mini], { 1: healthy });
  assert.equal((await enabled.context.resolveProviderRecoveryTab(adapter, shop, true)).tab.id, mini.id);
  assert.equal(enabled.created.length, 0);
  const disabled = sandbox([mini], { 1: healthy });
  assert.equal((await disabled.context.resolveProviderRecoveryTab(adapter, shop, false)).tab.id, 1);
  assert.equal(disabled.created.length, 0);
});

test("wrong-shop primary is not selected as healthy recovery target", async () => {
  const { context } = sandbox([mini, primary], { 1: healthy, 2: { ready: true, current_provider_account_id: "other" } });
  assert.equal((await context.resolveProviderRecoveryTab(adapter, shop, false)).tab.id, 1);
});

function commandHarness({ primaryReady = true, miniShop = "shop" } = {}) {
  let miniReady = false;
  const preparations = [];
  const commandContext = { key: "shopee:shop", adapter, account: { provider_account_id: "shop" } };
  const status = tab => ({ ready: tab.id === primary.id ? primaryReady : miniReady,
    current_provider_account_id: tab.id === primary.id ? "shop" : miniShop });
  const context = vm.createContext({ withRequestTimeout: async operation => operation(),
    STORAGE: { commandTab: "command", providerRecoveryTabs: "recovery" },
    readStorage: async () => ({}), readAccountState: () => mini.id,
    providerRecoveryRecord: () => ({ tab_id: mini.id }), getTab: async () => mini,
    providerChatTabs: async () => [mini, primary], providerLabel: () => "Shopee",
    providerTabStatus: async tab => status(tab),
    providerTabCanSend: (state, command) => state.ready && state.current_provider_account_id === command.account.provider_account_id,
    prepareProviderTab: async tab => { preparations.push(tab.id); miniReady = true; },
    rememberCommandTab: async () => {}, recordLog: async () => {},
  });
  installProviderPolicy(context);
  vm.runInContext(extract("function orderProviderTabs(", "async function providerTabStatus(")
    + extract("async function sendReadiness(", "function providerAdapterForCommand("), context);
  return { preparations, run: () => context.commandTab(commandContext, { prepareForSend: true }) };
}

test("ready New Webchat sends without initializing closed mini-chat first", async () => {
  const h = commandHarness();
  assert.equal((await h.run()).id, primary.id);
  assert.deepEqual(h.preparations, []);
});

test("confirmed unready surfaces fail immediately without preparing or retrying a send", async () => {
  const fallback = commandHarness({ primaryReady: false });
  await assert.rejects(fallback.run(), /not ready for this account/);
  assert.deepEqual(fallback.preparations, []);
  const wrongShop = commandHarness({ primaryReady: false, miniShop: "other-shop" });
  await assert.rejects(wrongShop.run(), /not ready for this account/);
  assert.deepEqual(wrongShop.preparations, []);
});

test("recovery off uses healthy mini-chat while primary is initializing", async () => {
  const { context, created } = sandbox([mini, primary], { 1: healthy, 2: { ...healthy, ready: false } });
  const selected = await context.resolveProviderRecoveryTab(adapter, shop, false);
  assert.equal(selected.tab.id, mini.id);
  assert.equal(selected.record.state, "ready");
  assert.equal(created.length, 0);
});

const redirected = { id: 2, url: "https://seller.shopee.co.th/webchat/conversations", active: false };

test("repeated recovery accepts a tracked redirected Webchat without opening replacement tabs", async () => {
  const h = sandbox([redirected], { 2: { ...healthy, ready: false } });
  for (let i = 0; i < 3; i++) {
    assert.equal((await h.context.resolveProviderRecoveryTab(adapter, shop, true)).tab.id, redirected.id);
  }
  assert.equal(h.created.length, 0);
});

test("healthy New Webchat wins over redirected Webchat; healthy Webchat covers primary initialization", async () => {
  const legacy = { ...redirected, id: 4, active: true };
  const h = sandbox([legacy, primary], { 2: healthy, 4: healthy });
  assert.equal((await h.context.resolveProviderRecoveryTab(adapter, shop, true)).tab.id, primary.id);
  const initializing = sandbox([legacy, primary], { 2: { ...healthy, ready: false }, 4: healthy });
  assert.equal((await initializing.context.resolveProviderRecoveryTab(adapter, shop, true)).tab.id, legacy.id);
  assert.equal(initializing.created.length, 0);
});

test("wrong-shop redirected Webchat cannot recover a different account or spawn duplicate tabs", async () => {
  const h = sandbox([redirected], { 2: { ...healthy, current_provider_account_id: "other" } });
  const result = await h.context.resolveProviderRecoveryTab(adapter, shop, true);
  assert.equal(result.tab, null);
  assert.match(result.reason, /different shop/);
  assert.equal(h.created.length, 0);
});
