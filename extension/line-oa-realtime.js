(() => {
  const SOURCE = "omnichat-realtime-bridge-v3";
  const previous = window.__omnichatLineOABridgeControl;
  previous?.dispose?.();
  let disposed = false;
  let timer = null;
  let running = false;
  const accountId = () => String(window.location.pathname.split("/").filter(Boolean)[0] ?? "").trim();
  const apiBase = "https://chat.line.biz/api";
  const post = (data) => window.postMessage({ source: SOURCE, ...data }, window.location.origin);
  async function json(url) {
    const response = await fetch(url, { credentials: "include", headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`LINE OA request failed (${response.status}).`);
    return response.json();
  }
  async function poll(requestId, providerAccountId) {
    if (disposed || running) return;
    running = true;
    try {
      const botId = accountId();
      if (!botId) throw new Error("LINE OA bot ID was not found in the open page URL.");
      const chats = await json(`${apiBase}/v2/bots/${encodeURIComponent(botId)}/chats?folderType=ALL&limit=100&prioritizePinnedChat=false`);
      const conversations = [];
      for (const chat of globalThis.OmnichatLineOA.chatItems(chats).slice(0, 100)) {
        const chatId = String(chat?.chatId ?? "").trim();
        if (!chatId) continue;
        const messages = await json(`${apiBase}/v3/bots/${encodeURIComponent(botId)}/chats/${encodeURIComponent(chatId)}/messages?limit=100`);
        conversations.push({ id: chatId, profile: chat.profile, messages: messages?.list ?? [] });
      }
      post({ type: "recovery_batch", request_id: requestId, provider_account_id: providerAccountId, body: { provider_account_id: providerAccountId, conversations } });
      post({ type: "recovery_complete", request_id: requestId, provider_account_id: providerAccountId, ok: true, recovered: conversations.reduce((sum, item) => sum + item.messages.length, 0), queued: 0, watermark: new Date().toISOString() });
    } catch (error) {
      post({ type: "recovery_complete", request_id: requestId, provider_account_id: providerAccountId, ok: false, error: String(error) });
    } finally {
      running = false;
    }
  }
  function start(requestId, providerAccountId) {
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
      if (timer) clearInterval(timer);
      timer = null;
    }
  };
  window.addEventListener("message", listener);
  window.__omnichatLineOABridgeControl = { dispose() { disposed = true; if (timer) clearInterval(timer); window.removeEventListener("message", listener); } };
  post({ type: "provider_status", surface: "line-oa", surface_ready: true, capabilities: { account_detection: true, message_observation: true, message_recovery: true }, realtime_transport: "authenticated_polling", realtime_connected: true, connected_at: new Date().toISOString(), chat_open: true });
})();
