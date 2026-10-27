import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
function fixture({ fail = false } = {}) {
  const entries = Array.from({ length: 205 }, (_, i) => ({ id: String(i), account_key: 'shop' }));
  const stored = { logs: entries, logOutbox: entries.map(e => e.id), logUploadEnabled: true };
  const batches = [];
  const submit = vm.runInNewContext(source.slice(source.indexOf('let logSubmission = null;'), source.indexOf('\nfunction isMessageScopedDeliveryError')) + '\nsubmitLogs', {
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
test('diagnostic uploads have no scheduler or alarm dispatch', () => {
  assert.doesNotMatch(source, /scheduleLogUpload|resumeLogUpload|alarm\.name === LOG_UPLOAD_ALARM/);
  assert.match(source, /chrome\.alarms\.clear\(LOG_UPLOAD_ALARM\)/);
});
