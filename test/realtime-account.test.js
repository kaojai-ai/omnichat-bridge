import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../extension/shopee-realtime.js", import.meta.url), "utf8");
const urlSource = await readFile(new URL("../extension/lib/shopee-url.js", import.meta.url), "utf8");
const adaptersSource = await readFile(new URL("../extension/lib/provider-adapters.js", import.meta.url), "utf8");
const shopeeAdapterSource = await readFile(new URL("../extension/lib/shopee-adapter.js", import.meta.url), "utf8");
const origin = "https://seller.shopee.co.th";

function createBridge() {
  const listeners = [];
  const posts = [];
  const responses = new Map();
  const requests = [];
  const window = {
    location: { origin, href: `${origin}/webchat/conversations` },
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
    document: { documentElement: { dataset: {} } },
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
    setInterval: () => 0,
    setTimeout,
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
    ].includes(path);
    await window.fetch(isConversationList
      ? new Request(`${origin}${path}`, { method: "POST", body: "{}" })
      : `${origin}${path}`);
    if (isConversationList) {
      await window.fetch(`${origin}/webchat/api/v1.2/conversation/serving_mode/attr`);
    }
    await new Promise((resolve) => setImmediate(resolve));
  }

  function setResponse(path, body) {
    responses.set(path, body);
  }

  async function detect(requestId = "detect-1") {
    for (const listener of listeners) {
      listener({
        source: window,
        origin,
        data: { source: "omnichat-realtime-bridge", type: "detect_account", request_id: requestId },
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
          source: "omnichat-realtime-bridge",
          type: "sync",
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
              source: "omnichat-realtime-bridge",
              type: "recovery_ack",
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

  return { fetch, setResponse, detect, waitForAutomaticDetection, sync, posts, requests };
}

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
