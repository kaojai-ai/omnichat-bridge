import assert from "node:assert/strict";
import test from "node:test";

import {
  LOG_RETENTION_MS,
  createLogEntry,
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
