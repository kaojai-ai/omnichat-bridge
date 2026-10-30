import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { logEntryForUpload } from '../extension/lib/logs.js';

const source = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const start = source.indexOf('async function sendLogBatch(');
const end = source.indexOf('\nlet automaticLogController', start);
const installation = '11111111-1111-4111-8111-111111111111';
for (const [configuredName, expectedName] of [['  Majestic Chrome  ', 'Majestic Chrome'], ['', installation]]) {
  test(`log batch identifies the installation using ${configuredName ? 'the configured device name' : 'its id when unnamed'}`, async () => {
    let request;
    const send = vm.runInNewContext(source.slice(start, end) + '\nsendLogBatch', {
      URL, crypto: webcrypto, STORAGE: { deviceName: 'name' },
      readStorage: async () => ({ name: configuredName }), installationId: async () => installation,
      normalizeDeviceName: name => name?.trim() ?? '',
      chrome: { runtime: { getManifest: () => ({ version: '0.8.5' }) } },
      canonicalProviderAccountId: context => context.account.provider_account_id,
      logEntryForUpload, sha256Hex: async () => 'hash', hmacHex: async () => 'signature',
      withRequestTimeout: fn => fn(undefined),
      fetch: async (_url, options) => { request = options; return { ok: true }; },
    });
    const batchId = '22222222-2222-4222-8222-222222222222';
    await send({ config: { logs_url: 'https://ingress.kaojai.ai/logs/omnichat', tenant_id: 'tenant', hmac_secret: 'test' },
      account: { provider: 'shopee', provider_account_id: 'shop' } },
    [{ id: 'debug', level: 'debug', event: 'initializing', scope: 'installation', account_key: 'internal' }], { batchId });
    const payload = JSON.parse(request.body);
    assert.equal(payload.installation_id, installation);
    assert.equal(payload.device_name, expectedName);
    assert.equal(payload.batch_id, batchId);
    assert.equal(payload.tenant_id, 'tenant');
    assert.equal(payload.logs.length, 1);
    assert.equal(payload.logs[0].level, 'debug');
    assert.equal(payload.logs[0].scope, 'installation');
    assert.equal(payload.logs[0].account_key, undefined);
    assert.equal(payload.hmac_secret, undefined);
  });
}
