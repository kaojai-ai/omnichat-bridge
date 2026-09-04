import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../extension/line-oa-realtime.js", import.meta.url), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));

test("LINE OA recovery paginates chat and message history", () => {
  assert.match(source, /url\.searchParams\.set\("next", next\)/);
  assert.match(source, /url\.searchParams\.set\("backward", backward\)/);
  assert.match(source, /const nextCursor = cursor\(body\?\.next\)/);
  assert.match(source, /const nextBackward = cursor\(body\?\.backward\)/);
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
  assert.match(source.slice(start, end), /stop\(\);/);
});

function createBridge() {
  const origin = "https://chat.line.biz";
  const listeners = [];
  const posts = [];
  const requests = [];
  const window = {
    location: { origin, pathname: "/bot-1/chats" },
    fetch: async (input) => {
      const url = new URL(String(input));
      requests.push(url);
      if (url.pathname === "/api/v2/bots/bot-1/chats") {
        return {
          ok: true,
          json: async () => url.searchParams.get("next") === "chat-page-2"
            ? { list: [{ chatId: "chat-2" }] }
            : { list: [{ chatId: "chat-1" }], next: "chat-page-2" },
        };
      }
      if (url.pathname === "/api/v3/bots/bot-1/chats/chat-1/messages") {
        return {
          ok: true,
          json: async () => url.searchParams.get("backward") === "message-page-2"
            ? { list: [{ id: "message-2" }] }
            : { list: [{ id: "message-1" }], backward: "message-page-2" },
        };
      }
      if (url.pathname === "/api/v3/bots/bot-1/chats/chat-2/messages") {
        return { ok: true, json: async () => ({ list: [{ id: "message-3" }] }) };
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
    OmnichatLineOA: { chatItems: (body) => body?.list ?? [] },
    crypto: { randomUUID: () => "poll-id" },
    setInterval: () => 1,
    clearInterval() {},
    setTimeout,
    clearTimeout,
    queueMicrotask,
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
    async sync() {
      for (const listener of listeners) {
        listener({
          source: window,
          origin,
          data: {
            source: "omnichat-realtime-bridge-v3",
            type: "sync_v3",
            request_id: "sync-1",
            provider_account_id: "line-oa-account-1",
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
  };
}

test("LINE OA maps the page bot ID to the configured provider account", () => {
  const bridge = createBridge();

  assert.deepEqual(plain(bridge.detect([{ provider_account_id: "line-oa-account-1", bot_id: "bot-1" }])), {
    source: "omnichat-realtime-bridge-v3",
    type: "accounts_detected",
    request_id: "detect-1",
    accounts: [{ provider: "line_oa", provider_account_id: "line-oa-account-1", bot_id: "bot-1" }],
  });
});

test("LINE OA rejects missing or ambiguous bot mappings", () => {
  const bridge = createBridge();

  assert.deepEqual(plain(bridge.detect([
    { provider_account_id: "line-oa-account-1", bot_id: "bot-1" },
    { provider_account_id: "line-oa-account-2", bot_id: "bot-1" },
  ])), {
    source: "omnichat-realtime-bridge-v3",
    type: "account_detection_failed",
    request_id: "detect-1",
    error: "LINE OA bot ID is not mapped to exactly one configured provider account.",
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
  assert.deepEqual(
    bridge.requests.map((url) => `${url.pathname}?${url.searchParams}`).sort(),
    [
      "/api/v2/bots/bot-1/chats?folderType=ALL&limit=100&prioritizePinnedChat=false",
      "/api/v2/bots/bot-1/chats?folderType=ALL&limit=100&prioritizePinnedChat=false&next=chat-page-2",
      "/api/v3/bots/bot-1/chats/chat-1/messages?limit=100",
      "/api/v3/bots/bot-1/chats/chat-1/messages?limit=100&backward=message-page-2",
      "/api/v3/bots/bot-1/chats/chat-2/messages?limit=100",
    ].sort(),
  );
});
