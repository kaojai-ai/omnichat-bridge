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

function createBridge({ sellerCentre = false, ready = true, secureSender = true, nativeSender = true } = {}) {
  const listeners = [];
  const posts = [];
  const sent = [];
  const sentUrls = [];
  const nativeRequests = [];
  const nativeRequestHeaders = [];
  const nativePayloads = [];
  const sendPath = sellerCentre ? "/webchat/api/v1.2/mini/messages" : "/webchat/api/v1.2/messages";
  const jsonResponse = (body) => ({
    ok: true,
    status: 200,
    clone: () => ({ json: async () => body }),
    json: async () => body,
  });
  const window = {
    location: { origin, href: `${origin}${sellerCentre ? "/portal/chat-management" : "/new-webchat/conversations"}` },
    fetch: async () => ({ ok: true }),
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
    ...((!sellerCentre && secureSender) ? {
      __chat_anti_fraud__: {
        poster: async (url, payload) => {
          sentUrls.push(url);
          sent.push(payload);
          return jsonResponse({ id: "provider-message-1" });
        },
      },
    } : {}),
    __omnichatRealtimeState: {
      nativeFetch: async (input) => {
        const request = input instanceof Request ? input : new Request(input, {});
        const path = new URL(request.url, origin).pathname;
        nativeRequests.push(path);
        nativeRequestHeaders.push(Object.fromEntries(request.headers.entries()));
        if (path === "/webchat/api/v1.2/mini/messages") {
          nativePayloads.push(await request.clone().json());
          return jsonResponse({ id: "provider-native-message-1" });
        }
        return jsonResponse({
          url: "https://cdn.example.com/reply.jpg",
          thumbnail: "https://cdn.example.com/reply-thumb.jpg",
        });
      },
      surface: sellerCentre ? "seller-centre" : "legacy",
      listTemplate: sellerCentre && ready ? {
        url: `${origin}/webchat/api/v1.2/mini/conversations?csrf_token=test`,
        init: { method: "POST", headers: { "content-type": "application/json" } },
        body: new TextEncoder().encode("{}").buffer,
      } : null,
      getTemplate: sellerCentre && ready ? {
        url: `${origin}/webchat/api/v1.2/mini/user/setting?csrf_token=test`,
        init: {
          method: "GET",
          headers: { authorization: "Bearer seller-test", "x-shop-region": "TH" },
          credentials: "include",
          mode: "cors",
        },
        body: null,
      } : null,
      conversationsById: new Map([
        ["conversation-1", { conversation_id: "conversation-1", shop_id: "shop-1", to_id: "buyer-1", biz_id: "0" }],
      ]),
      sendTemplate: sellerCentre ? null : {
        url: `${origin}${sendPath}?csrf_token=test`,
        headers: { "content-type": "application/json" },
        payload: { content: { uid: "template" } },
      },
      sendErrorsByClientMessageId: new Map(),
    },
  };
  if (!nativeSender) window.__omnichatRealtimeState.nativeFetch = null;
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
    clearInterval,
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
        data: { source: "omnichat-realtime-bridge-v3", type: "send_api_v3", ...message },
      });
    }
    await new Promise((resolve) => setImmediate(resolve));
    return {
      payload: sent[before],
      result: posts.findLast((post) => post.type === "api_send_result" && post.request_id === message.request_id),
    };
  }

  return {
    send,
    sentUrls,
    nativeRequests,
    nativeRequestHeaders,
    nativePayloads,
    reattach() {
      vm.runInContext(source, context);
    },
    get messageListenerCount() { return listeners.length; },
  };
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

test("sends once after the page bridge is reattached", async () => {
  const bridge = createBridge();

  bridge.reattach();
  assert.equal(bridge.messageListenerCount, 1);
  const { result } = await bridge.send({
    ...baseCommand,
    request_id: "request-reattached-1",
    client_message_id: "client-reattached-1",
    command_type: "send_text",
    text: "Only once",
  });

  assert.equal(result.ok, true);
  assert.equal(bridge.sentUrls.length, 1);
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
    source: "omnichat-realtime-bridge-v3",
    type: "api_send_result",
    request_id: "request-invalid-1",
    ok: false,
    error: "Reply quote is invalid.",
  });
});

test("sends Seller Centre text through the mini endpoint", async () => {
  const bridge = createBridge({ sellerCentre: true });
  const { result } = await bridge.send({
    ...baseCommand,
    request_id: "seller-text-1",
    client_message_id: "seller-client-1",
    command_type: "send_text",
    text: "Seller Centre hello",
  });

  assert.equal(result.ok, true);
  assert.deepEqual(bridge.sentUrls, []);
  assert.equal(bridge.nativeRequests.at(-1), "/webchat/api/v1.2/mini/messages");
  assert.equal(bridge.nativeRequestHeaders.at(-1).authorization, "Bearer seller-test");
  assert.equal(bridge.nativeRequestHeaders.at(-1)["x-shop-region"], "TH");
  assert.equal(bridge.nativePayloads.at(-1).conversation_id, "conversation-1");
  assert.equal(bridge.nativePayloads.at(-1).source, "minichat");
  assert.equal(bridge.nativePayloads.at(-1).choice_info.real_shop_id, "shop-1");
  assert.equal(bridge.nativePayloads.at(-1).content.text, "Seller Centre hello");
  assert.equal(result.provider_message_id, "provider-native-message-1");
  assert.equal(bridge.nativeRequests.includes("/webchat/api/v1.2/messages"), false);
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
  assert.equal(imageBridge.nativeRequests.includes("/webchat/api/v1.2/mini/messages"), true);
  assert.equal(imageBridge.nativePayloads.at(-1).type, "image");
  assert.equal(image.result.provider_message_id, "provider-native-message-1");

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
  assert.equal(productBridge.nativeRequests.at(-1), "/webchat/api/v1.2/mini/messages");
  assert.equal(productBridge.nativePayloads.at(-1).type, "product");
  assert.equal(productBridge.nativePayloads.at(-1).content.product_id, 12345);
});

test("sends a quoted Seller Centre text without the legacy secure poster", async () => {
  const bridge = createBridge({ sellerCentre: true });
  const result = await bridge.send({
    ...baseCommand,
    request_id: "seller-quoted-1",
    client_message_id: "seller-quoted-client-1",
    command_type: "send_text",
    text: "Quoted Seller Centre hello",
    reply_to_provider_message_id: "provider-message-quoted",
  });

  assert.equal(result.result.ok, true);
  assert.equal(bridge.sentUrls.length, 0);
  assert.equal(bridge.nativePayloads.at(-1).content.quoted_msg_id, "provider-message-quoted");
});

test("keeps the legacy secure-sender failure scoped to the legacy surface", async () => {
  const bridge = createBridge({ secureSender: false });
  const { payload, result } = await bridge.send({
    ...baseCommand,
    request_id: "legacy-unavailable-1",
    command_type: "send_text",
    text: "Should not send",
  });

  assert.equal(payload, undefined);
  assert.match(result.error, /secure sender is unavailable/);
  assert.equal(bridge.nativeRequests.includes("/webchat/api/v1.2/messages"), false);
});

test("reports a Seller Centre native-sender failure without falling back", async () => {
  const bridge = createBridge({ sellerCentre: true, nativeSender: false });
  const { payload, result } = await bridge.send({
    ...baseCommand,
    request_id: "seller-native-unavailable-1",
    command_type: "send_text",
    text: "Should not send",
  });

  assert.equal(payload, undefined);
  assert.match(result.error, /Seller Centre native sender is unavailable/);
  assert.deepEqual(bridge.sentUrls, []);
  assert.deepEqual(bridge.nativeRequests, []);
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
