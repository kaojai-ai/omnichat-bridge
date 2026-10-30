import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { automaticLogForwardingEnabled, forwardingBackoff, selectLogBatch } from '../extension/lib/log-forwarding.js';
const source = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
function fixture({ fail = false, automatic = false, busy = false, aborted = false } = {}) {
  const entries = Array.from({ length: 205 }, (_, i) => ({ id: String(i), account_key: 'shop' }));
  const stored = { forward_log: automatic, logs: entries, logOutbox: entries.map(e => e.id), logUploadEnabled: true };
  const batches = [];
  const submit = vm.runInNewContext(source.slice(source.indexOf('let logSubmission = null;'), source.indexOf('\nfunction isMessageScopedDeliveryError')) + '\nsubmitLogs', {
    automaticLogForwardingEnabled, forwardingBackoff, selectLogBatch, automaticLogWorkBusy: () => busy,
    diagnosticBuffer: { drain: async () => {} }, logMutationQueue: Promise.resolve(),
    STORAGE: new Proxy({}, { get: (_, key) => key }), readStorage: async () => stored,
    writeStorage: async value => Object.assign(stored, value), mutateLogs: fn => fn(),
    hasLocalConsent: () => true, hasServerInitialized: () => true,
    configuredAccountContexts: () => [{ key: 'shop', config: { logs_url: 'configured' }, account: { provider_account_id: 'shop' } }],
    pruneLogs: value => value, MAX_LOG_UPLOAD_BATCH: 100,
    sendLogBatch: async (_, batch) => { batches.push(batch.length); if (fail) throw new Error('Unavailable'); },
    recordLog: async () => {}, diagnosticErrorDetails: () => ({}),
  });
  return { submit, batches, stored };
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
test('batch rotation excludes debug and keeps accounts isolated', () => {
  const contexts=[{key:'a'},{key:'b'}];
  const entries=Array.from({length:120},(_,i)=>({id:String(i),account_key:'a',level:'info'}));
  entries.push({id:'b',account_key:'b',level:'warn'},{id:'debug',account_key:'b',level:'debug'});
  const ids=new Set(entries.map(e=>e.id));
  const first=selectLogBatch(contexts,entries,ids);
  assert.equal(first.logs.length,100);
  assert.deepEqual(selectLogBatch(contexts,entries,ids,first.cursor).logs.map(e=>e.id),['b']);
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
  assert.equal(stored.logForwardState,undefined);
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
