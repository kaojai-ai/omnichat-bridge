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

test("keeps the Shopee Shop ID on normalized messages", () => {
  const messages = context.OmnichatShopee.parseShopeeMessages({
    id: "message-account",
    conversation_id: "conversation-1",
    from_id: "buyer-1",
    to_id: "shop-user-1",
    to_shop_id: 1549058683,
    type: "text",
    created_timestamp: 1_753_225_200,
    content: { text: "Hello" },
  }, "realtime_socket");

  assert.equal(messages[0].provider_account_id, "1549058683");
  assert.equal(messages[0].sender_account_id, undefined);
  assert.equal(messages[0].recipient_account_id, "1549058683");
});

test("uses the product Shop ID when message routing metadata is absent", () => {
  const messages = context.OmnichatShopee.parseShopeeMessages({
    id: "message-product-account",
    conversation_id: "conversation-1",
    from_id: "buyer-1",
    to_id: "shop-user-1",
    type: "product",
    created_timestamp: 1_753_225_200,
    content: { product_id: 123, product_name: "Car cover", shop_id: 1549058683 },
  }, "realtime_socket");

  assert.equal(messages[0].provider_account_id, "1549058683");
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

test("normalizes Shopee video media keys to the player URL", () => {
  const messages = context.OmnichatShopee.parseShopeeMessages({
    id: "video-1",
    conversation_id: "conversation-1",
    from_id: "buyer-1",
    to_id: "shop-user-1",
    to_shop_id: "11110133",
    type: "video",
    created_timestamp: 1_754_820_642,
    content: { video_url: "th-11110133-6v8gu-mrpkn7hlghzc35" },
  }, "realtime_socket");

  assert.equal(
    messages[0].media_url,
    "https://down-ws-sg.vod.susercontent.com/api/v4/11110133/mms/th-11110133-6v8gu-mrpkn7hlghzc35.default.mp4",
  );
});

test("prefers Shopee's player URL over a legacy video CDN URL", () => {
  const playerUrl = "https://down-ws-sg.vod.susercontent.com/api/v4/11110133/mms/th-11110133-6v8gu-mrpkn7hlghzc35.default.mp4";
  const messages = context.OmnichatShopee.parseShopeeMessages({
    id: "video-2",
    conversation_id: "conversation-1",
    from_id: "buyer-1",
    to_id: "shop-user-1",
    type: "video",
    created_timestamp: 1_754_820_642,
    content: {
      video_url: "https://down-tx-sg.vod.susercontent.com/f97f42183dcae470d3a3d29bfcbf4c94",
      vid: "th-11110133-6v8gu-mrpkn7hlghzc35",
    },
  }, "realtime_socket");

  assert.equal(messages[0].media_url, playerUrl);
});
