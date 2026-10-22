export const CONFIG_MIGRATION_ERROR = "This configuration cannot be migrated automatically. Copy a new configuration from KaoJai Admin and import it again.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENVIRONMENTS = {
  "admin.kaojai.ai": { api: "https://omnichat.kaojai.ai", logs: "https://ingress.kaojai.ai/logs/omnichat" },
  "admin.kaojai.dev": { api: "https://omnichat.kaojai.dev", logs: "https://ingress.kaojai.dev/logs/omnichat" },
};

// KaoJai-specific migration is deliberately separate from the open-source config contract.
export function accountMigration(account, version) {
  if (!account || typeof account !== "object") return { status: "custom" };
  let url;
  const raw = account.api_url || account.commands_url;
  try { url = new URL(raw); } catch {
    return /^https?:\/\/(?:[^/@]*@)?admin\.kaojai\.(ai|dev)(?=[:/?#]|$)/i.test(raw ?? "")
      ? { status: "invalid", error: CONFIG_MIGRATION_ERROR } : { status: "custom" };
  }
  const environment = ENVIRONMENTS[url.hostname];
  if (!environment) return { status: "current_or_custom" };
  const match = /^\/api\/omnichat\/(shopee|line_oa)\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  const accountId = account.canonical_provider_account_id || account.provider_account_id;
  let pathAccount;
  try { pathAccount = match && decodeURIComponent(match[3]); } catch { return { status: "invalid", error: CONFIG_MIGRATION_ERROR }; }
  if (version !== 3 || url.origin !== `https://${url.hostname}` || url.username || url.password
    || url.search || url.hash || !match || !UUID.test(match[2])
    || match[1] !== account.provider || pathAccount !== accountId
    || (account.tenant_id && account.tenant_id !== match[2])) {
    return { status: "invalid", error: CONFIG_MIGRATION_ERROR };
  }
  return { status: "pending", candidate: { ...account,
    api_url: `${environment.api}/api/${match[1]}/${match[2]}/${match[3]}`,
    logs_url: environment.logs,
  } };
}

export function migrationOrigins(config) {
  return (config?.accounts ?? []).flatMap((account) => {
    const migration = accountMigration(account, config.version);
    return migration.candidate ? [migration.candidate.api_url, migration.candidate.logs_url] : [];
  });
}

export function assertMigratableConfig(config) {
  for (const account of config?.accounts ?? []) {
    if (accountMigration(account, config.version).status === "invalid") throw new Error(CONFIG_MIGRATION_ERROR);
  }
}
