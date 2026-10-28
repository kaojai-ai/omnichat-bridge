const SHOPEE_SELLER_ORIGINS = Object.freeze({
  TH: "https://seller.shopee.co.th",
  MY: "https://seller.shopee.com.my",
  PH: "https://seller.shopee.ph",
  SG: "https://seller.shopee.sg",
  ID: "https://seller.shopee.co.id",
  VN: "https://banhang.shopee.vn",
});

function countryForUrl(value) {
  try {
    const origin = new URL(value).origin;
    return Object.keys(SHOPEE_SELLER_ORIGINS).find(country => SHOPEE_SELLER_ORIGINS[country] === origin) ?? null;
  } catch { return null; }
}

function originForAccount(account) {
  const country = String(account?.country ?? "TH").trim().toUpperCase();
  const origin = SHOPEE_SELLER_ORIGINS[country];
  if (!origin) throw new Error("Unsupported Shopee account country.");
  return origin;
}
const SHOPEE_CHAT_SURFACES = Object.freeze({
  "new-webchat": Object.freeze([
    "/new-webchat",
  ]),
  "webchat": Object.freeze([
    "/webchat",
  ]),
  "seller-centre": Object.freeze([
    "/",
    "/portal",
  ]),
});

function isShopeePageUrl(value) {
  try {
    const url = new URL(value);
    return Boolean(countryForUrl(url.href));
  } catch {
    return false;
  }
}

function normalizedPath(pathname) {
  return pathname.replace(/\/+$/, "") || "/";
}

function pathMatches(path, prefix) {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function surfaceForPath(pathname) {
  if (typeof pathname !== "string") return null;
  const path = normalizedPath(pathname);
  if (pathMatches(path, "/webchat/api")) return null;
  if (SHOPEE_CHAT_SURFACES.webchat.some(chatPath => pathMatches(path, chatPath))) return "webchat";
  if (SHOPEE_CHAT_SURFACES["new-webchat"].some((chatPath) => pathMatches(path, chatPath))) {
    return "new-webchat";
  }
  return "seller-centre";
}

function isShopeeChatPath(pathname) {
  return Boolean(surfaceForPath(pathname));
}

function surfaceForUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return Boolean(countryForUrl(url.href)) ? surfaceForPath(url.pathname) : null;
  } catch {
    return null;
  }
}

function isShopeeChatUrl(value) {
  return Boolean(surfaceForUrl(value));
}

globalThis.OmnichatShopeeUrl = {
  sellerOrigins: SHOPEE_SELLER_ORIGINS,
  countryForUrl,
  originForAccount,
  chatSurfaces: SHOPEE_CHAT_SURFACES,
  isShopeePageUrl,
  isShopeeChatPath,
  isShopeeChatUrl,
  surfaceForPath,
  surfaceForUrl,
};
