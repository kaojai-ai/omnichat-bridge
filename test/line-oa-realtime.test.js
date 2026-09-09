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

test("LINE OA command capabilities require an observed browser send profile", () => {
  assert.match(source, /const sendProfilesByBot = new Map\(\)/);
  assert.match(source, /function rememberSendProfile\(/);
  assert.match(source, /if \(profiles\.has\("text"\)\) capabilities\.push\("send_text"\)/);
  assert.match(source, /if \(profiles\.has\("sticker"\)\) capabilities\.push\("send_sticker"\)/);
  assert.match(source, /imageProfile && firstImageUrlPath\(imageProfile\.payload\)/);
  assert.match(source, /function safeHeaders\(/);
  assert.match(source, /\["accept", "content-type", "x-oa-chat-client-version"\]/);
  assert.match(source, /credentials: "include"/);
  assert.doesNotMatch(source, /cookie\s*:/);
});

function createBridge({ basicId = "@159nzygg", availableAccounts = null, chatCount = 2, chat1MessageCount = 2, chatLatestEventTimestamps = {} } = {}) {
  const origin = "https://chat.line.biz";
  const listeners = [];
  const posts = [];
  const requests = [];
  const sentPayloads = [];
  const chatIds = Array.from({ length: chatCount }, (_value, index) => `chat-${index + 1}`);
  const window = {
    location: { origin, pathname: "/bot-1/chats" },
    fetch: async (input, init = {}) => {
      const url = new URL(String(input));
      requests.push(url);
      if (url.pathname === "/api/v1/bots/bot-1/chats/chat-1/messages/send") {
        sentPayloads.push({ headers: init.headers, body: init.body });
        return { ok: true, json: async () => ({ id: `sent-${sentPayloads.length}` }) };
      }
      if (url.pathname === "/api/v1/bots") {
        return {
          ok: true,
          json: async () => ({
            list: availableAccounts ?? (basicId ? [{ botId: "bot-1", basicSearchId: basicId, name: "KaoJai.ai" }] : []),
          }),
        };
      }
      if (url.pathname === "/api/v2/bots/bot-1/chats") {
        const next = url.searchParams.get("next");
        const pageIndex = next ? Number(String(next).replace("chat-page-", "")) - 1 : 0;
        const chatId = chatIds[pageIndex];
        return {
          ok: true,
          json: async () => ({
            list: chatId ? [{
              chatId,
              ...(chatLatestEventTimestamps[chatId] !== undefined
                ? { latestEvent: { type: "message", timestamp: chatLatestEventTimestamps[chatId] } }
                : {}),
            }] : [],
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
        return {
          ok: true,
          json: async () => ({
            list: [{ id: "message-3", timestamp: chatLatestEventTimestamps["chat-2"] ?? 1200 }],
          }),
        };
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
      if (!["recovery_batch", "recovery_cursor"].includes(message.type)) return;
      queueMicrotask(() => {
        const response = {
          source: "omnichat-realtime-bridge-v3",
          type: "recovery_ack_v3",
          request_id: message.request_id,
          ok: true,
        };
        if (message.type === "recovery_batch") {
          const messages = message.body.conversations[0].messages;
          const latest = messages.at(-1);
          response.parsed = messages.length;
          response.queued = 1;
          response.latest_cursor = latest
            ? {
              event_timestamp: new Date(Number(latest.timestamp)).toISOString(),
              message_id: String(latest.id),
            }
            : null;
        }
        for (const listener of listeners) {
          listener({
            source: window,
            origin,
            data: response,
          });
        }
      });
    },
  };
  const context = vm.createContext({
    window,
    fetch: window.fetch,
    URL,
    Headers,
    Request,
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
    sentPayloads,
    async captureManualSend(payload) {
      await context.window.fetch(`${origin}/api/v1/bots/bot-1/chats/chat-1/messages/send`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-oa-chat-client-version": "observed-version",
          cookie: "must-not-be-copied",
        },
        body: JSON.stringify(payload),
      });
      await new Promise((resolve) => setImmediate(resolve));
    },
    async sendCommand(command) {
      const before = posts.length;
      for (const listener of listeners) {
        listener({
          source: window,
          origin,
          data: {
            source: "omnichat-realtime-bridge-v3",
            type: "send_api_v3",
            request_id: "send-1",
            conversation_id: "chat-1",
            browser_provider_account_id: basicId,
            ...command,
          },
        });
      }
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const result = posts.slice(before).find((post) => post.type === "api_send_result" && post.request_id === "send-1");
        if (result) return result;
        await new Promise((resolve) => setImmediate(resolve));
      }
      throw new Error("LINE OA send command did not complete.");
    },
    async detect(accountHints) {
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
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const detected = posts.slice(before).find((post) => post.request_id === "detect-1");
        if (detected) return detected;
        await new Promise((resolve) => setImmediate(resolve));
      }
      throw new Error("LINE OA account detection did not complete.");
    },
    async sync({ requestId = "sync-1", providerAccountId = "line-oa-account-1", botId = "bot-1", checkpoint = null } = {}) {
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
            ...(botId ? { bot_id: botId } : {}),
          },
        });
      }
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const complete = posts.findLast((post) => post.type === "recovery_complete" && post.request_id === requestId);
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

test("LINE OA discovers and persists the page Basic ID with its bot ID", async () => {
  const bridge = createBridge();

  assert.deepEqual(plain(await bridge.detect([{ provider_account_id: "@159nzygg" }])), {
    source: "omnichat-realtime-bridge-v3",
    type: "accounts_detected",
    request_id: "detect-1",
    accounts: [{ provider: "line_oa", provider_account_id: "@159nzygg", bot_id: "bot-1", display_name: "KaoJai.ai" }],
  });
});

test("LINE OA rejects a session without an accessible account", async () => {
  const bridge = createBridge({ basicId: "" });

  assert.deepEqual(plain(await bridge.detect([{ provider_account_id: "@159nzygg" }])), {
    source: "omnichat-realtime-bridge-v3",
    type: "account_detection_failed",
    request_id: "detect-1",
    error: "No LINE OA accounts were found for the signed-in user.",
  });
});

test("LINE OA replays an observed text request without copying cookies", async () => {
  const bridge = createBridge();

  await bridge.captureManualSend({ type: "text", text: "manual message", sendId: "manual-send" });
  const result = await bridge.sendCommand({ command_type: "send_text", text: "bridge message" });

  assert.deepEqual(plain(result), {
    source: "omnichat-realtime-bridge-v3",
    type: "api_send_result",
    request_id: "send-1",
    ok: true,
    provider_message_id: "sent-2",
  });
  assert.equal(bridge.sentPayloads.length, 2);
  const sentBody = JSON.parse(bridge.sentPayloads[1].body);
  assert.equal(sentBody.type, "text");
  assert.equal(sentBody.text, "bridge message");
  assert.match(sentBody.sendId, /^chat-1_\d+_\d{8}$/);
  assert.deepEqual(plain(bridge.sentPayloads[1].headers), {
    accept: "application/json",
    "content-type": "application/json",
    "x-oa-chat-client-version": "observed-version",
  });
});

test("LINE OA replays observed image and sticker request shapes", async () => {
  const bridge = createBridge();

  await bridge.captureManualSend({
    type: "image",
    imageUrl: "https://old-image.example/manual.png",
    sendId: "manual-image",
  });
  const imageResult = await bridge.sendCommand({
    command_type: "send_image",
    image_url: "https://cdn.kaojai.example/reply.png",
  });
  assert.equal(imageResult.ok, true);
  const imageBody = JSON.parse(bridge.sentPayloads[1].body);
  assert.equal(imageBody.type, "image");
  assert.equal(imageBody.imageUrl, "https://cdn.kaojai.example/reply.png");

  await bridge.captureManualSend({
    type: "sticker",
    packageId: "manual-package",
    stickerId: "manual-sticker",
    sendId: "manual-sticker-send",
  });
  const stickerResult = await bridge.sendCommand({
    command_type: "send_sticker",
    package_id: "bridge-package",
    sticker_id: "bridge-sticker",
  });
  assert.equal(stickerResult.ok, true);
  const stickerBody = JSON.parse(bridge.sentPayloads[3].body);
  assert.equal(stickerBody.type, "sticker");
  assert.equal(stickerBody.packageId, "bridge-package");
  assert.equal(stickerBody.stickerId, "bridge-sticker");
});

test("LINE OA discovers a closed account bot ID before polling it", async () => {
  const bridge = createBridge({
    availableAccounts: [{ botId: "bot-1", basicSearchId: "@other" }],
  });

  const complete = await bridge.sync({ providerAccountId: "@other", botId: "" });

  assert.equal(complete.ok, true);
  assert.ok(bridge.requests.some((url) => url.pathname === "/api/v1/bots"));
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

test("LINE OA saves a per-conversation cursor after each persisted message page", async () => {
  const bridge = createBridge();

  await bridge.sync();

  const cursors = bridge.posts.filter((post) => post.type === "recovery_cursor");
  assert.equal(cursors.length, 3);
  assert.deepEqual(
    cursors.map((post) => post.conversation_id),
    ["chat-1", "chat-1", "chat-2"],
  );
  assert.ok(cursors.every((post) => post.cursor?.event_timestamp && post.cursor?.message_id));
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

test("LINE OA skips unchanged chats using latestEvent timestamp", async () => {
  const bridge = createBridge({
    chatLatestEventTimestamps: { "chat-1": 1000, "chat-2": 3000 },
  });

  const complete = await bridge.sync({
    checkpoint: { watermark: "1970-01-01T00:00:02.000Z" },
  });

  assert.equal(complete.ok, true);
  assert.equal(complete.recovered, 1);
  assert.deepEqual(
    bridge.requests
      .filter((url) => url.pathname.includes("/messages"))
      .map((url) => `${url.pathname}?${url.searchParams}`),
    ["/api/v3/bots/bot-1/chats/chat-2/messages?limit=100"],
  );
});

test("LINE OA fetches when latestEvent timestamp equals the saved watermark", async () => {
  const bridge = createBridge({
    chatCount: 1,
    chatLatestEventTimestamps: { "chat-1": 2000 },
  });

  const complete = await bridge.sync({
    checkpoint: { watermark: "1970-01-01T00:00:02.000Z" },
  });

  assert.equal(complete.ok, true);
  assert.equal(
    bridge.requests.filter((url) => url.pathname === "/api/v3/bots/bot-1/chats/chat-1/messages").length,
    1,
  );
});

test("LINE OA queues a sync request that arrives during an active recovery", async () => {
  const bridge = createBridge();

  const first = bridge.sync({ requestId: "sync-1" });
  const second = bridge.sync({
    requestId: "sync-2",
    providerAccountId: "line-oa-account-2",
    botId: "bot-1",
  });
  const [firstComplete, secondComplete] = await Promise.all([first, second]);

  assert.equal(firstComplete.ok, true);
  assert.equal(secondComplete.ok, true);
  assert.equal(secondComplete.provider_account_id, "line-oa-account-2");
  assert.equal(bridge.posts.filter((post) => post.type === "recovery_complete").length, 2);
});

test("LINE OA uses an explicit bot ID to poll another configured account from one tab", async () => {
  const bridge = createBridge();

  const complete = await bridge.sync({
    requestId: "sync-2",
    providerAccountId: "line-oa-account-2",
    botId: "bot-1",
  });

  assert.equal(complete.ok, true);
  assert.equal(complete.provider_account_id, "line-oa-account-2");
  assert.ok(bridge.requests.some((url) => url.pathname === "/api/v2/bots/bot-1/chats"));
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

test("LINE OA republishes realtime health when a replacement content bridge detects accounts", async () => {
  const bridge = createBridge();
  bridge.posts.length = 0;
  await bridge.detect();
  const status = bridge.posts.find((post) => post.type === "provider_status");
  assert.equal(status?.realtime_connected, true);
  assert.equal(status?.realtime_transport, "authenticated_polling");
  assert.deepEqual(plain(status.command_capabilities_by_account), { "@159nzygg": [] });
  bridge.dispose();
});
