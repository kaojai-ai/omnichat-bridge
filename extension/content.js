(() => {
  const SOURCE = "omnichat-realtime-bridge-v3";
  const BRIDGE_PROTOCOL_VERSION = 5;
  const AUTO_OPEN_SELLER_CENTRE_CHAT = "auto_open_seller_centre_chat";
  const previousBridge = globalThis.__omnichatContentBridgeControl;
  if (previousBridge?.source === SOURCE && typeof previousBridge.dispose === "function") {
    previousBridge.dispose("Content bridge reattached.");
  }
  const bridgeGeneration = (Number(globalThis.__omnichatContentBridgeGeneration) || 0) + 1;
  globalThis.__omnichatContentBridgeGeneration = bridgeGeneration;
  let disposed = false;
  const isBridgeActive = () => !disposed
    && globalThis.__omnichatContentBridgeGeneration === bridgeGeneration;
  const currentUrl = window.location.href || `${window.location.origin}${window.location.pathname}`;
  const providerAdapter = globalThis.OmnichatProviderAdapters?.forPage?.(currentUrl);
  if (!providerAdapter) return;
  const providerLabel = providerAdapter.displayName || providerAdapter.id;
  const recoveries = new Map();
  const accountDetections = new Map();
  const profilesByConversation = new Map();
  const pendingOutbound = new Map();
  const pendingApiSends = new Map();
  const pendingProviderPreparations = new Map();
  const realtimeMessageKeys = new Set();
  let activeConversationId = null;
  let realtimeConnected = false;
  let lastRealtimeConnectedAt = null;
  let providerSurface = null;
  let providerSurfaceReady = false;
  let providerCapabilities = {};
  let providerRealtimeTransport = null;
  let providerChatOpen = null;
  let automaticSellerCentreLandingStarted = false;
  let automaticSellerCentreLandingStartupChecked = false;
  let automaticSellerCentreLandingPromise = null;
  let automaticSellerCentreLandingRerun = false;
  let resumeSyncTimer;
  const MAX_REPLY_TEXT_LENGTH = 2_000;
  const MAX_REPLY_IMAGE_BYTES = 10 * 1024 * 1024;
  const RECOVERY_INACTIVITY_TIMEOUT_MS = 60_000;

  const post = (message) => {
    if (!isBridgeActive()) return;
    window.postMessage({ source: SOURCE, ...message }, window.location.origin);
  };
  function sendRuntimeMessage(message, onError) {
    if (!isBridgeActive()) {
      return Promise.resolve({ ok: false, error: "Provider bridge was replaced." });
    }
    try {
      const runtime = globalThis.chrome?.runtime;
      if (typeof runtime?.sendMessage !== "function") {
        const error = new Error("Extension context invalidated.");
        onError?.(error);
        return Promise.resolve({ ok: false, error: error.message });
      }
      return Promise.resolve(runtime.sendMessage(message)).catch((error) => {
        onError?.(error);
        return { ok: false, error: String(error) };
      });
    } catch (error) {
      onError?.(error);
      return Promise.resolve({ ok: false, error: String(error) });
    }
  }

  const log = (level, event, message, details = {}) => {
    void sendRuntimeMessage({
      type: "record_log",
      level,
      area: "provider",
      event,
      message,
      details: { ...details, provider: providerAdapter.id },
    }).catch(() => undefined);
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
    log("error", "async_error", "Extension async operation failed.", {
      scope,
      ...errorDetails(error),
      ...details,
    });
  }

  function observeAsync(scope, task, details = {}) {
    if (!isBridgeActive()) return Promise.resolve();
    return Promise.resolve()
      .then(() => (isBridgeActive() ? task() : undefined))
      .catch((error) => {
        if (isBridgeActive()) logAsyncError(scope, error, details);
      });
  }

  const onWindowError = (event) => {
    if (!isBridgeActive()) return;
    log("error", "uncaught_error", "Unhandled provider error.", {
      scope: "content",
      error_kind: "error_event",
      ...errorDetails(event?.error ?? event?.message),
    });
  };
  const onUnhandledRejection = (event) => {
    if (!isBridgeActive()) return;
    log("error", "uncaught_error", "Unhandled provider error.", {
      scope: "content",
      error_kind: "unhandled_rejection",
      ...errorDetails(event?.reason),
    });
  };
  window.addEventListener("error", onWindowError);
  window.addEventListener("unhandledrejection", onUnhandledRejection);

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
      post({ type: "cancel_sync_v3", request_id: id });
      log("error", "recovery_timeout", `${providerLabel} recovery stopped responding.`);
      pending.resolve({
        ok: false,
        error: `${providerLabel} recovery stopped responding for 60 seconds. Retry.`,
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
        pending.resolve({ ok: false, error: `${providerLabel} did not return a provider message ID.` });
      }, 2_000);
      return;
    }
    if (!pending.result) return;
    pendingApiSends.delete(requestId);
    clearTimeout(pending.timeout);
    pending.resolve({
      ok: false,
      error: pending.result.error
        ? `${providerLabel} API error: ${pending.result.error}`
        : `${providerLabel} API reply failed.`
    });
  }

  function prepareProviderSurface(message) {
    const requestId = typeof message?.request_id === "string" ? message.request_id : "";
    if (!requestId) return Promise.resolve({ ok: false, error: "Provider preparation request is invalid." });
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (!pendingProviderPreparations.has(requestId)) return;
        pendingProviderPreparations.delete(requestId);
        resolve({ ok: false, error: `${providerLabel} surface preparation timed out.` });
      }, 30_000);
      pendingProviderPreparations.set(requestId, { resolve, timeout });
      post({
        type: "prepare_provider_v3",
        provider: providerAdapter.id,
        request_id: requestId,
      });
    });
  }

  const isSellerCentrePage = () => providerAdapter.id === "shopee"
    && providerAdapter.surfaceForUrl?.(currentUrl) === "seller-centre";

  async function automaticSellerCentreLandingSync() {
    if (!isBridgeActive() || !isSellerCentrePage() || automaticSellerCentreLandingStarted) {
      return { skipped: "not_eligible" };
    }
    const stored = await chrome.storage.local.get([
      AUTO_OPEN_SELLER_CENTRE_CHAT,
      "local_consent",
      "config",
    ]);
    const configured = stored.config?.accounts?.some(
      (account) => account?.provider === providerAdapter.id,
    );
    if (
      stored[AUTO_OPEN_SELLER_CENTRE_CHAT] !== true
      || !stored.local_consent?.accepted_at
      || !configured
    ) {
      return { skipped: "not_enabled" };
    }

    automaticSellerCentreLandingStarted = true;
    const prepared = await prepareProviderSurface({
      request_id: `auto-open:${crypto.randomUUID()}`,
    });
    if (!prepared?.ok) {
      throw new Error(prepared?.error ?? "Seller Centre Chat could not be opened automatically.");
    }
    const detection = await requestAccountDetection();
    if (!detection?.ok) {
      throw new Error(detection?.error ?? "Shopee account detection failed after opening Chat.");
    }
    const latest = await chrome.storage.local.get([AUTO_OPEN_SELLER_CENTRE_CHAT]);
    if (latest[AUTO_OPEN_SELLER_CENTRE_CHAT] !== true) {
      return { skipped: "disabled_during_startup" };
    }
    const result = await sendRuntimeMessage({
      type: "auto_sync_now",
      provider: providerAdapter.id,
    });
    if (!result?.ok) throw new Error(result?.error ?? "Automatic sync could not start.");
    return result;
  }

  function startAutomaticSellerCentreLandingSync() {
    if (automaticSellerCentreLandingPromise) {
      automaticSellerCentreLandingRerun = true;
      return;
    }
    automaticSellerCentreLandingPromise = automaticSellerCentreLandingSync()
      .catch((error) => {
        automaticSellerCentreLandingStarted = false;
        logAsyncError("automatic_seller_centre_sync", error);
      })
      .finally(() => {
        automaticSellerCentreLandingPromise = null;
        if (automaticSellerCentreLandingRerun) {
          automaticSellerCentreLandingRerun = false;
          startAutomaticSellerCentreLandingSync();
        }
      });
  }

  async function isConfigured(providerAccountId) {
    const stored = await chrome.storage.local.get([
      "config",
      "detected_accounts",
      "local_consent",
    ]);
    const accountId = String(providerAccountId ?? "").trim();
    return Boolean(
      stored.local_consent?.accepted_at
      && accountId
      && stored.detected_accounts?.some(
        (account) => account?.provider === providerAdapter.id
          && account.provider_account_id === accountId,
      )
      && stored.config?.accounts?.some(
        (account) => account.provider === providerAdapter.id
          && account.provider_account_id === accountId,
      ),
    );
  }

  async function requestRecovery(providerAccountId) {
    if (!providerAdapter.supports("message_recovery")) {
      return { ok: false, error: `${providerAdapter.displayName} does not support message recovery.` };
    }
    const accountId = String(providerAccountId ?? "").trim();
    if (!await isConfigured(accountId)) {
      log("warn", "recovery_not_configured", "Provider recovery could not start because setup is incomplete.", {
        provider_account_id: accountId,
      });
      return { ok: false, error: "Extension setup is required." };
    }
    const syncState = await sendRuntimeMessage({
      type: "get_sync_state",
      provider: providerAdapter.id,
      provider_account_id: accountId,
    });
    if (!syncState?.ok) {
      log("error", "checkpoint_failed", syncState?.error ?? "Could not load sync checkpoint.");
      return syncState;
    }
    const requestId = crypto.randomUUID();
    const result = new Promise((resolve) => {
      recoveries.set(requestId, { resolve, timeout: null });
      touchRecovery(requestId);
    });
    post({
      type: "sync_v3",
      request_id: requestId,
      checkpoint: syncState.checkpoint,
      provider: providerAdapter.id,
      provider_account_id: accountId,
    });
    log("info", "recovery_requested", "Provider recovery request sent.", {
      provider_account_id: accountId,
      checkpoint_present: Boolean(syncState.checkpoint?.watermark),
    });
    return result;
  }

  function cancelRecovery() {
    let cancelled = 0;
    for (const [requestId, pending] of recoveries) {
      clearTimeout(pending.timeout);
      recoveries.delete(requestId);
      post({ type: "cancel_sync_v3", request_id: requestId });
      pending.resolve({ ok: false, error: "Sync cancelled." });
      cancelled += 1;
    }
    return { ok: true, cancelled: cancelled > 0 };
  }

  async function requestAccountDetection() {
    if (!providerAdapter.supports("account_detection")) {
      return { ok: false, error: `${providerAdapter.displayName} does not support account detection.` };
    }
    const requestId = crypto.randomUUID();
    const result = new Promise((resolve) => {
      const timeout = setTimeout(() => {
        accountDetections.delete(requestId);
        log("warn", "account_detection_timeout", `${providerLabel} account detection timed out.`);
        resolve({ ok: false, error: `Refresh ${providerLabel} to detect the account ID.` });
      }, 20_000);
      accountDetections.set(requestId, { resolve, timeout });
    });
    post({ type: "detect_account_v3", request_id: requestId });
    return result;
  }

  function normalizedAccount(message) {
    return providerAdapter.normalizeAccount(message);
  }

  function normalizedMessages(payload, captureMethod) {
    return providerAdapter.normalizeMessages(payload, captureMethod).map((message) => ({
      ...message,
      provider: typeof message?.provider === "string" && message.provider.trim()
        ? message.provider.trim()
        : providerAdapter.id,
    }));
  }

  async function handleAccountsDetected(message) {
    const accounts = (Array.isArray(message?.accounts) ? message.accounts : [message])
      .map(normalizedAccount)
      .filter(Boolean);
    if (!accounts.length) return;
    const stored = await chrome.storage.local.get(["local_consent"]);
    if (!stored.local_consent?.accepted_at) return;
    const persisted = await sendRuntimeMessage({
      type: "accounts_detected",
      provider: providerAdapter.id,
      accounts,
    });
    if (!persisted?.ok) {
      throw new Error(persisted?.error ?? "Could not save detected provider accounts.");
    }
    log("info", "account_detected", `${providerLabel} accounts detected on the provider page.`, {
      accounts: accounts.length,
    });
    const pending = message.request_id ? accountDetections.get(message.request_id) : null;
    if (!pending) return;
    accountDetections.delete(message.request_id);
    clearTimeout(pending.timeout);
    pending.resolve({ ok: true, accounts });
  }

  function handleAccountDetectionFailed(message) {
    const pending = accountDetections.get(message.request_id);
    if (!pending) return;
    accountDetections.delete(message.request_id);
    clearTimeout(pending.timeout);
    log("warn", "account_detection_failed", message.error ?? `${providerLabel} account was not found.`);
    pending.resolve({ ok: false, error: message.error ?? `${providerLabel} account ID was not found.` });
  }

  function profileField(profile, field) {
    const value = profile?.[field];
    return typeof value === "string" && value.trim() ? value.trim() : "";
  }

  function mergeConversationProfiles(...profiles) {
    const id = profiles.map((profile) => profileField(profile, "id")).find(Boolean) ?? "";
    if (!id) return null;
    const providerAccountId = profiles.map((profile) => profileField(profile, "provider_account_id")).find(Boolean);
    const displayName = profiles.map((profile) => profileField(profile, "display_name")).find(Boolean);
    const avatarUrl = profiles
      .map((profile) => profileField(profile, "avatar_url"))
      .find((value) => value.startsWith("https://"));
    return {
      id,
      ...(providerAccountId ? { provider_account_id: providerAccountId } : {}),
      ...(displayName ? { display_name: displayName } : {}),
      ...(avatarUrl ? { avatar_url: avatarUrl } : {}),
    };
  }

  function handleProfilesDetected(message) {
    for (const profile of message.profiles ?? []) {
      const conversationId = String(profile?.conversation_id ?? "").trim();
      const id = String(profile?.id ?? "").trim();
      if (!conversationId || !id) continue;
      const normalizedProfile = {
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
      };
      const merged = mergeConversationProfiles(profilesByConversation.get(conversationId), normalizedProfile);
      if (merged) profilesByConversation.set(conversationId, merged);
    }
  }

  function addConversationProfile(messages) {
    return messages.map((message) => {
      const profile = profilesByConversation.get(message.conversation_id);
      const participant = mergeConversationProfiles(profile, message.participant);
      return participant
        ? {
          ...message,
          ...(participant.provider_account_id ? { provider_account_id: participant.provider_account_id } : {}),
          participant,
        }
        : message;
    });
  }

  async function handleRecoveryBatch(message) {
    touchRecovery(message.request_id);
    try {
      const messages = addConversationProfile(
        normalizedMessages(message.body, "history_recovery")
      ).map((item) => ({
        ...item,
        ...(item.provider_account_id || !message.provider_account_id
          ? {}
          : { provider_account_id: message.provider_account_id }),
      }));
      const result = await sendRuntimeMessage({
        type: "queue_messages",
        messages,
        flush: false,
        advance_cursor: false,
      });
      post({
        type: "recovery_ack_v3",
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
        provider_account_id: message.provider_account_id,
        parsed: messages.length,
        queued: Number(result?.queued) || 0,
      });
    } catch (error) {
      log("error", "recovery_batch_failed", error instanceof Error ? error.message : String(error), {
        provider_account_id: message.provider_account_id,
        ...errorDetails(error),
      });
      post({ type: "recovery_ack_v3", request_id: message.request_id, ok: false, error: String(error) });
    }
  }

  async function handleRecoveryCursor(message) {
    touchRecovery(message.request_id);
    try {
      const result = await sendRuntimeMessage({
        type: "advance_scan_cursor",
        provider: providerAdapter.id,
        provider_account_id: message.provider_account_id,
        conversation_id: message.conversation_id,
        cursor: message.cursor,
        summary_token: message.summary_token,
      });
      post({
        type: "recovery_ack_v3",
        request_id: message.request_id,
        ok: Boolean(result?.ok),
        ...(result?.ok ? {} : { error: result?.error ?? "Could not save sync cursor." }),
      });
    } catch (error) {
      logAsyncError("recovery_cursor", error, {
        provider_account_id: message.provider_account_id,
        conversation_id: message.conversation_id,
      });
      post({ type: "recovery_ack_v3", request_id: message.request_id, ok: false, error: String(error) });
    }
  }

  async function handleBootstrapSelection(message) {
    touchRecovery(message.request_id);
    try {
      const result = await sendRuntimeMessage({
        type: "save_bootstrap",
        provider: providerAdapter.id,
        provider_account_id: message.provider_account_id,
        conversations: message.conversations,
      });
      post({
        type: "recovery_ack_v3",
        request_id: message.request_id,
        ok: Boolean(result?.ok),
        ...(result?.ok ? {} : { error: result?.error ?? "Could not save bootstrap state." }),
      });
    } catch (error) {
      logAsyncError("recovery_bootstrap", error, {
        provider_account_id: message.provider_account_id,
      });
      post({ type: "recovery_ack_v3", request_id: message.request_id, ok: false, error: String(error) });
    }
  }

  function handleRecoveryProgress(message) {
    touchRecovery(message.request_id);
    void sendRuntimeMessage({
      type: "sync_progress",
      provider: providerAdapter.id,
      provider_account_id: message.provider_account_id,
      request_id: message.request_id,
      completed_conversations: message.completed_conversations,
      total_conversations: message.total_conversations
    }, (error) => logAsyncError("sync_progress", error, {
      provider_account_id: message.provider_account_id,
    }));
  }

  function requestResumeSync() {
    if (!isBridgeActive()) return;
    clearTimeout(resumeSyncTimer);
    resumeSyncTimer = setTimeout(() => {
      if (!isBridgeActive()) return;
      void sendRuntimeMessage({ type: "resume_sync" }, (error) => {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("Extension context invalidated") || message.includes("Receiving end does not exist")) return;
      log("warn", "resume_failed", message);
      });
    }, 500);
  }

  async function handleRealtimeEvent(body, captureMethod = "realtime_socket") {
    const messages = [];
    for (const message of addConversationProfile(normalizedMessages(body, captureMethod))) {
      const apiSend = findPendingApiSend(message);
      if (apiSend) {
        apiSend.pending.echo = message;
        finishPendingApiSend(apiSend.requestId, apiSend.pending);
      }

      const realtimeKey = `${message.conversation_id}:${message.id}`;
      if (realtimeMessageKeys.has(realtimeKey)) continue;
      realtimeMessageKeys.add(realtimeKey);

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
    const result = await sendRuntimeMessage({ type: "queue_messages", messages, flush: true });
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
      log("error", "recovery_failed", message.error ?? "Provider recovery failed.", {
        provider_account_id: message.provider_account_id,
      });
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
      provider_account_id: message.provider_account_id,
      recovered: result.recovered,
      queued: result.queued,
    });
  }

  function setComposerText(composer, text) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    if (!setter) throw new Error(`${providerLabel} message composer is unavailable.`);
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
      return { ok: false, error: `Open the matching ${providerLabel} conversation before replying.` };
    }

    const composer = document.querySelector("textarea[placeholder]");
    const sendControl = composer?.parentElement?.querySelector("i");
    if (!(composer instanceof HTMLTextAreaElement) || !(sendControl instanceof HTMLElement)) {
      return { ok: false, error: `Open the ${providerLabel} conversation before replying.` };
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
        return { ok: false, error: `${providerLabel} product is invalid.` };
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
    if (!providerAdapter.supportsSend(commandType)) {
      return { ok: false, error: `Unsupported ${providerLabel} reply command.` };
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
        resolve({ ok: false, error: `${providerLabel} API reply timed out.` });
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
        type: "send_api_v3",
        ...message,
        ...imagePayload,
        provider: providerAdapter.id,
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

  const onPageMessage = (event) => {
    if (!isBridgeActive()) return;
    if (event.source !== window || event.origin !== window.location.origin || event.data?.source !== SOURCE) return;
    if (event.data.type === "realtime_event") {
      void observeAsync("realtime_event", () => handleRealtimeEvent(event.data.body, event.data.capture_method));
    } else if (event.data.type === "accounts_detected" || event.data.type === "account_detected") {
      void observeAsync("accounts_detected", () => handleAccountsDetected(event.data));
    } else if (event.data.type === "account_detection_failed") {
      handleAccountDetectionFailed(event.data);
    } else if (event.data.type === "profiles_detected") {
      handleProfilesDetected(event.data);
    } else if (event.data.type === "active_conversation") {
      activeConversationId = typeof event.data.conversation_id === "string" ? event.data.conversation_id : null;
    } else if (event.data.type === "socket_connected") {
      realtimeConnected = true;
      lastRealtimeConnectedAt = new Date().toISOString();
      log("info", "socket_observed", `${providerLabel} realtime socket detected.`);
      requestResumeSync();
    } else if (event.data.type === "provider_status") {
      const wasSurfaceReady = providerSurfaceReady;
      providerSurface = typeof event.data.surface === "string" ? event.data.surface : providerSurface;
      providerSurfaceReady = event.data.surface_ready === true;
      providerCapabilities = event.data.capabilities && typeof event.data.capabilities === "object"
        ? { ...event.data.capabilities }
        : providerCapabilities;
      providerRealtimeTransport = typeof event.data.realtime_transport === "string"
        ? event.data.realtime_transport
        : providerRealtimeTransport;
      providerChatOpen = typeof event.data.chat_open === "boolean"
        ? event.data.chat_open
        : providerChatOpen;
      realtimeConnected = event.data.realtime_connected === true;
      if (realtimeConnected) {
        lastRealtimeConnectedAt = event.data.connected_at ?? lastRealtimeConnectedAt ?? new Date().toISOString();
      }
      if (providerSurface === "seller-centre" && !automaticSellerCentreLandingStartupChecked) {
        automaticSellerCentreLandingStartupChecked = true;
        startAutomaticSellerCentreLandingSync();
      }
      if (
        providerSurface === "seller-centre"
        && providerSurfaceReady
        && providerChatOpen === true
        && !wasSurfaceReady
        && !automaticSellerCentreLandingStarted
      ) {
        requestResumeSync();
      }
    } else if (event.data.type === "seller_centre_chat_opened") {
      requestResumeSync();
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
      void observeAsync("recovery_batch", () => handleRecoveryBatch(event.data));
    } else if (event.data.type === "recovery_cursor") {
      void observeAsync("recovery_cursor", () => handleRecoveryCursor(event.data));
    } else if (event.data.type === "recovery_bootstrap") {
      void observeAsync("recovery_bootstrap", () => handleBootstrapSelection(event.data));
    } else if (event.data.type === "recovery_progress") {
      handleRecoveryProgress(event.data);
    } else if (event.data.type === "sync_plan") {
      touchRecovery(event.data.request_id);
      void sendRuntimeMessage({
        type: "record_sync_plan",
        provider: providerAdapter.id,
        provider_account_id: event.data.provider_account_id,
        mode: event.data.mode,
        checkpoint: event.data.checkpoint,
        conversations: event.data.conversations,
      }, (error) => logAsyncError("sync_plan", error, {
        provider_account_id: event.data.provider_account_id,
      }));
    } else if (event.data.type === "recovery_complete") {
      void observeAsync("recovery_complete", () => handleRecoveryComplete(event.data));
    } else if (event.data.type === "api_send_result") {
      handleApiSendResult(event.data);
    } else if (event.data.type === "prepare_provider_result") {
      const pending = pendingProviderPreparations.get(event.data.request_id);
      if (!pending) return;
      pendingProviderPreparations.delete(event.data.request_id);
      clearTimeout(pending.timeout);
      pending.resolve(event.data);
    }
  };

  const onRuntimeMessage = (message, _sender, respond) => {
    if (!isBridgeActive()) return undefined;
    if (message?.provider && message.provider !== providerAdapter.id) {
      respond({ ok: false, error: "Provider message does not match this page." });
      return false;
    }
    if (message?.type === "ping_v3") {
      respond({ ok: true, bridge_protocol_version: BRIDGE_PROTOCOL_VERSION, bridge_source: SOURCE });
      return false;
    }
    if (message?.type === "get_provider_status_v3") {
      respond({
        ok: true,
        surface: providerSurface,
        surface_ready: providerSurfaceReady,
        capabilities: { ...providerCapabilities },
        realtime_transport: providerRealtimeTransport,
        chat_open: providerChatOpen,
        realtime_connected: realtimeConnected,
        last_realtime_connected_at: lastRealtimeConnectedAt,
        page_visible: document.visibilityState === "visible",
      });
      return false;
    }
    if (message?.type === "auto_open_chat_and_sync_v3") {
      automaticSellerCentreLandingStartupChecked = true;
      startAutomaticSellerCentreLandingSync();
      respond({ ok: true, scheduled: true });
      return false;
    }
    if (message?.type === "sync_now_v3") {
      void requestRecovery(message.provider_account_id).then(respond, (error) => respond({ ok: false, error: String(error) }));
      return true;
    }
    if (message?.type === "cancel_sync_v3") {
      respond(cancelRecovery());
      return false;
    }
    if (message?.type === "detect_account_v3") {
      void requestAccountDetection().then(respond, (error) => respond({ ok: false, error: String(error) }));
      return true;
    }
    if (message?.type === "send_api_v3") {
      void sendViaApi(message).then(respond, (error) => respond({ ok: false, error: String(error) }));
      return true;
    }
    if (message?.type === "prepare_provider_v3") {
      void prepareProviderSurface(message).then(respond, (error) => respond({ ok: false, error: String(error) }));
      return true;
    }
    if (message?.type === "send_text_ui_click_wip_v3") {
      void sendTextByUiClick_WIP(message).then(respond, (error) => respond({ ok: false, error: String(error) }));
      return true;
    }
    return undefined;
  };

  const requestLifecycleResumeSync = () => {
    if (!isSellerCentrePage() || providerChatOpen === true) {
      requestResumeSync();
    }
  };
  const onPageShow = () => {
    if (isBridgeActive()) requestLifecycleResumeSync();
  };
  const onWindowFocus = () => {
    if (isBridgeActive()) requestLifecycleResumeSync();
  };
  const onVisibilityChange = () => {
    if (isBridgeActive() && !document.hidden) requestLifecycleResumeSync();
  };
  window.addEventListener("message", onPageMessage);
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  window.addEventListener("pageshow", onPageShow);
  window.addEventListener("focus", onWindowFocus);
  document.addEventListener("visibilitychange", onVisibilityChange);

  const dispose = (reason = "Content bridge was replaced.") => {
    if (disposed) return false;
    disposed = true;
    clearTimeout(resumeSyncTimer);
    for (const pending of recoveries.values()) {
      clearTimeout(pending.timeout);
      pending.resolve({ ok: false, error: reason });
    }
    recoveries.clear();
    for (const pending of accountDetections.values()) {
      clearTimeout(pending.timeout);
      pending.resolve({ ok: false, error: reason });
    }
    accountDetections.clear();
    for (const pending of pendingApiSends.values()) {
      clearTimeout(pending.timeout);
      if (pending.providerIdTimeout) clearTimeout(pending.providerIdTimeout);
      pending.resolve({ ok: false, error: reason });
    }
    pendingApiSends.clear();
    for (const pending of pendingProviderPreparations.values()) {
      clearTimeout(pending.timeout);
      pending.resolve({ ok: false, error: reason });
    }
    pendingProviderPreparations.clear();
    for (const pending of pendingOutbound.values()) clearTimeout(pending.timeout);
    pendingOutbound.clear();
    window.removeEventListener?.("error", onWindowError);
    window.removeEventListener?.("unhandledrejection", onUnhandledRejection);
    window.removeEventListener?.("message", onPageMessage);
    window.removeEventListener?.("pageshow", onPageShow);
    window.removeEventListener?.("focus", onWindowFocus);
    document.removeEventListener?.("visibilitychange", onVisibilityChange);
    try {
      globalThis.chrome?.runtime?.onMessage?.removeListener?.(onRuntimeMessage);
    } catch {
      // Chrome invalidates this API during an extension reload; the new listener uses a new channel generation.
    }
    return true;
  };
  globalThis.__omnichatContentBridgeControl = {
    source: SOURCE,
    bridge_protocol_version: BRIDGE_PROTOCOL_VERSION,
    generation: bridgeGeneration,
    dispose,
  };

  log("info", "content_loaded", `${providerLabel} content bridge loaded.`);
  if (providerAdapter.matchesUrl(currentUrl)) {
    requestLifecycleResumeSync();
  }
})();
