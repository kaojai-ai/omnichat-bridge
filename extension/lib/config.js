export const CONFIG_VERSION = 2;

function requiredString(value, message) {
  if (typeof value !== "string" || !value.trim()) throw new Error(message);
  return value.trim();
}

function secureUrl(value, protocol, message) {
  const raw = requiredString(value, message);
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(message);
  }
  if (url.protocol !== protocol) throw new Error(message);
  return url.toString();
}

export function accountKey(provider, providerAccountId) {
  return `${provider}:${providerAccountId}`;
}

export function validateAccountConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Account configuration must be an object.");
  }
  const provider = requiredString(value.provider, "Account provider is required.");
  if (provider !== "shopee") throw new Error("Only Shopee is supported.");
  const provider_account_id = requiredString(value.provider_account_id, "Shop ID is required.");
  const hmac_secret = requiredString(value.hmac_secret, "HMAC secret is required.");
  const events_url = secureUrl(value.events_url, "https:", "Events URL must use HTTPS.");
  const commands_url = secureUrl(value.commands_url, "https:", "Commands URL must use HTTPS.");
  return {
    provider,
    provider_account_id,
    events_url,
    commands_url,
    hmac_secret,
  };
}

export function validateConfigFile(value) {
  if (value?.version !== CONFIG_VERSION || !Array.isArray(value.accounts)) {
    throw new Error(`Configuration file must be version ${CONFIG_VERSION} with an accounts list.`);
  }
  const accounts = value.accounts.map(validateAccountConfig);
  const keys = accounts.map((account) => accountKey(account.provider, account.provider_account_id));
  if (new Set(keys).size !== keys.length) throw new Error("Configuration contains duplicate accounts.");
  return { version: CONFIG_VERSION, accounts };
}

export function findAccountConfig(config, detectedAccount) {
  if (!detectedAccount?.provider || !detectedAccount?.provider_account_id) return null;
  return config?.accounts?.find(
    (account) => account.provider === detectedAccount.provider
      && account.provider_account_id === detectedAccount.provider_account_id,
  ) ?? null;
}

export function accountConfigKey(account) {
  return account?.provider && account?.provider_account_id
    ? accountKey(account.provider, account.provider_account_id)
    : null;
}

export function accountOrigins(config) {
  const urls = [];
  for (const account of config.accounts) {
    urls.push(account.events_url, account.commands_url);
  }
  return urls;
}
