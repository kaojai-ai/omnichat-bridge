import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../extension/lib/shopee-url.js", import.meta.url), "utf8");
const context = vm.createContext({ URL });
vm.runInContext(source, context);

const { isShopeePageUrl, isShopeeChatPath, isShopeeChatUrl, surfaceForPath, surfaceForUrl } = context.OmnichatShopeeUrl;

test("accepts both Shopee Seller Chat URLs", () => {
  for (const path of ["/new-webchat/conversations", "/webchat/conversations", "/portal/chat-management", "/"]) {
    assert.equal(isShopeeChatPath(path), true);
    assert.equal(isShopeeChatUrl(`https://seller.shopee.co.th${path}?conversation_id=conversation-1`), true);
  }
  assert.equal(surfaceForPath("/new-webchat/conversations"), "legacy");
  assert.equal(surfaceForPath("/webchat/conversations"), "legacy");
  assert.equal(surfaceForPath("/portal/chat-management"), "seller-centre");
  assert.equal(surfaceForPath("/"), "seller-centre");
  assert.equal(surfaceForUrl("https://seller.shopee.co.th/portal/chat-management"), "seller-centre");
});

test("keeps Shopee Seller Chat matching origin-locked", () => {
  assert.equal(isShopeePageUrl("https://seller.shopee.co.th/settings"), true);
  assert.equal(isShopeePageUrl("https://seller.shopee.co.th.evil.example/settings"), false);
  assert.equal(isShopeeChatUrl("https://seller.shopee.co.th/shop/123"), false);
  assert.equal(isShopeeChatUrl("https://seller.shopee.co.th.evil.example/webchat/conversations"), false);
  assert.equal(isShopeeChatUrl("https://example.com/webchat/conversations"), false);
});
