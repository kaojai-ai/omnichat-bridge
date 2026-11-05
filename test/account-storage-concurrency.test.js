import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { STORAGE, readAccountState, writeAccountState } from "../extension/lib/storage.js";
import { latestMessageCursor, migrateScanState } from "../extension/lib/sync-state.js";

const source = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");
function section(start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first);
  return source.slice(first, last);
}
const turn = () => new Promise(resolve => setImmediate(resolve));
const context = key => ({ key, account: { provider: "line_oa", provider_account_id: key } });
const message = id => ({ id, provider: "line_oa", conversation_id: "conversation", event_timestamp: "2026-10-25T00:00:00.000Z" });

function harness(overrides = {}) {
  const state = { [STORAGE.consent]: true, [STORAGE.serverInitialized]: true };
  const uploads = [];
  let failWrite = false;
  const runtime = vm.createContext({ preemptAutomaticLogUpload: () => {},
    performance, TextEncoder, STORAGE, readAccountState, writeAccountState,
    metadataScope: async context => context.key,
    customerMetadata: { enrich: async (_scope, message) => message },
    readStorage: async () => { const snapshot = structuredClone(state); await turn(); return snapshot; },
    writeStorage: async patch => { await turn(); if (failWrite) { failWrite = false; throw new Error("storage unavailable"); } Object.assign(state, structuredClone(patch)); },
    hasLocalConsent: value => value === true,
    hasServerInitialized: stored => stored[STORAGE.serverInitialized] === true,
    latestMessageCursor,
    messageProvider: value => value.provider,
    recordLog: async () => {}, installationId: async () => "fixture",
    selectBatchMessages: pending => pending,
    deliverWithIsolation: selected => new Promise(resolve => uploads.push({ selected, resolve })),
    isMessageScopedDeliveryError: () => false,
    attemptDelivery: async () => ({ sent: 0 }),
    ...overrides,
  });
  vm.runInContext([
    section("let accountStorageQueue =", "let liveStateWriteQueue ="),
    section("async function writeAccountScanState(", "function bootstrapConversation("),
    section("function messageKey(", "async function queueMessages("),
    section("async function flushBatch(", "async function flushAll("),
  ].join("\n"), runtime);
  return { runtime, state, uploads, failNextWrite: () => { failWrite = true; } };
}

test("concurrent account uploads preserve new captures and do not restore delivered messages", { timeout: 3000 }, async () => {
  const h = harness();
  const a = context("a"), b = context("b");
  await Promise.all([
    h.runtime.queueMessagesForContext([message("a1")], a, false),
    h.runtime.queueMessagesForContext([message("b1")], b, false),
  ]);
  const first = h.runtime.flushBatch(a);
  const second = h.runtime.flushBatch(b);
  while (h.uploads.length < 2) await turn();
  const acknowledge = id => {
    const upload = h.uploads.find(value => value.selected[0].id === id);
    upload.resolve({ delivered: upload.selected, skipped: [], failed: [] });
  };
  // Ingress must complete while both network requests are still waiting.
  await h.runtime.queueMessagesForContext([message("b-new")], b, false);
  acknowledge("a1");
  await first;
  await h.runtime.queueMessagesForContext([message("a-new")], a, false);
  await h.runtime.updateScopedState(STORAGE.status, b.key, { state: "syncing", completed_conversations: 3 });
  acknowledge("b1");
  assert.equal((await second).pending, 1);
  assert.deepEqual(readAccountState(h.state[STORAGE.pending], a.key, []).map(value => value.id), ["a-new"]);
  assert.deepEqual(readAccountState(h.state[STORAGE.pending], b.key, []).map(value => value.id), ["b-new"]);
  assert.equal(readAccountState(h.state[STORAGE.status], b.key, {}).state, "syncing");
  assert.equal(readAccountState(h.state[STORAGE.status], b.key, {}).completed_conversations, 3);
});

test("concurrent status and scan updates preserve other accounts and existing checkpoints", async () => {
  const h = harness();
  await Promise.all([
    h.runtime.updateScopedState(STORAGE.status, "a", { state: "syncing" }),
    h.runtime.updateScopedState(STORAGE.status, "b", { state: "error" }),
    h.runtime.updateScopedState(STORAGE.status, "a", { completed_conversations: 2 }),
    h.runtime.writeAccountScanState(context("a"), { conversations: { c: { message_id: "checkpoint" } }, in_progress: true }),
    h.runtime.writeAccountScanState(context("b"), { in_progress: true }),
    h.runtime.writeAccountScanState(context("a"), { in_progress: false, failed_at: "now" }),
  ]);
  assert.deepEqual(readAccountState(h.state[STORAGE.status], "a", {}), { state: "syncing", completed_conversations: 2 });
  assert.equal(readAccountState(h.state[STORAGE.status], "b", {}).state, "error");
  assert.equal(readAccountState(h.state[STORAGE.scanState], "a", {}).conversations.c.message_id, "checkpoint");
  assert.equal(readAccountState(h.state[STORAGE.scanState], "a", {}).in_progress, false);
  assert.equal(readAccountState(h.state[STORAGE.scanState], "b", {}).in_progress, true);
});

test("a failed storage write does not prevent another account from saving", async () => {
  const h = harness();
  h.failNextWrite();
  await assert.rejects(h.runtime.updateScopedState(STORAGE.status, "a", { state: "syncing" }), /storage unavailable/);
  await h.runtime.updateScopedState(STORAGE.status, "b", { state: "watching" });
  assert.equal(readAccountState(h.state[STORAGE.status], "b", {}).state, "watching");
});

test("delivery triggers coalesce for one account while another account proceeds", { timeout: 3000 }, async () => {
  const started = [];
  const finish = [];
  const runtime = vm.createContext({ preemptAutomaticLogUpload: () => {},
    deliverPendingForAccount: (account, options) => new Promise((resolve, reject) => {
      started.push(account.key);
      finish.push(() => options.fail ? reject(new Error("upload failed")) : resolve({ sent: 1 }));
    }),
  });
  vm.runInContext(section("const accountDeliveries =", "async function deliverPendingForAccount("), runtime);
  const first = runtime.attemptDelivery(context("a"), { fail: true });
  const failure = assert.rejects(first, /upload failed/);
  const second = runtime.attemptDelivery(context("a"), {});
  assert.equal(second, first, "same-account triggers share the active delivery");
  const other = runtime.attemptDelivery(context("b"), {});
  await turn();
  assert.deepEqual(started, ["a", "b"]);
  finish[1]();
  await other;
  finish[0]();
  await failure;
  await turn();
  assert.deepEqual(started, ["a", "b"]);
  const retry = runtime.attemptDelivery(context("a"), {});
  await turn();
  assert.deepEqual(started, ["a", "b", "a"]);
  finish[2]();
  await retry;
});


test("capture ACK waits for durable storage but not blocked target delivery or diagnostics", { timeout: 3000 }, async () => {
  const attempts = [];
  const h = harness({
    attemptDelivery: account => { attempts.push(account.key); return new Promise(() => {}); },
    recordLog: () => new Promise(() => {}),
  });
  const a = context("a");
  const result = await h.runtime.queueMessagesForContext([message("a1")], a, true, false);
  assert.equal(result.queued, 1);
  assert.equal(result.sent, 0, "local capture ACK must not claim server delivery");
  assert.equal(result.pending, 1);
  assert.deepEqual(readAccountState(h.state[STORAGE.pending], a.key, []).map(row => row.id), ["a1"]);
  assert.deepEqual(attempts, ["a"]);
  const progress = readAccountState(h.state[STORAGE.status], a.key, {});
  assert.equal(progress.messages_captured, 1);
  assert.ok(Number.isFinite(Date.parse(progress.last_progress_at)));
  await h.runtime.queueMessagesForContext([message("a1")], a, true, false);
  const unchanged = readAccountState(h.state[STORAGE.status], a.key, {});
  assert.equal(unchanged.messages_captured, 1, "a duplicate must not inflate durable capture progress");
  assert.equal(unchanged.last_progress_at, progress.last_progress_at);
  h.failNextWrite();
  await assert.rejects(h.runtime.queueMessagesForContext([message("a2")], a, true, false), /storage unavailable/);
  assert.equal(attempts.length, 2, "failed capture must not schedule forwarding");
});


test("capture during an active upload wakes one follow-up drain without parallel uploads", async () => {
  const finish = [];
  const runtime = vm.createContext({ preemptAutomaticLogUpload: () => {},
    deliverPendingForAccount: () => new Promise(resolve => finish.push(resolve)),
  });
  vm.runInContext(section("const accountDeliveries =", "async function deliverPendingForAccount("), runtime);
  const initial = runtime.attemptDelivery(context("a"), {});
  await turn();
  assert.equal(finish.length, 1);
  assert.equal(runtime.attemptDelivery(context("a"), {}), initial);
  assert.equal(runtime.attemptDelivery(context("a"), {}), initial);
  assert.equal(finish.length, 1);
  finish[0]({ sent: 2, pending: 1 });
  await turn();
  assert.equal(finish.length, 2, "bursty captures wake one subsequent drain");
  finish[1]({ sent: 1, pending: 0 });
  const result = await initial;
  assert.equal(result.sent, 3);
  assert.equal(result.pending, 0);
});


test("realtime after a failed scan cannot advance past unrecovered historical pages", async () => {
  const h = harness();
  const a = context("a");
  const checkpoint = { event_timestamp: "2026-09-01T00:00:00Z", message_id: "old" };
  h.state[STORAGE.scanState] = writeAccountState(null, a.key, { version: 1,
    watermark: "2026-09-01T00:00:00Z", in_progress: false,
    started_at: "2026-10-25T00:00:00Z", completed_at: "2026-09-01T00:00:00Z",
    failed_at: "2026-10-25T00:01:00Z", conversations: { conversation: checkpoint } });
  await h.runtime.queueMessagesForContext([message("new-realtime")], a, false);
  assert.deepEqual(readAccountState(h.state[STORAGE.scanState], a.key).conversations.conversation, checkpoint);
  assert.equal(readAccountState(h.state[STORAGE.pending], a.key).length, 1);
});

for (const provider of ["shopee", "line_oa"]) {
  test(`${provider} accepts unseen messages behind its recovery checkpoint`, async () => {
    const h = harness();
    const a = { key: `${provider}:shop`, account: { provider, provider_account_id: "shop" } };
    const checkpoint = { event_timestamp: "2026-10-25T00:00:00.000Z", message_id: "200" };
    h.state[STORAGE.scanState] = writeAccountState(null, a.key, {
      version: 1, watermark: checkpoint.event_timestamp, in_progress: false,
      conversations: { conversation: checkpoint },
    });
    const messages = [
      { ...message("100"), provider, event_timestamp: "2026-10-24T23:59:00.000Z" },
      { ...message("150"), provider },
      { ...message("300"), provider, event_timestamp: "2026-10-25T00:01:00.000Z" },
    ];
    const result = await h.runtime.queueMessagesForContext(messages, a, false);
    assert.equal(result.queued, 3);
    assert.deepEqual(readAccountState(h.state[STORAGE.scanState], a.key).conversations.conversation, checkpoint);
    const duplicate = await h.runtime.queueMessagesForContext(messages, a, false);
    assert.equal(duplicate.queued, 0);
    assert.equal(readAccountState(h.state[STORAGE.pending], a.key).length, 3);
  });
}


test("legacy scan migration never infers completeness from pending messages", async () => {
  const a = context("legacy");
  const state = {
    [STORAGE.consent]: true,
    [STORAGE.pending]: writeAccountState(null, a.key, [message("unscanned-live")]),
  };
  const runtime = vm.createContext({
    STORAGE, readAccountState, writeAccountState, migrateScanState,
    serializeAccountStorage: task => task(),
    readStorage: async () => state,
    writeStorage: async patch => Object.assign(state, patch),
    accountContextFor: () => a,
    hasLocalConsent: value => value === true,
  });
  vm.runInContext(section("async function getAccountScanState(", "async function discardPending("), runtime);
  const result = await runtime.getAccountScanState(a.account.provider_account_id, a.account.provider);
  assert.deepEqual(result.state.conversations, {});
  assert.equal(result.state.watermark, null);
  assert.equal(readAccountState(state[STORAGE.pending], a.key)[0].id, "unscanned-live");
});

test('permanently rejected and skipped messages are dropped with error diagnostics and no archive', async () => {
  const logs = [];
  const h = harness({
    messageReference: value => `${value.conversation_id}:${value.id}`,
    deliveryMessageDetails: async () => ({}), diagnosticErrorDetails: () => ({}),
    recordLog: async (level, area, event) => logs.push({ level, area, event }),
  });
  const a = context('a');
  await h.runtime.queueMessagesForContext([message('skipped'), message('rejected'), message('good')], a, false);
  const upload = h.runtime.flushBatch(a);
  while (!h.uploads.length) await turn();
  const [skipped, rejected, good] = h.uploads[0].selected;
  h.uploads[0].resolve({ delivered: [good], skipped: [skipped], failed: [{ message: rejected, error: new Error('Rejected') }] });
  assert.equal((await upload).pending, 0);
  assert.equal(readAccountState(h.state[STORAGE.pending], a.key, []).length, 0);
  assert.equal(Object.hasOwn(h.state, 'failed_messages_v1'), false);
  assert.ok(logs.some(item => item.level === 'error' && item.event === 'server_skipped'));
  assert.ok(logs.some(item => item.level === 'error' && item.event === 'failed'));
  assert.equal(readAccountState(h.state[STORAGE.status], a.key, {}).delivery_error, null);
});

test('queue pressure rejects capture before changing durable messages or checkpoints and resumes after drain', async () => {
  const h = harness();
  const a = context('a');
  const existing = { ...message('existing'), text: 'x'.repeat(4 * 1024 * 1024 - 500) };
  h.state[STORAGE.pending] = writeAccountState({}, a.key, [existing]);
  h.state[STORAGE.scanState] = writeAccountState({}, a.key, { watermark: '2026-10-25T00:00:00Z' });
  const checkpoint = JSON.stringify(h.state[STORAGE.scanState]);
  await assert.rejects(h.runtime.queueMessagesForContext([{ ...message('new'), text: 'x'.repeat(1000) }], a, false), /queue is full/);
  assert.equal(readAccountState(h.state[STORAGE.pending], a.key, []).length, 1);
  assert.equal(JSON.stringify(h.state[STORAGE.scanState]), checkpoint);
  h.state[STORAGE.pending] = writeAccountState({}, a.key, []);
  assert.equal((await h.runtime.queueMessagesForContext([message('new')], a, false)).queued, 1);
});

test('temporary target outage respects stored backoff and preserves pending messages', async () => {
  const pending = [message('unacknowledged')];
  let requests = 0;
  const retryAt = new Date(Date.now() + 60_000).toISOString();
  const deliver = vm.runInNewContext(`(${section('async function deliverPendingForAccount(', 'async function attemptAllDeliveries(')})`, {
    STORAGE, readAccountState,
    readStorage: async () => ({
      [STORAGE.consent]: true,
      [STORAGE.pending]: writeAccountState({}, 'a', pending),
      [STORAGE.deliveryRetry]: writeAccountState({}, 'a', { next_at: retryAt }),
    }),
    hasLocalConsent: () => true, hasServerInitialized: () => true,
    resetDeliveryRetry: async () => assert.fail('automatic work must not reset backoff'),
    flushAll: async () => { requests++; return { sent: 0, pending: 1 }; },
  });
  const result = await deliver(context('a'), { resetBackoff: false });
  assert.equal(result.skipped, 'backoff');
  assert.equal(result.pending, 1);
  assert.equal(requests, 0);
  assert.equal(pending[0].id, 'unacknowledged');
});
