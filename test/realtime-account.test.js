import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { latestMessageCursor } from "../extension/lib/sync-state.js";

const source = await readFile(new URL("../extension/shopee-realtime.js", import.meta.url), "utf8");
const urlSource = await readFile(new URL("../extension/lib/shopee-url.js", import.meta.url), "utf8");
const adaptersSource = await readFile(new URL("../extension/lib/provider-adapters.js", import.meta.url), "utf8");
const shopeeAdapterSource = await readFile(new URL("../extension/lib/shopee-adapter.js", import.meta.url), "utf8");
const shopeeParserSource = await readFile(new URL("../extension/lib/shopee.js", import.meta.url), "utf8");
const origin = "https://seller.shopee.co.th";
const parserContext = vm.createContext({ location: { origin }, URL });
vm.runInContext(shopeeParserSource, parserContext);

test("Shopee history window is not capped at the bootstrap conversation limit", () => {
  assert.match(
    source,
    /maxItems: !historyWindow && bootstrap && !pageRequired\.length \? MANUAL_SYNC_MAX_CONVERSATIONS : null/,
  );
  assert.match(source, /\} else if \(!historyWindow && bootstrap\) \{/);
});

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

function createBridge({ pathname = "/webchat/conversations", captureIntervals = false, miniChatOpen = null, initialResponses = {} } = {}) {
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
    },
    __CHAT_GLOBAL__: {},
  };
  const context = vm.createContext({
    window,
    document,
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
    setTimeout,
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
    for (let attempt = 0; attempt < 300; attempt += 1) {
      for (const post of posts) {
        if (![
          "recovery_batch",
          "recovery_bootstrap",
          "recovery_cursor",
          "history_backfill",
          "history_window",
        ].includes(post.type) || acknowledged.has(post.request_id)) continue;
        acknowledged.add(post.request_id);
        const parsed = post.type === "recovery_batch" && recoveryStore
          ? parserContext.OmnichatShopee.parseShopeeMessages(post.body, "history_recovery")
          : [];
        const failed = post.type === "recovery_batch" && recoveryStore?.failNextBatch === true;
        if (failed) recoveryStore.failNextBatch = false;
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
        if (complete.ok && recoveryStore) recoveryStore.watermark = complete.watermark;
        await new Promise((resolve) => setImmediate(resolve));
        return complete;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Recovery did not complete in the test harness.");
  }

  return {
    get state() { return window.__omnichatRealtimeState; },
    fetch,
    setResponse,
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
    get state() { return window.__omnichatRealtimeState; },
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
  const store = { messages: [], conversations: {}, watermark: null };
  const complete = await bridge.sync("100000001", "history-window", {
    watermark: "2026-09-20T00:00:00.000Z",
    history_days: 35,
    history_since_ms: sinceMs,
  }, store);

  assert.equal(complete.ok, true);
  assert.deepEqual(store.messages.map((item) => item.id), ["inside-message"]);
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
  const timestamp = "2026-08-20T10:00:00.000Z";
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

  const changedBridge = createBridge();
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
  bridge.setResponse("/webchat/api/v1.2/conversations/changed/messages", []);

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
  bridge.setResponse("/webchat/api/v1.2/conversations/no-time/messages", []);

  const result = await bridge.sync("100000001", "no-time-sync", {
    watermark: "2026-08-01T00:00:00.000Z",
    conversations: { "no-time": { event_timestamp: "2026-08-20T10:00:00.000Z", message_id: "message-1" } },
  });

  assert.equal(result.ok, true);
  assert.equal(bridge.requests.includes("/webchat/api/v1.2/conversations/no-time/messages"), true);
  assert.equal(bridge.posts.findLast((post) => post.type === "sync_plan")?.conversations[0].reason, "missing_summary_time");
});

test("discovers a Seller Centre shop and polls its mini history without legacy endpoints", async () => {
  const bridge = createBridge({ pathname: "/portal/chat-management", captureIntervals: true });
  const conversation = {
    id: "seller-centre-conversation",
    shop_id: 100000001,
    to_id: 987654321,
    to_name: "Test buyer",
    latest_message_id: "seller-message-1",
    latest_message_type: "text",
    latest_message_content: { text: "First" },
    last_message_time: "2026-08-20T10:00:00.000Z",
    biz_id: 0,
  };
  await bridge.fetch("/webchat/api/v1.2/mini/user/setting", {});
  await bridge.fetch("/webchat/api/v1.2/mini/conversations", [conversation]);
  await bridge.fetch("/webchat/api/workbenchapi/v1.2/mini/shop/setting", { shop_id: 100000001 });

  const detection = await bridge.detect();
  assert.ok(detection);
  assert.deepEqual(
    JSON.parse(JSON.stringify(detection.accounts.map((account) => account.provider_account_id))),
    ["100000001"],
  );

  bridge.setResponse("/webchat/api/v1.2/mini/conversations", [{
    ...conversation,
    latest_message_id: "seller-message-2",
    last_message_time: "2026-08-20T10:01:00.000Z",
  }]);
  bridge.setResponse("/webchat/api/v1.2/mini/conversations/seller-centre-conversation/messages", [{
    id: "seller-message-1",
    conversation_id: "seller-centre-conversation",
    from_id: 987654321,
    to_id: 100000001,
    shop_id: 100000001,
    type: "text",
    content: { text: "First" },
    created_timestamp: 1_724_141_000,
  }, {
    id: "seller-message-2",
    conversation_id: "seller-centre-conversation",
    from_id: 987654321,
    to_id: 100000001,
    shop_id: 100000001,
    type: "text",
    content: { text: "Second" },
    created_timestamp: 1_724_141_060,
  }]);
  await bridge.runIntervals();
  assert.equal(bridge.intervals.filter(({ delay }) => delay === 3_000).length, 1);
  const realtime = bridge.posts.findLast((post) => post.type === "realtime_event");
  assert.equal(realtime.capture_method, "poll");
  assert.deepEqual(
    JSON.parse(JSON.stringify(realtime.body.messages.map((message) => message.id))),
    ["seller-message-2"],
  );
  assert.equal(bridge.requests.includes("/webchat/api/v1.2/conversations"), false);
  assert.equal(bridge.requests.includes("/webchat/api/v1.2/messages"), false);
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
  await bridge.fetch("/webchat/api/v1.2/mini/conversations/seller-centre-recovery/messages", []);

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
  return bridge.posts.filter((post) => post.type === "realtime_event")
    .flatMap((post) => Array.from(post.body.messages, (message) => message.id));
}

test("Seller Centre retries unchanged summaries after repeated history failures and captures intervening messages once", async () => {
  const bridge = await pollingRetryBridge();
  bridge.setResponse(retryListPath, [retryConversation("m2")]);
  bridge.setResponse(retryHistoryPath, () => new Response("{}", { status: 503 }));
  await bridge.runIntervals();
  await bridge.runIntervals();
  assert.equal(bridge.requests.filter((path) => path === retryHistoryPath).length, 2);
  assert.equal(bridge.state.capturedMessageIdsByConversation.get("retry-conversation"), "m1");
  bridge.setResponse(retryListPath, [retryConversation("m3")]);
  bridge.setResponse(retryHistoryPath, [retryMessage("m1", 0), retryMessage("m2", 1), retryMessage("m3", 2)]);
  await bridge.runIntervals();
  assert.deepEqual(capturedRetryIds(bridge), ["m2", "m3"]);
  assert.equal(bridge.state.pendingSellerCentreMessages.size, 0);
  await bridge.runIntervals();
  assert.deepEqual(capturedRetryIds(bridge), ["m2", "m3"]);
});

test("Seller Centre retains pending capture until a history request template is available", async () => {
  const bridge = await pollingRetryBridge();
  const template = bridge.state.getTemplate;
  bridge.state.getTemplate = null;
  bridge.state.historyTemplate = null;
  bridge.setResponse(retryListPath, [retryConversation("m2")]);
  await bridge.runIntervals();
  assert.equal(bridge.state.pendingSellerCentreMessages.size, 1);
  assert.equal(bridge.requests.includes(retryHistoryPath), false);
  bridge.state.getTemplate = template;
  bridge.setResponse(retryHistoryPath, [retryMessage("m1", 0), retryMessage("m2", 1)]);
  await bridge.runIntervals();
  assert.deepEqual(capturedRetryIds(bridge), ["m2"]);
});

test("Seller Centre prevents overlapping history fetches and retains newer summaries", async () => {
  const bridge = await pollingRetryBridge();
  let finish;
  bridge.setResponse(retryHistoryPath, () => new Promise((resolve) => { finish = resolve; }));
  bridge.setResponse(retryListPath, [retryConversation("m2")]);
  await bridge.runIntervals();
  await bridge.fetch(retryListPath, [retryConversation("m3")]);
  assert.equal(bridge.requests.filter((path) => path === retryHistoryPath).length, 1);
  finish(new Response(JSON.stringify([retryMessage("m1", 0), retryMessage("m2", 1)])));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(bridge.state.pendingSellerCentreMessages.size, 1);
  bridge.setResponse(retryHistoryPath, [retryMessage("m1", 0), retryMessage("m2", 1), retryMessage("m3", 2)]);
  await bridge.runIntervals();
  assert.deepEqual(capturedRetryIds(bridge), ["m2", "m3"]);
});

for (const reset of ["shop switch", "dispose"]) {
  test(`Seller Centre discards in-flight messages after ${reset}`, async () => {
    const bridge = await pollingRetryBridge();
    let finish;
    bridge.setResponse(retryHistoryPath, () => new Promise((resolve) => { finish = resolve; }));
    bridge.setResponse(retryListPath, [retryConversation("m2")]);
    await bridge.runIntervals();
    assert.equal(bridge.state.pendingSellerCentreMessages.size, 1);
    if (reset === "shop switch") {
      await bridge.fetch("/api/v2/login/", { data: { shop_id: 200000002 } });
    } else bridge.dispose();
    finish(new Response(JSON.stringify([retryMessage("m1", 0), retryMessage("m2", 1)])));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(capturedRetryIds(bridge), []);
    assert.equal(bridge.state.pendingSellerCentreMessages.size, 0);
    assert.equal(bridge.state.capturedMessageIdsByConversation.size, 0);
  });
}


test("Seller Centre retries m2 on the next poll without a new summary message", async () => {
  const bridge = await pollingRetryBridge();
  bridge.setResponse(retryListPath, [retryConversation("m2")]);
  bridge.setResponse(retryHistoryPath, () => new Response("{}", { status: 503 }));
  await bridge.runIntervals();
  bridge.setResponse(retryHistoryPath, [retryMessage("m1", 0), retryMessage("m2", 1)]);
  await bridge.runIntervals();
  assert.equal(bridge.requests.filter((path) => path === retryHistoryPath).length, 2);
  assert.deepEqual(capturedRetryIds(bridge), ["m2"]);
  await bridge.runIntervals();
  assert.deepEqual(capturedRetryIds(bridge), ["m2"]);
});

for (const subaccount of [false, true]) {
  test(`recovers closed conversations across POST pages in ${subaccount ? "subaccount" : "normal"} mini-chat, restricted to the active shop`, async () => {
    const bridge = createBridge({ pathname: "/portal", miniChatOpen: true });
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
    await bridge.fetch("/webchat/api/v1.2/mini/conversations/active-shop/messages", []);
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

test("subaccount polling captures new active-shop messages without fetching other shops", async () => {
  const bridge = createBridge({ pathname: "/portal", captureIntervals: true });
  const path = "/webchat/api/v1.2/mini/subaccount/serving_mode/conversations";
  await bridge.detect();
  await bridge.fetch("/webchat/api/v1.2/mini/conversation/unread-count", {});
  await bridge.fetch(path, { conversations: [retryConversation("m1")] });
  bridge.setResponse(path, { conversations: [
    retryConversation("m2"),
    { ...retryConversation("other-message"), id: "other-conversation", shop_id: 200000002 },
  ] });
  bridge.setResponse(retryHistoryPath, [retryMessage("m1", 0), retryMessage("m2", 1)]);
  await bridge.runIntervals();
  assert.deepEqual(capturedRetryIds(bridge), ["m2"]);
  assert.equal(bridge.requests.includes(`${retryListPath}/other-conversation/messages`), false);
});
