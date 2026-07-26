import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../extension/lib/shopee.js", import.meta.url), "utf8");
const context = vm.createContext({
  location: { origin: "https://seller.shopee.co.th" },
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
  });
});
