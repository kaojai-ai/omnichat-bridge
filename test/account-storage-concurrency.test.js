import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { STORAGE, readAccountState, writeAccountState } from "../extension/lib/storage.js";
import { advanceConversationCursors, hasScanBacklog, isAfterMessageCursor, latestMessageCursor, migrateScanState } from "../extension/lib/sync-state.js";

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

function harness() {
  const state = { [STORAGE.consent]: true, [STORAGE.serverInitialized]: true };
  const uploads = [];
  let failWrite = false;
  const runtime = vm.createContext({
    STORAGE, readAccountState, writeAccountState,
    readStorage: async () => { const snapshot = structuredClone(state); await turn(); return snapshot; },
    writeStorage: async patch => { await turn(); if (failWrite) { failWrite = false; throw new Error("storage unavailable"); } Object.assign(state, structuredClone(patch)); },
    hasLocalConsent: value => value === true,
    hasServerInitialized: stored => stored[STORAGE.serverInitialized] === true,
    advanceConversationCursors, hasScanBacklog, isAfterMessageCursor, latestMessageCursor, migrateScanState,
    messageProvider: value => value.provider,
    recordLog: async () => {}, installationId: async () => "fixture",
    selectBatchMessages: pending => pending,
    deliverWithIsolation: selected => new Promise(resolve => uploads.push({ selected, resolve })),
    isMessageScopedDeliveryError: () => false,
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

test("delivery attempts for one account wait for its upload while another account proceeds", { timeout: 3000 }, async () => {
  const started = [];
  const finish = [];
  const runtime = vm.createContext({
    deliverPendingForAccount: (account, options) => new Promise((resolve, reject) => {
      started.push(account.key);
      finish.push(() => options.fail ? reject(new Error("upload failed")) : resolve({ sent: 1 }));
    }),
  });
  vm.runInContext(section("const accountDeliveries =", "async function deliverPendingForAccount("), runtime);
  const first = runtime.attemptDelivery(context("a"), { fail: true });
  const failure = assert.rejects(first, /upload failed/);
  const second = runtime.attemptDelivery(context("a"), {});
  const other = runtime.attemptDelivery(context("b"), {});
  await turn();
  assert.deepEqual(started, ["a", "b"]);
  finish[1]();
  await other;
  finish[0]();
  await failure;
  await turn();
  assert.deepEqual(started, ["a", "b", "a"]);
  finish[2]();
  await second;
});
