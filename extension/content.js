(() => {
  const SOURCE = "omnichat-realtime-bridge";
  const FALLBACK_DAYS = 7;
  const recoveries = new Map();
  const accountDetections = new Map();
  const profilesByConversation = new Map();
  const pendingOutbound = new Map();
  const pendingApiSends = new Map();
  let activeConversationId = null;
  let resumeSyncTimer;
  const MAX_REPLY_TEXT_LENGTH = 2_000;

  const post = (message) => window.postMessage({ source: SOURCE, ...message }, window.location.origin);

  const outboundKey = (conversationId, text) => `${conversationId}\u0000${text}`;

  function trackOutbound(conversationId, text, commandId, clientMessageId) {
    const key = outboundKey(conversationId, text);
    const previous = pendingOutbound.get(key);
    if (previous?.timeout) clearTimeout(previous.timeout);
    const outbound = { commandId, clientMessageId, timeout: null };
    outbound.timeout = setTimeout(() => {
      if (pendingOutbound.get(key) === outbound) pendingOutbound.delete(key);
    }, 60_000);
    pendingOutbound.set(key, outbound);
  }

  function clearTrackedOutbound(conversationId, text, commandId) {
    const key = outboundKey(conversationId, text);
    const outbound = pendingOutbound.get(key);
    if (!outbound || outbound.commandId !== commandId) return;
    if (outbound.timeout) clearTimeout(outbound.timeout);
    pendingOutbound.delete(key);
  }

  async function isConfigured() {
    const stored = await chrome.storage.local.get([
      "config",
      "detected_account",
      "local_consent",
    ]);
    const accountId = stored.detected_account?.provider_account_id;
    return Boolean(
      stored.local_consent?.accepted_at
      && stored.detected_account?.provider === "shopee"
      && accountId
      && stored.config?.accounts?.some(
        (account) => account.provider === "shopee"
          && account.provider_account_id === accountId,
      ),
    );
  }

  async function requestRecovery(mode = "limited") {
    if (!await isConfigured()) return { ok: false, error: "Extension setup is required." };
    const syncState = await chrome.runtime.sendMessage({ type: "get_sync_state" });
    if (!syncState?.ok) return syncState;
    const requestId = crypto.randomUUID();
    const result = new Promise((resolve) => {
      const timeout = mode === "resume" ? null : setTimeout(() => {
        recoveries.delete(requestId);
        resolve({ ok: false, error: "Shopee recovery timed out." });
      }, 120_000);
      recoveries.set(requestId, { resolve, timeout });
    });
    post({
      type: "recover",
      request_id: requestId,
      mode,
      cursors: syncState.cursor?.conversations ?? {},
      fallback_since: new Date(Date.now() - FALLBACK_DAYS * 86_400_000).toISOString()
    });
    return result;
  }

  async function requestAccountDetection() {
    const requestId = crypto.randomUUID();
    const result = new Promise((resolve) => {
      const timeout = setTimeout(() => {
        accountDetections.delete(requestId);
        resolve({ ok: false, error: "Refresh Shopee Seller Chat to detect the Shop ID." });
      }, 20_000);
      accountDetections.set(requestId, { resolve, timeout });
    });
    post({ type: "detect_account", request_id: requestId });
    return result;
  }

  async function handleAccountDetected(message) {
    const accountId = String(message.provider_account_id ?? "").trim();
    if (!accountId) return;
    const stored = await chrome.storage.local.get("local_consent");
    if (!stored.local_consent?.accepted_at) return;
    const avatarUrl = typeof message.avatar_url === "string" && message.avatar_url.startsWith("https://")
      ? message.avatar_url
      : undefined;
    const account = {
      provider: "shopee",
      provider_account_id: accountId,
      ...(typeof message.display_name === "string" && message.display_name.trim() ? { display_name: message.display_name.trim() } : {}),
      ...(avatarUrl ? { avatar_url: avatarUrl } : {}),
      detected_at: new Date().toISOString()
    };
    await chrome.storage.local.set({ detected_account: account });
    const pending = message.request_id ? accountDetections.get(message.request_id) : null;
    if (!pending) return;
    accountDetections.delete(message.request_id);
    clearTimeout(pending.timeout);
    pending.resolve({ ok: true, account });
  }

  function handleAccountDetectionFailed(message) {
    const pending = accountDetections.get(message.request_id);
    if (!pending) return;
    accountDetections.delete(message.request_id);
    clearTimeout(pending.timeout);
    pending.resolve({ ok: false, error: message.error ?? "Shopee Shop ID was not found." });
  }

  function handleProfilesDetected(message) {
    for (const profile of message.profiles ?? []) {
      const conversationId = String(profile?.conversation_id ?? "").trim();
      const id = String(profile?.id ?? "").trim();
      if (!conversationId || !id) continue;
      profilesByConversation.set(conversationId, {
        id,
        ...(typeof profile.display_name === "string" && profile.display_name.trim()
          ? { display_name: profile.display_name.trim() }
          : {}),
        ...(typeof profile.avatar_url === "string" && profile.avatar_url.startsWith("https://")
          ? { avatar_url: profile.avatar_url }
          : {})
      });
    }
  }

  function addConversationProfile(messages) {
    return messages.map((message) => {
      const profile = profilesByConversation.get(message.conversation_id);
      return profile ? { ...message, participant: profile } : message;
    });
  }

  async function handleRecoveryBatch(message) {
    try {
      const messages = addConversationProfile(
        globalThis.OmnichatShopee.parseShopeeMessages(message.body, "history_recovery")
      );
      const result = await chrome.runtime.sendMessage({ type: "queue_messages", messages, flush: false });
      post({
        type: "recovery_ack",
        request_id: message.request_id,
        ok: Boolean(result?.ok),
        parsed: messages.length,
        queued: result?.queued ?? 0,
        ...(result?.ok ? {} : { error: result?.error ?? "Could not persist recovered messages." })
      });
    } catch (error) {
      post({ type: "recovery_ack", request_id: message.request_id, ok: false, error: String(error) });
    }
  }

  function handleRecoveryProgress(message) {
    void chrome.runtime.sendMessage({
      type: "sync_progress",
      request_id: message.request_id,
      completed_conversations: message.completed_conversations,
      total_conversations: message.total_conversations
    });
  }

  function requestResumeSync() {
    clearTimeout(resumeSyncTimer);
    resumeSyncTimer = setTimeout(() => {
      void chrome.runtime.sendMessage({ type: "resume_sync" });
    }, 500);
  }

  async function handleRealtimeEvent(body) {
    const messages = addConversationProfile(globalThis.OmnichatShopee.parseShopeeMessages(body, "realtime_socket"))
      .map((message) => {
        const key = outboundKey(message.conversation_id, message.text ?? "");
        const pending = pendingOutbound.get(key);
        if (!pending) return message;
        if (pending.timeout) clearTimeout(pending.timeout);
        pendingOutbound.delete(key);
        return {
          ...message,
          command_id: pending.commandId,
          client_message_id: message.client_message_id ?? pending.clientMessageId,
        };
      });
    if (!messages.length) return;
    const result = await chrome.runtime.sendMessage({ type: "queue_messages", messages, flush: true });
    if (document.documentElement) {
      document.documentElement.dataset.omnichatRealtimeCapture = JSON.stringify({ parsed: messages.length, queued: result?.queued ?? 0 });
    }
  }

  async function handleRecoveryComplete(message) {
    const pending = recoveries.get(message.request_id);
    if (!message.ok) {
      await markSyncComplete(message.request_id);
      if (pending) {
        recoveries.delete(message.request_id);
        clearTimeout(pending.timeout);
        pending.resolve(message);
      }
      return;
    }
    const delivery = await chrome.runtime.sendMessage({ type: "flush_now" });
    const result = {
      ok: true,
      recovered: message.recovered ?? 0,
      queued: message.queued ?? 0,
      sent: delivery?.sent ?? 0,
      pending: delivery?.pending ?? message.queued ?? 0,
      ...(delivery?.ok ? {} : { sync_error: delivery?.error ?? "Target sync failed." })
    };
    if (document.documentElement) {
      document.documentElement.dataset.omnichatRecovery = JSON.stringify({ recovered: result.recovered, queued: result.queued, sent: result.sent });
    }
    await markSyncComplete(message.request_id);
    if (pending) {
      recoveries.delete(message.request_id);
      clearTimeout(pending.timeout);
      pending.resolve(result);
    }
  }

  function setComposerText(composer, text) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    if (!setter) throw new Error("Shopee message composer is unavailable.");
    setter.call(composer, text);
    composer.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
  }

  // WIP alternative only. This requires the target conversation to be open and is never used.
  async function sendTextByUiClick_WIP(message) {
    const requestId = typeof message?.request_id === "string" ? message.request_id : "";
    const conversationId = typeof message?.conversation_id === "string" ? message.conversation_id : "";
    const text = typeof message?.text === "string" ? message.text.trim() : "";
    if (!requestId || !conversationId || !text || text.length > MAX_REPLY_TEXT_LENGTH) {
      return { ok: false, error: "Reply text is invalid." };
    }
    if (activeConversationId !== conversationId) {
      return { ok: false, error: "Open the matching Shopee conversation before replying." };
    }

    const composer = document.querySelector("textarea[placeholder]");
    const sendControl = composer?.parentElement?.querySelector("i");
    if (!(composer instanceof HTMLTextAreaElement) || !(sendControl instanceof HTMLElement)) {
      return { ok: false, error: "Open the Shopee conversation before replying." };
    }

    if (typeof message.client_message_id === "string" && message.client_message_id) {
      trackOutbound(conversationId, text, requestId, message.client_message_id);
    }
    setComposerText(composer, text);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    sendControl.click();
    return { ok: true };
  }

  async function sendTextViaApi(message) {
    const requestId = typeof message?.request_id === "string" ? message.request_id : "";
    const conversationId = typeof message?.conversation_id === "string" ? message.conversation_id : "";
    const text = typeof message?.text === "string" ? message.text.trim() : "";
    const clientMessageId = typeof message?.client_message_id === "string" && message.client_message_id
      ? message.client_message_id
      : requestId;
    if (!requestId || !conversationId || !text || text.length > MAX_REPLY_TEXT_LENGTH) {
      return { ok: false, error: "Reply text is invalid." };
    }
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        pendingApiSends.delete(requestId);
        clearTrackedOutbound(conversationId, text, requestId);
        resolve({ ok: false, error: "Shopee API reply timed out." });
      }, 20_000);
      pendingApiSends.set(requestId, { resolve, timeout, conversationId, text, clientMessageId });
      // Shopee can broadcast the echo before its HTTP sender resolves. Track first so
      // the collector preserves the Admin optimistic message's client_message_id.
      trackOutbound(conversationId, text, requestId, clientMessageId);
      post({ type: "send_api", request_id: requestId, conversation_id: conversationId, text, client_message_id: clientMessageId });
    });
  }

  function handleApiSendResult(message) {
    const pending = pendingApiSends.get(message.request_id);
    if (!pending) return;
    pendingApiSends.delete(message.request_id);
    clearTimeout(pending.timeout);
    if (!message.ok) clearTrackedOutbound(pending.conversationId, pending.text, message.request_id);
    pending.resolve(message.ok
      ? { ok: true, ...(message.provider_message_id ? { provider_message_id: message.provider_message_id } : {}) }
      : { ok: false, error: message.error ? `Shopee API error: ${message.error}` : "Shopee API reply failed." });
  }

  async function markSyncComplete(requestId) {
    try {
      await chrome.runtime.sendMessage({ type: "sync_complete", request_id: requestId });
    } catch {
      // The popup state is non-critical; delivery state is managed by the background worker.
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== window.location.origin || event.data?.source !== SOURCE) return;
    if (event.data.type === "realtime_event") {
      void handleRealtimeEvent(event.data.body);
    } else if (event.data.type === "account_detected") {
      void handleAccountDetected(event.data);
    } else if (event.data.type === "account_detection_failed") {
      handleAccountDetectionFailed(event.data);
    } else if (event.data.type === "profiles_detected") {
      handleProfilesDetected(event.data);
    } else if (event.data.type === "active_conversation") {
      activeConversationId = typeof event.data.conversation_id === "string" ? event.data.conversation_id : null;
    } else if (event.data.type === "recovery_batch") {
      void handleRecoveryBatch(event.data);
    } else if (event.data.type === "recovery_progress") {
      handleRecoveryProgress(event.data);
    } else if (event.data.type === "recovery_complete") {
      void handleRecoveryComplete(event.data);
    } else if (event.data.type === "api_send_result") {
      handleApiSendResult(event.data);
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message?.type === "ping") {
      respond({ ok: true });
      return false;
    }
    if (message?.type === "recover_now") {
      void requestRecovery(message.mode).then(respond, (error) => respond({ ok: false, error: String(error) }));
      return true;
    }
    if (message?.type === "detect_account") {
      void requestAccountDetection().then(respond, (error) => respond({ ok: false, error: String(error) }));
      return true;
    }
    if (message?.type === "send_text_api") {
      void sendTextViaApi(message).then(respond, (error) => respond({ ok: false, error: String(error) }));
      return true;
    }
    if (message?.type === "send_text_ui_click_wip") {
      void sendTextByUiClick_WIP(message).then(respond, (error) => respond({ ok: false, error: String(error) }));
      return true;
    }
    return undefined;
  });

  window.addEventListener("pageshow", requestResumeSync);
  window.addEventListener("focus", requestResumeSync);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) requestResumeSync();
  });

})();
