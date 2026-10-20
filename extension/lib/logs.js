export const LOG_RETENTION_MS = 2 * 24 * 60 * 60_000;
export const MAX_LOG_BYTES = 4 * 1024 * 1024;
const FAILURE_RESERVE_BYTES = MAX_LOG_BYTES / 4;
const STORAGE_HEADROOM_BYTES = 1024 * 1024;
const ROUTINE_LOG_INTERVAL_MS = 5 * 60_000;
const DROPPED_ROUTINE_EVENTS = new Set(["provider.content_ready", "account.detected", "account.detection_started"]);

const LEVELS = new Set(["debug", "info", "warn", "error"]);
const BLOCKED_DETAIL_KEY = /authorization|body|content|cookie|credential|headers?|hmac|message_text|password|payload|secret|token|url/i;
const RAW_ERROR_DETAIL_LIMITS = new Map([
  ["error_message", 500],
  ["error_stack", 2_000],
  ["cause_message", 500],
]);
const IDENTIFIER_DETAIL_KEYS = new Set([
  "category",
  "batch_id",
  "server_error_code",
  "provider_account_id",
  "message_key",
  "message_id",
  "conversation_id",
  "sender_id",
  "recipient_id",
  "sender_account_id",
  "recipient_account_id",
  "event_timestamp",
  "capture_method",
  "message_fingerprint",
]);

const SEND_DIAGNOSTIC_ID_KEYS = ["route_shop_id", "route_recipient_id", "route_recipient_shop_id", "route_business_id",
  "request_shop_id", "request_recipient_id", "request_recipient_shop_id", "request_business_id",
  "query_shop_id", "query_business_id", "choice_shop_id", "request_conversation_id"];

// Explicit, bounded local support diagnostics. Only known numeric routing IDs;
// never message text, request/response bodies, full URLs, headers, or credentials.
export function sanitizeSendDiagnostics(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || input.diagnostic_version !== 1) return undefined;
  const result = { diagnostic_version: 1 };
  const enums = {
    surface: ["new-webchat", "seller-centre"],
    endpoint_path: ["/webchat/api/v1.2/messages", "/webchat/api/v1.2/mini/messages"],
    command_type: ["send_text", "send_image", "send_video", "send_product"],
    template_source: ["captured", "derived"], route_source: ["command", "cache", "lookup"],
    cache_reason: ["complete", "incomplete", "shop_mismatch", "ambiguous_shop", "absent"],
    failure_kind: ["provider_rejection", "unrecognized_response", "transport_failure", "pre_dispatch_failure"],
  };
  for (const key of ["payload_conversation_id_state", "payload_shop_id_state", "payload_to_id_state", "payload_to_shop_id_state", "payload_biz_id_state", "quoted_message_id_state"]) {
    enums[key] = ["absent", "number", "string", "other"];
  }
  for (const [key, allowed] of Object.entries(enums)) {
    if (allowed.includes(input[key])) result[key] = input[key];
  }
  for (const key of ["route_resolved", "route_shop_matches_account", "payload_conversation_matches_route", "payload_to_shop_matches_route", "payload_biz_matches_route", "payload_shop_matches_route", "payload_to_matches_route",
    "url_shop_matches_route", "url_biz_matches_route", "choice_shop_matches_route", "native_attempted", "delivery_uncertain", "client_id_is_uuid"]) {
    if (typeof input[key] === "boolean") result[key] = input[key];
  }
  if (typeof input.native_error_code === "string" && /^[a-zA-Z0-9_]{1,64}$/.test(input.native_error_code)) {
    result.native_error_code = input.native_error_code;
  }
  if (Number.isInteger(input.http_status) && input.http_status >= 100 && input.http_status <= 599) result.http_status = input.http_status;
  if (Number.isFinite(input.provider_duration_ms) && input.provider_duration_ms >= 0 && input.provider_duration_ms <= 300_000) {
    result.provider_duration_ms = input.provider_duration_ms;
  }
  for (const key of SEND_DIAGNOSTIC_ID_KEYS) {
    const id = typeof input[key] === "number" || typeof input[key] === "string" ? String(input[key]) : "";
    if (/^\d{1,32}$/.test(id)) result[key] = id;
  }
  if (Number.isInteger(input.text_length) && input.text_length >= 0 && input.text_length <= 20_000) result.text_length = input.text_length;
  return result;
}

function safeName(value, fallback) {
  const name = String(value ?? "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(name) ? name : fallback;
}

export function sanitizeLogText(value, maxLength = 300) {
  return String(value ?? "")
    .replace(/\bhttps?:\/\/[^\s)]+/gi, "[url]")
    .replace(/\b(?:bearer|basic)\s+[^\s,;]+/gi, "[authorization]")
    .replace(/\b(authorization|cookie|hmac_secret|password|secret|token)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\b[A-Za-z0-9+/_=-]{32,}\b/g, "[redacted]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, maxLength);
}

function errorText(error) {
  return typeof error?.message === "string" && error.message.trim()
    ? error.message
    : String(error ?? "Unknown error.");
}

function errorCode(error, text) {
  const explicit = typeof error?.server_error_code === "string"
    ? error.server_error_code.trim()
    : "";
  if (explicit) return explicit;
  return text.match(/returned\s+[1-5]\d{2}:\s*([A-Za-z][A-Za-z0-9._-]{0,63})/i)?.[1] ?? "";
}

function errorCategory(text, status) {
  if (/not configured|setup is required/i.test(text)) return "not_configured";
  if (/timed out|timeout/i.test(text)) return "timeout";
  if (/429|rate limit/i.test(text)) return "rate_limited";
  if (status === 401 || status === 403 || /unauthorized|forbidden/i.test(text)) return "unauthorized";
  if (/acknowledgement is invalid/i.test(text)) return "invalid_acknowledgement";
  if (/refresh|loading|initializ/i.test(text)) return "provider_not_ready";
  if (/returned [5]\d{2}|unavailable|network|fetch/i.test(text)) return "network";
  return "unknown";
}

function sanitizeIdentifier(value) {
  const text = String(value ?? "").trim();
  return /^[-A-Za-z0-9._:+]{1,200}$/.test(text) ? text : "[redacted]";
}

export function diagnosticErrorDetails(error) {
  const text = errorText(error);
  const status = Number(error?.http_status) || Number(text.match(/\b([1-5]\d{2})\b/)?.[1]) || null;
  const code = errorCode(error, text);
  return {
    category: errorCategory(text, status),
    ...(status ? { http_status: status } : {}),
    error_type: typeof error?.name === "string" && error.name.trim() ? error.name : "Error",
    error_message: text,
    ...(typeof error?.stack === "string" && error.stack.trim() ? { error_stack: error.stack } : {}),
    ...(code ? { server_error_code: code } : {}),
    ...(error?.cause && typeof error.cause?.message === "string"
      ? { cause_message: error.cause.message }
      : {}),
  };
}

export function sanitizeLogDetails(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const sendDiagnostics = sanitizeSendDiagnostics(value) ?? {};
  const details = { ...sendDiagnostics };
  for (const [rawKey, rawValue] of Object.entries(value).slice(0, 32)) {
    const key = safeName(rawKey, "");
    if (Object.hasOwn(sendDiagnostics, key)) {
      continue;
    }
    if (!key || SEND_DIAGNOSTIC_ID_KEYS.includes(key) || BLOCKED_DETAIL_KEY.test(key)) continue;
    if (IDENTIFIER_DETAIL_KEYS.has(key) && typeof rawValue === "string") {
      details[key] = sanitizeIdentifier(rawValue);
      continue;
    }
    if (RAW_ERROR_DETAIL_LIMITS.has(key) && typeof rawValue === "string") {
      const text = sanitizeLogText(rawValue, RAW_ERROR_DETAIL_LIMITS.get(key));
      if (text) details[key] = text;
      continue;
    }
    if (typeof rawValue === "number" && Number.isFinite(rawValue)) details[key] = rawValue;
    else if (typeof rawValue === "boolean" || rawValue === null) details[key] = rawValue;
    else if (typeof rawValue === "string") {
      const text = sanitizeLogText(rawValue);
      details[key] = /^[a-z0-9._:-]{1,64}$/i.test(text) ? text : "[redacted]";
    }
  }
  return details;
}

export function createLogEntry(value, now = Date.now(), id = crypto.randomUUID()) {
  return {
    id,
    at: new Date(now).toISOString(),
    level: LEVELS.has(value?.level) ? value.level : "info",
    area: safeName(value?.area, "extension"),
    event: safeName(value?.event, "unknown"),
    message: sanitizeLogText(value?.message || value?.event || "Extension event"),
    details: sanitizeLogDetails(value?.details),
    ...(typeof value?.account_key === "string" && value.account_key
      ? { account_key: value.account_key }
      : {}),
  };
}

export function logStorageBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function availableLogBudget(totalBytes, currentLogBytes, quotaBytes) {
  if (![totalBytes, currentLogBytes, quotaBytes].every(Number.isFinite)) return 0;
  return Math.max(0, Math.min(MAX_LOG_BYTES, quotaBytes - (totalBytes - currentLogBytes) - STORAGE_HEADROOM_BYTES));
}

export function pruneLogs(items, now = Date.now(), maxBytes = MAX_LOG_BYTES) {
  const budget = Number.isFinite(maxBytes) ? Math.max(0, Math.min(MAX_LOG_BYTES, maxBytes)) : 0;
  const cutoff = now - LOG_RETENTION_MS;
  const recent = (Array.isArray(items) ? items : [])
    .filter((item) => Number.isFinite(Date.parse(item?.at)) && Date.parse(item.at) >= cutoff)
    // Include an outbox ID/comma allowance even for entries not queued for upload.
    .map((item) => ({ item, bytes: logStorageBytes(item) + logStorageBytes(item.id ?? "") + 2 }));
  const retained = new Set();
  let bytes = 4; // JSON array brackets for logs and optional upload outbox.
  for (const row of recent) {
    if (!["error", "warn"].includes(row.item.level) || bytes + row.bytes > Math.min(FAILURE_RESERVE_BYTES, budget)) continue;
    retained.add(row.item);
    bytes += row.bytes;
  }
  for (const row of recent) {
    if (retained.has(row.item) || bytes + row.bytes > budget) continue;
    retained.add(row.item);
    bytes += row.bytes;
  }
  return recent.filter(({ item }) => retained.has(item)).map(({ item }) => item);
}

// Drop routine readiness/start chatter and sample unchanged account observations
// before reading/writing the larger log buffer. Failures are never sampled.
export function createRoutineLogFilter() {
  const previous = new Map();
  return (level, area, event, details, now = Date.now()) => {
    if (!["info", "debug"].includes(level)) return details;
    const name = `${area}.${event}`;
    if (DROPPED_ROUTINE_EVENTS.has(name)) return null;
    if (name !== "provider.account_detected") return details;
    const key = JSON.stringify([area, event, details?.provider, details?.provider_account_id]);
    const signature = JSON.stringify(sanitizeLogDetails(details));
    const prior = previous.get(key);
    if (prior && prior.signature === signature && now - prior.at < ROUTINE_LOG_INTERVAL_MS) {
      prior.suppressed += 1;
      return null;
    }
    previous.delete(key);
    previous.set(key, { signature, at: now, suppressed: 0 });
    if (previous.size > 64) previous.delete(previous.keys().next().value);
    return prior?.signature === signature && prior.suppressed
      ? { ...details, suppressed_count: prior.suppressed } : details;
  };
}

export function logEntryForUpload(entry) {
  return {
    id: entry.id,
    at: entry.at,
    level: entry.level,
    area: entry.area,
    event: entry.event,
    message: entry.message,
    details: entry.details,
  };
}
