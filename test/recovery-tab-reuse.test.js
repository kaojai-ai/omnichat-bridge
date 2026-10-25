import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { PROVIDER_RECOVERY_STATES } from "../extension/lib/provider-recovery.js";

const source = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");
const start = source.indexOf("async function resolveProviderRecoveryTab(");
const end = source.indexOf("function providerRecoveryFailureReason(", start);

function harness(provider, { tracked = true, url = "https://provider.example/chat", status = null,
  lookupFails = false, queryFails = false, tabs = null, alternativeStatus = { healthy: true, current_provider_account_id: "account" } } = {}) {
  const original = { id: 42, url, status: "complete" };
  const alternative = { id: 43, url: "https://provider.example/chat" };
  const openTabs = tabs ?? [original, alternative];
  let record = tracked ? { tab_id: original.id, state: "needs_attention" } : null;
  const calls = { created: 0, status: [] };
  const adapter = { id: provider, matchesUrl: url => url === "https://provider.example/chat" };
  const account = { account: { provider_account_id: "account" } };
  const runtime = vm.createContext({
    STORAGE: { providerRecoveryTabs: "recovery" }, PROVIDER_RECOVERY_STATES,
    providerRecoveryTabLocks: new Map(),
    readStorage: async () => ({ recovery: record }), providerRecoveryRecord: () => record,
    getTab: async id => lookupFails ? null : openTabs.find(tab => tab.id === id),
    providerChatTabs: async () => openTabs.filter(tab => adapter.matchesUrl(tab.url)),
    orderProviderTabs: (_, tabs) => tabs,
    providerTabStatus: async tab => { calls.status.push(tab.id); return tab.id === 43 ? alternativeStatus : status; },
    providerTabHealthy: status => status?.healthy === true,
    providerLabel: () => provider,
    updateProviderRecoveryTabState: async (_, patch) => (record = { ...record, ...patch }),
    recoveryRetryDue: () => true, providerRecoveryUrl: () => "https://provider.example/chat",
    recordLog: async () => {},
    chrome: { tabs: {
      query: async () => { if (queryFails) throw new Error("Chrome unavailable"); return openTabs; },
      create: async ({ url }) => { calls.created++; const tab = { id: 100, url }; openTabs.push(tab); return tab; },
    } },
  });
  vm.runInContext(source.slice(start, end), runtime);
  return { calls, record: () => record, run: () => runtime.ensureProviderRecoveryTab(adapter, account, true) };
}

for (const provider of ["shopee", "line_oa"]) {
  for (const [scenario, options] of Object.entries({
    "missing bridge": {},
    "loading or failed page": { url: "chrome-error://chromewebdata/" },
    "arbitrary navigation": { url: "https://example.org/" },
    "sign-in redirect": { url: "https://access.line.me/" },
    "unhealthy provider": { status: { healthy: false } },
    "wrong account": { status: { healthy: true, current_provider_account_id: "other" } },
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
    const h = harness(provider, { lookupFails: true, status: { healthy: true, current_provider_account_id: "account" } });
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
