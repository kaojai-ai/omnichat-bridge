export const LOG_RETENTION_MS = 2 * 24 * 60 * 60_000;
export const MAX_LOG_ENTRIES = 4_000;

const LEVELS = new Set(["debug", "info", "warn", "error"]);
const BLOCKED_DETAIL_KEY = /authorization|body|content|cookie|credential|headers?|hmac|message_text|password|payload|secret|token|url/i;

function safeName(value, fallback) {
  const name = String(value ?? "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(name) ? name : fallback;
}

export function sanitizeLogText(value) {
  return String(value ?? "")
    .replace(/\bhttps?:\/\/[^\s)]+/gi, "[url]")
    .replace(/\b(?:bearer|basic)\s+[^\s,;]+/gi, "[authorization]")
    .replace(/\b(authorization|cookie|hmac_secret|password|secret|token)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\b[A-Za-z0-9+/_=-]{32,}\b/g, "[redacted]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]")
    .slice(0, 300);
}

export function sanitizeLogDetails(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const details = {};
  for (const [rawKey, rawValue] of Object.entries(value).slice(0, 20)) {
    const key = safeName(rawKey, "");
    if (!key || BLOCKED_DETAIL_KEY.test(key)) continue;
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
