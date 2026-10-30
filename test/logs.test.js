import { createDiagnosticBuffer } from "../extension/lib/diagnostic-buffer.js";
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

import {
  LOG_RETENTION_MS,
  MAX_LOG_BYTES,
  logStorageBytes,
  availableLogBudget,
  createLogEntry,
  diagnosticErrorDetails,
  logEntryForUpload,
  pruneLogs,
  sanitizeSendDiagnostics,
} from "../extension/lib/logs.js";

test("background accepts route diagnostics and stores sanitized correlation details", async () => {
  const source = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
  const allowStart = source.indexOf("const INBOUND_LOG_MESSAGES =");
  const allowEnd = source.indexOf("\n};", allowStart) + 3;
  const recordStart = source.indexOf("let diagnosticsSuspended =");
  const recordEnd = source.indexOf("\nasync function recordUnexpected", recordStart);
  const listenerStart = source.indexOf("chrome.runtime.onMessage.addListener(");
  const listenerEnd = source.indexOf("\n});", listenerStart) + 4;
  const storage = {};
  let listener;
  let buffer;
  const context = vm.createContext({
    chrome: { runtime: { onMessage: { addListener: fn => { listener = fn; } } },
      storage: { local: { getBytesInUse: async () => 0, QUOTA_BYTES: 10 * 1024 * 1024 } } },
    STORAGE: { logs: "logs", logOutbox: "outbox" },
    createDiagnosticBuffer: options => (buffer = createDiagnosticBuffer({ ...options, setTimer: () => 1, clearTimer: () => {} })),
    mutateLogs: fn => fn(), readStorage: async () => storage,
    writeStorage: async value => Object.assign(storage, value),
    accountContextFor: () => null, hasServerInitialized: () => false,
    createLogEntry, pruneLogs, availableLogBudget,
  });
  vm.runInContext(source.slice(allowStart, allowEnd) + "\n"
    + source.slice(recordStart, recordEnd) + "\n" + source.slice(listenerStart, listenerEnd), context);
  const response = await new Promise(resolve => {
    assert.equal(listener({ type: "record_log", area: "provider", level: "info",
      event: "send_route_resolution", message: "untrusted page message",
      details: { provider_account_id: "@line-account-one", current_provider_account_id: "@line-account-two",
        request_id: "0123456789abcdef0123456789abcdef0123456789abcdef", cache_reason: "absent", pages: 2,
        stop_reason: "scoped_end", lookup_scope: "captured_filters", route_resolved: false,
        message_text: "private reply", request_url: "https://private.example", token: "private-token" },
    }, {}, resolve), true);
  });
  assert.equal(response.ok, true);
  assert.equal(storage.logs, undefined, "response acknowledges bounded admission, not a storage flush");
  await buffer.flush();
  assert.equal(storage.logs.length, 1);
  const entry = storage.logs[0];
  assert.equal(entry.event, "send_route_resolution");
  assert.equal(entry.message, "Shopee reply routing checked.");
  assert.deepEqual(entry.details, { provider_account_id: "@line-account-one", current_provider_account_id: "@line-account-two",
    request_id: "0123456789abcdef0123456789abcdef0123456789abcdef", cache_reason: "absent", pages: 2,
    stop_reason: "scoped_end", lookup_scope: "captured_filters", route_resolved: false });
  const rejected = await new Promise(resolve => listener({ type: "record_log", area: "provider",
    event: "unregistered_event" }, {}, resolve));
  assert.equal(rejected.ok, false);
  assert.equal(storage.logs.length, 1);

  await new Promise(resolve => listener({ type: "record_log", area: "provider", level: "error",
    event: "send_failed", message: "private provider message",
    details: { request_id: "request-123", conversation_id: "conversation-123",
      diagnostic_version: 1, ...Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`unused_${i}`, i])),
      native_error_code: "param_error", http_status: 200, route_shop_id: "207459663",
      request_recipient_id: "123456789", payload_shop_id_state: "absent", payload_shop_matches_route: false,
      failure_kind: "provider_rejection", message_text: "private reply", request_url: "https://private.example?token=secret" },
  }, {}, resolve));
  await buffer.flush();
  assert.equal(storage.logs[0].event, "send_failed");
  assert.equal(storage.logs[0].message, "Provider reply failed. See routing diagnostics.");
  assert.equal(storage.logs[0].details.native_error_code, "param_error");
  assert.equal(storage.logs[0].details.payload_shop_id_state, "absent");
  const popup = readFileSync(new URL("../extension/popup.js", import.meta.url), "utf8");
  const formatStart = popup.indexOf("function formatLogDetails(");
  const formatEnd = popup.indexOf("function safeFilenamePart(", formatStart);
  const exported = vm.runInNewContext(popup.slice(formatStart, formatEnd) + "\nformatSupportLogs()", { logs: storage.logs, logLevel: { value: "error" }, chrome: { runtime: { getManifest: () => ({ version: "0.6.64" }) } } });
  assert.match(exported, /native_error_code=param_error/);
  assert.match(exported, /request_recipient_id=123456789/);
  assert.match(exported, /request_id=request-123/);
  assert.match(exported, /provider_account_id=@line-account-one/);
  assert.match(exported, /current_provider_account_id=@line-account-two/);
  assert.match(exported, /request_id=0123456789abcdef0123456789abcdef0123456789abcdef/);
  assert.match(exported, /payload_shop_matches_route=false/);
  assert.doesNotMatch(exported, /private provider message|private reply|private.example|token=secret/);
  await new Promise(resolve => listener({ type: "record_log", area: "provider", level: "warn",
    event: "send_route_fallback", message: "untrusted fallback text",
    details: { request_id: "fallback-1", fallback_reason: "missing", missing_fields: "to_id",
      warning_code: "SHOPEE_LEGACY_ROUTE_FALLBACK", cookie: "secret", message_text: "private" },
  }, {}, resolve));
  await buffer.flush();
  assert.equal(storage.logs[0].level, "warn");
  assert.equal(storage.logs[0].event, "send_route_fallback");
  assert.match(storage.logs[0].message, /deprecated/);
  assert.equal(storage.logs[0].details.warning_code, "SHOPEE_LEGACY_ROUTE_FALLBACK");
  assert.equal(storage.logs[0].details.fallback_reason, "missing");
  assert.equal(storage.logs[0].details.missing_fields, "to_id");
  assert.equal(storage.logs[0].details.cookie, undefined);
  assert.equal(storage.logs[0].details.message_text, undefined);
});

test("log entries redact sensitive strings and detail keys", () => {
  const entry = createLogEntry({
    level: "error",
    area: "sync",
    event: "failed",
    message: "POST https://example.com/path?token=abc failed; bearer super-secret",
    details: {
      count: 3,
      hmac_secret: "do-not-store",
      request_url: "https://example.com/private",
      reason: "token=do-not-store",
      decision: "history_job",
    },
  }, Date.parse("2026-07-26T00:00:00.000Z"), "log-1");

  assert.equal(entry.message, "POST [url] failed; [authorization]");
  assert.deepEqual(entry.details, {
    count: 3,
    reason: "[redacted]",
    decision: "history_job",
  });
  assert.equal("hmac_secret" in entry.details, false);
});

test("logs older than two days are removed", () => {
  const now = Date.parse("2026-07-26T12:00:00.000Z");
  const recent = createLogEntry({ event: "recent" }, now - LOG_RETENTION_MS + 1, "recent");
  const expired = createLogEntry({ event: "expired" }, now - LOG_RETENTION_MS - 1, "expired");
  assert.deepEqual(pruneLogs([recent, expired], now).map((item) => item.id), ["recent"]);
});

test("retains more than 100 entries within the byte budget", () => {
  const now = Date.now();
  const entries = Array.from({ length: 1000 }, (_, index) => createLogEntry({ event: "useful_event" }, now - index, `log-${index}`));
  assert.equal(pruneLogs(entries, now).length, 1000);
  assert.ok(logStorageBytes(pruneLogs(entries, now)) <= MAX_LOG_BYTES);
});

test("remote log payload omits internal account routing", () => {
  const entry = createLogEntry({
    area: "sync",
    event: "started",
    account_key: "shopee:123",
  }, Date.parse("2026-07-26T00:00:00.000Z"), "log-1");
  assert.equal(logEntryForUpload(entry).account_key, undefined);
});

test("keeps useful raw exception details and message fingerprints", () => {
  const error = new Error("Target server returned 403: provider_account_not_participant");
  error.http_status = 403;
  error.server_error_code = "provider_account_not_participant";
  error.stack = "Error: Target server returned 403: provider_account_not_participant";
  const entry = createLogEntry({
    level: "error",
    area: "delivery",
    event: "failed",
    details: {
      ...diagnosticErrorDetails(error),
      provider_account_id: "100000001",
      message_id: "message-1",
      conversation_id: "conversation-1",
      message_fingerprint: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    },
  }, Date.parse("2026-07-26T00:00:00.000Z"), "log-diagnostic");

  assert.equal(entry.details.http_status, 403);
  assert.equal(entry.details.server_error_code, "provider_account_not_participant");
  assert.equal(entry.details.error_type, "Error");
  assert.match(entry.details.error_message, /Target server returned 403/);
  assert.match(entry.details.error_stack, /Target server returned 403/);
  assert.equal(entry.details.message_fingerprint, "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
});

test("retains safe delivery correlation details without message content", () => {
  const entry = createLogEntry({
    area: "message_delivery",
    event: "message_blocked",
    details: {
      provider: "line_oa",
      batch_id: "11111111-1111-4111-8111-111111111111",
      message_id: "message-1",
      conversation_id: "conversation-1",
      provider_type: "text",
      type: "text",
      has_text: true,
      text_length: 42,
      has_media: false,
      request_bytes: 4096,
      message_text: "do-not-store",
    },
  }, Date.parse("2026-07-26T00:00:00.000Z"), "log-delivery-correlation");

  assert.equal(entry.details.provider, "line_oa");
  assert.equal(entry.details.batch_id, "11111111-1111-4111-8111-111111111111");
  assert.equal(entry.details.text_length, 42);
  assert.equal(entry.details.request_bytes, 4096);
  assert.equal(entry.details.message_text, undefined);
});


test("send diagnostics allowlist excludes secrets, arbitrary strings, and oversized values", () => {
  assert.deepEqual(sanitizeSendDiagnostics({ diagnostic_version: 1, surface: "seller-centre",
    payload_shop_id_state: "absent", payload_shop_matches_route: false, native_error_code: "param_error",
    http_status: 200, provider_duration_ms: 500, text: "private message", cookie: "secret", shop_id: "123",
    endpoint_path: "https://private.example?token=secret", route_source: "private value",
  }), { diagnostic_version: 1, surface: "seller-centre", payload_shop_id_state: "absent",
    payload_shop_matches_route: false, native_error_code: "param_error", http_status: 200, provider_duration_ms: 500 });
  assert.equal(sanitizeSendDiagnostics({ surface: "legacy" }), undefined);
  assert.deepEqual(sanitizeSendDiagnostics({ diagnostic_version: 1, provider_duration_ms: Infinity, http_status: 999 }), { diagnostic_version: 1 });
  const entry = createLogEntry({ details: { diagnostic_version: 1, payload_shop_id_state: "absent",
    payload_shop_matches_route: false, endpoint_path: "/webchat/api/v1.2/mini/messages", payload: "secret", request_url: "https://private.example" } });
  assert.deepEqual(entry.details, { diagnostic_version: 1, payload_shop_id_state: "absent",
    payload_shop_matches_route: false, endpoint_path: "/webchat/api/v1.2/mini/messages" });
});

test("discovery noise cannot evict the last send failure before retention expires", () => {
  const now = Date.now();
  const failure = createLogEntry({ level: "error", event: "send_api" }, now - 1000, "failure");
  const entries = Array.from({ length: 150 }, (_, i) => createLogEntry({ event: "account_detected" }, now - i, `noise-${i}`));
  const retained = pruneLogs([...entries, failure], now);
  assert.ok(logStorageBytes(retained) <= MAX_LOG_BYTES);
  assert.equal(retained.at(-1).id, "failure");
});


test("byte budget includes UTF-8 data and optional outbox references", () => {
  const now = Date.now();
  const entries = Array.from({ length: 2000 }, (_, i) => createLogEntry({ event: "event", message: "ทดสอบ".repeat(50) }, now - i, `entry-${i}`));
  const budget = 32 * 1024;
  const retained = pruneLogs(entries, now, budget);
  assert.ok(retained.length > 0 && retained.length < entries.length);
  assert.ok(logStorageBytes(retained) + logStorageBytes(retained.map(entry => entry.id)) <= budget);
  assert.deepEqual(pruneLogs(entries, now, 0), []);
  const failure = createLogEntry({ level: "error", event: "send_failed", message: "param_error" }, now - 3000, "failure");
  assert.equal(pruneLogs([...entries, failure], now, budget).at(-1).id, "failure");
});

test("log budget leaves Chrome quota headroom as other extension data grows", () => {
  const MiB = 1024 * 1024;
  assert.equal(availableLogBudget(2 * MiB, 0, 10 * MiB), 4 * MiB);
  assert.equal(availableLogBudget(9 * MiB, 2 * MiB, 10 * MiB), 2 * MiB);
  assert.equal(availableLogBudget(10 * MiB, 0, 10 * MiB), 0);
});

test("invalid routing IDs cannot bypass the diagnostic allowlist through generic details", () => {
  const entry = createLogEntry({ details: { diagnostic_version: 1, request_shop_id: "private-text",
    query_shop_id: { token: "secret" }, route_recipient_id: "123456789" } });
  assert.deepEqual(entry.details, { diagnostic_version: 1, route_recipient_id: "123456789" });
});


test("provider diagnostics retain bounded error context and classify status without response descriptions", () => {
  const error = new Error("private provider echo customer text");
  error.diagnostics = { diagnostic_version: 1, provider: "line_oa", operation: "send", command_type: "send_text",
    http_status: 400, failure_kind: "provider_rejection", native_error_code: "INVALID_ARGUMENT",
    validation_fields: ["text", "sendId", "private-input", "text"], response_format: "json", native_attempted: true,
    delivery_uncertain: false, payload: { token: "private-credential" }, response: "private response" };
  const entry = createLogEntry({ level: "error", details: diagnosticErrorDetails(error) });
  assert.equal(entry.details.category, "invalid_request");
  assert.equal(entry.details.native_error_code, "INVALID_ARGUMENT");
  assert.equal(entry.details.validation_fields, "text,sendId");
  assert.deepEqual(sanitizeSendDiagnostics(entry.details), sanitizeSendDiagnostics(error.diagnostics));
  assert.equal(entry.details.operation, "send");
  assert.equal(entry.details.delivery_uncertain, false);
  assert.doesNotMatch(JSON.stringify(logEntryForUpload(entry)), /private|customer text/);
  error.diagnostics = { diagnostic_version: 1, provider: "line_oa", operation: "send", timed_out: true, failure_kind: "transport_failure" };
  assert.equal(diagnosticErrorDetails(error).category, "timeout");
});

test("diagnostic-only fields cannot bypass typed validation through generic details", () => {
  const entry = createLogEntry({ details: { diagnostic_version: 1, operation: "customer-secret", stage: "private-url",
    response_format: "private-body", validation_fields: ["secret"], provider_code_present: "secret" } });
  for (const key of ["operation", "stage", "response_format", "validation_fields", "provider_code_present"]) assert.equal(entry.details[key], undefined);
});


test("structured provider rate limits and HTTP200 rejections have useful categories", () => {
  const error = { message: "private provider description", diagnostics: { diagnostic_version: 1, failure_kind: "provider_rejection", http_status: 429 } };
  assert.equal(diagnosticErrorDetails(error).category, "rate_limited");
  error.diagnostics.http_status = 200;
  assert.equal(diagnosticErrorDetails(error).category, "provider_rejection");
});


test("unreadable provider response diagnostics do not store parser excerpts", () => {
  const error = new SyntaxError("Unexpected token in private-provider-body");
  error.diagnostics = { diagnostic_version: 1, provider: "shopee", operation: "upload", error_name: "SyntaxError", failure_kind: "unrecognized_response", http_status: 200 };
  const entry = createLogEntry({ details: diagnosticErrorDetails(error) });
  assert.equal(entry.details.error_name, "SyntaxError");
  assert.doesNotMatch(JSON.stringify(entry), /private-provider-body/);
});


test("unrecognized native codes cannot carry arbitrary provider strings into support logs", () => {
  const entry = createLogEntry({ details: { diagnostic_version: 1, native_error_code: "privateCustomerValue123" } });
  assert.equal(entry.details.native_error_code, undefined);
  assert.equal(entry.details.provider_code_present, true);
  assert.doesNotMatch(JSON.stringify(entry), /privateCustomerValue123/);
});

test("all retained diagnostics are queued, including unscoped DEBUG and repeated routine events", async () => {
  const source = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
  const storage = {};
  let buffer;
  const record = vm.runInNewContext(source.slice(source.indexOf("let diagnosticsSuspended ="), source.indexOf("\nasync function recordUnexpected")) + "\nrecordLog", {
    STORAGE: { logs: "logs", logOutbox: "outbox" },
    chrome: { storage: { local: { getBytesInUse: async () => 0, QUOTA_BYTES: 10 * 1024 * 1024 } } },
    createDiagnosticBuffer: options => (buffer = createDiagnosticBuffer({ ...options, setTimer: () => 1, clearTimer: () => {} })),
    mutateLogs: fn => fn(), readStorage: async () => storage,
    writeStorage: async value => Object.assign(storage, value),
    accountContextFor: () => null,
    createLogEntry, pruneLogs, availableLogBudget,
  });
  for (const level of ["debug", "info", "warn", "error"]) {
    await record(level, "provider", "account_detected", "Account detection observed.");
    await record(level, "provider", "account_detected", "Account detection observed.");
  }
  await buffer.drain();
  assert.equal(storage.logs.length, 8);
  assert.equal(storage.outbox.length, 8);
  assert.equal(new Set(storage.outbox).size, 8);
  assert.ok(storage.logs.every(entry => !entry.account_key));
  assert.deepEqual(new Set(storage.outbox), new Set(storage.logs.map(entry => entry.id)));
});

test("diagnostic admission failure is nonthrowing and is not acknowledged", async () => {
  const source = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
  const record = vm.runInNewContext(source.slice(source.indexOf("async function recordLog("), source.indexOf("\nasync function recordUnexpected")) + "\nrecordLog", {
    diagnosticsSuspended: false,
    diagnosticBuffer: { enqueue: () => { throw new Error("Admission unavailable"); } },
  });
  assert.equal(await record("error", "provider", "recovery_failed", "Failed."), false);
});

test("account identifier relaxation still rejects emails, URLs, free text and credentials", () => {
  for (const value of ["person@example.com", "@person@example.com", "@", "@line account", "https://line.example/account", "token=private", "@" + "a".repeat(201)]) {
    const entry = createLogEntry({ details: { provider_account_id: value } });
    assert.equal(entry.details.provider_account_id, "[redacted]", value);
  }
  const entry = createLogEntry({ details: {
    request_id: "a".repeat(48), provider_account_id: "@line-one",
    message_text: "private chat", authorization: "Bearer private", cookie: "private",
    request_body: "private", request_url: "https://private.example", hmac_secret: "private",
    reason: "a".repeat(48),
  } });
  assert.deepEqual(entry.details, {
    request_id: "a".repeat(48), provider_account_id: "@line-one", reason: "[redacted]",
  });
});

test("upload preserves installation scope while excluding internal routing", () => {
  const uploaded = logEntryForUpload({ ...createLogEntry({ level: "debug", event: "initializing" }),
    account_key: "shopee:transport-route", scope: "installation" });
  assert.equal(uploaded.scope, "installation");
  assert.equal(uploaded.level, "debug");
  assert.equal(uploaded.account_key, undefined);
});
