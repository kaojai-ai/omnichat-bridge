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

function createBridge({ sellerCentre = false, ready = true } = {}) {
  const listeners = [];
  const posts = [];
  const sent = [];
  const sentUrls = [];
  const nativeRequests = [];
  const sendPath = sellerCentre ? "/webchat/api/v1.2/mini/messages" : "/webchat/api/v1.2/messages";
  const window = {
    location: { origin, href: `${origin}${sellerCentre ? "/portal/chat-management" : "/new-webchat/conversations"}` },
    fetch: async () => ({ ok: true }),
    addEventListener(type, listener) {
      if (type === "message") listeners.push(listener);
    },
    postMessage(message) {
      posts.push(message);
    },
    __CHAT_GLOBAL__: {},
    __chat_anti_fraud__: {
      poster: async (url, payload) => {
        sentUrls.push(url);
        sent.push(payload);
        return {
          ok: true,
          clone: () => ({ json: async () => ({ id: "provider-message-1" }) }),
        };
      },
    },
    __omnichatRealtimeState: {
      nativeFetch: async (input) => {
        nativeRequests.push(new URL(input.url ?? input, origin).pathname);
        return {
          ok: true,
          json: async () => ({
            url: "https://cdn.example.com/reply.jpg",
            thumbnail: "https://cdn.example.com/reply-thumb.jpg",
          }),
        };
      },
      surface: sellerCentre ? "seller-centre" : "legacy",
      listTemplate: sellerCentre && ready ? {
        url: `${origin}/webchat/api/v1.2/mini/conversations?csrf_token=test`,
        init: { method: "POST", headers: { "content-type": "application/json" } },
        body: new TextEncoder().encode("{}").buffer,
      } : null,
      getTemplate: sellerCentre && ready ? {
        url: `${origin}/webchat/api/v1.2/mini/user/setting?csrf_token=test`,
        init: { method: "GET", headers: {} },
        body: null,
      } : null,
      conversationsById: new Map([
        ["conversation-1", { conversation_id: "conversation-1", shop_id: "shop-1", to_id: "buyer-1", biz_id: "0" }],
      ]),
      sendTemplate: {
        url: `${origin}${sendPath}?csrf_token=test`,
        headers: { "content-type": "application/json" },
        payload: sellerCentre ? {
          request_id: "template-request",
          type: "text",
          conversation_id: "conversation-1",
          shop_id: 1,
          to_id: 2,
          biz_id: 0,
          content: { uid: "template" },
          choice_info: { real_shop_id: 1 },
          source: "minichat",
        } : { content: { uid: "template" } },
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
        data: { source: "omnichat-realtime-bridge-v2", type: "send_api_v2", ...message },
      });
    }
    await new Promise((resolve) => setImmediate(resolve));
    return {
      payload: sent[before],
      result: posts.findLast((post) => post.type === "api_send_result" && post.request_id === message.request_id),
    };
  }

  return { send, sentUrls, nativeRequests };
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
    source: "omnichat-realtime-bridge-v2",
    type: "api_send_result",
    request_id: "request-invalid-1",
    ok: false,
    error: "Reply quote is invalid.",
  });
});

test("sends Seller Centre text through the mini endpoint", async () => {
  const bridge = createBridge({ sellerCentre: true });
  const { payload, result } = await bridge.send({
    ...baseCommand,
    request_id: "seller-text-1",
    client_message_id: "seller-client-1",
    command_type: "send_text",
    text: "Seller Centre hello",
  });

  assert.equal(result.ok, true);
  assert.equal(new URL(bridge.sentUrls[0]).pathname, "/webchat/api/v1.2/mini/messages");
  assert.equal(payload.source, "minichat");
  assert.equal(payload.choice_info.real_shop_id, 1);
  assert.equal(payload.content.text, "Seller Centre hello");
});

test("keeps Seller Centre image and product replies on the new request profile", async () => {
  const imageBridge = createBridge({ sellerCentre: true });
  const image = await imageBridge.send({
    ...baseCommand,
    request_id: "seller-image-1",
    client_message_id: "seller-image-client-1",
    command_type: "send_image",
    image_bytes: new Uint8Array([1, 2, 3]).buffer,
    image_type: "image/jpeg",
  });
  assert.equal(image.result.ok, true);
  assert.equal(imageBridge.nativeRequests.includes("/webchat/api/coreapi/v1.2/images"), true);
  assert.equal(new URL(imageBridge.sentUrls[0]).pathname, "/webchat/api/v1.2/mini/messages");
  assert.equal(image.payload.type, "image");

  const productBridge = createBridge({ sellerCentre: true });
  const product = await productBridge.send({
    ...baseCommand,
    request_id: "seller-product-1",
    client_message_id: "seller-product-client-1",
    command_type: "send_product",
    provider_product_id: "12345",
    product_name: "Test product",
  });
  assert.equal(product.result.ok, true);
  assert.equal(new URL(productBridge.sentUrls[0]).pathname, "/webchat/api/v1.2/mini/messages");
  assert.equal(product.payload.type, "product");
  assert.equal(product.payload.content.product_id, 12345);
});

test("fails explicitly when Seller Centre capabilities are not initialized", async () => {
  const bridge = createBridge({ sellerCentre: true, ready: false });
  const { payload, result } = await bridge.send({
    ...baseCommand,
    request_id: "seller-unready-1",
    client_message_id: "seller-unready-client-1",
    command_type: "send_text",
    text: "Should not send",
  });
  assert.equal(payload, undefined);
  assert.equal(result.ok, false);
  assert.match(result.error, /Seller Centre chat is still initializing/);
});
