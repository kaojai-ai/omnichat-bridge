export const DELIVERY_RETRY_DELAYS_MS = [
  60_000,
  2 * 60_000,
  5 * 60_000,
  15 * 60_000,
  30 * 60_000,
];

export function compareMessageCursor(left, right) {
  const leftTime = Date.parse(left?.event_timestamp ?? "");
  const rightTime = Date.parse(right?.event_timestamp ?? "");
  if (!Number.isFinite(leftTime)) return -1;
  if (!Number.isFinite(rightTime)) return 1;
  if (leftTime !== rightTime) return leftTime - rightTime;
  const leftId = String(left?.message_id ?? left?.id ?? "");
  const rightId = String(right?.message_id ?? right?.id ?? "");
  if (leftId === rightId) return 0;
  return leftId > rightId ? 1 : -1;
}

export function isAfterMessageCursor(message, cursor) {
  if (!cursor) return true;
  return compareMessageCursor(message, cursor) > 0;
}

export function hasScanBacklog(state) {
  return !state?.watermark || state.in_progress === true;
}

export function advanceConversationCursors(current, messages) {
  const conversations = { ...(current?.conversations ?? {}) };
  for (const message of messages ?? []) {
    const conversationId = String(message?.conversation_id ?? "");
    if (!conversationId) continue;
    const candidate = {
      event_timestamp: message.event_timestamp,
      message_id: message.id,
    };
    if (compareMessageCursor(candidate, conversations[conversationId]) > 0) {
      conversations[conversationId] = candidate;
    }
  }
  return conversations;
}

export function latestMessageCursor(messages) {
  let latest = null;
  for (const message of messages ?? []) {
    const candidate = {
      event_timestamp: message?.event_timestamp,
      message_id: message?.id,
    };
    if (compareMessageCursor(candidate, latest) > 0) latest = candidate;
  }
  return latest;
}

export function deliveryRetryDelay(attempt) {
  const index = Math.max(
    0,
    Math.min(Number(attempt) || 0, DELIVERY_RETRY_DELAYS_MS.length - 1),
  );
  return DELIVERY_RETRY_DELAYS_MS[index];
}

export function migrateScanState(legacyCursor, pendingMessages, lastAutoAt = null) {
  const conversations = advanceConversationCursors(
    legacyCursor,
    pendingMessages,
  );
  return {
    version: 1,
    watermark: null,
    conversations,
    bootstrap: null,
    in_progress: false,
    last_auto_at: lastAutoAt,
    updated_at: new Date().toISOString(),
  };
}
