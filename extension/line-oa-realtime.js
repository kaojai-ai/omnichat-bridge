(() => {
  const SOURCE = "omnichat-realtime-bridge-v3";
  const BRIDGE_VERSION = "line-oa-poll-11";
  // Script revisions remain compatible unless the page bridge interface breaks.
  const COMPATIBILITY_VERSION = 3;
  const CHAT_PAGE_LIMIT = 25;
  const PAGE_LIMIT = 100;
  const INITIAL_SYNC_MAX_CONVERSATIONS = 10;
  const INITIAL_SYNC_MAX_MESSAGES_PER_CONVERSATION = 25;
  const INITIAL_SYNC_LOOKBACK_MS = 24 * 60 * 60 * 1_000;
  const REQUEST_TIMEOUT_MS = 20_000;
  const ACK_TIMEOUT_MS = 20_000;
  const SEND_CONFIRM_TIMEOUT_MS = 10_000;
  const SEND_CONFIRM_POLL_MS = 1_000;
  const previous = window.__omnichatLineOABridgeControl;
  previous?.dispose?.();
  let disposed = false;
  let timer = null;
  let activePoll = null;
  let lastProviderCheckAt = null;
  const pollingAccounts = new Map();
  let accessibleAccounts = [];
  let accountAccessVerified = false;
  let providerCheckOutcome = "unknown";
  let accountAccessRequest = null;
  let metadataSessionEpoch = 0;
  let pollGeneration = 0;
  const queuedSyncs = [];
  const acknowledgements = new Map();
  const metadataProfilesByAccount = new Map();
  const missingHistoryIds = new Set();
  const sendProfilesByBot = new Map();
  const nativeFetch = window.fetch.bind(window);
  const apiBase = "https://chat.line.biz/api";
  const post = (data) => {
    window.postMessage({ source: SOURCE, ...data }, window.location.origin);
    // Waiting accounts inherit real progress from the work ahead of them, not
    // timer ticks. A stalled active request must still let every deadline expire.
    if (!activePoll || data.provider_account_id !== activePoll.providerAccountId
      || !(data.request_id === activePoll.requestId || String(data.request_id).startsWith(`${activePoll.requestId}:`))
      || !["recovery_phase", "recovery_progress", "recovery_batch", "recovery_cursor", "history_window", "history_backfill"].includes(data.type)) return;
    for (const request of queuedSyncs) {
      if (String(request.requestId).startsWith("poll:")) continue;
      window.postMessage({ source: SOURCE, type: "recovery_activity", request_id: request.requestId,
        provider_account_id: request.providerAccountId }, window.location.origin);
    }
  };
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
    const type = payload.type === "textV2" ? "text" : value(payload.type);
    if (!["text", "image", "sticker"].includes(type)) return;
    const profiles = sendProfilesByBot.get(target.botId) ?? new Map();
    profiles.set(type, { headers: safeHeaders(init?.headers), payload: clone(payload) });
    sendProfilesByBot.set(target.botId, profiles);
    void publishProviderStatus();
  }

  function commandCapabilities(botId) {
    return botId ? ["send_text", "send_image", "send_video", "send_file", "send_sticker"] : [];
  }

  function pollingAccountIds() {
    if (timer) return [...pollingAccounts.keys()];
    return [...new Set([...(activePoll ? [activePoll.providerAccountId] : []), ...queuedSyncs.map((request) => request.providerAccountId)])];
  }

  function postProviderStatus() {
    const commandCapabilitiesByAccount = Object.fromEntries((accountAccessVerified ? accessibleAccounts : []).map((account) => [
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
      accessible_account_ids: accessibleAccounts.map((account) => account.provider_account_id),
      account_access_verified: accountAccessVerified,
      provider_check_outcome: providerCheckOutcome,
      realtime_transport: "authenticated_polling",
      realtime_connected: !lastProviderCheckAt || Date.now() - Date.parse(lastProviderCheckAt) < 45_000,
      connected_at: new Date().toISOString(),
      chat_open: true,
      last_provider_check_at: lastProviderCheckAt,
      provider_polling_active: Boolean(timer || activePoll || queuedSyncs.length),
      provider_polling_account_ids: pollingAccountIds(),
    });
  }

  async function publishProviderStatus() {
    await availableAccounts().catch(() => undefined);
    postProviderStatus();
  }

  window.fetch = async (input, init) => {
    const response = await nativeFetch(input, init);
    try {
      const request = input instanceof Request ? input : null;
      const url = new URL(request?.url ?? String(input), window.location.origin);
      if (url.origin === window.location.origin && /^\/api\/v\d+\/bots(?:\/|$)/.test(url.pathname)
        && [401, 403].includes(response.status)) markProviderCheckFailure({ providerDiagnostics: { http_status: response.status } });
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

  function markProviderCheckFailure(error) {
    const confirmedFailure = [401, 403].includes(error?.providerDiagnostics?.http_status);
    if (confirmedFailure) {
      metadataSessionEpoch += 1;
      providerCheckOutcome = "failed";
      accessibleAccounts = [];
    } else if (providerCheckOutcome !== "failed") {
      providerCheckOutcome = "unknown";
    }
    accountAccessVerified = false;
    postProviderStatus();
  }

  function invalidProviderResponse(message) {
    const error = new Error(message);
    markProviderCheckFailure(error);
    return error;
  }

  async function availableAccounts() {
    if (accountAccessRequest) return accountAccessRequest;
    const sessionEpoch = metadataSessionEpoch;
    accountAccessRequest = (async () => {
      try {
        const body = await json(`${apiBase}/v1/bots?noFilter=true&limit=1000`);
        if (!Array.isArray(body?.list)) throw new Error("LINE OA account list was invalid.");
        const accounts = body.list.map((bot) => ({
          provider_account_id: normalizeBasicId(bot?.basicSearchId ?? bot?.basicId),
          bot_id: value(bot?.botId ?? bot?.id),
          display_name: value(bot?.name ?? bot?.displayName),
        })).filter((account) => account.provider_account_id && account.bot_id);
        if (disposed) return [];
        if (sessionEpoch !== metadataSessionEpoch) throw new Error("LINE OA account check was superseded by a session change.");
        if (accessibleAccounts.some((previous) => !accounts.some((account) => account.provider_account_id === previous.provider_account_id && account.bot_id === previous.bot_id))) metadataSessionEpoch += 1;
        accessibleAccounts = accounts;
        accountAccessVerified = true;
        providerCheckOutcome = "passed";
        const ids = new Set(accounts.map((account) => account.provider_account_id));
        for (const id of pollingAccounts.keys()) {
          if (!ids.has(id)) cancelPolling("This LINE OA is not accessible to the signed-in user.", { providerAccountId: id });
        }
        postProviderStatus();
        return accounts;
      } catch (error) {
        markProviderCheckFailure(error);
        throw error;
      }
    })().finally(() => { accountAccessRequest = null; });
    return accountAccessRequest;
  }

  async function resolveBotId(providerAccountId) {
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

  async function json(url, timeoutMs = REQUEST_TIMEOUT_MS) {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timeout = setTimeout(() => controller?.abort(), Math.max(1, Math.min(REQUEST_TIMEOUT_MS, timeoutMs)));
    try {
      const response = await fetch(url, {
        credentials: "include",
        headers: { accept: "application/json" },
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (!response.ok) {
        let format = "json";
        const body = await response.json().catch(() => { format = "non_json"; return null; });
        const error = new Error(`LINE OA request failed (${response.status}).`);
        error.providerDiagnostics = { http_status: response.status, response_format: format, ...providerErrorDetails(body) };
        throw error;
      }
      const body = await response.json();
      lastProviderCheckAt = new Date().toISOString();
      return body;
    } catch (error) {
      const failure = error?.name === "AbortError" ? new Error("LINE OA request timed out.") : error;
      failure.providerCheckUnavailable = true;
      if ([401, 403].includes(failure?.providerDiagnostics?.http_status)) markProviderCheckFailure(failure);
      throw failure;
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

  function messageSendId(event) {
    return value(event?.message?.sendId ?? event?.sendId ?? event?.message?.client_message_id ?? event?.client_message_id);
  }

  function messageConversationId(event) {
    return value(event?.source?.chatId ?? event?.conversation_id ?? event?.source?.conversationId);
  }

  async function waitForSentMessage({ botId, conversationId, sendId, deadlineAt = Infinity }) {
    const deadline = Math.min(Date.now() + SEND_CONFIRM_TIMEOUT_MS, deadlineAt);
    while (Date.now() < deadline) {
      // Always request the newest messages for this conversation. Do not walk
      // backward through history because a newly sent message appears at the front.
      const body = await json(messagesUrl(botId, conversationId, null, PAGE_LIMIT));
      const messages = Array.isArray(body?.list) ? body.list : [];
      const confirmed = messages.find((message) => (
        messageConversationId(message) === conversationId
        && messageSendId(message) === sendId
      ));
      if (confirmed) return messageId(confirmed);
      await new Promise((resolve) => setTimeout(resolve, SEND_CONFIRM_POLL_MS));
    }
    return "";
  }

  function waitForAcknowledgement(requestId) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        acknowledgements.delete(requestId);
        const error = new Error("LINE OA local message queue acknowledgement timed out.");
        error.name = "TimeoutError";
        reject(error);
      }, ACK_TIMEOUT_MS);
      acknowledgements.set(requestId, (message) => {
        clearTimeout(timeout);
        resolve(message);
      });
    });
  }

  function cancelAcknowledgements(error, recoveryRequestId = null) {
    for (const [requestId, acknowledge] of acknowledgements) {
      if (recoveryRequestId && !requestId.startsWith(`${recoveryRequestId}:`)) continue;
      acknowledgements.delete(requestId);
      acknowledge({ ok: false, error });
    }
  }

  function captureChatProfile(providerAccountId, chat) {
    const conversationId = value(chat?.chatId);
    const profile = chat?.profile;
    const id = value(profile?.userId ?? profile?.groupId) || conversationId;
    if (!providerAccountId || !conversationId || !id) return;
    const profiles = metadataProfilesByAccount.get(providerAccountId) ?? new Map();
    metadataProfilesByAccount.set(providerAccountId, profiles);
    const key = `${conversationId}:${id}`;
    const previous = profiles.get(key) ?? {};
    const displayName = previous.display_name ? "" : value(profile?.displayName ?? profile?.name);
    let avatarUrl = "";
    if (!previous.avatar_url) {
      try {
        const url = new URL(value(profile?.pictureUrl ?? profile?.imageUrl ?? profile?.avatarUrl));
        if (url.protocol === "https:") avatarUrl = url.toString();
      } catch { /* Optional metadata. */ }
    }
    if (!displayName && !avatarUrl) return;
    const additions = { ...(displayName ? { display_name: displayName } : {}), ...(avatarUrl ? { avatar_url: avatarUrl } : {}) };
    profiles.set(key, { ...previous, ...additions });
    while (profiles.size > 1_000) profiles.delete(profiles.keys().next().value);
    post({ type: "profiles_detected", profiles: [{ conversation_id: conversationId, id, provider_account_id: providerAccountId, ...additions }] });
  }

  async function queueMessagePage({ requestId, providerAccountId, chat, messages, page }) {
    captureChatProfile(providerAccountId, chat);
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
    return !disposed && generation.epoch === pollGeneration && !generation.cancelled;
  }

  // Persisted boundaries own recovery; evictable IDs must never stop pagination.
  async function recoverChat({ requestId, providerAccountId, botId, chat, generation, maxMessages = null, sinceMs = 0 }) {
    const chatId = value(chat?.chatId);
    if (!chatId) return { parsed: 0, queued: 0 };
    let backward = null;
    let page = 0;
    let parsed = 0;
    let queued = 0;
    let accepted = 0;
    let latestCursor = null;
    const seenCursors = new Set();

    while (pollIsActive(generation)) {
      const remaining = maxMessages === null ? PAGE_LIMIT : maxMessages - accepted;
      if (remaining <= 0) break;
      const body = await json(messagesUrl(botId, chatId, backward, Math.min(PAGE_LIMIT, remaining)));
      if (!pollIsActive(generation)) return { parsed, queued };
      if (!Array.isArray(body?.list)) throw invalidProviderResponse("LINE OA message history response is invalid.");
      const rawMessages = body.list;
      const messages = rawMessages
        .filter((message) => {
          const timestamp = messageTimeMs(message);
          // Bootstrap and incremental recovery both have a lower bound. Never
          // enqueue timestamp-less messages when a lower bound is active.
          return sinceMs > 0
            ? timestamp > 0 && timestamp >= sinceMs
            : true;
        })
        .slice(0, maxMessages === null ? undefined : Math.max(0, maxMessages - accepted));
      const pageIsBeforeCheckpoint = sinceMs > 0
        && rawMessages.length > 0
        && rawMessages.every((message) => {
          const timestamp = messageTimeMs(message);
          return timestamp <= 0 || timestamp < sinceMs;
        });
      const limitReached = maxMessages !== null && accepted >= maxMessages;
      if (!messages.length && (pageIsBeforeCheckpoint || limitReached)) break;
      if (!messages.length && sinceMs > 0) {
        const nextBackward = cursor(body?.backward);
        if (!nextBackward) break;
        if (seenCursors.has(nextBackward)) throw new Error("LINE OA message history pagination repeated a cursor.");
        seenCursors.add(nextBackward);
        backward = nextBackward;
        page += 1;
        continue;
      }
      const result = await queueMessagePage({ requestId, providerAccountId, chat, messages, page });
      if (!pollIsActive(generation)) return { parsed, queued };
      parsed += result.parsed;
      queued += result.queued;
      accepted += messages.length;
      const candidate = result.latestCursor;
      if (candidate && (!latestCursor || timeMs(candidate.event_timestamp) > timeMs(latestCursor.event_timestamp)
        || (timeMs(candidate.event_timestamp) === timeMs(latestCursor.event_timestamp)
          && String(candidate.message_id) > String(latestCursor.message_id)))) latestCursor = candidate;
      if (!pollIsActive(generation)) return { parsed, queued };
      if (maxMessages !== null && accepted >= maxMessages) break;
      const nextBackward = cursor(body?.backward);
      if (!nextBackward || pageIsBeforeCheckpoint) break;
      if (seenCursors.has(nextBackward)) throw new Error("LINE OA message history pagination repeated a cursor.");
      seenCursors.add(nextBackward);
      backward = nextBackward;
      page += 1;
    }
    if (pollIsActive(generation) && latestCursor) {
      await advanceRecoveryCursor({ requestId, providerAccountId, chat, page, latestCursor });
    }
    return { parsed, queued, latestCursor };
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

  function historySelection(history) {
    const days = Number(history?.days ?? history?.history_days);
    const sinceMs = Number(history?.sinceMs ?? history?.history_since_ms);
    if (!Number.isInteger(days) || days < 1 || !Number.isFinite(sinceMs) || sinceMs <= 0) return null;
    const ids = Array.isArray(history?.ids ?? history?.history_conversation_ids)
      ? (history.ids ?? history.history_conversation_ids).map((id) => value(id)).filter(Boolean)
      : [];
    return { days, sinceMs, ids };
  }

  function historyCovered(checkpoint, conversationId, days) {
    return (Number(checkpoint?.history_backfill?.[conversationId]) || 0) >= days;
  }

  function historyWindowActive(selection, checkpoint) {
    return Boolean(
      selection
      && selection.ids.length === 0
      && (Number(checkpoint?.history_window_days) || 0) < selection.days,
    );
  }

  function chatBeforeHistory(chat, sinceMs) {
    const latest = latestEventTimeMs(chat);
    return latest > 0 && latest < sinceMs;
  }

  async function markHistoryWindow({ requestId, providerAccountId, days, checkpoint }) {
    const windowRequestId = `${requestId}:history-window`;
    post({
      type: "history_window",
      request_id: windowRequestId,
      provider_account_id: providerAccountId,
      history_days: days,
    });
    const acknowledgement = await waitForAcknowledgement(windowRequestId);
    if (!acknowledgement?.ok) {
      throw new Error(acknowledgement?.error ?? "LINE OA history window could not be saved.");
    }
    if (checkpoint && typeof checkpoint === "object") checkpoint.history_window_days = days;
  }

  async function markHistoryBackfill({ requestId, providerAccountId, conversationId, days, checkpoint }) {
    const backfillRequestId = `${requestId}:${conversationId}:history`;
    post({
      type: "history_backfill",
      request_id: backfillRequestId,
      provider_account_id: providerAccountId,
      conversation_id: conversationId,
      history_days: days,
    });
    const acknowledgement = await waitForAcknowledgement(backfillRequestId);
    if (!acknowledgement?.ok) {
      throw new Error(acknowledgement?.error ?? "LINE OA history backfill could not be saved.");
    }
    if (checkpoint && typeof checkpoint === "object") {
      checkpoint.history_backfill = {
        ...(checkpoint.history_backfill ?? {}),
        [conversationId]: days,
      };
    }
  }

  async function poll(requestId, providerAccountId, botId, checkpoint, generation, history) {
    const scanStartedAt = Date.now();
    const completedCursors = { ...(checkpoint?.conversations ?? {}) };
    try {
      const resolvedBotId = await resolveBotId(providerAccountId, botId);
      if (!pollIsActive(generation)) return;
      if (!resolvedBotId) throw new Error("LINE OA account is not available to the signed-in user.");
      const selection = historySelection(history);
      if (selection && !String(requestId).startsWith("poll:")) missingHistoryIds.clear();
      const checkpointMs = timeMs(checkpoint?.watermark);
      const bootstrap = checkpointMs <= 0;
      const historyWindow = historyWindowActive(selection, checkpoint);
      const lowerBoundMs = historyWindow
        ? selection.sinceMs
        : bootstrap
          ? Date.now() - INITIAL_SYNC_LOOKBACK_MS
          : checkpointMs;
      const pendingIds = new Set(
        (selection?.ids ?? []).filter((id) => !historyCovered(checkpoint, id, selection.days) && !missingHistoryIds.has(id)),
      );
      const seenChatIds = new Set();
      let next = null;
      let parsed = 0;
      let queued = 0;
      let completedConversations = 0;
      let nonTargetConversations = 0;
      let totalConversations = null;
      const seenCursors = new Set();
      const trackedRequest = !String(requestId).startsWith("poll:");
      postRecoveryProgress(requestId, providerAccountId, completedConversations, totalConversations);
      while (pollIsActive(generation)) {
        const body = await json(chatUrl(resolvedBotId, next));
        if (!pollIsActive(generation)) return;
        if (!Array.isArray(body?.list)) throw invalidProviderResponse("LINE OA conversation list response is invalid.");
        const chats = globalThis.OmnichatLineOA.chatItems(body);
        const pageTotal = numberFrom(body, ["total", "totalCount", "total_count"]);
        if (pageTotal !== null) {
          const visibleTotal = bootstrap && !historyWindow && pendingIds.size === 0
            ? Math.min(pageTotal, INITIAL_SYNC_MAX_CONVERSATIONS)
            : pageTotal;
          totalConversations = Math.max(totalConversations ?? 0, visibleTotal);
        }
        const pageBeforeHistory = historyWindow
          && chats.length > 0
          && chats.every((chat) => chatBeforeHistory(chat, selection.sinceMs));
        if (trackedRequest && pageTotal !== null) {
          postRecoveryProgress(requestId, providerAccountId, completedConversations, totalConversations);
        }
        const chatsToRecover = [];
        for (const chat of chats) {
          const chatId = value(chat?.chatId);
          if (chatId) seenChatIds.add(chatId);
          const targeted = Boolean(chatId && pendingIds.has(chatId));
          if (historyWindow && !targeted && chatBeforeHistory(chat, selection.sinceMs)) continue;
          if (!targeted && bootstrap && !historyWindow && nonTargetConversations >= INITIAL_SYNC_MAX_CONVERSATIONS) continue;
          chatsToRecover.push(chat);
          if (!targeted && bootstrap) nonTargetConversations += 1;
        }
        if (trackedRequest) {
          post({
            type: "recovery_phase",
            request_id: requestId,
            provider_account_id: providerAccountId,
            phase: "fetching_messages",
            completed_conversations: completedConversations,
            total_conversations: totalConversations ?? 0,
          });
        }
        for (const chat of chatsToRecover) {
          if (!pollIsActive(generation)) return;
          const chatId = value(chat?.chatId);
          if (!chatId) continue;
          const deep = pendingIds.has(chatId);
          const result = deep || shouldRecoverChat(chat, historyWindow ? selection.sinceMs : checkpointMs)
            ? await recoverChat({
              requestId,
              providerAccountId,
              botId: resolvedBotId,
              chat,
              generation,
              maxMessages: deep || historyWindow
                ? null
                : (bootstrap ? INITIAL_SYNC_MAX_MESSAGES_PER_CONVERSATION : null),
              sinceMs: deep || historyWindow ? selection.sinceMs : Math.max(lowerBoundMs, timeMs(completedCursors[chatId]?.event_timestamp)),
            })
            : { parsed: 0, queued: 0 };
          if (!pollIsActive(generation)) return;
          if (result.latestCursor) completedCursors[chatId] = result.latestCursor;
          if (deep) {
            await markHistoryBackfill({
              requestId,
              providerAccountId,
              conversationId: chatId,
              days: selection.days,
              checkpoint,
            });
            pendingIds.delete(chatId);
          }
          parsed += result.parsed;
          queued += result.queued;
          completedConversations += 1;
          postRecoveryProgress(requestId, providerAccountId, completedConversations, totalConversations);
          if (trackedRequest) {
            post({
              type: "recovery_phase",
              request_id: requestId,
              provider_account_id: providerAccountId,
              phase: "conversation_complete",
              conversation_id: chatId,
              completed_conversations: completedConversations,
              total_conversations: totalConversations ?? 0,
            });
          }
        }
        if (pageBeforeHistory) break;
        if (bootstrap && !historyWindow && pendingIds.size === 0 && nonTargetConversations >= INITIAL_SYNC_MAX_CONVERSATIONS) break;
        const nextCursor = cursor(body?.next);
        if (!nextCursor) break;
        if (seenCursors.has(nextCursor)) throw new Error("LINE OA conversation pagination repeated a cursor.");
        seenCursors.add(nextCursor);
        next = nextCursor;
      }
      for (const chatId of pendingIds) {
        if (!pollIsActive(generation) || seenChatIds.has(chatId)) continue;
        try {
          const result = await recoverChat({
            requestId,
            providerAccountId,
            botId: resolvedBotId,
            chat: { chatId },
            generation,
            maxMessages: null,
            sinceMs: selection.sinceMs,
          });
          if (!pollIsActive(generation)) return;
          if (result.latestCursor) completedCursors[chatId] = result.latestCursor;
          await markHistoryBackfill({
            requestId,
            providerAccountId,
            conversationId: chatId,
            days: selection.days,
            checkpoint,
          });
          parsed += result.parsed;
          queued += result.queued;
        } catch (error) {
          if (String(error).includes("failed (404)")) {
            missingHistoryIds.add(chatId);
            continue;
          }
          throw error;
        }
      }
      if (!pollIsActive(generation)) return;
      if (historyWindow) {
        await markHistoryWindow({
          requestId,
          providerAccountId,
          days: selection.days,
          checkpoint,
        });
      }
      const watermark = new Date(scanStartedAt).toISOString();
      const state = pollingAccounts.get(providerAccountId);
      if (state) {
        state.checkpoint = {
          ...checkpoint,
          watermark,
          conversations: completedCursors,
          ...(checkpoint?.history_backfill ? { history_backfill: checkpoint.history_backfill } : {}),
          ...(checkpoint?.history_window_days ? { history_window_days: checkpoint.history_window_days } : {}),
        };
      }
      postProviderStatus();
      post({ type: "recovery_complete", request_id: requestId, provider_account_id: providerAccountId, ok: true, recovered: parsed, queued, watermark });
    } catch (error) {
      if (error?.providerCheckUnavailable) markProviderCheckFailure(error);
      if (pollIsActive(generation)) {
        postProviderStatus();
        post({ type: "recovery_complete", request_id: requestId, provider_account_id: providerAccountId, ok: false, error: "LINE OA recovery failed.", diagnostics: failedOperationDiagnostics(error, "recovery") });
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

  function startPoll({ requestId, providerAccountId, botId, checkpoint, history }) {
    const generation = { epoch: pollGeneration, cancelled: false };
    const current = { requestId, providerAccountId, generation, task: null };
    activePoll = current;
    if (!String(requestId).startsWith("poll:")) {
      post({ type: "recovery_phase", request_id: requestId, provider_account_id: providerAccountId, phase: "loading_conversations" });
    }
    const task = poll(requestId, providerAccountId, botId, checkpoint, generation, history);
    current.task = task;
    void task.then(() => finishPoll(current), () => finishPoll(current));
  }

  function start(requestId, providerAccountId, botId, checkpoint, history) {
    const accountId = value(providerAccountId);
    stopTimer();
    const previous = pollingAccounts.get(accountId);
    const account = {
      botId: value(botId) || previous?.botId || "",
      checkpoint: checkpoint ?? previous?.checkpoint ?? null,
      history: history === undefined ? previous?.history ?? null : history,
    };
    pollingAccounts.set(accountId, account);
    const request = { requestId, providerAccountId: accountId, ...account };
    if (activePoll) {
      queuedSyncs.push(request);
      if (!String(requestId).startsWith("poll:")) {
        post({ type: "recovery_phase", request_id: requestId, provider_account_id: accountId, phase: "waiting_recovery" });
      }
    } else startPoll(request);
    timer = setInterval(() => {
      // Queue residence is not progress. Only actual phase/data events renew
      // recovery deadlines; scoped cancellation releases the next account.
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
    postProviderStatus();
  }

  function cancelPolling(reason, { notifyRequests = true, providerAccountId = "", requestId = "" } = {}) {
    const accountId = value(providerAccountId);
    const selectedRequestId = value(requestId);
    const globalCancellation = !accountId && !selectedRequestId;
    const matches = (request) => request
      && (!accountId || request.providerAccountId === accountId)
      && (!selectedRequestId || request.requestId === selectedRequestId);
    const interrupted = [];
    // Late cancellation must never stop a replacement attempt or its polling timer.
    if (selectedRequestId && !matches(activePoll) && !queuedSyncs.some(matches)) return;
    if (activePoll && matches(activePoll)) {
      activePoll.generation.cancelled = true;
      interrupted.push(activePoll);
      activePoll = null;
    }
    for (let index = queuedSyncs.length - 1; index >= 0; index -= 1) {
      if (matches(queuedSyncs[index])) {
        interrupted.push(...queuedSyncs.splice(index, 1));
      }
    }
    if (globalCancellation) {
      stopTimer();
      pollGeneration += 1;
      pollingAccounts.clear();
      cancelAcknowledgements(reason);
    } else {
      const affectedAccounts = accountId ? [accountId] : interrupted.map((request) => request.providerAccountId);
      for (const id of affectedAccounts) {
        const hasReplacement = activePoll?.providerAccountId === id
          || queuedSyncs.some((request) => request.providerAccountId === id);
        if (!hasReplacement) {
          pollingAccounts.delete(id);
        }
      }
      if (!pollingAccounts.size) stopTimer();
      for (const request of interrupted) cancelAcknowledgements(reason, request.requestId);
    }
    if (!disposed && !activePoll) {
      const next = queuedSyncs.shift();
      if (next) startPoll(next);
    }
    postProviderStatus();
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

  function sendId(conversationId) {
    return `${conversationId}_${Date.now()}_${Math.floor(Math.random() * 100_000_000).toString().padStart(8, "0")}`;
  }

  function responseMessageId(payload) {
    return value(payload?.id ?? payload?.message?.id ?? payload?.data?.id ?? payload?.data?.messageId);
  }

  // Provider response text can echo customer content or credentials. Extract only
  // fixed protocol codes and known payload field names, never arbitrary strings.
  function providerErrorDetails(body) {
    const codes = new Set(["BAD_REQUEST", "INVALID_ARGUMENT", "INVALID_REQUEST", "INVALID_PARAMETER", "VALIDATION_ERROR", "UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND", "bad_request", "invalid_request", "invalid_argument", "validation_error", "invalid_parameter", "param_error", "unauthorized", "forbidden", "not_found", "conflict", "rate_limited", "too_many_requests", "internal_error", "service_unavailable", "unknown_error"]);
    const fields = new Set(["sendId", "type", "text", "substitution", "mention", "emojis", "packageId", "stickerId", "imageUrl", "contentMessageToken", "items", "file"]);
    const result = {};
    const candidates = [body?.code, body?.errorCode, body?.error?.code];
    result.provider_code_present = candidates.some((candidate) => candidate !== undefined && candidate !== null);
    for (const candidate of [body?.code, body?.errorCode, body?.error?.code]) {
      if ((typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0 && candidate <= 999999)
        || (typeof candidate === "string" && (/^\d{1,6}$/.test(candidate) || codes.has(candidate)))) {
        result.native_error_code = String(candidate);
        break;
      }
    }
    const details = [body?.details, body?.errors, body?.error?.details].flatMap((entries) => Array.isArray(entries) ? entries.slice(0, 20) : []);
    const validationFields = [...new Set(details.map((entry) => entry?.property ?? entry?.field ?? entry?.path).filter((field) => fields.has(field)))];
    if (validationFields.length) result.validation_fields = validationFields;
    return result;
  }

  function failedOperationDiagnostics(error, operation) {
    const details = error?.providerDiagnostics ?? {};
    const timedOut = ["AbortError", "TimeoutError"].includes(error?.name)
      || error?.message === "LINE OA request timed out.";
    return {
      diagnostic_version: 1, provider: "line_oa", operation,
      native_attempted: false, delivery_uncertain: false,
      failure_kind: timedOut ? "transport_failure" : details.http_status >= 400 ? "provider_rejection" : "pre_dispatch_failure",
      timed_out: timedOut,
      ...(["Error", "TypeError", "AbortError", "TimeoutError", "SyntaxError"].includes(error?.name) ? { error_name: error.name } : {}),
      ...details,
    };
  }

  async function sendBrowserMessage(command) {
    const commandType = value(command?.command_type ?? command?.type);
    const browserAccountId = normalizeBasicId(command?.browser_provider_account_id ?? command?.provider_account_id);
    const conversationId = value(command?.conversation_id);
    const requestId = value(command?.request_id);
    const startedAt = Date.now();
    let operation = "initialize";
    let sendStarted = false;
    let httpStatus;
    let providerDetails = {};
    let responseFormat;
    let templateSource = "derived";
    const diagnostics = (failureKind, uncertain = false) => ({
      diagnostic_version: 1, provider: "line_oa", operation,
      command_type: ["send_text", "send_image", "send_video", "send_file", "send_sticker"].includes(commandType) ? commandType : "unknown",
      ...(httpStatus ? { http_status: httpStatus } : {}),
      ...(responseFormat ? { response_format: responseFormat } : {}),
      native_attempted: sendStarted, delivery_uncertain: uncertain,
      failure_kind: failureKind, provider_duration_ms: Math.max(0, Date.now() - startedAt),
      client_id_is_uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value(command?.client_message_id)),
      template_source: templateSource, ...providerDetails,
    });
    const reject = (error) => post({ type: "api_send_result", request_id: requestId, ok: false, error, diagnostics: diagnostics("validation_failure") });
    if (!requestId || !browserAccountId || !conversationId) {
      reject("LINE OA reply command is invalid.");
      return;
    }
    try {
      const botId = await resolveBotId(browserAccountId, "");
      const expectedType = commandType === "send_text" ? "text"
        : commandType === "send_sticker" ? "sticker"
          : commandType === "send_image" ? "image"
            : commandType === "send_video" ? "video"
              : commandType === "send_file" ? "file"
                : "";
      const profile = botId && expectedType ? profileFor(botId, expectedType) : null;
      templateSource = sendProfilesByBot.get(botId)?.has(expectedType) ? "captured" : "derived";
      if (!botId || !profile) {
        reject("LINE OA sender is not initialized for this reply type.");
        return;
      }
      const payload = clone(profile.payload);
      const requestedSendId = value(command?.client_message_id);
      const confirmationSendId = requestedSendId || sendId(conversationId);
      payload.sendId = confirmationSendId;
      if (expectedType === "text") {
        const textValue = value(command?.text);
        if (!textValue || textValue.length > 2_000) {
          reject("LINE OA reply text is invalid.");
          return;
        }
        // Learned profiles may contain mentions from a previous human reply.
        delete payload.mention;
        delete payload.emojis;
        delete payload.substitution;
        payload.type = "text";
        payload.text = textValue;
        if (command.text_v2 !== undefined) {
          const native = command.text_v2;
          const entries = native?.substitution && typeof native.substitution === "object"
            && !Array.isArray(native.substitution) ? Object.entries(native.substitution) : [];
          const valid = typeof native?.text === "string" && native.text.length > 0
            && native.text.length <= 5_000 && entries.length > 0 && entries.length <= 20
            && entries.every(([key, entry]) => /^[A-Za-z0-9_]{1,20}$/.test(key)
              && entry?.type === "mention" && (entry.mentionee?.type === "all"
                || (entry.mentionee?.type === "user" && typeof entry.mentionee.userId === "string"
                  && entry.mentionee.userId.length > 0)));
          if (!valid) {
            reject("LINE OA mention reply is invalid.");
            return;
          }
          payload.type = "textV2";
          payload.text = native.text;
          payload.substitution = clone(native.substitution);
        }
      } else if (expectedType === "sticker") {
        const packageId = value(command?.package_id);
        const stickerId = value(command?.sticker_id);
        if (!packageId || !stickerId) {
          reject("LINE OA sticker is invalid.");
          return;
        }
        payload.packageId = packageId;
        payload.stickerId = stickerId;
      }

      const deadlineAt = Math.min(Number(command.deadline_at_ms) || Infinity, Date.now() + 25_000);
      const remaining = () => deadlineAt - Date.now();
      const requestSignal = () => {
        if (remaining() <= 0) throw new Error("LINE OA reply deadline expired.");
        return AbortSignal.timeout(Math.max(1, Math.min(20_000, remaining())));
      };
      let endpoint = `${apiBase}/v1/bots/${encodeURIComponent(botId)}/chats/${encodeURIComponent(conversationId)}/messages/send`;
      let body = JSON.stringify(payload);
      if (["image", "video", "file"].includes(expectedType)) {
        const bytes = command.image_bytes ?? command.media_bytes;
        const contentType = value(command.image_type ?? command.media_type);
        const maxBytes = (expectedType === "image" ? 20 : 32) * 1024 * 1024;
        if (!(bytes instanceof ArrayBuffer) || !bytes.byteLength || bytes.byteLength > maxBytes) {
          throw new Error("LINE OA attachment is empty or too large.");
        }
        if (expectedType === "image" && !contentType.startsWith("image/")) throw new Error("LINE OA image type is invalid.");
        if (expectedType === "file" && !value(command.file_name)) throw new Error("LINE OA file name is required.");
        const imageExtension = { "image/jpeg": "jpg", "image/gif": "gif", "image/png": "png" }[contentType];
        if (expectedType === "image" && !imageExtension) throw new Error("LINE OA supports JPEG, PNG, and GIF images.");
        const videoExtension = { "video/mp4": "mp4", "video/quicktime": "mov", "video/x-m4v": "m4v", "video/x-msvideo": "avi" }[contentType];
        if (expectedType === "video" && !videoExtension) throw new Error("LINE OA video type is unsupported.");
        const fileName = value(command.file_name) || (expectedType === "image" ? `image.${imageExtension}` : `video.${videoExtension}`);
        const form = new FormData();
        form.append("file", new Blob([bytes], { type: contentType || "application/octet-stream" }), fileName);
        const uploadHeaders = { ...profile.headers };
        delete uploadHeaders["content-type"];
        operation = "upload";
        const upload = await nativeFetch(`${apiBase}/v1/bots/${encodeURIComponent(botId)}/messages/${encodeURIComponent(conversationId)}/uploadFile`, {
          method: "POST", credentials: "include", headers: uploadHeaders, body: form, signal: requestSignal(),
        });
        httpStatus = upload.status;
        const uploaded = await upload.json().then((body) => { responseFormat = "json"; return body; }).catch(() => { responseFormat = "non_json"; return null; });
        if (!upload.ok) {
          if ([401, 403].includes(upload.status)) markProviderCheckFailure({ providerDiagnostics: { http_status: upload.status } });
          providerDetails = providerErrorDetails(uploaded);
          throw new Error(`LINE OA attachment upload failed (${upload.status}).`);
        }
        const token = value(uploaded?.contentMessageToken);
        if (!token) throw new Error("LINE OA attachment upload returned no content token.");
        endpoint = `${apiBase}/v1/bots/${encodeURIComponent(botId)}/chats/${encodeURIComponent(conversationId)}/messages/bulkSendFiles`;
        body = JSON.stringify({ items: [{ sendId: confirmationSendId, contentMessageToken: token }] });
      }
      const signal = requestSignal();
      operation = "send";
      httpStatus = undefined;
      responseFormat = undefined;
      sendStarted = true;
      const response = await nativeFetch(endpoint, {
        method: "POST",
        headers: profile.headers,
        credentials: "include",
        body,
        signal,
      });
      httpStatus = response.status;
      const responseBody = await response.json().then((body) => { responseFormat = "json"; return body; }).catch(() => { responseFormat = "non_json"; return null; });
      if (!response.ok) {
        if ([401, 403].includes(response.status)) markProviderCheckFailure({ providerDiagnostics: { http_status: response.status } });
        providerDetails = providerErrorDetails(responseBody);
        post({ type: "api_send_result", request_id: requestId, ok: false, error: `LINE OA send failed (${response.status}).`, diagnostics: diagnostics("provider_rejection") });
        return;
      }
      const responseMessageIdValue = responseMessageId(responseBody);
      operation = "confirm";
      httpStatus = undefined;
      responseFormat = undefined;
      const confirmedMessageId = await waitForSentMessage({
        botId,
        conversationId,
        sendId: confirmationSendId,
        deadlineAt,
      });
      const providerMessageId = confirmedMessageId || responseMessageIdValue;
      post({
        type: "api_send_result",
        request_id: requestId,
        ok: Boolean(confirmedMessageId || responseMessageIdValue),
        ...(confirmedMessageId ? { confirmed: true } : { uncertain: true }),
        send_id: confirmationSendId,
        ...(providerMessageId ? { provider_message_id: providerMessageId } : {}),
        ...(!confirmedMessageId ? { error: "LINE OA send was accepted but could not be confirmed in message history.", diagnostics: diagnostics("confirmation_failure", true) } : {}),
      });
    } catch (error) {
      if (error?.providerDiagnostics) {
        httpStatus = error.providerDiagnostics.http_status;
        responseFormat = error.providerDiagnostics.response_format;
        providerDetails = error.providerDiagnostics;
      }
      providerDetails.timed_out = ["AbortError", "TimeoutError"].includes(error?.name)
        || error?.message === "LINE OA reply deadline expired." || error?.message === "LINE OA request timed out.";
      if (["Error", "TypeError", "AbortError", "TimeoutError", "SyntaxError"].includes(error?.name)) providerDetails.error_name = error.name;
      const failureKind = providerDetails.timed_out ? "transport_failure"
        : httpStatus >= 400 ? "provider_rejection" : operation === "initialize" ? "pre_dispatch_failure" : "transport_failure";
      post({ type: "api_send_result", request_id: requestId, ok: false, uncertain: sendStarted,
        error: "LINE OA send was not acknowledged.", diagnostics: diagnostics(failureKind, sendStarted) });
    }
  }

  // Read only account/chat lists. Never fetch message history for metadata.
  async function refreshMetadata(command) {
    const requestId = value(command?.request_id);
    const accountId = normalizeBasicId(command?.provider_account_id);
    const deadlineAt = Math.min(Number(command?.deadline_at) || 0, Date.now() + 30_000);
    const limit = Math.max(1, Math.min(100, Math.trunc(Number(command?.limit) || 100)));
    const locationAtStart = window.location.href;
    const sessionEpoch = metadataSessionEpoch;
    const profiles = [];
    let account;
    const assertCurrent = () => {
      if (disposed || sessionEpoch !== metadataSessionEpoch || window.location.href !== locationAtStart) throw new Error("LINE OA session changed during metadata refresh.");
      if (Date.now() >= deadlineAt) throw new Error("Metadata refresh timed out.");
    };
    try {
      if (!requestId || !accountId) throw new Error("Metadata refresh account is missing.");
      assertCurrent();
      const accountsBody = await json(`${apiBase}/v1/bots?noFilter=true&limit=1000`, deadlineAt - Date.now());
      assertCurrent();
      if (!Array.isArray(accountsBody?.list)) throw new Error("LINE OA account list was invalid.");
      const bot = accountsBody.list.find((item) => normalizeBasicId(item?.basicSearchId ?? item?.basicId) === accountId);
      const botId = value(bot?.botId ?? bot?.id);
      if (!botId) throw new Error("This LINE OA is not accessible to the signed-in user.");
      const name = value(bot?.name ?? bot?.displayName);
      account = { provider: "line_oa", provider_account_id: accountId, bot_id: botId,
        ...(name ? { display_name: name } : {}) };
      let next = null;
      let count = 0;
      const seenCursors = new Set();
      const seenChats = new Set();
      let partial = false;
      do {
        assertCurrent();
        const url = new URL(chatUrl(botId, next));
        url.searchParams.set("limit", String(Math.min(CHAT_PAGE_LIMIT, limit - count)));
        url.searchParams.set("prioritizePinnedChat", "false");
        const body = await json(url.toString(), deadlineAt - Date.now());
        assertCurrent();
        if (!Array.isArray(body?.list)) throw new Error("LINE OA returned an invalid conversation list.");
        const chats = globalThis.OmnichatLineOA.chatItems(body);
        for (const chat of chats) {
          if (count >= limit) break;
          const conversationId = value(chat?.chatId);
          if (!conversationId || seenChats.has(conversationId)) continue;
          seenChats.add(conversationId);
          count += 1;
          const profile = chat?.profile;
          const id = value(profile?.userId ?? profile?.groupId) || conversationId;
          const displayName = value(profile?.displayName ?? profile?.name);
          const avatar = value(profile?.pictureUrl ?? profile?.imageUrl ?? profile?.avatarUrl);
          let avatarUrl = "";
          try { const parsed = new URL(avatar); if (parsed.protocol === "https:") avatarUrl = parsed.toString(); } catch { /* Optional metadata. */ }
          profiles.push({ conversation_id: conversationId, id, provider_account_id: accountId,
            ...(displayName ? { display_name: displayName } : {}), ...(avatarUrl ? { avatar_url: avatarUrl } : {}) });
        }
        next = cursor(body?.next);
        if (next && seenCursors.has(next)) { partial = true; break; }
        if (next) seenCursors.add(next);
        if (next && count >= limit) partial = true;
      } while (next && count < limit);
      assertCurrent();
      post({ type: "metadata_refresh_result", request_id: requestId, ok: true, account, profiles, partial });
    } catch (error) {
      const current = !disposed && sessionEpoch === metadataSessionEpoch && window.location.href === locationAtStart && Date.now() < deadlineAt;
      post({ type: "metadata_refresh_result", request_id: requestId, ok: Boolean(current && account),
        ...(current && account ? { account } : {}), profiles: current ? profiles : [], partial: Boolean(current && account),
        error: error instanceof Error ? error.message : "Metadata refresh failed." });
    }
  }

  const listener = (event) => {
    if (disposed || event.source !== window || event.origin !== window.location.origin || event.data?.source !== SOURCE) return;
    if (event.data.type === "refresh_metadata_v3") {
      void refreshMetadata(event.data);
    } else if (event.data.type === "detect_account_v3") {
      void availableAccounts().then((accounts) => {
        postProviderStatus();
        post({
          type: "accounts_detected",
          request_id: event.data.request_id,
          accounts: accounts.map((account) => ({ provider: "line_oa", ...account })),
        });
      }).catch((error) => {
        post({
          type: "account_detection_failed",
          provider_check_outcome: providerCheckOutcome,
          request_id: event.data.request_id,
          error: "LINE OA account detection failed.",
          diagnostics: failedOperationDiagnostics(error, "initialize"),
        });
      });
    } else if (event.data.type === "sync_v3") {
      start(
        event.data.request_id,
        event.data.provider_account_id,
        event.data.bot_id,
        event.data.checkpoint,
        historySelection(event.data),
      );
    } else if (event.data.type === "cancel_sync_v3") {
      cancelPolling("LINE OA recovery was cancelled.", {
        notifyRequests: false,
        providerAccountId: event.data.provider_account_id,
        requestId: event.data.request_id,
      });
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
    compatibility_version: COMPATIBILITY_VERSION,
    metadata_refresh: true,
    bounded_message_ids: true,
    grace_classification: true,
    dispose() {
      disposed = true;
      cancelPolling("LINE OA bridge was replaced.");
      window.removeEventListener("message", listener);
    },
  };
  postProviderStatus();
})();
