import { findAccountConfig } from "./config.js";
import { mergeDetectedAccounts } from "./storage.js";

function lineBotIdFromUrl(activeTabUrl = "") {
  try {
    const url = new URL(activeTabUrl);
    if (url.origin !== "https://chat.line.biz") return "";
    return String(url.pathname.split("/").filter(Boolean)[0] ?? "").trim();
  } catch {
    return "";
  }
}

export function configuredProviderAccounts(config, providerId) {
  if (!providerId || !Array.isArray(config?.accounts)) return [];
  return config.accounts
    .filter((account) => (
      account?.provider === providerId
      && String(account.provider_account_id ?? "").trim()
    ))
    .map((account) => ({
      provider: account.provider,
      provider_account_id: String(account.provider_account_id).trim(),
      ...(account.bot_id ? { bot_id: String(account.bot_id).trim() } : {}),
      ...(account.display_name ? { display_name: String(account.display_name).trim() } : {}),
    }));
}

export function visibleDetectedAccounts(accounts, storedConfig, activeTabUrl = "") {
  const openLineBotId = lineBotIdFromUrl(activeTabUrl);
  return (Array.isArray(accounts) ? accounts : []).filter((account) => (
    Boolean(findAccountConfig(storedConfig, account))
      || (account?.provider === "line_oa"
        && openLineBotId
        && String(account.bot_id ?? "").trim() === openLineBotId)
  ));
}

export function hydrateDetectedAccounts({
  storedAccounts,
  config,
  providerId,
  activeTabUrl = "",
} = {}) {
  const seeded = configuredProviderAccounts(config, providerId);
  const stored = Array.isArray(storedAccounts) ? storedAccounts : [];
  const scopedStored = providerId
    ? stored.filter((account) => account?.provider === providerId)
    : stored;
  return visibleDetectedAccounts(
    mergeDetectedAccounts(seeded, scopedStored),
    config,
    activeTabUrl,
  );
}
