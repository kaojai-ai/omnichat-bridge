import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { latestMessageCursor } from "../extension/lib/sync-state.js";

const cacheSource = await readFile(new URL("../extension/lib/message-id-cache.js", import.meta.url), "utf8");
const source = cacheSource + "\n" + await readFile(new URL("../extension/shopee-realtime.js", import.meta.url), "utf8");
const urlSource = await readFile(new URL("../extension/lib/shopee-url.js", import.meta.url), "utf8");
const adaptersSource = await readFile(new URL("../extension/lib/provider-adapters.js", import.meta.url), "utf8");
const shopeeAdapterSource = await readFile(new URL("../extension/lib/shopee-adapter.js", import.meta.url), "utf8");
const shopeeParserSource = await readFile(new URL("../extension/lib/shopee.js", import.meta.url), "utf8");
// Native Shopee history offsets are exclusive message IDs, including 64-bit strings.
function historyPage(messages, offset, limit = 100) {
  const start = offset === "0" ? 0 : messages.findIndex(message => message.id === offset) + 1;
  assert.ok(offset === "0" || start > 0, `Unknown history cursor: ${offset}`);
  return messages.slice(start, start + limit);
}
const origin = "https://seller.shopee.co.th";
const parserContext = vm.createContext({ location: { origin }, URL });
vm.runInContext(shopeeParserSource, parserContext);

test("keeps the recovery account identity available to reconnect cleanup", () => {
  const recoverStart = source.indexOf("async function recover(");
  const recoveryTry = source.indexOf("    try {", recoverStart);
  const accountDeclaration = source.indexOf("const accountId = value(checkpoint?.provider_account_id);", recoverStart);

  assert.ok(recoverStart >= 0);
  assert.ok(accountDeclaration > recoverStart);
  assert.ok(accountDeclaration < recoveryTry);
  assert.equal(
    source.indexOf("const accountId = value(checkpoint?.provider_account_id);", accountDeclaration + 1),
    -1,
  );
});

test("a late native list response cannot restore templates or routes from the previous shop", async () => {
  const bridge = createBridge();
  await bridge.detect();
  let release;
  const oldList = bridge.fetch("/webchat/api/v1.2/conversations", () => new Promise(resolve => { release = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  await bridge.fetch("/webchat/api/coreapi/v1.2/login", { shop: { id: 200000002 } });
  release(new Response(JSON.stringify([{ id: "old-conversation", shop_id: 100000001, to_id: 123 }]), { status: 200 }));
  await oldList;
  assert.equal(bridge.state.currentAccountId, "200000002");
  assert.equal(bridge.state.listTemplate, null);
  assert.equal(bridge.state.lookupListTemplate, null);
  assert.equal(bridge.state.routesByShopConversation.size, 0);
});

test("observed authentication rejection invalidates the current shop and captured templates", async () => {
  const bridge = createBridge();
  await bridge.detect();
  await bridge.fetch("/webchat/api/v1.2/conversations", []);
  await bridge.fetch("/webchat/api/v1.2/conversations/rejected/messages", () => new Response("{}", { status: 401 }));
  assert.equal(bridge.state.currentAccountId, null);
  assert.equal(bridge.state.listTemplate, null);
  assert.equal(bridge.state.getTemplate, null);
  assert.equal(bridge.state.historyTemplate, null);
});

test("recovery verifies the live authenticated shop before using cached request templates", async () => {
  const bridge = createBridge();
  await bridge.detect();
  bridge.setResponse("/api/v2/login/", { shop_id: 200000002 });
  const result = await bridge.sync("100000001");
  assert.equal(result.ok, false);
  assert.match(result.error, /signed-in shop does not match|session changed|superseded/);
  assert.equal(bridge.requests.some(path => /conversations\/.+\/messages/.test(path)), false);
});

test("recovery authentication failure clears stale templates and retains the actual 401 failure", async () => {
  const bridge = createBridge();
  await bridge.detect();
  await bridge.fetch("/webchat/api/v1.2/conversations", []);
  bridge.setResponse("/api/v2/login/", () => new Response("{}", { status: 401 }));
  const result = await bridge.sync("100000001");
  assert.equal(result.ok, false);
  assert.match(result.error, /401/);
  assert.equal(bridge.state.currentAccountId, null);
  assert.equal(bridge.state.listTemplate, null);
  assert.equal(bridge.state.getTemplate, null);
});

test("an operation-specific 403 does not erase an authenticated shop", async () => {
  const bridge = createBridge();
  await bridge.detect();
  await bridge.fetch("/webchat/api/v1.2/conversations", []);
  await bridge.fetch("/webchat/api/v1.2/conversations/restricted/messages", () => new Response("{}", { status: 403 }));
  assert.equal(bridge.state.currentAccountId, "100000001");
  assert.ok(bridge.state.listTemplate);
});

function createBridge({ pathname = "/new-webchat/conversations", captureIntervals = false, miniChatOpen = null, initialResponses = {}, socket = null, requestTimeoutMs = 15_000 } = {}) {
  const listeners = [];
  const documentListeners = new Map();
  const posts = [];
  const acknowledged = new Set();
  const responses = new Map(Object.entries({
    "/api/v2/login/": { data: { shop_id: 100000001 } },
    "/webchat/api/coreapi/v1.2/login": { shop: { id: 100000001, name: "Example Sports Shop" } },
    ...initialResponses,
  }));
  const requests = [];
  const intervals = [];
  const checkpoints = new Map([["100000001", { watermark: "2026-08-01T00:00:00.000Z" }]]);
  const syncedAccounts = new Set();
  let checkpointReadAllowed = true;
  let pollAcknowledgement = true;
  let miniChatClicks = 0;
  let miniChatIsOpen = miniChatOpen === true;
  const miniChatPanel = {
    classList: {
      contains: (name) => name === "active" && miniChatIsOpen,
    },
  };
  const miniChatLauncher = {
    getBoundingClientRect: () => ({ width: 48, height: 48 }),
    id: "SidebarEntry",
    closest: (selector) => selector === ".panel-item"
      ? miniChatPanel
      : selector === "#SidebarEntry" ? miniChatLauncher : null,
    getAttribute: () => null,
    click: () => {
      miniChatClicks += 1;
      miniChatIsOpen = true;
    },
  };
  const document = {
    documentElement: { dataset: {} },
    addEventListener(type, listener) {
      documentListeners.set(type, [...(documentListeners.get(type) ?? []), listener]);
    },
    ...(miniChatOpen === null ? {} : {
      getElementById: (id) => id === "SidebarEntry" ? miniChatLauncher : null,
    }),
  };
  const window = {
    location: { origin, href: `${origin}${pathname}` },
    fetch: async (input) => {
      const path = new URL(input.url ?? input, origin).pathname;
      requests.push(path);
      const body = responses.get(path) ?? {};
      if (typeof body === "function") return body(input);
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    addEventListener(type, listener) {
      if (type === "message") listeners.push(listener);
    },
    removeEventListener(type, listener) {
      if (type !== "message") return;
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    },
    postMessage(message) {
      posts.push(message);
      if (message.type === "recovery_checkpoint") {
        queueMicrotask(() => {
          for (const listener of listeners) listener({ source: window, origin, data: {
            source: "omnichat-realtime-bridge-v3", type: "recovery_ack_v3",
            request_id: message.request_id, ok: checkpointReadAllowed,
            checkpoint: structuredClone(checkpoints.get(message.provider_account_id) ?? {}),
          } });
        });
      }
      if (message.type === "recovery_cursor" && message.request_id.startsWith("poll:")) {
        queueMicrotask(() => {
          const checkpoint = checkpoints.get(message.provider_account_id) ?? {};
          checkpoint.conversations = { ...checkpoint.conversations, [message.conversation_id]: message.cursor };
          checkpoints.set(message.provider_account_id, checkpoint);
          acknowledged.add(message.request_id);
          for (const listener of listeners) listener({ source: window, origin, data: {
            source: "omnichat-realtime-bridge-v3", type: "recovery_ack_v3",
            request_id: message.request_id, ok: true,
          } });
        });
      }
      if (message.type === "recovery_batch" && message.request_id.startsWith("poll:")) {
        queueMicrotask(() => {
          acknowledged.add(message.request_id);
          const parsed = parserContext.OmnichatShopee.parseShopeeMessages(message.body, "poll");
          for (const listener of listeners) listener({ source: window, origin, data: {
            source: "omnichat-realtime-bridge-v3", type: "recovery_ack_v3",
            request_id: message.request_id, ok: pollAcknowledgement,
            parsed: parsed.length, queued: pollAcknowledgement ? parsed.length : 0,
            latest_cursor: pollAcknowledgement ? latestMessageCursor(parsed) : null,
          } });
        });
      }
    },
    __CHAT_GLOBAL__: socket ? { socket } : {},
  };
  const clockStartedAt = Date.now();
  let clockOffset = 0;
  const context = vm.createContext({
    window,
    document,
    Date: class extends Date { static now() { return Date.parse("2026-08-20T12:00:00Z") + Date.now() - clockStartedAt + clockOffset; } },
    URL,
    Headers,
    Request,
    Response,
    FormData,
    Blob,
    ArrayBuffer,
    Uint8Array,
    structuredClone,
    AbortController,
    setInterval: (callback, delay) => {
      if (!captureIntervals) return 0;
      intervals.push({ callback, delay });
      return intervals.length;
    },
    setTimeout: (callback, delay, ...args) => setTimeout(callback, delay === 15_000 ? requestTimeoutMs : delay, ...args),
    clearInterval,
    clearTimeout,
  });
  vm.runInContext(urlSource, context);
  vm.runInContext(adaptersSource, context);
  vm.runInContext(shopeeAdapterSource, context);
  vm.runInContext(source, context);

  async function fetch(path, body, requestBody = {}) {
    responses.set(path, body);
    const isConversationList = [
      "/webchat/api/v1.2/conversations",
      "/webchat/api/v1.2/subaccount/serving_mode/conversations",
      "/webchat/api/v1.2/mini/conversations",
      "/webchat/api/v1.2/mini/subaccount/serving_mode/conversations",
    ].includes(path);
    await window.fetch(isConversationList
      ? new Request(`${origin}${path}`, { method: "POST", body: JSON.stringify(requestBody) })
      : `${origin}${path}`);
    if (isConversationList && !path.includes("/mini/")) {
      await window.fetch(`${origin}/webchat/api/v1.2/conversation/serving_mode/attr`);
    }
    await new Promise((resolve) => setImmediate(resolve));
  }

  function setResponse(path, body) {
    responses.set(path, body);
  }

  function seedRecoveryState() {
    const state = window.__omnichatRealtimeState;
    state.recoveryInFlight = true;
    state.recoveryRequestId = "stale-recovery";
    state.recoveryAbortController = new AbortController();
    state.acknowledgements.set("stale-ack", () => {});
  }

  async function resetRecovery() {
    for (const listener of listeners) {
      listener({
        source: window,
        origin,
        data: { source: "omnichat-realtime-bridge-v3", type: "reset_recovery_v3" },
      });
    }
    await new Promise((resolve) => setImmediate(resolve));
    return {
      recoveryInFlight: window.__omnichatRealtimeState.recoveryInFlight,
      recoveryRequestId: window.__omnichatRealtimeState.recoveryRequestId,
      acknowledgementCount: window.__omnichatRealtimeState.acknowledgements.size,
      recoveryEpoch: window.__omnichatRealtimeState.recoveryEpoch,
    };
  }

  async function runIntervals() {
    for (const { callback } of intervals) callback();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  }

  async function clickMiniChat() {
    for (const listener of documentListeners.get("click") ?? []) {
      listener({ target: miniChatLauncher });
    }
    miniChatLauncher.click();
    await new Promise((resolve) => setImmediate(resolve));
  }

  async function detect(requestId = "detect-1") {
    for (const listener of listeners) {
      listener({
        source: window,
        origin,
        data: { source: "omnichat-realtime-bridge-v3", type: "detect_account_v3", request_id: requestId },
      });
    }
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const detection = posts.findLast((post) => post.type === "accounts_detected" && post.request_id === requestId);
      if (detection) return detection;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return undefined;
  }

  async function waitForAutomaticDetection() {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const detection = posts.findLast((post) => post.type === "accounts_detected"
        && !post.request_id
        && post.accounts?.length === 1);
      if (detection) return detection;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return null;
  }

  async function sync(providerAccountId, requestId = "sync-1", checkpoint = { watermark: "2026-08-01T00:00:00.000Z" }, recoveryStore = null) {
    if (!syncedAccounts.has(providerAccountId)) checkpoints.set(providerAccountId, structuredClone(checkpoint));
    syncedAccounts.add(providerAccountId);
    for (const listener of listeners) {
      listener({
        source: window,
        origin,
        data: {
          source: "omnichat-realtime-bridge-v3",
          type: "sync_v3",
          request_id: requestId,
          checkpoint,
          provider_account_id: providerAccountId,
        },
      });
    }
    for (let attempt = 0; attempt < 2000; attempt += 1) {
      for (const post of posts) {
        if (![
          "recovery_batch",
          "recovery_bootstrap",
          "recovery_cursor",
          "history_backfill",
          "history_window",
          "recovery_scan_complete",
        ].includes(post.type) || acknowledged.has(post.request_id)) continue;
        acknowledged.add(post.request_id);
        const parsed = post.type === "recovery_batch"
          ? parserContext.OmnichatShopee.parseShopeeMessages(post.body, "history_recovery")
          : [];
        const failed = (post.type === "recovery_batch" && recoveryStore?.failNextBatch === true)
          || (post.type === "recovery_scan_complete" && recoveryStore?.failCompletion === true);
        if (failed) recoveryStore.failNextBatch = false;
        if (post.type === "recovery_bootstrap" && !failed) {
          const saved = checkpoints.get(providerAccountId) ?? {};
          saved.bootstrap = { conversations: post.conversations, started_at: post.started_at };
          checkpoints.set(providerAccountId, saved);
        }
        if (post.type === "recovery_scan_complete" && !failed) {
          const saved = checkpoints.get(providerAccountId) ?? {};
          saved.watermark = post.watermark;
          saved.bootstrap = null;
          checkpoints.set(providerAccountId, saved);
        }
        if (post.type === "recovery_cursor" && !failed) {
          const saved = checkpoints.get(providerAccountId) ?? {};
          saved.conversations = { ...saved.conversations, [post.conversation_id]: post.cursor };
          checkpoints.set(providerAccountId, saved);
        }
        if (recoveryStore && !failed) {
          if (post.type === "recovery_batch") recoveryStore.messages.push(...parsed);
          if (post.type === "recovery_cursor") recoveryStore.conversations[post.conversation_id] = post.cursor;
        }
        for (const listener of listeners) {
          listener({
            source: window,
            origin,
            data: {
              source: "omnichat-realtime-bridge-v3",
              type: "recovery_ack_v3",
              request_id: post.request_id,
              ok: !failed,
              parsed: parsed.length,
              queued: failed ? 0 : parsed.length,
              latest_cursor: failed ? null : latestMessageCursor(parsed),
            },
          });
        }
      }
      const complete = posts.findLast((post) => post.type === "recovery_complete" && post.request_id === requestId);
      if (complete) {
        if (complete.ok && recoveryStore) recoveryStore.watermark = checkpoints.get(providerAccountId)?.watermark;
        await new Promise((resolve) => setImmediate(resolve));
        return complete;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Recovery did not complete in the test harness.");
  }

  return {
    get state() { return window.__omnichatRealtimeState; },
    advanceClock(ms) { clockOffset += ms; },
    setSocket(socket) { window.__CHAT_GLOBAL__.socket = socket; },
    checkStatus(requestId) {
      for (const listener of listeners) listener({ source: window, origin, data: { source: "omnichat-realtime-bridge-v3", type: "check_provider_status_v3", request_id: requestId } });
      return posts.findLast(post => post.type === "provider_status" && post.request_id === requestId);
    },
    fetch,
    setResponse,
    checkpoint(accountId = "100000001") { return checkpoints.get(accountId) ?? {}; },
    setCheckpointReadAllowed(value) { checkpointReadAllowed = value; },
    setCheckpoint(value, accountId = "100000001") { checkpoints.set(accountId, structuredClone(value)); },
    setPollAcknowledgement(ok) { pollAcknowledgement = ok; },
    cancelSync(requestId) {
      for (const listener of listeners) listener({ source: window, origin, data: {
        source: "omnichat-realtime-bridge-v3", type: "cancel_sync_v3", request_id: requestId,
      } });
    },
    seedRecoveryState,
    resetRecovery,
    detect,
    waitForAutomaticDetection,
    sync,
    posts,
    requests,
    intervals,
    runIntervals,
    clickMiniChat,
    reattach() {
      vm.runInContext(source, context);
    },
    postLegacyBridgeMessage() {
      window.postMessage({
        source: "omnichat-realtime-bridge-v2",
        type: "send_api_v2",
        request_id: "legacy-send",
      }, origin);
    },
    dispose() { window.__omnichatRealtimeBridgeControl.dispose(); },
    get messageListenerCount() { return listeners.length; },
    get miniChatClicks() { return miniChatClicks; },
    get miniChatIsOpen() { return miniChatIsOpen; },
  };
}

test("resets stale page-side recovery state before a retry", async () => {
  const bridge = createBridge({ pathname: "/portal/chat-management" });
  bridge.seedRecoveryState();

  const state = await bridge.resetRecovery();

  assert.deepEqual(state, {
    recoveryInFlight: false,
    recoveryRequestId: null,
    acknowledgementCount: 0,
    recoveryEpoch: 1,
  });
});

test("replaces the prior page bridge listener on reattachment", () => {
  const bridge = createBridge();

  assert.equal(bridge.messageListenerCount, 1);
  bridge.reattach();

  assert.equal(bridge.messageListenerCount, 1);
});

test("fences messages emitted by a pre-v3 page bridge", () => {
  const bridge = createBridge();
  const before = bridge.posts.length;

  bridge.postLegacyBridgeMessage();

  assert.equal(bridge.posts.length, before);
});

test("signals automatic sync when Seller Centre mini-chat is opened manually", async () => {
  const bridge = createBridge({ pathname: "/portal/sale/order", miniChatOpen: false });

  await bridge.clickMiniChat();
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(bridge.miniChatClicks, 1);
  assert.equal(bridge.miniChatIsOpen, true);
  assert.equal(bridge.posts.filter((post) => post.type === "seller_centre_chat_opened").length, 1);
});

test("reports Seller Centre chat-open state separately from surface readiness", async () => {
  const bridge = createBridge({ pathname: "/portal/sale/order", miniChatOpen: false });
  await new Promise((resolve) => setImmediate(resolve));

  const closed = bridge.posts.findLast((post) => post.type === "provider_status");
  assert.equal(closed?.surface, "seller-centre");
  assert.equal(closed?.surface_ready, false);
  assert.equal(closed?.chat_open, false);

  await bridge.clickMiniChat();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const opened = bridge.posts.findLast((post) => post.type === "provider_status");
  assert.equal(opened?.chat_open, true);
});

test("uses shop.id as the provider account and keeps user IDs as metadata", async () => {
  const bridge = createBridge();
  await bridge.fetch("/webchat/api/coreapi/v1.2/login", {
    user: { id: 4897267 },
    shop: { id: 100000001, user_id: 100000002, name: "Example Sports Shop" },
  });

  const detection = bridge.posts.findLast((post) => post.type === "accounts_detected");
  assert.equal(detection.accounts.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(detection.accounts[0])), {
    provider: "shopee",
    provider_account_id: "100000001",
    display_name: "Example Sports Shop",
    provider_user_id: "4897267",
    shop_user_id: "100000002",
  });
  assert.equal(detection.accounts.some((account) => account.provider_account_id === "100000002"), false);
});

test("detects the Seller Centre shop before Webchat mini opens", async () => {
  const bridge = createBridge({
    pathname: "/portal/chat-management",
    miniChatOpen: false,
    initialResponses: {
      "/api/v2/login/": {
        data: { shop_id: 100000001, shop_name: "example-store" },
      },
    },
  });

  const detection = await bridge.detect();

  assert.deepEqual(JSON.parse(JSON.stringify(detection.accounts)), [{
    provider: "shopee",
    provider_account_id: "100000001",
    display_name: "example-store",
  }]);
  assert.equal(bridge.requests.includes("/api/v2/login/"), true);
  assert.equal(bridge.miniChatClicks, 0);
});

test("detects only the current login shop, ignoring shop-list and conversation catalogues", async () => {
  const bridge = createBridge();
  await bridge.fetch("/webchat/api/v1.2/shop_list", {
    shops: [{ id: 100000001 }, { id: 39233325 }],
  });
  await bridge.fetch("/webchat/api/v1.2/subaccount/serving_mode/conversations", {
    conversations: [{ id: "old", shop_id: 39233325 }],
  });
  const detection = await bridge.detect();
  assert.deepEqual(Array.from(detection.accounts, (account) => account.provider_account_id), ["100000001"]);
  assert.equal(bridge.requests.filter((path) => path === "/webchat/api/v1.2/shop_list").length, 1);
});

test("login switch clears stale templates and recovery, then detects the new shop", async () => {
  const bridge = createBridge();
  await bridge.detect();
  await bridge.fetch("/webchat/api/v1.2/conversations", []);
  bridge.seedRecoveryState();
  await bridge.fetch("/webchat/api/coreapi/v1.2/login", { shop: { id: 39233325, name: "new-shop" } });
  const state = bridge.state;
  assert.equal(state.currentAccountId, "39233325");
  assert.equal(state.listTemplate, null);
  assert.equal(state.getTemplate, null);
  assert.equal(state.recoveryInFlight, false);
  const detection = await bridge.detect("new-session");
  assert.deepEqual(Array.from(detection.accounts, (account) => account.provider_account_id), ["39233325"]);
  const status = bridge.posts.findLast((post) => post.type === "provider_status");
  assert.equal(status.current_provider_account_id, "39233325");
  assert.equal(status.surface_ready, false);
});

test("limits recovery to the requested Shop ID", async () => {
  const bridge = createBridge();
  await bridge.fetch("/webchat/api/v1.2/subaccount/serving_mode/conversations", {
    conversations: [
      { id: "conversation-my", shop_id: 1698999861, last_message_time: "2026-08-16T10:00:00.000Z" },
      { id: "conversation-th", shop_id: 100000001, last_message_time: "2026-08-16T11:00:00.000Z" },
    ],
  });
  await bridge.fetch("/webchat/api/v1.2/conversations/conversation-th/messages", []);

  const complete = await bridge.sync("100000001");
  const plan = bridge.posts.findLast((post) => post.type === "sync_plan");
  assert.equal(complete.ok, true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(plan.conversations.map((conversation) => conversation.conversation_id))),
    ["conversation-th"],
  );
});

test("Shopee history_days loads a configured conversation older than the checkpoint", async () => {
  const conversationId = "580433e9-90f9-49cb-a68d-e9f16f7e0a88";
  const sinceMs = Date.parse("2026-08-25T00:00:00.000Z");
  const bridge = createBridge();
  bridge.advanceClock(40 * 86400_000);
  await bridge.fetch("/webchat/api/v1.2/conversations", [{
    id: conversationId,
    shop_id: 100000001,
    last_message_time: "2026-08-28T00:00:00.000Z",
    latest_message_id: "august-message",
  }]);
  bridge.setResponse(`/webchat/api/v1.2/conversations/${conversationId}/messages`, [
    {
      id: "august-message",
      conversation_id: conversationId,
      shop_id: 100000001,
      from_id: "buyer-1",
      to_id: "shop-1",
      to_shop_id: 100000001,
      type: "text",
      content: { text: "since 25 August" },
      created_timestamp: Date.parse("2026-08-26T00:00:00.000Z") / 1000,
    },
    {
      id: "too-old",
      conversation_id: conversationId,
      shop_id: 100000001,
      from_id: "buyer-1",
      to_id: "shop-1",
      to_shop_id: 100000001,
      type: "text",
      content: { text: "before the window" },
      created_timestamp: Date.parse("2026-08-20T00:00:00.000Z") / 1000,
    },
  ]);
  const store = { messages: [], conversations: {}, watermark: null };
  const complete = await bridge.sync("100000001", "history", {
    watermark: "2026-09-20T00:00:00.000Z",
    history_days: 35,
    history_since_ms: sinceMs,
    history_conversation_ids: [conversationId],
  }, store);

  assert.equal(complete.ok, true);
  assert.deepEqual(store.messages.map((message) => message.id), ["august-message"]);
  assert.equal(
    bridge.posts.some((post) => post.type === "history_backfill"
      && post.conversation_id === conversationId
      && post.history_days === 35),
    true,
  );
});

test("Shopee history_days without conversation ids loads every conversation in the window", async () => {
  const sinceMs = Date.parse("2026-08-25T00:00:00.000Z");
  const insideId = "inside-window";
  const outsideId = "outside-window";
  const message = (id, conversationId, timestamp) => ({
    id,
    conversation_id: conversationId,
    shop_id: 100000001,
    from_id: "buyer-1",
    to_id: "shop-1",
    to_shop_id: 100000001,
    type: "text",
    content: { text: id },
    created_timestamp: Date.parse(timestamp) / 1000,
  });
  const bridge = createBridge();
  bridge.advanceClock(40 * 86400_000);
  await bridge.fetch("/webchat/api/v1.2/conversations", [
    {
      id: insideId,
      shop_id: 100000001,
      last_message_time: "2026-08-28T00:00:00.000Z",
      latest_message_id: "inside-message",
    },
    {
      id: "inside-older",
      shop_id: 100000001,
      last_message_time: "2026-08-26T00:00:00.000Z",
      latest_message_id: "inside-older-message",
    },
    {
      id: outsideId,
      shop_id: 100000001,
      last_message_time: "2026-08-01T00:00:00.000Z",
      latest_message_id: "outside-message",
    },
  ]);
  bridge.setResponse(`/webchat/api/v1.2/conversations/${insideId}/messages`, [
    message("inside-message", insideId, "2026-08-26T00:00:00.000Z"),
    message("inside-too-old", insideId, "2026-08-20T00:00:00.000Z"),
  ]);
  bridge.setResponse("/webchat/api/v1.2/conversations/inside-older/messages", [
    message("inside-older-message", "inside-older", "2026-08-26T00:00:00.000Z"),
  ]);
  const store = { messages: [], conversations: {}, watermark: null };
  const complete = await bridge.sync("100000001", "history-window", {
    watermark: "2026-09-20T00:00:00.000Z",
    history_days: 35,
    history_since_ms: sinceMs,
  }, store);

  assert.equal(complete.ok, true);
  assert.deepEqual(store.messages.map((item) => item.id), ["inside-message", "inside-older-message"]);
  assert.equal(
    bridge.requests.includes("/webchat/api/v1.2/conversations/inside-older/messages"),
    true,
  );
  assert.equal(
    bridge.requests.includes(`/webchat/api/v1.2/conversations/${outsideId}/messages`),
    false,
  );
  assert.equal(
    bridge.posts.some((post) => post.type === "history_window" && post.history_days === 35),
    true,
  );
});

test("Shopee recovery persists a cursor, skips unchanged history, and catches a same-time message", async () => {
  let timestamp = "2026-08-20T10:00:00.000Z";
  const listPath = "/webchat/api/v1.2/conversations";
  const historyPath = "/webchat/api/v1.2/conversations/unchanged/messages";
  const conversation = (messageId) => ({
    id: "unchanged", shop_id: 100000001, last_message_time: timestamp,
    latest_message_id: messageId,
  });
  const message = (id) => ({
    id, conversation_id: "unchanged", shop_id: 100000001,
    from_id: "buyer-1", to_id: "shop-1", to_shop_id: 100000001,
    type: "text", content: { text: id }, created_timestamp: Date.parse(timestamp) / 1000,
  });
  const store = { messages: [], conversations: {}, watermark: null };
  const firstBridge = createBridge();
  await firstBridge.fetch(listPath, [conversation("message-1")]);
  firstBridge.setResponse(historyPath, [message("message-1")]);
  const checkpoint = {
    watermark: "2026-08-01T00:00:00.000Z",
    conversations: store.conversations,
  };
  const first = await firstBridge.sync("100000001", "first", checkpoint, store);
  assert.equal(first.ok, true);
  assert.equal(store.messages.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(store.conversations.unchanged)), {
    event_timestamp: timestamp, message_id: "message-1",
  });

  const repeatBridge = createBridge();
  await repeatBridge.fetch(listPath, [conversation("message-1")]);
  const second = await repeatBridge.sync("100000001", "second", store, store);
  assert.equal(second.ok, true);
  assert.equal(repeatBridge.requests.includes(historyPath), false);
  assert.equal(store.messages.length, 1);

  // Provider timestamps are second-granular; keep the boundary exact and
  // ensure a replacement fixture's clock cannot move behind the prior scan.
  store.watermark = new Date(Math.floor(Date.parse(store.watermark) / 1000) * 1000).toISOString();
  timestamp = store.watermark;
  const changedBridge = createBridge();
  changedBridge.advanceClock(1000);
  await changedBridge.fetch(listPath, [conversation("message-2")]);
  changedBridge.setResponse(historyPath, [message("message-2"), message("message-1")]);
  const changed = await changedBridge.sync("100000001", "changed", store, store);
  assert.equal(changed.ok, true);
  assert.equal(changedBridge.requests.includes(historyPath), true);
  assert.equal(store.messages.some((item) => item.id === "message-2"), true);
  assert.equal(store.conversations.unchanged.message_id, "message-2");
});

test("Shopee recovery retries when message persistence fails", async () => {
  const timestamp = "2026-08-20T10:00:00.000Z";
  const bridge = createBridge();
  await bridge.fetch("/webchat/api/v1.2/conversations", [{
    id: "retry", shop_id: 100000001, last_message_time: timestamp,
    latest_message_id: "message-1",
  }]);
  bridge.setResponse("/webchat/api/v1.2/conversations/retry/messages", [{
    id: "message-1", conversation_id: "retry", shop_id: 100000001,
    from_id: "buyer-1", to_id: "shop-1", to_shop_id: 100000001,
    type: "text", content: { text: "Hello" }, created_timestamp: Date.parse(timestamp) / 1000,
  }]);
  const store = { messages: [], conversations: {}, watermark: null, failNextBatch: true };
  const checkpoint = { watermark: "2026-08-01T00:00:00.000Z", conversations: store.conversations };
  const failed = await bridge.sync("100000001", "failed", checkpoint, store);
  assert.equal(failed.ok, false);
  assert.equal(store.messages.length, 0);
  assert.equal(store.conversations.retry, undefined);
  assert.equal(store.watermark, null);

  const retried = await bridge.sync("100000001", "retried", checkpoint, store);
  assert.equal(retried.ok, true);
  assert.equal(store.messages.length, 1);
  assert.equal(store.conversations.retry.message_id, "message-1");
});

test("Shopee sync checks a different message ID at the same timestamp", async () => {
  const bridge = createBridge();
  const timestamp = "2026-08-20T10:00:00.000Z";
  await bridge.fetch("/webchat/api/v1.2/conversations", [{
    id: "changed", shop_id: 100000001, last_message_time: timestamp,
    latest_message_id: "message-2",
  }]);
  bridge.setResponse("/webchat/api/v1.2/conversations/changed/messages", [{
    ...retryMessage("message-2", 0), conversation_id: "changed", created_timestamp: Date.parse(timestamp) / 1000,
  }]);

  const result = await bridge.sync("100000001", "changed-sync", {
    watermark: "2026-08-01T00:00:00.000Z",
    conversations: { changed: { event_timestamp: timestamp, message_id: "message-1" } },
  });

  assert.equal(result.ok, true);
  assert.equal(bridge.requests.includes("/webchat/api/v1.2/conversations/changed/messages"), true);
  assert.equal(bridge.posts.findLast((post) => post.type === "sync_plan")?.conversations[0].reason, "same_timestamp_new_message");
});

test("Shopee sync keeps the legacy nested last-message ID as a skip signal", async () => {
  const bridge = createBridge();
  const timestamp = "2026-08-20T10:00:00.000Z";
  await bridge.fetch("/webchat/api/v1.2/conversations", [{
    id: "nested", shop_id: 100000001, last_message_time: timestamp,
    last_message: { id: "message-1" },
  }]);

  const result = await bridge.sync("100000001", "nested-sync", {
    watermark: "2026-08-01T00:00:00.000Z",
    conversations: { nested: { event_timestamp: timestamp, message_id: "message-1" } },
  });

  assert.equal(result.ok, true);
  assert.equal(bridge.requests.includes("/webchat/api/v1.2/conversations/nested/messages"), false);
  assert.equal(bridge.posts.findLast((post) => post.type === "sync_plan")?.conversations[0].reason, "same_cursor_message");
});

test("Shopee sync probes a summary with no reliable message ID", async () => {
  const bridge = createBridge();
  const timestamp = "2026-08-20T10:00:00.000Z";
  await bridge.fetch("/webchat/api/v1.2/conversations", [{
    id: "ambiguous", shop_id: 100000001, last_message_time: timestamp,
  }]);
  bridge.setResponse("/webchat/api/v1.2/conversations/ambiguous/messages", []);

  const result = await bridge.sync("100000001", "ambiguous-sync", {
    watermark: "2026-08-01T00:00:00.000Z",
    conversations: { ambiguous: { event_timestamp: timestamp, message_id: "message-1" } },
  });

  assert.equal(result.ok, true);
  assert.equal(bridge.requests.includes("/webchat/api/v1.2/conversations/ambiguous/messages"), true);
  assert.equal(bridge.posts.findLast((post) => post.type === "sync_plan")?.conversations[0].reason, "same_timestamp_unknown_message");
});

test("Shopee sync probes a summary with no usable timestamp", async () => {
  const bridge = createBridge();
  await bridge.fetch("/webchat/api/v1.2/conversations", [{
    id: "no-time", shop_id: 100000001, latest_message_id: "message-1",
  }]);
  bridge.setResponse("/webchat/api/v1.2/conversations/no-time/messages", [{
    ...retryMessage("message-1", 0), conversation_id: "no-time", created_timestamp: Date.parse("2026-08-20T10:00:00Z") / 1000,
  }]);

  const result = await bridge.sync("100000001", "no-time-sync", {
    watermark: "2026-08-01T00:00:00.000Z",
    conversations: { "no-time": { event_timestamp: "2026-08-20T10:00:00.000Z", message_id: "message-1" } },
  });

  assert.equal(result.ok, true);
  assert.equal(bridge.requests.includes("/webchat/api/v1.2/conversations/no-time/messages"), true);
  assert.equal(bridge.posts.findLast((post) => post.type === "sync_plan")?.conversations[0].reason, "missing_summary_time");
});

test("recovers Seller Centre history through the mini conversation route", async () => {
  const bridge = createBridge({ pathname: "/portal/chat-management", miniChatOpen: false });
  await bridge.fetch("/webchat/api/v1.2/mini/user/setting", {});
  await bridge.fetch("/webchat/api/v1.2/mini/conversations", [{
    id: "seller-centre-recovery",
    shop_id: 100000001,
    to_id: 987654321,
    last_message_time: "2026-08-20T10:00:00.000Z",
    latest_message_id: "seller-recovery-message",
    biz_id: 0,
  }]);
  await bridge.fetch("/webchat/api/v1.2/mini/conversations/seller-centre-recovery/messages", [{
    id: "seller-recovery-message", conversation_id: "seller-centre-recovery",
    shop_id: 100000001, from_id: 987654321, to_id: 100000001,
    type: "text", content: { text: "Recovered" }, created_timestamp: Date.parse("2026-08-20T10:00:00Z") / 1000,
  }]);

  const complete = await bridge.sync("100000001");
  assert.equal(complete.ok, true);
  assert.equal(bridge.miniChatClicks, 1);
  assert.equal(bridge.miniChatIsOpen, true);
  assert.equal(bridge.requests.includes("/webchat/api/v1.2/mini/conversations/seller-centre-recovery/messages"), true);
  assert.equal(bridge.requests.some((path) => path.includes("/webchat/api/v1.2/conversations/")), false);
});

const retryListPath = "/webchat/api/v1.2/mini/conversations";
const retryHistoryPath = `${retryListPath}/retry-conversation/messages`;
const retryConversation = (latestId) => ({
  id: "retry-conversation", shop_id: 100000001, to_id: 987654321,
  to_name: "Synthetic buyer", latest_message_id: latestId,
  last_message_time: "2026-10-06T10:01:00Z", biz_id: 0,
});
const retryMessage = (id, seconds) => ({
  id, conversation_id: "retry-conversation", from_id: 987654321,
  to_id: 100000001, shop_id: 100000001, type: "text",
  content: { text: id }, created_timestamp: 1791280800 + seconds,
});
async function pollingRetryBridge() {
  const bridge = createBridge({ pathname: "/portal/chat-management", captureIntervals: true });
  await bridge.fetch("/webchat/api/v1.2/mini/user/setting", {});
  await bridge.fetch(retryListPath, [retryConversation("m1")]);
  return bridge;
}
function capturedRetryIds(bridge) {
  return bridge.posts.filter((post) => post.type === "recovery_batch" && post.request_id.startsWith("poll:"))
    .flatMap((post) => Array.from(post.body, (message) => message.id));
}

test("Seller Centre initial list leaves history ownership with recovery", async () => {
  const bridge = await pollingRetryBridge();
  assert.equal(Object.keys(bridge.checkpoint().conversations ?? {}).length, 0);
  assert.equal(bridge.requests.includes(retryHistoryPath), false);
  assert.deepEqual(capturedRetryIds(bridge), []);
});

for (const subaccount of [false, true]) {
  test(`recovers closed conversations across POST pages in ${subaccount ? "subaccount" : "normal"} mini-chat, restricted to the active shop`, async () => {
    const bridge = createBridge({ pathname: "/portal", miniChatOpen: true });
    await bridge.detect();
    const path = subaccount
      ? "/webchat/api/v1.2/mini/subaccount/serving_mode/conversations"
      : "/webchat/api/v1.2/mini/conversations";
    const cursor = "1790138871629724048";
    const conversation = (id, shopId, next) => ({
      id, shop_id: shopId, status: 2, to_id: 987654321,
      last_message_time: "2026-08-20T10:00:00.000Z",
      latest_message_id: `${id}-message`, next_timestamp_nano: next,
    });
    const wrap = (items) => subaccount ? { conversations: items, attributions: {}, ShopIds: [] } : items;
    const first = wrap([conversation("other-shop", 200000002, cursor)]);
    const payload = { next_timestamp_nano: "0", direction: "older", biz_id: 0, on_message_received: false };
    await bridge.fetch(path, first, payload);
    await bridge.fetch("/webchat/api/v1.2/mini/conversations/active-shop/messages", [{
      ...retryMessage("active-shop-message", 0), conversation_id: "active-shop",
      created_timestamp: Date.parse("2026-08-20T10:00:00Z") / 1000,
    }]);
    const replayBodies = [];
    bridge.setResponse(path, async (request) => {
      assert.equal(request.method, "POST");
      const body = await request.clone().json();
      replayBodies.push(body);
      return new Response(JSON.stringify(body.next_timestamp_nano === "0"
        ? first : wrap([conversation("active-shop", 100000001, "")])), { status: 200 });
    });
    const complete = await bridge.sync("100000001");
    assert.equal(complete.ok, true);
    assert.equal(replayBodies.length, 2);
    assert.deepEqual(replayBodies[0], payload);
    assert.deepEqual(replayBodies[1], { ...payload, next_timestamp_nano: cursor });
    assert.ok(bridge.requests.includes("/webchat/api/v1.2/mini/conversations/active-shop/messages"));
    assert.equal(bridge.requests.includes("/webchat/api/v1.2/mini/conversations/other-shop/messages"), false);
  });
}

for (const hangBody of [false, true]) {
  test(`initial recovery bounds a hung ${hangBody ? "body" : "request"} and a fresh attempt succeeds`, async () => {
    const bridge = createBridge({ pathname: "/portal/chat-management", requestTimeoutMs: 20 });
    await bridge.fetch("/webchat/api/v1.2/mini/user/setting", {});
    await bridge.fetch(retryListPath, []);
    bridge.setResponse(retryListPath, () => hangBody
      ? { ok: true, json: () => new Promise(() => {}) }
      : new Promise(() => {}));
    const failed = await bridge.sync("100000001", "hung-initial");
    assert.equal(failed.ok, false);
    assert.match(failed.error, /timed out/);
    assert.equal(failed.reason_code, "provider_timeout");
    assert.equal(failed.diagnostics.timed_out, true);
    assert.equal(failed.diagnostics.error_name, "TimeoutError");
    assert.equal(bridge.state.recoveryInFlight, false);
    bridge.setResponse(retryListPath, []);
    const retried = await bridge.sync("100000001", "fresh-initial");
    assert.equal(retried.ok, true);
  });
}

test("default recovery with no conversation cursor stops at the saved checkpoint", async () => {
  const bridge = createBridge();
  const listPath = "/webchat/api/v1.2/conversations";
  const conversation = { id: "missing-cursor", shop_id: 100000001, last_message_time: "2026-08-20T11:00:00Z" };
  await bridge.fetch(listPath, [conversation]);
  bridge.setResponse(`${listPath}/${conversation.id}/messages`, [
    { ...retryMessage("ancient", 0), conversation_id: conversation.id, created_timestamp: Date.parse("2021-01-01T00:00:00Z") / 1000 },
    { ...retryMessage("outside-window", 0), conversation_id: conversation.id, created_timestamp: Date.parse("2026-08-14T12:00:00Z") / 1000 },
    { ...retryMessage("inside-window", 0), conversation_id: conversation.id, created_timestamp: Date.parse("2026-08-16T12:00:00Z") / 1000 },
    { ...retryMessage("recent", 0), conversation_id: conversation.id, created_timestamp: Date.parse("2026-08-20T11:00:00Z") / 1000 },
  ]);
  const complete = await bridge.sync("100000001");
  assert.equal(complete.ok, true);
  const messages = bridge.posts.filter(post => post.type === "recovery_batch").flatMap(post => Array.from(post.body));
  assert.deepEqual(messages.map(message => message.id), ["recent", "inside-window", "outside-window"]);
});

test("initial Shopee sync uses one day while reconnect resumes its saved checkpoint", async () => {
  const listPath = "/webchat/api/v1.2/conversations";
  const historyPath = `${listPath}/initial-window/messages`;
  const conversation = { id: "initial-window", shop_id: 100000001, last_message_time: "2026-08-20T11:00:00Z" };
  const messages = [
    { ...retryMessage("two-days-old", 0), conversation_id: conversation.id, created_timestamp: Date.parse("2026-08-18T12:00:00Z") / 1000 },
    { ...retryMessage("today", 0), conversation_id: conversation.id, created_timestamp: Date.parse("2026-08-20T11:00:00Z") / 1000 },
  ];
  const recovered = async (checkpoint) => {
    const bridge = createBridge();
    await bridge.fetch(listPath, [conversation]);
    bridge.setResponse(historyPath, messages);
    const complete = await bridge.sync("100000001", "window-test", checkpoint);
    assert.equal(complete.ok, true);
    return bridge.posts.filter(post => post.type === "recovery_batch")
      .flatMap(post => Array.from(post.body, message => message.id));
  };
  assert.deepEqual(await recovered({}), ["today"]);
  assert.deepEqual(await recovered({ watermark: "2026-08-01T00:00:00Z" }), ["today", "two-days-old"]);
});

test("redirected Webchat discovers its shop, captures routing, and observes the standalone socket", async () => {
  const handlers = new Map();
  const bridge = createBridge({ pathname: "/webchat/conversations", socket: { connected: true, on: (event, handler) => handlers.set(event, handler), off: () => {} } });
  try {
    await bridge.fetch("/webchat/api/coreapi/v1.2/login", { shop: { id: 100000001, name: "Fixture Shop" } });
    assert.equal(bridge.state.surface, "webchat");
    assert.equal(bridge.posts.findLast(post => post.type === "accounts_detected").accounts[0].provider_account_id, "100000001");
    await bridge.fetch("/webchat/api/v1.2/conversations", { conversations: [{ id: "456", shop_id: 100000001, to_id: 123, to_shop_id: 789, biz_id: 0 }] });
    const profile = bridge.posts.findLast(post => post.type === "profiles_detected").profiles[0];
    assert.deepEqual(JSON.parse(JSON.stringify(profile.omnichat.routing.fields)), { to_id: "123", to_shop_id: "789", biz_id: "0" });
    assert.equal(typeof handlers.get("message"), "function");
    handlers.get("message")({ message_type: "message", message_content: JSON.stringify({ id: "incoming-1", conversation_id: "456", shop_id: 100000001, created_timestamp: Date.parse("2026-08-20T12:00:00Z"), content: { text: "Fixture inbound" } }) });
    const inbound = bridge.posts.findLast(post => post.type === "realtime_event");
    assert.equal(inbound.capture_method, "realtime_socket");
    assert.equal(inbound.body.messages[0].id, "incoming-1");
  } finally { bridge.dispose(); }
});

test("Shopee provider checks replace socket listeners without a recurring observer", async () => {
  const makeSocket = () => ({ connected: true, handlers: new Map(),
    on(event, handler) { this.handlers.set(event, handler); },
    off(event) { this.handlers.delete(event); } });
  const first = makeSocket();
  const bridge = createBridge({ socket: first, captureIntervals: true });
  try {
    assert.equal(bridge.intervals.some(item => item.delay === 2_000), false);
    await new Promise(resolve => setImmediate(resolve));
    const staleDisconnect = first.handlers.get("disconnect");
    const second = makeSocket();
    bridge.setSocket(second);
    const status = bridge.checkStatus("fresh-1");
    assert.equal(status.realtime_connected, true);
    assert.ok(status.last_provider_check_at);
    assert.equal(first.handlers.size, 0);
    assert.equal(second.handlers.size, 3);
    const count = bridge.posts.length;
    staleDisconnect();
    assert.equal(bridge.posts.length, count);
    second.connected = false;
    second.handlers.get("disconnect")();
    assert.equal(bridge.posts.at(-1).realtime_connected, false);
    bridge.setSocket(null);
    assert.equal(bridge.checkStatus("fresh-2").realtime_connected, false);
    assert.equal(second.handlers.size, 0);
    assert.equal(bridge.state.socket, null);
  } finally { bridge.dispose(); }
});

for (const offlineDays of [8, 30]) {
  test(`Shopee recovers since checkpoint after ${offlineDays} days offline`, async () => {
    const bridge = createBridge();
    const now = Date.parse("2026-08-20T12:00:00Z");
    const checkpoint = new Date(now - offlineDays * 86400_000).toISOString();
    const timestamp = now - (offlineDays - 1) * 86400_000;
    const conversation = { id: "offline", shop_id: 100000001, last_message_time: new Date(timestamp).toISOString() };
    await bridge.fetch("/webchat/api/v1.2/conversations", [conversation]);
    bridge.setResponse("/webchat/api/v1.2/conversations/offline/messages", [
      { ...retryMessage("offline-message", 0), conversation_id: "offline", created_timestamp: timestamp / 1000 },
      { ...retryMessage("before-checkpoint", 0), conversation_id: "offline", created_timestamp: (Date.parse(checkpoint) - 1) / 1000 },
    ]);
    const complete = await bridge.sync("100000001", `offline-${offlineDays}`, { watermark: checkpoint });
    assert.equal(complete.ok, true);
    assert.deepEqual(bridge.posts.filter(post => post.type === "recovery_batch").flatMap(post => Array.from(post.body, item => item.id)), ["offline-message"]);
    bridge.dispose();
  });
}

test("Shopee does not advance a conversation cursor after a later history page fails", async () => {
  const bridge = createBridge();
  const listPath = "/webchat/api/v1.2/conversations";
  const historyPath = `${listPath}/interrupted/messages`;
  const timestamp = Date.parse("2026-08-20T10:00:00Z");
  await bridge.fetch(listPath, [{ id: "interrupted", shop_id: 100000001, last_message_time: new Date(timestamp).toISOString() }]);
  const message = (id, time) => ({ ...retryMessage(id, 0), conversation_id: "interrupted", created_timestamp: time / 1000 });
  const newest = Array.from({ length: 100 }, (_, index) => message(`new-${index}`, timestamp - index * 1000));
  const older = message("older-unprocessed", timestamp - 101000);
  let fail = true;
  bridge.setResponse(historyPath, request => {
    const offset = Number(new URL(request.url).searchParams.get("offset"));
    return new Response(JSON.stringify(offset === 0 ? newest : fail ? { error: "unavailable" } : [older]));
  });
  const store = { messages: [], conversations: {}, watermark: "2026-08-01T00:00:00Z" };
  const checkpoint = { watermark: store.watermark, conversations: store.conversations };
  const failed = await bridge.sync("100000001", "failed-later-page", checkpoint, store);
  assert.equal(failed.ok, false);
  assert.equal(failed.reason_code, "invalid_message_history");
  assert.equal(store.conversations.interrupted, undefined);
  assert.equal(store.watermark, checkpoint.watermark);
  fail = false;
  const recovered = await bridge.sync("100000001", "restart-later-page", checkpoint, store);
  assert.equal(recovered.ok, true);
  assert.equal(store.messages.some(item => item.id === "older-unprocessed"), true);
  assert.ok(store.conversations.interrupted);
  bridge.dispose();
});

test("Shopee rejects malformed conversation lists without advancing recovery", async () => {
  const bridge = createBridge();
  await bridge.fetch("/webchat/api/v1.2/conversations", []);
  bridge.setResponse("/webchat/api/v1.2/conversations", { error: "unavailable" });
  const complete = await bridge.sync("100000001", "invalid-list");
  assert.equal(complete.ok, false);
  assert.equal(complete.reason_code, "invalid_conversation_list");
  assert.equal(bridge.posts.some(post => post.type === "recovery_cursor"), false);
  bridge.dispose();
});

test("Shopee recovery reports fetched conversation pages and actual message work", async () => {
  const bridge = createBridge();
  try {
    await bridge.fetch("/webchat/api/v1.2/conversations", [{ id: "progress-conversation", shop_id: 100000001,
      last_message_time: "2026-08-16T11:00:00.000Z" }]);
    await bridge.fetch("/webchat/api/v1.2/conversations/progress-conversation/messages", []);
    const complete = await bridge.sync("100000001", "visible-progress");
    assert.equal(complete.ok, true);
    const phases = bridge.posts.filter(post => post.type === "recovery_phase" && post.request_id === "visible-progress");
    assert.equal(phases[0].phase, "loading_conversations");
    assert.equal(phases[0].conversation_pages, 0);
    assert.equal(phases[1].phase, "checking_conversations");
    assert.equal(phases[1].conversation_pages, 1);
    assert.ok(phases.some(post => post.phase === "fetching_messages" && post.conversation_id === "progress-conversation"));
    assert.equal(phases.at(-1).phase, "conversation_complete");
    assert.equal(phases.at(-1).completed_conversations, 1);
  } finally { bridge.dispose(); }
});

test("Shopee bootstrap caps a busy conversation at twenty-five messages", async () => {
  const bridge = createBridge();
  const path = "/webchat/api/v1.2/conversations";
  const messages = Array.from({ length: 40 }, (_, index) => ({
    id: `bootstrap-${index}`, conversation_id: "bootstrap-full", shop_id: 100000001,
    from_id: 987654321, to_id: 100000001, type: "text", content: { text: "Fixture" },
    created_timestamp: Date.parse("2026-08-20T11:00:00Z") / 1000 + index,
  }));
  await bridge.fetch(path, [{ id: "bootstrap-full", shop_id: 100000001,
    last_message_time: "2026-08-20T11:00:39Z", latest_message_id: "bootstrap-39" }]);
  bridge.setResponse(`${path}/bootstrap-full/messages`, messages);
  const store = { messages: [], conversations: {} };
  const result = await bridge.sync("100000001", "bootstrap-full", {}, store);
  assert.equal(result.ok, true);
  assert.equal(store.messages.length, 25);
  assert.equal(store.conversations["bootstrap-full"].event_timestamp, "2026-08-20T11:00:39.000Z");
  bridge.dispose();
});

test("Shopee recovery does not advance checkpoints before history reaches its summary", async () => {
  const bridge = createBridge();
  const path = "/webchat/api/v1.2/conversations";
  await bridge.fetch(path, [{ id: "not-ready", shop_id: 100000001,
    last_message_time: "2026-08-20T11:00:00Z", latest_message_id: "missing-latest" }]);
  bridge.setResponse(`${path}/not-ready/messages`, []);
  const result = await bridge.sync("100000001", "not-ready", {});
  assert.equal(result.ok, false);
  assert.equal(result.reason_code, "invalid_message_history");
  assert.equal(result.diagnostics.stage, "history_completeness");
  assert.equal(result.diagnostics.conversation_id, "not-ready");
  assert.equal(result.diagnostics.expected_latest_message_id, "missing-latest");
  assert.equal(result.diagnostics.page_index, 0);
  assert.equal(result.diagnostics.page_count, 0);
  assert.equal(bridge.posts.some((post) => post.type === "recovery_cursor"), false);
  bridge.dispose();
});

test("combined Shopee metadata uses one list pass without widening bootstrap chat limits", async () => {
  const bridge = createBridge();
  const path = "/webchat/api/v1.2/conversations";
  const items = Array.from({ length: 105 }, (_, i) => ({ id: `combined-${i}`, shop_id: 100000001,
    to_id: `customer-${i}`, to_name: `Customer ${i}`, last_message_time: "2026-08-20T11:00:00Z" }));
  await bridge.fetch(path, items);
  for (const item of items) bridge.setResponse(`${path}/${item.id}/messages`, []);
  const before = bridge.requests.length;
  const result = await bridge.sync("100000001", "combined", { refresh_metadata: true });
  assert.equal(result.ok, true);
  assert.equal(result.metadata.ok, true);
  assert.equal(result.metadata.profiles.length, 100);
  assert.equal(result.metadata.partial, true);
  assert.equal(result.metadata.account.provider_account_id, "100000001");
  const requests = bridge.requests.slice(before);
  assert.equal(requests.filter(request => request === path).length, 1);
  assert.equal(requests.filter(request => request.startsWith(path + "/") && request.endsWith("/messages")).length, 10);
  bridge.dispose();
});

test("Shopee recovery traverses later list pages after an old summary and probes unknown latest activity", async () => {
  const bridge = createBridge({ pathname: "/portal", miniChatOpen: true });
  await bridge.detect();
  const path = "/webchat/api/v1.2/mini/conversations";
  const old = { id: "old-first", shop_id: 100000001, to_id: "old-customer", next_timestamp_nano: "next-page", last_message_time: "2020-01-01T00:00:00Z" };
  const unknown = { id: "unknown-later", shop_id: 100000001, to_id: "new-customer", next_timestamp_nano: "0", created_timestamp: 1500000000 };
  await bridge.fetch(path, [old], { next_timestamp_nano: "stale-scroll" });
  await bridge.fetch(`${path}/unknown-later/messages`, []);
  const cursors = [];
  bridge.setResponse(path, async request => {
    const payload = await request.clone().json(); cursors.push(payload.next_timestamp_nano);
    return new Response(JSON.stringify(payload.next_timestamp_nano === "0" ? [old] : [unknown]));
  });
  bridge.setResponse(`${path}/unknown-later/messages`, []);
  const result = await bridge.sync("100000001", "unordered", { watermark: "2026-08-01T00:00:00Z", refresh_metadata: true });
  assert.equal(result.ok, true);
  assert.deepEqual(cursors, ["0", "next-page"]);
  assert.equal(result.metadata.profiles.length, 2);
  assert.ok(bridge.requests.includes(`${path}/unknown-later/messages`));
  assert.equal(bridge.requests.includes(`${path}/old-first/messages`), false);
  bridge.dispose();
});

test("Shopee recovery continues past an early requested-history conversation", async () => {
  const bridge = createBridge();
  const path = "/webchat/api/v1.2/conversations";
  const conversation = (id, next) => ({ id, shop_id: 100000001,
    last_message_time: "2026-08-20T11:00:00Z", next_timestamp_nano: next });
  await bridge.fetch(path, [conversation("deep-first", "second")], { next_timestamp_nano: "0", direction: "older" });
  bridge.setResponse(path, async (request) => new Response(JSON.stringify(
    (await request.json()).next_timestamp_nano === "0"
      ? [conversation("deep-first", "second")] : [conversation("ordinary-later", "0")],
  )));
  bridge.setResponse(`${path}/deep-first/messages`, []);
  bridge.setResponse(`${path}/ordinary-later/messages`, []);
  const result = await bridge.sync("100000001", "deep-and-regular", {
    watermark: "2026-08-19T00:00:00Z", history_days: 3,
    history_since_ms: Date.parse("2026-08-17T00:00:00Z"),
    history_conversation_ids: ["deep-first"],
  });
  assert.equal(result.ok, true);
  assert.ok(bridge.requests.includes(`${path}/ordinary-later/messages`));
  bridge.dispose();
});

test("Shopee repeated list cursor fails recovery rather than advancing its checkpoint", async () => {
  const bridge = createBridge({ pathname: "/portal", miniChatOpen: true });
  await bridge.detect();
  const path = "/webchat/api/v1.2/mini/conversations";
  const item = { id: "cycle", shop_id: 100000001, next_timestamp_nano: "again", last_message_time: "2026-08-20T11:00:00Z" };
  await bridge.fetch(path, [item], { next_timestamp_nano: "0" });
  await bridge.fetch(`${path}/cycle/messages`, []);
  const result = await bridge.sync("100000001", "cyclic", { watermark: "2026-08-01T00:00:00Z", refresh_metadata: true });
  assert.equal(result.ok, false);
  assert.equal(result.reason_code, "invalid_conversation_list");
  assert.equal(bridge.posts.some(post => post.type === "recovery_cursor"), false);
  bridge.dispose();
});

test("Shopee metadata collection stops at thirty seconds without failing message recovery", async () => {
  const bridge = createBridge();
  const path = "/webchat/api/v1.2/conversations";
  const item = { id: "slow-list", shop_id: 100000001, to_id: "customer", last_message_time: "2026-08-20T11:00:00Z" };
  await bridge.fetch(path, [item]);
  bridge.setResponse(path, () => { bridge.advanceClock(31000); return new Response(JSON.stringify([item])); });
  bridge.setResponse(`${path}/slow-list/messages`, []);
  const result = await bridge.sync("100000001", "slow-metadata", { watermark: "2026-08-01T00:00:00Z", refresh_metadata: true });
  assert.equal(result.ok, true);
  assert.equal(result.metadata.profiles.length, 0);
  assert.equal(result.metadata.partial, true);
  assert.ok(bridge.requests.includes(`${path}/slow-list/messages`));
  bridge.dispose();
});

test("Shopee combined sync resets captured GET offset and skips unchanged history", async () => {
  const bridge = createBridge();
  const path = "/webchat/api/v1.2/conversations";
  const item = { id: "unchanged", shop_id: 100000001, to_id: "customer", last_message_time: "2026-08-20T11:00:00Z", latest_message_id: "last" };
  await bridge.fetch(path, [item]);
  bridge.state.listTemplate = { ...bridge.state.listTemplate, url: `https://seller.shopee.co.th${path}?offset=50&limit=25`,
    init: { ...bridge.state.listTemplate.init, method: "GET" }, body: null };
  const offsets = [];
  bridge.setResponse(path, request => { offsets.push(new URL(request.url).searchParams.get("offset")); return new Response(JSON.stringify([item])); });
  const before = bridge.requests.length;
  const result = await bridge.sync("100000001", "get-reset", { watermark: "2026-08-01T00:00:00Z", refresh_metadata: true,
    conversations: { unchanged: { event_timestamp: item.last_message_time, message_id: "last" } } });
  assert.equal(result.ok, true);
  assert.deepEqual(offsets, ["0"]);
  assert.equal(result.metadata.profiles.length, 1);
  assert.equal(bridge.requests.slice(before).some(request => request.endsWith("/messages")), false);
  bridge.dispose();
});

test("new webchat body pagination stops only after a fully old ordered page", async () => {
  const bridge = createBridge();
  try {
    const path = "/webchat/api/v1.2/conversations";
    const row = (id, date, cursor) => ({ id, shop_id: 100000001, pinned: false,
      last_message_time: date, next_timestamp_nano: cursor });
    const pages = [
      [row("new", "2026-08-20T11:00:00Z", "x"), row("old", "2026-07-01T00:00:00Z", "second")],
      [row("older", "2026-06-01T00:00:00Z", "third")],
      [row("oldest", "2026-05-01T00:00:00Z", "0")],
    ];
    await bridge.fetch(path, pages[0], { direction: "older", next_timestamp_nano: "stale-scroll" });
    const cursors = [];
    bridge.setResponse(path, async request => {
      const { next_timestamp_nano: cursor } = await request.clone().json(); cursors.push(cursor);
      return new Response(JSON.stringify(pages[{ 0: 0, second: 1, third: 2 }[cursor]]));
    });
    bridge.setResponse(`${path}/new/messages`, []);
    const result = await bridge.sync("100000001", "ordered-cutoff", { watermark: "2026-08-01T00:00:00Z" });
    assert.equal(result.ok, true);
    assert.deepEqual(cursors, ["0", "second"]);
  } finally { bridge.dispose(); }
});

for (const variant of ["equal", "missing", "pinned", "unknown-pin", "disordered", "metadata", "required"]) {
  test(`Shopee older-list shortcut falls through for ${variant}`, async () => {
    const bridge = createBridge();
    try {
      const path = "/webchat/api/v1.2/conversations";
      const row = (id, date, cursor) => ({ id, shop_id: 100000001, to_id: id, pinned: false,
        last_message_time: date, next_timestamp_nano: cursor });
      const first = row("first", "2026-07-01T00:00:00Z", "second");
      if (variant === "equal") first.last_message_time = "2026-08-01T00:00:00Z";
      if (variant === "missing") delete first.last_message_time;
      if (variant === "pinned") first.pinned = true;
      if (variant === "unknown-pin") delete first.pinned;
      const firstPage = variant === "disordered"
        ? [row("earlier", "2026-06-01T00:00:00Z", "unused"), first] : [first];
      const last = row("last", "2026-05-01T00:00:00Z", "0");
      await bridge.fetch(path, firstPage, { direction: "older", next_timestamp_nano: "0" });
      const cursors = [];
      bridge.setResponse(path, async request => {
        const { next_timestamp_nano: cursor } = await request.clone().json(); cursors.push(cursor);
        return new Response(JSON.stringify(cursor === "0" ? firstPage : [last]));
      });
      for (const id of ["first", "earlier", "last"]) bridge.setResponse(`${path}/${id}/messages`, []);
      const checkpoint = { watermark: "2026-08-01T00:00:00Z",
        ...(variant === "metadata" ? { refresh_metadata: true } : {}),
        ...(variant === "required" ? { history_days: 30, history_since_ms: Date.parse("2026-07-01T00:00:00Z"), history_conversation_ids: ["last"] } : {}) };
      const result = await bridge.sync("100000001", `guard-${variant}`, checkpoint);
      assert.equal(result.ok, true);
      assert.deepEqual(cursors, ["0", "second"]);
      if (variant === "metadata") assert.equal(result.metadata.profiles.length, 2);
    } finally { bridge.dispose(); }
  });
}

test("Shopee cross-page activity disorder disables subsequent checkpoint stops", async () => {
  const bridge = createBridge();
  try {
    const path = "/webchat/api/v1.2/conversations";
    const row = (id, date, cursor) => ({ id, shop_id: 100000001, pinned: false,
      last_message_time: date, next_timestamp_nano: cursor });
    const pages = [
      [row("new", "2026-08-20T11:00:00Z", "unused"), row("old", "2026-05-01T00:00:00Z", "second")],
      [row("out-of-order", "2026-06-01T00:00:00Z", "third")],
      [row("last", "2026-04-01T00:00:00Z", "0")],
    ];
    await bridge.fetch(path, pages[0], { direction: "older", next_timestamp_nano: "0" });
    const cursors = [];
    bridge.setResponse(path, async request => {
      const { next_timestamp_nano: cursor } = await request.clone().json(); cursors.push(cursor);
      return new Response(JSON.stringify(pages[{ 0: 0, second: 1, third: 2 }[cursor]]));
    });
    bridge.setResponse(`${path}/new/messages`, []);
    const result = await bridge.sync("100000001", "cross-page-disorder", { watermark: "2026-08-01T00:00:00Z" });
    assert.equal(result.ok, true);
    assert.deepEqual(cursors, ["0", "second", "third"]);
  } finally { bridge.dispose(); }
});

test("standalone chat discovers its authenticated shop without conversation interception", async () => {
  const bridge = createBridge();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(bridge.state.currentAccountId, "100000001");
  assert.equal(bridge.state.listTemplate, null);
  assert.ok(bridge.requests.includes("/api/v2/login/"));
});

test("manual discovery retries a failed standalone startup check", async () => {
  const bridge = createBridge({ initialResponses: {
    "/api/v2/login/": () => new Response("{}", { status: 503 }),
  } });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(bridge.state.accountDiscoveryPromise, null);
  bridge.setResponse("/api/v2/login/", { data: { shop_id: 100000001 } });
  await bridge.detect();
  assert.equal(bridge.state.currentAccountId, "100000001");
});

test("Shopee recovery finds the summary message after a full page of newer arrivals", async () => {
  const bridge = createBridge();
  try {
    const list = "/webchat/api/v1.2/conversations";
    const timestamp = Date.parse("2026-08-20T11:00:00Z") / 1000;
    const messages = Array.from({ length: 101 }, (_, i) => ({
      ...retryMessage(String(2442444048573022577n + BigInt(i)), 0), conversation_id: "busy",
      created_timestamp: timestamp + i,
    })).reverse();
    await bridge.fetch(list, [{ id: "busy", shop_id: 100000001,
      latest_message_id: "2442444048573022577", last_message_time: new Date(timestamp * 1000).toISOString() }]);
    const offsets = [];
    bridge.setResponse(`${list}/busy/messages`, request => {
      const offset = new URL(request.url).searchParams.get("offset");
      offsets.push(offset);
      return new Response(JSON.stringify(historyPage(messages, offset)));
    });
    const store = { messages: [], conversations: {} };
    const result = await bridge.sync("100000001", "summary-on-second-page", { watermark: "2026-08-19T12:00:00Z" }, store);
    assert.equal(result.ok, true);
    assert.deepEqual(offsets, ["0", "2442444048573022578"]);
    assert.equal(store.messages.length, 101);
    assert.equal(store.conversations.busy.message_id, "2442444048573022677");
  } finally { bridge.dispose(); }
});

test("Shopee withholds the checkpoint when the summary message is missing across all pages", async () => {
  const bridge = createBridge();
  try {
    const list = "/webchat/api/v1.2/conversations";
    await bridge.fetch(list, [{ id: "busy", shop_id: 100000001,
      latest_message_id: "not-visible", last_message_time: "2026-08-20T11:00:00Z" }]);
    const messages = Array.from({ length: 101 }, (_, i) => ({
      ...retryMessage(`visible-${i}`, 0), conversation_id: "busy",
      created_timestamp: Date.parse("2026-08-20T11:00:00Z") / 1000 - i,
    }));
    const offsets = [];
    bridge.setResponse(`${list}/busy/messages`, request => {
      const offset = new URL(request.url).searchParams.get("offset");
      offsets.push(offset);
      return new Response(JSON.stringify(historyPage(messages, offset)));
    });
    const store = { messages: [], conversations: {} };
    const result = await bridge.sync("100000001", "summary-still-missing", { watermark: "2026-08-19T12:00:00Z" }, store);
    assert.equal(result.ok, false);
    assert.deepEqual(offsets, ["0", "visible-99"]);
    assert.equal(store.messages.length, 101);
    assert.equal(store.conversations.busy, undefined);
  } finally { bridge.dispose(); }
});

test("Shopee first sync freezes its 10-chat, 25-message window across retry", async () => {
  const bridge = createBridge();
  const list = "/webchat/api/v1.2/conversations";
  const boundary = Date.parse("2026-08-20T12:00:00Z");
  const chats = Array.from({ length: 12 }, (_, i) => ({
    id: `bounded-${i}`, shop_id: 100000001,
    last_message_time: new Date(boundary - 1000 - i * 1000).toISOString(),
  }));
  const history = chat => Array.from({ length: 30 }, (_, i) => ({
    ...retryMessage(`${chat.id}-${i}`, 0), conversation_id: chat.id,
    created_timestamp: (boundary - 1000 - i * 1000) / 1000,
  }));
  try {
    await bridge.fetch(list, chats);
    for (const chat of chats) bridge.setResponse(`${list}/${chat.id}/messages`, history(chat));
    const store = { messages: [], conversations: {}, failNextBatch: true };
    assert.equal((await bridge.sync("100000001", "bounded-failed", {}, store)).ok, false);
    const frozen = structuredClone(bridge.checkpoint().bootstrap);
    assert.equal(frozen.conversations.length, 10);
    bridge.advanceClock(3 * 86400_000);
    bridge.setResponse(list, [{ id: "new-chat", shop_id: 100000001, last_message_time: "2026-08-23T11:00:00Z" }, ...chats]);
    assert.equal((await bridge.sync("100000001", "bounded-retry", {}, store)).ok, true);
    assert.equal(store.messages.length, 250);
    assert.equal(new Set(store.messages.map(message => message.conversation_id)).size, 10);
    for (const chat of frozen.conversations) {
      assert.equal(store.messages.filter(message => message.conversation_id === chat.id).length, 25);
    }
    assert.equal(bridge.checkpoint().watermark, frozen.started_at);
    assert.equal(bridge.requests.some(path => path.includes("new-chat/messages")), false);
    assert.equal(bridge.requests.some(path => path.includes("bounded-10/messages")), false);
  } finally { bridge.dispose(); }
});

test("Shopee three-day recovery paginates every missing message beyond initial caps", async () => {
  const bridge = createBridge();
  const list = "/webchat/api/v1.2/conversations";
  const since = Date.parse("2026-08-17T12:00:00Z");
  const messages = Array.from({ length: 301 }, (_, i) => ({
    ...retryMessage(`gap-${i}`, 0), conversation_id: "gap",
    created_timestamp: (since + 1000 + i * 1000) / 1000,
  })).reverse();
  const offsets = [];
  try {
    await bridge.fetch(list, [{ id: "gap", shop_id: 100000001, latest_message_id: "gap-300",
      last_message_time: new Date(messages[0].created_timestamp * 1000).toISOString() }]);
    bridge.setResponse(`${list}/gap/messages`, request => {
      const offset = new URL(request.url).searchParams.get("offset");
      offsets.push(offset);
      return new Response(JSON.stringify(historyPage(messages, offset)));
    });
    const store = { messages: [], conversations: {} };
    const result = await bridge.sync("100000001", "three-day-gap", { watermark: new Date(since).toISOString() }, store);
    assert.equal(result.ok, true);
    assert.equal(store.messages.length, 301);
    assert.deepEqual(offsets, ["0", "gap-201", "gap-101", "gap-1"]);
    assert.equal(bridge.posts.some(post => post.type === "recovery_bootstrap"), false);
    assert.equal(bridge.checkpoint().watermark, result.watermark);
  } finally { bridge.dispose(); }
});

test("Shopee routine polling waits for bounded initialization when no watermark exists", async () => {
  const bridge = await pollingRetryBridge();
  try {
    bridge.setCheckpoint({});
    bridge.setResponse(retryListPath, [retryConversation("uninitialized")]);
    bridge.setResponse(retryHistoryPath, [retryMessage("uninitialized", 0)]);
    await bridge.runIntervals();
    assert.equal(bridge.posts.some(post => post.type === "recovery_batch"), false);
    assert.equal(bridge.checkpoint().watermark, undefined);
  } finally { bridge.dispose(); }
});

test("Shopee checkpoint read failure cannot fall back to bootstrap", async () => {
  const bridge = createBridge();
  try {
    await bridge.fetch("/webchat/api/v1.2/conversations", [{ id: "blocked", shop_id: 100000001, last_message_time: "2026-08-20T11:00:00Z" }]);
    bridge.setCheckpointReadAllowed(false);
    const result = await bridge.sync("100000001", "checkpoint-read-failed", {});
    assert.equal(result.ok, false);
    assert.equal(bridge.posts.some(post => ["recovery_batch", "recovery_bootstrap", "recovery_scan_complete"].includes(post.type)), false);
    assert.equal(bridge.checkpoint().watermark, undefined);
  } finally { bridge.dispose(); }
});

test("Shopee completion write failure retains the previous overall checkpoint", async () => {
  const bridge = createBridge();
  const watermark = "2026-08-17T12:00:00Z";
  try {
    await bridge.fetch("/webchat/api/v1.2/conversations", []);
    const result = await bridge.sync("100000001", "completion-write-failed", { watermark },
      { messages: [], conversations: {}, failCompletion: true });
    assert.equal(result.ok, false);
    assert.equal(bridge.checkpoint().watermark, watermark);
  } finally { bridge.dispose(); }
});

test("Shopee next-page fetch failures do not retain the preceding page evidence", async () => {
  const bridge = createBridge();
  const list = "/webchat/api/v1.2/conversations";
  const messages = Array.from({ length: 100 }, (_, i) => ({
    ...retryMessage(`diagnostic-${i}`, 0), conversation_id: "diagnostic-chat",
    created_timestamp: Date.parse("2026-08-20T11:00:00Z") / 1000 + i,
  })).reverse();
  try {
    await bridge.fetch(list, [{ id: "diagnostic-chat", shop_id: 100000001,
      latest_message_id: messages[0].id, last_message_time: "2026-08-20T11:01:39Z" }]);
    bridge.setResponse(`${list}/diagnostic-chat/messages`, request => {
      const offset = new URL(request.url).searchParams.get("offset");
      return offset === "0" ? new Response(JSON.stringify(messages)) : new Response("{}", { status: 500 });
    });
    const result = await bridge.sync("100000001", "page-fetch-failure", { watermark: "2026-08-17T12:00:00Z" });
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics.stage, "history_fetch");
    assert.equal(result.diagnostics.page_index, 1);
    assert.equal(result.diagnostics.page_offset, "diagnostic-0");
    assert.equal(result.diagnostics.page_count, undefined);
    assert.equal(result.diagnostics.first_message_id, undefined);
    assert.equal(result.diagnostics.last_message_id, undefined);
  } finally { bridge.dispose(); }
});

test("Seller Centre page traffic does not create an autonomous sync job", async () => {
  const bridge = await pollingRetryBridge();
  try {
    bridge.setResponse(retryListPath, [retryConversation("new")]);
    bridge.setResponse(retryHistoryPath, [retryMessage("new", 0)]);
    await bridge.runIntervals();
    assert.equal(bridge.intervals.some(item => item.delay === 3_000), false);
    assert.equal(bridge.requests.includes(retryHistoryPath), false);
    assert.equal(bridge.posts.some(post => post.type === "recovery_batch"), false);
  } finally { bridge.dispose(); }
});

test("Seller Centre coordinator retry fetches unchanged summaries from durable checkpoints", async () => {
  const bridge = await pollingRetryBridge();
  try {
    const at = Date.parse("2026-08-20T11:00:00Z");
    const summary = { ...retryConversation("latest"), last_message_time: new Date(at).toISOString() };
    bridge.setResponse(retryListPath, [summary]);
    bridge.setResponse(retryHistoryPath, () => new Response("{}", { status: 503 }));
    const checkpoint = bridge.checkpoint().watermark;
    const failed = await bridge.sync("100000001", "failed-scan");
    assert.equal(failed.ok, false);
    assert.equal(bridge.checkpoint().watermark, checkpoint);
    assert.equal(failed.diagnostics.stage, "history_fetch");
    bridge.setResponse(retryHistoryPath, [{ ...retryMessage("latest", 0), created_timestamp: at / 1000 }]);
    const store = { messages: [], conversations: {} };
    assert.equal((await bridge.sync("100000001", "retry-scan", {}, store)).ok, true);
    assert.deepEqual(store.messages.map(message => message.id), ["latest"]);
    const fetched = bridge.requests.filter(path => path === retryHistoryPath).length;
    assert.equal((await bridge.sync("100000001", "unchanged-scan")).ok, true);
    assert.equal(bridge.requests.filter(path => path === retryHistoryPath).length, fetched);
  } finally { bridge.dispose(); }
});

test("Shopee incremental scan excludes arrivals newer than its frozen start", async () => {
  const bridge = createBridge();
  try {
    const list = "/webchat/api/v1.2/conversations";
    await bridge.fetch(list, [{ id: "frozen", shop_id: 100000001, latest_message_id: "future", last_message_time: "2026-08-20T13:00:00Z" }]);
    bridge.setResponse(`${list}/frozen/messages`, [
      { ...retryMessage("past", 0), conversation_id: "frozen", created_timestamp: Date.parse("2026-08-20T11:00:00Z") / 1000 },
      { ...retryMessage("future", 0), conversation_id: "frozen", created_timestamp: Date.parse("2026-08-20T13:00:00Z") / 1000 },
    ]);
    const store = { messages: [], conversations: {} };
    const result = await bridge.sync("100000001", "frozen-scan", { watermark: "2026-08-19T12:00:00Z" }, store);
    assert.equal(result.ok, true);
    assert.deepEqual(store.messages.map(message => message.id), ["past"]);
    assert.equal(store.conversations.frozen.message_id, "past");
    assert.ok(Date.parse(result.watermark) < Date.parse("2026-08-20T13:00:00Z"));
  } finally { bridge.dispose(); }
});

for (const mode of ['old-first-page', 'overflow', 'equal', 'pinned', 'disordered', 'explicit-sort']) {
  test(`Shopee GET watermark discovery: ${mode}`, async () => {
    const bridge = createBridge();
    try {
      const path = '/webchat/api/v1.2/conversations';
      const row = (id, date) => ({ id, shop_id: 100000001, last_message_time: date });
      const old = row('old', '2026-07-01T00:00:00Z');
      let first = [old];
      if (mode === 'overflow') first = [row('new', '2026-08-20T11:00:00Z')];
      if (mode === 'equal') first = [row('equal', '2026-08-01T00:00:00Z')];
      if (mode === 'pinned') first = [{ ...row('pin', '2026-08-20T11:00:00Z'), pinned: true }, old];
      if (mode === 'disordered') first = [old, row('new', '2026-08-20T11:00:00Z')];
      await bridge.fetch(path, first);
      bridge.state.listTemplate = { ...bridge.state.listTemplate,
        url: `https://seller.shopee.co.th${path}?offset=0&limit=25${mode === 'explicit-sort' ? '&sort=unknown' : ''}`,
        init: { ...bridge.state.listTemplate.init, method: 'GET' }, body: null };
      const offsets = [];
      bridge.setResponse(path, request => {
        const offset = new URL(request.url).searchParams.get('offset'); offsets.push(offset);
        return new Response(JSON.stringify(!new URL(request.url).searchParams.has('cursor')
          ? { conversations: first, next_cursor: 'next' }
          : { conversations: [row('older', '2026-06-01T00:00:00Z')] }));
      });
      for (const id of ['new', 'equal', 'pin']) bridge.setResponse(`${path}/${id}/messages`, []);
      const result = await bridge.sync('100000001', `get-${mode}`, { watermark: '2026-08-01T00:00:00Z' });
      assert.equal(result.ok, true, result.error);
      assert.equal(offsets.length, ['old-first-page', 'pinned'].includes(mode) ? 1 : 2);
    } finally { bridge.dispose(); }
  });
}

test('Shopee changing pagination tokens with repeated data fail without committing scan coverage', async () => {
  const bridge = createBridge();
  try {
    const path = '/webchat/api/v1.2/conversations';
    const item = { id: 'repeated', shop_id: 100000001, last_message_time: '2026-08-20T11:00:00Z' };
    await bridge.fetch(path, [item]);
    let count = 0;
    bridge.setResponse(path, () => new Response(JSON.stringify({ conversations: [item], next_cursor: `token-${++count}` })));
    const checkpoint = { watermark: '2026-08-01T00:00:00Z' };
    const result = await bridge.sync('100000001', 'no-data-progress', checkpoint);
    assert.equal(result.ok, false);
    assert.match(result.error, /no data progress/);
    assert.equal(count, 2);
    assert.equal(bridge.posts.some(item => item.type === 'recovery_scan_complete' && item.request_id.startsWith('no-data-progress')), false);
  } finally { bridge.dispose(); }
});
