import { sessionConnectionStatus } from "./popup-status.js";
import { accountConfigKey, findAccountConfig } from "./config.js";
import { mergeDetectedAccounts, readAccountState } from "./storage.js";

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
    mergeDetectedAccounts(scopedStored, seeded),
    config,
    activeTabUrl,
  );
}

export function popupAccountsForSession(accounts, liveState, pageAccounts = []) {
  const pageKeys = new Set(pageAccounts.map(accountConfigKey));
  const isActive = (account) => readAccountState(liveState, accountConfigKey(account), {}).active_in_profile === true;
  return accounts.filter((account) => !["shopee", "line_oa"].includes(account.provider)
    || isActive(account)
    || Boolean(sessionConnectionStatus(readAccountState(liveState, accountConfigKey(account), {})))
    || (account.provider === "shopee" && pageKeys.has(accountConfigKey(account))))
    .sort((left, right) => Number(isActive(right)) - Number(isActive(left)));
}

// Combined sync can process accounts outside the popup's current provider view.
export function activeSyncAccount(config, detectedAccounts, status, pending) {
  for (const configured of config.accounts) {
    const key = accountConfigKey(configured);
    const syncState = readAccountState(status, key, null);
    if (!["discovering", "syncing"].includes(syncState?.state)) continue;
    const account = detectedAccounts.find(candidate => accountConfigKey(candidate) === key) ?? configured;
    return { account, syncState, pending: readAccountState(pending, key, []) };
  }
  return null;
}

export function currentTabSyncAccounts(config, accounts, provider) {
  const detected = (Array.isArray(accounts) ? accounts : []).filter(account => account.provider === provider);
  if (provider === "line_oa") {
    const configured = detected.filter(account => findAccountConfig(config, account));
    return [...new Map(configured.map(account => [accountConfigKey(account), account])).values()];
  }
  return detected.length === 1 && findAccountConfig(config, detected[0]) ? detected : [];
}
