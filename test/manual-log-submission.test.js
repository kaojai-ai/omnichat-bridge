import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { automaticLogForwardingEnabled, forwardingBackoff, routeLogEntries, selectLogBatch } from '../extension/lib/log-forwarding.js';
const source = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
function fixture({ fail = false, automatic = false, busy = false, persisted, onSend, contexts } = {}) {
  const entries = Array.from({ length: 205 }, (_, i) => ({ id: String(i), account_key: 'shop' }));
  const stored = persisted ?? { forward_log: automatic, logs: entries, logOutbox: entries.map(e => e.id), logUploadEnabled: true };
  const batches = [];
  const telemetry = [];
  const submit = vm.runInNewContext(source.slice(source.indexOf('let logSubmission = null;'), source.indexOf('\nfunction isMessageScopedDeliveryError')) + '\nsubmitLogs', {
    crypto: webcrypto, automaticLogForwardingEnabled, forwardingBackoff, routeLogEntries, selectLogBatch, automaticLogWorkBusy: () => busy,
    diagnosticBuffer: { drain: async () => {} }, logMutationQueue: Promise.resolve(),
    STORAGE: new Proxy({}, { get: (_, key) => key }), readStorage: async () => stored,
    writeStorage: async value => Object.assign(stored, value), mutateLogs: fn => fn(),
    hasLocalConsent: () => true, hasServerInitialized: () => true,
    configuredAccountContexts: () => contexts ?? [{ key: 'shop', config: { logs_url: 'configured' }, account: { provider_account_id: 'shop' } }],
    pruneLogs: value => value, MAX_LOG_UPLOAD_BATCH: 100,
    sendLogBatch: async (_, batch, options) => { batches.push(batch.length); await onSend?.(batch, options); if (fail) throw new Error('Unavailable'); },
    recordLog: async (...args) => { telemetry.push(args); }, diagnosticErrorDetails: () => ({}),
  });
  return { submit, batches, stored, telemetry };
}
test('manual submit coalesces clicks and drains only its snapshot in bounded batches', async () => {
  const { submit, batches, stored } = fixture();
  const first = submit();
  assert.equal(submit(), first);
  const result = await first;
  assert.equal(result.ok, true);
  assert.equal(result.submitted, 205);
  assert.deepEqual(batches, [100, 100, 5]);
  assert.equal(stored.logOutbox.length, 0);
});
test('failed manual submission preserves pending logs without automatic retry', async () => {
  const { submit, batches, stored } = fixture({ fail: true });
  const result = await submit();
  assert.equal(result.ok, false);
  assert.equal(result.remaining, 205);
  assert.deepEqual(batches, [100]);
  assert.equal(stored.logOutbox.length, 205);
});
test('automatic forwarding defaults on, respects off and backoff is bounded', () => {
  assert.equal(automaticLogForwardingEnabled({}), true);
  assert.equal(automaticLogForwardingEnabled({forward_log:false}), false);
  assert.deepEqual([1,2,3,4,5,99].map(forwardingBackoff),[1,2,4,8,15,15].map(n=>n*60000));
});
test('batch rotation includes debug and keeps accounts isolated', () => {
  const contexts=[{key:'a'},{key:'b'}];
  const entries=Array.from({length:120},(_,i)=>({id:String(i),account_key:'a',level:'info'}));
  entries.push({id:'b',account_key:'b',level:'warn'},{id:'debug',account_key:'b',level:'debug'});
  const ids=new Set(entries.map(e=>e.id));
  const first=selectLogBatch(contexts,entries,ids);
  assert.equal(first.logs.length,100);
  assert.deepEqual(selectLogBatch(contexts,entries,ids,first.cursor).logs.map(e=>e.id),['debug','b']);
});

test('automatic wakes upload one bounded batch and preserve the remainder', async () => {
  const {submit,batches,stored}=fixture({automatic:true});
  const result=await submit({automatic:true});
  assert.equal(result.submitted,100);
  assert.deepEqual(batches,[100]);
  assert.equal(stored.logOutbox.length,105);
  assert.equal(stored.logForwardState.failures,0);
});
test('automatic forwarding yields while customer work is busy', async () => {
  const {submit,batches}=fixture({automatic:true,busy:true});
  assert.equal((await submit({automatic:true})).skipped,true);
  assert.equal(batches.length,0);
});
test('failed auto upload retains entries and observes persisted retry deadline', async () => {
  const {submit,batches,stored}=fixture({automatic:true,fail:true});
  assert.equal((await submit({automatic:true})).ok,false);
  assert.equal(stored.logOutbox.length,205);
  assert.equal(stored.logForwardState.failures,1);
  assert.equal((await submit({automatic:true})).skipped,true);
  assert.equal(batches.length,1);
});
test('preempted uploads retain entries without failure backoff', async () => {
  const {submit,stored}=fixture({automatic:true,fail:true});
  assert.equal((await submit({automatic:true,signal:{aborted:true}})).skipped,true);
  assert.equal(stored.logOutbox.length,205);
  assert.equal(stored.logForwardState.failures,undefined);
  assert.equal(stored.logForwardState.pending_batches.shop.entry_ids.length,100);
});
test('manual click during automatic upload joins then drains the remaining logs', async () => {
  const {submit,batches,stored}=fixture({automatic:true});
  const automatic=submit({automatic:true});
  const manual=submit();
  assert.equal(submit(),manual);
  await automatic;
  const result=await manual;
  assert.equal(result.ok,true);
  assert.equal(stored.logOutbox.length,0);
  assert.deepEqual(batches,[100,100,5]);
});

for (const firstAutomatic of [true, false]) {
  test(`${firstAutomatic ? 'automatic' : 'manual'} accepted batch keeps its identity after lost response, new logs and restart`, async () => {
    const persisted = { forward_log: true, logs: [{ id: 'a', account_key: 'shop' }], logOutbox: ['a'], logUploadEnabled: true };
    const accepted = new Set();
    const emitted = [];
    const requests = [];
    const accept = (logs, { batchId }) => {
      assert.match(batchId, /^[a-f0-9-]{36}$/);
      requests.push({ batchId, ids: logs.map(entry => entry.id) });
      if (!accepted.has(batchId)) {
        accepted.add(batchId);
        emitted.push(...logs.map(entry => entry.id));
      }
    };
    const first = fixture({ persisted, onSend: (logs, options) => {
      accept(logs, options);
      throw new Error('Response lost after server acceptance');
    }});
    await first.submit({ automatic: firstAutomatic });
    persisted.logs.unshift({ id: 'b', account_key: 'shop' });
    persisted.logOutbox.push('b');
    // Recreate the coordinator from persisted storage as a worker restart does.
    const restarted = fixture({ persisted: structuredClone(persisted), onSend: accept });
    const result = await restarted.submit();
    assert.equal(result.ok, true);
    assert.deepEqual(requests[1], requests[0]);
    assert.deepEqual(requests.map(request => request.ids), [['a'], ['a'], ['b']]);
    assert.deepEqual(emitted, ['a', 'b']);
    assert.deepEqual(Object.keys(restarted.stored.logForwardState.pending_batches), []);
  });
}

test('retry preserves batch id after retention evicts an entry and never adopts another account', () => {
  const pending = { shop: { batch_id: '11111111-1111-4111-8111-111111111111', entry_ids: ['expired', 'retained', 'other'] } };
  const entries = [{ id: 'retained', account_key: 'shop' }, { id: 'new', account_key: 'shop' }, { id: 'other', account_key: 'another-shop' }];
  const selected = selectLogBatch([{ key: 'shop' }], entries, new Set(entries.map(entry => entry.id)), 0, 100, pending);
  assert.equal(selected.batchId, pending.shop.batch_id);
  assert.deepEqual(selected.logs.map(entry => entry.id), ['retained']);
});

test('unattributed and removed-account diagnostics use one installation route without duplicate forwarding', async () => {
  const contexts = [{ key: 'a', config: { logs_url: 'a' } }, { key: 'b', config: { logs_url: 'b' } }];
  const logs = [{ id: 'debug', level: 'debug' }, { id: 'orphan', account_key: 'removed' },
    { id: 'a', account_key: 'a' }, { id: 'b', account_key: 'b' }];
  const original = structuredClone(logs);
  const routed = routeLogEntries(contexts, logs);
  assert.deepEqual(logs, original, 'authentication routing must not change stored attribution');
  assert.equal(routed[0].scope, 'installation');
  assert.equal(routed[1].scope, 'installation');
  assert.equal(routed[2].scope, undefined);
  const sent = [];
  const persisted = { logs, logOutbox: [], logUploadEnabled: true };
  const { submit, stored, telemetry } = fixture({ contexts, persisted, onSend: batch => sent.push(...batch) });
  assert.equal((await submit()).submitted, 2, 'migration queues previously excluded debug and orphan logs');
  assert.deepEqual(sent.map(entry => entry.id).sort(), ['debug', 'orphan']);
  assert.ok(sent.every(entry => entry.account_key === 'a' && entry.scope === 'installation'));
  assert.equal(stored.logForwardState.all_logs_queued, true);
  assert.equal((await submit()).submitted, 0, 'acknowledged retained logs are not requeued on the next submission');
  assert.equal(new Set(sent.map(entry => entry.id)).size, sent.length);
});

test('manual submit forwards all levels across accounts once without creating upload telemetry', async () => {
  const contexts = [{ key: 'a', config: { logs_url: 'a' } }, { key: 'b', config: { logs_url: 'b' } }];
  const logs = ['debug', 'info', 'warn', 'error'].map((level, index) => ({ id: level, level, account_key: index % 2 ? 'b' : 'a' }));
  logs.push({ id: 'unscoped', level: 'info' });
  const persisted = { logs, logOutbox: logs.map(entry => entry.id), logUploadEnabled: true };
  const sent = [];
  const { submit, stored, telemetry } = fixture({ contexts, persisted, onSend: batch => sent.push(...batch) });
  assert.equal((await submit()).submitted, 5);
  assert.deepEqual(sent.map(entry => entry.id).sort(), logs.map(entry => entry.id).sort());
  assert.equal(stored.logOutbox.length, 0);
  assert.equal(stored.logs.length, 5);
  assert.equal(telemetry.length, 0, 'uploading logs must not create more logs to upload');
  assert.equal((await submit()).submitted, 0);
});
