(() => {
  const SOURCE = "omnichat-realtime-bridge-v3";
  const PAGE_LIMIT = 100;
  const ACK_TIMEOUT_MS = 20_000;
  const previous = window.__omnichatLineOABridgeControl;
  previous?.dispose?.();
  let disposed = false;
  let timer = null;
  let running = false;
  const acknowledgements = new Map();
  const knownChatIds = new Set();
  const knownMessageIdsByChat = new Map();
  const accountId = () => String(window.location.pathname.split("/").filter(Boolean)[0] ?? "").trim();
  const apiBase = "https://chat.line.biz/api";
  const post = (data) => window.postMessage({ source: SOURCE, ...data }, window.location.origin);
  const value = (input) => typeof input === "string" || typeof input === "number" ? String(input).trim() : "";
  const cursor = (input) => value(input) || null;

  async function json(url) {
    const response = await fetch(url, { credentials: "include", headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`LINE OA request failed (${response.status}).`);
    return response.json();
  }

  function chatUrl(botId, next) {
    const url = new URL(`${apiBase}/v2/bots/${encodeURIComponent(botId)}/chats`);
    url.searchParams.set("folderType", "ALL");
    url.searchParams.set("limit", String(PAGE_LIMIT));
    url.searchParams.set("prioritizePinnedChat", "false");
    if (next) url.searchParams.set("next", next);
    return url.toString();
  }

  function messagesUrl(botId, chatId, backward) {
    const url = new URL(`${apiBase}/v3/bots/${encodeURIComponent(botId)}/chats/${encodeURIComponent(chatId)}/messages`);
    url.searchParams.set("limit", String(PAGE_LIMIT));
    if (backward) url.searchParams.set("backward", backward);
    return url.toString();
  }

  function messageId(event) {
    return value(event?.message?.id ?? event?.id ?? event?.provider_message_id);
  }

  function waitForAcknowledgement(requestId) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        acknowledgements.delete(requestId);
        reject(new Error("LINE OA local message queue acknowledgement timed out."));
      }, ACK_TIMEOUT_MS);
      acknowledgements.set(requestId, (message) => {
        clearTimeout(timeout);
        resolve(message);
      });
    });
  }

  function cancelAcknowledgements(error) {
    for (const [requestId, acknowledge] of acknowledgements) {
      acknowledgements.delete(requestId);
      acknowledge({ ok: false, error });
    }
  }

  async function queueMessagePage({ requestId, providerAccountId, chat, messages, page }) {
    if (!messages.length) return { parsed: 0, queued: 0 };
    const batchRequestId = `${requestId}:${value(chat?.chatId)}:${page}`;
    post({
      type: "recovery_batch",
      request_id: batchRequestId,
      provider_account_id: providerAccountId,
      body: {
        provider_account_id: providerAccountId,
        conversations: [{ id: value(chat?.chatId), profile: chat?.profile, messages }],
      },
    });
    const acknowledgement = await waitForAcknowledgement(batchRequestId);
    if (!acknowledgement?.ok) {
      throw new Error(acknowledgement?.error ?? "LINE OA messages could not be queued locally.");
    }
    return {
      parsed: Number(acknowledgement.parsed) || 0,
      queued: Number(acknowledgement.queued) || 0,
    };
  }

  async function recoverChat({ requestId, providerAccountId, botId, chat }) {
    const chatId = value(chat?.chatId);
    if (!chatId) return { parsed: 0, queued: 0 };
    const knownMessageIds = knownMessageIdsByChat.get(chatId) ?? new Set();
    knownMessageIdsByChat.set(chatId, knownMessageIds);
    let backward = null;
    let page = 0;
    let parsed = 0;
    let queued = 0;
    const seenCursors = new Set();

    while (!disposed) {
      const body = await json(messagesUrl(botId, chatId, backward));
      const messages = Array.isArray(body?.list) ? body.list : [];
      const allKnown = messages.length > 0 && messages.every((message) => {
        const id = messageId(message);
        return id && knownMessageIds.has(id);
      });
      if (allKnown) break;
      const result = await queueMessagePage({ requestId, providerAccountId, chat, messages, page });
      parsed += result.parsed;
      queued += result.queued;
      for (const message of messages) {
        const id = messageId(message);
        if (id) knownMessageIds.add(id);
      }
      const nextBackward = cursor(body?.backward);
      if (!nextBackward || allKnown || seenCursors.has(nextBackward)) break;
      seenCursors.add(nextBackward);
      backward = nextBackward;
      page += 1;
    }
    return { parsed, queued };
  }

  async function poll(requestId, providerAccountId) {
    if (disposed || running) return;
    running = true;
    try {
      const botId = accountId();
      if (!botId) throw new Error("LINE OA bot ID was not found in the open page URL.");
      let next = null;
      let parsed = 0;
      let queued = 0;
      const seenCursors = new Set();
      while (!disposed) {
        const body = await json(chatUrl(botId, next));
        const chats = globalThis.OmnichatLineOA.chatItems(body);
        const allKnown = chats.length > 0 && chats.every((chat) => knownChatIds.has(value(chat?.chatId)));
        for (const chat of chats) {
          const chatId = value(chat?.chatId);
          if (!chatId) continue;
          const result = await recoverChat({ requestId, providerAccountId, botId, chat });
          parsed += result.parsed;
          queued += result.queued;
          knownChatIds.add(chatId);
        }
        const nextCursor = cursor(body?.next);
        if (!nextCursor || allKnown || seenCursors.has(nextCursor)) break;
        seenCursors.add(nextCursor);
        next = nextCursor;
      }
      post({ type: "recovery_complete", request_id: requestId, provider_account_id: providerAccountId, ok: true, recovered: parsed, queued, watermark: new Date().toISOString() });
    } catch (error) {
      post({ type: "recovery_complete", request_id: requestId, provider_account_id: providerAccountId, ok: false, error: String(error) });
    } finally {
      running = false;
    }
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function start(requestId, providerAccountId) {
    stop();
    void poll(requestId, providerAccountId);
    timer = setInterval(() => void poll(`poll:${crypto.randomUUID()}`, providerAccountId), 15_000);
  }

  const listener = (event) => {
    if (disposed || event.source !== window || event.origin !== window.location.origin || event.data?.source !== SOURCE) return;
    if (event.data.type === "detect_account_v3") {
      const id = accountId();
      if (id) post({ type: "accounts_detected", accounts: [{ provider: "line_oa", provider_account_id: id }] });
    } else if (event.data.type === "sync_v3") {
      start(event.data.request_id, event.data.provider_account_id);
    } else if (event.data.type === "cancel_sync_v3") {
      stop();
      cancelAcknowledgements("LINE OA recovery was cancelled.");
    } else if (event.data.type === "recovery_ack_v3") {
      const acknowledge = acknowledgements.get(event.data.request_id);
      if (acknowledge) {
        acknowledgements.delete(event.data.request_id);
        acknowledge(event.data);
      }
    }
  };

  window.addEventListener("message", listener);
  window.__omnichatLineOABridgeControl = {
    dispose() {
      disposed = true;
      stop();
      cancelAcknowledgements("LINE OA bridge was replaced.");
      window.removeEventListener("message", listener);
    },
  };
  post({ type: "provider_status", surface: "line-oa", surface_ready: true, capabilities: { account_detection: true, message_observation: true, message_recovery: true }, realtime_transport: "authenticated_polling", realtime_connected: true, connected_at: new Date().toISOString(), chat_open: true });
})();
