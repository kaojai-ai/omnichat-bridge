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

function createBridge({ pathname = null, sellerCentre = false, ready = true, secureSender = true, nativeSender = true, conversationPages = null, listFailure = false, sendBody = null, cachedRouting = null, transportFailure = false, onList = null, onTemplateWait = null, videoUploader = null, imageFailure = null } = {}) {
  const listeners = [];
  const posts = [];
  const sent = [];
  const sentUrls = [];
  const nativeRequests = [];
  const listRequests = [];
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
    location: { origin, href: `${origin}${pathname ?? (sellerCentre ? "/portal/chat-management" : "/new-webchat/conversations")}` },
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
          return jsonResponse(sendBody ?? { id: "provider-message-1", message_option: 0 });
        },
      },
    } : {}),
    __omnichatRealtimeState: {
      nativeFetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const path = new URL(request.url, origin).pathname;
        nativeRequests.push(path);
        nativeRequestHeaders.push(Object.fromEntries(request.headers.entries()));
        if (path === "/webchat/api/v1.2/mini/conversations") {
          listRequests.push(request.clone());
          if (onList) return jsonResponse(await onList(request));
        }
        if (path === "/webchat/api/v1.2/mini/conversations" && conversationPages) {
          if (listFailure) return { ok: false, status: 503 };
          const page = Number(new URL(request.url).searchParams.get("page") ?? "0");
          return jsonResponse(conversationPages[page] ?? { conversations: [] });
        }
        if (path.endsWith("/images") && imageFailure) return { ok: false, status: 400, json: async () => imageFailure };
        if (path === "/webchat/api/v1.2/mini/messages") {
          nativePayloads.push(await request.clone().json());
          if (transportFailure) throw new Error("connection reset");
          return jsonResponse(sendBody ?? { id: "provider-native-message-1", message_option: 0 });
        }
        if (path === "/webchat/api/v1.2/mini/conversations") return jsonResponse({ conversations: [{
          id: "conversation-1", shop_id: "shop-1", to_id: "101", biz_id: "0",
        }] });
        return jsonResponse({
          url: "https://cdn.example.com/reply.jpg",
          thumbnail: "https://cdn.example.com/reply-thumb.jpg",
        });
      },
      surface: pathname?.startsWith("/webchat") ? "webchat" : sellerCentre ? "seller-centre" : "new-webchat",
      listTemplate: sellerCentre && ready ? {
        url: `${origin}/webchat/api/v1.2/mini/conversations?csrf_token=test${conversationPages ? "&page=0&limit=1" : ""}`,
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
      conversationsById: new Map(cachedRouting ? [["conversation-1", cachedRouting]] : conversationPages ? [] : [
        ["conversation-1", { conversation_id: "conversation-1", shop_id: "shop-1", to_id: "101", biz_id: "0" }],
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
    ...(videoUploader ? { OmnichatShopeeVideo: { upload: videoUploader } } : {}),
    window,
    document: { documentElement: { dataset: {} }, ...(onTemplateWait ? { getElementById: () => ({ getBoundingClientRect: () => ({ width: 48, height: 48 }), closest: () => ({ classList: { contains: () => true } }) }) } : {}) },
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
    AbortController,
    setTimeout: (callback, delay) => { if (delay === 250 && onTemplateWait) { void Promise.resolve(onTemplateWait(window.__omnichatRealtimeState)).then(callback); return 0; } if (delay !== 250 && delay > 0) return setTimeout(callback, delay); queueMicrotask(callback); return 0; },
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
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (posts.some((post) => post.type === "api_send_result" && post.request_id === message.request_id)) break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    return {
      payload: sent[before],
      result: posts.findLast((post) => post.type === "api_send_result" && post.request_id === message.request_id),
    };
  }

  return {
    send,
    state: window.__omnichatRealtimeState,
    listRequests,
    async observeList(body = {}) {
      await window.fetch(`${origin}/webchat/api/v1.2/mini/conversations`, { method: "POST", body: JSON.stringify(body) });
      for (let i = 0; i < 4; i += 1) await new Promise(resolve => setImmediate(resolve));
    },
    sentUrls,
    nativeRequests,
    nativeRequestHeaders,
    nativePayloads,
    posts,
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

test("finds a send route on Shopee conversation page two", async () => {
  const bridge = createBridge({ sellerCentre: true, conversationPages: [
    { conversations: [{ id: "other", shop_id: "shop-1", to_id: "199", biz_id: "0" }] },
    { conversations: [{ id: "conversation-1", shop_id: "shop-2", to_id: "102", to_shop_id: "201", biz_id: "3" }] },
  ] });
  const { result } = await bridge.send({ ...baseCommand, command_type: "send_text", text: "Hello" });
  assert.equal(result.ok, true);
  assert.equal(bridge.nativeRequests.filter((path) => path.endsWith("/mini/conversations")).length, 2);
  assert.equal(bridge.nativePayloads.length, 1);
  assert.equal(bridge.nativePayloads[0].shop_id, "shop-2");
  assert.equal(bridge.nativePayloads[0].to_id, 102);
  assert.equal(bridge.nativePayloads[0].to_shop_id, 201);
  assert.equal(bridge.nativePayloads[0].biz_id, 3);
});

test("does not send when Shopee's conversation list is exhausted", async () => {
  const bridge = createBridge({ sellerCentre: true, conversationPages: [
    { conversations: [{ id: "other", shop_id: "shop-1", to_id: "199" }] },
    { conversations: [] },
  ] });
  const { result } = await bridge.send({ ...baseCommand, command_type: "send_text", text: "Hello" });
  assert.equal(result.error_code, "SHOPEE_CONVERSATION_MISSING");
  assert.match(result.error, /could not be resolved/);
  assert.doesNotMatch(result.error, /distribution|conversation is missing/);
  assert.doesNotMatch(result.error, /7 days|closed/);
  assert.equal(bridge.nativePayloads.length, 0);
});

test("reports a Shopee list request failure without sending", async () => {
  const bridge = createBridge({ sellerCentre: true, conversationPages: [{}], listFailure: true });
  const { result } = await bridge.send({ ...baseCommand, command_type: "send_text", text: "Hello" });
  assert.match(result.error, /lookup failed.*503/);
  assert.equal(bridge.nativePayloads.length, 0);
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
  assert.deepEqual(plain({ ...result, diagnostics: undefined }), {
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

test("sends a quoted Seller Centre text without the New Webchat secure poster", async () => {
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

test("keeps the New Webchat secure-sender failure scoped to the New Webchat surface", async () => {
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

test("does not dispatch expired Shopee commands", async () => {
  const bridge = createBridge({ sellerCentre: true });
  const { result } = await bridge.send({ ...baseCommand, command_type: "send_text", text: "Hello", deadline_at_ms: Date.now() - 1 });
  assert.match(result.error, /deadline expired/);
  assert.equal(bridge.nativePayloads.length, 0);
});

test("native param_error is a rejection while a lost native response is uncertain", async () => {
  const rejected = createBridge({ sellerCentre: true, sendBody: { error_code: "param_error", message: "param_error" } });
  const failure = await rejected.send({ ...baseCommand, command_type: "send_text", text: "Hello" });
  assert.equal(failure.result.ok, false);
  assert.equal(failure.result.uncertain, undefined);
  const uncertain = createBridge({ sellerCentre: true, transportFailure: true });
  const lost = await uncertain.send({ ...baseCommand, command_type: "send_text", text: "Hello" });
  assert.equal(lost.result.uncertain, true);
});

test("native rejection diagnostics omit payloads and credentials", async () => {
  const bridge = createBridge({ sellerCentre: true, sendBody: { error_code: "param_error", message: "param_error" } });
  await bridge.send({ ...baseCommand, command_type: "send_text", text: "private reply text" });
  const log = bridge.posts.find((post) => post.type === "diagnostic_log" && post.event === "send_failed");
  assert.equal(log.details.native_error_code, "param_error");
  assert.equal(log.details.endpoint_path, "/webchat/api/v1.2/mini/messages");
  assert.equal(log.details.payload_shop_id_state, "string");
  assert.equal(log.details.diagnostic_version, 1);
  assert.equal(log.details.request_id, baseCommand.request_id);
  assert.equal(log.details.conversation_id, baseCommand.conversation_id);
  assert.equal(log.details.failure_kind, "provider_rejection");
  assert.equal(log.details.delivery_uncertain, false);
  assert.equal(log.details.template_source, "derived");
  assert.equal(log.details.payload_shop_matches_route, true);
  assert.equal(log.details.payload_to_matches_route, true);
  assert.equal(log.details.http_status, 200);
  assert.doesNotMatch(JSON.stringify(log), /private reply text|Bearer seller-test|csrf_token/);
});

for (const sellerCentre of [false, true]) {
  for (const sendBody of [
    { error_code: "illegal", message: "Message violates Shopee chat rules." },
    { error_code: 123, message: "Message violates Shopee chat rules." },
    { error: 123, message: "Message violates Shopee chat rules." },
    { error_code: "illegal" },
  ]) {
    test(`preserves content rejection on ${sellerCentre ? "Seller Centre" : "New Webchat"}: ${JSON.stringify(sendBody)}`, async () => {
      const bridge = createBridge({ sellerCentre, sendBody });
      const { result } = await bridge.send({ ...baseCommand, command_type: "send_text", text: "blocked text" });
      assert.equal(result.ok, false);
      assert.equal(result.error, sendBody.message ?? "illegal");
      assert.equal(result.uncertain, undefined);
      assert.doesNotMatch(result.error, /routing is unavailable/);
    });
  }
  test(`accepts numeric zero error on ${sellerCentre ? "Seller Centre" : "New Webchat"}`, async () => {
    const bridge = createBridge({ sellerCentre, sendBody: { error_code: 0, error: 0, id: "accepted", message_option: 0 } });
    const { result } = await bridge.send({ ...baseCommand, command_type: "send_text", text: "hello" });
    assert.equal(result.ok, true);
    assert.equal(result.provider_message_id, "accepted");
  });
}

test("refreshes an incomplete cached route before reporting a provider rejection", async () => {
  const bridge = createBridge({
    sellerCentre: true,
    cachedRouting: { conversation_id: "conversation-1", to_id: "101" },
    conversationPages: [{ conversations: [{ id: "conversation-1", shop_id: "shop-1", to_id: "101" }] }],
    sendBody: { error_code: "illegal", message: "Message violates Shopee chat rules." },
  });
  const { result } = await bridge.send({ ...baseCommand, command_type: "send_text", text: "blocked text" });
  assert.equal(bridge.nativeRequests.filter((path) => path.endsWith("/mini/conversations")).length, 1);
  assert.equal(bridge.nativePayloads.length, 1);
  assert.equal(bridge.nativePayloads[0].shop_id, "shop-1");
  assert.equal(bridge.nativePayloads[0].to_id, 101);
  assert.equal(result.ok, false);
  assert.equal(result.error, "Message violates Shopee chat rules.");
});

for (const sellerCentre of [false, true]) {
  for (const option of [256, 288, 2, 16]) {
    test(`rejects HTTP 200 message ID with failed delivery option ${option} on ${sellerCentre ? "Seller Centre" : "New Webchat"}`, async () => {
      // Sanitized shape captured from Seller Centre: no error_code despite failure.
      const bridge = createBridge({ sellerCentre, sendBody: {
        id: "provider-rejected-message", type: "text", content: { text: "test" },
        message_option: option, to_id_status: 0, msg_tag: { msg_ui_opt: 12 },
      } });
      const { result } = await bridge.send({ ...baseCommand, command_type: "send_text", text: "test" });
      assert.equal(result.ok, false);
      assert.equal(result.uncertain, undefined);
      assert.equal(result.provider_message_id, undefined);
      assert.match(result.error, /Shopee (did not deliver|blocked|rejected)/);
    });
  }
  for (const option of [0, 1, 32, 64, 128, 512, 1024]) {
    test(`only accepts known normal option ${option} on ${sellerCentre ? "Seller Centre" : "New Webchat"}`, async () => {
      const bridge = createBridge({ sellerCentre, sendBody: { id: "accepted", message_option: option } });
      const { result } = await bridge.send({ ...baseCommand, command_type: "send_text", text: "hello" });
      assert.equal(result.ok, option === 0);
      assert.equal(result.uncertain, option === 0 ? undefined : true);
    });
  }
}

for (const sellerCentre of [false, true]) {
  for (const sendBody of [
    {}, { id: "id-only" }, { error_code: 0 },
    { id: "id", message_option: "0" }, { id: "id", message_option: null },
    { id: "id", message_option: 2 ** 32 },
    { id: "id", message_option: 0, status: "pending" },
    { id: "id", message_option: 0, msg_tag: { msg_ui_opt: 12 } },
    { id: "id", message_option: 0, error: {} },
    { id: "id", message_option: 0, conversation_id: "another-chat" },
    { data: { id: "nested", message_option: 0 } },
  ]) {
    test(`unknown response remains uncertain on ${sellerCentre ? "Seller Centre" : "New Webchat"}: ${JSON.stringify(sendBody)}`, async () => {
      const bridge = createBridge({ sellerCentre, sendBody });
      const { result } = await bridge.send({ ...baseCommand, command_type: "send_text", text: "test" });
      assert.equal(result.ok, false);
      assert.equal(result.uncertain, true);
      assert.equal(result.provider_message_id, undefined);
      assert.match(result.error, /check Seller Chat before retrying/);
    });
  }
}


for (const listFailure of [false, true]) {
  test(`sends with a same-shop cached route without consulting ${listFailure ? "unavailable" : "empty"} list`, async () => {
    const bridge = createBridge({ sellerCentre: true,
      cachedRouting: { conversation_id: "conversation-1", shop_id: "shop-1", to_id: "101" },
      conversationPages: [{ conversations: [] }], listFailure,
    });
    const { result } = await bridge.send({ ...baseCommand, provider_account_id: "shop-1", command_type: "send_text", text: "Hello" });
    assert.equal(result.ok, true);
    assert.deepEqual(bridge.nativeRequests.filter((path) => path.startsWith("/webchat/")), ["/webchat/api/v1.2/mini/messages"]);
    assert.equal(bridge.nativePayloads.length, 1);
    assert.equal(bridge.nativePayloads[0].to_id, 101);
  });
}

for (const found of [false, true]) {
  test(`a different-shop cached route is ${found ? "replaced by lookup" : "never sent when lookup misses"}`, async () => {
    const bridge = createBridge({ sellerCentre: true,
      cachedRouting: { conversation_id: "conversation-1", shop_id: "wrong-shop", to_id: "999" },
      conversationPages: [{ conversations: [{ id: "conversation-1", shop_id: found ? "shop-1" : "wrong-shop", to_id: "101" }] }],
    });
    const { result } = await bridge.send({ ...baseCommand, provider_account_id: "shop-1", command_type: "send_text", text: "Hello" });
    assert.ok(bridge.nativeRequests.some((path) => path.endsWith("/mini/conversations")));
    assert.equal(bridge.nativePayloads.length, found ? 1 : 0);
    if (found) {
      assert.equal(result.ok, true);
      assert.equal(bridge.nativePayloads[0].shop_id, "shop-1");
      assert.equal(bridge.nativePayloads[0].to_id, 101);
    } else {
      assert.equal(result.error_code, "SHOPEE_CONVERSATION_MISSING");
    }
  });
}

for (const transportFailure of [false, true]) {
  test(`cached-route ${transportFailure ? "transport uncertainty" : "provider rejection"} does not retry`, async () => {
    const bridge = createBridge({ sellerCentre: true,
      cachedRouting: { conversation_id: "conversation-1", shop_id: "shop-1", to_id: "101" },
      conversationPages: [{ conversations: [] }], transportFailure,
      sendBody: { error_code: "illegal", message: "Message violates Shopee chat rules." },
    });
    const { result } = await bridge.send({ ...baseCommand, provider_account_id: "shop-1", command_type: "send_text", text: "Hello" });
    assert.equal(result.ok, false);
    assert.equal(result.uncertain, transportFailure ? true : undefined);
    if (!transportFailure) assert.equal(result.error, "Message violates Shopee chat rules.");
    assert.deepEqual(bridge.nativeRequests.filter((path) => path.startsWith("/webchat/")), ["/webchat/api/v1.2/mini/messages"]);
    assert.equal(bridge.nativePayloads.length, 1);
  });
}

test("does not label malformed conversation responses as missing", async () => {
  const bridge = createBridge({ sellerCentre: true, conversationPages: [{ error_code: "unauthorized" }] });
  const { result } = await bridge.send({ ...baseCommand, command_type: "send_text", text: "Hello" });
  assert.match(result.error, /lookup failed/);
  assert.equal(result.error_code, undefined);
  assert.equal(bridge.nativePayloads.length, 0);
});


test("uses routing discovered while Seller Centre initializes without a list lookup", async () => {
  let initialized = false;
  const bridge = createBridge({ sellerCentre: true, ready: false, conversationPages: [],
    onTemplateWait: async (state) => {
      assert.equal(initialized, false);
      initialized = true;
      await new Promise(resolve => setImmediate(resolve));
      state.listTemplate = { url: `${origin}/webchat/api/v1.2/mini/conversations`, init: { method: "POST" }, body: new TextEncoder().encode("{}").buffer };
      state.getTemplate = { url: `${origin}/webchat/api/v1.2/mini/user/setting`, init: { method: "GET" } };
      state.routesByShopConversation.set(JSON.stringify(["shop-1", "conversation-1"]), {
        conversation_id: "conversation-1", shop_id: "shop-1", to_id: "301", biz_id: "0",
      });
    },
  });
  const { result } = await bridge.send({ ...baseCommand, provider_account_id: "shop-1", command_type: "send_text", text: "Hello" });
  assert.equal(initialized, true);
  assert.equal(result.ok, true);
  assert.equal(bridge.listRequests.length, 0);
  assert.equal(bridge.nativePayloads.length, 1);
  assert.equal(bridge.nativePayloads[0].to_id, 301);
});

test("partial observations preserve a usable route and explicit zero updates biz_id", async () => {
  const pages = [{ conversations: [] }];
  const bridge = createBridge({ sellerCentre: true, conversationPages: pages,
    cachedRouting: { conversation_id: "conversation-1", shop_id: "shop-1", to_id: "101", to_shop_id: "201", biz_id: "3" },
  });
  pages[0] = { conversations: [{ id: "conversation-1", to_id: "", biz_id: 8 }] };
  await bridge.observeList();
  pages[0] = { conversations: [{ id: "conversation-1", shop_id: "shop-1", to_id: "", to_shop_id: null, biz_id: 0 }] };
  await bridge.observeList();
  const before = bridge.listRequests.length;
  const { result } = await bridge.send({ ...baseCommand, provider_account_id: "shop-1", command_type: "send_text", text: "Hello" });
  assert.equal(result.ok, true);
  assert.equal(bridge.listRequests.length, before);
  assert.equal(bridge.nativePayloads[0].to_id, 101);
  assert.equal(bridge.nativePayloads[0].to_shop_id, 201);
  assert.equal(bridge.nativePayloads[0].biz_id, 0);
});

test("same conversation ID in two shops keeps independent send routes", async () => {
  const bridge = createBridge({ sellerCentre: true, conversationPages: [{ conversations: [
    { id: "conversation-1", shop_id: "shop-1", to_id: "101" },
    { id: "conversation-1", shop_id: "shop-2", to_id: "102" },
  ] }] });
  await bridge.observeList();
  const before = bridge.listRequests.length;
  for (const shop of [1, 2, 1]) {
    const { result } = await bridge.send({ ...baseCommand, request_id: `shop-${shop}-${bridge.nativePayloads.length}`,
      provider_account_id: `shop-${shop}`, command_type: "send_text", text: "Hello" });
    assert.equal(result.ok, true);
    assert.equal(bridge.nativePayloads.at(-1).shop_id, `shop-${shop}`);
    assert.equal(bridge.nativePayloads.at(-1).to_id, 100 + shop);
    assert.equal(bridge.nativePayloads.at(-1).biz_id, 0);
  }
  assert.equal(bridge.listRequests.length, before);
});

test("send lookup restarts a captured later nano page without changing the UI template", async () => {
  const cursor = "1790138871629724048";
  const bridge = createBridge({ sellerCentre: true, conversationPages: [], onList: async request => {
    const body = await request.json();
    return { conversations: body.next_timestamp_nano === "0"
      ? [{ id: "conversation-1", shop_id: "shop-1", to_id: "101" }] : [] };
  } });
  await bridge.observeList({ next_timestamp_nano: cursor, direction: "older", biz_id: 0, filter: "assigned" });
  const { result } = await bridge.send({ ...baseCommand, provider_account_id: "shop-1", command_type: "send_text", text: "Hello" });
  assert.equal(result.ok, true);
  assert.deepEqual(await bridge.listRequests.at(-1).json(), {
    next_timestamp_nano: "0", direction: "older", biz_id: 0, filter: "assigned",
  });
  assert.equal(JSON.parse(new TextDecoder().decode(bridge.state.listTemplate.body)).next_timestamp_nano, cursor);
  assert.equal(bridge.nativePayloads.length, 1);
});


test("a hung lookup is bounded by the command deadline and never sends", async () => {
  const bridge = createBridge({ sellerCentre: true, conversationPages: [], onList: () => new Promise(() => {}) });
  await bridge.send({ ...baseCommand, provider_account_id: "shop-1", command_type: "send_text", text: "Hello", deadline_at_ms: Date.now() + 30 });
  await new Promise(resolve => setTimeout(resolve, 60));
  const result = bridge.posts.find(post => post.type === "api_send_result" && post.request_id === baseCommand.request_id);
  assert.equal(result?.ok, false);
  assert.match(result.error, /timed out|deadline expired/);
  assert.equal(bridge.nativePayloads.length, 0);
});

test("filtered list exhaustion has neutral guidance and useful sanitized diagnostics", async () => {
  const bridge = createBridge({ sellerCentre: true, conversationPages: [{ conversations: [] }] });
  await bridge.observeList({ next_timestamp_nano: "0", filter: "assigned" });
  const { result } = await bridge.send({ ...baseCommand, provider_account_id: "shop-1", command_type: "send_text", text: "private reply" });
  assert.equal(result.ok, false);
  assert.match(result.error, /could not be resolved/);
  assert.doesNotMatch(result.error, /distribution|conversation is missing/);
  const diagnostic = bridge.posts.findLast(post => post.type === "diagnostic_log" && post.event === "send_route_resolution");
  assert.equal(diagnostic.details.pages, 1);
  assert.equal(diagnostic.details.stop_reason, "scoped_end");
  assert.equal(diagnostic.details.lookup_scope, "captured_filters");
  assert.equal(diagnostic.details.request_id, baseCommand.request_id);
  assert.doesNotMatch(JSON.stringify(diagnostic), /private reply|csrf_token|seller-test/);
  assert.equal(bridge.nativePayloads.length, 0);
});


test("a shop session switch during lookup prevents sending the old shop route", async () => {
  const bridge = createBridge({ sellerCentre: true, conversationPages: [], onList: async () => {
    await new Promise(resolve => setImmediate(resolve));
    bridge.state.currentAccountId = "shop-2";
    bridge.state.routeSessionEpoch = (bridge.state.routeSessionEpoch ?? 0) + 1;
    return { conversations: [{ id: "conversation-1", shop_id: "shop-1", to_id: "101" }] };
  } });
  bridge.state.currentAccountId = "shop-1";
  const { result } = await bridge.send({ ...baseCommand, provider_account_id: "shop-1", command_type: "send_text", text: "Hello" });
  assert.equal(result.ok, false);
  assert.match(result.error, /session changed/);
  assert.equal(bridge.nativePayloads.length, 0);
});


test("param_error diagnostics survive local sanitization and export with exact numeric routing IDs", async () => {
  const { createLogEntry, logEntryForUpload } = await import("../extension/lib/logs.js");
  const bridge = createBridge({ sellerCentre: true, sendBody: { error_code: "param_error", message: "private rejected text" },
    cachedRouting: { conversation_id: "conversation-1", shop_id: "207459663", to_id: "123456789", biz_id: "0" } });
  const command = { ...baseCommand, provider_account_id: "207459663", command_type: "send_text", text: "private rejected text" };
  const { result } = await bridge.send(command);
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics.native_error_code, "param_error"); // Local bridge context; server ACK remains unchanged.
  const event = bridge.posts.find(post => post.type === "diagnostic_log" && post.event === "send_failed");
  const saved = createLogEntry({ level: event.level, area: "provider", event: event.event, message: event.message, details: event.details });
  assert.equal(saved.details.native_error_code, "param_error");
  assert.equal(saved.details.route_shop_id, "207459663");
  assert.equal(saved.details.request_shop_id, "207459663");
  assert.equal(saved.details.route_recipient_id, "123456789");
  assert.equal(saved.details.request_recipient_id, "123456789");
  assert.equal(saved.details.provider_account_id, "207459663");
  assert.equal(saved.details.request_id, command.request_id);
  assert.equal(saved.details.http_status, 200);
  assert.equal(saved.details.failure_kind, "provider_rejection");
  const exportText = Object.entries(saved.details).map(([key, value]) => `${key}=${value}`).join(" · ");
  assert.match(exportText, /native_error_code=param_error/);
  assert.match(exportText, /request_recipient_id=123456789/);
  assert.doesNotMatch(JSON.stringify(saved), /private rejected text|Bearer seller-test|csrf_token/);
});

test("captured request missing routing fields is repaired and visible in local rejection diagnostics", async () => {
  const { createLogEntry } = await import("../extension/lib/logs.js");
  const bridge = createBridge({ sendBody: { error_code: "param_error" } });
  await bridge.send({ ...baseCommand, command_type: "send_text", text: "private text" });
  const event = bridge.posts.find(post => post.type === "diagnostic_log" && post.event === "send_failed");
  const saved = createLogEntry({ details: event.details });
  assert.equal(saved.details.template_source, "captured");
  assert.equal(saved.details.payload_shop_id_state, "string");
  assert.equal(saved.details.payload_shop_matches_route, true);
  assert.equal(saved.details.payload_to_id_state, "number");
  assert.equal(saved.details.payload_to_matches_route, true);
});

const commandRouting = fields => ({ routing: { version: 1, fields, observed_at: "2026-10-21T03:00:00Z" } });

for (const sellerCentre of [false, true]) {
  test(`saved command route bypasses empty cache and unavailable lookup on ${sellerCentre ? "mini-chat" : "New Webchat"}`, async () => {
    const bridge = createBridge({ sellerCentre, conversationPages: [{ conversations: [] }], listFailure: true });
    bridge.state.currentAccountId = "207459663";
    const { result } = await bridge.send({ ...baseCommand, provider_account_id: "207459663", command_type: "send_text", text: "Direct route",
      omnichat: commandRouting({ to_id: "123456789", to_shop_id: "1834183330", biz_id: "3" }) });
    assert.equal(result.ok, true);
    assert.equal(bridge.listRequests.length, 0);
    const payload = sellerCentre ? bridge.nativePayloads[0] : undefined;
    if (payload) {
      assert.equal(payload.shop_id, 207459663);
      assert.equal(payload.to_id, 123456789);
      assert.equal(payload.to_shop_id, 1834183330);
      assert.equal(payload.biz_id, 3);
    }
    assert.equal(bridge.posts.some(post => post.event === "send_route_fallback"), false);
    const resolution = bridge.posts.find(post => post.event === "send_route_resolution");
    assert.equal(resolution.details.route_source, "command");
    assert.equal(resolution.details.stop_reason, "command");
    assert.equal(resolution.details.lookup_scope, "not_needed");
    assert.equal(resolution.details.pages, 0);
    assert.equal(Object.hasOwn(resolution.details, "cache_reason"), false);
  });
}

test("unsupported command routing warns and falls back to existing cached destination", async () => {
  const bridge = createBridge({ sellerCentre: true });
  bridge.state.currentAccountId = "shop-1";
  const { result } = await bridge.send({ ...baseCommand, provider_account_id: "shop-1", command_type: "send_text", text: "Fallback",
    omnichat: { routing: { version: 99, fields: { to_id: "999" }, observed_at: "2026-10-21T03:00:00Z" } } });
  assert.equal(result.ok, true);
  assert.equal(bridge.nativePayloads[0].to_id, 101);
  assert.equal(bridge.listRequests.length, 0);
  const warning = bridge.posts.find(post => post.event === "send_route_fallback");
  assert.equal(warning.level, "warn");
  assert.equal(warning.details.fallback_reason, "invalid");
});

test("command for another signed-in shop cannot use a cached foreign route", async () => {
  const bridge = createBridge({ sellerCentre: true, cachedRouting: {
    conversation_id: "conversation-1", shop_id: "other-shop", to_id: "999", biz_id: "0",
  }, conversationPages: [{ conversations: [] }] });
  bridge.state.currentAccountId = "current-shop";
  const { result } = await bridge.send({ ...baseCommand, provider_account_id: "other-shop", command_type: "send_text", text: "Wrong account",
    omnichat: commandRouting({ to_id: "123456789" }) });
  assert.equal(result.ok, false);
  assert.equal(bridge.nativePayloads.length, 0);
});

test("captured template cannot leak recipient shop or business between command conversations", async () => {
  const bridge = createBridge({ conversationPages: [{ conversations: [] }] });
  bridge.state.currentAccountId = "207459663";
  Object.assign(bridge.state.sendTemplate.payload, { to_shop_id: 999, biz_id: 88, to_id: 777, shop_id: 666 });
  const first = await bridge.send({ ...baseCommand, provider_account_id: "207459663", command_type: "send_text", text: "First",
    omnichat: commandRouting({ to_id: "123", to_shop_id: "456", biz_id: "3" }) });
  assert.equal(first.result.ok, true);
  assert.equal(first.payload.to_shop_id, 456);
  assert.equal(first.payload.biz_id, 3);
  const second = await bridge.send({ ...baseCommand, request_id: "second", conversation_id: "conversation-2", provider_account_id: "207459663",
    command_type: "send_text", text: "Second", omnichat: commandRouting({ to_id: "789" }) });
  assert.equal(second.result.ok, true);
  assert.equal(second.payload.to_id, 789);
  assert.equal(Object.hasOwn(second.payload, "to_shop_id"), false);
  assert.equal(second.payload.biz_id, 0);
  assert.equal(bridge.listRequests.length, 0);
  assert.equal(bridge.state.sendTemplate.payload.to_shop_id, 999, "the captured template itself stays unchanged");
});

test("profile routing contains only observed numeric destination fields and preserves explicit zero", async () => {
  const bridge = createBridge({ sellerCentre: true, conversationPages: [{ conversations: [
    { id: "conversation-1", shop_id: "shop-1", to_id: "123" },
    { id: "conversation-2", shop_id: "shop-1", to_id: "456", to_shop_id: 0, biz_id: 0 },
  ] }] });
  await bridge.observeList();
  const profiles = bridge.posts.filter(post => post.type === "profiles_detected").flatMap(post => post.profiles);
  const first = profiles.find(profile => profile.conversation_id === "conversation-1");
  const second = profiles.find(profile => profile.conversation_id === "conversation-2");
  assert.deepEqual(plain(first.omnichat.routing.fields), { to_id: "123" });
  assert.deepEqual(plain(second.omnichat.routing.fields), { to_id: "456", to_shop_id: "0", biz_id: "0" });
  assert.ok(Number.isFinite(Date.parse(first.omnichat.routing.observed_at)));
});

test("partial conversation responses publish merged routing for later message forwarding", async () => {
  const pages = [{ conversations: [{ id: "conversation-1", shop_id: "shop-1", to_id: "123", to_shop_id: "456", biz_id: "3" }] }];
  const bridge = createBridge({ sellerCentre: true, conversationPages: pages });
  await bridge.observeList();
  pages[0] = { conversations: [{ id: "conversation-1", shop_id: "shop-1", to_shop_id: "789", biz_id: 0 }] };
  await bridge.observeList();
  const updated = bridge.posts.filter(post => post.type === "profiles_detected").at(-1).profiles.find(profile => profile.conversation_id === "conversation-1");
  assert.equal(updated.id, "123");
  assert.deepEqual(plain(updated.omnichat.routing.fields), { to_id: "123", to_shop_id: "789", biz_id: "0" });
});

test("video upload failure never dispatches a Shopee chat message or retries", async () => {
  let uploads = 0;
  const bridge = createBridge({ videoUploader: async () => { uploads++; throw new Error("transfer failed"); } });
  const { result } = await bridge.send({ ...baseCommand, command_type: "send_video", media_type: "video/mp4",
    media_bytes: new Uint8Array([1, 2, 3]).buffer, deadline_at_ms: Date.now() + 5000 });
  assert.equal(result.ok, false);
  assert.match(result.error, /transfer failed/);
  assert.equal(uploads, 1);
  assert.equal(bridge.sentUrls.length, 0);
  assert.equal(bridge.nativePayloads.length, 0);
});

test("unverified mini-chat video returns unsupported before uploading or sending", async () => {
  let uploads = 0;
  const bridge = createBridge({ sellerCentre: true, videoUploader: async () => { uploads++; return {}; } });
  const { result } = await bridge.send({ ...baseCommand, command_type: "send_video", media_type: "video/mp4",
    media_bytes: new Uint8Array([1, 2, 3]).buffer });
  assert.equal(result.ok, false);
  assert.match(result.error, /video.*requires initialized New Webchat/i);
  assert.equal(uploads, 0);
  assert.equal(bridge.nativePayloads.length, 0);
});


test("Shopee image rejection retains upload stage and status without provider description or chat send", async () => {
  const bridge = createBridge({ sellerCentre: true, imageFailure: { error_code: "param_error", message: "private customer echo token=secret" } });
  const { result } = await bridge.send({ ...baseCommand, command_type: "send_image", image_bytes: new Uint8Array([1,2,3]).buffer, image_type: "image/jpeg" });
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics.operation, "upload");
  assert.equal(result.diagnostics.stage, "upload_transfer");
  assert.equal(result.diagnostics.failure_kind, "provider_rejection");
  assert.equal(result.diagnostics.http_status, 400);
  assert.equal(result.diagnostics.native_error_code, "param_error");
  assert.equal(result.diagnostics.native_attempted, false);
  assert.equal(bridge.nativePayloads.length, 0);
  assert.doesNotMatch(JSON.stringify(result), /private customer|token=secret/);
});

for (const commandType of ["send_text", "send_image"]) {
  test(`redirected Webchat sends ${commandType} from supplied routing without lookup`, async () => {
    const bridge = createBridge({ pathname: "/webchat/conversations", conversationPages: [{ conversations: [] }], listFailure: true });
    bridge.state.currentAccountId = "207459663";
    const { result, payload } = await bridge.send({ ...baseCommand, provider_account_id: "207459663", command_type: commandType,
      text: "Legacy compatibility fixture", image_bytes: new Uint8Array([1,2,3]).buffer, image_type: "image/jpeg",
      omnichat: commandRouting({ to_id: "123456789", to_shop_id: "1834183330", biz_id: "0" }) });
    assert.equal(result.ok, true);
    assert.equal(bridge.state.surface, "webchat");
    assert.equal(new URL(bridge.sentUrls[0]).pathname, "/webchat/api/v1.2/messages");
    assert.equal(payload.to_id, 123456789);
    assert.equal(payload.shop_id, 207459663);
    assert.equal(bridge.listRequests.length, 0);
    assert.equal(bridge.posts.find(post => post.event === "send_route_resolution").details.pages, 0);
    assert.equal(bridge.posts.some(post => post.event === "send_route_fallback"), false);
  });
}

test("redirected Webchat video is rejected before upload or native send", async () => {
  let uploads = 0;
  const bridge = createBridge({ pathname: "/webchat/conversations", videoUploader: async () => { uploads++; return {}; } });
  const { result } = await bridge.send({ ...baseCommand, command_type: "send_video", media_type: "video/mp4", video_bytes: new Uint8Array([1]).buffer });
  assert.equal(result.ok, false);
  assert.match(result.error, /video.*requires initialized New Webchat/i);
  assert.equal(uploads, 0);
  assert.equal(bridge.sentUrls.length, 0);
  assert.equal(bridge.nativePayloads.length, 0);
});
