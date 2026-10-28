import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../extension/lib/shopee-url.js", import.meta.url), "utf8");
const context = vm.createContext({ URL });
vm.runInContext(source, context);

const { isShopeePageUrl, isShopeeChatPath, isShopeeChatUrl, surfaceForPath, surfaceForUrl } = context.OmnichatShopeeUrl;

test("recognizes both standalone pages while excluding API URLs", () => {
  const newWebchatPaths = ["/new-webchat", "/new-webchat/conversations"];
  const webchatPaths = ["/webchat", "/webchat/", "/webchat/conversations", "/webchat/conversations/chat-1"];
  const sellerCentrePaths = ["/", "/portal", "/portal/", "/portal/chat-management", "/portal/sale/order", "/404"];
  for (const path of [...newWebchatPaths, ...webchatPaths, ...sellerCentrePaths]) {
    assert.equal(isShopeeChatPath(path), true);
    assert.equal(isShopeeChatUrl(`https://seller.shopee.co.th${path}?conversation_id=conversation-1`), true);
  }
  for (const path of newWebchatPaths) assert.equal(surfaceForPath(path), "new-webchat");
  for (const path of webchatPaths) assert.equal(surfaceForPath(path), "webchat");
  for (const path of ["/webchat/api", "/webchat/api/v1.2/messages"]) {
    assert.equal(surfaceForPath(path), null);
    assert.equal(isShopeeChatUrl(`https://seller.shopee.co.th${path}`), false);
  }
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

test("six supported markets use exact HTTPS origins and reject lookalikes", () => {
  const expected = {
    TH: "https://seller.shopee.co.th", MY: "https://seller.shopee.com.my", PH: "https://seller.shopee.ph",
    SG: "https://seller.shopee.sg", ID: "https://seller.shopee.co.id", VN: "https://banhang.shopee.vn",
  };
  assert.deepEqual(JSON.parse(JSON.stringify(context.OmnichatShopeeUrl.sellerOrigins)), expected);
  for (const [country, origin] of Object.entries(expected)) {
    assert.equal(context.OmnichatShopeeUrl.countryForUrl(`${origin}/new-webchat`), country);
    assert.equal(context.OmnichatShopeeUrl.originForAccount({ country }), origin);
    assert.equal(isShopeeChatUrl(`${origin}/new-webchat/conversations`), true);
    assert.equal(isShopeePageUrl(`${origin}.evil.example/`), false);
    assert.equal(isShopeePageUrl(origin.replace("https:", "http:")), false);
  }
  assert.throws(() => context.OmnichatShopeeUrl.originForAccount({ country: "US" }), /Unsupported/);
});

test("manifest grants and injects exactly the supported Shopee markets", async () => {
  const manifest = JSON.parse(await readFile(new URL("../extension/manifest.json", import.meta.url), "utf8"));
  const patterns = Object.values(context.OmnichatShopeeUrl.sellerOrigins).map(origin => `${origin}/*`);
  assert.deepEqual(manifest.host_permissions.filter(pattern => !pattern.includes("chat.line.biz")), patterns);
  for (const script of manifest.content_scripts.filter(script => script.js.includes("lib/shopee-url.js"))) {
    assert.deepEqual(script.matches, patterns);
  }
});
