import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

import {
  LOG_RETENTION_MS,
  MAX_LOG_ENTRIES,
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
  const recordStart = source.indexOf("async function recordLog(");
  const recordEnd = source.indexOf("\nasync function recordUnexpected", recordStart);
  const listenerStart = source.indexOf("chrome.runtime.onMessage.addListener(");
  const listenerEnd = source.indexOf("\n});", listenerStart) + 4;
  const storage = {};
  let listener;
  const context = vm.createContext({
    chrome: { runtime: { onMessage: { addListener: fn => { listener = fn; } } } },
    STORAGE: { logs: "logs", logOutbox: "outbox" },
    mutateLogs: fn => fn(), readStorage: async () => storage,
    writeStorage: async value => Object.assign(storage, value),
    accountContextFor: () => null, hasServerInitialized: () => false,
    createLogEntry, pruneLogs,
  });
  vm.runInContext(source.slice(allowStart, allowEnd) + "\n"
    + source.slice(recordStart, recordEnd) + "\n" + source.slice(listenerStart, listenerEnd), context);
  const response = await new Promise(resolve => {
    assert.equal(listener({ type: "record_log", area: "provider", level: "info",
      event: "send_route_resolution", message: "untrusted page message",
      details: { request_id: "request-123", cache_reason: "absent", pages: 2,
        stop_reason: "scoped_end", lookup_scope: "captured_filters", route_resolved: false,
        message_text: "private reply", request_url: "https://private.example", token: "private-token" },
    }, {}, resolve), true);
  });
  assert.equal(response.ok, true);
  assert.equal(storage.logs.length, 1);
  const entry = storage.logs[0];
  assert.equal(entry.event, "send_route_resolution");
  assert.equal(entry.message, "Shopee reply routing checked.");
  assert.deepEqual(entry.details, { request_id: "request-123", cache_reason: "absent", pages: 2,
    stop_reason: "scoped_end", lookup_scope: "captured_filters", route_resolved: false });
  const rejected = await new Promise(resolve => listener({ type: "record_log", area: "provider",
    event: "unregistered_event" }, {}, resolve));
  assert.equal(rejected.ok, false);
  assert.equal(storage.logs.length, 1);
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

test("keeps only the newest 100 logs", () => {
  const now = Date.parse("2026-07-26T12:00:00.000Z");
  const entries = Array.from({ length: 101 }, (_, index) => (
    createLogEntry({ event: `event-${index}` }, now - index, `log-${index}`)
  ));
  const retained = pruneLogs(entries, now);

  assert.equal(MAX_LOG_ENTRIES, 100);
  assert.equal(retained.length, 100);
  assert.equal(retained.at(-1).id, "log-99");
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
  assert.equal(retained.length, MAX_LOG_ENTRIES);
  assert.equal(retained.at(-1).id, "failure");
});
