import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { createReplyQueue } from "../extension/lib/reply-queue.js";
import { PROVIDER_RECOVERY_STATES } from "../extension/lib/provider-recovery.js";

const source = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");
const start = source.indexOf("async function resolveProviderRecoveryTab(");
const end = source.indexOf("function providerRecoveryFailureReason(", start);

function harness(provider, { tracked = true, url = "https://provider.example/chat", status = null,
  lookupFails = false, queryFails = false, tabs = null, country, owned = false, onUpdate = async () => {}, onReload = () => {}, alternativeStatus = { healthy: true, capabilities: { message_recovery: true }, current_provider_account_id: "account" } } = {}) {
  const original = { id: 42, url, status: "complete" };
  const alternative = { id: 43, url: "https://provider.example/chat" };
  const openTabs = tabs ?? [original, alternative];
  let record = tracked ? { tab_id: original.id, state: "needs_attention", opened_by_extension: owned } : null;
  const calls = { created: 0, reloaded: 0, invalidated: 0, status: [], recoveryKeys: [] };
  const adapter = { id: provider, matchesUrl: url => country ? /^https:\/\/seller\.shopee\.(?:co\.th|com\.my|ph)\//.test(url) : url === "https://provider.example/chat",
    ...(country ? { matchesAccountUrl: url => new URL(url).hostname === `seller.shopee.${country === "MY" ? "com.my" : "ph"}` } : {}),
  };
  const replyQueue = createReplyQueue();
  const account = { key: `${provider}:account`, account: { provider_account_id: "account", ...(country ? { country } : {}) } };
  const runtime = vm.createContext({ recoveryTemplateReloads: new Map(), activeProviderSendAccounts: new Set(),
    URL, STORAGE: { providerRecoveryTabs: "recovery" }, PROVIDER_RECOVERY_STATES,
    providerRecoveryTabLocks: new Map(), replyQueue, invalidateProviderTab: () => { calls.invalidated++; },
    readStorage: async () => ({ recovery: record }), providerRecoveryRecord: (_stored, key) => { calls.recoveryKeys.push(key); return record; },
    getTab: async id => lookupFails ? null : openTabs.find(tab => tab.id === id),
    providerChatTabs: async () => openTabs.filter(tab => adapter.matchesUrl(tab.url)),
    orderProviderTabs: (_, tabs) => tabs,
    providerTabStatus: async tab => { calls.status.push(tab.id); return tab.id === 43 ? alternativeStatus : status; },
    providerTabHealthy: status => status?.healthy === true,
    providerLabel: () => provider,
    updateProviderRecoveryTabState: async (_, patch) => { await onUpdate(patch); return (record = { ...record, ...patch }); },
    recoveryRetryDue: () => true, providerRecoveryUrl: () => country ? `https://seller.shopee.${country === "MY" ? "com.my" : "ph"}/new-webchat/conversations` : "https://provider.example/chat",
    recordLog: async () => {},
    chrome: { tabs: {
      reload: async () => { calls.reloaded++; await onReload(); },
      query: async () => { if (queryFails) throw new Error("Chrome unavailable"); return openTabs; },
      create: async ({ url }) => { calls.created++; const tab = { id: 100, url }; openTabs.push(tab); return tab; },
    } },
  });
  vm.runInContext(source.slice(source.indexOf("function providerRecoveryKey("), source.indexOf("function providerRecoveryUrl(")), runtime);
  vm.runInContext(source.slice(start, end), runtime);
  return { calls, replyQueue, record: () => record, run: () => runtime.ensureProviderRecoveryTab(adapter, account, true) };
}

for (const provider of ["shopee", "line_oa"]) {
  for (const [scenario, options] of Object.entries({
    "missing bridge": {},
    "loading or failed page": { url: "chrome-error://chromewebdata/" },
    "arbitrary navigation": { url: "https://example.org/" },
    "sign-in redirect": { url: "https://access.line.me/" },
    "unhealthy provider": { status: { healthy: false } },
    "wrong account": { status: { healthy: true, capabilities: { message_recovery: true }, current_provider_account_id: "other" } },
  })) {
    test(`${provider}: ${scenario} uses a healthy existing matching tab without creating another`, async () => {
      const h = harness(provider, options);
      for (let tick = 0; tick < 3; tick++) await h.run();
      assert.equal(h.calls.created, 0);
      const keepHealthyLineTab = provider === "line_oa" && scenario === "wrong account";
      assert.equal(h.record().tab_id, keepHealthyLineTab ? 42 : 43);
      assert.equal(h.calls.status.includes(43), !keepHealthyLineTab);
      assert.equal(h.record().state, "ready");
    });
  }
  test(`${provider}: lookup failure does not replace a tab still in Chrome's tab list`, async () => {
    const h = harness(provider, { lookupFails: true, status: { healthy: true, capabilities: { message_recovery: true }, current_provider_account_id: "account" } });
    await h.run();
    assert.equal(h.record().tab_id, 42);
    assert.equal(h.calls.created, 0);
  });
  test(`${provider}: uncertain Chrome state never creates a speculative replacement`, async () => {
    const h = harness(provider, { lookupFails: true, queryFails: true });
    await assert.rejects(h.run(), /Chrome unavailable/);
    assert.equal(h.calls.created, 0);
  });
  test(`${provider}: concurrent checks create one replacement after actual closure`, async () => {
    const h = harness(provider, { tabs: [] });
    await Promise.all([h.run(), h.run(), h.run()]);
    await h.run();
    assert.equal(h.calls.created, 1);
    assert.equal(h.record().tab_id, 100);
  });
  test(`${provider}: with no tracked tab, adopts an existing provider tab`, async () => {
    const h = harness(provider, { tracked: false });
    await h.run();
    assert.equal(h.calls.created, 0);
    assert.equal(h.record().tab_id, 43);
  });
}


for (const provider of ["shopee", "line_oa"]) {
  test(`${provider}: retains a signed-out tab when no healthy alternative exists`, async () => {
    const h = harness(provider, { url: "https://access.line.me/", alternativeStatus: { healthy: false } });
    const result = await h.run();
    assert.equal(result.tab, null);
    assert.equal(h.record().tab_id, 42);
    assert.equal(h.calls.created, 0);
  });
}

test("Shopee never adopts a healthy alternative signed into another shop", async () => {
  const h = harness("shopee", { alternativeStatus: { healthy: true, current_provider_account_id: "other" } });
  await h.run();
  assert.equal(h.record().tab_id, 42);
  assert.equal(h.calls.created, 0);
});


test("MY recovery ignores an existing TH tab and opens its own regional chat", async () => {
  const h = harness("shopee", { country: "MY", tracked: false,
    tabs: [{ id: 99, url: "https://seller.shopee.co.th/new-webchat/conversations" }] });
  await h.run();
  assert.equal(h.calls.created, 1);
  assert.ok(h.calls.recoveryKeys.every(key => key === "shopee:MY"));
});

test("MY recovery refuses a healthy PH tab even when its account ID matches", async () => {
  const h = harness("shopee", { country: "MY", url: "https://seller.shopee.ph/new-webchat/conversations",
    status: { healthy: true, capabilities: { message_recovery: true }, current_provider_account_id: "account" } });
  const result = await h.run();
  assert.equal(result.tab, null);
  assert.equal(h.calls.created, 0, "an existing tracked tab needs attention, never speculative replacement");
});


test("uninitialized customer Shopee tab creates one inactive owned chat without reloading customer tab", async () => {
  const h = harness("shopee", { tabs: [{ id: 42, url: "https://provider.example/chat" }],
    status: { healthy: false, current_provider_account_id: "account", capabilities: { message_recovery: false } } });
  await h.run();
  assert.equal(h.calls.created, 1);
  assert.equal(h.calls.reloaded, 0);
  assert.equal(h.record().opened_by_extension, true);
  await h.run();
  await h.run();
  assert.equal(h.calls.created, 1, "owned recovery tab is reused");
  assert.ok(h.calls.reloaded <= 1, "at most one owned-tab initialization reload");
});


test("owned-tab reload yields to a send arriving during its storage await", async () => {
  let releaseStorage;
  let storageStarted;
  const blockedStorage = new Promise(resolve => { releaseStorage = resolve; });
  const started = new Promise(resolve => { storageStarted = resolve; });
  const events = [];
  const h = harness("shopee", {
    owned: true, tabs: [{ id: 42, url: "https://provider.example/chat" }],
    status: { healthy: false, current_provider_account_id: "account", capabilities: { message_recovery: false } },
    onUpdate: async patch => {
      if (patch.template_reload_at) { storageStarted(); await blockedStorage; }
    },
    onReload: () => events.push("reload"),
  });
  const recovery = h.run();
  await started;
  const send = h.replyQueue.run("shopee:account", () => events.push("send"));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, [], "send waits only for the storage reservation to unwind");
  releaseStorage();
  await Promise.all([recovery, send]);
  assert.deepEqual(events, ["send"]);
  assert.equal(h.calls.reloaded, 0);
  assert.equal(h.calls.invalidated, 0, "queued send keeps its verified session and acknowledgement socket");
  assert.equal(h.record().template_reload_at, null, "yielded recovery does not consume its reload attempt");
  assert.equal(h.record().next_retry_at, null, "yielded recovery does not start a cooldown");
  await h.run();
  assert.equal(h.calls.reloaded, 1, "recovery can retry when customer work is finished");
});

test("owned-tab reload yields to an already queued send", async () => {
  let releaseSend;
  const h = harness("shopee", {
    owned: true, tabs: [{ id: 42, url: "https://provider.example/chat" }],
    status: { healthy: false, current_provider_account_id: "account", capabilities: { message_recovery: false } },
  });
  const send = h.replyQueue.run("shopee:account", () => new Promise(resolve => { releaseSend = resolve; }));
  await h.run();
  assert.equal(h.calls.reloaded, 0);
  assert.equal(h.record().template_reload_at, undefined, "skipped recovery does not consume its reload attempt");
  releaseSend();
  await send;
  await h.run();
  assert.equal(h.calls.reloaded, 1);
});
