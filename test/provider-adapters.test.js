import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const sources = await Promise.all([
  "../extension/lib/shopee-url.js",
  "../extension/lib/provider-adapters.js",
  "../extension/lib/shopee-adapter.js",
].map((path) => readFile(new URL(path, import.meta.url), "utf8")));
const lineOaSource = await readFile(new URL("../extension/lib/line-oa.js", import.meta.url), "utf8");

function createRegistry({ includeLineOA = false } = {}) {
  const context = vm.createContext({
    URL,
    OmnichatShopee: {
      parseShopeeMessages(payload, captureMethod) {
        return [{ payload, captureMethod }];
      },
    },
  });
  for (const source of sources) vm.runInContext(source, context);
  if (includeLineOA) vm.runInContext(lineOaSource, context);
  return context.OmnichatProviderAdapters;
}

const plain = (value) => JSON.parse(JSON.stringify(value));

test("routes only supported Shopee chat URLs to the adapter", () => {
  const registry = createRegistry();
  const adapter = registry.forUrl("https://seller.shopee.co.th/webchat/conversations?conversation_id=1");

  assert.equal(adapter.id, "shopee");
  assert.equal(registry.forPage("https://seller.shopee.co.th/settings").id, "shopee");
  assert.equal(adapter.supports("account_detection"), true);
  assert.equal(adapter.supports("message_recovery"), true);
  assert.equal(adapter.supportsSend("send_text"), true);
  assert.equal(adapter.supportsSend("send_sticker"), false);
  for (const path of ["/", "/404", "/portal", "/portal/", "/portal/chat-management", "/portal/sale/order"]) {
    const url = `https://seller.shopee.co.th${path}`;
    assert.equal(registry.forUrl(url).surfaceForUrl(url), "seller-centre");
  }
  assert.deepEqual(plain(adapter.surfacePriority), ["seller-centre", "legacy"]);
  assert.equal(adapter.chatUrl, "https://seller.shopee.co.th/portal/chat-management");
  assert.equal(registry.forUrl("https://manager.line.biz/"), null);
});

test("allows a future provider to own config validation and page matching", () => {
  const registry = createRegistry();
  const adapter = registry.register({
    id: "line_oa",
    matchesUrl: (url) => String(url).startsWith("https://chat.line.biz/"),
    matchesPage: (url) => String(url).startsWith("https://chat.line.biz/"),
    validateConfig: () => ({ provider: "line_oa" }),
    configOrigins: () => ["https://sync.example.com/events"],
    recoveryUrlForAccount: () => "https://chat.line.biz/",
    providerStatusReady: () => true,
    providerStatusHealthy: () => true,
  });

  assert.equal(registry.get(" line_oa "), adapter);
  assert.deepEqual(plain(registry.list().map((item) => item.id)), ["shopee", "line_oa"]);
  assert.equal(registry.forUrl("https://chat.line.biz/bot-1"), adapter);
  assert.equal(registry.forPage("https://chat.line.biz/bot-1"), adapter);
  assert.equal(adapter.recoveryUrlForAccount(), "https://chat.line.biz/");
  assert.equal(adapter.providerStatusReady({}), true);
  assert.equal(adapter.providerStatusHealthy({}), true);
});

test("normalizes LINE OA Basic IDs without exposing secrets", () => {
  const adapter = createRegistry({ includeLineOA: true }).get("line_oa");

  assert.equal(adapter.chatUrlForAccount({ provider_account_id: "@exampleoa" }), "https://chat.line.biz/account/@exampleoa");
  assert.equal(adapter.chatUrlForAccount({ provider_account_id: "exampleoa" }), "https://chat.line.biz/account/@exampleoa");

  assert.deepEqual(plain(adapter.normalizeAccount({ provider_account_id: " exampleoa ", bot_id: "ignored", display_name: " Example Store " }, "2026-08-30T00:00:00.000Z")), {
    provider: "line_oa",
    provider_account_id: "@exampleoa",
    bot_id: "ignored",
    display_name: "Example Store",
    detected_at: "2026-08-30T00:00:00.000Z",
  });
});

test("accepts only v3 LINE OA configs and preserves shared endpoints", () => {
  const adapter = createRegistry({ includeLineOA: true }).get("line_oa");

  assert.deepEqual(plain(adapter.validateConfig({
    provider: "line_oa",
    provider_account_id: " exampleoa ",
    bot_id: " U74ab0151a03134a97b85e685f69434f5 ",
    tenant_id: " tenant-1 ",
    user_id: " user-1 ",
    events_url: "https://collector.example.com/events/line_oa/tenant-1/channel-1",
    api_url: "https://admin.example.com/api/omnichat/line_oa/tenant-1/channel-1",
    control_url: "https://admin.example.com/api/omnichat/line_oa/tenant-1/channel-1/control",
    logs_url: "https://logs.example.com/omnichat",
    sync_key_url: "https://sync.example.com/v3",
    hmac_secret: "secret-1",
  }, 3)), {
    provider: "line_oa",
    provider_account_id: "@exampleoa",
    bot_id: "U74ab0151a03134a97b85e685f69434f5",
    tenant_id: "tenant-1",
    user_id: "user-1",
    events_url: "https://collector.example.com/events/line_oa/tenant-1/channel-1",
    api_url: "https://admin.example.com/api/omnichat/line_oa/tenant-1/channel-1",
    logs_url: "https://logs.example.com/omnichat",
    hmac_secret: "secret-1",
  });

  assert.throws(() => adapter.validateConfig({
    provider: "line_oa",
    provider_account_id: "channel-1",
    bot_id: "bot-1",
    events_url: "https://collector.example.com/events",
    hmac_secret: "secret-1",
  }, 2), /LINE OA requires a version 3 configuration/);

  assert.throws(() => adapter.validateConfig({
    provider: "line_oa",
    provider_account_id: "channel-1",
    events_url: "https://collector.example.com/events",
    hmac_secret: "secret-1",
  }, 3), /api_url/);
});

test("requests the LINE API origin for the generic ping", () => {
  const adapter = createRegistry({ includeLineOA: true }).get("line_oa");
  assert.deepEqual(plain(adapter.configOrigins({
    events_url: "https://collector.example.com/events",
    api_url: "https://admin.example.com/api/omnichat/line_oa/tenant-1/channel-1",
    logs_url: "https://logs.example.com/omnichat",
  })), [
    "https://collector.example.com/events",
    "https://admin.example.com/api/omnichat/line_oa/tenant-1/channel-1",
    "https://logs.example.com/omnichat",
  ]);
});

test("extracts a LINE OA Basic ID from the Manager link in page HTML", () => {
  const context = vm.createContext({
    URL,
    document: {
      documentElement: {
        outerHTML: '<a href="https://manager.line.biz/account/@exampleoa">LINE Official Account</a>',
      },
    },
  });
  vm.runInContext(lineOaSource, context);

  assert.equal(context.OmnichatLineOA.basicIdFromHtml(), "@exampleoa");
  assert.equal(context.OmnichatLineOA.basicIdFromHtml(
    '<a href="https://manager.line.biz/account/@exampleoa">LINE Official Account</a>',
  ), "@exampleoa");
  assert.equal(context.OmnichatLineOA.basicIdFromHtml(
    '<a href="https://manager.line.biz/account/%40exampleoa">LINE Official Account</a>',
  ), "@exampleoa");
});

test("extracts and merges Shopee accounts without treating user IDs as shop IDs", () => {
  const adapter = createRegistry().get("shopee");
  const accounts = adapter.accountsFromPayload({
    user: { id: 4897267 },
    shop: { id: 100000001, user_id: 100000002, name: "Example Shop" },
    shops: [
      { id: 100000001, name: "Example Shop", logo: "https://cdn.example.com/shop.jpg" },
      { id: 100000003, name: "Example Shop Two" },
    ],
    conversations: [{ shop_id: 100000004, shop_name: "Example Shop Three" }],
    ShopIds: [100000001, 100000003, 100000004],
  });

  assert.deepEqual(plain(accounts), [
    {
      provider: "shopee",
      provider_account_id: "100000001",
      display_name: "Example Shop",
      provider_user_id: "4897267",
      shop_user_id: "100000002",
      avatar_url: "https://cdn.example.com/shop.jpg",
    },
    { provider: "shopee", provider_account_id: "100000003", display_name: "Example Shop Two", provider_user_id: "4897267" },
    { provider: "shopee", provider_account_id: "100000004", display_name: "Example Shop Three" },
  ]);
  assert.equal(accounts.some((account) => account.provider_account_id === "100000002"), false);
});

test("extracts a Shopee display name from the nested Seller Centre session", () => {
  const adapter = createRegistry().get("shopee");

  assert.deepEqual(plain(adapter.accountsFromPayload({
    data: { shop_id: 100000001, shop_name: "example-store" },
  })), [{
    provider: "shopee",
    provider_account_id: "100000001",
    display_name: "example-store",
  }]);
});

test("normalizes detected account metadata and rejects unsafe avatar URLs", () => {
  const adapter = createRegistry().get("shopee");
  assert.deepEqual(plain(adapter.normalizeAccount({
    provider_account_id: 123,
    display_name: " Shop ",
    avatar_url: "http://example.com/avatar.jpg",
    provider_user_id: 456,
  }, "2026-08-30T00:00:00.000Z")), {
    provider: "shopee",
    provider_account_id: "123",
    display_name: "Shop",
    provider_user_id: "456",
    detected_at: "2026-08-30T00:00:00.000Z",
  });
});

test("keeps message normalization behind the provider boundary", () => {
  const adapter = createRegistry().get("shopee");
  assert.deepEqual(plain(adapter.normalizeMessages({ messages: [] }, "realtime_socket")), [{
    payload: { messages: [] },
    captureMethod: "realtime_socket",
  }]);
});

test("LINE OA retains sticker identity, a display URL, and its send correlation ID", () => {
  const adapter = createRegistry({ includeLineOA: true }).get("line_oa");
  const messages = adapter.normalizeMessages({ provider_account_id: "@test", messages: [{ type: "message", timestamp: 1000, source: { chatId: "chat-1", userId: "user-1" }, message: { id: "msg-1", sendId: "admin-client-message-1", type: "sticker", packageId: "123", stickerId: "10445608" } }] }, "history_recovery");
  assert.deepEqual(plain(messages[0].sticker), { package_id: "123", sticker_id: "10445608" });
  assert.equal(messages[0].client_message_id, "admin-client-message-1");
  assert.match(messages[0].media_url, /10445608\/ANDROID\/sticker.png$/);
});
