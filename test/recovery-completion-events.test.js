import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
function fixture(provider = 'line_oa') {
  const controller = new AbortController();
  const control = { controller, adapter: { id: provider }, providerAccountId: 'account', tabId: 7, providerRequestId: 'attempt' };
  const calls = [];
  const timers = new Map();
  let id = 0;
  const scope = vm.createContext({
    AbortController, providerAutomaticRecoveries: new Map(), activeSyncControl: control,
    syncCancelledError: () => Object.assign(new Error('Cancelled'), { name: 'AbortError' }),
    providerMessageTimeout: () => Object.assign(new Error('No progress'), { name: 'TimeoutError' }),
    PROVIDER_STATUS_RESPONSE_TIMEOUT_MS: 5000, RECOVERY_IDLE_TIMEOUT_MS: 60000,
    setTimeout: fn => { timers.set(++id, fn); return id; }, clearTimeout: key => timers.delete(key),
    sendProviderMessage: async (tabId, message) => { calls.push({ tabId, message }); return { ok: true, started: true, request_id: message.request_id }; },
  });
  const a = source.indexOf('function awaitProviderRecovery('), b = source.indexOf('function syncCancelledError(', a);
  const c = source.indexOf('function syncControlForMessage('), d = source.indexOf('async function initializeAndStartSync(', c);
  const e = source.indexOf('  if (message?.type === "sync_complete")'), f = source.indexOf('  if (message?.type === "sync_activity")', e);
  vm.runInContext(source.slice(a, b) + source.slice(c, d) + '\nfunction complete(message, tabId) { let response; const _sender = {tab: {id: tabId}}, respond = value => {response=value}; ' + source.slice(e, f) + '; return response; }', scope);
  const message = { type: 'sync_now_v3', provider, provider_account_id: 'account', request_id: 'attempt' };
  return { scope, control, calls, timers, controller, start: () => scope.awaitProviderRecovery(7, message, control, controller.signal),
    complete: (patch = {}, tabId = 7) => scope.complete({ ...message, type: 'sync_complete', result: { ok: true, recovered: 3 }, ...patch }, tabId) };
}
for (const provider of ['line_oa', 'shopee']) {
  test(`${provider} startup ACK does not complete recovery; separate event completes it`, async () => {
    const h = fixture(provider); let done = false;
    const task = h.start().then(value => { done = true; return value; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(done, false);
    assert.equal(h.calls.length, 1);
    h.complete();
    assert.equal((await task).recovered, 3);
    assert.equal(h.timers.size, 0);
    assert.equal(h.control.recoveryCompletion, null);
  });
}
test('wrong tab, account, provider and superseded attempt cannot complete recovery', async () => {
  const h = fixture(); const task = h.start();
  for (const [patch, tab] of [[{}, 8], [{provider_account_id:'other'},7], [{provider:'shopee'},7], [{request_id:'old'},7]]) {
    assert.equal(h.complete(patch, tab), false);
    assert.ok(h.control.recoveryCompletion);
  }
  h.complete(); await task;
});
test('real progress extends recovery watchdog; silence fails without restarting scan', async () => {
  const h = fixture(); const task = h.start();
  const failure = assert.rejects(task, { name: 'TimeoutError' });
  const first = [...h.timers.keys()][0];
  h.control.touchRecovery();
  assert.equal(h.timers.has(first), false);
  [...h.timers.values()][0]();
  await failure;
  assert.equal(h.calls.filter(call => call.message.type === 'sync_now_v3').length, 1);
  assert.equal(h.calls.at(-1).message.type, 'cancel_sync_v3');
});
test('cancellation rejects event wait and cleans correlation state', async () => {
  const h = fixture(); const task = h.start();
  h.controller.abort();
  await assert.rejects(task, { name: 'AbortError' });
  assert.equal(h.control.recoveryCompletion, null);
  assert.equal(h.timers.size, 0);
});

test('count-only progress preserves the actual phase and reports measured list-page counts', async () => {
  let state = { state: 'syncing', phase: 'fetching_messages', completed_conversations: 2, total_conversations: 5 };
  const control = { adapter: { id: 'line_oa' }, providerAccountId: 'account', controller: new AbortController() };
  const scope = vm.createContext({
    syncControlForMessage: () => control, isCurrentSyncControl: () => true,
    exclusive: operation => operation(), readStorage: async () => ({}), STORAGE: {},
    accountContextFor: () => ({ key: 'line_oa:account' }),
    updateScopedState: async (_storage, _key, update) => { state = {...state, ...update(state)}; },
  });
  const start = source.indexOf('  if (message?.type === "sync_progress" || message?.type === "sync_phase")');
  const end = source.indexOf('  if (message?.type === "record_sync_plan")', start);
  vm.runInContext('function progress(message, respond) { const _sender = { tab: { id: 7 } };' + source.slice(start, end) + '}', scope);
  const send = patch => new Promise(resolve => scope.progress({ type:'sync_progress', provider:'line_oa', provider_account_id:'account', ...patch }, resolve));
  await send({ completed_conversations: 3, conversation_pages: 2 });
  assert.equal(state.phase, 'fetching_messages');
  assert.equal(state.completed_conversations, 3);
  assert.equal(state.total_conversations, 5);
  assert.equal(state.conversation_pages, 2);
  await send({ type:'sync_phase', phase:'loading_conversations' });
  assert.equal(state.phase, 'loading_conversations');
  assert.equal(state.completed_conversations, 3);
  await send({ provider_account_id:'other', completed_conversations:999 });
  assert.equal(state.completed_conversations, 3);
});

test('navigation fails the correlated recovery promptly without a second start', async () => {
  const h = fixture(); const task = h.start();
  Object.assign(h.scope, {
    providerBridgeChecks: new Map(), providerTabEpochs: new Map(), providerPolicyTabIds: new Map(),
  });
  const start = source.indexOf('function invalidateProviderTab('), end = source.indexOf('chrome.tabs.onUpdated.addListener', start);
  vm.runInContext(source.slice(start, end), h.scope);
  h.scope.invalidateProviderTab(7, 'provider_tab_navigated');
  await assert.rejects(task, /Page changed. Sync again/);
  assert.equal(h.calls.length, 1);
  assert.equal(h.control.recoveryCompletion, null);
});
