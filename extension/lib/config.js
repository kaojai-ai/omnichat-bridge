export const CONFIG_VERSION = 3;
const SUPPORTED_CONFIG_VERSIONS = new Set([2, CONFIG_VERSION]);
const DEFAULT_PROVIDER = "shopee";

function registeredProviderAdapter(provider) {
  return globalThis.OmnichatProviderAdapters?.get(provider) ?? null;
}

export function isSupportedProvider(provider) {
  const normalized = typeof provider === "string" ? provider.trim() : "";
  if (!normalized) return false;
  if (normalized === DEFAULT_PROVIDER) return true;
  return typeof registeredProviderAdapter(normalized)?.validateConfig === "function";
}

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

export function validateAccountConfig(value, version = CONFIG_VERSION) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Account configuration must be an object.");
  }
  const provider = requiredString(value.provider, "Account provider is required.");
  const normalizedInput = { ...value, provider };
  if (provider !== DEFAULT_PROVIDER) {
    const adapter = registeredProviderAdapter(provider);
    if (typeof adapter?.validateConfig !== "function") {
      throw new Error(`Unsupported provider: ${provider}.`);
    }
    const normalized = adapter.validateConfig(normalizedInput, version);
    if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
      throw new Error(`Provider ${provider} returned an invalid configuration.`);
    }
    if (normalized.provider !== provider) {
      throw new Error(`Provider ${provider} returned a mismatched configuration.`);
    }
    return {
      ...normalized,
      provider,
      provider_account_id: requiredString(
        normalized.provider_account_id,
        "Provider account ID is required.",
      ),
    };
  }
  const provider_account_id = requiredString(value.provider_account_id, "Shop ID is required.");
  const hmac_secret = requiredString(value.hmac_secret, "HMAC secret is required.");
  const events_url = secureUrl(value.events_url, "https:", "Events URL must use HTTPS.");
  const control_url = value.control_url === undefined || value.control_url === ""
    ? undefined
    : secureUrl(value.control_url, "https:", "Control URL must use HTTPS.");
  const image_server_url = value.image_server_url === undefined || value.image_server_url === ""
    ? undefined
    : secureUrl(value.image_server_url, "https:", "Image server URL must use HTTPS.");
  const logs_url = value.logs_url === undefined || value.logs_url === ""
    ? undefined
    : secureUrl(value.logs_url, "https:", "Logs URL must use HTTPS.");
  if (version === CONFIG_VERSION) {
    const api_url = secureUrl(value.api_url, "https:", "API URL must use HTTPS.");
    return {
      provider,
      provider_account_id,
      events_url,
      api_url,
      ...(control_url ? { control_url } : {}),
      ...(image_server_url ? { image_server_url } : {}),
      ...(logs_url ? { logs_url } : {}),
      hmac_secret,
    };
  }
  const commands_url = secureUrl(value.commands_url, "https:", "Commands URL must use HTTPS.");
  return {
    provider,
    provider_account_id,
    events_url,
    commands_url,
    ...(control_url ? { control_url } : {}),
    ...(image_server_url ? { image_server_url } : {}),
    ...(logs_url ? { logs_url } : {}),
    hmac_secret,
  };
}

export function validateConfigFile(value) {
  const version = value?.version;
  if (!SUPPORTED_CONFIG_VERSIONS.has(version) || !Array.isArray(value.accounts)) {
    throw new Error(`Configuration file must be version 2 or ${CONFIG_VERSION} with an accounts list.`);
  }
  const accounts = value.accounts
    .filter((account) => {
      if (!account || typeof account !== "object" || Array.isArray(account)) return true;
      if (!Object.hasOwn(account, "provider") || typeof account.provider !== "string") return true;
      return isSupportedProvider(account.provider);
    })
    .map((account) => validateAccountConfig(account, version));
  const keys = accounts.map((account) => accountKey(account.provider, account.provider_account_id));
  if (new Set(keys).size !== keys.length) throw new Error("Configuration contains duplicate accounts.");
  return { version, accounts };
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
    const adapter = registeredProviderAdapter(account.provider);
    const adapterUrls = typeof adapter?.configOrigins === "function"
      ? adapter.configOrigins(account)
      : [account.events_url, account.api_url, account.commands_url, account.control_url, account.image_server_url, account.logs_url];
    for (const url of Array.isArray(adapterUrls) ? adapterUrls : []) {
      if (typeof url !== "string" || !url.trim()) continue;
      let parsed;
      try { parsed = new URL(url); } catch { throw new Error("Provider configuration origin is invalid."); }
      if (!["https:", "wss:"].includes(parsed.protocol)) {
        throw new Error("Provider configuration origins must use HTTPS or WSS.");
      }
      urls.push(parsed.toString());
    }
  }
  return urls;
}
