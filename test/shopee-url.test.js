import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../extension/lib/shopee-url.js", import.meta.url), "utf8");
const context = vm.createContext({ URL });
vm.runInContext(source, context);

const { isShopeePageUrl, isShopeeChatPath, isShopeeChatUrl } = context.OmnichatShopeeUrl;

test("accepts both Shopee Seller Chat URLs", () => {
  for (const path of ["/new-webchat/conversations", "/webchat/conversations"]) {
    assert.equal(isShopeeChatPath(path), true);
    assert.equal(isShopeeChatUrl(`https://seller.shopee.co.th${path}?conversation_id=conversation-1`), true);
  }
});

test("keeps Shopee Seller Chat matching origin-locked", () => {
  assert.equal(isShopeePageUrl("https://seller.shopee.co.th/settings"), true);
  assert.equal(isShopeePageUrl("https://seller.shopee.co.th.evil.example/settings"), false);
  assert.equal(isShopeeChatUrl("https://seller.shopee.co.th/shop/123"), false);
  assert.equal(isShopeeChatUrl("https://seller.shopee.co.th.evil.example/webchat/conversations"), false);
  assert.equal(isShopeeChatUrl("https://example.com/webchat/conversations"), false);
});
