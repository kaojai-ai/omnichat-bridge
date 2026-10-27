import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
const source = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
function fixture(verify = async () => {}) {
  const calls = [];
  const scope = vm.createContext({ providerBridgeChecks: new Map(), providerTabEpochs: new Map(),
    providerSessionEpochs: new Map(), providerPolicyContexts: new Map(), providerPolicyTabIds: new Map(),
    activeSyncControl: null, providerAutomaticRecoveries: new Map(), lineTabSyncs: new Map(),
    providerSessionEpoch: () => 0, liveConnections: new Map(),
    verifyProviderBridge: async (...args) => { calls.push(args); return verify(...args); },
  });
  vm.runInContext(section("async function ensureProviderBridge(", "async function verifyProviderBridge(")
    + section("function invalidateBridgeVerification(", "// A transport/probe failure")
    + section("function invalidateProviderSession(", "chrome.tabs.onUpdated.addListener"), scope);
  return { scope, calls, check: (tab = 1, provider = "shopee", options = { reuseVerified: true }) => scope.ensureProviderBridge(tab, { id: provider }, options) };
}
for (const provider of ["shopee", "line_oa"]) {
  test(`${provider}: send checks reuse document verification; watchdog checks still verify`, async () => {
    const h = fixture();
    await h.check(1, provider);
    await h.check(1, provider);
    assert.equal(h.calls.length, 1);
    await h.check(1, provider, {});
    assert.equal(h.calls.length, 2, "background repair checks remain fresh");
    h.scope.invalidateProviderTab(1, "navigation");
    await h.check(1, provider);
    assert.equal(h.calls.length, 3);
    h.scope.invalidateProviderSession(provider, "configuration_changed");
    await h.check(1, provider);
    assert.equal(h.calls.length, 4);
    h.scope.invalidateBridgeVerification(1);
    await h.check(1, provider);
    assert.equal(h.calls.length, 5, "missing status or explicit retirement requires verification again");
  });
}
test("concurrent bridge checks share work; navigation rejects superseded verification", async () => {
  let finish;
  const h = fixture(() => new Promise(resolve => { finish = resolve; }));
  const one = h.check();
  const two = h.check();
  assert.equal(h.calls.length, 1);
  h.scope.invalidateProviderTab(1, "navigation");
  finish();
  const results = await Promise.allSettled([one, two]);
  assert.ok(results.every(result => result.status === "rejected"));
  assert.equal(h.scope.providerBridgeChecks.size, 0);
});
test("failed verification is not remembered; another provider cannot reuse a certificate", async () => {
  let fail = true;
  const h = fixture(async () => { if (fail) throw new Error("Missing bridge"); });
  await assert.rejects(h.check(), /Missing bridge/);
  fail = false;
  await h.check();
  await h.check(1, "line_oa");
  assert.equal(h.calls.length, 3);
});
