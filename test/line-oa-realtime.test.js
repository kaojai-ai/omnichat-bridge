import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../extension/line-oa-realtime.js", import.meta.url), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));

test("LINE OA recovery paginates chat and message history", () => {
  assert.match(source, /const INITIAL_SYNC_MAX_CONVERSATIONS = 10/);
  assert.match(source, /const INITIAL_SYNC_MAX_MESSAGES_PER_CONVERSATION = 25/);
  assert.match(source, /const INITIAL_SYNC_LOOKBACK_MS = 24 \* 60 \* 60 \* 1_000/);
  assert.match(source, /url\.searchParams\.set\("next", next\)/);
  assert.match(source, /url\.searchParams\.set\("backward", backward\)/);
  assert.match(source, /const nextCursor = cursor\(body\?\.next\)/);
  assert.match(source, /const nextBackward = cursor\(body\?\.backward\)/);
  assert.match(source, /const bootstrap = checkpointMs <= 0/);
  assert.match(source, /const lowerBoundMs = historyWindow/);
  assert.match(source, /Date\.now\(\) - INITIAL_SYNC_LOOKBACK_MS/);
  assert.doesNotMatch(source, /\.slice\(0, 100\)/);
});

test("LINE OA uses caller client_message_id as sendId and confirms it from message history", () => {
  assert.match(source, /const confirmationSendId = requestedSendId \|\| sendId\(conversationId\)/);
  assert.match(source, /payload\.sendId = confirmationSendId/);
  assert.match(source, /waitForSentMessage\(\{[\s\S]*sendId: confirmationSendId/);
  assert.match(source, /messageConversationId\(message\) === conversationId/);
  assert.match(source, /messageSendId\(message\) === sendId/);
  assert.match(source, /messagesUrl\(botId, conversationId, null, PAGE_LIMIT\)/);
  assert.match(source, /send_id: confirmationSendId/);
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


function createBridge({ sendResponseBody, sendStatus = 200, sendNonJson = false, sendError = null, accountError = null, chatError = null, confirmError = null, uploadStatus = 200, uploadDelayMs = 0, uploadBody = { contentMessageToken: "upload-token" }, basicId = "@exampleoa", availableAccounts = null, chatCount = 2, chat1MessageCount = 2, chatLatestEventTimestamps = {}, beforeChatRequest = null } = {}) {
  const origin = "https://chat.line.biz";
  let fixtureNow = null;
  class FixtureDate extends Date {
    static now() { return fixtureNow ?? Date.now(); }
  }
  const listeners = [];
  const posts = [];
  const requests = [];
  const sentPayloads = [];
  const uploads = [];
  const intervals = new Map();
  let nextIntervalId = 1;
  const chatIds = Array.from({ length: chatCount }, (_value, index) => `chat-${index + 1}`);
  const window = {
    location: { origin, pathname: "/bot-1/chats" },
    fetch: async (input, init = {}) => {
      const url = new URL(String(input));
      requests.push(url);
      if (url.pathname === "/api/v1/bots/bot-1/messages/chat-1/uploadFile") {
        uploads.push(init);
        if (uploadDelayMs) await new Promise(resolve => setTimeout(resolve, uploadDelayMs));
        return { ok: uploadStatus === 200, status: uploadStatus, json: async () => uploadBody };
      }
      if (["/api/v1/bots/bot-1/chats/chat-1/messages/send", "/api/v1/bots/bot-1/chats/chat-1/messages/bulkSendFiles"].includes(url.pathname)) {
        sentPayloads.push({ headers: init.headers, body: init.body });
        if (sendError) throw sendError;
        return { ok: sendStatus === 200, status: sendStatus, json: async () => { if (sendNonJson) throw new SyntaxError("secret provider HTML"); return sendResponseBody === undefined ? ({ id: `sent-${sentPayloads.length}` }) : sendResponseBody; } };
      }
      if (url.pathname === "/api/v1/bots") {
        if (accountError) throw accountError;
        return {
          ok: true,
          json: async () => ({
            list: availableAccounts ?? (basicId ? [{ botId: "bot-1", basicSearchId: basicId, name: "Example Store" }] : []),
          }),
        };
      }
      if (url.pathname === "/api/v2/bots/bot-1/chats") {
        if (beforeChatRequest) await beforeChatRequest(url);
        if (chatError) throw chatError;
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
        if (sentPayloads.length && confirmError) throw confirmError;
        if (sentPayloads.length && sendResponseBody === undefined) {
          const body = JSON.parse(sentPayloads.at(-1).body);
          return { ok: true, json: async () => ({ list: [{ source: { chatId: "chat-1" },
            message: { id: `sent-${sentPayloads.length}`, sendId: body.sendId ?? body.items?.[0]?.sendId } }] }) };
        }
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
      if (!["recovery_batch", "recovery_cursor", "history_backfill", "history_window"].includes(message.type)) return;
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
    URL, Date: FixtureDate,
    Headers,
    Request,
    FormData, Blob, ArrayBuffer, AbortSignal,
    document: { documentElement: { outerHTML: basicId ? `<a href="https://manager.line.biz/account/${basicId}">LINE Official Account</a>` : "" } },
    OmnichatLineOA: {
      chatItems: (body) => body?.list ?? [],
      basicIdFromHtml: () => basicId,
    },
    crypto: { randomUUID: () => "poll-id" },
    setInterval(callback) { const id = nextIntervalId++; intervals.set(id, callback); return id; },
    clearInterval(id) { intervals.delete(id); },
    setTimeout,
    clearTimeout,
    queueMicrotask,
    AbortController,
  });
  vm.runInContext(source.replace("const SEND_CONFIRM_TIMEOUT_MS = 10_000", "const SEND_CONFIRM_TIMEOUT_MS = 10").replace("const SEND_CONFIRM_POLL_MS = 1_000", "const SEND_CONFIRM_POLL_MS = 1"), context);

  return {
    posts,
    setAccounts(accounts) { availableAccounts = accounts; },
    setAccountError(error) { accountError = error; },
    requests,
    sentPayloads,
    uploads,
    dispatch(data) {
      for (const listener of listeners) listener({ source: window, origin, data: { source: "omnichat-realtime-bridge-v3", ...data } });
    },
    tick() { for (const callback of [...intervals.values()]) callback(); },
    get intervalCount() { return intervals.size; },
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
        await new Promise((resolve) => setTimeout(resolve, 1));
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
    async sync({
      requestId = "sync-1",
      providerAccountId = "@exampleoa",
      botId = "bot-1",
      checkpoint = null,
      history_days = null,
      history_since_ms = null,
      history_conversation_ids = null,
      now = 5_000,
    } = {}) {
      // History fixtures use epoch-millisecond timestamps. Keep bootstrap lookback in that same clock.
      fixtureNow = now;
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
            ...(history_days != null ? {
              history_days,
              history_since_ms,
              history_conversation_ids,
            } : {}),
          },
        });
      }
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const complete = posts.findLast((post) => post.type === "recovery_complete" && post.request_id === requestId);
        if (complete) { fixtureNow = null; return complete; }
        await new Promise((resolve) => setImmediate(resolve));
      }
      fixtureNow = null;
      throw new Error("LINE OA recovery did not complete.");
    },
    dispose() {
      context.window.__omnichatLineOABridgeControl.dispose();
    },
  };
}

test("LINE OA discovers and persists the page Basic ID with its bot ID", async () => {
  const bridge = createBridge();

  assert.deepEqual(plain(await bridge.detect([{ provider_account_id: "@exampleoa" }])), {
    source: "omnichat-realtime-bridge-v3",
    type: "accounts_detected",
    request_id: "detect-1",
    accounts: [{ provider: "line_oa", provider_account_id: "@exampleoa", bot_id: "bot-1", display_name: "Example Store" }],
  });
});

test("LINE OA reports verified empty access without trusting the page or configuration", async () => {
  const bridge = createBridge({ availableAccounts: [] });

  assert.deepEqual(plain(await bridge.detect([{ provider_account_id: "@exampleoa" }])), {
    source: "omnichat-realtime-bridge-v3",
    type: "accounts_detected",
    request_id: "detect-1",
    accounts: [],
  });
});

test("LINE OA replays an observed text request without copying cookies", async () => {
  const bridge = createBridge();

  await bridge.captureManualSend({ type: "text", text: "manual message", sendId: "manual-send" });
  const result = await bridge.sendCommand({ command_type: "send_text", text: "bridge message", client_message_id: "caller-send-id" });

  assert.deepEqual(plain(result), {
    source: "omnichat-realtime-bridge-v3",
    type: "api_send_result",
    request_id: "send-1",
    ok: true,
    send_id: "caller-send-id",
    confirmed: true,
    provider_message_id: "sent-2",
  });
  assert.equal(bridge.sentPayloads.length, 2);
  const sentBody = JSON.parse(bridge.sentPayloads[1].body);
  assert.equal(sentBody.type, "text");
  assert.equal(sentBody.text, "bridge message");
  assert.equal(sentBody.sendId, "caller-send-id");
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
    image_url: "https://cdn.example.com/reply.png",
    image_bytes: new Uint8Array([1, 2, 3]).buffer, image_type: "image/png",
  });
  assert.equal(imageResult.ok, true);
  const imageBody = JSON.parse(bridge.sentPayloads[1].body);
  assert.equal(imageBody.items[0].contentMessageToken, "upload-token");
  assert.equal(bridge.uploads[0].body.get("file").size, 3);

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
    provider_account_id: "@exampleoa",
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
    provider_account_id: "@exampleoa",
    completed_conversations: 0,
    total_conversations: 0,
  });
  assert.deepEqual(
    bridge.requests.map((url) => `${url.pathname}?${url.searchParams}`).sort(),
    [
      "/api/v1/bots?noFilter=true&limit=1000",
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

test("LINE OA history_days reloads a configured conversation behind the checkpoint", async () => {
  const bridge = createBridge({
    chatLatestEventTimestamps: { "chat-1": 1_000, "chat-2": 1_000 },
  });

  const complete = await bridge.sync({
    checkpoint: { watermark: "1970-01-01T00:00:02.000Z" },
    history_days: 35,
    history_since_ms: 900,
    history_conversation_ids: ["chat-1"],
  });

  assert.equal(complete.ok, true);
  assert.equal(complete.recovered, 2);
  const messagePaths = bridge.requests
    .filter((url) => url.pathname.includes("/messages"))
    .map((url) => url.pathname);
  assert.ok(messagePaths.includes("/api/v3/bots/bot-1/chats/chat-1/messages"));
  assert.equal(messagePaths.includes("/api/v3/bots/bot-1/chats/chat-2/messages"), false);
  assert.equal(
    bridge.posts.some((post) => post.type === "history_backfill"
      && post.conversation_id === "chat-1"
      && post.history_days === 35),
    true,
  );
});

test("LINE OA history_days requests a conversation that is not on the first chat page", async () => {
  const conversationId = "580433e9-90f9-49cb-a68d-e9f16f7e0a88";
  const bridge = createBridge({
    chatLatestEventTimestamps: { "chat-1": 1_000, "chat-2": 1_000 },
  });

  const complete = await bridge.sync({
    checkpoint: { watermark: "1970-01-01T00:00:02.000Z" },
    history_days: 35,
    history_since_ms: 900,
    history_conversation_ids: [conversationId],
  });

  assert.equal(complete.ok, true);
  assert.equal(
    bridge.requests.some((url) => url.pathname === `/api/v3/bots/bot-1/chats/${conversationId}/messages`),
    true,
  );
});

test("LINE OA history_days without conversation ids uses that day as the lower bound", async () => {
  const bridge = createBridge({
    chatCount: 12,
    chat1MessageCount: 30,
    chatLatestEventTimestamps: {
      "chat-11": 2_000,
      "chat-12": 500,
    },
  });

  const complete = await bridge.sync({
    checkpoint: { watermark: "1970-01-01T00:00:03.000Z" },
    history_days: 35,
    history_since_ms: 1_001,
  });

  assert.equal(complete.ok, true);
  const messagePaths = bridge.requests
    .filter((url) => url.pathname.includes("/messages"))
    .map((url) => url.pathname);
  assert.equal(messagePaths.includes("/api/v3/bots/bot-1/chats/chat-11/messages"), true);
  assert.equal(messagePaths.includes("/api/v3/bots/bot-1/chats/chat-12/messages"), false);
  const chat1Batch = bridge.posts.find(
    (post) => post.type === "recovery_batch" && post.request_id.startsWith("sync-1:chat-1:"),
  );
  assert.equal(chat1Batch.body.conversations[0].messages.length, 29);
  assert.ok(chat1Batch.body.conversations[0].messages.every((message) => message.timestamp >= 1_001));
  assert.equal(
    bridge.posts.some((post) => post.type === "history_window" && post.history_days === 35),
    true,
  );
});

test("LINE OA does not repeat a history window already saved", async () => {
  const bridge = createBridge({
    chatLatestEventTimestamps: { "chat-1": 1_000, "chat-2": 1_000 },
  });

  const complete = await bridge.sync({
    checkpoint: {
      watermark: "1970-01-01T00:00:03.000Z",
      history_window_days: 35,
    },
    history_days: 35,
    history_since_ms: 900,
  });

  assert.equal(complete.ok, true);
  assert.equal(
    bridge.requests.some((url) => url.pathname.includes("/messages")),
    false,
  );
  assert.equal(bridge.posts.some((post) => post.type === "history_window"), false);
});

test("LINE OA does not repeat a configured history backfill already saved", async () => {
  const bridge = createBridge({
    chatLatestEventTimestamps: { "chat-1": 1_000, "chat-2": 1_000 },
  });

  const complete = await bridge.sync({
    checkpoint: {
      watermark: "1970-01-01T00:00:02.000Z",
      history_backfill: { "chat-1": 35 },
    },
    history_days: 35,
    history_since_ms: 900,
    history_conversation_ids: ["chat-1"],
  });

  assert.equal(complete.ok, true);
  assert.equal(complete.recovered, 0);
  assert.equal(bridge.requests.some((url) => url.pathname.includes("/messages")), false);
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
  const bridge = createBridge({ availableAccounts: ["@exampleoa", "@second"].map((basicSearchId) => ({ basicSearchId, botId: "bot-1" })) });

  const first = bridge.sync({ requestId: "sync-1" });
  const second = bridge.sync({
    requestId: "sync-2",
    providerAccountId: "@second",
    botId: "bot-1",
  });
  const [firstComplete, secondComplete] = await Promise.all([first, second]);

  assert.equal(firstComplete.ok, true);
  assert.equal(secondComplete.ok, true);
  assert.equal(secondComplete.provider_account_id, "@second");
  assert.equal(bridge.posts.filter((post) => post.type === "recovery_complete").length, 2);
});

test("LINE OA cannot use a configured bot ID to bypass current access", async () => {
  const bridge = createBridge();

  const complete = await bridge.sync({
    requestId: "sync-2",
    providerAccountId: "line-oa-account-2",
    botId: "bot-1",
  });

  assert.equal(complete.ok, false);
  assert.equal(complete.provider_account_id, "line-oa-account-2");
  assert.equal(bridge.requests.some((url) => url.pathname === "/api/v2/bots/bot-1/chats"), false);
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
    provider_account_id: "@exampleoa",
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
  assert.deepEqual(plain(status.command_capabilities_by_account), { "@exampleoa": ["send_text", "send_image", "send_video", "send_file", "send_sticker"] });
  bridge.dispose();
});

test("LINE OA sends without a training message for an accessible account from one tab", async () => {
  const bridge = createBridge({ availableAccounts: [{ botId: "bot-1", basicSearchId: "@other" }] });
  for (const command of [
    { command_type: "send_text", text: "hello" },
    { command_type: "send_image", image_bytes: new Uint8Array([1]).buffer, image_type: "image/png" },
    { command_type: "send_sticker", package_id: "1", sticker_id: "2" },
  ]) {
    const result = await bridge.sendCommand({ ...command, browser_provider_account_id: "@other" });
    assert.equal(result.ok, true);
  }
  assert.deepEqual(bridge.sentPayloads.map(p => JSON.parse(p.body).type), ["text", undefined, "sticker"]);
  bridge.dispose();
});

test("LINE OA acknowledges an accepted send with no response ID without inventing a provider ID", async () => {
  for (const sendResponseBody of [null, {}]) {
    const bridge = createBridge({ sendResponseBody });
    const result = await bridge.sendCommand({ command_type: "send_text", text: "accepted" });
    const submitted = JSON.parse(bridge.sentPayloads[0].body);
    assert.equal(result.ok, false);
    assert.equal(result.uncertain, true);
    assert.match(submitted.sendId, /^chat-1_\d+_\d{8}$/);
    assert.equal(result.provider_message_id, undefined);
    bridge.dispose();
  }
});

test("LINE OA uses the Admin client message ID as its send correlation ID", async () => {
  const bridge = createBridge({ sendResponseBody: null });

  const result = await bridge.sendCommand({
    command_type: "send_sticker",
    package_id: "1669",
    sticker_id: "31690",
    client_message_id: "admin-client-message-1",
  });

  const submitted = JSON.parse(bridge.sentPayloads[0].body);
  assert.equal(submitted.sendId, "admin-client-message-1");
  assert.equal(result.provider_message_id, undefined);
  bridge.dispose();
});

for (const command_type of ["send_video", "send_file"]) {
  test(`LINE OA uploads ${command_type} bytes and sends the returned token with the caller ID`, async () => {
    const bridge = createBridge();
    const result = await bridge.sendCommand({ command_type, media_bytes: new Uint8Array([4, 5, 6]).buffer,
      media_type: command_type === "send_video" ? "video/mp4" : "application/pdf", file_name: "attachment.pdf", client_message_id: "media-send" });
    assert.equal(result.ok, true);
    assert.equal(bridge.uploads.length, 1);
    assert.equal(bridge.uploads[0].headers["content-type"], undefined);
    assert.equal(bridge.uploads[0].body.get("file").name, "attachment.pdf");
    assert.deepEqual(JSON.parse(bridge.sentPayloads[0].body), { items: [{ sendId: "media-send", contentMessageToken: "upload-token" }] });
    bridge.dispose();
  });
}

test("LINE OA never submits media after upload failure or a missing token", async () => {
  for (const options of [{ uploadStatus: 413 }, { uploadBody: {} }]) {
    const bridge = createBridge(options);
    const result = await bridge.sendCommand({ command_type: "send_file", media_bytes: new Uint8Array([1]).buffer,
      media_type: "application/pdf", file_name: "report.pdf" });
    assert.equal(result.ok, false);
    assert.equal(result.uncertain, false);
    assert.equal(bridge.sentPayloads.length, 0);
    bridge.dispose();
  }
});

test("LINE OA rejects expired media before uploading or sending", async () => {
  const bridge = createBridge();
  const result = await bridge.sendCommand({ command_type: "send_file", deadline_at_ms: Date.now() - 1,
    media_bytes: new Uint8Array([1]).buffer, media_type: "application/pdf", file_name: "report.pdf" });
  assert.equal(result.ok, false);
  assert.equal(result.uncertain, false);
  assert.equal(bridge.uploads.length, 0);
  assert.equal(bridge.sentPayloads.length, 0);
  bridge.dispose();
});

test("LINE OA does not submit a token when the deadline expires during upload", async () => {
  const bridge = createBridge({ uploadDelayMs: 30 });
  const result = await bridge.sendCommand({ command_type: "send_file", deadline_at_ms: Date.now() + 15,
    media_bytes: new Uint8Array([1]).buffer, media_type: "application/pdf", file_name: "report.pdf" });
  assert.equal(result.ok, false);
  assert.equal(result.uncertain, false);
  assert.equal(bridge.uploads.length, 1);
  assert.equal(bridge.sentPayloads.length, 0);
  bridge.dispose();
});

test("LINE OA rejects empty media, unsupported images, and unnamed files before upload", async () => {
  for (const command of [
    { command_type: "send_file", media_bytes: new ArrayBuffer(0), file_name: "empty.pdf" },
    { command_type: "send_image", image_bytes: new Uint8Array([1]).buffer, image_type: "image/webp" },
    { command_type: "send_file", media_bytes: new Uint8Array([1]).buffer, media_type: "application/pdf" },
  ]) {
    const bridge = createBridge();
    const result = await bridge.sendCommand(command);
    assert.equal(result.ok, false);
    assert.equal(result.uncertain, false);
    assert.equal(bridge.uploads.length, 0);
    assert.equal(bridge.sentPayloads.length, 0);
    bridge.dispose();
  }
});

test("LINE OA sends native all mentions and clears learned mentions on later plain replies", async () => {
  const bridge = createBridge();
  await bridge.captureManualSend({ type: "textV2", text: "{old}", substitution: {
    old: { type: "mention", mentionee: { type: "user", userId: "Uold" } },
  } });
  const result = await bridge.sendCommand({ command_type: "send_text", text: "@All hello", text_v2: {
    text: "{everyone} hello", substitution: { everyone: { type: "mention", mentionee: { type: "all" } } },
  } });
  assert.equal(result.ok, true);
  const payload = JSON.parse(bridge.sentPayloads.at(-1).body);
  assert.equal(payload.type, "textV2");
  assert.equal(payload.text, "{everyone} hello");
  assert.deepEqual(payload.substitution, { everyone: { type: "mention", mentionee: { type: "all" } } });
  await bridge.sendCommand({ command_type: "send_text", text: "plain reply" });
  const plainPayload = JSON.parse(bridge.sentPayloads.at(-1).body);
  assert.equal(plainPayload.type, "text");
  assert.equal(plainPayload.text, "plain reply");
  assert.equal(plainPayload.substitution, undefined);
});

test("LINE OA rejects malformed mention commands before sending", async () => {
  const bridge = createBridge();
  const result = await bridge.sendCommand({ command_type: "send_text", text: "@All", text_v2: {
    text: "{everyone}", substitution: { everyone: { type: "mention", mentionee: { type: "invalid" } } },
  } });
  assert.equal(result.ok, false);
  assert.equal(bridge.sentPayloads.length, 0);
});


test("LINE OA stale checkpoints cannot import messages older than 5 days", async () => {
  const bridge = createBridge();
  const complete = await bridge.sync({
    checkpoint: { watermark: "1970-01-01T00:00:00.900Z" },
    now: 6 * 24 * 60 * 60 * 1_000,
  });
  assert.equal(complete.ok, true);
  assert.equal(complete.recovered, 0);
  assert.equal(bridge.posts.some(post => post.type === "recovery_batch"), false);
  assert.equal(bridge.requests.some(url => url.searchParams.has("backward")), false);
});


test("LINE OA initial setup excludes two-day-old history", async () => {
  const bridge = createBridge({ chatCount: 1 });
  const complete = await bridge.sync({ now: 2 * 24 * 60 * 60 * 1_000 + 2_000 });
  assert.equal(complete.ok, true);
  assert.equal(complete.recovered, 0);
  assert.equal(bridge.posts.some(post => post.type === "recovery_batch"), false);
});

test("LINE OA reconnect includes two-day-old messages within the five-day maximum", async () => {
  const bridge = createBridge({ chatCount: 1 });
  const complete = await bridge.sync({
    now: 2 * 24 * 60 * 60 * 1_000 + 2_000,
    checkpoint: { watermark: "1970-01-01T00:00:00.900Z" },
  });
  assert.equal(complete.ok, true);
  assert.equal(complete.recovered, 2);
  const messages = bridge.posts.filter(post => post.type === "recovery_batch")
    .flatMap(post => post.body.conversations.flatMap(chat => chat.messages));
  assert.deepEqual(messages.map(message => message.id), ["message-1", "message-2"]);
});


test("LINE OA 400 diagnostics preserve only safe codes and payload field names", async () => {
  const bridge = createBridge({ sendStatus: 400, sendResponseBody: {
    code: "INVALID_ARGUMENT", message: "secret customer message https://private.invalid?token=secret",
    details: [{ property: "sendId", message: "secret token" }, { field: "customer-secret" }],
  } });
  const result = await bridge.sendCommand({ command_type: "send_text", text: "private text", client_message_id: "12345678-1234-1234-1234-123456789abc" });
  assert.equal(result.ok, false);
  assert.deepEqual(plain(result.diagnostics), {
    diagnostic_version: 1, provider: "line_oa", operation: "send", command_type: "send_text",
    http_status: 400, response_format: "json", native_attempted: true, delivery_uncertain: false,
    failure_kind: "provider_rejection", provider_duration_ms: result.diagnostics.provider_duration_ms,
    client_id_is_uuid: true, template_source: "derived", provider_code_present: true,
    native_error_code: "INVALID_ARGUMENT", validation_fields: ["sendId"],
  });
  assert.doesNotMatch(JSON.stringify(result), /secret|private|customer/);
  assert.equal(bridge.sentPayloads.length, 1);
});

test("LINE OA non-JSON failure has status and format without exposing the response", async () => {
  const bridge = createBridge({ sendStatus: 502, sendNonJson: true });
  const result = await bridge.sendCommand({ command_type: "send_text", text: "private text" });
  assert.equal(result.diagnostics.http_status, 502);
  assert.equal(result.diagnostics.response_format, "non_json");
  assert.equal(result.diagnostics.native_attempted, true);
  assert.doesNotMatch(JSON.stringify(result), /secret|private/);
  assert.equal(bridge.sentPayloads.length, 1);
});

test("LINE OA upload rejection records safe diagnostics and never attempts a send", async () => {
  const bridge = createBridge({ uploadStatus: 400, uploadBody: { errorCode: "secret-token-123", errors: [{ field: "file", message: "private upload" }] } });
  const result = await bridge.sendCommand({ command_type: "send_video", media_bytes: new ArrayBuffer(4), media_type: "video/mp4" });
  assert.equal(result.diagnostics.operation, "upload");
  assert.equal(result.diagnostics.http_status, 400);
  assert.equal(result.diagnostics.native_attempted, false);
  assert.equal(result.diagnostics.delivery_uncertain, false);
  assert.equal(result.diagnostics.provider_code_present, true);
  assert.equal(result.diagnostics.native_error_code, undefined);
  assert.deepEqual(plain(result.diagnostics.validation_fields), ["file"]);
  assert.doesNotMatch(JSON.stringify(result), /secret|private/);
  assert.equal(bridge.sentPayloads.length, 0);
});


test("LINE OA send timeout records uncertainty and never retries", async () => {
  const error = new Error("secret transport details");
  error.name = "TimeoutError";
  const bridge = createBridge({ sendError: error });
  const result = await bridge.sendCommand({ command_type: "send_text", text: "private text" });
  assert.equal(result.uncertain, true);
  assert.equal(result.diagnostics.timed_out, true);
  assert.equal(result.diagnostics.error_name, "TimeoutError");
  assert.equal(result.diagnostics.failure_kind, "transport_failure");
  assert.equal(result.diagnostics.native_attempted, true);
  assert.equal(bridge.sentPayloads.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /secret|private/);
});

test("LINE OA account resolution failure returns diagnostics instead of an unhandled rejection", async () => {
  const bridge = createBridge({ basicId: "", accountError: new TypeError("secret account request") });
  const result = await bridge.sendCommand({ command_type: "send_text", browser_provider_account_id: "@otheroa", text: "private text" });
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics.operation, "initialize");
  assert.equal(result.diagnostics.failure_kind, "pre_dispatch_failure");
  assert.equal(result.diagnostics.timed_out, false);
  assert.equal(result.diagnostics.error_name, "TypeError");
  assert.equal(result.diagnostics.native_attempted, false);
  assert.equal(bridge.sentPayloads.length, 0);
  assert.doesNotMatch(JSON.stringify(result), /secret|private/);
});


test("LINE OA detection failures publish safe initialization diagnostics", async () => {
  const bridge = createBridge({ accountError: new TypeError("private account token") });
  const result = await bridge.detect();
  assert.equal(result.type, "account_detection_failed");
  assert.equal(result.diagnostics.operation, "initialize");
  assert.equal(result.diagnostics.error_name, "TypeError");
  assert.doesNotMatch(JSON.stringify(result), /private|token/);
});

test("LINE OA recovery failures publish safe recovery diagnostics", async () => {
  const bridge = createBridge({ chatError: new TypeError("private chat token") });
  const result = await bridge.sync();
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics.operation, "recovery");
  assert.equal(result.diagnostics.error_name, "TypeError");
  assert.doesNotMatch(JSON.stringify(result), /private|token/);
});

test("LINE OA confirmation errors do not report the successful send HTTP status", async () => {
  const bridge = createBridge({ confirmError: new TypeError("private history token") });
  const result = await bridge.sendCommand({ command_type: "send_text", text: "private text" });
  assert.equal(result.diagnostics.operation, "confirm");
  assert.equal(result.diagnostics.http_status, undefined);
  assert.equal(result.diagnostics.response_format, undefined);
  assert.equal(result.diagnostics.delivery_uncertain, true);
  assert.equal(bridge.sentPayloads.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /private|token/);
});


async function settleBridge() {
  for (let index = 0; index < 12; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

function startAccount(bridge, account, requestId = `sync-${account}`) {
  bridge.dispatch({ type: "sync_v3", request_id: requestId, provider_account_id: account, bot_id: "bot-1" });
}

function lastPollingStatus(bridge) {
  return plain(bridge.posts.filter((post) => post.type === "provider_status").at(-1));
}

test("LINE OA restores and continuously polls three accounts from one tab", async () => {
  const bridge = createBridge({ availableAccounts: ["@first", "@second", "@third"].map((basicSearchId) => ({ basicSearchId, botId: "bot-1" })), chatCount: 0 });
  for (const account of ["@first", "@second", "@third"]) startAccount(bridge, account);
  await settleBridge();
  assert.deepEqual(lastPollingStatus(bridge).provider_polling_account_ids, ["@first", "@second", "@third"]);
  assert.equal(bridge.posts.filter((post) => post.type === "recovery_complete" && post.ok).length, 3);
  assert.equal(bridge.intervalCount, 1);
  bridge.tick();
  await settleBridge();
  const periodic = bridge.posts.filter((post) => post.type === "recovery_complete" && post.request_id.startsWith("poll:"));
  assert.deepEqual(periodic.map((post) => post.provider_account_id), ["@first", "@second", "@third"]);
  bridge.dispose();
});

test("LINE OA scoped cancellation preserves other active and queued account polling", async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let blockNext = true;
  const bridge = createBridge({ availableAccounts: ["@first", "@second", "@third"].map((basicSearchId) => ({ basicSearchId, botId: "bot-1" })), chatCount: 0, beforeChatRequest: async () => { if (blockNext) { blockNext = false; await blocked; } } });
  startAccount(bridge, "@first");
  startAccount(bridge, "@second");
  startAccount(bridge, "@third");
  await settleBridge();
  bridge.dispatch({ type: "cancel_sync_v3", provider_account_id: "@second", request_id: "sync-@second" });
  assert.deepEqual(lastPollingStatus(bridge).provider_polling_account_ids, ["@first", "@third"]);
  bridge.dispatch({ type: "cancel_sync_v3", request_id: "sync-@first" });
  await settleBridge();
  assert.deepEqual(lastPollingStatus(bridge).provider_polling_account_ids, ["@third"]);
  assert.ok(bridge.posts.some((post) => post.type === "recovery_complete" && post.provider_account_id === "@third" && post.ok));
  release();
  await settleBridge();
  assert.equal(bridge.posts.some((post) => post.type === "recovery_complete" && ["@first", "@second"].includes(post.provider_account_id)), false);
  bridge.tick();
  await settleBridge();
  assert.ok(bridge.posts.some((post) => post.type === "recovery_complete" && post.request_id.startsWith("poll:") && post.provider_account_id === "@third"));
  bridge.dispose();
});

test("LINE OA stale cancellation cannot stop a replacement request or completed account polling", async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let blockNext = true;
  const bridge = createBridge({ availableAccounts: ["@first", "@second", "@third"].map((basicSearchId) => ({ basicSearchId, botId: "bot-1" })), chatCount: 0, beforeChatRequest: async () => { if (blockNext) { blockNext = false; await blocked; } } });
  startAccount(bridge, "@first", "old");
  await settleBridge();
  bridge.dispatch({ type: "cancel_sync_v3", provider_account_id: "@first", request_id: "old" });
  startAccount(bridge, "@first", "replacement");
  bridge.dispatch({ type: "cancel_sync_v3", provider_account_id: "@first", request_id: "old" });
  bridge.dispatch({ type: "cancel_sync_v3", request_id: "unknown" });
  await settleBridge();
  assert.ok(bridge.posts.some((post) => post.type === "recovery_complete" && post.request_id === "replacement" && post.ok));
  bridge.dispatch({ type: "cancel_sync_v3", provider_account_id: "@first", request_id: "replacement" });
  assert.deepEqual(lastPollingStatus(bridge).provider_polling_account_ids, ["@first"]);
  assert.equal(bridge.intervalCount, 1);
  release();
  await settleBridge();
  assert.equal(bridge.posts.some((post) => post.type === "recovery_complete" && post.request_id === "old"), false);
  bridge.dispose();
});

test("LINE OA global stop clears every polling registration and reports inactive", async () => {
  const bridge = createBridge({ availableAccounts: ["@first", "@second", "@third"].map((basicSearchId) => ({ basicSearchId, botId: "bot-1" })), chatCount: 0 });
  for (const account of ["@first", "@second", "@third"]) startAccount(bridge, account);
  await settleBridge();
  bridge.dispatch({ type: "cancel_sync_v3" });
  assert.equal(lastPollingStatus(bridge).provider_polling_active, false);
  assert.deepEqual(lastPollingStatus(bridge).provider_polling_account_ids, []);
  assert.equal(bridge.intervalCount, 0);
  const count = bridge.requests.length;
  bridge.tick();
  await settleBridge();
  assert.equal(bridge.requests.length, count);
  bridge.dispose();
});


test("LINE OA queued recoveries stay active without masking a stalled active request", async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let blockNext = true;
  const bridge = createBridge({ availableAccounts: ["@first", "@second", "@third"].map((basicSearchId) => ({ basicSearchId, botId: "bot-1" })), chatCount: 0, beforeChatRequest: async () => { if (blockNext) { blockNext = false; await blocked; } } });
  startAccount(bridge, "@first", "active");
  startAccount(bridge, "@second", "queued");
  startAccount(bridge, "@third", "poll:periodic");
  await settleBridge();
  bridge.posts.length = 0;
  for (let tick = 0; tick < 5; tick += 1) bridge.tick();
  const activity = bridge.posts.filter((post) => post.type === "recovery_activity");
  assert.equal(activity.length, 5);
  assert.deepEqual(activity.map((post) => [post.request_id, post.provider_account_id]), Array.from({ length: 5 }, () => ["queued", "@second"]));
  release();
  await settleBridge();
  assert.ok(bridge.posts.some((post) => post.type === "recovery_complete" && post.request_id === "queued" && post.ok));
  bridge.dispose();
});


test("LINE access refresh removes revoked polling but preserves another account", async () => {
  const accounts = ["@first", "@second"].map((basicSearchId) => ({ basicSearchId, botId: "bot-1" }));
  const bridge = createBridge({ availableAccounts: accounts, chatCount: 0 });
  startAccount(bridge, "@first");
  startAccount(bridge, "@second");
  await settleBridge();
  bridge.setAccounts([accounts[0]]);
  await bridge.detect();
  assert.deepEqual(lastPollingStatus(bridge).accessible_account_ids, ["@first"]);
  assert.deepEqual(lastPollingStatus(bridge).provider_polling_account_ids, ["@first"]);
  bridge.tick();
  await settleBridge();
  assert.ok(bridge.posts.some((post) => post.type === "recovery_complete" && post.request_id.startsWith("poll:") && post.provider_account_id === "@first" && post.ok));
  bridge.dispose();
});

test("LINE account-list failure marks access unknown without revoking known accounts", async () => {
  const bridge = createBridge({ chatCount: 0 });
  await bridge.sync();
  bridge.setAccountError(new Error("network unavailable"));
  await bridge.detect();
  assert.equal(lastPollingStatus(bridge).account_access_verified, false);
  assert.deepEqual(lastPollingStatus(bridge).accessible_account_ids, ["@exampleoa"]);
  assert.deepEqual(lastPollingStatus(bridge).provider_polling_account_ids, ["@exampleoa"]);
  bridge.setAccountError(null);
  bridge.setAccounts([]);
  await bridge.detect();
  assert.equal(lastPollingStatus(bridge).account_access_verified, true);
  assert.deepEqual(lastPollingStatus(bridge).accessible_account_ids, []);
  assert.deepEqual(lastPollingStatus(bridge).provider_polling_account_ids, []);
  bridge.dispose();
});

test("LINE sync failure does not revoke access or block a second accessible account", async () => {
  let requests = 0;
  const bridge = createBridge({
    availableAccounts: ["@first", "@second"].map((basicSearchId) => ({ basicSearchId, botId: "bot-1" })),
    chatCount: 0,
    beforeChatRequest: () => { if (++requests === 1) throw new Error("temporary failure"); },
  });
  startAccount(bridge, "@first");
  startAccount(bridge, "@second");
  await settleBridge();
  assert.equal(bridge.posts.find((post) => post.type === "recovery_complete" && post.provider_account_id === "@first").ok, false);
  assert.equal(bridge.posts.find((post) => post.type === "recovery_complete" && post.provider_account_id === "@second").ok, true);
  assert.deepEqual(lastPollingStatus(bridge).accessible_account_ids, ["@first", "@second"]);
  assert.equal(lastPollingStatus(bridge).account_access_verified, true);
  bridge.dispose();
});
