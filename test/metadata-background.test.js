import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { mergeDetectedAccounts } from "../extension/lib/storage.js";

const source = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
function section(start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first);
  return source.slice(first, last);
}
const plain = value => JSON.parse(JSON.stringify(value));
const turn = () => new Promise(resolve => setImmediate(resolve));

function harness() {
  let now = 1_000;
  let epoch = 1;
  let tabEpoch = 1;
  let handler;
  let finish;
  const requests = [];
  const writes = [];
  const refreshed = [];
  const enriched = [];
  const state = { config: { events_url: "https://configured.test/events", tenant_id: "tenant-a" }, consent: true,
    detectedAccounts: [{ provider: "shopee", provider_account_id: "shop-a", display_name: "Cached shop" }] };
  const adapter = { id: "shopee", matchesUrl: url => url === "https://seller.test/chat" };
  const tab = { id: 7, url: "https://seller.test/chat" };
  const forbidden = () => { throw new Error("Metadata must not touch readiness or dispatch."); };
  const runtime = vm.createContext({
    Date: { now: () => now }, Map, WeakMap,
    STORAGE: { config: "config", consent: "consent", detectedAccounts: "detectedAccounts" },
    metadataRefreshes: new Map(), metadataScopes: new WeakMap(), metadataEpoch: 0, metadataErasing: false, metadataCacheWarningReported: false, recordLog: async () => {},
    accountKey: (provider, account) => `${provider}:${account}`,
    sha256Hex: async value => value,
    readStorage: async () => structuredClone(state),
    writeStorage: async patch => { writes.push(plain(patch)); Object.assign(state, plain(patch)); },
    hasLocalConsent: value => value === true,
    accountContextFor: (stored, id, provider) => provider === "shopee" && id === "shop-a"
      ? { config: stored.config, account: { provider, provider_account_id: id }, adapter } : null,
    providerAdapterForId: provider => provider === "shopee" ? adapter : null,
    providerSessionEpoch: () => epoch,
    providerTabContext: () => `tab:${tabEpoch}`,
    providerChatTabs: async () => [tab], orderProviderTabs: (_adapter, tabs) => tabs,
    providerTabStatus: async () => ({ current_provider_account_id: "shop-a" }),
    ensureProviderBridge: async () => {},
    sendProviderMessage: async (...args) => { requests.push(args); return new Promise(resolve => { finish = resolve; }); },
    exclusive: callback => callback(), mergeDetectedAccounts,
    customerMetadata: {
      refresh: async (scope, profiles) => { refreshed.push({ scope, profiles: plain(profiles) }); return profiles.length; },
      flush: async () => {},
      enrich: async (scope, message) => { enriched.push({ scope, message: plain(message) }); },
    },
    updateLiveState: forbidden, providerReadiness: forbidden, dispatchCommand: forbidden,
    chrome: { runtime: { onMessage: { addListener: listener => { handler = listener; } } } },
  });
  vm.runInContext(section("function metadataScope(", "const providerAdapters =")
    + section("async function refreshAccountMetadata(", "async function detectOpenProviderAccount(")
    + section("chrome.runtime.onMessage.addListener((message, _sender, respond) => {", '  if (message?.type === "check_extension_update")')
    + "return false; });", runtime);
  function invoke(message, sender = {}) {
    return new Promise(resolve => {
      assert.equal(handler(message, sender, resolve), true);
    });
  }
  return { runtime, state, writes, requests, refreshed, enriched, tab, invoke,
    set now(value) { now = value; },
    changeSession() { epoch += 1; }, changeTab() { tabEpoch += 1; },
    async pending() { while (!finish) await turn(); },
    finish(value = { ok: true, account: { provider_account_id: "shop-a", display_name: "Fresh shop" }, profiles: [
      { conversation_id: "chat-a", id: "buyer-a", provider_account_id: "shop-a", display_name: "Fresh buyer" },
    ] }) { finish(value); },
  };
}
const command = { type: "refresh_metadata", provider: "shopee", provider_account_id: "shop-a" };

test("runtime metadata refresh coalesces one account and overwrites only its metadata", async () => {
  const h = harness();
  const first = h.invoke(command);
  const second = h.invoke(command);
  await h.pending();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0][1].limit, 100);
  assert.equal(h.requests[0][1].deadline_at, 31_000);
  h.finish();
  assert.deepEqual(plain(await first), { ok: true, account_refreshed: true, customer_count: 1, partial: false });
  assert.deepEqual(plain(await second), plain(await first));
  assert.equal(h.refreshed.length, 1);
  assert.equal(h.state.detectedAccounts[0].display_name, "Fresh shop");
  assert.equal(h.runtime.metadataRefreshes.size, 0);
});

for (const [name, change] of [
  ["configuration", h => { h.state.config.tenant_id = "tenant-b"; }],
  ["session", h => h.changeSession()],
  ["erase generation", h => { h.runtime.metadataEpoch += 1; }],
  ["tab generation", h => h.changeTab()],
  ["deadline", h => { h.now = 31_000; }],
  ["consent", h => { h.state.consent = false; }],
]) {
  test(`late refresh after changed ${name} cannot overwrite cached metadata`, async () => {
    const h = harness();
    const result = h.invoke(command);
    await h.pending();
    change(h);
    h.finish();
    assert.equal((await result).ok, false);
    assert.equal(h.writes.length, 0);
    assert.equal(h.refreshed.length, 0);
    assert.equal(h.state.detectedAccounts[0].display_name, "Cached shop");
  });
}

test("manual refresh filters mismatched account and caps customer records at 100", async () => {
  const h = harness();
  const result = h.invoke(command);
  await h.pending();
  h.finish({ ok: true, partial: true, account: { provider_account_id: "other-shop", display_name: "Wrong" },
    profiles: Array.from({ length: 110 }, (_, index) => ({ conversation_id: `chat-${index}`, id: `buyer-${index}`,
      provider_account_id: index === 0 ? "other-shop" : "shop-a", display_name: "Buyer" })) });
  const outcome = await result;
  assert.equal(outcome.ok, true);
  assert.equal(outcome.account_refreshed, false);
  assert.equal(outcome.partial, true);
  assert.equal(outcome.customer_count, 99);
  assert.equal(h.writes.length, 0);
  assert.ok(h.refreshed[0].profiles.every(profile => profile.provider_account_id === "shop-a"));
});

test("failed manual refresh keeps all cached information", async () => {
  const h = harness();
  const result = h.invoke(command);
  await h.pending();
  h.finish({ ok: false, account: { provider_account_id: "shop-a", display_name: "Do not apply" } });
  assert.equal((await result).ok, false);
  assert.equal(h.writes.length, 0);
  assert.equal(h.refreshed.length, 0);
});

test("passive profile caching is account scoped and never changes readiness or dispatches", async () => {
  const h = harness();
  const result = await h.invoke({ type: "cache_profiles", provider: "shopee", profiles: [
    { conversation_id: "chat-a", id: "buyer-a", provider_account_id: "shop-a", display_name: "Buyer" },
    { conversation_id: "chat-b", id: "buyer-b", provider_account_id: "unconfigured-shop", display_name: "Wrong" },
  ] }, { tab: h.tab });
  assert.equal(result.ok, true);
  assert.equal(h.enriched.length, 1);
  assert.equal(h.enriched[0].message.participant.id, "buyer-a");
  assert.equal(h.writes.length, 0);
  assert.equal(h.requests.length, 0);
  assert.equal((await h.invoke({ type: "cache_profiles", provider: "shopee", profiles: [] }, { tab: { url: "https://unrelated.test" } })).ok, false);
});


test("persistence failure reports applied metadata as partial success", async () => {
  const h = harness();
  h.runtime.customerMetadata.flush = async () => { throw new Error("Storage unavailable"); };
  const result = h.invoke(command);
  await h.pending();
  h.finish();
  const outcome = await result;
  assert.equal(outcome.ok, true);
  assert.equal(outcome.partial, true);
  assert.equal(outcome.account_refreshed, true);
  assert.equal(outcome.customer_count, 1);
  assert.equal(h.refreshed.length, 1);
  assert.equal(h.state.detectedAccounts[0].display_name, "Fresh shop");
});

test("erasing local data blocks new refresh and passive cache requests", async () => {
  const h = harness();
  h.runtime.metadataErasing = true;
  assert.equal((await h.invoke(command)).ok, false);
  const result = await h.invoke({ type: "cache_profiles", provider: "shopee", profiles: [
    { conversation_id: "chat-a", id: "buyer-a", provider_account_id: "shop-a", display_name: "Buyer" },
  ] }, { tab: h.tab });
  assert.equal(result.ok, false);
  assert.equal(h.requests.length, 0);
  assert.equal(h.refreshed.length, 0);
  assert.equal(h.enriched.length, 0);
  assert.equal(h.writes.length, 0);
});
