const SHOPEE_SELLER_ORIGIN = "https://seller.shopee.co.th";
const SHOPEE_CHAT_PATHS = [
  "/new-webchat/conversations",
  "/webchat/conversations",
];

function normalizedPath(pathname) {
  return pathname.replace(/\/+$/, "") || "/";
}

function isShopeeChatPath(pathname) {
  if (typeof pathname !== "string") return false;
  const path = normalizedPath(pathname);
  return SHOPEE_CHAT_PATHS.some((chatPath) => path === chatPath || path.startsWith(`${chatPath}/`));
}

function isShopeeChatUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.origin === SHOPEE_SELLER_ORIGIN && isShopeeChatPath(url.pathname);
  } catch {
    return false;
  }
}

globalThis.OmnichatShopeeUrl = { isShopeeChatPath, isShopeeChatUrl };
