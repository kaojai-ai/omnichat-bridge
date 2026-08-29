import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../extension/shopee-realtime.js", import.meta.url), "utf8");
const urlSource = await readFile(new URL("../extension/lib/shopee-url.js", import.meta.url), "utf8");
const adaptersSource = await readFile(new URL("../extension/lib/provider-adapters.js", import.meta.url), "utf8");
const shopeeAdapterSource = await readFile(new URL("../extension/lib/shopee-adapter.js", import.meta.url), "utf8");
const origin = "https://seller.shopee.co.th";
const plain = (value) => JSON.parse(JSON.stringify(value));

function createBridge() {
  const listeners = [];
  const posts = [];
  const sent = [];
  const window = {
    location: { origin, href: `${origin}/new-webchat/conversations` },
    fetch: async () => ({ ok: true }),
    addEventListener(type, listener) {
      if (type === "message") listeners.push(listener);
    },
    postMessage(message) {
      posts.push(message);
    },
    __CHAT_GLOBAL__: {},
    __chat_anti_fraud__: {
      poster: async (_url, payload) => {
        sent.push(payload);
        return {
          ok: true,
          clone: () => ({ json: async () => ({ id: "provider-message-1" }) }),
        };
      },
    },
    __omnichatRealtimeState: {
      nativeFetch: async () => ({
        ok: true,
        json: async () => ({
          url: "https://cdn.example.com/reply.jpg",
          thumbnail: "https://cdn.example.com/reply-thumb.jpg",
        }),
      }),
      conversationsById: new Map([
        ["conversation-1", { conversation_id: "conversation-1", shop_id: "shop-1", to_id: "buyer-1", biz_id: "0" }],
      ]),
      sendTemplate: {
        url: `${origin}/webchat/api/v1.2/messages?csrf_token=test`,
        headers: { "content-type": "application/json" },
        payload: { content: { uid: "template" } },
      },
      sendErrorsByClientMessageId: new Map(),
    },
  };
  const context = vm.createContext({
    window,
    document: { documentElement: { dataset: {} } },
    URL,
    Headers,
    Request,
    FormData,
    Blob,
    ArrayBuffer,
    Uint8Array,
    structuredClone,
    setInterval: () => 0,
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(urlSource, context);
  vm.runInContext(adaptersSource, context);
  vm.runInContext(shopeeAdapterSource, context);
  vm.runInContext(source, context);

  async function send(message) {
    const before = sent.length;
    for (const listener of listeners) {
      listener({
        source: window,
        origin,
        data: { source: "omnichat-realtime-bridge", type: "send_api", ...message },
      });
    }
    await new Promise((resolve) => setImmediate(resolve));
    return {
      payload: sent[before],
      result: posts.findLast((post) => post.type === "api_send_result" && post.request_id === message.request_id),
    };
  }

  return { send };
}

const baseCommand = {
  request_id: "request-1",
  conversation_id: "conversation-1",
  client_message_id: "client-1",
};

test("maps a quoted text command to Shopee content.quoted_msg_id", async () => {
  const bridge = createBridge();
  const { payload, result } = await bridge.send({
    ...baseCommand,
    command_type: "send_text",
    text: "Hello",
    reply_to_provider_message_id: "quoted-message-1",
  });

  assert.equal(result.ok, true);
  assert.deepEqual(plain(payload.content), {
    text: "Hello",
    uid: "client-1",
    quoted_msg_id: "quoted-message-1",
  });
});

test("maps a quoted image command without losing uploaded image content", async () => {
  const bridge = createBridge();
  const { payload, result } = await bridge.send({
    ...baseCommand,
    request_id: "request-image-1",
    client_message_id: "client-image-1",
    command_type: "send_image",
    image_bytes: new Uint8Array([1, 2, 3]).buffer,
    image_type: "image/jpeg",
    reply_to_provider_message_id: "quoted-message-2",
  });

  assert.equal(result.ok, true);
  assert.equal(payload.content.url, "https://cdn.example.com/reply.jpg");
  assert.equal(payload.content.uid, "client-image-1");
  assert.equal(payload.content.quoted_msg_id, "quoted-message-2");
});

test("omits quote metadata for an ordinary text command", async () => {
  const bridge = createBridge();
  const { payload, result } = await bridge.send({
    ...baseCommand,
    request_id: "request-plain-1",
    client_message_id: "client-plain-1",
    command_type: "send_text",
    text: "Hello",
  });

  assert.equal(result.ok, true);
  assert.deepEqual(plain(payload.content), { text: "Hello", uid: "client-plain-1" });
});

test("rejects an invalid quote target instead of sending unquoted", async () => {
  const bridge = createBridge();
  const { payload, result } = await bridge.send({
    ...baseCommand,
    request_id: "request-invalid-1",
    command_type: "send_text",
    text: "Hello",
    reply_to_provider_message_id: "  ",
  });

  assert.equal(payload, undefined);
  assert.deepEqual(plain(result), {
    source: "omnichat-realtime-bridge",
    type: "api_send_result",
    request_id: "request-invalid-1",
    ok: false,
    error: "Reply quote is invalid.",
  });
});
