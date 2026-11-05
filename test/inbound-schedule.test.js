import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const start = source.indexOf('async function runInboundTick(');
const end = source.indexOf('async function runProviderHealthWatchdogOnce(', start);
function fixture() {
  const context = { key: 'shopee:shop', adapter: { id: 'shopee' } };
  const state = { live: { leader: true }, status: { last_sync_at: '2026-01-01T00:00:00Z' }, scan: {} };
  const jobs = new Map(), calls = [], updates = [];
  let finish;
  const runtime = vm.createContext({
    inboundTickRunning: false, inboundNextAt: new Map(), providerAutomaticRetryAt: new Map(), providerAutomaticRetryAttempts: new Map(),
    STORAGE: { live: 'live', status: 'status', scanState: 'scan' },
    readStorage: async () => state, readAccountState: (value, _key, fallback) => value ?? fallback,
    hasServerInitialized: () => true, hasLocalConsent: () => true,
    configuredAccountContexts: () => [context], accountSyncs: jobs,
    liveConnections: new Map([[context.key, { socket: { readyState: 1 } }]]), WebSocket: { OPEN: 1 },
    sessionEligibility: { state: () => ({ eligible: true, unknown: false }) },
    requestAccountSync: () => { calls.push(context.key); jobs.set(context.key, {}); return new Promise(resolve => { finish = value => { jobs.delete(context.key); resolve(value); }; }); },
    updateScopedState: async (_storage, _key, patch) => updates.push(patch),
  });
  vm.runInContext(source.slice(start, end), runtime);
  return { runtime, state, calls, updates, finish: value => finish(value) };
}
test('timer ticks do not overlap an active account scan and standby nodes do not fetch', async () => {
  const h = fixture();
  await h.runtime.runInboundTick();
  await h.runtime.runInboundTick();
  assert.equal(h.calls.length, 1);
  h.finish({});
  await new Promise(resolve => setImmediate(resolve));
  h.runtime.inboundNextAt.clear();
  h.state.live.leader = false;
  await h.runtime.runInboundTick();
  assert.equal(h.calls.length, 1);
});
test('failed scan results schedule backoff instead of being mistaken for successful empty scans', async () => {
  const h = fixture();
  await h.runtime.runInboundTick();
  h.finish({ error: 'Provider scan failed.' });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(h.runtime.providerAutomaticRetryAt.get('shopee:shop') > Date.now());
  assert.ok(h.updates[0].next_retry_at);
  h.runtime.inboundNextAt.clear();
  await h.runtime.runInboundTick();
  assert.equal(h.calls.length, 1);
});
test('accounts require manual initialization but interrupted first scans remain retryable', async () => {
  const h = fixture();
  h.state.status = {};
  await h.runtime.runInboundTick();
  assert.equal(h.calls.length, 0);
  h.state.scan.started_at = '2026-01-01T00:00:00Z';
  await h.runtime.runInboundTick();
  assert.equal(h.calls.length, 1);
  h.finish({});
});

for (const [ordered, pages, minimum] of [[true, 1, 3000], [true, 10, 30000], [false, 1, 60000]]) {
  test(`next scan waits from completion and amortizes pages (ordered=${ordered}, pages=${pages})`, async () => {
    const h = fixture();
    await h.runtime.runInboundTick();
    const completedAt = Date.now();
    h.finish({ discovery_ordered: ordered, conversation_pages: pages });
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(h.runtime.inboundNextAt.get('shopee:shop') >= completedAt + minimum);
    await h.runtime.runInboundTick();
    assert.equal(h.calls.length, 1);
  });
}
