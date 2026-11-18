import { initializeConnectionPage } from "./lib/connection-page.js";
import { BaseClient } from "@evex-dev/linejs/base";
import QRCode from "qrcode";
import { createBrowserFetch } from "./lib/line-personal-fetch.js";
import { personalSessionStorage } from "./lib/line-personal-storage.js";
import { personalTextMessage } from "./lib/line-personal-message.js";
import { sendPersonalText } from "./lib/provider-text-send.js";
import { personalCommandClient } from "./lib/line-personal-command.js";
import { createPersonalProfiles } from "./lib/line-personal-profiles.js";
import { STORAGE, hasLocalConsent, readStorage } from "./lib/storage.js";

const ui = Object.fromEntries(["status", "authorization", "qr", "pin", "pin-help", "account", "name", "id", "copy", "connect", "disconnect", "reconnect", "countdown"].map((name) => [name, document.getElementById(`personal-${name}`)]));
const requestedAccount = new URL(location.href).searchParams.get("account");
const scope = /^u[a-f0-9]{32}$/i.test(requestedAccount ?? "") ? requestedAccount : "setup";
const tab = await chrome.tabs.getCurrent();
let session = null;
let port;
let closed = false;
const receipts = new Map();
const active = (value) => Boolean(value && session === value && !value.controller.signal.aborted);
const report = (text, error = false, ready = false, loading = false) => {
  if (ui.status.textContent !== text) ui.status.textContent = text;
  ui.status.dataset.loading = String(loading);
  ui.status.dataset.state = error ? "error" : ready ? "ready" : "neutral";
};

function connectPort() {
  if (closed) return;
  port = chrome.runtime.connect({ name: "omnichat-provider-tab" });
  port.onMessage.addListener((request) => {
    if (request?.kind === "provider_registered") return changed();
    if (request?.kind !== "provider_request") return;
    void handle(request.message).then((result) => port.postMessage({ kind: "provider_response", id: request.id, result }))
      .catch(() => { try { port.postMessage({ kind: "provider_response", id: request.id, result: { ok: false, error: "LINE Personal operation failed." } }); } catch {} });
  });
  port.onDisconnect.addListener(() => { if (!closed) setTimeout(connectPort, 1_000); });
  port.postMessage({ kind: "register_provider_tab", tab_id: tab.id });
}
function changed() { try { port.postMessage({ kind: "provider_state_changed" }); } catch {} }
async function configured(value = session) {
  const stored = await readStorage([STORAGE.config, STORAGE.consent]);
  if (!value?.base.profile?.mid || !hasLocalConsent(stored[STORAGE.consent])) return false;
  return stored[STORAGE.config]?.accounts?.some((account) => account.provider === "line_personal" && account.provider_account_id === value.base.profile.mid) === true;
}
function status() {
  const verified = Boolean(session?.ready && session.base.profile?.mid && active(session));
  const fresh = verified && Date.now() - session.lastSuccess < 195_000;
  return {
    ok: verified, provider: "line_personal", account_access_verified: verified,
    current_provider_account_id: verified ? session.base.profile.mid : null,
    accessible_account_ids: verified ? [session.base.profile.mid] : [],
    realtime_connected: fresh, provider_check_outcome: verified ? "verified" : "unknown",
    send_verified_at: fresh ? new Date().toISOString() : null,
    last_provider_check_at: fresh ? new Date().toISOString() : null,
    capabilities: { account_detection: true, message_recovery: true, send_text: true },
  };
}
async function account() {
  if (!session?.ready || !active(session)) return { ok: false, error: "Connect LINE Personal first." };
  const profile = session.base.profile;
  const result = { provider: "line_personal", provider_account_id: profile.mid, display_name: profile.displayName || "LINE Personal" };
  await chrome.runtime.sendMessage({ type: "accounts_detected", provider: "line_personal", accounts: [result] });
  return { ok: true, accounts: [result] };
}
async function queue(value, raw, captureMethod) {
  if (!active(value)) throw new DOMException("Connection stopped", "AbortError");
  if (!await configured(value)) throw new Error("ACCOUNT_NOT_CONFIGURED");
  if (raw.from === value.base.profile.mid && value.replyInFlight) await value.replyInFlight;
  const normalized = await personalTextMessage(value.base, raw, value.base.profile.mid, captureMethod);
  const message = await value.profiles.enrich(normalized, value.base.profile.mid);
  if (!message || !active(value)) return;
  const correlation = receipts.get(message.id);
  if (correlation) message.client_message_id = correlation;
  const result = await chrome.runtime.sendMessage({ type: "queue_messages", provider: "line_personal", messages: [message], flush: true });
  if (!result?.ok || result.latest_cursor?.message_id !== message.id) throw new Error("MESSAGE_QUEUE_UNAVAILABLE");
}
function waitForReconnect(signal, delayMs) {
  const deadline = Date.now() + delayMs;
  const updateCountdown = () => {
    ui.countdown.textContent = `Retrying in ${Math.max(1, Math.ceil((deadline - Date.now()) / 1_000))}s`;
  };
  updateCountdown();
  ui.countdown.hidden = false;
  ui.reconnect.hidden = false;
  return new Promise((resolve) => {
    const timer = setTimeout(finish, delayMs);
    const ticker = setInterval(updateCountdown, 250);
    function finish() {
      clearTimeout(timer);
      clearInterval(ticker);
      signal.removeEventListener("abort", finish);
      ui.reconnect.removeEventListener("click", finish);
      ui.countdown.hidden = true;
      ui.reconnect.hidden = true;
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
    ui.reconnect.addEventListener("click", finish, { once: true });
  });
}

function requiresNewLogin(error) {
  const code = error?.data?.code ?? error?.data?.e?.code;
  return error?.httpStatus === 401 || error?.name === "NotAuthorized"
    || code === "NOT_AUTHORIZED_DEVICE" || code === "AUTHENTICATION_FAILED";
}

async function poll(value) {
  const saved = await value.storage.get("syncRevisions");
  const revisions = saved ?? { revision: 0, globalRev: 0, individualRev: 0 };
  let retryDelay = 2_000;
  while (active(value)) {
    try {
      if (!await configured(value)) {
        report("Connected locally. Copy this account ID into your LINE Personal configuration to enable forwarding.");
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        continue;
      }
      value.forwardStartedAt ??= Date.now();
      if (!value.bootstrapRequested && !await value.storage.get("bootstrapDone")) {
        value.bootstrapRequested = true;
        void chrome.runtime.sendMessage({ type: "sync_account", provider: "line_personal", provider_account_id: value.base.profile.mid, tab_id: tab.id })
          .then((result) => result?.ok && value.storage.set("bootstrapDone", true))
          .catch(() => {
            if (active(value) && value.ready) report("Connected. Recent history is unavailable; use Sync messages to retry.", true);
          });
      }
      const response = await value.base.talk.sync({ ...revisions, limit: 100 });
      if (!active(value)) return;
      const next = { ...revisions };
      if (response.fullSyncResponse?.nextRevision != null) next.revision = response.fullSyncResponse.nextRevision;
      const operations = response.operationResponse;
      if (operations?.globalEvents?.lastRevision != null) next.globalRev = operations.globalEvents.lastRevision;
      if (operations?.individualEvents?.lastRevision != null) next.individualRev = operations.individualEvents.lastRevision;
      for (const event of operations?.operations ?? []) {
        if (!active(value)) return;
        if (["RECEIVE_MESSAGE", "SEND_MESSAGE"].includes(event.type) && event.message
          && (saved || Number(event.message.createdTime) >= value.forwardStartedAt)) await queue(value, event.message, "realtime_socket");
        if (event.revision != null) next.revision = event.revision;
      }
      await value.storage.set("syncRevisions", next);
      if (!active(value)) return;
      Object.assign(revisions, next); // Advance only after queue acceptance and durable cursor storage.
      value.ready = true;
      value.lastSuccess = Date.now();
      retryDelay = 2_000;
      changed();
      report("Connected. Incoming messages and replies use your configured server.", false, true);
      await new Promise((resolve) => setTimeout(resolve, 250));
    } catch (error) {
      if (!active(value)) return;
      value.ready = false;
      changed();
      if (requiresNewLogin(error)) {
        // The setup tab can authorize a different account on the next QR scan.
        if (scope === "setup") await value.storage.clear();
        else await value.storage.delete("authToken");
        receipts.clear();
        if (!active(value)) return;
        ui.connect.textContent = "Reconnect LINE";
        report("LINE ended this session. Reconnect and scan the QR code in LINE.", true);
        return;
      }
      report("LINE connection interrupted. Reconnecting…", false, false, true);
      await waitForReconnect(value.controller.signal, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 30_000);
    }
  }
}

async function history(value, signal) {
  if (!active(value) || !await configured(value)) return { ok: false, error: "This LINE account is not configured." };
  signal.throwIfAborted();
  const reader = personalCommandClient(value.base, signal);
  const boxes = await reader.talk.getMessageBoxes({ messageBoxListRequest: { minChatId: "0", maxChatId: "0", activeOnly: false, messageBoxCountLimit: 10, withUnreadCount: false, lastMessagesPerMessageBoxCount: 25 }, syncReason: "INTERNAL" });
  const conversations = Array.isArray(boxes) ? boxes : boxes?.messageBoxes ?? [];
  let recovered = 0;
  for (const box of conversations.slice(0, 10)) {
    if (!active(value)) break;
    signal.throwIfAborted();
    const mid = box.id ?? box.mid;
    if (typeof mid !== "string") continue;
    const messages = box.lastMessages?.length ? box.lastMessages : await reader.talk.getRecentMessagesV2({ messageBoxId: mid, messagesCount: 25 });
    for (const raw of (Array.isArray(messages) ? messages : messages?.messages ?? []).slice(-25)) {
      signal.throwIfAborted();
      await queue(value, raw, "history_recovery"); recovered++;
    }
    try { port.postMessage({ kind: "provider_sync_activity", ...value.historyRequest }); } catch {}
  }
  const result = { ok: true, recovered, total_conversations: Math.min(conversations.length, 10), completed_conversations: Math.min(conversations.length, 10) };
  return result;
}

async function handle(message) {
  if (message?.type === "ping_v3") return { ok: true, bridge_protocol_version: 14, bridge_source: "omnichat-realtime-bridge-v4", recovery_watchdog_version: 1 };
  if (message?.type === "get_provider_status_v3") return status();
  if (message?.type === "detect_account_v3") return account();
  if (message?.type === "cancel_sync_v3") { session?.historyController?.abort(); return { ok: true }; }
  const value = session;
  if (!active(value) || !value.ready || message?.provider_account_id !== value.base.profile.mid || !await configured(value)) return { ok: false, error: "LINE account is not verified for this configuration.", dispatch_started: false };
  if (message.type === "sync_now_v3") {
    if (value.historyController) return { ok: false, error: "LINE history sync is already running." };
    const controller = new AbortController();
    value.historyController = controller;
    value.historyRequest = { provider: "line_personal", provider_account_id: value.base.profile.mid, request_id: message.request_id };
    void history(value, AbortSignal.any([controller.signal, value.controller.signal])).catch(() => ({ ok: false, error: "Could not sync recent LINE history." })).then((result) => {
      if (!active(value)) return;
      try { port.postMessage({ kind: "provider_sync_complete", ...value.historyRequest, result }); } catch {}
    }).finally(() => { value.historyController = null; value.historyRequest = null; });
    return { ok: true, started: true, request_id: message.request_id };
  }
  if (message.type !== "send_api_v3" || message.command_type !== "send_text") return { ok: false, error: "Unsupported LINE Personal operation.", dispatch_started: false };
  if (value.replyInFlight) return { ok: false, error: "A reply is already in progress.", dispatch_started: false, retryable: false };
  if (!Number.isFinite(message.deadline_at_ms) || Date.now() >= message.deadline_at_ms) return { ok: false, error: "Reply expired before sending.", dispatch_started: false, retryable: true };
  const signal = AbortSignal.any([value.controller.signal, AbortSignal.timeout(Math.max(1, message.deadline_at_ms - Date.now()))]);
  const task = (async () => {
    const command = personalCommandClient(value.base, signal);
    const result = await sendPersonalText(command, { to: message.conversation_id, text: message.text, signal, receipt: true });
    if (result.provider_message_id && message.client_message_id) {
      receipts.set(result.provider_message_id, message.client_message_id);
      if (receipts.size > 1_000) receipts.delete(receipts.keys().next().value);
    }
    return {
      ok: result.status === "accepted", ...(result.provider_message_id ? { provider_message_id: result.provider_message_id } : {}),
      dispatch_started: result.status !== "not_dispatched", uncertain: result.status === "uncertain", retryable: false,
      execution_stage: result.stage, ...(result.status !== "accepted" ? { error: result.code, error_code: result.code } : {}),
    };
  })();
  value.replyInFlight = task;
  try { return await task; } finally { if (value.replyInFlight === task) value.replyInFlight = null; }
}

function isTransientConnectionError(error) {
  return error?.httpStatus === 404 || (error?.httpStatus >= 500 && error.httpStatus <= 599)
    || error?.name === "TypeError" || error?.name === "TimeoutError";
}

function connectionFailureMessage(stage, error) {
  // Never display raw SDK messages, response bodies, URLs or credentials.
  const status = error?.httpStatus;
  const reason = Number.isInteger(status) && status >= 400 && status <= 599 ? `HTTP ${status}`
    : ["TimeoutError", "NotAuthorized", "E2EEKeyMismatch", "NoE2EEKey"].includes(error?.name) ? error.name
    : error?.name === "TypeError" ? "network or browser failure" : "connection failed";
  return `LINE ${stage} failed (${reason}). Click Connect to try again.`;
}

async function start(value) {
  const storage = await personalSessionStorage(scope);
  if (!active(value)) return;
  const controller = value.controller;
  value.storage = storage;
  // Use direct HTTPS RPC: the extra /enc gateway returns 404 (LINEJS #280).
  // TLS and LINE message E2EE remain enabled.
  const base = new BaseClient({ device: "ANDROIDSECONDARY", legy: { encrypted: false }, storage, fetch: createBrowserFetch(controller.signal) });
  value.base = base;
  value.profiles = createPersonalProfiles({ signal: controller.signal,
    loadContact: (mid, signal) => personalCommandClient(base, signal).talk.getContact({ mid }),
    loadChat: (chatMid, signal) => personalCommandClient(base, signal).talk.getChat({ chatMid }) });
  base.on("update:authtoken", (token) => { if (active(value)) { base.authToken = token; void storage.set("authToken", token).catch(() => { value.ready = false; changed(); }); } });
  base.on("qrcall", (url) => {
    if (!active(value)) return;
    ui.authorization.hidden = false;
    ui.qr.hidden = false; ui.pin.hidden = true; ui["pin-help"].hidden = true;
    void QRCode.toCanvas(ui.qr, url, { width: 280, margin: 2 }).catch(() => report("Could not display the QR code. Reconnect and try again.", true));
  });
  base.on("pincall", (pin) => { if (active(value) && /^\d{4,8}$/.test(String(pin))) { ui.qr.hidden = true; ui.pin.hidden = false; ui.pin.textContent = String(pin); ui["pin-help"].hidden = false; } });
  let stage = "session";
  try {
    const token = await storage.get("authToken");
    stage = token ? "saved login" : "QR login";
    if (token) await base.loginProcess.login({ authToken: token });
    else {
      await base.loginProcess.withQrCode({});
      stage = "profile";
      await base.loginProcess.ready();
    }
    if (!active(value)) return;
    const profile = base.profile;
    if (!profile?.mid || (scope !== "setup" && profile.mid !== scope)) { await storage.clear(); throw new Error("ACCOUNT_MISMATCH"); }
    value.ready = true; value.lastSuccess = Date.now();
    ui.authorization.hidden = true; ui.pin.textContent = "";
    ui.account.hidden = false; ui.name.textContent = profile.displayName || "LINE Personal"; ui.id.textContent = profile.mid;
    stage = "configuration";
    const isConfigured = await configured(value);
    report(isConfigured ? "Connected. Incoming messages and replies use your configured server." : "Connected locally. Copy this account ID into your LINE Personal configuration to enable forwarding.", false, isConfigured);
    stage = "account registration";
    await account(); changed();
    stage = "sync";
    await poll(value);
  } catch (error) {
    if (active(value)) {
      // QR authorization may already have produced a valid token. Keep it
      // for transport outages; explicit disconnect and invalid keys still clear.
      if (stage !== "sync" && !isTransientConnectionError(error)) await storage.clear();
      report(connectionFailureMessage(stage, error), true);
    }
  } finally {
    controller.abort(); base.authToken = "";
    if (session === value) { session = null; ui.connect.hidden = false; ui.connect.disabled = false; ui.disconnect.hidden = true; changed(); }
  }
}

async function disconnect() {
  const value = session;
  session = null; value?.controller.abort();
  await value?.storage?.clear(); receipts.clear();
  ui.account.hidden = true; ui.authorization.hidden = true; ui.pin.textContent = "";
  ui.connect.hidden = false; ui.connect.disabled = false; ui.disconnect.hidden = true;
  ui.connect.textContent = "Connect LINE";
  report("Disconnected. Local session removed."); changed();
}

const requireConsent = await initializeConnectionPage({ onConsentRevoked: () => { void disconnect(); } });

ui.connect.addEventListener("click", async () => {
  if (session) return;
  // The connection button is shown only after consent. Request optional LINE
  // access directly in the click handler, before consent/storage checks await.
  try {
    const granted = await chrome.permissions.request({ origins: [
      "https://legy.line-apps.com/*", "https://obs.line-apps.com/*",
    ] });
    if (!granted) { report("Allow LINE access to connect this account.", true); return; }
    if (!await requireConsent()) return;
  } catch {
    report("Could not request LINE access. Click Connect to try again.", true); return;
  }
  ui.connect.disabled = true; ui.connect.hidden = true; ui.disconnect.hidden = false;
  const value = { controller: new AbortController(), ready: false, lastSuccess: 0, startedAt: Date.now() };
  session = value; report("Approve the connection in LINE on your phone.");
  void navigator.locks.request(`omnichat-line-personal:${scope}`, { ifAvailable: true }, async (lock) => {
    if (!lock) { session = null; ui.connect.hidden = false; ui.connect.disabled = false; report("This account already has a connection tab open.", true); return; }
    await start(value);
  }).catch(() => {
    value.controller.abort();
    if (session === value) session = null;
    ui.connect.hidden = false; ui.connect.disabled = false; ui.disconnect.hidden = true;
    report("The connection could not be started.", true);
  });
});
ui.disconnect.addEventListener("click", disconnect);
ui.copy.addEventListener("click", () => { if (session?.base.profile?.mid) void navigator.clipboard.writeText(session.base.profile.mid); });
window.addEventListener("beforeunload", (event) => {
  if (!active(session)) return;
  event.preventDefault();
  event.returnValue = true;
});
window.addEventListener("pagehide", () => { closed = true; session?.controller.abort(); });
setInterval(changed, 20_000);
connectPort();
