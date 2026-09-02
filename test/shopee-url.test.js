import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../extension/lib/shopee-url.js", import.meta.url), "utf8");
const context = vm.createContext({ URL });
vm.runInContext(source, context);

const { isShopeePageUrl, isShopeeChatPath, isShopeeChatUrl, surfaceForPath, surfaceForUrl } = context.OmnichatShopeeUrl;

test("routes only old Webchat paths to legacy and Seller Centre pages to Seller Centre", () => {
  const legacyPaths = ["/new-webchat", "/new-webchat/conversations", "/webchat", "/webchat/conversations"];
  const sellerCentrePaths = ["/", "/portal", "/portal/", "/portal/chat-management", "/portal/sale/order", "/404"];
  for (const path of [...legacyPaths, ...sellerCentrePaths]) {
    assert.equal(isShopeeChatPath(path), true);
    assert.equal(isShopeeChatUrl(`https://seller.shopee.co.th${path}?conversation_id=conversation-1`), true);
  }
  for (const path of legacyPaths) assert.equal(surfaceForPath(path), "legacy");
  for (const path of sellerCentrePaths) {
    assert.equal(surfaceForPath(path), "seller-centre");
    assert.equal(surfaceForUrl(`https://seller.shopee.co.th${path}`), "seller-centre");
  }
});

test("keeps Shopee Seller Chat matching origin-locked", () => {
  assert.equal(isShopeePageUrl("https://seller.shopee.co.th/settings"), true);
  assert.equal(isShopeePageUrl("https://seller.shopee.co.th.evil.example/settings"), false);
  assert.equal(isShopeeChatUrl("https://seller.shopee.co.th/shop/123"), true);
  assert.equal(isShopeeChatUrl("https://seller.shopee.co.th.evil.example/webchat/conversations"), false);
  assert.equal(isShopeeChatUrl("https://example.com/webchat/conversations"), false);
});
