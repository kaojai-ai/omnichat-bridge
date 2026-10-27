import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../extension/content.js", import.meta.url), "utf8");
const urlSource = await readFile(new URL("../extension/lib/shopee-url.js", import.meta.url), "utf8");
const adaptersSource = await readFile(new URL("../extension/lib/provider-adapters.js", import.meta.url), "utf8");
const shopeeAdapterSource = await readFile(new URL("../extension/lib/shopee-adapter.js", import.meta.url), "utf8");
const lineOaSource = await readFile(new URL("../extension/lib/line-oa.js", import.meta.url), "utf8");
const shopeeParserSource = await readFile(new URL("../extension/lib/shopee.js", import.meta.url), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));

function contentBridge(pathname = "/new-webchat/conversations", { localConsent = false, storage = {}, provider = "shopee", runtimeHandler = null, realShopeeParser = false } = {}) {
  const runtimeListeners = [];
  const windowListeners = new Map();
  const runtimeMessages = [];
  const storageWrites = [];
  let context;
  const window = {
    location: {
      origin: provider === "line_oa" ? "https://chat.line.biz" : "https://seller.shopee.co.th",
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
          return runtimeHandler ? runtimeHandler(message) : { ok: true };
        },
      },
      storage: {
        local: {
          async get() {
            return {
              ...(localConsent ? { local_consent: { accepted_at: "2026-09-01T00:00:00.000Z" } } : {}),
              ...storage,
            };
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
    crypto,
    Uint8Array,
    atob,
  });
  window.window = window;
  vm.runInContext(urlSource, context);
  vm.runInContext(adaptersSource, context);
  if (realShopeeParser) vm.runInContext(shopeeParserSource, context);
  vm.runInContext(shopeeAdapterSource, context);
  vm.runInContext(lineOaSource, context);
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
    requestMessage: message => new Promise(resolve => runtimeListeners[0](message, {}, resolve)),
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

for (const command_type of ["send_video", "send_file"]) {
  test(`passes ${command_type} decoded bytes to the LINE page and retains filename and deadline`, async () => {
    const bridge = contentBridge("/bot-1/chat/chat-1", { provider: "line_oa", localConsent: true });
    const deadline = Date.now() + 30_000;
    const result = bridge.sendCommand({ ...command, command_type, media_base64: "AQID", media_type: "application/pdf",
      file_name: "report.pdf", deadline_at_ms: deadline });
    const submitted = bridge.runtimeMessages.find(message => message.type === "send_api_v3");
    assert.deepEqual(Array.from(new Uint8Array(submitted.media_bytes)), [1, 2, 3]);
    assert.equal(submitted.file_name, "report.pdf");
    assert.equal(submitted.deadline_at_ms, deadline);
    assert.equal(submitted.media_base64, undefined);
    await bridge.providerEvent({ type: "api_send_result", request_id: "request-1", ok: true, provider_message_id: "provider-1", confirmed: true });
    assert.deepEqual(plain(await result), { ok: true, provider_message_id: "provider-1" });
  });
}

test("actual Shopee parser keeps session ownership across realtime and historical recovery", async () => {
  const bridge = contentBridge("/new-webchat/conversations", { localConsent: true, realShopeeParser: true });
  await bridge.providerEvent({ type: "accounts_detected", accounts: [{ provider: "shopee", provider_account_id: "active-shop" }] });
  const raw = { id: "realtime-owned", conversation_id: "fixture-chat", from_id: "seller-user", to_id: "buyer-user",
    from_shop_id: "active-shop", to_shop_id: "buyer-shop", type: "text", content: { text: "Fixture reply" } };
  await bridge.providerEvent({ type: "realtime_event", body: { messages: [raw] } });
  await bridge.providerEvent({ type: "recovery_batch", request_id: "history:fixture", provider_account_id: "active-shop",
    body: { messages: [{ ...raw, id: "history-owned" }, { ...raw, id: "history-foreign", from_shop_id: "foreign-shop" }] } });
  const messages = bridge.runtimeMessages.filter((message) => message.type === "queue_messages").flatMap((message) => message.messages);
  assert.deepEqual(messages.map((message) => message.id), ["realtime-owned", "history-owned"]);
  for (const message of messages) {
    assert.equal(message.provider_account_id, "active-shop");
    assert.equal(message.sender_account_id, "active-shop");
    assert.equal(message.recipient_account_id, "buyer-shop");
  }
});

test("actual Shopee parser rejects unrelated and ambiguous shops before recovery owner fallback", async () => {
  const bridge = contentBridge("/new-webchat/conversations", { localConsent: true, realShopeeParser: true });
  await bridge.providerEvent({ type: "accounts_detected", accounts: ["shop-a", "shop-b"].map((id) => ({ provider: "shopee", provider_account_id: id })) });
  const raw = { id: "ambiguous", conversation_id: "fixture-chat", from_id: "seller-user", to_id: "buyer-user",
    from_shop_id: "shop-a", to_shop_id: "shop-b", type: "text", content: { text: "Fixture" } };
  await bridge.providerEvent({ type: "realtime_event", body: { messages: [raw, { ...raw, id: "foreign", from_shop_id: "foreign-a", to_shop_id: "foreign-b" }] } });
  await bridge.providerEvent({ type: "recovery_batch", request_id: "history:unowned", provider_account_id: "shop-a", body: { messages: [raw] } });
  const messages = bridge.runtimeMessages.filter((message) => message.type === "queue_messages").flatMap((message) => message.messages);
  assert.equal(messages.length, 0);
});

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

test("waits for the recovered native ID after an acknowledged API send", async () => {
  const bridge = contentBridge();
  const result = bridge.sendCommand(command);

  await bridge.providerEvent({
    type: "api_send_result",
    request_id: "request-1",
    ok: true,
  });
  await bridge.providerEvent({ type: "realtime_event", body: { messages: [echo] } });

  assert.deepEqual(plain(await result), { ok: true, provider_message_id: "provider-1" });
});

test("flushes pending messages when the recurring LINE-style poll completes", async () => {
  const bridge = contentBridge();

  await bridge.providerEvent({
    type: "recovery_complete",
    request_id: "poll:poll-1",
    provider_account_id: "shop-1",
    ok: true,
    recovered: 0,
    queued: 0,
  });

  const flush = bridge.runtimeMessages.find((message) => message.type === "flush_pending");
  assert.deepEqual(plain(flush), {
    type: "flush_pending",
    provider: "shopee",
    provider_account_id: "shop-1",
  });
});

test("keeps historical recovery batches deferred until recovery completes", async () => {
  const bridge = contentBridge();

  await bridge.providerEvent({
    type: "recovery_batch",
    request_id: "sync-1:chat-1:0",
    provider_account_id: "shop-1",
    body: { messages: [echo] },
  });

  const queue = bridge.runtimeMessages.find((message) => message.type === "queue_messages");
  assert.equal(queue?.flush, false);
  assert.equal(queue?.advance_cursor, false);
});

test("flushes each recurring poll recovery batch immediately", async () => {
  const bridge = contentBridge();

  await bridge.providerEvent({
    type: "recovery_batch",
    request_id: "poll:poll-1:chat-1:0",
    provider_account_id: "shop-1",
    body: { messages: [echo] },
  });

  const queue = bridge.runtimeMessages.find((message) => message.type === "queue_messages");
  assert.equal(queue?.flush, true);
  assert.equal(queue?.advance_cursor, false);
});

test("keeps message-level buyer profile data when the conversation list profile is missing", async () => {
  const bridge = contentBridge("/portal/chat-management");

  await bridge.providerEvent({
    type: "realtime_event",
    body: {
      messages: [{
        ...echo,
        participant: {
          id: "buyer-1",
          display_name: "Buyer from history",
          avatar_url: "https://cdn.example.com/buyer.jpg",
        },
      }],
    },
  });

  assert.deepEqual(
    plain(bridge.runtimeMessages.find((message) => message.type === "queue_messages")?.messages[0].participant),
    {
      id: "buyer-1",
      display_name: "Buyer from history",
      avatar_url: "https://cdn.example.com/buyer.jpg",
    },
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

test("resumes sync when Seller Centre is already open and becomes ready", async () => {
  const bridge = contentBridge("/portal/chat-management");

  await bridge.providerEvent({
    type: "provider_status",
    surface: "seller-centre",
    surface_ready: true,
    chat_open: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 550));

  assert.equal(
    bridge.runtimeMessages.filter((message) => message.type === "resume_sync").length,
    1,
  );
});

test("does not reopen Seller Centre from lifecycle events after Chat is closed", async () => {
  const bridge = contentBridge("/portal/chat-management");

  await bridge.providerEvent({
    type: "provider_status",
    surface: "seller-centre",
    surface_ready: true,
    chat_open: false,
  });
  await bridge.triggerWindowEvent("focus");
  await new Promise((resolve) => setTimeout(resolve, 550));

  assert.equal(
    bridge.runtimeMessages.filter((message) => message.type === "resume_sync").length,
    0,
  );
});

test("waits for the Seller Centre page bridge before unattended recovery opens mini chat", async () => {
  const bridge = contentBridge("/portal/sale/order", {
    localConsent: true,
    storage: {
      unattended_recovery: true,
      config: {
        version: 2,
        accounts: [{ provider: "shopee", provider_account_id: "shop-1" }],
      },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    bridge.runtimeMessages.filter((message) => message.type === "prepare_provider_v3").length,
    0,
  );
  await bridge.providerEvent({
    type: "provider_status",
    surface: "seller-centre",
    surface_ready: false,
    chat_open: false,
  });

  const preparation = bridge.runtimeMessages.find((message) => message.type === "prepare_provider_v3");
  assert.match(preparation?.request_id, /^auto-open:/);
  await bridge.providerEvent({
    type: "provider_status",
    surface: "seller-centre",
    surface_ready: true,
    chat_open: true,
  });
  await bridge.providerEvent({
    type: "prepare_provider_result",
    request_id: preparation.request_id,
    ok: true,
    surface: "seller-centre",
    surface_ready: true,
  });

  const detection = bridge.runtimeMessages.find((message) => message.type === "detect_account_v3");
  assert.ok(detection?.request_id);
  await bridge.providerEvent({
    type: "accounts_detected",
    request_id: detection.request_id,
    accounts: [{ provider: "shopee", provider_account_id: "shop-1" }],
  });
  await new Promise((resolve) => setTimeout(resolve, 550));

  assert.equal(
    bridge.runtimeMessages.filter((message) => message.type === "auto_sync_now").length,
    1,
  );
  assert.equal(
    bridge.runtimeMessages.filter((message) => message.type === "resume_sync").length,
    0,
  );

  await bridge.providerEvent({
    type: "provider_status",
    surface: "seller-centre",
    surface_ready: true,
    chat_open: false,
  });
  await bridge.sendCommand({ type: "auto_open_chat_and_sync_v3" });
  await new Promise((resolve) => setImmediate(resolve));

  const preparations = bridge.runtimeMessages.filter((message) => message.type === "prepare_provider_v3");
  assert.equal(preparations.length, 2);
  await bridge.providerEvent({
    type: "prepare_provider_result",
    request_id: preparations[1].request_id,
    ok: false,
    error: "Test recovery stopped.",
  });
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

for (const pathname of [
  "/",
  "/404",
  "/portal",
  "/portal/",
  "/portal/chat-management",
  "/portal/sale/order",
]) {
  test(`does not open Seller Centre automatically when unattended recovery is disabled on ${pathname}`, async () => {
    const bridge = contentBridge(pathname);

    await new Promise((resolve) => setTimeout(resolve, 550));

    assert.equal(
      bridge.runtimeMessages.filter((message) => ["resume_sync", "prepare_provider_v3"].includes(message.type)).length,
      0,
    );
  });
}

test("preserves provider uncertainty instead of reporting a definite rejection", async () => {
  const bridge = contentBridge("/new-webchat/conversations", { localConsent: true });
  const result = bridge.sendCommand(command);
  await bridge.providerEvent({ type: "api_send_result", request_id: command.request_id, ok: false, uncertain: true, error: "native response lost" });
  assert.equal((await result).uncertain, true);
});

test("reuses cached buyer names without automatic replacement", async () => {
  const bridge = contentBridge("/portal/chat-management");
  for (const [id, participant] of [
    ["profile-1", { id: "buyer-1", display_name: "First name" }],
    ["profile-2", undefined],
    ["profile-3", { id: "buyer-1", display_name: "Updated name" }],
    ["profile-4", undefined],
  ]) {
    await bridge.providerEvent({ type: "realtime_event", body: { messages: [{ ...echo, id, participant }] } });
  }
  const names = bridge.runtimeMessages.filter((message) => message.type === "queue_messages")
    .map((message) => message.messages[0].participant?.display_name);
  assert.deepEqual(names, ["First name", "First name", "First name", "First name"]);
});

test("uses observed conversation mapping and preserves names through incomplete profile updates", async () => {
  const bridge = contentBridge("/portal/chat-management");
  for (const [id, name] of [["mapped-1", "List name"], ["mapped-2", undefined], ["mapped-3", "New list name"]]) {
    await bridge.providerEvent({
      type: "profiles_detected",
      profiles: [{ conversation_id: echo.conversation_id, id: "buyer-1", ...(name ? { display_name: name } : {}) }],
    });
    await bridge.providerEvent({ type: "realtime_event", body: { messages: [{ ...echo, id }] } });
  }
  const names = bridge.runtimeMessages.filter((message) => message.type === "queue_messages")
    .map((message) => message.messages[0].participant?.display_name);
  assert.deepEqual(names, ["List name", "List name", "List name"]);
});


test("cancel during checkpoint loading prevents a stale recovery from starting", async () => {
  let finishCheckpoint;
  const account = { provider: "shopee", provider_account_id: "shop-1" };
  const bridge = contentBridge("/new-webchat/conversations", {
    localConsent: true, storage: { config: { accounts: [account] }, detected_accounts: [account] },
    runtimeHandler: message => message.type === "get_sync_state"
      ? new Promise(resolve => { finishCheckpoint = resolve; }) : { ok: true },
  });
  const old = bridge.sendCommand({ type: "sync_now_v3", provider_account_id: "shop-1", request_id: "old" });
  await new Promise(resolve => setImmediate(resolve));
  await bridge.requestMessage({ type: "cancel_sync_v3" });
  finishCheckpoint({ ok: true, checkpoint: {} });
  assert.equal((await old).ok, false);
  assert.equal(bridge.runtimeMessages.some(message => message.type === "sync_v3"), false);
});

test("content forwards attempt-scoped recovery activity and cancellation", async () => {
  const account = { provider: "shopee", provider_account_id: "shop-1" };
  const bridge = contentBridge("/new-webchat/conversations", {
    localConsent: true, storage: { config: { accounts: [account] }, detected_accounts: [account] },
  });
  const running = bridge.sendCommand({ type: "sync_now_v3", provider_account_id: "shop-1", request_id: "current" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(bridge.runtimeMessages.find(message => message.type === "sync_v3").request_id, "current");
  assert.equal(bridge.runtimeMessages.find(message => message.type === "sync_activity").request_id, "current");
  await bridge.requestMessage({ type: "cancel_sync_v3", request_id: "old" });
  assert.equal(bridge.runtimeMessages.some(message => message.type === "cancel_sync_v3"), false);
  await bridge.requestMessage({ type: "cancel_sync_v3", request_id: "current" });
  assert.equal((await running).ok, false);
});


test("preserves missing-conversation codes across the content bridge", async () => {
  const bridge = contentBridge();
  const pending = bridge.sendCommand({ ...command, request_id: "missing-1" });
  await bridge.providerEvent({ type: "api_send_result", request_id: "missing-1", ok: false,
    error_code: "SHOPEE_CONVERSATION_MISSING", error: "Shopee conversation is missing." });
  assert.equal((await pending).error_code, "SHOPEE_CONVERSATION_MISSING");
});

const routingEnvelope = (fields, observed_at = "2026-10-21T03:00:00Z") => ({ routing: { version: 1, fields, observed_at } });

test("forwards observed routing with messages and keeps it isolated by shop", async () => {
  const bridge = contentBridge();
  for (const [shop, buyer] of [["shop-1", "123"], ["shop-2", "456"]]) {
    await bridge.providerEvent({ type: "profiles_detected", profiles: [{
      conversation_id: echo.conversation_id, id: buyer, provider_account_id: shop,
      omnichat: routingEnvelope({ to_id: buyer, to_shop_id: "0", biz_id: "0", cookie: "secret" }),
    }] });
  }
  for (const shop of ["shop-1", "shop-2"]) {
    await bridge.providerEvent({ type: "realtime_event", body: { messages: [{ ...echo, id: `route-${shop}`, provider_account_id: shop }] } });
  }
  const messages = bridge.runtimeMessages.filter(message => message.type === "queue_messages").map(message => message.messages[0]);
  assert.equal(messages[0].provider_account_id, "shop-1");
  assert.equal(messages[1].provider_account_id, "shop-2");
  assert.equal(messages[0].omnichat.routing.fields.to_id, "123");
  assert.equal(messages[1].omnichat.routing.fields.to_id, "456");
  assert.equal(messages[0].omnichat.routing.fields.to_shop_id, "0");
  assert.equal(messages[0].omnichat.routing.fields.cookie, undefined);
});

test("partial and stale profile observations do not erase complete observed routing", async () => {
  const bridge = contentBridge();
  for (const [fields, time] of [
    [{ to_id: "123", to_shop_id: "456", biz_id: "3" }, "2026-10-21T03:00:00Z"],
    [{ biz_id: "0" }, "2026-10-21T03:01:00Z"],
    [{ to_id: "999", to_shop_id: "999" }, "2026-10-21T02:59:00Z"],
  ]) {
    await bridge.providerEvent({ type: "profiles_detected", profiles: [{ conversation_id: echo.conversation_id,
      id: "123", provider_account_id: "shop-1", omnichat: routingEnvelope(fields, time) }] });
  }
  await bridge.providerEvent({ type: "realtime_event", body: { messages: [{ ...echo, id: "partial-route", provider_account_id: "shop-1" }] } });
  const message = bridge.runtimeMessages.find(message => message.type === "queue_messages").messages[0];
  assert.deepEqual(plain(message.omnichat.routing.fields), { to_id: "123", to_shop_id: "456", biz_id: "0" });
  assert.equal(message.omnichat.routing.observed_at, "2026-10-21T03:01:00Z");
});


test("LINE rejection diagnostics survive the content response without changing uncertainty", async () => {
  const bridge = contentBridge("/account/bot/chat", { provider: "line_oa" });
  const pending = bridge.sendCommand({ ...command, request_id: "line-diagnostic", provider: "line_oa" });
  const diagnostics = { diagnostic_version: 1, provider: "line_oa", operation: "send",
    http_status: 400, native_error_code: "INVALID_REQUEST", native_attempted: true,
    delivery_uncertain: false, validation_fields: ["clientMessageId"] };
  await bridge.providerEvent({ type: "api_send_result", request_id: "line-diagnostic", ok: false,
    error: "LINE OA send failed (400).", diagnostics });
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.uncertain, undefined);
  assert.deepEqual(plain(result.diagnostics), diagnostics);
});


test("LINE recovery and account failure logs retain structured evidence without page error descriptions", async () => {
  const bridge = contentBridge("/account/bot/chat", { provider: "line_oa" });
  const diagnostics = { diagnostic_version: 1, provider: "line_oa", operation: "recovery", http_status: 403,
    failure_kind: "provider_rejection", native_error_code: "FORBIDDEN",
    body: "private response", error_message: "private response", stack: "private stack" };
  await bridge.providerEvent({ type: "recovery_complete", request_id: "recover-error", ok: false,
    error: "private response", diagnostics });
  const detection = bridge.sendCommand({ type: "detect_account_v3", provider: "line_oa" });
  await new Promise(resolve => setImmediate(resolve));
  const request = bridge.runtimeMessages.findLast(message => message.type === "detect_account_v3");
  assert.ok(request);
  await bridge.providerEvent({ type: "account_detection_failed", request_id: request.request_id,
    error: "private response", diagnostics: { ...diagnostics, operation: "initialize" } });
  await detection;
  for (const event of ["recovery_failed", "account_detection_failed"]) {
    const log = bridge.runtimeMessages.find(message => message.type === "record_log" && message.event === event);
    assert.ok(log);
    assert.equal(log.details.http_status, 403);
    assert.equal(log.details.native_error_code, "FORBIDDEN");
    assert.equal(log.details.operation, event === "recovery_failed" ? "recovery" : "initialize");
    assert.doesNotMatch(JSON.stringify(log), /private response|private stack|error_message/);
  }
});


test("typed recovery supersession is informational while an untyped abort remains failure", async () => {
  const bridge = contentBridge();
  await bridge.providerEvent({ type: "recovery_complete", request_id: "replaced", ok: false,
    reason_code: "superseded", error: "private provider response" });
  await bridge.providerEvent({ type: "recovery_complete", request_id: "failed", ok: false,
    error: "Recovery was superseded by a bridge reconnect.",
    diagnostics: { diagnostic_version: 1, operation: "recovery", error_name: "AbortError" } });
  const logs = bridge.runtimeMessages.filter(message => message.type === "record_log");
  const superseded = logs.find(log => log.event === "recovery_superseded");
  assert.equal(superseded.level, "info");
  assert.equal(superseded.details.reason_code, "superseded");
  assert.equal(logs.find(log => log.event === "recovery_failed").level, "error");
  assert.doesNotMatch(JSON.stringify(logs), /private provider response/);
});

for (const persisted of [true, false]) {
  test(`manual recovery suppresses fallback ERROR only after logging acknowledgement ${persisted}`, async () => {
    const account = { provider: "shopee", provider_account_id: "shop-1" };
    const bridge = contentBridge("/new-webchat/conversations", {
      localConsent: true, storage: { config: { accounts: [account] }, detected_accounts: [account] },
      runtimeHandler: message => ({ ok: message.type === "record_log" ? persisted : true }),
    });
    const running = bridge.sendCommand({ type: "sync_now_v3", provider_account_id: "shop-1", request_id: "failed" });
    await new Promise(resolve => setImmediate(resolve));
    await bridge.providerEvent({ type: "recovery_complete", request_id: "failed", ok: false, error: "Failed." });
    const result = await running;
    assert.equal(result.ok, false);
    assert.equal(result.recovery_diagnostic_recorded, persisted);
  });
}

test("LINE account reset during checkpoint loading leaves other OA recovery running", async () => {
  const accounts = ["oa-a", "oa-b"].map(id => ({ provider: "line_oa", provider_account_id: id, bot_id: `bot-${id}` }));
  const checkpoints = new Map();
  const bridge = contentBridge("/bot-oa-a/chats", {
    provider: "line_oa", localConsent: true,
    storage: { config: { accounts }, detected_accounts: accounts },
    runtimeHandler: message => message.type === "get_sync_state"
      ? new Promise(resolve => checkpoints.set(message.provider_account_id, resolve)) : { ok: true },
  });
  const a = bridge.sendCommand({ type: "sync_now_v3", provider_account_id: "oa-a", bot_id: "bot-oa-a", request_id: "a" });
  const b = bridge.sendCommand({ type: "sync_now_v3", provider_account_id: "oa-b", bot_id: "bot-oa-b", request_id: "b" });
  await new Promise(resolve => setImmediate(resolve));
  await bridge.requestMessage({ type: "cancel_sync_v3", provider_account_id: "oa-a" });
  for (const resolve of checkpoints.values()) resolve({ ok: true, checkpoint: {} });
  assert.equal((await a).ok, false);
  await new Promise(resolve => setImmediate(resolve));
  const requests = bridge.runtimeMessages.filter(message => message.type === "sync_v3");
  assert.deepEqual(requests.map(message => message.provider_account_id), ["oa-b"]);
  await bridge.providerEvent({ type: "recovery_complete", request_id: "b", provider_account_id: "oa-b", ok: true, recovered: 0 });
  assert.equal((await b).ok, true);
});

test("LINE reset after recovery completes forwards its account and retains per-account polling status", async () => {
  const bridge = contentBridge("/bot-1/chats", { provider: "line_oa" });
  await bridge.providerEvent({ type: "provider_status", provider_polling_active: true,
    provider_polling_account_ids: ["oa-b"], surface_ready: true, realtime_connected: true });
  const status = await bridge.requestMessage({ type: "get_provider_status_v3" });
  assert.deepEqual(plain(status.provider_polling_account_ids), ["oa-b"]);
  await bridge.requestMessage({ type: "cancel_sync_v3", provider_account_id: "oa-a" });
  const cancellation = bridge.runtimeMessages.find(message => message.type === "cancel_sync_v3");
  assert.equal(cancellation.provider_account_id, "oa-a");
  assert.equal(cancellation.request_id, undefined);
});


test("replacing a content bridge preserves uncertainty for an outstanding send", async () => {
  const bridge = contentBridge("/new-webchat/conversations", { localConsent: true });
  const result = bridge.sendCommand(command);
  await new Promise(resolve => setImmediate(resolve));
  bridge.reattach();
  const outcome = await result;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.uncertain, true);
  assert.equal(bridge.runtimeListenerCount, 1);
});

test("LINE verified empty detection settles and clears access without persisting empty accounts", async () => {
  const bridge = contentBridge("/bot-1/chats", { provider: "line_oa", localConsent: true });
  await bridge.providerEvent({ type: "provider_status", account_access_verified: true,
    accessible_account_ids: ["@one"], surface_ready: true });
  const detection = bridge.requestMessage({ type: "detect_account_v3", provider: "line_oa" });
  await new Promise(resolve => setImmediate(resolve));
  const request = bridge.runtimeMessages.findLast(message => message.type === "detect_account_v3");
  await bridge.providerEvent({ type: "provider_status", account_access_verified: true,
    accessible_account_ids: [], surface_ready: true });
  await bridge.providerEvent({ type: "accounts_detected", request_id: request.request_id, accounts: [] });
  assert.deepEqual(plain(await detection), { ok: true, accounts: [] });
  const status = await bridge.requestMessage({ type: "get_provider_status_v3" });
  assert.equal(status.account_access_verified, true);
  assert.deepEqual(plain(status.accessible_account_ids), []);
  assert.deepEqual(plain(status.provider_account_ids), []);
  assert.equal(bridge.runtimeMessages.some(message => message.type === "accounts_detected"), false);
});
