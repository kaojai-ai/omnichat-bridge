import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../extension/lib/shopee.js", import.meta.url), "utf8");
const context = vm.createContext({
  location: { origin: "https://seller.shopee.co.th" },
  URL,
});
vm.runInContext(source, context);

test("normalizes Shopee product echoes with provider product metadata", () => {
  const messages = context.OmnichatShopee.parseShopeeMessages({
    id: "message-1",
    conversation_id: "conversation-1",
    from_id: "shop-user-1",
    from_shop_id: "shop-1",
    to_id: "buyer-1",
    type: "product",
    created_timestamp: 1_753_225_200,
    content: {
      uid: "client-message-1",
      product_id: 123456,
      shop_id: 789012,
      product_name: "Car cover",
    },
  }, "realtime_socket");

  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, "product");
  assert.equal(messages[0].text, "Car cover");
  assert.equal(messages[0].client_message_id, "client-message-1");
  assert.deepEqual(JSON.parse(JSON.stringify(messages[0].product)), {
    provider_product_id: "123456",
    product_name: "Car cover",
    provider_account_id: "789012",
  });
});

test("normalizes Shopee stickers with a renderable media URL", () => {
  const messages = context.OmnichatShopee.parseShopeeMessages({
    id: "sticker-1",
    conversation_id: "conversation-1",
    from_id: "buyer-1",
    to_id: "shop-user-1",
    to_shop_id: "shop-1",
    type: "sticker",
    created_timestamp: 1_753_225_200,
    content: { sticker_url: "//cdn.example.com/sticker.webp" },
  }, "realtime_socket");

  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, "sticker");
  assert.equal(messages[0].media_url, "https://cdn.example.com/sticker.webp");
});

test("builds a renderable URL from Shopee sticker IDs", () => {
  const messages = context.OmnichatShopee.parseShopeeMessages({
    id: "sticker-2",
    conversation_id: "conversation-1",
    from_id: "buyer-1",
    to_id: "shop-user-1",
    to_shop_id: "shop-1",
    type: "sticker",
    created_timestamp: 1_753_225_200,
    content: { sticker_id: "0008", sticker_package_id: "sticker_th_choki", format: "png" },
  }, "realtime_socket");

  assert.equal(messages[0].media_url, "https://deo.shopeemobile.com/shopee/shopee-sticker-live-th/packs/sticker_th_choki/0008@1x.png");
});

test("normalizes Shopee emoji payloads as stickers", () => {
  const messages = context.OmnichatShopee.parseShopeeMessages({
    id: "emoji-1",
    conversation_id: "conversation-1",
    from_id: "buyer-1",
    to_id: "shop-user-1",
    to_shop_id: "shop-1",
    type: "emoji_message",
    created_timestamp: 1_753_225_200,
    content: { thumbnail_url: "https://cdn.example.com/emoji.webp" },
  }, "realtime_socket");

  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, "sticker");
  assert.equal(messages[0].media_url, "https://cdn.example.com/emoji.webp");
});
