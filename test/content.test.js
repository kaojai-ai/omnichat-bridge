import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../extension/content.js", import.meta.url), "utf8");
const urlSource = await readFile(new URL("../extension/lib/shopee-url.js", import.meta.url), "utf8");
const adaptersSource = await readFile(new URL("../extension/lib/provider-adapters.js", import.meta.url), "utf8");
const shopeeAdapterSource = await readFile(new URL("../extension/lib/shopee-adapter.js", import.meta.url), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));

function contentBridge(pathname = "/new-webchat/conversations", { localConsent = false } = {}) {
  const runtimeListeners = [];
  const windowListeners = new Map();
  const runtimeMessages = [];
  const storageWrites = [];
  let context;
  const window = {
    location: {
      origin: "https://seller.shopee.co.th",
      pathname,
    },
    addEventListener(type, listener) {
      windowListeners.set(type, [...(windowListeners.get(type) ?? []), listener]);
    },
    removeEventListener(type, listener) {
      windowListeners.set(type, (windowListeners.get(type) ?? []).filter((item) => item !== listener));
    },
    postMessage(message) {
      runtimeMessages.push(message);
    },
  };
  context = vm.createContext({
    window,
    document: {
      hidden: false,
      addEventListener() {},
      removeEventListener() {},
    },
    URL,
    chrome: {
      runtime: {
        onMessage: {
          addListener(listener) {
            runtimeListeners.push(listener);
          },
          removeListener(listener) {
            const index = runtimeListeners.indexOf(listener);
            if (index >= 0) runtimeListeners.splice(index, 1);
          },
        },
        async sendMessage(message) {
          runtimeMessages.push(message);
          return { ok: true };
        },
      },
      storage: {
        local: {
          async get() {
            return localConsent ? { local_consent: { accepted_at: "2026-09-01T00:00:00.000Z" } } : {};
          },
          async set(value) {
            storageWrites.push(value);
          },
        },
      },
    },
    OmnichatShopee: {
      parseShopeeMessages(body) {
        return body.messages;
      },
    },
    setTimeout,
    clearTimeout,
    Uint8Array,
    atob,
  });
  window.window = window;
  vm.runInContext(urlSource, context);
  vm.runInContext(adaptersSource, context);
  vm.runInContext(shopeeAdapterSource, context);
  vm.runInContext(source, context);

  const sendCommand = (message) => new Promise((resolve) => {
    assert.equal(runtimeListeners[0](message, {}, resolve), true);
  });
  const providerEvent = async (data) => {
    for (const listener of windowListeners.get("message") ?? []) {
      listener({
        source: window,
        origin: window.location.origin,
        data: { source: "omnichat-realtime-bridge-v3", ...data },
      });
    }
    await new Promise((resolve) => setImmediate(resolve));
  };

  const triggerWindowEvent = async (type) => {
    for (const listener of windowListeners.get(type) ?? []) listener({});
    await new Promise((resolve) => setImmediate(resolve));
  };

  return {
    invalidateRuntime() {
      context.chrome.runtime = undefined;
    },
    providerEvent,
    runtimeMessages,
    storageWrites,
    sendCommand,
    triggerWindowEvent,
    reattach() {
      vm.runInContext(source, context);
    },
    get runtimeListenerCount() { return runtimeListeners.length; },
    get pageMessageListenerCount() { return (windowListeners.get("message") ?? []).length; },
  };
}

const command = {
  type: "send_api_v3",
  request_id: "request-1",
  conversation_id: "conversation-1",
  client_message_id: "client-1",
  command_type: "send_text",
  text: "Hello",
};

test("routes detected accounts through the background merger", async () => {
  const bridge = contentBridge("/new-webchat/conversations", { localConsent: true });

  await bridge.providerEvent({
    type: "accounts_detected",
    accounts: [{ provider: "shopee", provider_account_id: "shop-1" }],
  });

  const detection = bridge.runtimeMessages.find((message) => message.type === "accounts_detected");
  assert.equal(detection?.provider, "shopee");
  assert.deepEqual(
    plain(detection?.accounts.map(({ detected_at: _detectedAt, ...account }) => account)),
    [{ provider: "shopee", provider_account_id: "shop-1" }],
  );
  assert.deepEqual(bridge.storageWrites, []);
});

const echo = {
  provider: "shopee",
  conversation_id: "conversation-1",
  id: "provider-1",
  client_message_id: "client-1",
  text: "Hello",
};

test("queues an API echo that completes a pending send", async () => {
  const bridge = contentBridge();
  const result = bridge.sendCommand(command);

  await bridge.providerEvent({ type: "realtime_event", body: { messages: [echo] } });

  assert.deepEqual(plain(await result), { ok: true, provider_message_id: "provider-1" });
  assert.deepEqual(
    plain(bridge.runtimeMessages.find((message) => message.type === "queue_messages")?.messages),
    [echo],
  );
});

test("queues an API echo after the provider result completes the send", async () => {
  const bridge = contentBridge();
  const result = bridge.sendCommand(command);

  await bridge.providerEvent({
    type: "api_send_result",
    request_id: "request-1",
    ok: true,
    provider_message_id: "provider-1",
  });
  assert.deepEqual(plain(await result), { ok: true, provider_message_id: "provider-1" });

  await bridge.providerEvent({ type: "realtime_event", body: { messages: [echo] } });

  assert.deepEqual(
    plain(bridge.runtimeMessages.find((message) => message.type === "queue_messages")?.messages),
    [echo],
  );
});

test("prepares Seller Centre before an outbound command is selected", async () => {
  const bridge = contentBridge("/portal/chat-management");
  const result = bridge.sendCommand({
    type: "prepare_provider_v3",
    provider: "shopee",
    request_id: "prepare-1",
  });

  assert.deepEqual(
    plain(bridge.runtimeMessages.find((message) => message.type === "prepare_provider_v3")),
    { source: "omnichat-realtime-bridge-v3", type: "prepare_provider_v3", provider: "shopee", request_id: "prepare-1" },
  );
  await bridge.providerEvent({
    type: "prepare_provider_result",
    request_id: "prepare-1",
    ok: true,
    surface: "seller-centre",
    surface_ready: true,
  });

  assert.equal((await result).surface, "seller-centre");
  assert.equal((await result).surface_ready, true);
});

test("keeps Seller Centre chat-open state available to the popup status", async () => {
  const bridge = contentBridge("/portal/chat-management");

  await bridge.providerEvent({
    type: "provider_status",
    surface: "seller-centre",
    surface_ready: false,
    chat_open: false,
  });

  const result = await bridge.sendCommand({ type: "get_provider_status_v3" });
  assert.equal(result.chat_open, false);
  assert.equal(result.surface_ready, false);
});

test("replaces the prior content bridge listener on reattachment", () => {
  const bridge = contentBridge();

  assert.equal(bridge.runtimeListenerCount, 1);
  assert.equal(bridge.pageMessageListenerCount, 1);
  bridge.reattach();

  assert.equal(bridge.runtimeListenerCount, 1);
  assert.equal(bridge.pageMessageListenerCount, 1);
});

test("starts the existing automatic sync path after a manual Seller Centre chat open", async () => {
  const bridge = contentBridge("/portal/chat-management");

  await bridge.providerEvent({ type: "seller_centre_chat_opened" });
  await new Promise((resolve) => setTimeout(resolve, 550));

  assert.equal(
    bridge.runtimeMessages.filter((message) => message.type === "resume_sync").length,
    1,
  );
});

test("does not deliver the same provider message twice across realtime surfaces", async () => {
  const bridge = contentBridge("/portal/chat-management");
  await bridge.providerEvent({ type: "realtime_event", capture_method: "realtime_socket", body: { messages: [echo] } });
  await bridge.providerEvent({ type: "realtime_event", capture_method: "realtime_polling", body: { messages: [echo] } });

  const queued = bridge.runtimeMessages.filter((message) => message.type === "queue_messages");
  assert.equal(queued.length, 1);
  assert.deepEqual(plain(queued[0].messages), [echo]);
});

test("ignores best-effort messages after the extension context is invalidated", async () => {
  const bridge = contentBridge();
  bridge.invalidateRuntime();

  await bridge.providerEvent({ type: "socket_connected" });
  await bridge.triggerWindowEvent("pageshow");
  await new Promise((resolve) => setTimeout(resolve, 550));

  assert.equal(
    bridge.runtimeMessages.filter((message) => ["record_log", "resume_sync"].includes(message.type)).length,
    1,
  );
});

for (const pathname of [
  "/new-webchat/conversations",
  "/webchat/conversations",
  "/",
  "/404",
  "/portal",
  "/portal/",
  "/portal/chat-management",
  "/portal/sale/order",
]) {
  test(`requests automatic sync when ${pathname} loads`, async () => {
    const bridge = contentBridge(pathname);

    await new Promise((resolve) => setTimeout(resolve, 550));

    assert.equal(
      bridge.runtimeMessages.filter((message) => message.type === "resume_sync").length,
      1,
    );
  });
}
