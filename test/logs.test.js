import assert from "node:assert/strict";
import test from "node:test";

import {
  LOG_RETENTION_MS,
  createLogEntry,
  diagnosticErrorDetails,
  logEntryForUpload,
  pruneLogs,
} from "../extension/lib/logs.js";

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
      provider_account_id: "1549058683",
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
