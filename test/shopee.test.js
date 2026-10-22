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
    to_shop_id: 100000001,
    type: "text",
    created_timestamp: 1_753_225_200,
    content: { text: "Hello" },
  }, "realtime_socket");

  assert.equal(messages[0].provider_account_id, "100000001");
  assert.equal(messages[0].sender_account_id, undefined);
  assert.equal(messages[0].recipient_account_id, "100000001");
});

test("normalizes a Seller Centre mini message into the canonical Shopee shape", () => {
  const [message] = context.OmnichatShopee.parseShopeeMessages([{
    id: "mini-message-1",
    conversation_id: "mini-conversation-1",
    from_id: 987654321,
    to_id: 100000001,
    shop_id: 100000001,
    type: "text",
    content: { text: "Hello from Seller Centre" },
    created_timestamp: 1_724_141_000,
  }], "poll");

  assert.equal(message.provider, "shopee");
  assert.equal(message.id, "mini-message-1");
  assert.equal(message.conversation_id, "mini-conversation-1");
  assert.equal(message.provider_account_id, "100000001");
  assert.equal(message.text, "Hello from Seller Centre");
  assert.equal(message.capture_method, "poll");
});

test("derives an incoming Seller Centre buyer profile from message metadata", () => {
  const [message] = context.OmnichatShopee.parseShopeeMessages([{
    id: "mini-incoming-profile",
    conversation_id: "mini-conversation-profile",
    from_id: 987654321,
    to_id: 100000001,
    to_shop_id: 100000001,
    from_user_name: "Buyer from history",
    from_avatar_url: "https://cdn.example.com/buyer.jpg",
    type: "text",
    content: { text: "Hello" },
  }], "poll");

  assert.deepEqual(JSON.parse(JSON.stringify(message.participant)), {
    id: "987654321",
    display_name: "Buyer from history",
    avatar_url: "https://cdn.example.com/buyer.jpg",
  });
});

test("derives an outgoing Seller Centre buyer profile from message metadata", () => {
  const [message] = context.OmnichatShopee.parseShopeeMessages([{
    id: "mini-outgoing-profile",
    conversation_id: "mini-conversation-profile",
    from_id: 100000001,
    from_shop_id: 100000001,
    to_id: 987654321,
    to_user_name: "Buyer reply",
    to_avatar: "https://cdn.example.com/buyer-reply.jpg",
    type: "text",
    content: { text: "Reply" },
  }], "poll");

  assert.deepEqual(JSON.parse(JSON.stringify(message.participant)), {
    id: "987654321",
    display_name: "Buyer reply",
    avatar_url: "https://cdn.example.com/buyer-reply.jpg",
  });
});

test("uses the product Shop ID when message routing metadata is absent", () => {
  const messages = context.OmnichatShopee.parseShopeeMessages({
    id: "message-product-account",
    conversation_id: "conversation-1",
    from_id: "buyer-1",
    to_id: "shop-user-1",
    type: "product",
    created_timestamp: 1_753_225_200,
    content: { product_id: 123, product_name: "Car cover", shop_id: 100000001 },
  }, "realtime_socket");

  assert.equal(messages[0].provider_account_id, "100000001");
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

test("keeps unsupported Shopee card content for later display", () => {
  const content = {
    questions: [
      { text: "สินค้าของฉันจะจัดส่งเมื่อไหร่" },
    ],
  };
  const [message] = context.OmnichatShopee.parseShopeeMessages({
    id: "faq-1",
    conversation_id: "conversation-1",
    from_id: "shop-user-1",
    from_shop_id: "shop-1",
    to_id: "buyer-1",
    type: "new_faq",
    created_timestamp: 1_753_225_200,
    content,
  }, "poll");

  assert.equal(message.type, "unsupported");
  assert.equal(message.provider_type, "new_faq");
  assert.equal(message.text, undefined);
  assert.deepEqual(message.provider_content, content);
});

test("parses unsupported Shopee content when it arrives as a JSON string", () => {
  const content = { order_id: "order-1", status: "paid" };
  const [message] = context.OmnichatShopee.parseShopeeMessages({
    id: "order-1",
    conversation_id: "conversation-1",
    from_id: "shop-user-1",
    from_shop_id: "shop-1",
    to_id: "buyer-1",
    type: "order",
    created_timestamp: 1_753_225_200,
    content: JSON.stringify(content),
  }, "history_recovery");

  assert.equal(message.type, "unsupported");
  assert.equal(message.provider_type, "order");
  assert.deepEqual(JSON.parse(JSON.stringify(message.provider_content)), content);
  assert.deepEqual(JSON.parse(JSON.stringify(message.order)), { provider_order_id: "order-1" });
});

test("does not attach provider content to text messages", () => {
  const [message] = context.OmnichatShopee.parseShopeeMessages({
    id: "text-content-1",
    conversation_id: "conversation-1",
    from_id: "buyer-1",
    to_id: "shop-user-1",
    to_shop_id: "shop-1",
    type: "text",
    created_timestamp: 1_753_225_200,
    content: { text: "Hello" },
  }, "poll");

  assert.equal(message.type, "text");
  assert.equal(message.text, "Hello");
  assert.equal(message.provider_content, undefined);
});

test("preserves polled Shopee rejection evidence without inferring successful delivery", () => {
  const input = {
    id: "failed-message", conversation_id: "conversation-1", from_id: "seller-1",
    to_id: "buyer-1", type: "text", content: { text: "Hello" },
  };
  for (const option of [2, 16, 256, 258, "256"]) {
    const [message] = context.OmnichatShopee.parseShopeeMessages({
      ...input, message_option: option, msg_tag: { msg_ui_opt: 12 },
    }, "poll");
    assert.equal(message.text, "Hello");
    assert.equal(message.provider_content.delivery_failed, true);
    assert.equal(message.provider_content.message_option, Number(option));
    assert.equal(message.provider_content.msg_ui_opt, 12);
  }
  for (const option of [0, 1, 1024]) {
    const [message] = context.OmnichatShopee.parseShopeeMessages({ ...input, message_option: option }, "poll");
    assert.equal(message.provider_content.message_option, option);
    assert.equal(message.provider_content.delivery_failed, undefined);
  }
  for (const option of [null, true, {}, "", "bad", -1, 1.5, 4294967298]) {
    const [message] = context.OmnichatShopee.parseShopeeMessages({ ...input, message_option: option }, "poll");
    assert.equal(message.provider_content, undefined);
  }
});

test("keeps notification content alongside delivery flags for every capture method", () => {
  for (const captureMethod of ["poll", "network_observer", "realtime_socket", "history_recovery"]) {
    const [message] = context.OmnichatShopee.parseShopeeMessages({
      id: "notice-1", conversation_id: "conversation-1", from_id: "seller-1", to_id: "buyer-1",
      type: "notification", content: { notification_for_sender: "Sending failed" },
      message_option: 256,
    }, captureMethod);
    assert.equal(message.provider_content.notification_for_sender, "Sending failed");
    assert.equal(message.provider_content.delivery_failed, true);
  }
});

test("zero recipient shop IDs preserve outgoing seller ownership and buyer profile", () => {
  for (const zero of [0, "0"]) {
    const [message] = context.OmnichatShopee.parseShopeeMessages({
      id: "outgoing-fixture", conversation_id: "conversation-fixture",
      from_id: "seller-user", to_id: "buyer-user", from_shop_id: "seller-shop", to_shop_id: zero,
      to_user_name: "Fixture buyer", type: "text", content: { text: "Fixture reply" },
    }, "network_observer");
    assert.equal(message.provider_account_id, "seller-shop");
    assert.equal(message.sender_account_id, "seller-shop");
    assert.equal(message.recipient_account_id, undefined);
    assert.equal(message.participant.id, "buyer-user");
    assert.equal(message.participant.display_name, "Fixture buyer");
  }
});

test("zero sender shop IDs preserve incoming seller ownership and buyer profile", () => {
  for (const zero of [0, "0"]) {
    const [message] = context.OmnichatShopee.parseShopeeMessages({
      id: "incoming-fixture", conversation_id: "conversation-fixture",
      from_id: "buyer-user", to_id: "seller-user", from_shop_id: zero, to_shop_id: "seller-shop",
      from_user_name: "Fixture buyer", type: "text", content: { text: "Fixture question" },
    }, "realtime_socket");
    assert.equal(message.provider_account_id, "seller-shop");
    assert.equal(message.sender_account_id, undefined);
    assert.equal(message.recipient_account_id, "seller-shop");
    assert.equal(message.participant.id, "buyer-user");
    assert.equal(message.participant.display_name, "Fixture buyer");
  }
});

test("real shop-to-shop routing retains both identities and existing recipient precedence", () => {
  const [message] = context.OmnichatShopee.parseShopeeMessages({
    id: "dual-shop-fixture", conversation_id: "conversation-fixture",
    from_id: "sender-user", to_id: "recipient-user", from_shop_id: "sender-shop", to_shop_id: "recipient-shop",
    type: "text", content: { text: "Fixture message" },
  }, "history_recovery");
  assert.equal(message.provider_account_id, "recipient-shop");
  assert.equal(message.sender_account_id, "sender-shop");
  assert.equal(message.recipient_account_id, "recipient-shop");
});

test("zero-only shop routing never invents account ownership from participant IDs", () => {
  for (const zero of [0, "0"]) {
    const [message] = context.OmnichatShopee.parseShopeeMessages({
      id: "unowned-fixture", conversation_id: "conversation-fixture",
      from_id: "sender-user", to_id: "recipient-user", from_shop_id: zero, to_shop_id: zero, shop_id: zero,
      type: "text", content: { text: "Fixture message", shop_id: zero },
    }, "poll");
    assert.equal(message.provider_account_id, undefined);
    assert.equal(message.sender_account_id, undefined);
    assert.equal(message.recipient_account_id, undefined);
  }
});

test("detected ownership selects either real endpoint without changing route identities", () => {
  const raw = { id: "owned", conversation_id: "fixture-chat", from_id: "sender-user", to_id: "recipient-user",
    from_shop_id: "sender-shop", to_shop_id: "recipient-shop", from_user_name: "Fixture sender", to_user_name: "Fixture recipient",
    type: "text", content: { text: "Fixture" } };
  for (const owner of ["sender-shop", "recipient-shop"]) {
    const [message] = context.OmnichatShopee.parseShopeeMessages(raw, "realtime_socket", { providerAccountIds: [owner] });
    assert.equal(message.provider_account_id, owner);
    assert.equal(message.sender_account_id, "sender-shop");
    assert.equal(message.recipient_account_id, "recipient-shop");
    assert.equal(message.participant.id, owner === "sender-shop" ? "recipient-user" : "sender-user");
  }
  assert.equal(context.OmnichatShopee.parseShopeeMessages(raw, "poll")[0].provider_account_id, "recipient-shop");
});

test("unrelated or ambiguous detected ownership rejects messages before account fallbacks", () => {
  const raw = { id: "unowned", conversation_id: "fixture-chat", from_id: "sender-user", to_id: "recipient-user",
    from_shop_id: "sender-shop", to_shop_id: "recipient-shop", type: "product", content: { product_name: "Fixture", shop_id: "active-shop" } };
  for (const ids of [["active-shop"], ["sender-shop", "recipient-shop"]]) {
    assert.equal(context.OmnichatShopee.parseShopeeMessages(raw, "history_recovery", { providerAccountIds: ids }).length, 0);
  }
  assert.equal(context.OmnichatShopee.parseShopeeMessages({ ...raw, from_shop_id: 0, to_shop_id: 0 }, "poll", { providerAccountIds: ["active-shop"] }).length, 0);
});
