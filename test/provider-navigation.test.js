import assert from "node:assert/strict";
import test from "node:test";
import { activateProvider, selectableProviders } from "../extension/lib/provider-navigation.js";

const personal = {
  id: "line_personal", chatUrl: "chrome-extension://own/line-personal.html",
  matchesUrl: (url) => typeof url === "string" && /^chrome-extension:\/\/own\/line-personal\.html(?:\?|$)/.test(url),
  chatUrlForAccount: (account) => `chrome-extension://own/line-personal.html?account=${account?.provider_account_id}`,
};
const shopee = { id: "shopee", chatUrl: "https://seller.shopee.co.th/new-webchat", matchesUrl: (url) => url?.startsWith("https://seller.shopee.co.th/") };
const oa = { id: "line_oa", chatUrl: "https://chat.line.biz/", matchesUrl: (url) => url?.startsWith("https://chat.line.biz/") };
const config = { accounts: [{ provider: "line_personal", provider_account_id: "personal-1" }] };

function browser(tabs = []) {
  const calls = [];
  return { calls, api: {
    tabs: {
      query: async (...args) => { calls.push(["query", ...args]); return tabs; },
      update: async (...args) => { calls.push(["update", ...args]); },
      create: async (value) => { calls.push(["create", value]); return { id: 99, ...value }; },
    },
    windows: { update: async (...args) => { calls.push(["window", ...args]); } },
  } };
}

test("Personal navigation requires configuration while existing providers remain selectable", async () => {
  assert.deepEqual(selectableProviders([shopee, oa, personal], null), [shopee, oa]);
  assert.deepEqual(selectableProviders([shopee, oa, personal], config), [shopee, oa, personal]);
  const h = browser();
  await assert.rejects(activateProvider(personal, null, h.api), /not configured/);
  await assert.rejects(activateProvider(null, config, h.api), /not configured/);
  assert.deepEqual(h.calls, []);
});

test("existing active provider tab is focused instead of opening a duplicate", async () => {
  const active = { id: 1, windowId: 10, active: true, lastAccessed: 100, url: personal.chatUrl };
  const h = browser([
    { id: 2, windowId: 20, active: false, lastAccessed: 200, url: personal.chatUrl },
    { id: 3, active: true, lastAccessed: 300, url: "chrome-extension://different/line-personal.html" },
    active,
  ]);
  assert.equal(await activateProvider(personal, config, h.api), active);
  assert.deepEqual(h.calls, [["query", {}], ["update", 1, { active: true }], ["window", 10, { focused: true }]]);
});

test("most recently accessed matching background tab wins when none is active", async () => {
  const latest = { id: 2, active: false, lastAccessed: 20, url: oa.chatUrl };
  const h = browser([{ id: 1, active: false, lastAccessed: 10, url: oa.chatUrl }, latest]);
  assert.equal(await activateProvider(oa, null, h.api), latest);
  assert.deepEqual(h.calls, [["query", {}], ["update", 2, { active: true }]]);
});

test("a missing Personal tab opens the configured account URL exactly once", async () => {
  const h = browser([{ id: 1, active: true, url: "https://example.test/" }]);
  const created = await activateProvider(personal, config, h.api);
  assert.equal(created.id, 99);
  assert.deepEqual(h.calls, [["query", {}], ["create", { url: `${personal.chatUrl}?account=personal-1`, active: true }]]);
});

test("lookup and activation failures never cause duplicate tab creation", async () => {
  const lookup = browser();
  lookup.api.tabs.query = async () => { throw new Error("browser unavailable"); };
  await assert.rejects(activateProvider(personal, config, lookup.api), /browser unavailable/);
  assert.deepEqual(lookup.calls, []);
  const activation = browser([{ id: 1, active: true, url: personal.chatUrl }]);
  activation.api.tabs.update = async () => { throw new Error("tab disappeared"); };
  await assert.rejects(activateProvider(personal, config, activation.api), /tab disappeared/);
  assert.deepEqual(activation.calls, [["query", {}]]);
});

test("existing website providers keep their default URL when creating a tab", async () => {
  const h = browser();
  await activateProvider(shopee, null, h.api);
  assert.deepEqual(h.calls, [["query", {}], ["create", { url: shopee.chatUrl, active: true }]]);
});
