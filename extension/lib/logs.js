export const LOG_RETENTION_MS = 2 * 24 * 60 * 60_000;
export const MAX_LOG_ENTRIES = 4_000;

const LEVELS = new Set(["debug", "info", "warn", "error"]);
const BLOCKED_DETAIL_KEY = /authorization|body|content|cookie|credential|headers?|hmac|message_text|password|payload|secret|token|url/i;
const RAW_ERROR_DETAIL_LIMITS = new Map([
  ["error_message", 500],
  ["error_stack", 2_000],
  ["cause_message", 500],
]);
const IDENTIFIER_DETAIL_KEYS = new Set([
  "category",
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
  const details = {};
  for (const [rawKey, rawValue] of Object.entries(value).slice(0, 20)) {
    const key = safeName(rawKey, "");
    if (!key || BLOCKED_DETAIL_KEY.test(key)) continue;
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

export function pruneLogs(items, now = Date.now()) {
  const cutoff = now - LOG_RETENTION_MS;
  return (Array.isArray(items) ? items : [])
    .filter((item) => Number.isFinite(Date.parse(item?.at)) && Date.parse(item.at) >= cutoff)
    .slice(0, MAX_LOG_ENTRIES);
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
