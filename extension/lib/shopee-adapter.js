(() => {
  const registry = globalThis.OmnichatProviderAdapters;
  if (!registry) throw new Error("Provider adapter registry is unavailable.");

  const value = (input) => {
    if (typeof input !== "string" && typeof input !== "number") return null;
    const normalized = String(input).trim();
    return normalized || null;
  };
  const firstValue = (item, keys) => keys.map((key) => value(item?.[key])).find(Boolean) ?? null;
  const httpsUrl = (input) => {
    const url = value(input);
    if (!url) return null;
    try { return new URL(url).protocol === "https:" ? url : null; } catch { return null; }
  };

  function accountFromShop(shop, user = null) {
    if (!shop || typeof shop !== "object" || Array.isArray(shop)) return null;
    const id = firstValue(shop, ["id", "shop_id", "shopid", "shopId"]);
    if (!id) return null;
    const name = firstValue(shop, ["name", "shop_name", "shopname", "shopName", "nickname"]);
    const avatarUrl = httpsUrl(firstValue(shop, ["logo", "shop_logo", "shop_avatar", "avatar", "avatar_url", "avatarUrl", "profile_image", "profile_picture"]));
    const providerUserId = firstValue(user, ["id"]);
    const shopUserId = firstValue(shop, ["user_id"]);
    return {
      provider: "shopee",
      provider_account_id: id,
      ...(name ? { display_name: name } : {}),
      ...(avatarUrl ? { avatar_url: avatarUrl } : {}),
      ...(providerUserId ? { provider_user_id: providerUserId } : {}),
      ...(shopUserId ? { shop_user_id: shopUserId } : {}),
    };
  }

  function accountFromConversation(conversation) {
    if (!conversation || typeof conversation !== "object" || Array.isArray(conversation)) return null;
    const id = firstValue(conversation, ["shop_id", "shopid", "shopId"]);
    if (!id) return null;
    const name = firstValue(conversation, ["shop_name", "shopname", "shopName"]);
    return {
      provider: "shopee",
      provider_account_id: id,
      ...(name ? { display_name: name } : {}),
    };
  }

  function shopListItems(body) {
    if (Array.isArray(body)) {
      return body.filter((item) => firstValue(item, ["name", "shop_name", "shopname", "shopName"]));
    }
    for (const candidate of [body?.shops, body?.data?.shops, body?.shop_list, body?.data?.shop_list]) {
      if (Array.isArray(candidate)) return candidate;
    }
    return [];
  }

  function conversationItems(body) {
    if (Array.isArray(body)) return body;
    for (const candidate of [
      body?.conversations,
      body?.items,
      body?.data?.conversations,
      body?.data?.items,
      body?.data,
    ]) {
      if (Array.isArray(candidate)) return candidate;
    }
    return [];
  }

  function accountsFromPayload(body) {
    const accounts = [];
    const add = (account) => {
      if (!account?.provider_account_id) return;
      const existing = accounts.find((item) => item.provider_account_id === account.provider_account_id);
      if (existing) {
        Object.assign(existing, Object.fromEntries(Object.entries(account).filter(([, item]) => item)));
      } else {
        accounts.push(account);
      }
    };
    add(accountFromShop(body?.shop, body?.user));
    const directShopId = firstValue(body, ["shop_id", "shopId"]);
    if (directShopId) add({ provider: "shopee", provider_account_id: directShopId });
    for (const shop of shopListItems(body)) add(accountFromShop(shop, body?.user));
    for (const conversation of conversationItems(body)) add(accountFromConversation(conversation));
    const shopIds = Array.isArray(body?.ShopIds)
      ? body.ShopIds
      : Array.isArray(body?.shop_ids) ? body.shop_ids : [];
    for (const id of shopIds) {
      const normalized = value(id);
      if (normalized) add({ provider: "shopee", provider_account_id: normalized });
    }
    return accounts;
  }

  function normalizeAccount(input, detectedAt = new Date().toISOString()) {
    const accountId = value(input?.provider_account_id);
    if (!accountId) return null;
    const displayName = value(input?.display_name);
    const avatarUrl = httpsUrl(input?.avatar_url);
    const providerUserId = value(input?.provider_user_id);
    const shopUserId = value(input?.shop_user_id);
    return {
      provider: "shopee",
      provider_account_id: accountId,
      ...(displayName ? { display_name: displayName } : {}),
      ...(avatarUrl ? { avatar_url: avatarUrl } : {}),
      ...(providerUserId ? { provider_user_id: providerUserId } : {}),
      ...(shopUserId ? { shop_user_id: shopUserId } : {}),
      detected_at: detectedAt,
    };
  }

  registry.register({
    id: "shopee",
    displayName: "Shopee Seller Chat",
    accountName: "Shopee shop",
    adapterVersion: "shopee-realtime-2",
    chatUrl: "https://seller.shopee.co.th/portal/chat-management",
    tabQueryPattern: "https://seller.shopee.co.th/*",
    surfacePriority: ["seller-centre", "legacy"],
    capabilities: ["account_detection", "message_observation", "message_recovery"],
    sendCommands: ["send_text", "send_image", "send_product"],
    matchesPage: (url) => globalThis.OmnichatShopeeUrl?.isShopeePageUrl(url) === true,
    matchesUrl: (url) => globalThis.OmnichatShopeeUrl?.isShopeeChatUrl(url) === true,
    surfaceForUrl: (url) => globalThis.OmnichatShopeeUrl?.surfaceForUrl(url) ?? null,
    accountsFromPayload,
    conversationItems,
    normalizeAccount,
    normalizeMessages(payload, captureMethod) {
      const normalize = globalThis.OmnichatShopee?.parseShopeeMessages;
      if (typeof normalize !== "function") throw new Error("Shopee message normalizer is unavailable.");
      return normalize(payload, captureMethod);
    },
  });
})();
