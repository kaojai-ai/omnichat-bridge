import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../extension/shopee-realtime.js", import.meta.url), "utf8");
const urlSource = await readFile(new URL("../extension/lib/shopee-url.js", import.meta.url), "utf8");
const adaptersSource = await readFile(new URL("../extension/lib/provider-adapters.js", import.meta.url), "utf8");
const shopeeAdapterSource = await readFile(new URL("../extension/lib/shopee-adapter.js", import.meta.url), "utf8");
const origin = "https://seller.shopee.co.th";

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

function createBridge({ pathname = "/webchat/conversations", captureIntervals = false, miniChatOpen = null } = {}) {
  const listeners = [];
  const posts = [];
  const responses = new Map();
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
    closest: (selector) => selector === ".panel-item" ? miniChatPanel : null,
    getAttribute: () => null,
    click: () => {
      miniChatClicks += 1;
      miniChatIsOpen = true;
    },
  };
  const document = {
    documentElement: { dataset: {} },
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
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    addEventListener(type, listener) {
      if (type === "message") listeners.push(listener);
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

  async function fetch(path, body) {
    responses.set(path, body);
    const isConversationList = [
      "/webchat/api/v1.2/conversations",
      "/webchat/api/v1.2/subaccount/serving_mode/conversations",
      "/webchat/api/v1.2/mini/conversations",
    ].includes(path);
    await window.fetch(isConversationList
      ? new Request(`${origin}${path}`, { method: "POST", body: "{}" })
      : `${origin}${path}`);
    if (isConversationList && path !== "/webchat/api/v1.2/mini/conversations") {
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
        data: { source: "omnichat-realtime-bridge-v2", type: "reset_recovery" },
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

  async function detect(requestId = "detect-1") {
    for (const listener of listeners) {
      listener({
        source: window,
        origin,
        data: { source: "omnichat-realtime-bridge-v2", type: "detect_account_v2", request_id: requestId },
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
        && post.accounts?.length > 1);
      if (detection) return detection;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return null;
  }

  async function sync(providerAccountId, requestId = "sync-1") {
    for (const listener of listeners) {
      listener({
        source: window,
        origin,
        data: {
          source: "omnichat-realtime-bridge-v2",
          type: "sync_v2",
          request_id: requestId,
          checkpoint: { watermark: "2026-08-01T00:00:00.000Z" },
          provider_account_id: providerAccountId,
        },
      });
    }
    const acknowledged = new Set();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      for (const post of posts) {
        if (![
          "recovery_batch",
          "recovery_bootstrap",
          "recovery_cursor",
        ].includes(post.type) || acknowledged.has(post.request_id)) continue;
        acknowledged.add(post.request_id);
        for (const listener of listeners) {
          listener({
            source: window,
            origin,
            data: {
              source: "omnichat-realtime-bridge-v2",
              type: "recovery_ack_v2",
              request_id: post.request_id,
              ok: true,
              latest_cursor: null,
            },
          });
        }
      }
      const complete = posts.findLast((post) => post.type === "recovery_complete" && post.request_id === requestId);
      if (complete) return complete;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Recovery did not complete in the test harness.");
  }

  return {
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

test("uses shop.id as the provider account and keeps user IDs as metadata", async () => {
  const bridge = createBridge();
  await bridge.fetch("/webchat/api/coreapi/v1.2/login", {
    user: { id: 4897267 },
    shop: { id: 1549058683, user_id: 1549897350, name: "2Days Ago Badminton" },
  });

  const detection = bridge.posts.findLast((post) => post.type === "accounts_detected");
  assert.equal(detection.accounts.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(detection.accounts[0])), {
    provider: "shopee",
    provider_account_id: "1549058683",
    display_name: "2Days Ago Badminton",
    provider_user_id: "4897267",
    shop_user_id: "1549897350",
  });
  assert.equal(detection.accounts.some((account) => account.provider_account_id === "1549897350"), false);
});

test("actively detects all shops on initial account detection", async () => {
  const bridge = createBridge();
  await bridge.fetch("/webchat/api/v1.2/conversations", [
    { id: "conversation-th", shop_id: 1549058683 },
  ]);
  bridge.setResponse("/webchat/api/v1.2/shop_list", {
    shops: [
      { id: 1549058683, name: "2Days Ago Badminton" },
      { id: 1698999861, name: "2daysagobadminton.my" },
      { id: 1698999856, name: "2daysagobadminton.ph" },
    ],
  });
  bridge.setResponse("/webchat/api/v1.2/subaccount/serving_mode/conversations", {
    conversations: [
      { id: "conversation-th", shop_id: 1549058683 },
    ],
  });

  const detection = await bridge.detect();
  assert.ok(detection, JSON.stringify({ posts: bridge.posts, requests: bridge.requests }));
  assert.deepEqual(
    JSON.parse(JSON.stringify(detection.accounts.map((account) => [account.provider_account_id, account.display_name]))),
    [
      ["1549058683", "2Days Ago Badminton"],
      ["1698999861", "2daysagobadminton.my"],
      ["1698999856", "2daysagobadminton.ph"],
    ],
  );
});

test("automatically detects all shops when the chat page initializes", async () => {
  const bridge = createBridge();
  bridge.setResponse("/webchat/api/v1.2/shop_list", {
    shops: [
      { id: 1549058683, name: "2Days Ago Badminton" },
      { id: 1698999861, name: "2daysagobadminton.my" },
      { id: 1698999856, name: "2daysagobadminton.ph" },
    ],
  });
  bridge.setResponse("/webchat/api/v1.2/subaccount/serving_mode/conversations", {
    conversations: [
      { id: "conversation-th", shop_id: 1549058683 },
    ],
  });
  await bridge.fetch("/webchat/api/v1.2/subaccount/serving_mode/conversations", {
    conversations: [
      { id: "conversation-th", shop_id: 1549058683 },
    ],
  });

  const detection = await bridge.waitForAutomaticDetection();
  assert.ok(detection, JSON.stringify({ posts: bridge.posts, requests: bridge.requests }));
  assert.deepEqual(
    JSON.parse(JSON.stringify(detection.accounts.map((account) => [account.provider_account_id, account.display_name]))),
    [
      ["1549058683", "2Days Ago Badminton"],
      ["1698999861", "2daysagobadminton.my"],
      ["1698999856", "2daysagobadminton.ph"],
    ],
  );
  assert.equal(bridge.requests.includes("/webchat/api/v1.2/shop_list"), true);
  assert.equal(
    bridge.requests.filter((path) => path === "/webchat/api/v1.2/subaccount/serving_mode/conversations").length,
    2,
  );
});

test("merges shop-list names with the special multi-shop conversation endpoint", async () => {
  const bridge = createBridge();
  await bridge.fetch("/webchat/api/v1.2/shop_list", {
    shops: [
      { id: 1698999861, name: "2daysagobadminton.my" },
      { id: 1698999856, name: "2daysagobadminton.ph" },
      { id: 1549058683, name: "2Days Ago Badminton" },
    ],
  });
  await bridge.fetch("/webchat/api/v1.2/subaccount/serving_mode/conversations", {
    conversations: [
      { id: "conversation-my", shop_id: 1698999861 },
      { id: "conversation-th", shop_id: 1549058683 },
    ],
  });

  const detection = await bridge.detect();
  assert.deepEqual(
    JSON.parse(JSON.stringify(detection.accounts.map((account) => [account.provider_account_id, account.display_name]))),
    [
      ["1698999861", "2daysagobadminton.my"],
      ["1698999856", "2daysagobadminton.ph"],
      ["1549058683", "2Days Ago Badminton"],
    ],
  );
});

test("limits recovery to the requested Shop ID", async () => {
  const bridge = createBridge();
  await bridge.fetch("/webchat/api/v1.2/subaccount/serving_mode/conversations", {
    conversations: [
      { id: "conversation-my", shop_id: 1698999861, last_message_time: "2026-08-16T10:00:00.000Z" },
      { id: "conversation-th", shop_id: 1549058683, last_message_time: "2026-08-16T11:00:00.000Z" },
    ],
  });
  await bridge.fetch("/webchat/api/v1.2/conversations/conversation-th/messages", []);

  const complete = await bridge.sync("1549058683");
  const plan = bridge.posts.findLast((post) => post.type === "sync_plan");
  assert.equal(complete.ok, true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(plan.conversations.map((conversation) => conversation.conversation_id))),
    ["conversation-th"],
  );
});

test("discovers a Seller Centre shop and polls its mini history without legacy endpoints", async () => {
  const bridge = createBridge({ pathname: "/portal/chat-management", captureIntervals: true });
  const conversation = {
    id: "seller-centre-conversation",
    shop_id: 1549058683,
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
  await bridge.fetch("/webchat/api/workbenchapi/v1.2/mini/shop/setting", { shop_id: 1549058683 });

  const detection = await bridge.detect();
  assert.ok(detection);
  assert.deepEqual(
    JSON.parse(JSON.stringify(detection.accounts.map((account) => account.provider_account_id))),
    ["1549058683"],
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
    to_id: 1549058683,
    shop_id: 1549058683,
    type: "text",
    content: { text: "First" },
    created_timestamp: 1_724_141_000,
  }, {
    id: "seller-message-2",
    conversation_id: "seller-centre-conversation",
    from_id: 987654321,
    to_id: 1549058683,
    shop_id: 1549058683,
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
    shop_id: 1549058683,
    to_id: 987654321,
    last_message_time: "2026-08-20T10:00:00.000Z",
    latest_message_id: "seller-recovery-message",
    biz_id: 0,
  }]);
  await bridge.fetch("/webchat/api/v1.2/mini/conversations/seller-centre-recovery/messages", []);

  const complete = await bridge.sync("1549058683");
  assert.equal(complete.ok, true);
  assert.equal(bridge.miniChatClicks, 1);
  assert.equal(bridge.miniChatIsOpen, true);
  assert.equal(bridge.requests.includes("/webchat/api/v1.2/mini/conversations/seller-centre-recovery/messages"), true);
  assert.equal(bridge.requests.some((path) => path.includes("/webchat/api/v1.2/conversations/")), false);
});
