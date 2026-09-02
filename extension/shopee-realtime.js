(() => {
  const SOURCE = "omnichat-realtime-bridge";
  const LEGACY_CONVERSATIONS_PATH = "/webchat/api/v1.2/conversations";
  const LEGACY_SUBACCOUNT_CONVERSATIONS_PATH = "/webchat/api/v1.2/subaccount/serving_mode/conversations";
  const LEGACY_SHOP_LIST_PATH = "/webchat/api/v1.2/shop_list";
  const LEGACY_LOGIN_PATH = "/webchat/api/coreapi/v1.2/login";
  const SELLER_CENTRE_CONVERSATIONS_PATH = "/webchat/api/v1.2/mini/conversations";
  const SELLER_CENTRE_SYNC_PATH = "/webchat/api/v1.2/mini/user/sync";
  const SELLER_CENTRE_MESSAGE_PREFIX = "/webchat/api/v1.2/mini/conversations/";
  const SELLER_CENTRE_SEND_PATH = "/webchat/api/v1.2/mini/messages";
  const LEGACY_SEND_PATH = "/webchat/api/v1.2/messages";
  const LEGACY_IMAGE_PATH = "/webchat/api/coreapi/v1.2/images";
  const SELLER_CENTRE_IMAGE_PATH = "/webchat/api/coreapi/v1.2/images";
  const SELLER_CENTRE_SURFACE = "seller-centre";
  const LEGACY_SURFACE = "legacy";
  const SURFACE_PROFILES = Object.freeze({
    [LEGACY_SURFACE]: Object.freeze({
      listPaths: Object.freeze([
        LEGACY_CONVERSATIONS_PATH,
        LEGACY_SUBACCOUNT_CONVERSATIONS_PATH,
      ]),
      shopListPath: LEGACY_SHOP_LIST_PATH,
      loginPath: LEGACY_LOGIN_PATH,
      sendPath: LEGACY_SEND_PATH,
      imagePath: LEGACY_IMAGE_PATH,
      historyPath: (conversationId) => `/webchat/api/v1.2/conversations/${encodeURIComponent(conversationId)}/messages`,
      historyPathPattern: /^\/webchat\/api\/v1\.2\/conversations\/[^/]+\/messages$/,
      syncPath: null,
      sendSource: null,
    }),
    [SELLER_CENTRE_SURFACE]: Object.freeze({
      listPaths: Object.freeze([SELLER_CENTRE_CONVERSATIONS_PATH]),
      shopListPath: null,
      loginPath: "/api/v2/login/",
      sendPath: SELLER_CENTRE_SEND_PATH,
      imagePath: SELLER_CENTRE_IMAGE_PATH,
      historyPath: (conversationId) => `${SELLER_CENTRE_MESSAGE_PREFIX}${encodeURIComponent(conversationId)}/messages`,
      historyPathPattern: /^\/webchat\/api\/v1\.2\/mini\/conversations\/[^/]+\/messages$/,
      syncPath: SELLER_CENTRE_SYNC_PATH,
      sendSource: "minichat",
    }),
  });
  const HISTORY_LIMIT = 100;
  const MANUAL_SYNC_MAX_CONVERSATIONS = 10;
  const MANUAL_SYNC_MAX_MESSAGES_PER_CONVERSATION = 25;
  const ACCOUNT_DISCOVERY_RETRY_DELAY_MS = 2_000;
  const ACCOUNT_DISCOVERY_MAX_ATTEMPTS = 2;
  const MIN_RECOVERY_REQUEST_INTERVAL_MS = 1_000;
  const SOCKET_OBSERVER_INTERVAL_MS = 2_000;
  const providerAdapter = globalThis.OmnichatProviderAdapters?.get("shopee");
  if (!providerAdapter) throw new Error("Shopee provider adapter is unavailable.");
  const currentSurface = providerAdapter.surfaceForUrl?.(window.location.href)
    ?? globalThis.OmnichatShopeeUrl?.surfaceForUrl?.(window.location.href)
    ?? LEGACY_SURFACE;
  const state = window.__omnichatRealtimeState ??= {
    surface: null,
    getTemplate: null,
    listTemplate: null,
    historyTemplate: null,
    nativeFetch: window.fetch.bind(window),
    recoveryInFlight: false,
    socket: null,
    accountsById: new Map(),
    profilesByConversation: new Map(),
    conversationsById: new Map(),
    sendTemplate: null,
    sendErrorsByClientMessageId: new Map(),
    activeConversationId: null,
    acknowledgements: new Map(),
    nextRecoveryRequestAt: 0,
    recoveryRequestId: null,
    recoveryAbortController: null,
    recoveryEpoch: 0,
    accountDiscoveryPromise: null,
    automaticAccountDiscoveryStarted: false,
    latestMessageIdsByConversation: new Map(),
    observedMessageKeys: new Set(),
    sellerCentreListInitialized: false,
    pollingConnected: false,
    pollingConnectedAt: null,
    pollingRefreshInFlight: false,
  };
  state.surface ??= currentSurface;
  if (state.surface !== currentSurface) {
    state.surface = currentSurface;
    state.getTemplate = null;
    state.listTemplate = null;
    state.historyTemplate = null;
    state.sendTemplate = null;
    state.latestMessageIdsByConversation = new Map();
    state.observedMessageKeys = new Set();
    state.sellerCentreListInitialized = false;
    state.pollingConnected = false;
    state.pollingConnectedAt = null;
    state.pollingRefreshInFlight = false;
  }
  state.profilesByConversation ??= new Map();
  state.conversationsById ??= new Map();
  state.accountsById ??= new Map();
  state.sendErrorsByClientMessageId ??= new Map();
  state.nextRecoveryRequestAt ??= 0;
  state.recoveryRequestId ??= null;
  state.recoveryAbortController ??= null;
  state.recoveryEpoch ??= 0;
  state.accountDiscoveryPromise ??= null;
  state.automaticAccountDiscoveryStarted ??= false;
  state.latestMessageIdsByConversation ??= new Map();
  state.observedMessageKeys ??= new Set();
  state.sellerCentreListInitialized ??= false;
  state.pollingConnected ??= false;
  state.pollingConnectedAt ??= null;
  state.pollingRefreshInFlight ??= false;

  const { accountsFromPayload, conversationItems } = providerAdapter;

  const post = (message) => window.postMessage({ source: SOURCE, ...message }, window.location.origin);
  const postLog = (level, event, message, details = {}) => post({
    type: "diagnostic_log",
    level,
    event,
    message,
    details,
  });

  const surfaceCapabilities = () => ({
    account_detection: Boolean(state.listTemplate),
    message_observation: isSellerCentreSurface()
      ? Boolean(state.listTemplate && state.getTemplate)
      : Boolean(state.socket),
    message_recovery: Boolean(state.listTemplate && state.getTemplate),
    send_text: Boolean(state.listTemplate && state.getTemplate),
    send_image: Boolean(state.listTemplate && state.getTemplate),
    send_product: Boolean(state.listTemplate && state.getTemplate),
  });

  const publishSurfaceStatus = () => {
    const capabilities = surfaceCapabilities();
    const ready = Boolean(state.listTemplate && state.getTemplate);
    post({
      type: "provider_status",
      surface: state.surface,
      surface_ready: ready,
      capabilities,
      realtime_transport: isSellerCentreSurface() ? "polling" : "socket",
      realtime_connected: isSellerCentreSurface() ? state.pollingConnected : Boolean(state.socket?.connected ?? state.socket),
      ...(isSellerCentreSurface() && state.pollingConnected ? { connected_at: state.pollingConnectedAt ?? new Date().toISOString() } : {}),
    });
  };

  function errorDetails(error) {
    return {
      error_type: typeof error?.name === "string" && error.name.trim() ? error.name : "Error",
      error_message: typeof error?.message === "string" && error.message.trim()
        ? error.message
        : String(error ?? "Unknown error."),
      ...(typeof error?.stack === "string" && error.stack.trim() ? { error_stack: error.stack } : {}),
    };
  }

  function logAsyncError(scope, error, details = {}) {
    postLog("error", "async_error", "Extension async operation failed.", {
      scope,
      ...errorDetails(error),
      ...details,
    });
  }

  function observeAsync(scope, task, details = {}) {
    return Promise.resolve()
      .then(task)
      .catch((error) => logAsyncError(scope, error, details));
  }

  window.addEventListener("error", (event) => {
    postLog("error", "uncaught_error", "Unhandled provider error.", {
      scope: "provider",
      error_kind: "error_event",
      ...errorDetails(event?.error ?? event?.message),
    });
  });
  window.addEventListener("unhandledrejection", (event) => {
    postLog("error", "uncaught_error", "Unhandled provider error.", {
      scope: "provider",
      error_kind: "unhandled_rejection",
      ...errorDetails(event?.reason),
    });
  });

  const pathOf = (url) => {
    try { return new URL(url, window.location.href).pathname; }
    catch { return ""; }
  };
  const surfaceProfile = () => SURFACE_PROFILES[state.surface] ?? SURFACE_PROFILES[LEGACY_SURFACE];
  const isSellerCentreSurface = () => state.surface === SELLER_CENTRE_SURFACE;
  const isListPath = (path) => surfaceProfile().listPaths.includes(path);
  const isHistoryPath = (path) => surfaceProfile().historyPathPattern.test(path);
  const isSendPath = (path) => path === surfaceProfile().sendPath;
  const value = (input) => {
    if (typeof input !== "string" && typeof input !== "number") return null;
    const normalized = String(input).trim();
    return normalized || null;
  };
  const firstValue = (item, keys) => keys.map((key) => value(item?.[key])).find(Boolean) ?? null;
  const postAccounts = (requestId) => {
    const accounts = [...state.accountsById.values()];
    if (!accounts.length) return false;
    post({
      type: "accounts_detected",
      accounts,
      ...(requestId ? { request_id: requestId } : {}),
    });
    return true;
  };
  const mergeAccounts = (accounts, requestId, publish = true) => {
    for (const account of accounts) {
      const id = value(account?.provider_account_id);
      if (!id) continue;
      const previous = state.accountsById.get(id) ?? {};
      state.accountsById.set(id, { ...previous, ...account, provider: "shopee", provider_account_id: id });
    }
    if (publish) postAccounts(requestId);
    return [...state.accountsById.values()];
  };
  const captureAccount = (response) => {
    void response.clone().json().then((body) => {
      mergeAccounts(accountsFromPayload(body));
    }).catch((error) => logAsyncError("account_capture", error));
  };
  const captureAccounts = (response) => {
    void response.clone().json().then((body) => {
      mergeAccounts(accountsFromPayload(body));
      captureProfiles(conversationItems(body));
    }).catch((error) => logAsyncError("accounts_capture", error));
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
    const response = await state.nativeFetch(request, {
      signal: state.recoveryAbortController?.signal,
    });
    if (state.recoveryRequestId) {
      post({ type: "recovery_activity", request_id: state.recoveryRequestId });
    }
    return response;
  };

  const waitForTemplate = async () => {
    const deadline = Date.now() + 15_000;
    while ((!state.listTemplate || !state.getTemplate) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!state.listTemplate || !state.getTemplate) throw new Error("Refresh Shopee Seller Chat once to initialize realtime sync.");
  };

  async function fetchShopList() {
    const shopListPath = surfaceProfile().shopListPath;
    if (!shopListPath) return [];
    const template = state.listTemplate ?? state.getTemplate;
    if (!template) return [];
    const url = new URL(template.url);
    url.pathname = shopListPath;
    const init = { ...template.init, method: "GET" };
    delete init.body;
    const response = await state.nativeFetch(new Request(url, init));
    if (!response.ok) return [];
    let body;
    try {
      body = await response.json();
    } catch (error) {
      logAsyncError("shop_list_response_parse", error);
      return [];
    }
    if (!body) return [];
    const accounts = accountsFromPayload(body);
    mergeAccounts(accounts, null, false);
    captureProfiles(conversationItems(body));
    return accounts;
  }

  const isShopeeChatPage = () => Boolean(
    providerAdapter.surfaceForUrl?.(window.location.href)
      ?? globalThis.OmnichatShopeeUrl?.surfaceForUrl?.(window.location.href),
  );

  async function discoverAccounts() {
    if (state.accountDiscoveryPromise) return state.accountDiscoveryPromise;
    state.accountDiscoveryPromise = (async () => {
      let lastResult = null;
      let lastError = null;
      for (let attempt = 0; attempt < ACCOUNT_DISCOVERY_MAX_ATTEMPTS; attempt += 1) {
        try {
          await waitForTemplate();
          const shopListAccounts = await fetchShopList();
          await fetchConversations(false);
          lastResult = {
            accounts: [...state.accountsById.values()],
            shopListAccounts,
          };
          if (shopListAccounts.length || isSellerCentreSurface() || attempt === ACCOUNT_DISCOVERY_MAX_ATTEMPTS - 1) {
            if (!shopListAccounts.length && !isSellerCentreSurface()) {
              postLog("warn", "shop_discovery_incomplete", "Shopee shop list was empty after account discovery.");
            }
            postAccounts();
            return lastResult.accounts;
          }
        } catch (error) {
          lastError = error;
          if (attempt === ACCOUNT_DISCOVERY_MAX_ATTEMPTS - 1) throw error;
          postLog("warn", "shop_discovery_retry", "Shopee shop discovery will retry after page startup.", {
            error_type: error instanceof Error ? error.constructor.name : "Error",
          });
        }
        await new Promise((resolve) => setTimeout(resolve, ACCOUNT_DISCOVERY_RETRY_DELAY_MS));
      }
      if (lastError) throw lastError;
      return lastResult?.accounts ?? [];
    })().finally(() => {
      state.accountDiscoveryPromise = null;
    });
    return state.accountDiscoveryPromise;
  }

  const startAutomaticAccountDiscovery = () => {
    if (!isShopeeChatPage() || state.automaticAccountDiscoveryStarted) return;
    state.automaticAccountDiscoveryStarted = true;
    void discoverAccounts().catch((error) => {
      postLog("warn", "shop_discovery_failed", "Shopee shop discovery failed during page startup.", {
        ...errorDetails(error),
      });
    });
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

  const resetRecovery = (reason = "Provider bridge reconnected; retrying recovery.") => {
    const hadRecovery = Boolean(
      state.recoveryInFlight
      || state.recoveryRequestId
      || state.acknowledgements.size,
    );
    state.recoveryEpoch += 1;
    state.recoveryAbortController?.abort();
    state.recoveryAbortController = null;
    for (const [acknowledgementId, acknowledge] of state.acknowledgements) {
      state.acknowledgements.delete(acknowledgementId);
      try {
        acknowledge({ ok: false, error: reason });
      } catch {
        // A stale page acknowledgement must not prevent the bridge reset.
      }
    }
    state.recoveryRequestId = null;
    state.recoveryInFlight = false;
    return hadRecovery;
  };

  window.__omnichatRealtimeBridgeControl = {
    resetRecovery,
  };

  const captureProfiles = (conversations) => {
    const profiles = [];
    for (const conversation of Array.isArray(conversations) ? conversations : []) {
      const conversationId = String(conversation.id ?? "").trim();
      const id = String(conversation.to_id ?? "").trim();
      if (!conversationId || !id) continue;
      state.conversationsById.set(conversationId, {
        conversation_id: conversationId,
        shop_id: String(conversation.shop_id ?? "").trim(),
        to_id: id,
        to_shop_id: String(conversation.to_shop_id ?? "").trim(),
        biz_id: String(conversation.biz_id ?? "0").trim() || "0",
      });
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
        ...(String(conversation.shop_id ?? "").trim()
          ? { provider_account_id: String(conversation.shop_id).trim() }
          : {}),
        ...(displayName ? { display_name: displayName } : {}),
        ...(avatarUrl ? { avatar_url: avatarUrl } : {})
      };
      state.profilesByConversation.set(conversationId, profile);
      profiles.push(profile);
    }
    if (profiles.length) post({ type: "profiles_detected", profiles });
  };

  const messageIdOf = (message) => firstValue(message ?? {}, ["id", "message_id"]);
  const latestMessageIdOf = (conversation) => firstValue(conversation ?? {}, [
    "latest_message_id",
    "last_message_id",
    "message_id",
  ]) ?? firstValue(conversation?.latest_message ?? {}, ["id", "message_id"]);
  const authQueryKeys = ["_uid", "_v", "csrf_token", "SPC_CDS_CHAT", "x-shop-region", "_api_source"];

  const emitRealtimeMessages = (messages, captureMethod = "poll") => {
    const accepted = [];
    for (const message of Array.isArray(messages) ? messages : []) {
      const conversationId = firstValue(message, ["conversation_id"]);
      const messageId = messageIdOf(message);
      if (!conversationId || !messageId) continue;
      const key = `${conversationId}:${messageId}`;
      if (state.observedMessageKeys.has(key)) continue;
      state.observedMessageKeys.add(key);
      accepted.push(message);
    }
    if (accepted.length) {
      post({
        type: "realtime_event",
        body: { messages: accepted },
        capture_method: captureMethod,
      });
    }
    return accepted.length;
  };

  const messageItems = (body, output = [], depth = 0, seen = new WeakSet()) => {
    if (depth > 8 || body === null || body === undefined) return output;
    if (Array.isArray(body)) {
      for (const item of body) messageItems(item, output, depth + 1, seen);
      return output;
    }
    if (typeof body !== "object" || seen.has(body)) return output;
    seen.add(body);
    if (messageIdOf(body) && firstValue(body, ["conversation_id"])) output.push(body);
    for (const value of Object.values(body)) messageItems(value, output, depth + 1, seen);
    return output;
  };

  const sellerCentreHistoryRequest = (conversation, template, offset = 0) => {
    const sourceUrl = new URL(template.url);
    const url = new URL(surfaceProfile().historyPath(conversation.id), sourceUrl.origin);
    for (const key of authQueryKeys) {
      if (sourceUrl.searchParams.has(key)) url.searchParams.set(key, sourceUrl.searchParams.get(key));
    }
    url.searchParams.set("shop_id", String(conversation.shop_id ?? ""));
    url.searchParams.set("biz_id", String(conversation.biz_id ?? 0));
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("limit", String(HISTORY_LIMIT));
    url.searchParams.set("direction", "older");
    url.searchParams.set("on_message_received", "true");
    const headers = new Headers(template.init?.headers ?? {});
    headers.delete("content-type");
    return new Request(url, {
      ...template.init,
      method: "GET",
      headers,
      body: undefined,
    });
  };

  async function fetchSellerCentreConversationMessages(conversation, previousLatestId, latestId) {
    const template = state.historyTemplate ?? state.getTemplate;
    if (!template) return;
    const response = await state.nativeFetch(sellerCentreHistoryRequest(conversation, template));
    if (!response.ok) throw new Error(`Shopee Seller Centre message poll returned ${response.status}.`);
    const body = await response.json();
    const messages = Array.isArray(body)
      ? body
      : conversationItems(body);
    const ordered = [...messages].sort((left, right) => {
      const difference = timeMs(left?.created_timestamp ?? left?.created_at)
        - timeMs(right?.created_timestamp ?? right?.created_at);
      if (difference) return difference;
      return String(messageIdOf(left) ?? "").localeCompare(String(messageIdOf(right) ?? ""));
    });
    const previousIndex = previousLatestId
      ? ordered.findIndex((message) => messageIdOf(message) === previousLatestId)
      : -1;
    const candidates = previousIndex >= 0
      ? ordered.slice(previousIndex + 1)
      : previousLatestId
        ? ordered
        : (latestId ? ordered.filter((message) => messageIdOf(message) === latestId) : ordered.slice(-1));
    const emitted = emitRealtimeMessages(candidates);
    if (emitted) postLog("debug", "seller_centre_messages_observed", "Seller Centre polling delivered new messages.", {
      conversation_id: String(conversation.id ?? ""),
      messages: emitted,
    });
  }

  async function captureSellerCentreConversationList(response) {
    let body;
    try {
      body = await response.clone().json();
    } catch (error) {
      logAsyncError("seller_centre_conversation_parse", error);
      return;
    }
    const conversations = conversationItems(body);
    mergeAccounts(accountsFromPayload(body), null, true);
    captureProfiles(conversations);
    const wasInitialized = state.sellerCentreListInitialized;
    const changed = [];
    for (const conversation of conversations) {
      const conversationId = String(conversation?.id ?? "").trim();
      if (!conversationId) continue;
      const latestId = latestMessageIdOf(conversation);
      const hadPrevious = state.latestMessageIdsByConversation.has(conversationId);
      const previousId = state.latestMessageIdsByConversation.get(conversationId) ?? null;
      state.latestMessageIdsByConversation.set(conversationId, latestId);
      if (wasInitialized && latestId && (!hadPrevious || latestId !== previousId)) {
        changed.push({ conversation, previousId, latestId });
      }
    }
    state.sellerCentreListInitialized = true;
    if (!wasInitialized || !changed.length) return;
    for (const item of changed) {
      try {
        await fetchSellerCentreConversationMessages(item.conversation, item.previousId, item.latestId);
      } catch (error) {
        logAsyncError("seller_centre_message_poll", error, {
          conversation_id: String(item.conversation?.id ?? ""),
        });
      }
    }
  }

  async function refreshSellerCentreConversations() {
    if (!isSellerCentreSurface() || !state.listTemplate || state.pollingRefreshInFlight) return;
    state.pollingRefreshInFlight = true;
    try {
      const response = await state.nativeFetch(new Request(state.listTemplate.url, {
        ...state.listTemplate.init,
        body: state.listTemplate.body?.slice(0),
      }));
      if (!response.ok) throw new Error(`Shopee Seller Centre conversation refresh returned ${response.status}.`);
      await captureSellerCentreConversationList(response);
    } finally {
      state.pollingRefreshInFlight = false;
    }
  }

  const captureSendTemplate = async (request) => {
    try {
      const payload = JSON.parse(await request.clone().text());
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
      state.sendTemplate = {
        url: request.url,
        headers: Object.fromEntries(request.headers.entries()),
        payload,
      };
      publishSurfaceStatus();
    } catch (error) {
      logAsyncError("send_template_capture", error);
    }
  };

  const senderTemplate = (routing, requestId, clientMessageId) => {
    if (state.sendTemplate) return state.sendTemplate;
    if (!state.getTemplate) return null;

    const sourceUrl = new URL(state.getTemplate.url);
    const profile = surfaceProfile();
    const url = new URL(profile.sendPath, sourceUrl.origin);
    for (const key of authQueryKeys) {
      if (sourceUrl.searchParams.has(key)) url.searchParams.set(key, sourceUrl.searchParams.get(key));
    }
    if (!isSellerCentreSurface()) {
      url.searchParams.set("shop_id", routing.shop_id);
      url.searchParams.set("biz_id", routing.biz_id);
      url.searchParams.set("uuid", clientMessageId);
    }

    const headers = Object.fromEntries(new Headers(state.getTemplate.init.headers).entries());
    headers["content-type"] = "application/json";
    return {
      url: url.toString(),
      headers,
      payload: {
        request_id: requestId,
        type: "text",
        conversation_id: routing.conversation_id,
        shop_id: numericId(routing.shop_id),
        to_id: numericId(routing.to_id),
        biz_id: numericId(routing.biz_id),
        ...(routing.to_shop_id ? { to_shop_id: numericId(routing.to_shop_id) } : {}),
        content: { uid: clientMessageId },
        chat_send_option: {
          force_send_cancel_order_warning: false,
          comply_cancel_order_warning: false,
        },
        source_content: {},
        entry_point: "direct_chat_entry_point",
        choice_info: { real_shop_id: isSellerCentreSurface() ? numericId(routing.shop_id) : null },
        ...(profile.sendSource ? { source: profile.sendSource } : {}),
      },
    };
  };

  const numericId = (value) => {
    const normalized = String(value ?? "").trim();
    if (!/^\d+$/.test(normalized)) return value;
    const parsed = Number(normalized);
    return Number.isSafeInteger(parsed) ? parsed : value;
  };

  const updateKnown = (payload, key, value) => {
    if (!value || !Object.hasOwn(payload, key)) return;
    payload[key] = ["shop_id", "to_id", "to_shop_id", "biz_id"].includes(key)
      ? numericId(value)
      : value;
  };

  const shopeeError = (body) => {
    const code = typeof body?.error_code === "string" && body.error_code.trim()
      && !["0", "success"].includes(body.error_code.toLowerCase())
      ? body.error_code
      : null;
    if (!code && !body?.error) return null;
    return typeof body?.message === "string" && body.message.trim()
      ? body.message
      : code ?? (typeof body?.error === "string" ? body.error : null);
  };

  const quotedMessageId = (message) => {
    if (message?.reply_to_provider_message_id === undefined) return null;
    if (typeof message.reply_to_provider_message_id !== "string") {
      throw new Error("Reply quote is invalid.");
    }
    const normalized = message.reply_to_provider_message_id.trim();
    if (!normalized || normalized.length > 200) throw new Error("Reply quote is invalid.");
    return normalized;
  };

  const withQuotedMessageId = (content, providerMessageId) => providerMessageId
    ? { ...content, quoted_msg_id: providerMessageId }
    : content;

  const captureShopeeSendError = async (request, response) => {
    let clientMessageId = new URL(request.url).searchParams.get("uuid");
    if (!clientMessageId) {
      try {
        const payload = await request.clone().json();
        clientMessageId = firstValue(payload?.content ?? payload, ["uid", "client_message_id"]);
      } catch (error) {
        logAsyncError("send_error_request_parse", error);
      }
    }
    if (!clientMessageId) return;
    let body = null;
    try {
      body = await response.clone().json();
    } catch (error) {
      logAsyncError("send_error_response_parse", error);
    }
    const error = shopeeError(body);
    if (!error) return;
    state.sendErrorsByClientMessageId.set(clientMessageId, error);
    setTimeout(() => state.sendErrorsByClientMessageId.delete(clientMessageId), 60_000);
  };

  const uploadImage = async (message, routing) => {
    if (!(message.image_bytes instanceof ArrayBuffer) || message.image_bytes.byteLength === 0) {
      throw new Error("Reply image is invalid.");
    }
    const sourceTemplateUrl = state.getTemplate?.url ?? state.sendTemplate?.url;
    if (!sourceTemplateUrl) throw new Error("Shopee image uploader is still initializing.");
    const sourceUrl = new URL(sourceTemplateUrl);
    const url = new URL(surfaceProfile().imagePath, sourceUrl.origin);
    for (const key of authQueryKeys) {
      if (sourceUrl.searchParams.has(key)) url.searchParams.set(key, sourceUrl.searchParams.get(key));
    }
    url.searchParams.set("shop_id", routing.shop_id);
    url.searchParams.set("biz_id", routing.biz_id);

    const type = String(message.image_type ?? "image/jpeg").trim();
    const extension = type.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "jpg";
    const form = new FormData();
    form.append("file", new Blob([message.image_bytes], { type }), `kaojai-reply.${extension}`);
    form.append("conversation_id", routing.conversation_id);
    const headers = new Headers(
      state.getTemplate?.init?.headers ?? state.sendTemplate?.headers ?? {},
    );
    headers.delete("content-type");
    headers.delete("content-length");
    const response = await state.nativeFetch(url.toString(), {
      method: "POST",
      body: form,
      credentials: "include",
      headers,
    });
    const body = await response.json().catch(() => null);
    const providerReason = shopeeError(body);
    if (!response.ok || providerReason || !body?.url) {
      throw new Error(providerReason ?? `Shopee image upload returned ${response.status}.`);
    }
    return {
      uid: String(message.client_message_id ?? message.request_id),
      url_hash: String(body.url).split("/").pop(),
      url: body.url,
      thumb_url: body.thumbnail,
      thumb_width: body.thumb_width,
      thumb_height: body.thumb_height,
      file_server_id: body.file_server_id,
    };
  };

  const sendApi = async (message) => {
    const requestId = String(message?.request_id ?? "").trim();
    const conversationId = String(message?.conversation_id ?? "").trim();
    const commandType = String(message?.command_type ?? "").trim();
    const clientMessageId = String(message?.client_message_id ?? requestId).trim();
    let routing = state.conversationsById.get(conversationId);
    if (!requestId || !conversationId || !clientMessageId || !providerAdapter.supportsSend(commandType)) {
      post({ type: "api_send_result", request_id: requestId, ok: false, error: "Reply command is invalid." });
      return;
    }
    if (isSellerCentreSurface() && (!state.listTemplate || !state.getTemplate)) {
      post({
        type: "api_send_result",
        request_id: requestId,
        ok: false,
        error: "Seller Centre chat is still initializing. Open the Chat panel and wait for its conversation list.",
      });
      publishSurfaceStatus();
      return;
    }
    if (!routing) {
      try {
        await waitForTemplate();
        await fetchConversations();
        routing = state.conversationsById.get(conversationId);
      } catch (error) {
        logAsyncError("send_routing", error, { conversation_id: conversationId });
        // The routing error below gives the user the actionable next step.
      }
    }
    if (!routing?.shop_id || !routing.to_id) {
      post({ type: "api_send_result", request_id: requestId, ok: false, error: "Conversation routing is unavailable. Refresh Shopee Seller Chat." });
      return;
    }
    const poster = window.__chat_anti_fraud__?.poster;
    if (typeof poster !== "function") {
      post({ type: "api_send_result", request_id: requestId, ok: false, error: "Shopee secure sender is unavailable. Refresh Seller Chat." });
      return;
    }
    try {
      const template = senderTemplate(routing, requestId, clientMessageId);
      if (!template) throw new Error("Shopee Seller Chat is still initializing. Refresh and wait for the conversation list.");
      const payload = structuredClone(template.payload);
      payload.request_id = requestId;
      updateKnown(payload, "conversation_id", conversationId);
      updateKnown(payload, "shop_id", routing.shop_id);
      updateKnown(payload, "to_id", routing.to_id);
      updateKnown(payload, "to_shop_id", routing.to_shop_id);
      updateKnown(payload, "biz_id", routing.biz_id);
      if (commandType === "send_text") {
        const text = String(message?.text ?? "").trim();
        if (!text) throw new Error("Reply text is invalid.");
        const providerMessageId = quotedMessageId(message);
        payload.type = "text";
        payload.content = withQuotedMessageId({ text, uid: clientMessageId }, providerMessageId);
      } else if (commandType === "send_image") {
        const providerMessageId = quotedMessageId(message);
        payload.type = "image";
        payload.content = withQuotedMessageId(await uploadImage(message, routing), providerMessageId);
      } else {
        const providerProductId = String(message?.provider_product_id ?? "").trim();
        const productName = String(message?.product_name ?? "").trim();
        if (!/^\d+$/.test(providerProductId) || !productName) {
          throw new Error("Shopee product is invalid.");
        }
        payload.type = "product";
        payload.content = {
          uid: clientMessageId,
          product_id: numericId(providerProductId),
          shop_id: numericId(routing.shop_id),
          product_name: productName,
        };
      }
      const url = new URL(template.url);
      if (isSellerCentreSurface()) url.searchParams.delete("uuid");
      else url.searchParams.set("uuid", clientMessageId);
      const response = await poster(url.toString(), payload, { headers: template.headers });
      let body = response;
      if (typeof response?.clone === "function") {
        try {
          body = await response.clone().json();
        } catch (error) {
          logAsyncError("send_response_parse", error);
          body = null;
        }
      }
      const providerReason = state.sendErrorsByClientMessageId.get(clientMessageId) ?? shopeeError(body);
      state.sendErrorsByClientMessageId.delete(clientMessageId);
      if (response?.ok === false || providerReason) {
        throw new Error(providerReason ?? `Shopee API returned ${response?.status ?? "an error"}.`);
      }
      const providerMessageId = String(
        body?.id
        ?? body?.message_id
        ?? body?.message?.id
        ?? body?.data?.id
        ?? body?.data?.message_id
        ?? body?.data?.message?.id
        ?? ""
      ).trim();
      post({ type: "api_send_result", request_id: requestId, ok: true, ...(providerMessageId ? { provider_message_id: providerMessageId } : {}) });
    } catch (error) {
      const providerReason = state.sendErrorsByClientMessageId.get(clientMessageId);
      state.sendErrorsByClientMessageId.delete(clientMessageId);
      logAsyncError("send_api", error, {
        conversation_id: conversationId,
        command_type: commandType,
      });
      post({ type: "api_send_result", request_id: requestId, ok: false, error: providerReason ?? (error instanceof Error ? error.message : String(error)) });
    }
  };
  const captureActiveConversation = (request) => {
    const path = pathOf(request.url);
    if (!isHistoryPath(path)) return;
    const match = path.match(/\/conversations\/([^/]+)\/messages$/);
    if (!match) return;
    const conversationId = decodeURIComponent(match[1]);
    if (!conversationId || state.activeConversationId === conversationId) return;
    state.activeConversationId = conversationId;
    post({ type: "active_conversation", conversation_id: conversationId });
  };

  const conversationTime = (conversation) => timeMs(
    conversation?.last_message_time ?? conversation?.created_timestamp,
  );

  const conversationToken = (conversation) => {
    const id = firstValue(conversation ?? {}, [
      "last_message_id",
      "latest_message_id",
      "message_id",
    ]) ?? firstValue(conversation?.last_message ?? {}, ["id", "message_id"]);
    return id ? `message:${id}` : null;
  };

  const nextConversationUrl = (currentUrl, body, items) => {
    const url = new URL(currentUrl);
    const nextCursor = firstValue(body ?? {}, ["next_cursor", "nextCursor"])
      ?? firstValue(body?.data ?? {}, ["next_cursor", "nextCursor"]);
    if (nextCursor) {
      url.searchParams.set(
        url.searchParams.has("next_cursor") ? "next_cursor" : "cursor",
        nextCursor,
      );
      return url.toString();
    }
    const limit = Number(url.searchParams.get("limit") ?? url.searchParams.get("page_size"));
    if (!Number.isFinite(limit) || limit <= 0 || items.length !== limit) return null;
    if (url.searchParams.has("offset")) {
      const offset = Number(url.searchParams.get("offset")) || 0;
      url.searchParams.set("offset", String(offset + limit));
      return url.toString();
    }
    if (url.searchParams.has("page")) {
      const page = Number(url.searchParams.get("page")) || 0;
      url.searchParams.set("page", String(page + 1));
      return url.toString();
    }
    return null;
  };

  async function fetchConversationPage(requestUrl = state.listTemplate.url, accountId = null, publish = true) {
    const response = await recoveryFetch(new Request(requestUrl, {
      ...state.listTemplate.init,
      body: state.listTemplate.body?.slice(0)
    }));
    if (!response.ok) throw new Error(`Shopee conversation recovery returned ${response.status}. Refresh Seller Chat.`);
    const body = await response.json();
    const allItems = conversationItems(body);
    mergeAccounts(accountsFromPayload(body), null, publish);
    captureProfiles(allItems);
    const items = accountId
      ? allItems.filter((conversation) => String(conversation?.shop_id ?? "").trim() === accountId)
      : allItems;
    return {
      items,
      raw_count: allItems.length,
      next: nextConversationUrl(requestUrl, body, allItems),
    };
  }

  async function fetchConversations(publish = true) {
    return (await fetchConversationPage(state.listTemplate.url, null, publish)).items;
  }

  async function fetchConversationPages({
    checkpointMs = 0,
    requiredIds = null,
    maxItems = null,
    accountId = null,
  } = {}) {
    const conversations = [];
    const seenIds = new Set();
    const required = requiredIds ? new Set(requiredIds) : null;
    let url = state.listTemplate.url;
    let firstPage = [];
    while (url) {
      const page = await fetchConversationPage(url, accountId);
      if (!firstPage.length) firstPage = page.items;
      let added = 0;
      for (const conversation of page.items) {
        const id = String(conversation?.id ?? "");
        if (!id || seenIds.has(id)) continue;
        seenIds.add(id);
        conversations.push(conversation);
        required?.delete(id);
        added += 1;
      }
      if (maxItems && conversations.length >= maxItems) break;
      const oldest = page.items.reduce((value, conversation) => {
        const candidate = conversationTime(conversation);
        return candidate && candidate < value ? candidate : value;
      }, Number.POSITIVE_INFINITY);
      if (required && required.size === 0) break;
      if (!required && checkpointMs && oldest < checkpointMs) break;
      if (!page.next || (!added && !page.raw_count)) break;
      url = page.next;
    }
    return { conversations, firstPage };
  }

  async function detectCurrentAccount(requestId) {
    try {
      await discoverAccounts();
      if (!postAccounts(requestId)) throw new Error("Shopee Shop ID was not found.");
    } catch (error) {
      logAsyncError("account_detection", error);
      post({ type: "account_detection_failed", request_id: requestId, error: String(error) });
    }
  }

  async function fetchHistory(conversation, cursor, maxMessages, onPage) {
    const sinceMs = timeMs(cursor?.event_timestamp);
    const pageSize = Math.min(HISTORY_LIMIT, maxMessages ?? HISTORY_LIMIT);
    let accepted = 0;
    let parsed = 0;
    let queued = 0;
    let latestCursor = null;
    for (let page = 0; ; page += 1) {
      const historyTemplate = state.historyTemplate ?? state.getTemplate;
      if (!historyTemplate) throw new Error("Shopee message history is still initializing. Refresh Seller Chat.");
      const sourceUrl = new URL(historyTemplate.url);
      const url = new URL(surfaceProfile().historyPath(conversation.id), sourceUrl.origin);
      for (const key of authQueryKeys) {
        if (sourceUrl.searchParams.has(key)) url.searchParams.set(key, sourceUrl.searchParams.get(key));
      }
      url.searchParams.set("shop_id", conversation.shop_id);
      url.searchParams.set("offset", String(page * pageSize));
      url.searchParams.set("limit", String(pageSize));
      url.searchParams.set("direction", "older");
      url.searchParams.set("biz_id", String(conversation.biz_id ?? 0));
      if (isSellerCentreSurface()) url.searchParams.set("on_message_received", "true");
      const headers = new Headers(historyTemplate.init.headers);
      headers.delete("content-type");
      const response = await recoveryFetch(new Request(url, {
        ...historyTemplate.init,
        method: "GET",
        headers,
        body: undefined,
      }));
      if (!response.ok) throw new Error(`Shopee message recovery returned ${response.status}. Refresh Seller Chat.`);
      const pageMessages = await response.json();
      if (!Array.isArray(pageMessages)) break;
      let currentMessages = pageMessages
        .filter((message) => timeMs(message.created_timestamp ?? message.created_at) >= sinceMs)
        .sort((left, right) => {
          const timeDifference = timeMs(right.created_timestamp ?? right.created_at)
            - timeMs(left.created_timestamp ?? left.created_at);
          if (timeDifference) return timeDifference;
          const rightId = String(right.id ?? right.message_id ?? "");
          const leftId = String(left.id ?? left.message_id ?? "");
          return rightId === leftId ? 0 : rightId > leftId ? 1 : -1;
        });
      if (maxMessages) currentMessages = currentMessages.slice(0, maxMessages - accepted);
      if (currentMessages.length) {
        const acknowledgement = await onPage(currentMessages, page);
        parsed += acknowledgement.parsed ?? 0;
        queued += acknowledgement.queued ?? 0;
        latestCursor ??= acknowledgement.latest_cursor ?? null;
        accepted += currentMessages.length;
      }
      if (maxMessages && accepted >= maxMessages) break;
      const oldest = pageMessages.reduce((value, message) => {
        const candidate = timeMs(message.created_timestamp ?? message.created_at);
        return candidate && candidate < value ? candidate : value;
      }, Number.POSITIVE_INFINITY);
      if (pageMessages.length < pageSize || oldest < sinceMs) break;
    }
    return { parsed, queued, latestCursor };
  }

  async function recover(requestId, checkpoint = {}) {
    if (state.recoveryInFlight) {
      post({ type: "recovery_complete", request_id: requestId, ok: false, error: "Recovery is already running." });
      return;
    }
    const recoveryEpoch = state.recoveryEpoch;
    state.recoveryInFlight = true;
    state.recoveryRequestId = requestId;
    state.recoveryAbortController = new AbortController();
    const startedAt = Date.now();
    let parsed = 0;
    let queued = 0;
    let checked = 0;
    try {
      postLog("info", "recovery_started", "Shopee recovery started.", {
        checkpoint_present: Boolean(checkpoint?.watermark),
      });
      await waitForTemplate();
      const watermarkMs = timeMs(checkpoint?.watermark);
      const bootstrap = !watermarkMs;
      const frozenBootstrap = Array.isArray(checkpoint?.bootstrap?.conversations)
        ? checkpoint.bootstrap.conversations
        : [];
      const accountId = value(checkpoint?.provider_account_id);
      const requiredIds = bootstrap && frozenBootstrap.length
        ? frozenBootstrap.map((conversation) => String(conversation.id))
        : null;
      const pages = await fetchConversationPages({
        checkpointMs: bootstrap ? 0 : watermarkMs,
        requiredIds,
        maxItems: bootstrap && !requiredIds ? MANUAL_SYNC_MAX_CONVERSATIONS : null,
        accountId,
      });
      const sorted = [...pages.conversations]
        .sort((left, right) => conversationTime(right) - conversationTime(left));
      let recoveryConversations;
      if (bootstrap && frozenBootstrap.length) {
        const liveById = new Map(sorted.map((conversation) => [String(conversation.id), conversation]));
        recoveryConversations = frozenBootstrap.map(
          (conversation) => liveById.get(String(conversation.id)) ?? conversation,
        );
      } else if (bootstrap) {
        recoveryConversations = sorted.slice(0, MANUAL_SYNC_MAX_CONVERSATIONS);
        const bootstrapRequestId = `${requestId}:bootstrap`;
        post({
          type: "recovery_bootstrap",
          request_id: bootstrapRequestId,
          provider_account_id: accountId,
          conversations: recoveryConversations,
        });
        const acknowledgement = await waitForAcknowledgement(bootstrapRequestId);
        if (!acknowledgement.ok) {
          throw new Error(acknowledgement.error ?? "Could not save bootstrap state.");
        }
      } else {
        recoveryConversations = sorted;
      }
      const firstPageFloor = pages.firstPage.reduce((value, conversation) => {
        const candidate = conversationTime(conversation);
        return candidate && candidate < value ? candidate : value;
      }, Number.POSITIVE_INFINITY);
      const bootstrapFloor = recoveryConversations.reduce((value, conversation) => {
        const candidate = conversationTime(conversation);
        return candidate && candidate < value ? candidate : value;
      }, Number.POSITIVE_INFINITY);
      const nextWatermarkMs = bootstrap
        ? bootstrapFloor
        : (Number.isFinite(firstPageFloor) ? Math.max(watermarkMs, firstPageFloor) : watermarkMs);
      const cursors = checkpoint?.conversations ?? {};
      const classify = (conversation) => {
        const cursor = cursors[String(conversation.id)];
        const cursorMs = timeMs(cursor?.event_timestamp);
        const summaryMs = conversationTime(conversation);
        const token = conversationToken(conversation);
        if (bootstrap) return { decision: "history_job", reason: "bootstrap", cursor, token };
        if (!summaryMs) return { decision: "probe", reason: "missing_summary_time", cursor, token };
        if (!cursorMs) {
          return summaryMs >= watermarkMs
            ? { decision: "history_job", reason: "new_conversation", cursor, token }
            : { decision: "skip", reason: "summary_older_than_checkpoint", cursor, token };
        }
        if (summaryMs > cursorMs) return { decision: "history_job", reason: "summary_newer", cursor, token };
        if (summaryMs < cursorMs) return { decision: "skip", reason: "summary_older_than_cursor", cursor, token };
        if (token && token === cursor.summary_token) {
          return { decision: "skip", reason: "same_summary_token", cursor, token };
        }
        return { decision: "probe", reason: "same_timestamp", cursor, token };
      };
      const classified = recoveryConversations.map((conversation) => ({
        conversation,
        ...classify(conversation),
      }));
      post({
        type: "sync_plan",
        request_id: requestId,
        provider_account_id: accountId,
        mode: bootstrap ? "bootstrap" : "incremental",
        checkpoint: watermarkMs ? new Date(watermarkMs).toISOString() : null,
        conversations: classified.slice(0, 10).map(({ conversation, cursor, decision, reason }) => {
          const cursorMs = timeMs(cursor?.event_timestamp);
          const summaryMs = conversationTime(conversation);
          return {
            conversation_id: String(conversation.id ?? ""),
            summary_timestamp: summaryMs ? new Date(summaryMs).toISOString() : null,
            cursor_timestamp: cursorMs ? new Date(cursorMs).toISOString() : null,
            cursor_message_id: cursor?.message_id ? String(cursor.message_id) : null,
            decision,
            reason,
          };
        }),
      });
      const probes = classified.filter(({ decision }) => decision === "probe");
      const recoveryJobs = classified.filter(({ decision }) => decision === "history_job");
      const totalConversations = probes.length + recoveryJobs.length;
      postLog("info", "recovery_plan", "Shopee recovery plan prepared.", {
        candidates: classified.length,
        history_jobs: recoveryJobs.length,
        probes: probes.length,
        skipped: classified.filter(({ decision }) => decision === "skip").length,
      });
      let completedConversations = 0;
      if (totalConversations) {
        post({ type: "recovery_progress", request_id: requestId, provider_account_id: accountId, completed_conversations: completedConversations, total_conversations: totalConversations });
      }
      for (const item of [...probes, ...recoveryJobs]) {
        const { conversation, cursor, token, decision } = item;
        checked += 1;
        postLog("debug", "conversation_started", "Checking one conversation for missed messages.", {
          position: checked,
          total: probes.length + recoveryJobs.length,
          decision,
        });
        const history = await fetchHistory(
          conversation,
          cursor,
          bootstrap ? MANUAL_SYNC_MAX_MESSAGES_PER_CONVERSATION : undefined,
          async (messages, page) => {
            const batchRequestId = `${requestId}:${conversation.id}:${page}`;
            post({ type: "recovery_batch", request_id: batchRequestId, provider_account_id: accountId, body: messages });
            const acknowledgement = await waitForAcknowledgement(batchRequestId);
            if (!acknowledgement.ok) {
              throw new Error(acknowledgement.error ?? "Could not queue recovered messages.");
            }
            return acknowledgement;
          },
        );
        parsed += history.parsed;
        queued += history.queued;
        const summaryMs = conversationTime(conversation);
        const completedCursor = history.latestCursor
          ?? cursor
          ?? (summaryMs ? {
            event_timestamp: new Date(summaryMs).toISOString(),
            message_id: "",
          } : null);
        if (completedCursor) {
          const cursorRequestId = `${requestId}:${conversation.id}:cursor`;
          post({
            type: "recovery_cursor",
            request_id: cursorRequestId,
            provider_account_id: accountId,
            conversation_id: String(conversation.id),
            cursor: completedCursor,
            summary_token: token,
          });
          const acknowledgement = await waitForAcknowledgement(cursorRequestId);
          if (!acknowledgement.ok) {
            throw new Error(acknowledgement.error ?? "Could not save sync cursor.");
          }
        }
        completedConversations += 1;
        post({ type: "recovery_progress", request_id: requestId, provider_account_id: accountId, completed_conversations: completedConversations, total_conversations: totalConversations });
        postLog("debug", "conversation_completed", "Conversation recovery check completed.", {
          position: checked,
          parsed: history.parsed,
          queued: history.queued,
          decision,
        });
      }
      post({
        type: "recovery_complete",
        request_id: requestId,
        provider_account_id: accountId,
        ok: true,
        recovered: parsed,
        queued,
        conversations_checked: checked,
        watermark: Number.isFinite(nextWatermarkMs)
          ? new Date(nextWatermarkMs).toISOString()
          : checkpoint?.watermark ?? null,
      });
      postLog("info", "recovery_completed", "Shopee recovery completed.", {
        parsed,
        queued,
        conversations_checked: checked,
        duration_ms: Date.now() - startedAt,
      });
    } catch (error) {
      if (state.recoveryEpoch !== recoveryEpoch) {
        post({
          type: "recovery_complete",
          request_id: requestId,
          provider_account_id: accountId,
          ok: false,
          error: "Recovery was superseded by a bridge reconnect.",
        });
        return;
      }
      postLog("error", "recovery_failed", error instanceof Error ? error.message : String(error), {
        conversations_checked: checked,
        duration_ms: Date.now() - startedAt,
        ...errorDetails(error),
      });
      post({ type: "recovery_complete", request_id: requestId, ok: false, error: String(error) });
    } finally {
      if (state.recoveryEpoch === recoveryEpoch && state.recoveryRequestId === requestId) {
        state.recoveryInFlight = false;
        state.recoveryRequestId = null;
        state.recoveryAbortController = null;
      }
    }
  }

  if (!window.fetch.__omnichatRealtimeBridge) {
    const originalFetch = state.nativeFetch;
    const observedFetch = async (input, init) => {
      const request = new Request(input, init);
      const path = pathOf(request.url);
      if (isSendPath(path) && request.method === "POST") {
        void observeAsync("send_template_capture", () => captureSendTemplate(request));
      }
      const response = await originalFetch(input, init);
      if (isSendPath(path) && request.method === "POST") {
        await captureShopeeSendError(request, response);
      }
      if (request.method === "GET") {
        captureActiveConversation(request);
        if (isHistoryPath(path)) {
          void observeAsync("history_template", () => templateFrom(request).then((template) => {
            state.historyTemplate = template;
            state.getTemplate ??= template;
            publishSurfaceStatus();
            postLog("info", "history_template_ready", "Shopee message-history request template captured.");
          }));
        }
      }
      if (path.startsWith("/webchat/api/") && request.method === "GET" && !state.getTemplate) {
        void observeAsync("history_template", () => templateFrom(request).then((template) => {
          state.getTemplate = template;
          publishSurfaceStatus();
          postLog("info", "history_template_ready", "Shopee history request template captured.");
        }));
      }
      if (isListPath(path)) {
        void observeAsync("conversation_template", () => templateFrom(request).then((template) => {
          const firstCapture = !state.listTemplate;
          state.listTemplate = template;
          publishSurfaceStatus();
          if (firstCapture) postLog("info", "list_template_ready", "Shopee conversation-list request template captured.");
          startAutomaticAccountDiscovery();
        }));
        if (isSellerCentreSurface()) {
          void observeAsync("seller_centre_conversation_capture", () => captureSellerCentreConversationList(response));
        } else {
          captureAccounts(response);
        }
      } else if (surfaceProfile().shopListPath && path === surfaceProfile().shopListPath) {
        captureAccounts(response);
      } else if (surfaceProfile().loginPath && path === surfaceProfile().loginPath) {
        captureAccount(response);
      } else if (isSellerCentreSurface() && path === "/webchat/api/workbenchapi/v1.2/mini/shop/setting") {
        captureAccount(response);
      } else if (isSellerCentreSurface() && path === surfaceProfile().syncPath && request.method === "POST") {
        state.pollingConnected = response.ok;
        if (state.pollingConnected) state.pollingConnectedAt ??= new Date().toISOString();
        publishSurfaceStatus();
        void observeAsync("seller_centre_sync_response", async () => {
          const body = await response.clone().json();
          if (body?.have_new_msg) await refreshSellerCentreConversations();
        });
      }
      return response;
    };
    Object.defineProperty(observedFetch, "__omnichatRealtimeBridge", { value: true });
    window.fetch = observedFetch;
  }

  function observeSocket() {
    if (isSellerCentreSurface()) {
      publishSurfaceStatus();
      return;
    }
    const socket = window.__CHAT_GLOBAL__?.socket;
    if (!socket?.on) {
      publishSurfaceStatus();
      return;
    }
    const connected = typeof socket.connected === "boolean" ? socket.connected : true;
    publishSurfaceStatus();
    if (state.socket === socket) return;
    state.socket = socket;
    if (document.documentElement) {
      document.documentElement.dataset.omnichatRealtime = connected ? "connected" : "disconnected";
    }
    if (connected) {
      post({ type: "socket_connected" });
      postLog("info", "socket_connected", "Shopee realtime socket connected.");
    }
    socket.on("connect", () => {
      if (document.documentElement) document.documentElement.dataset.omnichatRealtime = "connected";
      post({ type: "socket_connected" });
      publishSurfaceStatus();
    });
    socket.on("disconnect", () => {
      if (document.documentElement) document.documentElement.dataset.omnichatRealtime = "disconnected";
      publishSurfaceStatus();
    });
    socket.on("message", (event) => {
      const envelope = event?.data ?? event;
      if (envelope?.message_type !== "message") return;
      try {
        const body = typeof envelope.message_content === "string"
          ? JSON.parse(envelope.message_content)
          : envelope.message_content;
        const messages = messageItems(body);
        if (messages.length) emitRealtimeMessages(messages, "realtime_socket");
        else post({ type: "realtime_event", body, capture_method: "realtime_socket" });
      } catch (error) {
        logAsyncError("socket_message", error);
      }
    });
  }

  void observeAsync("socket_observer", observeSocket);
  setInterval(() => {
    void observeAsync("socket_observer", observeSocket);
  }, SOCKET_OBSERVER_INTERVAL_MS);

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== window.location.origin || event.data?.source !== SOURCE) return;
    if (event.data.type === "sync") {
      const providerAccountId = value(event.data.provider_account_id);
      void observeAsync("recovery", () => recover(event.data.request_id, {
        ...(event.data.checkpoint ?? {}),
        ...(providerAccountId ? { provider_account_id: providerAccountId } : {}),
      }));
    } else if (event.data.type === "cancel_sync") {
      if (state.recoveryRequestId === event.data.request_id) {
        state.recoveryAbortController?.abort();
      }
    } else if (event.data.type === "reset_recovery") {
      resetRecovery();
    } else if (event.data.type === "detect_account") {
      void observeAsync("account_detection", () => detectCurrentAccount(event.data.request_id));
    } else if (event.data.type === "send_api") {
      void observeAsync("send_api", () => sendApi(event.data));
    } else if (event.data.type === "recovery_ack") {
      const acknowledge = state.acknowledgements.get(event.data.request_id);
      if (acknowledge) {
        state.acknowledgements.delete(event.data.request_id);
        acknowledge(event.data);
      }
    }
  });
})();
