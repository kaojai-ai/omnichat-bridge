const SHOPEE_SELLER_ORIGIN = "https://seller.shopee.co.th";
const SHOPEE_CHAT_SURFACES = Object.freeze({
  legacy: Object.freeze([
    "/new-webchat/conversations",
    "/webchat/conversations",
  ]),
  "seller-centre": Object.freeze([
    "/portal/chat-management",
    "/",
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

function surfaceForPath(pathname) {
  if (typeof pathname !== "string") return null;
  const path = normalizedPath(pathname);
  for (const [surface, paths] of Object.entries(SHOPEE_CHAT_SURFACES)) {
    if (paths.some((chatPath) => path === chatPath || path.startsWith(`${chatPath}/`))) {
      return surface;
    }
  }
  return null;
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
