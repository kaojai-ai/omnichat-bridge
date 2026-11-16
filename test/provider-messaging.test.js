import assert from "node:assert/strict";
import test from "node:test";
import { createProviderMessenger } from "../extension/lib/provider-messaging.js";

function event() {
  const listeners = new Set();
  return {
    addListener: (listener) => listeners.add(listener),
    removeListener: (listener) => listeners.delete(listener),
    emit: (value) => { for (const listener of [...listeners]) listener(value); },
  };
}
function port() {
  const sent = [];
  return { sent, onMessage: event(), onDisconnect: event(), postMessage: (message) => sent.push(message) };
}

test("providers without an extension port retain the content-script transport", async () => {
  const calls = [];
  const messenger = createProviderMessenger({ sendToTab: async (...args) => { calls.push(args); return { ok: true }; } });
  const message = { type: "detect_account_v3", provider: "line_oa" };
  assert.deepEqual(await messenger.send(42, message), { ok: true });
  assert.deepEqual(calls, [[42, message]]);
});

test("responses are isolated to their attached tab and request, including out-of-order replies", async (t) => {
  const messenger = createProviderMessenger({ sendToTab: () => assert.fail("must not fall back") });
  const a = port(), b = port();
  t.after(messenger.attach(1, a));
  t.after(messenger.attach(2, b));
  const first = messenger.send(1, { type: "ping_v3" });
  const second = messenger.send(1, { type: "get_provider_status_v3" });
  let firstSettled = false;
  void first.then(() => { firstSettled = true; });
  const [one, two] = a.sent;
  assert.notEqual(one.id, two.id);
  b.onMessage.emit({ kind: "provider_response", id: one.id, result: { wrong: true } });
  a.onMessage.emit({ kind: "provider_response", id: "unrecognized", result: { wrong: true } });
  a.onMessage.emit({ kind: "provider_request", id: one.id, result: { wrong: true } });
  a.onMessage.emit({ kind: "provider_response", id: two.id, result: { ok: true, ready: true } });
  assert.deepEqual(await second, { ok: true, ready: true });
  assert.equal(firstSettled, false);
  a.onMessage.emit({ kind: "provider_response", id: one.id, result: { ok: true } });
  assert.deepEqual(await first, { ok: true });
});

test("replacing a port rejects its pending send without retrying or detaching its successor", async (t) => {
  let fallbacks = 0;
  const messenger = createProviderMessenger({ sendToTab: () => { fallbacks++; } });
  const old = port(), next = port();
  const disposeOld = messenger.attach(1, old);
  const pending = messenger.send(1, { type: "send_api_v3" });
  const rejected = assert.rejects(pending, /Provider connection closed/);
  t.after(messenger.attach(1, next));
  await rejected;
  old.onDisconnect.emit();
  disposeOld();
  assert.equal(messenger.has(1), true);
  const current = messenger.send(1, { type: "ping_v3" });
  old.onMessage.emit({ kind: "provider_response", id: next.sent[0].id, result: { stale: true } });
  next.onMessage.emit({ kind: "provider_response", id: next.sent[0].id, result: { ok: true } });
  assert.deepEqual(await current, { ok: true });
  assert.equal(fallbacks, 0);
  assert.equal(old.sent.length, 1);
});

test("cancellation before dispatch posts nothing; cancellation after dispatch never retries", async (t) => {
  const messenger = createProviderMessenger({ sendToTab: () => assert.fail("must not retry another transport") });
  const peer = port();
  t.after(messenger.attach(1, peer));
  const before = new AbortController();
  before.abort();
  await assert.rejects(messenger.send(1, { type: "send_api_v3" }, { signal: before.signal }), { name: "AbortError" });
  assert.equal(peer.sent.length, 0);
  const during = new AbortController();
  const result = messenger.send(1, { type: "send_api_v3" }, { signal: during.signal });
  const rejected = assert.rejects(result, { name: "AbortError" });
  during.abort();
  await rejected;
  peer.onMessage.emit({ kind: "provider_response", id: peer.sent[0].id, result: { ok: true } });
  assert.equal(peer.sent.length, 1);
});

test("a disconnected or timed-out send rejects once and ignores late confirmation", async (t) => {
  const messenger = createProviderMessenger({ sendToTab: () => assert.fail("must not retry"), timeoutMs: 5 });
  const peer = port();
  t.after(messenger.attach(1, peer));
  const timedOut = messenger.send(1, { type: "send_api_v3" });
  await assert.rejects(timedOut, { name: "TimeoutError" });
  peer.onMessage.emit({ kind: "provider_response", id: peer.sent[0].id, result: { ok: true } });
  assert.equal(peer.sent.length, 1);
  const disconnected = messenger.send(1, { type: "send_api_v3" });
  const rejected = assert.rejects(disconnected, /Provider connection closed/);
  peer.onDisconnect.emit();
  await rejected;
  assert.equal(messenger.has(1), false);
  assert.equal(peer.sent.length, 2);
});

test("postMessage failure does not fall back and cannot leak a pending request", async (t) => {
  const messenger = createProviderMessenger({ sendToTab: () => assert.fail("must not retry") });
  const peer = port();
  peer.postMessage = () => { throw new Error("port closed"); };
  t.after(messenger.attach(1, peer));
  await assert.rejects(messenger.send(1, { type: "send_api_v3" }), /Provider connection closed/);
});
