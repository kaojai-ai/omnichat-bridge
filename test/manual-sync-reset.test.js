import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
function harness(provider) {
  const calls = [];
  const tab = { id: 7, url: 'provider-chat' };
  const checks = new Map([[7, {}], [8, {}]]);
  const epochs = new Map();
  const scope = vm.createContext({ Map, Number,
    providerAdapterForId: id => id === provider ? { id } : null,
    STORAGE: { consent: 'consent' }, readStorage: async () => ({ consent: true }), hasLocalConsent: value => value,
    providerChatTabById: async () => tab, cancelActiveSync: async (...args) => calls.push(['cancel', ...args]),
    providerBridgeChecks: checks, providerTabEpochs: epochs,
    providerPolicyTabIds: new Map([['target', 7], ['other', 8]]), sessionEligibility: { reset: key => calls.push(['reset', key]) },
    providerTabContext: current => `${current.id}:${epochs.get(current.id)}:${current.url}`,
    ensureProviderBridge: async () => calls.push(['bridge']),
    sendProviderMessage: async (_id, message) => { calls.push([message.type]); return { ok: true }; },
    providerLabel: () => provider, PROVIDER_STATUS_RESPONSE_TIMEOUT_MS: 5000,
    resetProviderRecovery: async () => calls.push(['recovery']), recordLog: async () => {},
  });
  vm.runInContext(source.slice(source.indexOf('const syncTabPreparations ='), source.indexOf('async function exactProviderAccountTab(')), scope);
  return { scope, calls, tab, checks, epochs };
}
for (const provider of ['line_oa', 'shopee']) {
  test(`manual ${provider} refresh clears only temporary selected-tab state`, async () => {
    const h = harness(provider);
    const first = h.scope.prepareSyncTab(provider, 7);
    assert.equal(h.scope.prepareSyncTab(provider, 7), first);
    assert.equal((await first).ok, true);
    assert.deepEqual(h.calls, [['cancel', provider, 7], ['reset', 'target'], ['bridge'], ['cancel_sync_v3'], ['recovery']]);
    assert.equal(h.checks.has(7), false);
    assert.equal(h.checks.has(8), true);
    assert.equal(h.epochs.get(7), 1);
    assert.equal(h.epochs.has(8), false);
  });
  test(`manual ${provider} refresh rejects navigation before it can authorize a new sync`, async () => {
    const h = harness(provider);
    h.scope.resetProviderRecovery = async () => { h.tab.url = 'different-page'; };
    await assert.rejects(h.scope.prepareSyncTab(provider, 7), /Page changed/);
  });
}
test('manual reset never clears persistent checkpoints, pending queues or outgoing protection', () => {
  const prepare = source.slice(source.indexOf('async function refreshSyncTab('), source.indexOf('async function exactProviderAccountTab('));
  assert.doesNotMatch(prepare, /writeStorage|chrome\.storage|seenLiveCommands|commandReceipts|stopAccountLiveConnection|invalidateProviderTab/);
});

test('BFCache channel closure stays a failure with a short actionable message', async () => {
  const error = new Error('The page keeping the extension port is moved into back/forward cache, so the message channel is closed.');
  const scope = vm.createContext({
    chrome: { tabs: { sendMessage: async () => { throw error; } } },
    performance: { now: () => 0 }, PROVIDER_REQUEST_TIMEOUT_MS: 100,
    setTimeout, clearTimeout, recordLog: async () => {},
  });
  vm.runInContext(source.slice(source.indexOf('function providerMessageTimeout('), source.indexOf('function syncCancelledError(')), scope);
  await assert.rejects(scope.sendProviderMessage(7, { type: 'sync_now_v3' }), failure => {
    assert.equal(failure.message, 'Page changed. Sync again.');
    assert.equal(failure.reason_code, 'provider_page_changed');
    assert.notEqual(failure.name, 'AbortError');
    return true;
  });
});
