import { createSessionEligibility } from "../extension/lib/session-eligibility.js";
import { createStatusReporter } from "../extension/lib/status-reporter.js";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { sanitizeSendDiagnostics, createLogEntry, logEntryForUpload, diagnosticErrorDetails } from "../extension/lib/logs.js";

const source = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");

function verifiedSession(key) {
  const eligibility = createSessionEligibility({ setTimer: () => 1, clearTimer: () => {} });
  eligibility.observe(key, { hasTab: true, verified: true });
  return eligibility;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness(overrides = {}) {
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
    migrationConnections: new Map(), migrationRetries: new Map(),
    liveCommandResults: new Map(),
    STORAGE: { config: "config" }, readStorage: async () => ({}),
    readAccountState: () => ({}),
    accountMigration: () => ({ status: "custom" }),
    Date: { now: () => now },
    liveEndpoint: () => true,
    updateLiveState: async () => {},
    recordLog: async (level, _area, event, _message, details) => logs.push({ level, event, details }),
    recordUnexpected: async () => {},
    signedLiveTicket: async () => { ticketCalls++; return ticket.promise; },
    sendConnectionStatus: async () => {},
    handleLiveCommand: async () => {},
    setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
    setInterval: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearInterval: (id) => timers.delete(id),
    ...overrides,
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

test("simultaneous account migration writes preserve both accounts and imported replacements", async () => {
  const oldA = { provider: "shopee", provider_account_id: "a", api_url: "https://old.invalid/a" };
  const oldB = { ...oldA, provider_account_id: "b", api_url: "https://old.invalid/b" };
  const newA = { ...oldA, api_url: "https://new.invalid/a" };
  const newB = { ...oldB, api_url: "https://new.invalid/b" };
  let stored = { config: { version: 3, history_days: 5, accounts: [oldA, oldB] } };
  const implementation = source.slice(source.indexOf("let migrationWrites ="), source.indexOf("async function ensureAccountLiveConnection(context)"));
  const persist = vm.runInNewContext(`(() => { ${implementation}; return persistAccountMigration; })()`, {
    STORAGE: { config: "config", status: "status" }, migrationRetries: new Map(),
    accountConfigKey: (value) => `${value.provider}:${value.provider_account_id}`,
    readStorage: async () => structuredClone(stored),
    writeStorage: async (values) => { await new Promise(setImmediate); stored = { ...stored, ...values }; },
    updateScopedState: async () => {},
  });
  await Promise.all([
    persist({ key: "shopee:a", config: newA }, oldA),
    persist({ key: "shopee:b", config: newB }, oldB),
  ]);
  assert.deepEqual(structuredClone(stored.config.accounts), [newA, newB]);
  assert.equal(stored.config.history_days, 5);
  const imported = { ...newA, api_url: "https://custom.invalid/imported" };
  stored.config.accounts[0] = imported;
  await persist({ key: "shopee:a", config: newA }, oldA);
  assert.deepEqual(stored.config.accounts[0], imported);
});

test("migration verifies the candidate but persists only after its real socket opens", async () => {
  const calls = [];
  const candidate = { api_url: "https://example.invalid/api", logs_url: "https://example.invalid/logs" };
  const h = harness({
    accountMigration: () => ({ status: "pending", candidate }),
    chrome: { permissions: { contains: async () => true } },
    signedApiPing: async () => calls.push("ping"),
    signedLeaderRequest: async (_context, action) => calls.push(action),
    persistAccountMigration: async () => calls.push("persist"),
  });
  h.resolveTicket();
  await h.ensureAccountLiveConnection(account);
  assert.deepEqual(calls, ["ping", "status"]);
  assert.equal(h.sockets.length, 1);
  h.sockets[0].open();
  assert.deepEqual(calls, ["ping", "status", "persist"]);
});

test("migration permission failure retains legacy transport and applies retry backoff", async () => {
  const states = [];
  const h = harness({
    accountMigration: () => ({ status: "pending", candidate: { api_url: "https://example.invalid/api", logs_url: "https://example.invalid/logs" } }),
    chrome: { permissions: { contains: async () => false } },
    updateScopedState: async (_storage, _key, state) => states.push(state),
    STORAGE: { config: "config", status: "status" },
  });
  h.resolveTicket();
  await h.ensureAccountLiveConnection(account);
  assert.equal(h.liveConnections.get(account.key).config, account.config);
  assert.equal(states[0].migration_pending, true);
  assert.equal(h.sockets.length, 1);
});

test("legacy storage notifications cannot replace a candidate during handshake or persistence", async () => {
  const persistence = deferred();
  let persisted = 0;
  let pings = 0;
  const candidate = { api_url: "https://example.invalid/api", logs_url: "https://example.invalid/logs" };
  const h = harness({
    accountMigration: () => ({ status: "pending", candidate }),
    chrome: { permissions: { contains: async () => true } },
    signedApiPing: async () => { pings++; },
    signedLeaderRequest: async () => {},
    persistAccountMigration: async () => { persisted++; await persistence.promise; },
  });
  h.resolveTicket();
  await h.ensureAccountLiveConnection(account);
  const socket = h.sockets[0];
  await h.ensureAccountLiveConnection(account);
  assert.equal(h.sockets.length, 1);
  assert.equal(socket.readyState, 0);
  assert.equal(pings, 1);
  socket.open();
  await h.ensureAccountLiveConnection(account);
  assert.equal(socket.readyState, 1);
  assert.equal(h.sockets.length, 1);
  assert.equal(persisted, 1);
  persistence.resolve();
  await new Promise(setImmediate);
});

test("candidate ticket failure retains source and persists migration retry state", async () => {
  const states = [];
  const h = harness({
    accountMigration: () => ({ status: "pending", candidate: { api_url: "https://example.invalid/api", logs_url: "https://example.invalid/logs" } }),
    chrome: { permissions: { contains: async () => true } },
    signedApiPing: async () => {}, signedLeaderRequest: async () => {},
    updateScopedState: async (_storage, _key, state) => states.push(state),
  });
  const start = h.ensureAccountLiveConnection(account);
  await new Promise(setImmediate);
  h.ticket.reject(new Error("New server unavailable."));
  await start;
  assert.equal(h.liveConnections.get(account.key).config, account.config);
  assert.equal(states[0].migration_pending, true);
  assert.ok(states[0].migration_retry_at > 0);
  assert.equal(h.sockets.length, 0);
});

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
    createStatusReporter: options => createStatusReporter({ ...options, id: () => "report", setTimer: () => 1, clearTimer: () => {} }),
    scheduleLeaderStatusRefresh: () => {}, scheduleKeepalive: () => {},
    recordLog: async (level, _area, event, _message, details) => logs.push({ level, event, details }),
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
    sessionEligibility: verifiedSession(account.key), activeLiveCommandContexts: async contexts => contexts,
    providerAdapterForCommand: () => ({ id: "shopee", supportsSend: () => true }),
    messageProviderAccountId: (value) => value.provider_account_id, canonicalProviderAccountId: () => "shop",
    replyQueue: { run: (_account, action) => action() }, sendViaProvider: () => { sends++; return pending.promise; },
    recordUnexpected: async () => {}, sendConnectionStatus: async () => {}, installationId: async () => "installation",
  });
  const context = { ...account, account: { provider: "shopee", provider_account_id: "shop" } };
  const first = run(JSON.stringify(command), context, socket);
  const duplicate = run(JSON.stringify(command), context, socket);
  await new Promise(setImmediate);
  assert.equal(sends, 1);
  pending.resolve({ ok: true, provider_message_id: "receipt" });
  await Promise.all([first, duplicate]);
  await run(JSON.stringify(command), context, socket);
  assert.equal(sends, 1);
  assert.equal(socket.sent.length, 3);
  assert.equal(JSON.stringify(socket.sent).includes("secret message"), false);
});


test("failed LINE commands retain safe provider evidence locally and in upload without changing server acknowledgements", async () => {
  const logs = [];
  const socket = { readyState: 1, sent: [], send(data) { this.sent.push(JSON.parse(data)); } };
  const command = { provider: "line_oa", provider_account_id: "oa", request_id: "request-line", type: "send_text", text: "private message" };
  const start = source.indexOf("async function handleLiveCommand(");
  const end = source.indexOf("\nchrome.storage.onChanged", start);
  const diagnostics = { diagnostic_version: 1, provider: "line_oa", operation: "send", http_status: 400,
    native_error_code: "INVALID_REQUEST", native_attempted: true, delivery_uncertain: false,
    body: "private message", cookie: "secret", access_token: "secret" };
  const run = vm.runInNewContext(`(${source.slice(start, end).trim()})`, {
    liveCommandResults: new Map(), liveConnections: new Map(), scheduleKeepalive: () => {}, WebSocket: { OPEN: 1 }, Date,
    sessionEligibility: verifiedSession("line_oa:oa"), activeLiveCommandContexts: async contexts => contexts,
    providerAdapterForCommand: () => ({ id: "line_oa", supportsSend: () => true }),
    messageProviderAccountId: value => value.provider_account_id, canonicalProviderAccountId: () => "oa",
    replyQueue: { run: (_account, action) => action() },
    sendViaProvider: async () => ({ ok: false, error: "LINE OA send failed (400).", diagnostics }),
    sanitizeSendDiagnostics,
    recordUnexpected: async (_scope, _error, details) => logs.push(createLogEntry({ level: "error", area: "live_command", event: "failed", details })),
    sendConnectionStatus: async () => {}, installationId: async () => "installation",
  });
  await run(JSON.stringify(command), { key: "line_oa:oa", account: { provider: "line_oa", provider_account_id: "oa" } }, socket);
  assert.equal(logs.length, 1);
  for (const entry of [logs[0], logEntryForUpload(logs[0])]) {
    assert.equal(entry.details.request_id, "request-line");
    assert.equal(entry.details.command_type, "send_text");
    assert.equal(entry.details.provider, "line_oa");
    assert.equal(entry.details.http_status, 400);
    assert.equal(entry.details.native_error_code, "INVALID_REQUEST");
    assert.doesNotMatch(JSON.stringify(entry), /private message|secret|access_token|cookie/);
  }
  assert.deepEqual(socket.sent, [{ type: "send_result", request_id: "request-line", ok: false, error: "LINE OA send failed (400)." }]);
});


test("unexpected errors classify structured provider status and timeout while preserving stack and cause", async () => {
  const entries = [];
  const start = source.indexOf("async function recordUnexpected(");
  const end = source.indexOf("\nfunction registerGlobalErrorHandlers", start);
  const record = vm.runInNewContext(`(${source.slice(start, end).trim()})`, {
    sanitizeSendDiagnostics, diagnosticErrorDetails,
    recordLog: async (_level, _area, _event, _message, details) => entries.push(details),
  });
  await record("live_command", "LINE OA request failed.", {
    diagnostic_version: 1, provider: "line_oa", operation: "send", http_status: 400,
  });
  assert.equal(entries[0].category, "invalid_request");
  const error = new Error("LINE OA request failed.", { cause: new Error("Transport failed.") });
  await record("live_command", error, {
    diagnostic_version: 1, provider: "line_oa", operation: "send", timed_out: true,
  });
  assert.equal(entries[1].category, "timeout");
  assert.equal(entries[1].error_stack, error.stack);
  assert.equal(entries[1].cause_message, "Transport failed.");
});


test("approved permissions clear persisted warnings without replacing a healthy legacy socket", async () => {
  for (const warning of [
    { migration_error: "Open configuration and save it to approve the new server access." },
    { migration_error: "Server access needed", migration_error_code: "server_permission_required" },
  ]) {
    const states = [];
    const retries = new Map([[account.key, { attempt: 4, nextAt: 3600000 }]]);
    const candidate = { api_url: "https://new.invalid/api", logs_url: "https://logs.invalid/logs" };
    const h = harness({
      migrationRetries: retries,
      readAccountState: () => ({ ...warning, migration_pending: true, migration_retry_at: 3600000 }),
      accountMigration: () => ({ status: "pending", candidate }),
      chrome: { permissions: { contains: async ({ origins }) => {
        assert.deepEqual(Array.from(origins), ["https://new.invalid/*", "https://logs.invalid/*"]);
        return true;
      } } },
      updateScopedState: async (_storage, _key, state) => states.push(state),
    });
    const socket = { readyState: 1 };
    h.liveConnections.set(account.key, { socket, config: account.config });
    await h.ensureAccountLiveConnection(account);
    assert.equal(h.liveConnections.get(account.key).socket, socket);
    assert.equal(h.calls(), 0);
    assert.equal(retries.size, 0);
    assert.equal(states.length, 1);
    assert.equal(states[0].migration_error, null);
    assert.equal(states[0].migration_retry_at, 0);
    assert.equal(states[0].migration_pending, true);
  }
});

test("denied permissions and unrelated migration failures retain their warning", async () => {
  for (const migration_error of [
    "Open configuration and save it to approve the new server access.",
    "API ping failed",
  ]) {
    const states = [];
    const h = harness({
      readAccountState: () => ({ migration_error, migration_pending: true }),
      accountMigration: () => ({ status: "pending", candidate: {
        api_url: "https://new.invalid/api", logs_url: "https://logs.invalid/logs",
      } }),
      chrome: { permissions: { contains: async () => migration_error === "API ping failed" } },
      updateScopedState: async (_storage, _key, state) => states.push(state),
    });
    h.liveConnections.set(account.key, { socket: { readyState: 1 }, config: account.config });
    await h.ensureAccountLiveConnection(account);
    assert.equal(states.length, 0);
  }
});

test("importing current configuration removes obsolete migration failure state", async () => {
  const states = [];
  const h = harness({
    readAccountState: () => ({ migration_pending: true, migration_error: "API ping failed" }),
    updateScopedState: async (_storage, _key, state) => states.push(state),
  });
  h.liveConnections.set(account.key, { socket: { readyState: 1 }, config: account.config });
  await h.ensureAccountLiveConnection(account);
  assert.equal(states[0].migration_pending, false);
  assert.equal(states[0].migration_error, null);
});


test("granting and revoking browser permissions reconcile regional access", async () => {
  const listeners = [];
  let calls = 0;
  const start = source.indexOf("chrome.permissions.onAdded.addListener(");
  const end = source.indexOf("async function refreshRegionalShopeePermissions(", start);
  vm.runInNewContext(source.slice(start, end), {
    chrome: { permissions: {
      onAdded: { addListener: callback => listeners.push(callback) },
      onRemoved: { addListener: callback => listeners.push(callback) },
    } },
    refreshRegionalShopeePermissions: async () => { calls++; },
    recordUnexpected: () => assert.fail("unexpected reconciliation failure"),
  });
  for (const listener of listeners) listener();
  assert.equal(calls, 2);
});


test("approval bypasses permission backoff when a natural reconnect is available", async () => {
  const calls = [];
  const candidate = { api_url: "https://new.invalid/api", logs_url: "https://logs.invalid/logs" };
  const h = harness({
    readAccountState: () => ({ migration_pending: true, migration_retry_at: 3600000,
      migration_error: "Open configuration and save it to approve the new server access." }),
    accountMigration: () => ({ status: "pending", candidate }),
    chrome: { permissions: { contains: async () => true } },
    updateScopedState: async () => {},
    signedApiPing: async () => calls.push("ping"),
    signedLeaderRequest: async () => calls.push("status"),
  });
  h.resolveTicket();
  await h.ensureAccountLiveConnection(account);
  assert.deepEqual(calls, ["ping", "status"]);
  assert.equal(h.liveConnections.get(account.key).config, candidate);
});


test("intentional stop is silent but clean remote closure remains a warning", async () => {
  const h = harness();
  h.resolveTicket();
  await h.ensureAccountLiveConnection(account);
  h.sockets[0].open();
  h.stopLiveConnection();
  assert.equal(h.logs.some(log => log.event === "disconnected"), false);
  await h.ensureAccountLiveConnection(account);
  h.sockets[1].open();
  h.advance(1200);
  h.sockets[1].close();
  const disconnected = h.logs.find(log => log.event === "disconnected");
  assert.equal(disconnected.level, "warn");
  assert.equal(disconnected.details.reason_code, "connection_closed");
  assert.equal(disconnected.details.close_code, 1000);
  assert.equal(disconnected.details.was_clean, true);
  assert.equal(disconnected.details.open_duration_ms, 1200);
  assert.equal(disconnected.details.reconnect_attempt, 1);
});
