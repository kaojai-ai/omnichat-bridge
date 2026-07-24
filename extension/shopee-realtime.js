(() => {
  const SOURCE = "omnichat-realtime-bridge";
  const CONVERSATIONS_PATH = "/webchat/api/v1.2/conversations";
  const LOGIN_PATH = "/webchat/api/coreapi/v1.2/login";
  const HISTORY_LIMIT = 100;
  const MANUAL_SYNC_MAX_CONVERSATIONS = 10;
  const MANUAL_SYNC_MAX_MESSAGES_PER_CONVERSATION = 25;
  const MIN_RECOVERY_REQUEST_INTERVAL_MS = 3_000;
  const state = window.__omnichatRealtimeState ??= {
    getTemplate: null,
    listTemplate: null,
    nativeFetch: window.fetch.bind(window),
    recoveryInFlight: false,
    socket: null,
    account: null,
    profilesByConversation: new Map(),
    activeConversationId: null,
    acknowledgements: new Map(),
    nextRecoveryRequestAt: 0
  };
  state.profilesByConversation ??= new Map();
  state.nextRecoveryRequestAt ??= 0;

  const post = (message) => window.postMessage({ source: SOURCE, ...message }, window.location.origin);
  const pathOf = (url) => {
    try { return new URL(url, window.location.href).pathname; }
    catch { return ""; }
  };
  const value = (input) => {
    if (typeof input !== "string" && typeof input !== "number") return null;
    const normalized = String(input).trim();
    return normalized || null;
  };
  const firstValue = (item, keys) => keys.map((key) => value(item[key])).find(Boolean) ?? null;
  const httpsUrl = (input) => {
    const url = value(input);
    if (!url) return null;
    try { return new URL(url).protocol === "https:" ? url : null; } catch { return null; }
  };
  const accountFrom = (input, depth = 0, seen = new WeakSet()) => {
    if (depth > 6 || !input || typeof input !== "object" || seen.has(input)) return null;
    seen.add(input);
    if (Array.isArray(input)) {
      for (const item of input) {
        const account = accountFrom(item, depth + 1, seen);
        if (account) return account;
      }
      return null;
    }
    const item = input;
    const id = firstValue(item, ["shop_id", "shopid", "shopId", "user_id", "userid", "userId"]);
    const name = firstValue(item, ["shop_name", "shopname", "shopName", "user_name", "userName", "username", "nickname", "name"]);
    const avatarUrl = httpsUrl(firstValue(item, ["shop_logo", "shop_avatar", "avatar", "avatar_url", "avatarUrl", "profile_image", "profile_picture"]));
    if (id) return { provider_account_id: id, ...(name ? { display_name: name } : {}), ...(avatarUrl ? { avatar_url: avatarUrl } : {}) };
    for (const child of Object.values(item)) {
      const account = accountFrom(child, depth + 1, seen);
      if (account) return account;
    }
    return null;
  };
  const postAccount = (requestId) => {
    if (!state.account) return false;
    post({ type: "account_detected", ...state.account, ...(requestId ? { request_id: requestId } : {}) });
    return true;
  };
  const captureAccount = (response) => {
    void response.clone().json().then((body) => {
      const account = accountFrom(body);
      if (!account) return;
      state.account = account;
      postAccount();
    }).catch(() => undefined);
  };
  const templateFrom = async (request) => ({
    url: request.url,
    body: request.method === "GET" || request.method === "HEAD" ? null : await request.clone().arrayBuffer(),
    init: {
      method: request.method,
      headers: new Headers(request.headers),
      mode: request.mode,
      credentials: request.credentials,
      cache: request.cache,
      redirect: request.redirect,
      referrerPolicy: request.referrerPolicy,
      integrity: request.integrity,
      keepalive: request.keepalive
    }
  });
  const timeMs = (value) => {
    if (typeof value === "string" && !/^\d+$/.test(value) && !Number.isNaN(Date.parse(value))) return Date.parse(value);
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return 0;
    if (numeric > 10_000_000_000_000) return numeric / 1_000_000;
    return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  };

  const recoveryFetch = async (request) => {
    const scheduledAt = Math.max(Date.now(), state.nextRecoveryRequestAt);
    state.nextRecoveryRequestAt = scheduledAt + MIN_RECOVERY_REQUEST_INTERVAL_MS;
    const waitMs = scheduledAt - Date.now();
    if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
    return state.nativeFetch(request);
  };

  const waitForTemplate = async () => {
    const deadline = Date.now() + 15_000;
    while ((!state.listTemplate || !state.getTemplate) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!state.listTemplate || !state.getTemplate) throw new Error("Refresh Shopee Seller Chat once to initialize realtime sync.");
  };

  const waitForAcknowledgement = (requestId) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      state.acknowledgements.delete(requestId);
      reject(new Error("Local message queue acknowledgement timed out."));
    }, 20_000);
    state.acknowledgements.set(requestId, (message) => {
      clearTimeout(timeout);
      resolve(message);
    });
  });

  const detectAccount = (conversations, requestId) => {
    const accountIds = [...new Set((Array.isArray(conversations) ? conversations : [])
      .map((conversation) => String(conversation.shop_id ?? "").trim())
      .filter(Boolean))];
    if (accountIds.length !== 1) return null;
    if (!state.account || state.account.provider_account_id !== accountIds[0]) {
      state.account = { provider_account_id: accountIds[0] };
    }
    postAccount(requestId);
    return state.account.provider_account_id;
  };

  const captureProfiles = (conversations) => {
    const profiles = [];
    for (const conversation of Array.isArray(conversations) ? conversations : []) {
      const conversationId = String(conversation.id ?? "").trim();
      const id = String(conversation.to_id ?? "").trim();
      if (!conversationId || !id) continue;
      const displayName = String(conversation.to_name ?? "").trim();
      const avatar = String(conversation.to_avatar ?? "").trim();
      let avatarUrl = "";
      try {
        const url = new URL(avatar);
        if (url.protocol === "https:") avatarUrl = url.toString();
      } catch { /* Ignore invalid provider avatar URLs. */ }
      const profile = {
        conversation_id: conversationId,
        id,
        ...(displayName ? { display_name: displayName } : {}),
        ...(avatarUrl ? { avatar_url: avatarUrl } : {})
      };
      state.profilesByConversation.set(conversationId, profile);
      profiles.push(profile);
    }
    if (profiles.length) post({ type: "profiles_detected", profiles });
  };
  const captureActiveConversation = (request) => {
    const match = pathOf(request.url).match(/^\/webchat\/api\/v1\.2\/conversations\/([^/]+)\/messages$/);
    if (!match) return;
    const conversationId = decodeURIComponent(match[1]);
    if (!conversationId || state.activeConversationId === conversationId) return;
    state.activeConversationId = conversationId;
    post({ type: "active_conversation", conversation_id: conversationId });
  };

  async function fetchConversations() {
    const response = await recoveryFetch(new Request(state.listTemplate.url, {
      ...state.listTemplate.init,
      body: state.listTemplate.body?.slice(0)
    }));
    if (!response.ok) throw new Error(`Shopee conversation recovery returned ${response.status}. Refresh Seller Chat.`);
    const body = await response.json();
    detectAccount(body);
    captureProfiles(body);
    return Array.isArray(body) ? body : [];
  }

  async function detectCurrentAccount(requestId) {
    if (postAccount(requestId)) {
      return;
    }
    try {
      await waitForTemplate();
      const conversations = await fetchConversations();
      if (!detectAccount(conversations, requestId)) throw new Error("Shopee Shop ID was not found.");
    } catch (error) {
      post({ type: "account_detection_failed", request_id: requestId, error: String(error) });
    }
  }

  async function fetchHistory(conversation, sinceMs, maxMessages) {
    const messages = [];
    const pageSize = Math.min(HISTORY_LIMIT, maxMessages ?? HISTORY_LIMIT);
    for (let page = 0; ; page += 1) {
      const sourceUrl = new URL(state.getTemplate.url);
      const url = new URL(sourceUrl.origin);
      url.pathname = `/webchat/api/v1.2/conversations/${encodeURIComponent(conversation.id)}/messages`;
      for (const key of ["_uid", "_v", "csrf_token", "SPC_CDS_CHAT", "x-shop-region", "_api_source"]) {
        if (sourceUrl.searchParams.has(key)) url.searchParams.set(key, sourceUrl.searchParams.get(key));
      }
      url.searchParams.set("shop_id", conversation.shop_id);
      url.searchParams.set("offset", String(page * pageSize));
      url.searchParams.set("limit", String(pageSize));
      url.searchParams.set("direction", "older");
      url.searchParams.set("biz_id", String(conversation.biz_id ?? 0));
      const headers = new Headers(state.getTemplate.init.headers);
      headers.delete("content-type");
      const response = await recoveryFetch(new Request(url, {
        ...state.getTemplate.init,
        method: "GET",
        headers
      }));
      if (!response.ok) throw new Error(`Shopee message recovery returned ${response.status}. Refresh Seller Chat.`);
      const pageMessages = await response.json();
      if (!Array.isArray(pageMessages)) break;
      const currentMessages = pageMessages
        .filter((message) => timeMs(message.created_timestamp ?? message.created_at) >= sinceMs)
        .sort((left, right) => timeMs(right.created_timestamp ?? right.created_at) - timeMs(left.created_timestamp ?? left.created_at));
      messages.push(...currentMessages);
      if (maxMessages && messages.length >= maxMessages) return messages.slice(0, maxMessages);
      const oldest = pageMessages.reduce((value, message) => {
        const candidate = timeMs(message.created_timestamp ?? message.created_at);
        return candidate && candidate < value ? candidate : value;
      }, Number.POSITIVE_INFINITY);
      if (pageMessages.length < pageSize || oldest <= sinceMs) break;
    }
    return messages;
  }

  async function recover(requestId, cursors, fallbackSince, mode = "limited") {
    if (state.recoveryInFlight) {
      post({ type: "recovery_complete", request_id: requestId, ok: false, error: "Recovery is already running." });
      return;
    }
    state.recoveryInFlight = true;
    let parsed = 0;
    let queued = 0;
    let checked = 0;
    try {
      await waitForTemplate();
      const conversations = await fetchConversations();
      const fallbackSinceMs = timeMs(fallbackSince);
      const recoveryConversations = [...conversations]
        .sort((left, right) => timeMs(right.last_message_time ?? right.created_timestamp) - timeMs(left.last_message_time ?? left.created_timestamp));
      if (mode === "limited") recoveryConversations.splice(MANUAL_SYNC_MAX_CONVERSATIONS);
      const totalConversations = recoveryConversations.length;
      let completedConversations = 0;
      post({ type: "recovery_progress", request_id: requestId, completed_conversations: completedConversations, total_conversations: totalConversations });
      for (const conversation of recoveryConversations) {
        const cursor = cursors?.[conversation.id];
        const sinceMs = timeMs(cursor?.event_timestamp) || fallbackSinceMs;
        const latestMs = timeMs(conversation.last_message_time ?? conversation.created_timestamp);
        if (!(latestMs && latestMs < sinceMs)) {
          checked += 1;
          const history = await fetchHistory(
          conversation,
          sinceMs,
          mode === "limited" ? MANUAL_SYNC_MAX_MESSAGES_PER_CONVERSATION : undefined
        );
          if (history.length) {
            const batchRequestId = `${requestId}:${conversation.id}`;
            post({ type: "recovery_batch", request_id: batchRequestId, body: history });
            const acknowledgement = await waitForAcknowledgement(batchRequestId);
            if (!acknowledgement.ok) throw new Error(acknowledgement.error ?? "Could not queue recovered messages.");
            parsed += acknowledgement.parsed ?? 0;
            queued += acknowledgement.queued ?? 0;
          }
        }
        completedConversations += 1;
        post({ type: "recovery_progress", request_id: requestId, completed_conversations: completedConversations, total_conversations: totalConversations });
      }
      post({ type: "recovery_complete", request_id: requestId, ok: true, recovered: parsed, queued, conversations_checked: checked });
    } catch (error) {
      post({ type: "recovery_complete", request_id: requestId, ok: false, error: String(error) });
    } finally {
      state.recoveryInFlight = false;
    }
  }

  if (!window.fetch.__omnichatRealtimeBridge) {
    const originalFetch = state.nativeFetch;
    const observedFetch = async (input, init) => {
      const request = new Request(input, init);
      const response = await originalFetch(input, init);
      const path = pathOf(request.url);
      if (request.method === "GET") captureActiveConversation(request);
      if (path.startsWith("/webchat/api/") && request.method === "GET" && !state.getTemplate) {
        void templateFrom(request).then((template) => { state.getTemplate = template; });
      }
      if (path === CONVERSATIONS_PATH) {
        void templateFrom(request).then((template) => { state.listTemplate = template; });
        void response.clone().json().then((body) => {
          detectAccount(body);
          captureProfiles(body);
        }).catch(() => undefined);
      } else if (path === LOGIN_PATH) {
        captureAccount(response);
      }
      return response;
    };
    Object.defineProperty(observedFetch, "__omnichatRealtimeBridge", { value: true });
    window.fetch = observedFetch;
  }

  function observeSocket() {
    const socket = window.__CHAT_GLOBAL__?.socket;
    if (!socket?.on || state.socket === socket) return;
    state.socket = socket;
    if (document.documentElement) document.documentElement.dataset.omnichatRealtime = "connected";
    socket.on("message", (event) => {
      const envelope = event?.data ?? event;
      if (envelope?.message_type !== "message") return;
      try {
        const body = typeof envelope.message_content === "string"
          ? JSON.parse(envelope.message_content)
          : envelope.message_content;
        post({ type: "realtime_event", body });
      } catch { /* Ignore malformed provider events. */ }
    });
  }

  observeSocket();
  setInterval(observeSocket, 2_000);

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== window.location.origin || event.data?.source !== SOURCE) return;
    if (event.data.type === "recover") {
      void recover(event.data.request_id, event.data.cursors ?? {}, event.data.fallback_since, event.data.mode);
    } else if (event.data.type === "detect_account") {
      void detectCurrentAccount(event.data.request_id);
    } else if (event.data.type === "recovery_ack") {
      const acknowledge = state.acknowledgements.get(event.data.request_id);
      if (acknowledge) {
        state.acknowledgements.delete(event.data.request_id);
        acknowledge(event.data);
      }
    }
  });
})();
