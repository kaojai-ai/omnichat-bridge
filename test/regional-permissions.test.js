import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { hasRegionalShopeePermission, regionalShopeeOrigins, regionalShopeeScripts, reconcileRegionalShopeeScripts } from "../extension/lib/regional-permissions.js";

const manifest = JSON.parse(await readFile(new URL("../extension/manifest.json", import.meta.url), "utf8"));
const config = { accounts: [{ provider: "shopee", country: "TH" }, { provider: "line_oa" },
  { provider: "shopee", country: "MY" }, { provider: "shopee", country: "MY" }, { provider: "shopee", country: "PH" }] };
const my = "https://seller.shopee.com.my";
const ph = "https://seller.shopee.ph";

function harness(granted = []) {
  const permissions = new Set(granted.map(origin => `${origin}/*`));
  let scripts = [{ id: "another-feature", matches: ["https://example.test/*"] }];
  const calls = [];
  return { calls, permissions, scripts: () => scripts, api: {
    runtime: { getManifest: () => manifest },
    permissions: { contains: async ({ origins }) => origins.every(origin => permissions.has(origin)) },
    scripting: {
      getRegisteredContentScripts: async () => scripts,
      unregisterContentScripts: async ({ ids }) => { calls.push(["remove", ids]); scripts = scripts.filter(script => !ids.includes(script.id)); },
      registerContentScripts: async values => { calls.push(["add", values]); scripts.push(...values); },
      updateContentScripts: async values => { calls.push(["update", values]); scripts = scripts.map(script => values.find(value => value.id === script.id) ?? script); },
    },
  } };
}

test("only configured regional seller origins need optional approval", async () => {
  assert.deepEqual(regionalShopeeOrigins(config), [my, ph]);
  const h = harness();
  assert.equal(await hasRegionalShopeePermission(h.api, { provider: "shopee", country: "TH" }), true);
  assert.equal(await hasRegionalShopeePermission(h.api, { provider: "line_oa" }), true);
  assert.equal(await hasRegionalShopeePermission(h.api, { provider: "shopee", country: "MY" }), false);
  await reconcileRegionalShopeeScripts(h.api, config);
  assert.equal(h.scripts().length, 1, "declined permissions do not inject scripts");
});

test("granted markets register persistent MAIN and ISOLATED document-start scripts", async () => {
  const h = harness([my]);
  await reconcileRegionalShopeeScripts(h.api, config);
  const scripts = h.scripts().filter(script => script.id.startsWith("omnichat-shopee-region-"));
  assert.equal(scripts.length, 2);
  assert.deepEqual(scripts.map(script => script.world), ["MAIN", "ISOLATED"]);
  for (const script of scripts) {
    assert.deepEqual(script.matches, [`${my}/*`]);
    assert.equal(script.runAt, "document_start");
    assert.equal(script.persistAcrossSessions, true);
    assert.deepEqual(script.js, manifest.content_scripts.find(value => (value.world ?? "ISOLATED") === script.world && value.js.includes("lib/shopee-url.js")).js);
  }
  await reconcileRegionalShopeeScripts(h.api, config);
  assert.equal(h.calls.length, 1, "startup reconciliation does not duplicate registrations");
});

test("concurrent permission and configuration events register scripts only once", async () => {
  const h = harness([my]);
  await Promise.all([reconcileRegionalShopeeScripts(h.api, config), reconcileRegionalShopeeScripts(h.api, config)]);
  assert.equal(h.calls.filter(([type]) => type === "add").length, 1);
});

test("revocation removes only that market while preserving other features and countries", async () => {
  const h = harness([my, ph]);
  await reconcileRegionalShopeeScripts(h.api, config);
  h.permissions.delete(`${my}/*`);
  await reconcileRegionalShopeeScripts(h.api, config);
  assert.deepEqual(h.scripts().map(script => script.id), ["another-feature", ...regionalShopeeScripts(manifest, ph).map(script => script.id)]);
  await reconcileRegionalShopeeScripts(h.api, { accounts: [] });
  assert.deepEqual(h.scripts().map(script => script.id), ["another-feature"]);
});

test("permission button requests immediately from click and does not start declined access", async () => {
  const popup = await readFile(new URL("../extension/popup.js", import.meta.url), "utf8");
  const code = popup.slice(popup.indexOf("async function renderRegionalAccess("), popup.indexOf("const emptyConfig ="));
  const buttons = [];
  let requested = false;
  let sent = 0;
  const container = { replaceChildren() { buttons.length = 0; }, append: value => buttons.push(value) };
  const scope = vm.createContext({ regionalShopeeOrigins, storedConfig: { accounts: [{ provider: "shopee", country: "MY" }] },
    language: "en", t: (_key, country) => `Allow Shopee ${country} access`, consented: () => true, globalThis: { OmnichatShopeeUrl: { countryForUrl: () => "MY" } },
    document: { querySelector: () => container, createElement: () => ({ addEventListener(_event, listener) { this.click = listener; } }) },
    chrome: { permissions: { contains: async () => false, request: () => { requested = true; return Promise.resolve(false); } },
      runtime: { sendMessage: async () => { sent++; } } },
    refreshStoredState: async () => {}, reportPopupError: () => assert.fail("unexpected error"),
  });
  vm.runInContext(code, scope);
  await scope.renderRegionalAccess();
  buttons[0].click();
  assert.equal(requested, true, "no asynchronous work precedes permissions.request");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent, 0);
});

test("revoked regional access cancels existing tab polling and closes only affected account", async () => {
  const background = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");
  const start = background.indexOf("async function refreshRegionalShopeePermissions(");
  const end = background.indexOf("async function reconnectProviderTab(", start);
  const contexts = [
    { key: "my", account: { provider: "shopee", country: "MY", provider_account_id: "my-shop" }, adapter: { id: "shopee" } },
    { key: "th", account: { provider: "shopee", country: "TH", provider_account_id: "th-shop" }, adapter: { id: "shopee" } },
    { key: "line", account: { provider: "line_oa", provider_account_id: "line-shop" }, adapter: { id: "line_oa" } },
  ];
  const reset = [], closed = [], cancelled = [], states = [], messages = [];
  const api = { permissions: { contains: async () => false }, tabs: { sendMessage: async (id, message) => messages.push({ id, message }) } };
  const scope = vm.createContext({ chrome: api, hasRegionalShopeePermission,
    STORAGE: {}, readStorage: async () => ({}), configuredAccountContexts: () => contexts,
    reconcileRegionalShopeeScripts: async () => {},
    readAccountState: () => null, providerRecoveryRecord: () => null, providerRecoveryKey: () => "shopee:MY",
    providerPolicyTabIds: new Map([["my", 42], ["th", 43]]), activeSyncControl: { accountKey: "my", tabId: 42 },
    providerAutomaticRecoveries: new Map(), cancelActiveSync: async (_provider, tabId) => cancelled.push(tabId),
    sessionEligibility: { reset: key => reset.push(key) }, liveConnections: new Map(contexts.map(context => [context.key, {}])),
    stopAccountLiveConnection: key => closed.push(key), updateLiveState: async context => states.push(context.key),
    reattachOpenProviderBridges: async () => {},
  });
  vm.runInContext(background.slice(start, end), scope);
  await scope.refreshRegionalShopeePermissions();
  assert.deepEqual(reset, ["my"]);
  assert.deepEqual(closed, ["my"]);
  assert.deepEqual(cancelled, [42]);
  assert.deepEqual(states, ["my"]);
  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{ id: 42, message: { type: "cancel_sync_v3", provider: "shopee", provider_account_id: "my-shop" } }]);
});

test("previously injected regional content cannot queue or forward after revocation", async () => {
  const source = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");
  const queue = source.slice(source.indexOf("async function queueMessagesForContext("), source.indexOf("  const startedAt = performance.now();", source.indexOf("async function queueMessagesForContext(")));
  const flush = source.slice(source.indexOf("async function flushBatch("), source.indexOf('  await recordLog("debug", "delivery", "batch_preparing"', source.indexOf("async function flushBatch(")));
  const scope = vm.createContext({ hasRegionalShopeePermission, chrome: { permissions: { contains: async () => false } },
    readStorage: async () => ({}), STORAGE: {}, readAccountState: () => [{}], hasLocalConsent: () => true,
  });
  vm.runInContext(`${queue}return "accepted"; }\n${flush}return { sent: 1 }; }`, scope);
  const regional = { account: { provider: "shopee", country: "MY" } };
  await assert.rejects(scope.queueMessagesForContext([], regional), /country access is required/);
  assert.equal((await scope.flushBatch(regional)).blocked, true);
  assert.equal(await scope.queueMessagesForContext([], { account: { provider: "shopee", country: "TH" } }), "accepted");
  assert.equal((await scope.flushBatch({ account: { provider: "line_oa" } })).sent, 1);
});
