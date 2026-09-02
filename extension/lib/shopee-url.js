const SHOPEE_SELLER_ORIGIN = "https://seller.shopee.co.th";
const SHOPEE_CHAT_SURFACES = Object.freeze({
  legacy: Object.freeze([
    "/new-webchat",
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
    return url.origin === SHOPEE_SELLER_ORIGIN;
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
  if (SHOPEE_CHAT_SURFACES.legacy.some((legacyPath) => pathMatches(path, legacyPath))) {
    return "legacy";
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
    return url.origin === SHOPEE_SELLER_ORIGIN ? surfaceForPath(url.pathname) : null;
  } catch {
    return null;
  }
}

function isShopeeChatUrl(value) {
  return Boolean(surfaceForUrl(value));
}

globalThis.OmnichatShopeeUrl = {
  chatSurfaces: SHOPEE_CHAT_SURFACES,
  isShopeePageUrl,
  isShopeeChatPath,
  isShopeeChatUrl,
  surfaceForPath,
  surfaceForUrl,
};
