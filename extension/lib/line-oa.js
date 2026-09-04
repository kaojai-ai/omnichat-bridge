(() => {
  const record = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : null;
  const text = (value) => typeof value === "string" && value.trim() ? value.trim() : null;
  const id = (value) => typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
  const iso = (value, fallback) => {
    const date = new Date(Number(value));
    return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
  };

  function eventItems(body) {
    const item = record(body);
    if (Array.isArray(body)) return body;
    if (Array.isArray(item?.list)) return item.list;
    if (Array.isArray(item?.messages)) return item.messages;
    if (Array.isArray(item?.conversations)) return item.conversations.flatMap((conversation) => Array.isArray(conversation?.messages) ? conversation.messages : []);
    return [];
  }

  function chatItems(body) {
    const item = record(body);
    if (Array.isArray(item?.list)) return item.list;
    return [];
  }

  function normalizeMessages(body, captureMethod) {
    const envelope = record(body);
    const providerAccountId = id(envelope?.provider_account_id);
    const results = [];
    const seen = new Set();
    for (const event of eventItems(envelope?.messages ?? body)) {
      const item = record(event);
      const message = record(item?.message);
      const conversationId = id(item?.source?.chatId ?? item?.conversation_id);
      const messageId = id(message?.id ?? item?.provider_message_id);
      const timestamp = Number(item?.timestamp);
      if (!conversationId || !messageId || !Number.isFinite(timestamp)) continue;
      const key = `${conversationId}:${messageId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const incoming = item.type === "message";
      const userId = id(item?.source?.userId ?? item?.source?.groupId) || conversationId;
      const messageType = text(message?.originalType ?? message?.type) ?? "unknown";
      const type = ["text", "image", "video", "sticker"].includes(messageType) ? messageType : "unsupported";
      results.push({
        provider: "line_oa",
        provider_account_id: providerAccountId || undefined,
        conversation_id: conversationId,
        id: messageId,
        event_timestamp: iso(timestamp, new Date().toISOString()),
        observed_at: new Date().toISOString(),
        sender_id: incoming ? userId : providerAccountId,
        recipient_id: incoming ? providerAccountId : userId,
        ...(incoming ? { recipient_account_id: providerAccountId } : { sender_account_id: providerAccountId }),
        type,
        ...(message?.text ? { text: String(message.text).slice(0, 20_000) } : {}),
        ...(message?.contentProvider?.originalContentUrl ? { media_url: message.contentProvider.originalContentUrl } : {}),
        ...(messageType !== type ? { provider_type: messageType } : {}),
        capture_method: captureMethod,
      });
    }
    return results;
  }

  function normalizeAccount(input) {
    const providerAccountId = id(input?.provider_account_id);
    return providerAccountId ? { provider: "line_oa", provider_account_id: providerAccountId, detected_at: new Date().toISOString() } : null;
  }

  globalThis.OmnichatLineOA = { chatItems, normalizeMessages };
  globalThis.OmnichatProviderAdapters?.register({
    id: "line_oa",
    displayName: "LINE Official Account",
    accountName: "LINE Official Account",
    adapterVersion: "line-oa-poll-1",
    chatUrl: "https://chat.line.biz/",
    tabQueryPattern: "https://chat.line.biz/*",
    capabilities: ["account_detection", "message_observation", "message_recovery"],
    sendCommands: [],
    matchesUrl: (url) => typeof url === "string" && /^https:\/\/chat\.line\.biz(?:\/|$)/i.test(url),
    matchesPage: (url) => typeof url === "string" && /^https:\/\/chat\.line\.biz(?:\/|$)/i.test(url),
    configOrigins: (account) => [account.events_url, account.commands_url, account.logs_url],
    validateConfig: (value) => {
      const providerAccountId = id(value?.provider_account_id);
      const botId = id(value?.bot_id);
      const eventsUrl = text(value?.events_url);
      const hmacSecret = text(value?.hmac_secret);
      if (!providerAccountId || !botId || !eventsUrl || !hmacSecret) throw new Error("LINE OA requires provider_account_id, bot_id, events_url, and hmac_secret.");
      const parsed = new URL(eventsUrl);
      if (parsed.protocol !== "https:") throw new Error("Events URL must use HTTPS.");
      return { provider: "line_oa", provider_account_id: providerAccountId, bot_id: botId, events_url: parsed.toString(), hmac_secret: hmacSecret };
    },
    normalizeAccount,
    normalizeMessages: (body, captureMethod) => globalThis.OmnichatLineOA.normalizeMessages(body, captureMethod),
  });
})();
