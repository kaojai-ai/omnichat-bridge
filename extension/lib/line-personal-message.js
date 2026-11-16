/** Normalize native identity once, before the shared Omnichat queue/mapper. */
export async function personalTextMessage(base, raw, ownId, captureMethod = "realtime_socket") {
  if (!raw?.id || !raw.from || !raw.to || !ownId) return null;
  if (!["NONE", 0].includes(raw.contentType)) return null;
  const group = ["GROUP", "ROOM", 1, 2].includes(raw.toType);
  const outgoing = raw.from === ownId;
  if (!group && !outgoing && raw.to !== ownId) return null;
  let text = raw.text;
  if (raw.chunks?.length) [text] = await base.e2ee.decryptE2EETextMessage(raw);
  if (typeof text !== "string" || !text) return null;
  const timestamp = Number(raw.createdTime);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  const conversationId = group || outgoing ? raw.to : raw.from;
  return {
    provider: "line_personal", provider_account_id: ownId,
    conversation_id: conversationId, conversation_type: group ? "group" : "user",
    participant: { id: outgoing ? conversationId : raw.from },
    id: String(raw.id), event_timestamp: new Date(timestamp).toISOString(), observed_at: new Date().toISOString(),
    sender_id: raw.from, recipient_id: raw.to,
    ...(outgoing ? { sender_account_id: ownId } : { recipient_account_id: ownId }),
    type: "text", text: text.slice(0, 20_000), capture_method: captureMethod,
  };
}
