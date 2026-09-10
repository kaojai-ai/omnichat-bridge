(() => {
  const SOURCE = "omnichat-realtime-bridge-v3";
  const BRIDGE_VERSION = "line-oa-poll-7";
  const CHAT_PAGE_LIMIT = 25;
  const PAGE_LIMIT = 100;
  const INITIAL_SYNC_MAX_CONVERSATIONS = 10;
  const INITIAL_SYNC_MAX_MESSAGES_PER_CONVERSATION = 25;
  const REQUEST_TIMEOUT_MS = 20_000;
  const ACK_TIMEOUT_MS = 20_000;
  const previous = window.__omnichatLineOABridgeControl;
  previous?.dispose?.();
  let disposed = false;
  let timer = null;
  let activePoll = null;
  const pollingAccounts = new Map();
  let pollGeneration = 0;
  const queuedSyncs = [];
  const acknowledgements = new Map();
  const knownChatIdsByAccount = new Map();
  const knownMessageIdsByAccount = new Map();
  const sendProfilesByBot = new Map();
  const nativeFetch = window.fetch.bind(window);
  const botIdFromUrl = () => String(window.location.pathname.split("/").filter(Boolean)[0] ?? "").trim();
  const basicIdFromPage = () => globalThis.OmnichatLineOA?.basicIdFromHtml?.() ?? "";
  const apiBase = "https://chat.line.biz/api";
  const post = (data) => window.postMessage({ source: SOURCE, ...data }, window.location.origin);
  const value = (input) => typeof input === "string" || typeof input === "number" ? String(input).trim() : "";
  const cursor = (input) => value(input) || null;
  const normalizeBasicId = (input) => {
    const normalized = value(input).replace(/^@+/, "");
    return normalized ? `@${normalized}` : "";
  };

  function messageSendPath(url) {
    const match = url.pathname.match(/^\/api\/v1\/bots\/([^/]+)\/chats\/([^/]+)\/messages\/send$/);
    return match ? { botId: decodeURIComponent(match[1]), conversationId: decodeURIComponent(match[2]) } : null;
  }

  function safeHeaders(input) {
    const headers = new Headers(input ?? {});
    const result = {};
    for (const name of ["accept", "content-type", "x-oa-chat-client-version"]) {
      const value = headers.get(name);
      if (value) result[name] = value;
    }
    return result;
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function profileFor(botId, type) {
    return sendProfilesByBot.get(botId)?.get(type) ?? {
      headers: { accept: "application/json", "content-type": "application/json", "x-oa-chat-client-version": "20240513144702" },
      payload: type === "image" ? { type, imageUrl: "" } : { type },
    };
  }

  function rememberSendProfile(url, init, payload) {
    const target = messageSendPath(url);
    if (!target || !payload || typeof payload !== "object" || Array.isArray(payload)) return;
    const type = value(payload.type);
    if (!["text", "image", "sticker"].includes(type)) return;
    const profiles = sendProfilesByBot.get(target.botId) ?? new Map();
    profiles.set(type, { headers: safeHeaders(init?.headers), payload: clone(payload) });
    sendProfilesByBot.set(target.botId, profiles);
    void publishProviderStatus();
  }

  function firstImageUrlPath(payload, path = []) {
    if (typeof payload === "string") return /^https:\/\//i.test(payload) ? path : null;
    if (!payload || typeof payload !== "object") return null;
    for (const [key, item] of Object.entries(payload)) {
      const found = firstImageUrlPath(item, [...path, key]);
      if (found) return found;
    }
    return null;
  }

  function setPath(object, path, nextValue) {
    let current = object;
    for (let index = 0; index < path.length - 1; index += 1) current = current[path[index]];
    current[path.at(-1)] = nextValue;
  }

  function commandCapabilities(botId) {
    return botId ? ["send_text", "send_image", "send_sticker"] : [];
  }

  async function publishProviderStatus(detectedAccounts) {
    const accounts = detectedAccounts ?? await availableAccounts().catch(() => []);
    const commandCapabilitiesByAccount = Object.fromEntries(accounts.map((account) => [
      account.provider_account_id,
      commandCapabilities(value(account.bot_id)),
    ]));
    post({
      type: "provider_status",
      surface: "line-oa",
      bridge_version: BRIDGE_VERSION,
      surface_ready: true,
      capabilities: { account_detection: true, message_observation: true, message_recovery: true },
      command_capabilities_by_account: commandCapabilitiesByAccount,
      realtime_transport: "authenticated_polling",
      realtime_connected: true,
      connected_at: new Date().toISOString(),
      chat_open: true,
    });
  }

  window.fetch = async (input, init) => {
    const response = await nativeFetch(input, init);
    try {
      const request = input instanceof Request ? input : null;
      const url = new URL(request?.url ?? String(input), window.location.origin);
      const method = String(init?.method ?? request?.method ?? "GET").toUpperCase();
      const rawBody = init?.body ?? null;
      if (method === "POST" && typeof rawBody === "string" && messageSendPath(url)) {
        const payload = JSON.parse(rawBody);
        if (response.ok) rememberSendProfile(url, init ?? request, payload);
      }
    } catch {
      // Profile capture is advisory; a provider request must retain its original result.
    }
    return response;
  };

  async function availableAccounts() {
    const body = await json(`${apiBase}/v1/bots?noFilter=true&limit=1000`);
    return (Array.isArray(body?.list) ? body.list : []).map((bot) => ({
      provider_account_id: normalizeBasicId(bot?.basicSearchId ?? bot?.basicId),
      bot_id: value(bot?.botId ?? bot?.id),
      display_name: value(bot?.name ?? bot?.displayName),
    })).filter((account) => account.provider_account_id && account.bot_id);
  }

  async function resolveBotId(providerAccountId, configuredBotId) {
    const explicit = value(configuredBotId);
    if (explicit) return explicit;
    const pageAccountId = normalizeBasicId(basicIdFromPage());
    if (pageAccountId === normalizeBasicId(providerAccountId)) return botIdFromUrl();
    const account = (await availableAccounts()).find(
      (candidate) => candidate.provider_account_id === normalizeBasicId(providerAccountId),
    );
    return account?.bot_id ?? "";
  }

  function timeMs(input) {
    const numeric = Number(input);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
    const parsed = Date.parse(String(input ?? ""));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function messageTimeMs(event) {
    return timeMs(event?.timestamp ?? event?.message?.timestamp ?? event?.createdAt ?? event?.created_at);
  }

  function latestEventTimeMs(chat) {
    return timeMs(chat?.latestEvent?.timestamp);
  }

  function shouldRecoverChat(chat, checkpointMs) {
    const latestEventMs = latestEventTimeMs(chat);
    return checkpointMs <= 0 || latestEventMs <= 0 || latestEventMs >= checkpointMs;
  }

  async function json(url) {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timeout = setTimeout(() => controller?.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        credentials: "include",
        headers: { accept: "application/json" },
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (!response.ok) throw new Error(`LINE OA request failed (${response.status}).`);
      return await response.json();
    } catch (error) {
      if (error?.name === "AbortError") throw new Error("LINE OA request timed out.");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  function chatUrl(botId, next) {
    const url = new URL(`${apiBase}/v2/bots/${encodeURIComponent(botId)}/chats`);
    url.searchParams.set("folderType", "ALL");
    url.searchParams.set("tagIds", "");
    url.searchParams.set("autoTagIds", "");
    url.searchParams.set("limit", String(CHAT_PAGE_LIMIT));
    url.searchParams.set("prioritizePinnedChat", "true");
    if (next) url.searchParams.set("next", next);
    return url.toString();
  }

  function messagesUrl(botId, chatId, backward, limit = PAGE_LIMIT) {
    const url = new URL(`${apiBase}/v3/bots/${encodeURIComponent(botId)}/chats/${encodeURIComponent(chatId)}/messages`);
    const requestedLimit = Number(limit);
    const pageLimit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(PAGE_LIMIT, Math.floor(requestedLimit)))
      : PAGE_LIMIT;
    url.searchParams.set("limit", String(pageLimit));
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
      latestCursor: acknowledgement.latest_cursor ?? null,
    };
  }

  async function advanceRecoveryCursor({ requestId, providerAccountId, chat, page, latestCursor }) {
    const chatId = value(chat?.chatId);
    if (!chatId || !latestCursor) return;
    const cursorRequestId = `${requestId}:${chatId}:cursor:${page}`;
    post({
      type: "recovery_cursor",
      request_id: cursorRequestId,
      provider_account_id: providerAccountId,
      conversation_id: chatId,
      cursor: latestCursor,
    });
    const acknowledgement = await waitForAcknowledgement(cursorRequestId);
    if (!acknowledgement?.ok) {
      throw new Error(acknowledgement?.error ?? "LINE OA sync cursor could not be saved.");
    }
  }

  function pollIsActive(generation) {
    return !disposed && generation === pollGeneration;
  }

  async function recoverChat({ requestId, providerAccountId, botId, chat, generation, knownMessageIdsByChat, maxMessages = null, sinceMs = 0 }) {
    const chatId = value(chat?.chatId);
    if (!chatId) return { parsed: 0, queued: 0 };
    const knownMessageIds = knownMessageIdsByChat.get(chatId) ?? new Set();
    knownMessageIdsByChat.set(chatId, knownMessageIds);
    let backward = null;
    let page = 0;
    let parsed = 0;
    let queued = 0;
    let accepted = 0;
    const seenCursors = new Set();

    while (pollIsActive(generation)) {
      const remaining = maxMessages === null ? PAGE_LIMIT : maxMessages - accepted;
      if (remaining <= 0) break;
      const body = await json(messagesUrl(botId, chatId, backward, Math.min(PAGE_LIMIT, remaining)));
      if (!pollIsActive(generation)) return { parsed, queued };
      const rawMessages = Array.isArray(body?.list) ? body.list : [];
      const allKnown = rawMessages.length > 0 && rawMessages.every((message) => {
        const id = messageId(message);
        return id && knownMessageIds.has(id);
      });
      if (allKnown) break;
      const messages = rawMessages
        .filter((message) => {
          const timestamp = messageTimeMs(message);
          return !sinceMs || !timestamp || timestamp >= sinceMs;
        })
        .slice(0, maxMessages === null ? undefined : Math.max(0, maxMessages - accepted));
      const pageIsBeforeCheckpoint = sinceMs > 0
        && rawMessages.length > 0
        && rawMessages.every((message) => {
          const timestamp = messageTimeMs(message);
          return timestamp > 0 && timestamp < sinceMs;
        });
      const limitReached = maxMessages !== null && accepted >= maxMessages;
      if (!messages.length && (pageIsBeforeCheckpoint || limitReached)) break;
      const result = await queueMessagePage({ requestId, providerAccountId, chat, messages, page });
      parsed += result.parsed;
      queued += result.queued;
      accepted += messages.length;
      await advanceRecoveryCursor({
        requestId,
        providerAccountId,
        chat,
        page,
        latestCursor: result.latestCursor,
      });
      for (const message of messages) {
        const id = messageId(message);
        if (id) knownMessageIds.add(id);
      }
      if (maxMessages !== null && accepted >= maxMessages) break;
      const nextBackward = cursor(body?.backward);
      if (!nextBackward || seenCursors.has(nextBackward) || pageIsBeforeCheckpoint) break;
      seenCursors.add(nextBackward);
      backward = nextBackward;
      page += 1;
    }
    return { parsed, queued };
  }

  function numberFrom(body, keys) {
    for (const key of keys) {
      const value = Number(body?.[key]);
      if (Number.isFinite(value) && value >= 0) return Math.floor(value);
    }
    return null;
  }

  function postRecoveryProgress(requestId, providerAccountId, completedConversations, totalConversations) {
    if (String(requestId).startsWith("poll:")) return;
    post({
      type: "recovery_progress",
      request_id: requestId,
      provider_account_id: providerAccountId,
      completed_conversations: completedConversations,
      total_conversations: totalConversations ?? 0,
    });
  }

  async function poll(requestId, providerAccountId, botId, checkpoint, generation) {
    try {
      const resolvedBotId = await resolveBotId(providerAccountId, botId);
      if (!resolvedBotId) throw new Error("LINE OA account is not available to the signed-in user.");
      const knownChatIds = knownChatIdsByAccount.get(providerAccountId) ?? new Set();
      const knownMessageIdsByChat = knownMessageIdsByAccount.get(providerAccountId) ?? new Map();
      knownChatIdsByAccount.set(providerAccountId, knownChatIds);
      knownMessageIdsByAccount.set(providerAccountId, knownMessageIdsByChat);
      const checkpointMs = timeMs(checkpoint?.watermark);
      const bootstrap = checkpointMs <= 0;
      let next = null;
      let parsed = 0;
      let queued = 0;
      let completedConversations = 0;
      let totalConversations = null;
      const seenCursors = new Set();
      const trackedRequest = !String(requestId).startsWith("poll:");
      postRecoveryProgress(requestId, providerAccountId, completedConversations, totalConversations);
      while (pollIsActive(generation)) {
        const body = await json(chatUrl(resolvedBotId, next));
        if (!pollIsActive(generation)) return;
        const chats = globalThis.OmnichatLineOA.chatItems(body);
        const pageTotal = numberFrom(body, ["total", "totalCount", "total_count"]);
        if (pageTotal !== null) {
          const visibleTotal = bootstrap
            ? Math.min(pageTotal, INITIAL_SYNC_MAX_CONVERSATIONS)
            : pageTotal;
          totalConversations = Math.max(totalConversations ?? 0, visibleTotal);
        }
        if (trackedRequest && pageTotal !== null) {
          postRecoveryProgress(requestId, providerAccountId, completedConversations, totalConversations);
        }
        const allKnown = chats.length > 0 && chats.every((chat) => knownChatIds.has(value(chat?.chatId)));
        const chatsToRecover = bootstrap
          ? chats.slice(0, Math.max(0, INITIAL_SYNC_MAX_CONVERSATIONS - completedConversations))
          : chats;
        for (const chat of chatsToRecover) {
          if (!pollIsActive(generation)) return;
          const chatId = value(chat?.chatId);
          if (!chatId) continue;
          const result = shouldRecoverChat(chat, checkpointMs)
            ? await recoverChat({
              requestId,
              providerAccountId,
              botId: resolvedBotId,
              chat,
              generation,
              knownMessageIdsByChat,
              maxMessages: bootstrap ? INITIAL_SYNC_MAX_MESSAGES_PER_CONVERSATION : null,
              sinceMs: bootstrap ? 0 : checkpointMs,
            })
            : { parsed: 0, queued: 0 };
          if (!pollIsActive(generation)) return;
          parsed += result.parsed;
          queued += result.queued;
          knownChatIds.add(chatId);
          completedConversations += 1;
          postRecoveryProgress(requestId, providerAccountId, completedConversations, totalConversations);
        }
        if (bootstrap && completedConversations >= INITIAL_SYNC_MAX_CONVERSATIONS) break;
        const nextCursor = cursor(body?.next);
        if (!nextCursor || allKnown || seenCursors.has(nextCursor)) break;
        seenCursors.add(nextCursor);
        next = nextCursor;
      }
      if (!pollIsActive(generation)) return;
      const watermark = new Date().toISOString();
      const state = pollingAccounts.get(providerAccountId);
      if (state) state.checkpoint = { watermark };
      post({ type: "recovery_complete", request_id: requestId, provider_account_id: providerAccountId, ok: true, recovered: parsed, queued, watermark });
    } catch (error) {
      if (pollIsActive(generation)) {
        post({ type: "recovery_complete", request_id: requestId, provider_account_id: providerAccountId, ok: false, error: String(error) });
      }
    }
  }

  function stopTimer() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function finishPoll(poll) {
    if (activePoll !== poll) return;
    activePoll = null;
    if (disposed) return;
    const next = queuedSyncs.shift();
    if (next) startPoll(next);
  }

  function startPoll({ requestId, providerAccountId, botId, checkpoint }) {
    const generation = pollGeneration;
    const current = { requestId, providerAccountId, task: null };
    activePoll = current;
    const task = poll(requestId, providerAccountId, botId, checkpoint, generation);
    current.task = task;
    void task.then(() => finishPoll(current), () => finishPoll(current));
  }

  function start(requestId, providerAccountId, botId, checkpoint) {
    const accountId = value(providerAccountId);
    stopTimer();
    const previous = pollingAccounts.get(accountId);
    const account = {
      botId: value(botId) || previous?.botId || "",
      checkpoint: checkpoint ?? previous?.checkpoint ?? null,
    };
    pollingAccounts.set(accountId, account);
    const request = { requestId, providerAccountId: accountId, ...account };
    if (activePoll) queuedSyncs.push(request);
    else startPoll(request);
    timer = setInterval(() => {
      if (activePoll || queuedSyncs.length || disposed || !pollingAccounts.size) return;
      const requests = [...pollingAccounts].map(([id, state]) => ({
        requestId: `poll:${crypto.randomUUID()}`,
        providerAccountId: id,
        ...state,
      }));
      const next = requests.shift();
      queuedSyncs.push(...requests);
      if (next) startPoll(next);
    }, 15_000);
  }

  function cancelPolling(reason, { notifyRequests = true } = {}) {
    stopTimer();
    pollGeneration += 1;
    const interrupted = [
      ...(activePoll ? [activePoll] : []),
      ...queuedSyncs,
    ];
    activePoll = null;
    queuedSyncs.length = 0;
    cancelAcknowledgements(reason);
    if (!notifyRequests) return;
    for (const request of interrupted) {
      if (String(request.requestId).startsWith("poll:")) continue;
      post({
        type: "recovery_complete",
        request_id: request.requestId,
        provider_account_id: request.providerAccountId,
        ok: false,
        error: reason,
      });
    }
  }

  function configuredAccountForPage(basicId) {
    return basicId ? { provider_account_id: basicId } : null;
  }

  function sendId(conversationId) {
    return `${conversationId}_${Date.now()}_${Math.floor(Math.random() * 100_000_000).toString().padStart(8, "0")}`;
  }

  function responseMessageId(payload) {
    return value(payload?.id ?? payload?.message?.id ?? payload?.data?.id ?? payload?.data?.messageId);
  }

  async function sendBrowserMessage(command) {
    const commandType = value(command?.command_type ?? command?.type);
    const browserAccountId = normalizeBasicId(command?.browser_provider_account_id ?? command?.provider_account_id);
    const conversationId = value(command?.conversation_id);
    const requestId = value(command?.request_id);
    if (!requestId || !browserAccountId || !conversationId) {
      post({ type: "api_send_result", request_id: requestId, ok: false, error: "LINE OA reply command is invalid." });
      return;
    }
    const botId = await resolveBotId(browserAccountId, "");
    const expectedType = commandType === "send_text" ? "text"
      : commandType === "send_sticker" ? "sticker"
        : commandType === "send_image" ? "image"
          : "";
    const profile = botId && expectedType ? profileFor(botId, expectedType) : null;
    if (!botId || !profile) {
      post({ type: "api_send_result", request_id: requestId, ok: false, error: "LINE OA sender is not initialized for this reply type." });
      return;
    }
    const payload = clone(profile.payload);
    payload.sendId = sendId(conversationId);
    if (expectedType === "text") {
      const textValue = value(command?.text);
      if (!textValue || textValue.length > 2_000) {
        post({ type: "api_send_result", request_id: requestId, ok: false, error: "LINE OA reply text is invalid." });
        return;
      }
      payload.text = textValue;
    } else if (expectedType === "sticker") {
      const packageId = value(command?.package_id);
      const stickerId = value(command?.sticker_id);
      if (!packageId || !stickerId) {
        post({ type: "api_send_result", request_id: requestId, ok: false, error: "LINE OA sticker is invalid." });
        return;
      }
      payload.packageId = packageId;
      payload.stickerId = stickerId;
    } else {
      const imageUrl = value(command?.image_url);
      const imagePath = firstImageUrlPath(payload) ?? (payload.imageUrl === "" ? ["imageUrl"] : null);
      if (!imageUrl || !/^https:\/\//i.test(imageUrl) || !imagePath) {
        post({ type: "api_send_result", request_id: requestId, ok: false, error: "LINE OA image sender is not initialized." });
        return;
      }
      setPath(payload, imagePath, imageUrl);
    }

    try {
      const response = await nativeFetch(`${apiBase}/v1/bots/${encodeURIComponent(botId)}/chats/${encodeURIComponent(conversationId)}/messages/send`, {
        method: "POST",
        headers: profile.headers,
        body: JSON.stringify(payload),
        credentials: "include",
      });
      const responseBody = await response.json().catch(() => null);
      if (!response.ok) {
        post({ type: "api_send_result", request_id: requestId, ok: false, error: `LINE OA send failed (${response.status}).` });
        return;
      }
      const providerMessageId = responseMessageId(responseBody);
      post({
        type: "api_send_result",
        request_id: requestId,
        ok: true,
        ...(providerMessageId ? { provider_message_id: providerMessageId } : {}),
      });
    } catch (error) {
      post({ type: "api_send_result", request_id: requestId, ok: false, uncertain: true, error: `LINE OA send was not acknowledged: ${String(error)}` });
    }
  }

  const listener = (event) => {
    if (disposed || event.source !== window || event.origin !== window.location.origin || event.data?.source !== SOURCE) return;
    if (event.data.type === "detect_account_v3") {
      void availableAccounts().then((accounts) => {
        if (!accounts.length) {
          const account = configuredAccountForPage(basicIdFromPage());
          if (account) accounts.push({ ...account, bot_id: botIdFromUrl() });
        }
        if (!accounts.length) {
          post({
            type: "account_detection_failed",
            request_id: event.data.request_id,
            error: "No LINE OA accounts were found for the signed-in user.",
          });
          return;
        }
        void publishProviderStatus(accounts);
        post({
          type: "accounts_detected",
          request_id: event.data.request_id,
          accounts: accounts.map((account) => ({ provider: "line_oa", ...account })),
        });
      }).catch((error) => {
        post({
          type: "account_detection_failed",
          request_id: event.data.request_id,
          error: String(error),
        });
      });
    } else if (event.data.type === "sync_v3") {
      start(event.data.request_id, event.data.provider_account_id, event.data.bot_id, event.data.checkpoint);
    } else if (event.data.type === "cancel_sync_v3") {
      cancelPolling("LINE OA recovery was cancelled.", { notifyRequests: false });
    } else if (event.data.type === "send_api_v3") {
      void sendBrowserMessage(event.data);
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
    source: SOURCE,
    bridge_version: BRIDGE_VERSION,
    dispose() {
      disposed = true;
      cancelPolling("LINE OA bridge was replaced.");
      window.removeEventListener("message", listener);
    },
  };
  post({ type: "provider_status", surface: "line-oa", bridge_version: BRIDGE_VERSION, surface_ready: true, capabilities: { account_detection: true, message_observation: true, message_recovery: true }, command_capabilities_by_account: {}, realtime_transport: "authenticated_polling", realtime_connected: true, connected_at: new Date().toISOString(), chat_open: true });
})();
