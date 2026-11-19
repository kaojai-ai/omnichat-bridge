export function linePersonalOrigins(account) {
  return ["https://legy.line-apps.com/", "https://obs.line-apps.com/",
    account?.events_url, account?.api_url, account?.logs_url, account?.image_server_url].filter(Boolean);
}

(() => {
  const pageUrl = () => globalThis.chrome?.runtime?.getURL?.("line-personal.html") ?? "";
  const matchesUrl = (value) => {
    try { const url = new URL(value); const own = new URL(pageUrl()); return url.protocol === own.protocol && url.host === own.host && url.pathname === own.pathname; }
    catch { return false; }
  };
  const id = (value) => typeof value === "string" && /^u[a-f0-9]{32}$/i.test(value) ? value : "";
  const normalizeAccount = (value) => id(value?.provider_account_id) ? {
    provider: "line_personal", provider_account_id: value.provider_account_id,
    ...(value.display_name ? { display_name: String(value.display_name).slice(0, 512) } : {}),
    ...(value.avatar_url ? { avatar_url: String(value.avatar_url) } : {}),
    detected_at: new Date().toISOString(),
  } : null;
  globalThis.OmnichatProviderAdapters?.register({
    id: "line_personal", displayName: "LINE Personal", accountName: "LINE Personal",
    adapterVersion: "line-personal-1", transport: "extension_page", icon: "icons/line.png",
    get chatUrl() { return pageUrl(); },
    chatUrlForAccount: (account) => `${pageUrl()}${id(account?.provider_account_id) ? `?account=${encodeURIComponent(account.provider_account_id)}` : ""}`,
    matchesUrl, matchesPage: matchesUrl, normalizeAccount,
    capabilities: ["account_detection", "message_observation", "message_recovery"],
    sendCommands: ["send_text"],
    providerStatusReady: (status) => status?.ok === true && status.account_access_verified === true,
    providerStatusHealthy: (status) => status?.ok === true && status.realtime_connected === true,
    configOrigins: linePersonalOrigins,
    validateConfig(value, version = 3) {
      if (version !== 3 || !id(value?.provider_account_id)) throw new Error("LINE Personal requires version 3 and a verified personal account ID.");
      if (typeof value.hmac_secret !== "string" || !value.hmac_secret.trim()) throw new Error("HMAC secret is required.");
      const result = { provider: "line_personal", provider_account_id: value.provider_account_id, hmac_secret: value.hmac_secret.trim() };
      for (const field of ["events_url", "api_url", "logs_url", "image_server_url"]) {
        if (!value[field] && ["logs_url", "image_server_url"].includes(field)) continue;
        let url;
        try { url = new URL(value[field]); } catch { throw new Error(`${field} must use HTTPS.`); }
        if (url.protocol !== "https:") throw new Error(`${field} must use HTTPS.`);
        result[field] = url.toString();
      }
      for (const field of ["tenant_id", "user_id", "display_name"]) {
        if (typeof value[field] === "string" && value[field].trim()) result[field] = value[field].trim();
      }
      return result;
    },
  });
})();
