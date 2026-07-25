import { hmacHex, sha256Hex } from "./lib/crypto.js";
import { accountConfigKey, findAccountConfig } from "./lib/config.js";
import {
  STORAGE,
  hasLocalConsent,
  installationId,
  readAccountState,
  readStorage,
  writeAccountState,
  writeStorage,
} from "./lib/storage.js";

const SHOPEE_URL_PATTERN = "https://seller.shopee.co.th/*";
const SHOPEE_CHAT_URL = "https://seller.shopee.co.th/new-webchat/conversations";
const MAX_BATCH_MESSAGES = 500;
const MAX_BATCH_CONVERSATIONS = 50;
const MAX_MESSAGES_PER_CONVERSATION = 100;
const MAX_FLUSH_BATCHES = 10;
const RESUME_SYNC_COOLDOWN_MS = 5 * 60_000;
const MAX_REPLY_TEXT_LENGTH = 2_000;
let mutationQueue = Promise.resolve();
let activeSync = null;
const completedRecoveryIds = new Set();
let liveSocket = null;
let liveReconnectTimer = null;
let liveHeartbeatTimer = null;
let liveReconnectAttempt = 0;
let liveConnectionKey = null;

async function recordUnexpected(scope, error) {
  const message = error instanceof Error ? error.message : String(error);
  const stored = await readStorage([STORAGE.unexpected]);
  const items = Array.isArray(stored[STORAGE.unexpected]) ? stored[STORAGE.unexpected] : [];
  await writeStorage({
    [STORAGE.unexpected]: [{ at: new Date().toISOString(), scope, message }, ...items].slice(0, 10),
  });
}

function currentAccountContext(stored) {
  const key = accountConfigKey(stored[STORAGE.detectedAccount]);
  const config = findAccountConfig(stored[STORAGE.config], stored[STORAGE.detectedAccount]);
  return key && config ? { key, config, account: stored[STORAGE.detectedAccount] } : null;
}

async function writeScopedState(storageKey, key, value) {
  const stored = await readStorage([storageKey]);
  await writeStorage({ [storageKey]: writeAccountState(stored[storageKey], key, value) });
}

async function updateLiveState(context, patch) {
  const stored = await readStorage([STORAGE.live]);
  const current = readAccountState(stored[STORAGE.live], context.key, {});
  await writeStorage({
    [STORAGE.live]: writeAccountState(stored[STORAGE.live], context.key, {
      ...current,
      ...patch,
      updated_at: new Date().toISOString(),
    }),
  });
}

function exclusive(task) {
  const result = mutationQueue.then(task, task);
  mutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.type === "get_sync_state") {
    void readStorage([STORAGE.detectedAccount, STORAGE.targetCursor]).then(
      (stored) => {
        const key = accountConfigKey(stored[STORAGE.detectedAccount]);
        respond({
          ok: true,
          cursor: readAccountState(stored[STORAGE.targetCursor], key, null),
        });
      },
      (error) => respond({ ok: false, error: String(error) })
    );
    return true;
  }
  if (message?.type === "queue_messages") {
    void exclusive(() => queueMessages(message.messages, Boolean(message.flush))).then(
      (result) => respond({ ok: true, ...result }),
      (error) => respond({ ok: false, error: String(error) })
    );
    return true;
  }
  if (message?.type === "flush_now") {
    void exclusive(() => flushAll()).then(
      (result) => respond({ ok: true, ...result }),
      (error) => respond({ ok: false, error: String(error) })
    );
    return true;
  }
  if (message?.type === "sync_now") {
    void ensureLiveConnection().then(() => startSync()).then(
      (result) => respond({ ok: true, ...result }),
      (error) => respond({ ok: false, error: String(error) })
    );
    return true;
  }
  if (message?.type === "resume_sync") {
    void resumeSync().then(
      (result) => respond({ ok: true, ...result }),
      (error) => respond({ ok: false, error: String(error) })
    );
    return true;
  }
  if (message?.type === "sync_progress") {
    if (completedRecoveryIds.has(message.request_id)) {
      respond({ ok: true, ignored: true });
      return false;
    }
    void readStorage([STORAGE.detectedAccount]).then((stored) => {
      const key = accountConfigKey(stored[STORAGE.detectedAccount]);
      if (!key) throw new Error("Shopee account is not detected.");
      return writeScopedState(STORAGE.status, key, {
        state: "syncing",
        completed_conversations: message.completed_conversations,
        total_conversations: message.total_conversations
      });
    }).then(
      () => respond({ ok: true }),
      (error) => respond({ ok: false, error: String(error) })
    );
    return true;
  }
  if (message?.type === "sync_complete") {
    completedRecoveryIds.add(message.request_id);
    setTimeout(() => completedRecoveryIds.delete(message.request_id), RESUME_SYNC_COOLDOWN_MS);
    void readStorage([STORAGE.detectedAccount]).then((stored) => {
      const key = accountConfigKey(stored[STORAGE.detectedAccount]);
      if (!key) throw new Error("Shopee account is not detected.");
      return writeScopedState(STORAGE.status, key, {
        state: "watching",
        last_sync_at: new Date().toISOString(),
      });
    }).then(
      () => respond({ ok: true }),
      (error) => respond({ ok: false, error: String(error) })
    );
    return true;
  }
  if (message?.type === "detect_account") {
    void detectOpenShopeeAccount().then(
      (result) => respond(result),
      (error) => respond({ ok: false, error: String(error) })
    );
    return true;
  }
  if (message?.type === "send_text") {
    void sendTextViaShopeeApi(message).then(
      (result) => respond(result),
      async (error) => {
        await recordUnexpected("send_text", error);
        respond({ ok: false, error: String(error) });
      }
    );
    return true;
  }
  if (message?.type === "get_live_state") {
    void ensureLiveConnection().then(() => getLiveState()).then(respond, async (error) => {
      await recordUnexpected("live_state", error);
      respond({ ok: false, error: String(error) });
    });
    return true;
  }
  if (message?.type === "claim_leader") {
    void claimLeader(message.tab_id).then(respond, async (error) => {
      await recordUnexpected("claim_leader", error);
      respond({ ok: false, error: String(error) });
    });
    return true;
  }
  if (message?.type === "release_leader") {
    void releaseLeader().then(respond, async (error) => {
      await recordUnexpected("release_leader", error);
      respond({ ok: false, error: String(error) });
    });
    return true;
  }
  if (message?.type === "open_leader_tab") {
    void openCommandTab().then(respond, (error) => respond({ ok: false, error: String(error) }));
    return true;
  }
  return undefined;
});

async function commandTab(context) {
  const stored = await readStorage([STORAGE.commandTab]);
  const tabId = readAccountState(stored[STORAGE.commandTab], context.key, null);
  if (Number.isInteger(tabId)) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.url?.startsWith("https://seller.shopee.co.th/")) return tab;
    } catch {
      // The tab was closed; select another seller tab below.
    }
  }
  let tab = await findShopeeChatTab();
  if (!tab) tab = await chrome.tabs.create({ url: SHOPEE_CHAT_URL, active: false });
  if (!tab.id) throw new Error("Shopee Seller Chat tab is unavailable.");
  await writeStorage({ [STORAGE.commandTab]: writeAccountState(stored[STORAGE.commandTab], context.key, tab.id) });
  return tab;
}

async function selectCommandTab(context, tabId) {
  if (!Number.isInteger(tabId)) return;
  const tab = await chrome.tabs.get(tabId);
  if (!Number.isInteger(tab.id) || !tab.url?.startsWith("https://seller.shopee.co.th/new-webchat/conversations")) {
    throw new Error("Open Shopee Seller Chat in this tab first.");
  }
  const stored = await readStorage([STORAGE.commandTab]);
  await writeStorage({ [STORAGE.commandTab]: writeAccountState(stored[STORAGE.commandTab], context.key, tab.id) });
}

async function sendTextViaShopeeApi(message) {
  const requestId = typeof message?.request_id === "string" ? message.request_id : "";
  const conversationId = typeof message?.conversation_id === "string" ? message.conversation_id : "";
  const clientMessageId = typeof message?.client_message_id === "string" ? message.client_message_id : "";
  const text = typeof message?.text === "string" ? message.text.trim() : "";
  if (!requestId || !conversationId || !text || text.length > MAX_REPLY_TEXT_LENGTH) {
    return { ok: false, error: "Reply text is invalid." };
  }
  const stored = await readStorage([STORAGE.config, STORAGE.detectedAccount]);
  const context = currentAccountContext(stored);
  if (!context) return { ok: false, error: "Shopee browser bridge is not configured." };
  const tab = await commandTab(context);
  await ensureShopeeBridge(tab.id);
  return chrome.tabs.sendMessage(tab.id, {
    type: "send_text_api",
    request_id: requestId,
    conversation_id: conversationId,
    ...(clientMessageId ? { client_message_id: clientMessageId } : {}),
    text,
  });
}

// WIP alternative only. Do not call this from the command path: it needs the target
// conversation open and competes with the user's Shopee UI.
async function sendTextByUiClick_WIP(message) {
  const stored = await readStorage([STORAGE.config, STORAGE.detectedAccount]);
  const context = currentAccountContext(stored);
  if (!context) return { ok: false, error: "Shopee browser bridge is not configured." };
  const tab = await commandTab(context);
  await ensureShopeeBridge(tab.id);
  return chrome.tabs.sendMessage(tab.id, { ...message, type: "send_text_ui_click_wip" });
}

function liveEndpoint(config) {
  if (typeof config?.commands_url !== "string") return null;
  const url = new URL(config.commands_url);
  return url.protocol === "https:" ? url : null;
}

function leaderEndpoint(config) {
  const url = liveEndpoint(config);
  if (!url) return null;
  url.pathname = url.pathname.replace(/\/tickets$/, "/leader");
  return url;
}

async function signedLeaderRequest(action) {
  const stored = await readStorage([STORAGE.config, STORAGE.detectedAccount]);
  const context = currentAccountContext(stored);
  const url = leaderEndpoint(context?.config);
  if (!context || !url) throw new Error("Leader endpoint is not configured.");
  const body = JSON.stringify({
    provider: "shopee",
    provider_account_id: context.account.provider_account_id,
    installation_id: await installationId(),
    action,
  });
  const timestamp = new Date().toISOString();
  const nonce = crypto.randomUUID();
  const signature = await hmacHex(context.config.hmac_secret, `POST\n${url.pathname}\n${timestamp}\n${nonce}\n${await sha256Hex(body)}`);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-omnichat-provider-account-id": context.account.provider_account_id,
      "x-omnichat-timestamp": timestamp,
      "x-omnichat-nonce": nonce,
      "x-omnichat-signature": signature,
    },
    body,
  });
  if (!response.ok) throw new Error(`Leader endpoint returned ${response.status}.`);
  const result = await response.json();
  await updateLiveState(context, {
    socket: liveSocket?.readyState === WebSocket.OPEN ? "connected" : "connecting",
    leader: result?.leader_installation_id === await installationId(),
    leader_installation_id: result?.leader_installation_id ?? null,
  });
  return { ok: true, ...result };
}

async function getLiveState() {
  try { return await signedLeaderRequest("status"); }
  catch (error) {
    const stored = await readStorage([STORAGE.config, STORAGE.detectedAccount]);
    const context = currentAccountContext(stored);
    if (context) await updateLiveState(context, {
      socket: liveSocket?.readyState === WebSocket.OPEN ? "connected" : "reconnecting",
      leader: false,
    });
    throw error;
  }
}

async function claimLeader(tabId) {
  const stored = await readStorage([STORAGE.config, STORAGE.detectedAccount]);
  const context = currentAccountContext(stored);
  if (!context) throw new Error("Shopee browser bridge is not configured.");
  await selectCommandTab(context, tabId);
  return signedLeaderRequest("claim");
}

async function releaseLeader() {
  const stored = await readStorage([STORAGE.config, STORAGE.detectedAccount]);
  if (!currentAccountContext(stored)) throw new Error("Shopee browser bridge is not configured.");
  return signedLeaderRequest("release");
}

async function openCommandTab() {
  const stored = await readStorage([STORAGE.config, STORAGE.detectedAccount]);
  const context = currentAccountContext(stored);
  if (!context) throw new Error("Shopee browser bridge is not configured.");
  const tab = await commandTab(context);
  if (!tab.id) throw new Error("Shopee Seller Chat tab is unavailable.");
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  return { ok: true };
}

function stopLiveConnection() {
  clearTimeout(liveReconnectTimer);
  clearInterval(liveHeartbeatTimer);
  liveReconnectTimer = null;
  liveHeartbeatTimer = null;
  liveSocket?.close();
  liveSocket = null;
  liveConnectionKey = null;
}

function scheduleLiveReconnect() {
  clearTimeout(liveReconnectTimer);
  const delay = Math.min(60_000, 1_000 * 2 ** Math.min(liveReconnectAttempt, 6));
  liveReconnectAttempt += 1;
  liveReconnectTimer = setTimeout(() => { void ensureLiveConnection(); }, delay);
}

async function signedLiveTicket(config, providerAccountId) {
  const url = liveEndpoint(config);
  if (!url) throw new Error("Live reply endpoint is not configured.");
  const body = JSON.stringify({ provider: "shopee", provider_account_id: providerAccountId, installation_id: await installationId() });
  const timestamp = new Date().toISOString();
  const nonce = crypto.randomUUID();
  const bodyHash = await sha256Hex(body);
  const signature = await hmacHex(config.hmac_secret, `POST\n${url.pathname}\n${timestamp}\n${nonce}\n${bodyHash}`);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-omnichat-provider-account-id": providerAccountId,
      "x-omnichat-timestamp": timestamp,
      "x-omnichat-nonce": nonce,
      "x-omnichat-signature": signature,
    },
    body,
  });
  if (!response.ok) throw new Error(`Live reply endpoint returned ${response.status}.`);
  const ticket = await response.json();
  if (typeof ticket?.ticket !== "string" || !ticket.ticket) throw new Error("Live reply endpoint returned an invalid ticket.");
  let socketUrl;
  try {
    socketUrl = new URL(ticket.socket_url);
  } catch {
    throw new Error("Live reply endpoint returned an invalid socket URL.");
  }
  if (socketUrl.protocol !== "wss:") throw new Error("Live reply endpoint returned an invalid socket URL.");
  return { ticket: ticket.ticket, socketUrl };
}

async function ensureLiveConnection() {
  const stored = await readStorage([STORAGE.config, STORAGE.consent, STORAGE.detectedAccount]);
  const context = currentAccountContext(stored);
  const endpoint = liveEndpoint(context?.config);
  if (!hasLocalConsent(stored[STORAGE.consent]) || !context || !endpoint) {
    stopLiveConnection();
    return;
  }
  const connectionKey = `${context.key}:${endpoint}`;
  if (liveConnectionKey && liveConnectionKey !== connectionKey) stopLiveConnection();
  if (liveSocket?.readyState === WebSocket.OPEN || liveSocket?.readyState === WebSocket.CONNECTING) return;
  await updateLiveState(context, { socket: "connecting" });
  try {
    const { ticket, socketUrl } = await signedLiveTicket(
      context.config,
      context.account.provider_account_id,
    );
    socketUrl.searchParams.set("ticket", ticket);
    const socket = new WebSocket(socketUrl);
    liveSocket = socket;
    liveConnectionKey = connectionKey;
    socket.addEventListener("open", () => {
      liveReconnectAttempt = 0;
      void updateLiveState(context, { socket: "connected" });
      clearInterval(liveHeartbeatTimer);
      liveHeartbeatTimer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping" }));
      }, 20_000);
      void getLiveState().catch((error) => recordUnexpected("leader_status", error));
    });
    socket.addEventListener("message", (event) => { void handleLiveCommand(event.data); });
    socket.addEventListener("close", () => {
      if (liveSocket === socket) {
        liveSocket = null;
        liveConnectionKey = null;
        clearInterval(liveHeartbeatTimer);
        void updateLiveState(context, { socket: "reconnecting", leader: false });
        scheduleLiveReconnect();
      }
    });
    socket.addEventListener("error", () => socket.close());
  } catch {
    await updateLiveState(context, { socket: "reconnecting" });
    scheduleLiveReconnect();
  }
}

async function handleLiveCommand(raw) {
  let command;
  try { command = JSON.parse(raw); } catch { return; }
  if (command?.type !== "send_text" || command.provider !== "shopee") return;
  const stored = await readStorage([STORAGE.detectedAccount]);
  if (stored[STORAGE.detectedAccount]?.provider_account_id !== command.provider_account_id) return;
  let result;
  try {
    result = await exclusive(() => sendTextViaShopeeApi(command));
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!result?.ok) await recordUnexpected("live_command", result?.error ?? "Reply failed.");
  if (liveSocket?.readyState === WebSocket.OPEN) {
    liveSocket.send(JSON.stringify({ type: "send_result", request_id: command.request_id, ok: Boolean(result?.ok), ...(result?.ok ? {} : { error: result?.error ?? "Reply failed." }) }));
  }
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes[STORAGE.config] || changes[STORAGE.consent] || changes[STORAGE.detectedAccount]) void ensureLiveConnection();
});

chrome.runtime.onStartup.addListener(() => { void ensureLiveConnection(); });
void ensureLiveConnection();

async function detectOpenShopeeAccount() {
  let tab = await findShopeeChatTab();
  if (!tab) return { ok: false, error: "Open Shopee Seller Chat to detect the Shop ID." };
  await ensureShopeeBridge(tab.id);
  return chrome.tabs.sendMessage(tab.id, { type: "detect_account" });
}

async function findShopeeChatTab() {
  const tabs = await chrome.tabs.query({ url: SHOPEE_URL_PATTERN });
  return tabs.find((item) => item.id && item.url?.includes("/new-webchat/conversations"));
}

async function ensureShopeeBridge(tabId) {
  try {
    const result = await chrome.tabs.sendMessage(tabId, { type: "ping" });
    if (result?.ok) return;
  } catch {
    // Reload below when an installed/reloaded extension is not attached to the existing page.
  }
  await chrome.tabs.reload(tabId);
  await waitForShopeeBridge(tabId);
}

async function waitForShopeeBridge(tabId) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const result = await chrome.tabs.sendMessage(tabId, { type: "ping" });
      if (result?.ok) return;
    } catch {
      // The page or content script is still loading.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Shopee Seller Chat did not finish loading.");
}

async function syncOpenShopee(mode) {
  const tab = await findShopeeChatTab();
  if (!tab) throw new Error("Open Shopee Seller Chat to sync messages.");
  await ensureShopeeBridge(tab.id);
  const result = await chrome.tabs.sendMessage(tab.id, { type: "recover_now", mode });
  if (!result?.ok) throw new Error(result?.error ?? "Shopee recovery failed.");
  return result;
}

async function manualSync() {
  const recovered = await syncOpenShopee("limited");
  const delivered = await exclusive(() => flushAll());
  return {
    recovered: recovered.recovered ?? 0,
    queued: recovered.queued ?? 0,
    sent: (recovered.sent ?? 0) + delivered.sent,
    pending: delivered.pending
  };
}

function startSync(mode = "limited") {
  if (activeSync) return activeSync;
  activeSync = (mode === "resume" ? resumeRecovery() : manualSync())
    .then(async (result) => {
      const syncedAt = new Date().toISOString();
      const stored = await readStorage([
        STORAGE.detectedAccount,
        STORAGE.lastResumeSyncAt,
        STORAGE.status,
      ]);
      const key = accountConfigKey(stored[STORAGE.detectedAccount]);
      if (!key) throw new Error("Shopee account is not detected.");
      await writeStorage({
        [STORAGE.status]: writeAccountState(stored[STORAGE.status], key, {
          state: "watching",
          last_sync_at: syncedAt,
          caught_up: result.pending === 0,
          last_result: {
            recovered: result.recovered,
            sent: result.sent,
            pending: result.pending,
          },
        }),
        [STORAGE.lastResumeSyncAt]: writeAccountState(
          stored[STORAGE.lastResumeSyncAt],
          key,
          syncedAt,
        ),
      });
      return result;
    })
    .finally(() => { activeSync = null; });
  return activeSync;
}

async function resumeRecovery() {
  const recovered = await syncOpenShopee("resume");
  const delivered = await exclusive(() => flushAll());
  return {
    recovered: recovered.recovered ?? 0,
    queued: recovered.queued ?? 0,
    sent: (recovered.sent ?? 0) + delivered.sent,
    pending: delivered.pending
  };
}

async function resumeSync() {
  if (activeSync) return activeSync;
  const stored = await readStorage([
    STORAGE.config,
    STORAGE.consent,
    STORAGE.detectedAccount,
    STORAGE.lastResumeSyncAt,
    STORAGE.targetCursor,
  ]);
  const context = currentAccountContext(stored);
  if (!hasLocalConsent(stored[STORAGE.consent]) || !context) {
    return { skipped: "not_configured" };
  }
  const lastResumeSyncAt = Date.parse(
    readAccountState(stored[STORAGE.lastResumeSyncAt], context.key, "") ?? "",
  );
  if (Number.isFinite(lastResumeSyncAt) && Date.now() - lastResumeSyncAt < RESUME_SYNC_COOLDOWN_MS) {
    return { skipped: "cooldown" };
  }
  await writeStorage({
    [STORAGE.lastResumeSyncAt]: writeAccountState(
      stored[STORAGE.lastResumeSyncAt],
      context.key,
      new Date().toISOString(),
    ),
  });
  const cursor = readAccountState(stored[STORAGE.targetCursor], context.key, null);
  const hasCursor = Object.keys(cursor?.conversations ?? {}).length > 0;
  return startSync(hasCursor ? "resume" : "limited");
}

function messageKey(message) {
  return `${message.provider}:${message.conversation_id}:${message.id}`;
}

function isAfterCursor(message, cursor) {
  if (!cursor) return true;
  const messageTime = Date.parse(message.event_timestamp);
  const cursorTime = Date.parse(cursor.event_timestamp);
  if (!Number.isFinite(messageTime) || !Number.isFinite(cursorTime)) return true;
  if (messageTime !== cursorTime) return messageTime > cursorTime;
  return String(message.id) > String(cursor.message_id ?? "");
}

async function queueMessages(messages, shouldFlush) {
  const stored = await readStorage([
    STORAGE.config,
    STORAGE.consent,
    STORAGE.detectedAccount,
    STORAGE.pending,
    STORAGE.targetCursor,
  ]);
  const context = currentAccountContext(stored);
  if (!hasLocalConsent(stored[STORAGE.consent]) || !context) {
    return { queued: 0, sent: 0, pending: 0 };
  }
  const pending = readAccountState(stored[STORAGE.pending], context.key, []);
  const targetCursor = readAccountState(stored[STORAGE.targetCursor], context.key, null);
  const known = new Set(pending.map(messageKey));
  const added = [];
  for (const message of messages ?? []) {
    const cursor = targetCursor?.conversations?.[message?.conversation_id];
    if (message?.provider !== "shopee" || known.has(messageKey(message)) || !isAfterCursor(message, cursor)) continue;
    known.add(messageKey(message));
    added.push(message);
  }
  if (added.length) {
    await writeStorage({
      [STORAGE.pending]: writeAccountState(
        stored[STORAGE.pending],
        context.key,
        [...pending, ...added],
      ),
    });
  }
  if (!shouldFlush) return { queued: added.length, sent: 0, pending: pending.length + added.length };
  try {
    const delivered = await flushAll();
    return { queued: added.length, ...delivered };
  } catch (error) {
    return { queued: added.length, sent: 0, pending: pending.length + added.length, sync_error: String(error) };
  }
}

function batchFor(messages, installId) {
  const conversations = new Map();
  for (const message of messages) {
    const conversation = conversations.get(message.conversation_id) ?? {
      id: message.conversation_id,
      ...(message.participant ? { participants: [message.participant] } : {}),
      messages: []
    };
    if (!conversation.participants && message.participant) conversation.participants = [message.participant];
    conversation.messages.push({
      id: message.id,
      event_timestamp: message.event_timestamp,
      observed_at: message.observed_at,
      sender_id: message.sender_id,
      recipient_id: message.recipient_id,
      ...(message.sender_account_id ? { sender_account_id: message.sender_account_id } : {}),
      ...(message.recipient_account_id ? { recipient_account_id: message.recipient_account_id } : {}),
      type: message.type,
      ...(message.text ? { text: message.text } : {}),
      ...(message.media_url ? { media_url: message.media_url } : {}),
      ...(message.provider_type ? { provider_type: message.provider_type } : {}),
      ...(message.command_id ? { command_id: message.command_id } : {}),
      ...(message.client_message_id ? { client_message_id: message.client_message_id } : {}),
      capture_method: message.capture_method
    });
    conversations.set(message.conversation_id, conversation);
  }
  return {
    schema: "omnichat.message_batch",
    version: 1,
    batch_id: crypto.randomUUID(),
    installation_id: installId,
    provider: "shopee",
    extension_version: chrome.runtime.getManifest().version,
    adapter_version: "shopee-realtime-1",
    conversations: [...conversations.values()]
  };
}

function selectBatchMessages(pending) {
  const conversationCounts = new Map();
  const selected = [];
  for (const message of pending) {
    const count = conversationCounts.get(message.conversation_id) ?? 0;
    if (count >= MAX_MESSAGES_PER_CONVERSATION) continue;
    if (!conversationCounts.has(message.conversation_id)
      && conversationCounts.size >= MAX_BATCH_CONVERSATIONS) continue;
    conversationCounts.set(message.conversation_id, count + 1);
    selected.push(message);
    if (selected.length >= MAX_BATCH_MESSAGES) break;
  }
  return selected;
}

async function signedRequest(config, providerAccountId, payload) {
  const url = new URL(config.events_url);
  if (url.protocol !== "https:") throw new Error("Target server must use HTTPS.");
  const body = JSON.stringify(payload);
  const timestamp = new Date().toISOString();
  const nonce = crypto.randomUUID();
  const bodyHash = await sha256Hex(body);
  const signature = await hmacHex(config.hmac_secret, `POST\n${url.pathname}\n${timestamp}\n${nonce}\n${bodyHash}`);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-omnichat-provider-account-id": providerAccountId,
      "x-omnichat-timestamp": timestamp,
      "x-omnichat-nonce": nonce,
      "x-omnichat-signature": signature
    },
    body
  });
  if (!response.ok) {
    let code = "";
    try {
      const error = await response.json();
      if (typeof error?.error === "string") code = `: ${error.error}`;
    } catch {
      // The HTTP status remains actionable when the target has no JSON error body.
    }
    throw new Error(`Target server returned ${response.status}${code}`);
  }
  return response.json();
}

function advancedCursor(current, delivered) {
  const conversations = { ...(current?.conversations ?? {}) };
  for (const message of delivered) {
    const previous = conversations[message.conversation_id];
    const previousTime = Date.parse(previous?.event_timestamp ?? "");
    const messageTime = Date.parse(message.event_timestamp);
    if (!Number.isFinite(messageTime)) continue;
    if (!Number.isFinite(previousTime)
      || messageTime > previousTime
      || (messageTime === previousTime && String(message.id) > String(previous.message_id))) {
      conversations[message.conversation_id] = {
        event_timestamp: message.event_timestamp,
        message_id: message.id
      };
    }
  }
  return { version: 1, conversations, updated_at: new Date().toISOString() };
}

async function flushBatch() {
  const stored = await readStorage([
    STORAGE.config,
    STORAGE.consent,
    STORAGE.pending,
    STORAGE.targetCursor,
    STORAGE.detectedAccount,
    STORAGE.status,
  ]);
  const context = currentAccountContext(stored);
  const pending = readAccountState(stored[STORAGE.pending], context?.key, []);
  if (!hasLocalConsent(stored[STORAGE.consent]) || !context || !pending.length) {
    return { sent: 0, pending: pending.length };
  }
  const selected = selectBatchMessages(pending);
  const payload = batchFor(selected, await installationId());
  if (JSON.stringify(payload).length > 1_000_000) throw new Error("Queued batch exceeds the 1 MiB limit.");
  const acknowledgement = await signedRequest(
    context.config,
    context.account.provider_account_id,
    payload,
  );
  if (acknowledgement.schema !== "omnichat.message_batch_ack"
    || acknowledgement.batch_id !== payload.batch_id
    || acknowledgement.accepted_messages + acknowledgement.duplicate_messages !== selected.length) {
    throw new Error("Target server acknowledgement is invalid.");
  }
  const deliveredKeys = new Set(selected.map(messageKey));
  const remaining = pending.filter((message) => !deliveredKeys.has(messageKey(message)));
  const targetCursor = readAccountState(stored[STORAGE.targetCursor], context.key, null);
  await writeStorage({
    [STORAGE.pending]: writeAccountState(stored[STORAGE.pending], context.key, remaining),
    [STORAGE.targetCursor]: writeAccountState(
      stored[STORAGE.targetCursor],
      context.key,
      advancedCursor(targetCursor, selected),
    ),
    [STORAGE.status]: writeAccountState(stored[STORAGE.status], context.key, {
      state: "watching",
      last_sync_at: new Date().toISOString(),
    }),
  });
  return { sent: selected.length, pending: remaining.length };
}

async function flushAll() {
  let sent = 0;
  let pending = 0;
  for (let batch = 0; batch < MAX_FLUSH_BATCHES; batch += 1) {
    const result = await flushBatch();
    sent += result.sent;
    pending = result.pending;
    if (!pending || !result.sent) break;
  }
  return { sent, pending };
}
