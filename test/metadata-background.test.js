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

function harness(provider = "shopee") {
  let now = 1_000;
  let epoch = 1;
  let tabEpoch = 1;
  let handler;
  const requests = [];
  const writes = [];
  const refreshed = [];
  const enriched = [];
  const state = { config: { events_url: "https://configured.test/events", tenant_id: "tenant-a" }, consent: true,
    detectedAccounts: [{ provider, provider_account_id: "shop-a", display_name: "Cached shop" }] };
  const adapter = { id: provider, supports: () => true, matchesUrl: url => url === "https://seller.test/chat" };
  const tab = { id: 7, url: "https://seller.test/chat" };
  const forbidden = () => { throw new Error("Metadata must not touch readiness or dispatch."); };
  const runtime = vm.createContext({
    throwIfSyncCancelled: signal => { if (signal?.aborted) throw new Error("Sync cancelled."); },
    Date: { now: () => now }, Map, WeakMap,
    STORAGE: { config: "config", consent: "consent", detectedAccounts: "detectedAccounts" },
    metadataRefreshes: new Map(), metadataScopes: new WeakMap(), metadataEpoch: 0, metadataErasing: false, metadataCacheWarningReported: false, recordLog: async () => {},
    accountKey: (provider, account) => `${provider}:${account}`,
    sha256Hex: async value => value,
    readStorage: async () => structuredClone(state),
    writeStorage: async patch => { writes.push(plain(patch)); Object.assign(state, plain(patch)); },
    hasLocalConsent: value => value === true,
    accountContextFor: (stored, id, requestedProvider) => requestedProvider === provider && id === "shop-a"
      && stored.detectedAccounts.some(account => account.provider === provider && account.provider_account_id === id)
      ? { key: `${provider}:${id}`, config: stored.config, account: { provider, provider_account_id: id }, adapter } : null,
    providerAdapterForId: requestedProvider => requestedProvider === provider ? adapter : null,
    providerSessionEpoch: () => epoch,
    providerTabContext: () => `tab:${tabEpoch}`,
    providerChatTabs: async () => [tab], orderProviderTabs: (_adapter, tabs) => tabs,
    providerTabStatus: async () => ({ current_provider_account_id: "shop-a", accessible_account_ids: ["shop-a"] }),
    ensureProviderBridge: async () => {},
    sendProviderMessage: forbidden,
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
    + section("async function persistAccountMetadata(", "async function detectOpenProviderAccount(")
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

  };
}
const freshMetadata = () => ({ ok: true, account: { provider_account_id: "shop-a", display_name: "Fresh shop" }, profiles: [
  { conversation_id: "chat-a", id: "buyer-a", provider_account_id: "shop-a", display_name: "Fresh buyer" },
] });
function persistence(h) {
  const context = h.runtime.accountContextFor(structuredClone(h.state), "shop-a", "shopee");
  const controller = new AbortController();
  const guard = { startedEpoch: h.runtime.metadataEpoch, epoch: h.runtime.providerSessionEpoch("shopee"),
    tab: h.tab, tabContext: h.runtime.providerTabContext(h.tab, "shopee"), signal: controller.signal };
  return { controller, run: (result = freshMetadata()) => h.runtime.persistAccountMetadata(result, context, guard) };
}

test("scoped metadata persistence applies display information and exposes only counts", async () => {
  const h = harness();
  const result = plain(await persistence(h).run());
  assert.deepEqual(result, { ok: true, account_refreshed: true, customer_count: 1, partial: false });
  assert.equal(h.refreshed.length, 1);
  assert.equal(h.state.detectedAccounts[0].display_name, "Fresh shop");
  assert.equal(h.requests.length, 0, "persistence does not dispatch commands or recheck readiness");
  assert.doesNotMatch(JSON.stringify(result), /Fresh buyer|profiles|Fresh shop/);
});

for (const [name, change] of [
  ["configuration", h => { h.state.config.tenant_id = "tenant-b"; }],
  ["session", h => h.changeSession()],
  ["erase generation", h => { h.runtime.metadataEpoch += 1; }],
  ["tab generation", h => h.changeTab()],
  ["consent", h => { h.state.consent = false; }],
  ["account removal", h => { h.state.detectedAccounts = []; }],
]) {
  test(`scoped persistence rejects changed ${name} before writing any metadata`, async () => {
    const h = harness();
    const operation = persistence(h);
    change(h);
    await assert.rejects(operation.run(), /context changed/);
    assert.equal(h.writes.length, 0);
    assert.equal(h.refreshed.length, 0);
  });
}

test("cancelled persistence does not change display information", async () => {
  const h = harness();
  const operation = persistence(h);
  operation.controller.abort();
  await assert.rejects(operation.run(), /cancelled/);
  assert.equal(h.writes.length, 0);
  assert.equal(h.refreshed.length, 0);
});

test("persistence filters mismatched account and caps returned customer records at 100", async () => {
  const h = harness();
  const outcome = await persistence(h).run({ ok: true, partial: true,
    account: { provider_account_id: "other-shop", display_name: "Wrong" },
    profiles: Array.from({ length: 110 }, (_, index) => ({ conversation_id: `chat-${index}`, id: `buyer-${index}`,
      provider_account_id: index === 0 ? "other-shop" : "shop-a", display_name: "Buyer" })) });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.account_refreshed, false);
  assert.equal(outcome.partial, true);
  assert.equal(outcome.customer_count, 99);
  assert.equal(h.writes.length, 0);
  assert.ok(h.refreshed[0].profiles.every(profile => profile.provider_account_id === "shop-a"));
});

test("failed metadata acquisition preserves cached information", async () => {
  const h = harness();
  const outcome = await persistence(h).run({ ok: false, account: { provider_account_id: "shop-a", display_name: "Do not apply" } });
  assert.equal(outcome.ok, false);
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
  const outcome = await persistence(h).run();
  assert.equal(outcome.ok, true);
  assert.equal(outcome.partial, true);
  assert.equal(outcome.account_refreshed, true);
  assert.equal(outcome.customer_count, 1);
  assert.equal(h.refreshed.length, 1);
  assert.equal(h.state.detectedAccounts[0].display_name, "Fresh shop");
});

test("erasing data blocks passive cache requests", async () => {
  const h = harness();
  h.runtime.metadataErasing = true;
  const result = await h.invoke({ type: "cache_profiles", provider: "shopee", profiles: [
    { conversation_id: "chat-a", id: "buyer-a", provider_account_id: "shop-a", display_name: "Buyer" },
  ] }, { tab: h.tab });
  assert.equal(result.ok, false);
  assert.equal(h.enriched.length, 0);
});

function combinedHarness(provider = "shopee", refreshMetadata = true) {
  const h = harness(provider);
  const context = h.runtime.accountContextFor(structuredClone(h.state), "shop-a", provider);
  const requests = [];
  let finish;
  const controller = new AbortController();
  const control = { controller, refreshMetadata, lockedTabId: h.tab.id,
    lockedTabContext: h.runtime.providerTabContext(h.tab, provider) };
  Object.assign(h.runtime, {
    providerLabel: () => provider, updateScopedState: async () => {},
    exactProviderAccountTab: async () => h.tab, providerChatTabById: async () => h.tab,
    providerTabCanSend: () => true, persistProviderSurfaceState: async () => {},
    crypto: { randomUUID: () => "combined-request" },
    awaitProviderRecovery: async (_tabId, message) => {
      requests.push(plain(message));
      return new Promise(resolve => { finish = resolve; });
    },
  });
  vm.runInContext(section("async function syncOpenProvider(", "async function retryProviderAccount("), h.runtime);
  return { ...h, context, requests, control,
    run: () => h.runtime.syncOpenProvider(control, context),
    async pending() { while (!finish) await turn(); },
    finish() { finish({ ok: true, recovered: 3, metadata: { ok: true,
      account: { provider_account_id: "shop-a", display_name: "Fresh shop" },
      profiles: [{ conversation_id: "chat-a", id: "buyer-a", provider_account_id: "shop-a", display_name: "Fresh buyer" }] } }); },
  };
}

for (const provider of ["shopee", "line_oa"]) {
  test(`${provider} combined manual scan applies metadata after long message recovery and returns only counts`, async () => {
    const h = combinedHarness(provider);
    const result = h.run();
    await h.pending();
    assert.equal(h.requests[0].refresh_metadata, true);
    h.runtime.Date.now = () => 120_000;
    h.finish();
    const outcome = plain(await result);
    assert.equal(outcome.recovered, 3);
    assert.deepEqual(outcome.metadata, { ok: true, account_refreshed: true, customer_count: 1, partial: false });
    assert.equal(h.refreshed.length, 1);
    assert.doesNotMatch(JSON.stringify(outcome), /Fresh buyer|profiles|Fresh shop/);
  });
  test(`${provider} automatic recovery requests no metadata and cannot apply unsolicited profiles`, async () => {
    const h = combinedHarness(provider, false);
    const result = h.run();
    await h.pending();
    assert.equal(h.requests[0].refresh_metadata, false);
    h.finish();
    const outcome = await result;
    assert.equal(outcome.metadata, undefined);
    assert.equal(h.writes.length, 0);
    assert.equal(h.refreshed.length, 0);
  });
}

for (const [name, change] of [
  ["account removal", h => { h.state.detectedAccounts = []; }],
  ["configuration", h => { h.state.config.tenant_id = "tenant-b"; }],
  ["session", h => h.changeSession()],
  ["tab", h => h.changeTab()],
  ["consent", h => { h.state.consent = false; }],
  ["erase", h => { h.runtime.metadataEpoch += 1; }],
]) {
  test(`combined scan metadata cannot apply after changed ${name}`, async () => {
    const h = combinedHarness();
    const result = h.run();
    await h.pending();
    change(h);
    h.finish();
    const outcome = await result;
    assert.equal(outcome.ok, true, "metadata staleness must not rewrite a completed recovery as failure");
    assert.equal(outcome.metadata.ok, false);
    assert.equal(h.writes.length, 0);
    assert.equal(h.refreshed.length, 0);
    assert.equal(h.state.detectedAccounts[0]?.display_name ?? "Cached shop", "Cached shop");
  });
}

test("cancelled combined scan cannot apply metadata or settle as successful recovery", async () => {
  const h = combinedHarness();
  const result = h.run();
  await h.pending();
  h.control.controller.abort();
  h.finish();
  await assert.rejects(result, /cancelled/);
  assert.equal(h.writes.length, 0);
  assert.equal(h.refreshed.length, 0);
});

test("cancellation while resolving metadata scope prevents late persistence", async () => {
  const h = harness();
  const operation = persistence(h);
  let releaseScope;
  let scopeStarted;
  const started = new Promise(resolve => { scopeStarted = resolve; });
  const pendingScope = new Promise(resolve => { releaseScope = resolve; });
  h.runtime.metadataScope = async () => { scopeStarted(); return pendingScope; };
  const result = operation.run();
  await started;
  operation.controller.abort();
  releaseScope("same-scope");
  await assert.rejects(result, /cancelled/);
  assert.equal(h.writes.length, 0);
  assert.equal(h.refreshed.length, 0);
});
