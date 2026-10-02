import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness() {
  const ticket = deferred();
  const sockets = [];
  const timers = new Map();
  const logs = [];
  const liveConnections = new Map();
  let ticketCalls = 0;
  let now = 0;
  let nextTimer = 0;
  class Socket {
    static CONNECTING = 0;
    static OPEN = 1;
    constructor() { this.readyState = 0; this.listeners = {}; this.sent = []; sockets.push(this); }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; this.listeners.close?.({ code: 1000, wasClean: true }); }
    open() { this.readyState = 1; this.listeners.open(); }
  }
  const globals = {
    liveConnections, WebSocket: Socket, URL, AbortController,
    Date: { now: () => now },
    liveEndpoint: () => true,
    updateLiveState: async () => {},
    recordLog: async (_level, _area, event, _message, details) => logs.push({ event, details }),
    recordUnexpected: async () => {},
    signedLiveTicket: async () => { ticketCalls++; return ticket.promise; },
    sendConnectionStatus: async () => {},
    handleLiveCommand: async () => {},
    setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
    setInterval: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearInterval: (id) => timers.delete(id),
  };
  const setup = source.slice(source.indexOf("function stopAccountLiveConnection("), source.indexOf("async function signedLiveTicket("));
  const connection = source.slice(source.indexOf("async function ensureAccountLiveConnection(context)"), source.indexOf("function scheduleLeaderStatusRefresh"));
  const keepalive = source.slice(source.indexOf("function scheduleKeepalive(context, socket)"), source.indexOf("async function ensureLiveConnection()"));
  const interval = source.match(/const KEEPALIVE_INTERVAL_MS = ([^;]+);/)[0];
  const api = vm.runInNewContext(`(() => { ${interval}\n${setup}\n${keepalive}\n${connection}; return { ensureAccountLiveConnection, stopLiveConnection }; })()`, globals);
  return { ...api, ticket, sockets, timers, logs, liveConnections,
    calls: () => ticketCalls, advance: (ms) => { now += ms; },
    resolveTicket: () => ticket.resolve({ ticket: "test-ticket", socketUrl: new URL("wss://example.com") }),
  };
}

const account = { key: "shopee:shop", config: {}, account: { provider_account_id: "shop" } };

test("simultaneous startup events request one ticket and create one socket", async () => {
  const h = harness();
  const starts = Array.from({ length: 5 }, () => h.ensureAccountLiveConnection(account));
  await new Promise(setImmediate);
  assert.equal(h.calls(), 1);
  h.resolveTicket();
  await Promise.all(starts);
  assert.equal(h.sockets.length, 1);
});

test("stopping during a ticket request prevents a late socket from opening", async () => {
  const h = harness();
  const start = h.ensureAccountLiveConnection(account);
  await new Promise(setImmediate);
  h.stopLiveConnection();
  h.resolveTicket();
  await start;
  assert.equal(h.sockets.length, 0);
});

test("a failed ticket releases the attempt and retries only when backoff expires", async () => {
  const h = harness();
  const start = h.ensureAccountLiveConnection(account);
  await new Promise(setImmediate);
  h.ticket.reject(new Error("ticket unavailable"));
  await start;
  assert.equal(h.liveConnections.get(account.key).connecting, false);
  await h.ensureAccountLiveConnection(account);
  assert.equal(h.calls(), 1);
  [...h.timers.values()][0].callback();
  await new Promise(setImmediate);
  assert.equal(h.calls(), 2);
});

test("connection attempts for different accounts remain independent", async () => {
  const h = harness();
  const first = h.ensureAccountLiveConnection(account);
  const second = h.ensureAccountLiveConnection({ ...account, key: "shopee:other" });
  await new Promise(setImmediate);
  assert.equal(h.calls(), 2);
  h.resolveTicket();
  await Promise.all([first, second]);
  assert.equal(h.sockets.length, 2);
});

test("socket traffic keeps an idle Chrome worker inside its 30-second activity window", async () => {
  const h = harness();
  h.resolveTicket();
  await h.ensureAccountLiveConnection(account);
  h.sockets[0].open();
  h.advance(20_000);
  const timer = [...h.timers.values()].find((item) => item.delay === 20_000);
  assert.ok(timer.delay < 30_000);
  timer.callback();
  assert.deepEqual(h.sockets[0].sent, [{ type: "keepalive" }]);
});

test("close diagnostics retain code and duration and status refresh respects retry backoff", async () => {
  const h = harness();
  h.resolveTicket();
  await h.ensureAccountLiveConnection(account);
  h.sockets[0].open();
  h.advance(45_000);
  h.sockets[0].readyState = 3;
  h.sockets[0].listeners.close({ code: 1006, wasClean: false, reason: "secret payload" });
  const close = h.logs.find((log) => log.event === "disconnected");
  assert.equal(close.details.close_code, 1006);
  assert.equal(close.details.was_clean, false);
  assert.equal(close.details.open_duration_ms, 45_000);
  assert.equal(JSON.stringify(close).includes("secret payload"), false);
  await h.ensureAccountLiveConnection(account);
  assert.equal(h.calls(), 1);
  const timer = [...h.timers.values()][0];
  timer.callback();
  await new Promise(setImmediate);
  assert.equal(h.calls(), 2);
});

test("readiness diagnostics publish changed states once without recording message content", async () => {
  let status = { ready: false, reason_code: "seller_chat_bridge_unavailable" };
  const logs = [];
  const sent = [];
  const socket = { readyState: 1, send: (data) => sent.push(JSON.parse(data)) };
  const connection = { socket, lastStatusKey: null };
  const start = source.indexOf("function statusPublishKey(status)");
  const end = source.indexOf("function scheduleKeepalive(context, socket)");
  const send = vm.runInNewContext(`(() => { ${source.slice(start, end)}; return sendConnectionStatus; })()`, {
    liveConnections: new Map([[account.key, connection]]),
    WebSocket: { OPEN: 1 }, connectionStatusSnapshot: async () => status,
    scheduleLeaderStatusRefresh: () => {}, scheduleKeepalive: () => {},
    recordLog: async (_level, _area, event, _message, details) => logs.push({ event, details }),
  });
  await send(socket, account);
  await send(socket, account);
  status = { ready: true, reason_code: "healthy" };
  await send(socket, account);
  assert.equal(sent.length, 2);
  assert.equal(logs.length, 2);
  assert.equal(logs[0].details.reason_code, "seller_chat_bridge_unavailable");
  assert.equal(logs[1].details.ready, true);
});

test("ticket timeout releases the guard even if the request never settles", async () => {
  const h = harness();
  const start = h.ensureAccountLiveConnection(account);
  await new Promise(setImmediate);
  [...h.timers.values()].find((timer) => timer.delay === 10_000).callback();
  await start;
  assert.equal(h.liveConnections.get(account.key).connecting, false);
  assert.ok(h.liveConnections.get(account.key).reconnectTimer);
  assert.equal(h.sockets.length, 0);
});

test("recent incoming socket activity suppresses unnecessary keepalive traffic", async () => {
  const h = harness();
  h.resolveTicket();
  await h.ensureAccountLiveConnection(account);
  h.sockets[0].open();
  const heartbeat = [...h.timers.values()].find((timer) => timer.delay === 20_000);
  h.advance(19_000);
  h.sockets[0].listeners.message({ data: "{}" });
  h.advance(1_000);
  heartbeat.callback();
  assert.equal(h.sockets[0].sent.length, 0);
  h.advance(20_000);
  heartbeat.callback();
  assert.equal(h.sockets[0].sent.length, 1);
});

test("duplicate commands share one provider operation and replay its acknowledgement", async () => {
  const pending = deferred();
  let sends = 0;
  const socket = { readyState: 1, sent: [], send(data) { this.sent.push(JSON.parse(data)); } };
  const command = { provider: "shopee", provider_account_id: "shop", request_id: "request", type: "send_text", text: "secret message" };
  const start = source.indexOf("async function handleLiveCommand(");
  const end = source.indexOf("\nchrome.storage.onChanged", start);
  const run = vm.runInNewContext(`(${source.slice(start, end).trim()})`, {
    liveCommandResults: new Map(), liveConnections: new Map(), scheduleKeepalive: () => {}, WebSocket: { OPEN: 1 }, Date,
    providerAdapterForCommand: () => ({ id: "shopee", supportsSend: () => true }),
    messageProviderAccountId: (value) => value.provider_account_id, canonicalProviderAccountId: () => "shop",
    exclusive: (action) => action(), sendViaProvider: () => { sends++; return pending.promise; },
    recordUnexpected: async () => {}, sendConnectionStatus: async () => {}, installationId: async () => "installation",
  });
  const context = { ...account, account: { provider: "shopee", provider_account_id: "shop" } };
  const first = run(JSON.stringify(command), context, socket);
  const duplicate = run(JSON.stringify(command), context, socket);
  assert.equal(sends, 1);
  pending.resolve({ ok: true, provider_message_id: "receipt" });
  await Promise.all([first, duplicate]);
  await run(JSON.stringify(command), context, socket);
  assert.equal(sends, 1);
  assert.equal(socket.sent.length, 3);
  assert.equal(JSON.stringify(socket.sent).includes("secret message"), false);
});
