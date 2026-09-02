import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const sources = await Promise.all([
  "../extension/lib/shopee-url.js",
  "../extension/lib/provider-adapters.js",
  "../extension/lib/shopee-adapter.js",
].map((path) => readFile(new URL(path, import.meta.url), "utf8")));

function createRegistry() {
  const context = vm.createContext({
    URL,
    OmnichatShopee: {
      parseShopeeMessages(payload, captureMethod) {
        return [{ payload, captureMethod }];
      },
    },
  });
  for (const source of sources) vm.runInContext(source, context);
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
  assert.equal(registry.forUrl("https://seller.shopee.co.th/portal/chat-management").surfaceForUrl("https://seller.shopee.co.th/portal/chat-management"), "seller-centre");
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
  });

  assert.equal(registry.get(" line_oa "), adapter);
  assert.deepEqual(plain(registry.list().map((item) => item.id)), ["shopee", "line_oa"]);
  assert.equal(registry.forUrl("https://chat.line.biz/bot-1"), adapter);
  assert.equal(registry.forPage("https://chat.line.biz/bot-1"), adapter);
});

test("extracts and merges Shopee accounts without treating user IDs as shop IDs", () => {
  const adapter = createRegistry().get("shopee");
  const accounts = adapter.accountsFromPayload({
    user: { id: 4897267 },
    shop: { id: 1549058683, user_id: 1549897350, name: "Thailand shop" },
    shops: [
      { id: 1549058683, name: "Thailand shop", logo: "https://cdn.example.com/shop.jpg" },
      { id: 1698999861, name: "Malaysia shop" },
    ],
    conversations: [{ shop_id: 1698999856, shop_name: "Philippines shop" }],
    ShopIds: [1549058683, 1698999861, 1698999856],
  });

  assert.deepEqual(plain(accounts), [
    {
      provider: "shopee",
      provider_account_id: "1549058683",
      display_name: "Thailand shop",
      provider_user_id: "4897267",
      shop_user_id: "1549897350",
      avatar_url: "https://cdn.example.com/shop.jpg",
    },
    { provider: "shopee", provider_account_id: "1698999861", display_name: "Malaysia shop", provider_user_id: "4897267" },
    { provider: "shopee", provider_account_id: "1698999856", display_name: "Philippines shop" },
  ]);
  assert.equal(accounts.some((account) => account.provider_account_id === "1549897350"), false);
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
