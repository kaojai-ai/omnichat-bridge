(() => {
  const record = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : null;
  const text = (value) => typeof value === "string" && value.trim() ? value.trim() : null;
  const id = (value) => typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
  const basicId = (value) => {
    let normalized = id(value);
    if (!normalized) return "";
    try { normalized = decodeURIComponent(normalized); } catch { /* Keep the original value for validation. */ }
    normalized = normalized.replace(/^@+/, "");
    return /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(normalized) ? `@${normalized}` : "";
  };
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
    const providerAccountId = basicId(envelope?.provider_account_id);
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

  function basicIdFromHtml(html) {
    const source = typeof html === "string"
      ? html
      : typeof document !== "undefined"
        ? document.documentElement?.outerHTML ?? ""
        : "";
    if (!source) return "";

    const managerAccount = source.match(/manager\.line\.biz\/account\/(?:%40|@)([a-z0-9][a-z0-9._-]{0,63})/i);
    const explicitBasicId = source.match(/(?:data-)?basic[_-]?id\s*[:=]\s*["'](@?[a-z0-9][a-z0-9._-]{0,63})["']/i);
    const jsonBasicId = source.match(/["']basicId["']\s*:\s*["'](@?[a-z0-9][a-z0-9._-]{0,63})["']/i);
    return basicId(managerAccount?.[1]) || basicId(explicitBasicId?.[1]) || basicId(jsonBasicId?.[1]);
  }

  function normalizeAccount(input, detectedAt = new Date().toISOString()) {
    const providerAccountId = basicId(input?.provider_account_id);
    return providerAccountId ? {
      provider: "line_oa",
      provider_account_id: providerAccountId,
      detected_at: detectedAt,
    } : null;
  }

  globalThis.OmnichatLineOA = { chatItems, normalizeMessages, normalizeAccount, basicIdFromHtml };
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
    configOrigins: (account) => [account.events_url, account.logs_url],
    validateConfig: (value, version = 3) => {
      if (version !== 3) throw new Error("LINE OA requires a version 3 configuration.");
      const providerAccountId = basicId(value?.provider_account_id);
      const eventsUrl = text(value?.events_url);
      const hmacSecret = text(value?.hmac_secret);
      if (!providerAccountId || !eventsUrl || !hmacSecret) throw new Error("LINE OA requires a valid basic ID, events_url, and hmac_secret.");
      let parsedEventsUrl;
      try { parsedEventsUrl = new URL(eventsUrl); } catch { throw new Error("Events URL must use HTTPS."); }
      if (parsedEventsUrl.protocol !== "https:") throw new Error("Events URL must use HTTPS.");
      const normalized = {
        provider: "line_oa",
        provider_account_id: providerAccountId,
        events_url: parsedEventsUrl.toString(),
        hmac_secret: hmacSecret,
      };
      for (const field of ["api_url", "control_url", "logs_url", "sync_key_url"]) {
        const raw = text(value?.[field]);
        if (!raw) continue;
        let parsed;
        try { parsed = new URL(raw); } catch { throw new Error(`${field} must use HTTPS.`); }
        if (parsed.protocol !== "https:") throw new Error(`${field} must use HTTPS.`);
        normalized[field] = parsed.toString();
      }
      for (const field of ["tenant_id", "user_id"]) {
        const normalizedValue = text(value?.[field]);
        if (normalizedValue) normalized[field] = normalizedValue;
      }
      return normalized;
    },
    normalizeAccount,
    normalizeMessages: (body, captureMethod) => globalThis.OmnichatLineOA.normalizeMessages(body, captureMethod),
  });
})();
