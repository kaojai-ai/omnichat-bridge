(() => {
  const SOURCE = "omnichat-realtime-bridge";
  const recoveries = new Map();
  const accountDetections = new Map();
  const profilesByConversation = new Map();
  const pendingOutbound = new Map();
  const pendingApiSends = new Map();
  let activeConversationId = null;
  let realtimeConnected = false;
  let lastRealtimeConnectedAt = null;
  let resumeSyncTimer;
  const MAX_REPLY_TEXT_LENGTH = 2_000;
  const MAX_REPLY_IMAGE_BYTES = 10 * 1024 * 1024;
  const RECOVERY_INACTIVITY_TIMEOUT_MS = 60_000;

  const post = (message) => window.postMessage({ source: SOURCE, ...message }, window.location.origin);
  function sendRuntimeMessage(message, onError) {
    try {
      const runtime = globalThis.chrome?.runtime;
      if (typeof runtime?.sendMessage !== "function") return Promise.resolve(undefined);
      return Promise.resolve(runtime.sendMessage(message)).catch((error) => {
        onError?.(error);
        return undefined;
      });
    } catch (error) {
      onError?.(error);
      return Promise.resolve(undefined);
    }
  }

  const log = (level, event, message, details = {}) => {
    void sendRuntimeMessage({
      type: "record_log",
      level,
      area: "provider",
      event,
      message,
      details,
    }).catch(() => undefined);
  };

  const outboundKey = (conversationId, text) => `${conversationId}\u0000${text}`;
  const recoveryIdFrom = (requestId) => String(requestId ?? "").split(":")[0];

  function touchRecovery(requestId) {
    const id = recoveryIdFrom(requestId);
    const pending = recoveries.get(id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    pending.timeout = setTimeout(() => {
      if (recoveries.get(id) !== pending) return;
      recoveries.delete(id);
      post({ type: "cancel_sync", request_id: id });
      log("error", "recovery_timeout", "Shopee recovery stopped responding.");
      pending.resolve({
        ok: false,
        error: "Shopee recovery stopped responding for 60 seconds. Retry.",
      });
    }, RECOVERY_INACTIVITY_TIMEOUT_MS);
  }

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

  function findPendingApiSend(message) {
    if (!message.client_message_id) return null;
    for (const [requestId, pending] of pendingApiSends) {
      if (
        pending.clientMessageId === message.client_message_id
        && pending.conversationId === message.conversation_id
      ) {
        return { requestId, pending };
      }
    }
    return null;
  }

  function finishPendingApiSend(requestId, pending) {
    const providerMessageId = String(
      pending.result?.provider_message_id ?? pending.echo?.id ?? ""
    ).trim();
    if (providerMessageId && (pending.result?.ok || pending.echo)) {
      pendingApiSends.delete(requestId);
      clearTimeout(pending.timeout);
      if (pending.providerIdTimeout) clearTimeout(pending.providerIdTimeout);
      pending.resolve({ ok: true, provider_message_id: providerMessageId });
      return;
    }
    if (pending.result?.ok) {
      if (pending.providerIdTimeout) return;
      pending.providerIdTimeout = setTimeout(() => {
        if (pendingApiSends.get(requestId) !== pending) return;
        pendingApiSends.delete(requestId);
        clearTimeout(pending.timeout);
        pending.resolve({ ok: false, error: "Shopee did not return a provider message ID." });
      }, 2_000);
      return;
    }
    if (!pending.result) return;
    pendingApiSends.delete(requestId);
    clearTimeout(pending.timeout);
    pending.resolve({
      ok: false,
      error: pending.result.error
        ? `Shopee API error: ${pending.result.error}`
        : "Shopee API reply failed."
    });
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

  async function requestRecovery() {
    if (!await isConfigured()) {
      log("warn", "recovery_not_configured", "Provider recovery could not start because setup is incomplete.");
      return { ok: false, error: "Extension setup is required." };
    }
    const syncState = await chrome.runtime.sendMessage({ type: "get_sync_state" });
    if (!syncState?.ok) {
      log("error", "checkpoint_failed", syncState?.error ?? "Could not load sync checkpoint.");
      return syncState;
    }
    const requestId = crypto.randomUUID();
    const stored = await chrome.storage.local.get("detected_account");
    const result = new Promise((resolve) => {
      recoveries.set(requestId, { resolve, timeout: null });
      touchRecovery(requestId);
    });
    post({
      type: "sync",
      request_id: requestId,
      checkpoint: syncState.checkpoint,
      active_account_id: stored.detected_account?.provider_account_id ?? null,
    });
    log("info", "recovery_requested", "Provider recovery request sent.", {
      checkpoint_present: Boolean(syncState.checkpoint?.watermark),
    });
    return result;
  }

  function cancelRecovery() {
    let cancelled = 0;
    for (const [requestId, pending] of recoveries) {
      clearTimeout(pending.timeout);
      recoveries.delete(requestId);
      post({ type: "cancel_sync", request_id: requestId });
      pending.resolve({ ok: false, error: "Sync cancelled." });
      cancelled += 1;
    }
    return { ok: true, cancelled: cancelled > 0 };
  }

  async function requestAccountDetection() {
    const requestId = crypto.randomUUID();
    const result = new Promise((resolve) => {
      const timeout = setTimeout(() => {
        accountDetections.delete(requestId);
        log("warn", "account_detection_timeout", "Shopee account detection timed out.");
        resolve({ ok: false, error: "Refresh Shopee Seller Chat to detect the Shop ID." });
      }, 20_000);
      accountDetections.set(requestId, { resolve, timeout });
    });
    post({ type: "detect_account", request_id: requestId });
    return result;
  }

  function normalizedAccount(message) {
    const accountId = String(message?.provider_account_id ?? "").trim();
    if (!accountId) return null;
    const avatarUrl = typeof message?.avatar_url === "string" && message.avatar_url.startsWith("https://")
      ? message.avatar_url
      : undefined;
    return {
      provider: "shopee",
      provider_account_id: accountId,
      ...(typeof message?.display_name === "string" && message.display_name.trim() ? { display_name: message.display_name.trim() } : {}),
      ...(avatarUrl ? { avatar_url: avatarUrl } : {}),
      ...(typeof message?.provider_user_id === "string" && message.provider_user_id.trim()
        ? { provider_user_id: message.provider_user_id.trim() }
        : {}),
      ...(typeof message?.shop_user_id === "string" && message.shop_user_id.trim()
        ? { shop_user_id: message.shop_user_id.trim() }
        : {}),
      detected_at: new Date().toISOString(),
    };
  }

  async function handleAccountsDetected(message) {
    const accounts = (Array.isArray(message?.accounts) ? message.accounts : [message])
      .map(normalizedAccount)
      .filter(Boolean);
    if (!accounts.length) return;
    const stored = await chrome.storage.local.get(["local_consent", "config", "detected_account"]);
    if (!stored.local_consent?.accepted_at) return;
    const previousId = stored.detected_account?.provider_account_id;
    const configured = (account) => stored.config?.accounts?.some(
      (config) => config.provider === "shopee"
        && config.provider_account_id === account.provider_account_id,
    );
    const active = accounts.find((account) => account.provider_account_id === previousId && configured(account))
      ?? accounts.find((account) => account.provider_account_id === message.active_account_id && configured(account))
      ?? accounts.find(configured)
      ?? accounts.find((account) => account.provider_account_id === message.active_account_id)
      ?? accounts[0];
    await chrome.storage.local.set({ detected_accounts: accounts, detected_account: active });
    log("info", "account_detected", "Shopee shops detected on provider page.", {
      accounts: accounts.length,
      active_account_id: active.provider_account_id,
    });
    const pending = message.request_id ? accountDetections.get(message.request_id) : null;
    if (!pending) return;
    accountDetections.delete(message.request_id);
    clearTimeout(pending.timeout);
    pending.resolve({ ok: true, account: active, accounts });
  }

  function handleAccountDetectionFailed(message) {
    const pending = accountDetections.get(message.request_id);
    if (!pending) return;
    accountDetections.delete(message.request_id);
    clearTimeout(pending.timeout);
    log("warn", "account_detection_failed", message.error ?? "Shopee account was not found.");
    pending.resolve({ ok: false, error: message.error ?? "Shopee Shop ID was not found." });
  }

  function handleProfilesDetected(message) {
    for (const profile of message.profiles ?? []) {
      const conversationId = String(profile?.conversation_id ?? "").trim();
      const id = String(profile?.id ?? "").trim();
      if (!conversationId || !id) continue;
      profilesByConversation.set(conversationId, {
        id,
        ...(typeof profile.provider_account_id === "string" && profile.provider_account_id.trim()
          ? { provider_account_id: profile.provider_account_id.trim() }
          : {}),
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
      return profile
        ? {
          ...message,
          ...(profile.provider_account_id ? { provider_account_id: profile.provider_account_id } : {}),
          participant: profile,
        }
        : message;
    });
  }

  async function handleRecoveryBatch(message) {
    touchRecovery(message.request_id);
    try {
      const messages = addConversationProfile(
        globalThis.OmnichatShopee.parseShopeeMessages(message.body, "history_recovery")
      );
      const result = await chrome.runtime.sendMessage({
        type: "queue_messages",
        messages,
        flush: false,
        advance_cursor: false,
      });
      post({
        type: "recovery_ack",
        request_id: message.request_id,
        ok: Boolean(result?.ok),
        parsed: messages.length,
        queued: result?.queued ?? 0,
        latest_cursor: result?.latest_cursor ?? null,
        ...(result?.ok ? {} : { error: result?.error ?? "Could not persist recovered messages." })
      });
      log(result?.ok ? "debug" : "error", "recovery_batch_processed", result?.ok
        ? "Recovered message page processed."
        : result?.error ?? "Recovered message page failed.", {
        parsed: messages.length,
        queued: Number(result?.queued) || 0,
      });
    } catch (error) {
      log("error", "recovery_batch_failed", error instanceof Error ? error.message : String(error));
      post({ type: "recovery_ack", request_id: message.request_id, ok: false, error: String(error) });
    }
  }

  async function handleRecoveryCursor(message) {
    touchRecovery(message.request_id);
    try {
      const result = await chrome.runtime.sendMessage({
        type: "advance_scan_cursor",
        conversation_id: message.conversation_id,
        cursor: message.cursor,
        summary_token: message.summary_token,
      });
      post({
        type: "recovery_ack",
        request_id: message.request_id,
        ok: Boolean(result?.ok),
        ...(result?.ok ? {} : { error: result?.error ?? "Could not save sync cursor." }),
      });
    } catch (error) {
      post({ type: "recovery_ack", request_id: message.request_id, ok: false, error: String(error) });
    }
  }

  async function handleBootstrapSelection(message) {
    touchRecovery(message.request_id);
    try {
      const result = await chrome.runtime.sendMessage({
        type: "save_bootstrap",
        conversations: message.conversations,
      });
      post({
        type: "recovery_ack",
        request_id: message.request_id,
        ok: Boolean(result?.ok),
        ...(result?.ok ? {} : { error: result?.error ?? "Could not save bootstrap state." }),
      });
    } catch (error) {
      post({ type: "recovery_ack", request_id: message.request_id, ok: false, error: String(error) });
    }
  }

  function handleRecoveryProgress(message) {
    touchRecovery(message.request_id);
    void sendRuntimeMessage({
      type: "sync_progress",
      request_id: message.request_id,
      completed_conversations: message.completed_conversations,
      total_conversations: message.total_conversations
    });
  }

  function requestResumeSync() {
    clearTimeout(resumeSyncTimer);
    resumeSyncTimer = setTimeout(() => {
      void sendRuntimeMessage({ type: "resume_sync" }, (error) => {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("Extension context invalidated") || message.includes("Receiving end does not exist")) return;
        log("warn", "resume_failed", message);
      });
    }, 500);
  }

  async function handleRealtimeEvent(body) {
    const messages = [];
    for (const message of addConversationProfile(globalThis.OmnichatShopee.parseShopeeMessages(body, "realtime_socket"))) {
      const apiSend = findPendingApiSend(message);
      if (apiSend) {
        apiSend.pending.echo = message;
        finishPendingApiSend(apiSend.requestId, apiSend.pending);
      }

      const key = outboundKey(message.conversation_id, message.text ?? "");
      const pending = pendingOutbound.get(key);
      if (!pending) {
        messages.push(message);
        continue;
      }
      if (pending.timeout) clearTimeout(pending.timeout);
      pendingOutbound.delete(key);
      messages.push({
        ...message,
        command_id: pending.commandId,
        client_message_id: message.client_message_id ?? pending.clientMessageId,
      });
    }
    if (!messages.length) return;
    const result = await chrome.runtime.sendMessage({ type: "queue_messages", messages, flush: true });
    log(result?.ok ? "info" : "error", "realtime_processed", result?.ok
      ? "Realtime provider event processed."
      : result?.error ?? "Realtime provider event failed.", {
      parsed: messages.length,
      queued: Number(result?.queued) || 0,
      deferred: Boolean(result?.deferred),
    });
    if (document.documentElement) {
      document.documentElement.dataset.omnichatRealtimeCapture = JSON.stringify({
        parsed: messages.length,
        queued: result?.queued ?? 0,
        deferred: Boolean(result?.deferred),
      });
    }
  }

  async function handleRecoveryComplete(message) {
    const pending = recoveries.get(message.request_id);
    if (pending) clearTimeout(pending.timeout);
    if (!message.ok) {
      log("error", "recovery_failed", message.error ?? "Provider recovery failed.");
      if (pending) {
        recoveries.delete(message.request_id);
        pending.resolve(message);
      }
      return;
    }
    const result = {
      ok: true,
      recovered: message.recovered ?? 0,
      queued: message.queued ?? 0,
      watermark: message.watermark ?? null,
    };
    if (document.documentElement) {
      document.documentElement.dataset.omnichatRecovery = JSON.stringify({
        recovered: result.recovered,
        queued: result.queued,
      });
    }
    if (pending) {
      recoveries.delete(message.request_id);
      pending.resolve(result);
    }
    log("info", "recovery_completed", "Provider recovery completed.", {
      recovered: result.recovered,
      queued: result.queued,
    });
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

  async function sendViaApi(message) {
    const requestId = typeof message?.request_id === "string" ? message.request_id : "";
    const conversationId = typeof message?.conversation_id === "string" ? message.conversation_id : "";
    const commandType = typeof message?.command_type === "string" ? message.command_type : "";
    const text = typeof message?.text === "string" ? message.text.trim() : "";
    const clientMessageId = typeof message?.client_message_id === "string" && message.client_message_id
      ? message.client_message_id
      : requestId;
    if (!requestId || !conversationId || !clientMessageId) {
      return { ok: false, error: "Reply command is invalid." };
    }
    if (commandType === "send_text" && (!text || text.length > MAX_REPLY_TEXT_LENGTH)) {
      return { ok: false, error: "Reply text is invalid." };
    }
    if (commandType === "send_product") {
      const providerProductId = String(message?.provider_product_id ?? "").trim();
      const productName = String(message?.product_name ?? "").trim();
      if (!/^\d+$/.test(providerProductId) || !productName) {
        return { ok: false, error: "Shopee product is invalid." };
      }
    }
    let imagePayload = {};
    if (commandType === "send_image") {
      const imageBase64 = typeof message?.image_base64 === "string" ? message.image_base64 : "";
      const imageType = typeof message?.image_type === "string" ? message.image_type : "";
      if (!imageBase64 || !imageType.startsWith("image/")) return { ok: false, error: "Reply image is invalid." };
      let binary;
      try { binary = atob(imageBase64); } catch { return { ok: false, error: "Reply image is invalid." }; }
      const imageBytes = Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer;
      if (!imageBytes.byteLength || imageBytes.byteLength > MAX_REPLY_IMAGE_BYTES) {
        return { ok: false, error: "Reply image must be 10 MB or smaller." };
      }
      imagePayload = { image_bytes: imageBytes, image_type: imageType };
    }
    if (!["send_text", "send_image", "send_product"].includes(commandType)) {
      return { ok: false, error: "Unsupported Shopee reply command." };
    }
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        const pending = pendingApiSends.get(requestId);
        if (!pending) return;
        pendingApiSends.delete(requestId);
        if (pending.echo?.id) {
          resolve({ ok: true, provider_message_id: pending.echo.id });
          return;
        }
        resolve({ ok: false, error: "Shopee API reply timed out." });
      }, 30_000);
      pendingApiSends.set(requestId, {
        resolve,
        timeout,
        conversationId,
        clientMessageId,
        echo: null,
        result: null,
        providerIdTimeout: null,
      });
      post({
        type: "send_api",
        ...message,
        ...imagePayload,
        request_id: requestId,
        conversation_id: conversationId,
        command_type: commandType,
        client_message_id: clientMessageId,
      });
    });
  }

  function handleApiSendResult(message) {
    const pending = pendingApiSends.get(message.request_id);
    if (!pending) return;
    pending.result = message;
    finishPendingApiSend(message.request_id, pending);
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== window.location.origin || event.data?.source !== SOURCE) return;
    if (event.data.type === "realtime_event") {
      void handleRealtimeEvent(event.data.body);
    } else if (event.data.type === "accounts_detected" || event.data.type === "account_detected") {
      void handleAccountsDetected(event.data);
    } else if (event.data.type === "account_detection_failed") {
      handleAccountDetectionFailed(event.data);
    } else if (event.data.type === "profiles_detected") {
      handleProfilesDetected(event.data);
    } else if (event.data.type === "active_conversation") {
      activeConversationId = typeof event.data.conversation_id === "string" ? event.data.conversation_id : null;
    } else if (event.data.type === "socket_connected") {
      realtimeConnected = true;
      lastRealtimeConnectedAt = new Date().toISOString();
      log("info", "socket_observed", "Shopee realtime socket detected.");
      requestResumeSync();
    } else if (event.data.type === "provider_status") {
      realtimeConnected = event.data.realtime_connected === true;
      if (realtimeConnected) {
        lastRealtimeConnectedAt = event.data.connected_at ?? lastRealtimeConnectedAt ?? new Date().toISOString();
      }
    } else if (event.data.type === "diagnostic_log") {
      log(
        event.data.level,
        event.data.event,
        event.data.message,
        event.data.details,
      );
    } else if (event.data.type === "recovery_activity") {
      touchRecovery(event.data.request_id);
    } else if (event.data.type === "recovery_batch") {
      void handleRecoveryBatch(event.data);
    } else if (event.data.type === "recovery_cursor") {
      void handleRecoveryCursor(event.data);
    } else if (event.data.type === "recovery_bootstrap") {
      void handleBootstrapSelection(event.data);
    } else if (event.data.type === "recovery_progress") {
      handleRecoveryProgress(event.data);
    } else if (event.data.type === "sync_plan") {
      touchRecovery(event.data.request_id);
      void sendRuntimeMessage({
        type: "record_sync_plan",
        mode: event.data.mode,
        checkpoint: event.data.checkpoint,
        conversations: event.data.conversations,
      });
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
    if (message?.type === "get_provider_status") {
      respond({
        ok: true,
        realtime_connected: realtimeConnected,
        last_realtime_connected_at: lastRealtimeConnectedAt,
        page_visible: document.visibilityState === "visible",
      });
      return false;
    }
    if (message?.type === "sync_now") {
      void requestRecovery().then(respond, (error) => respond({ ok: false, error: String(error) }));
      return true;
    }
    if (message?.type === "cancel_sync") {
      respond(cancelRecovery());
      return false;
    }
    if (message?.type === "detect_account") {
      void requestAccountDetection().then(respond, (error) => respond({ ok: false, error: String(error) }));
      return true;
    }
    if (message?.type === "send_api") {
      void sendViaApi(message).then(respond, (error) => respond({ ok: false, error: String(error) }));
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

  log("info", "content_loaded", "Shopee content bridge loaded.");
  if (globalThis.OmnichatShopeeUrl.isShopeeChatPath(window.location.pathname)) {
    requestResumeSync();
  }
})();
