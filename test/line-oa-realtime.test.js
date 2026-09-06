import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../extension/line-oa-realtime.js", import.meta.url), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));

test("LINE OA recovery paginates chat and message history", () => {
  assert.match(source, /const INITIAL_SYNC_MAX_CONVERSATIONS = 10/);
  assert.match(source, /const INITIAL_SYNC_MAX_MESSAGES_PER_CONVERSATION = 25/);
  assert.match(source, /url\.searchParams\.set\("next", next\)/);
  assert.match(source, /url\.searchParams\.set\("backward", backward\)/);
  assert.match(source, /const nextCursor = cursor\(body\?\.next\)/);
  assert.match(source, /const nextBackward = cursor\(body\?\.backward\)/);
  assert.match(source, /const bootstrap = checkpointMs <= 0/);
  assert.doesNotMatch(source, /\.slice\(0, 100\)/);
});

test("LINE OA recovery waits for local persistence before completing", () => {
  assert.match(source, /await waitForAcknowledgement\(batchRequestId\)/);
  assert.match(source, /event\.data\.type === "recovery_ack_v3"/);
  assert.match(source, /post\(\{ type: "recovery_complete"/);
});

test("LINE OA replaces an existing polling interval before starting another", () => {
  const start = source.indexOf("function start(");
  const end = source.indexOf("\n  const listener", start);
  assert.ok(start >= 0);
  assert.ok(end > start);
  assert.match(source.slice(start, end), /stopTimer\(\);/);
});

function createBridge({ basicId = "@159nzygg", chatCount = 2, chat1MessageCount = 2 } = {}) {
  const origin = "https://chat.line.biz";
  const listeners = [];
  const posts = [];
  const requests = [];
  const chatIds = Array.from({ length: chatCount }, (_value, index) => `chat-${index + 1}`);
  const window = {
    location: { origin, pathname: "/bot-1/chats" },
    fetch: async (input) => {
      const url = new URL(String(input));
      requests.push(url);
      if (url.pathname === "/api/v2/bots/bot-1/chats") {
        const next = url.searchParams.get("next");
        const pageIndex = next ? Number(String(next).replace("chat-page-", "")) - 1 : 0;
        const chatId = chatIds[pageIndex];
        return {
          ok: true,
          json: async () => ({
            list: chatId ? [{ chatId }] : [],
            ...(pageIndex + 1 < chatIds.length ? { next: `chat-page-${pageIndex + 2}` } : {}),
          }),
        };
      }
      if (url.pathname === "/api/v3/bots/bot-1/chats/chat-1/messages") {
        if (chat1MessageCount > 2) {
          return {
            ok: true,
            json: async () => ({
              list: Array.from({ length: chat1MessageCount }, (_value, index) => ({
                id: `message-${index + 1}`,
                timestamp: 1000 + index,
              })),
            }),
          };
        }
        return {
          ok: true,
          json: async () => url.searchParams.get("backward") === "message-page-2"
            ? { list: [{ id: "message-2", timestamp: 1100 }] }
            : { list: [{ id: "message-1", timestamp: 1000 }], backward: "message-page-2" },
        };
      }
      if (url.pathname === "/api/v3/bots/bot-1/chats/chat-2/messages") {
        return { ok: true, json: async () => ({ list: [{ id: "message-3", timestamp: 1200 }] }) };
      }
      if (url.pathname.startsWith("/api/v3/bots/bot-1/chats/") && url.pathname.endsWith("/messages")) {
        const chatId = url.pathname.split("/").at(-2);
        const chatNumber = Number(String(chatId).replace("chat-", ""));
        return {
          ok: true,
          json: async () => ({ list: [{ id: `message-${chatNumber}`, timestamp: 2000 + chatNumber }] }),
        };
      }
      throw new Error(`Unexpected LINE OA URL: ${url}`);
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
      if (message.type !== "recovery_batch") return;
      queueMicrotask(() => {
        for (const listener of listeners) {
          listener({
            source: window,
            origin,
            data: {
              source: "omnichat-realtime-bridge-v3",
              type: "recovery_ack_v3",
              request_id: message.request_id,
              ok: true,
              parsed: message.body.conversations[0].messages.length,
              queued: 1,
            },
          });
        }
      });
    },
  };
  const context = vm.createContext({
    window,
    fetch: window.fetch,
    URL,
    document: { documentElement: { outerHTML: basicId ? `<a href="https://manager.line.biz/account/${basicId}">LINE Official Account</a>` : "" } },
    OmnichatLineOA: {
      chatItems: (body) => body?.list ?? [],
      basicIdFromHtml: () => basicId,
    },
    crypto: { randomUUID: () => "poll-id" },
    setInterval: () => 1,
    clearInterval() {},
    setTimeout,
    clearTimeout,
    queueMicrotask,
    AbortController,
  });
  vm.runInContext(source, context);

  return {
    posts,
    requests,
    detect(accountHints) {
      const before = posts.length;
      for (const listener of listeners) {
        listener({
          source: window,
          origin,
          data: {
            source: "omnichat-realtime-bridge-v3",
            type: "detect_account_v3",
            request_id: "detect-1",
            account_hints: accountHints,
          },
        });
      }
      return posts.slice(before).find((post) => post.request_id === "detect-1");
    },
    async sync({ requestId = "sync-1", providerAccountId = "line-oa-account-1", checkpoint = null } = {}) {
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
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const complete = posts.findLast((post) => post.type === "recovery_complete" && post.request_id === "sync-1");
        if (complete) return complete;
        await new Promise((resolve) => setImmediate(resolve));
      }
      throw new Error("LINE OA recovery did not complete.");
    },
    dispose() {
      context.window.__omnichatLineOABridgeControl.dispose();
    },
  };
}

test("LINE OA maps the page Basic ID to the configured provider account", () => {
  const bridge = createBridge();

  assert.deepEqual(plain(bridge.detect([{ provider_account_id: "@159nzygg" }])), {
    source: "omnichat-realtime-bridge-v3",
    type: "accounts_detected",
    request_id: "detect-1",
    accounts: [{ provider: "line_oa", provider_account_id: "@159nzygg" }],
  });
});

test("LINE OA rejects a page without a Basic ID", () => {
  const bridge = createBridge({ basicId: "" });

  assert.deepEqual(plain(bridge.detect([{ provider_account_id: "@159nzygg" }])), {
    source: "omnichat-realtime-bridge-v3",
    type: "account_detection_failed",
    request_id: "detect-1",
    error: "LINE OA Basic ID was not found in the open page.",
  });
});

test("LINE OA recovers every chat and message page only after each page is acknowledged", async () => {
  const bridge = createBridge();

  const complete = await bridge.sync();

  const { watermark, ...completeWithoutWatermark } = complete;
  assert.deepEqual(completeWithoutWatermark, {
    source: "omnichat-realtime-bridge-v3",
    type: "recovery_complete",
    request_id: "sync-1",
    provider_account_id: "line-oa-account-1",
    ok: true,
    recovered: 3,
    queued: 3,
  });
  assert.match(watermark, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(bridge.posts.filter((post) => post.type === "recovery_batch").length, 3);
  const progress = bridge.posts.filter((post) => post.type === "recovery_progress");
  assert.equal(progress.length, 3);
  assert.deepEqual(plain(progress[0]), {
    source: "omnichat-realtime-bridge-v3",
    type: "recovery_progress",
    request_id: "sync-1",
    provider_account_id: "line-oa-account-1",
    completed_conversations: 0,
    total_conversations: 0,
  });
  assert.deepEqual(
    bridge.requests.map((url) => `${url.pathname}?${url.searchParams}`).sort(),
    [
      "/api/v2/bots/bot-1/chats?folderType=ALL&tagIds=&autoTagIds=&limit=25&prioritizePinnedChat=true",
      "/api/v2/bots/bot-1/chats?folderType=ALL&tagIds=&autoTagIds=&limit=25&prioritizePinnedChat=true&next=chat-page-2",
      "/api/v3/bots/bot-1/chats/chat-1/messages?limit=25",
      "/api/v3/bots/bot-1/chats/chat-1/messages?limit=24&backward=message-page-2",
      "/api/v3/bots/bot-1/chats/chat-2/messages?limit=25",
    ].sort(),
  );
});

test("LINE OA first setup stops after ten conversations", async () => {
  const bridge = createBridge({ chatCount: 11 });

  const complete = await bridge.sync();

  assert.equal(complete.ok, true);
  assert.equal(complete.recovered, 11);
  assert.equal(bridge.posts.filter((post) => post.type === "recovery_batch").length, 11);
  const chatRequests = bridge.requests.filter((url) => url.pathname === "/api/v2/bots/bot-1/chats");
  assert.equal(chatRequests.length, 10);
  assert.equal(chatRequests.some((url) => url.searchParams.get("next") === "chat-page-11"), false);
});

test("LINE OA first setup caps messages per conversation", async () => {
  const bridge = createBridge({ chat1MessageCount: 30 });

  const complete = await bridge.sync();

  assert.equal(complete.ok, true);
  assert.equal(complete.recovered, 26);
  const chat1Batches = bridge.posts.filter(
    (post) => post.type === "recovery_batch" && post.request_id.startsWith("sync-1:chat-1:"),
  );
  assert.equal(chat1Batches.length, 1);
  assert.equal(chat1Batches[0].body.conversations[0].messages.length, 25);
  assert.equal(
    bridge.requests.filter((url) => url.pathname === "/api/v3/bots/bot-1/chats/chat-1/messages").length,
    1,
  );
});

test("LINE OA incremental recovery stops at the saved watermark", async () => {
  const bridge = createBridge();

  const complete = await bridge.sync({
    checkpoint: { watermark: "1970-01-01T00:00:02.000Z" },
  });

  assert.equal(complete.ok, true);
  assert.equal(complete.recovered, 0);
  assert.equal(bridge.posts.filter((post) => post.type === "recovery_batch").length, 0);
  assert.deepEqual(
    bridge.requests
      .filter((url) => url.pathname.includes("/messages"))
      .map((url) => `${url.pathname}?${url.searchParams}`)
      .sort(),
    [
      "/api/v3/bots/bot-1/chats/chat-1/messages?limit=100",
      "/api/v3/bots/bot-1/chats/chat-2/messages?limit=100",
    ].sort(),
  );
});

test("LINE OA queues a sync request that arrives during an active recovery", async () => {
  const bridge = createBridge();

  const first = bridge.sync({ requestId: "sync-1" });
  const second = bridge.sync({ requestId: "sync-2" });
  const [firstComplete, secondComplete] = await Promise.all([first, second]);

  assert.equal(firstComplete.ok, true);
  assert.equal(secondComplete.ok, true);
  assert.equal(bridge.posts.filter((post) => post.type === "recovery_complete").length, 2);
});

test("LINE OA completes a pending request when the page bridge is replaced", async () => {
  const bridge = createBridge();
  const pending = bridge.sync({ requestId: "sync-1" });

  bridge.dispose();

  const complete = await pending;
  assert.deepEqual(plain(complete), {
    source: "omnichat-realtime-bridge-v3",
    type: "recovery_complete",
    request_id: "sync-1",
    provider_account_id: "line-oa-account-1",
    ok: false,
    error: "LINE OA bridge was replaced.",
  });
});
