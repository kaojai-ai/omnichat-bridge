import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../extension/content.js", import.meta.url), "utf8");
const urlSource = await readFile(new URL("../extension/lib/shopee-url.js", import.meta.url), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));

function contentBridge(pathname = "/new-webchat/conversations") {
  const runtimeListeners = [];
  const windowListeners = new Map();
  const runtimeMessages = [];
  let context;
  const window = {
    location: {
      origin: "https://seller.shopee.co.th",
      pathname,
    },
    addEventListener(type, listener) {
      windowListeners.set(type, [...(windowListeners.get(type) ?? []), listener]);
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
    },
    chrome: {
      runtime: {
        onMessage: {
          addListener(listener) {
            runtimeListeners.push(listener);
          },
        },
        async sendMessage(message) {
          runtimeMessages.push(message);
          return { ok: true };
        },
      },
      storage: { local: { async get() { return {}; } } },
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
  vm.runInContext(source, context);

  const sendCommand = (message) => new Promise((resolve) => {
    assert.equal(runtimeListeners[0](message, {}, resolve), true);
  });
  const providerEvent = async (data) => {
    for (const listener of windowListeners.get("message") ?? []) {
      listener({
        source: window,
        origin: window.location.origin,
        data: { source: "omnichat-realtime-bridge", ...data },
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
    sendCommand,
    triggerWindowEvent,
  };
}

const command = {
  type: "send_api",
  request_id: "request-1",
  conversation_id: "conversation-1",
  client_message_id: "client-1",
  command_type: "send_text",
  text: "Hello",
};

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

for (const pathname of ["/new-webchat/conversations", "/webchat/conversations"]) {
  test(`requests automatic sync when ${pathname} loads`, async () => {
    const bridge = contentBridge(pathname);

    await new Promise((resolve) => setTimeout(resolve, 550));

    assert.equal(
      bridge.runtimeMessages.filter((message) => message.type === "resume_sync").length,
      1,
    );
  });
}
