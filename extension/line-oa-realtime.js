(() => {
  const SOURCE = "omnichat-realtime-bridge-v3";
  const BRIDGE_VERSION = "line-oa-poll-3";
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
  let pollingAccountId = null;
  let pollingCheckpoint = null;
  let pollGeneration = 0;
  const queuedSyncs = [];
  const acknowledgements = new Map();
  const knownChatIds = new Set();
  const knownMessageIdsByChat = new Map();
  const botIdFromUrl = () => String(window.location.pathname.split("/").filter(Boolean)[0] ?? "").trim();
  const basicIdFromPage = () => globalThis.OmnichatLineOA?.basicIdFromHtml?.() ?? "";
  const apiBase = "https://chat.line.biz/api";
  const post = (data) => window.postMessage({ source: SOURCE, ...data }, window.location.origin);
  const value = (input) => typeof input === "string" || typeof input === "number" ? String(input).trim() : "";
  const cursor = (input) => value(input) || null;

  function timeMs(input) {
    const numeric = Number(input);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
    const parsed = Date.parse(String(input ?? ""));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function messageTimeMs(event) {
    return timeMs(event?.timestamp ?? event?.message?.timestamp ?? event?.createdAt ?? event?.created_at);
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

  async function recoverChat({ requestId, providerAccountId, botId, chat, generation, maxMessages = null, sinceMs = 0 }) {
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

  async function poll(requestId, providerAccountId, checkpoint, generation) {
    try {
      const botId = botIdFromUrl();
      if (!botId) throw new Error("LINE OA bot ID was not found in the open page URL.");
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
        const body = await json(chatUrl(botId, next));
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
          const result = await recoverChat({
            requestId,
            providerAccountId,
            botId,
            chat,
            generation,
            maxMessages: bootstrap ? INITIAL_SYNC_MAX_MESSAGES_PER_CONVERSATION : null,
            sinceMs: bootstrap ? 0 : checkpointMs,
          });
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
      pollingCheckpoint = { watermark };
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

  function startPoll({ requestId, providerAccountId, checkpoint }) {
    const generation = pollGeneration;
    const current = { requestId, providerAccountId, task: null };
    activePoll = current;
    const task = poll(requestId, providerAccountId, checkpoint, generation);
    current.task = task;
    void task.then(() => finishPoll(current), () => finishPoll(current));
  }

  function start(requestId, providerAccountId, checkpoint) {
    const accountId = value(providerAccountId);
    if (activePoll && activePoll.providerAccountId !== accountId) {
      post({
        type: "recovery_complete",
        request_id: requestId,
        provider_account_id: providerAccountId,
        ok: false,
        error: "LINE OA recovery is already running for another account.",
      });
      return;
    }
    stopTimer();
    if (pollingAccountId && pollingAccountId !== accountId) pollingCheckpoint = null;
    pollingAccountId = accountId || pollingAccountId;
    const request = { requestId, providerAccountId, checkpoint: checkpoint ?? pollingCheckpoint };
    if (activePoll) queuedSyncs.push(request);
    else startPoll(request);
    timer = setInterval(() => {
      if (activePoll || queuedSyncs.length || disposed || !pollingAccountId) return;
      startPoll({ requestId: `poll:${crypto.randomUUID()}`, providerAccountId: pollingAccountId, checkpoint: pollingCheckpoint });
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

  const listener = (event) => {
    if (disposed || event.source !== window || event.origin !== window.location.origin || event.data?.source !== SOURCE) return;
    if (event.data.type === "detect_account_v3") {
      const basicId = basicIdFromPage();
      const account = configuredAccountForPage(basicId);
      if (!account) {
        post({
          type: "account_detection_failed",
          request_id: event.data.request_id,
          error: "LINE OA Basic ID was not found in the open page.",
        });
      } else {
        post({
          type: "accounts_detected",
          request_id: event.data.request_id,
          accounts: [{ provider: "line_oa", ...account }],
        });
      }
    } else if (event.data.type === "sync_v3") {
      start(event.data.request_id, event.data.provider_account_id, event.data.checkpoint);
    } else if (event.data.type === "cancel_sync_v3") {
      cancelPolling("LINE OA recovery was cancelled.", { notifyRequests: false });
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
  post({ type: "provider_status", surface: "line-oa", bridge_version: BRIDGE_VERSION, surface_ready: true, capabilities: { account_detection: true, message_observation: true, message_recovery: true }, realtime_transport: "authenticated_polling", realtime_connected: true, connected_at: new Date().toISOString(), chat_open: true });
})();
