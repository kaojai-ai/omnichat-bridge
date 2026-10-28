import "./shopee-url.js";

const SCRIPT_PREFIX = "omnichat-shopee-region-";
const TH_ORIGIN = globalThis.OmnichatShopeeUrl.sellerOrigins.TH;

export function regionalShopeeOrigins(config) {
  return [...new Set((config?.accounts ?? [])
    .filter(account => account.provider === "shopee")
    .map(account => globalThis.OmnichatShopeeUrl.originForAccount(account))
    .filter(origin => origin !== TH_ORIGIN))];
}

export function regionalShopeeScripts(manifest, origin) {
  const country = globalThis.OmnichatShopeeUrl.countryForUrl(origin);
  if (!country || country === "TH") return [];
  return manifest.content_scripts.filter(script => script.js.includes("lib/shopee-url.js"))
    .map(script => ({
      id: `${SCRIPT_PREFIX}${country.toLowerCase()}-${(script.world ?? "ISOLATED").toLowerCase()}`,
      matches: [`${origin}/*`],
      js: script.js,
      runAt: "document_start",
      world: script.world ?? "ISOLATED",
      persistAcrossSessions: true,
    }));
}

export async function hasRegionalShopeePermission(api, account) {
  if (account?.provider !== "shopee") return true;
  const origin = globalThis.OmnichatShopeeUrl.originForAccount(account);
  return origin === TH_ORIGIN || api.permissions.contains({ origins: [`${origin}/*`] });
}

let scriptUpdates = Promise.resolve();
export function reconcileRegionalShopeeScripts(api, config) {
  const operation = scriptUpdates.then(() => reconcileScripts(api, config));
  scriptUpdates = operation.catch(() => {});
  return operation;
}

async function reconcileScripts(api, config) {
  const existing = await api.scripting.getRegisteredContentScripts();
  const granted = [];
  for (const origin of regionalShopeeOrigins(config)) {
    if (await api.permissions.contains({ origins: [`${origin}/*`] })) granted.push(origin);
  }
  const desired = granted.flatMap(origin => regionalShopeeScripts(api.runtime.getManifest(), origin));
  const current = existing.filter(script => script.id.startsWith(SCRIPT_PREFIX));
  const stale = current.filter(script => !desired.some(next => next.id === script.id));
  if (stale.length) await api.scripting.unregisterContentScripts({ ids: stale.map(script => script.id) });
  const added = desired.filter(script => !current.some(previous => previous.id === script.id));
  const changed = desired.filter(script => current.some(previous => previous.id === script.id
    && JSON.stringify([previous.matches, previous.js, previous.runAt, previous.world])
      !== JSON.stringify([script.matches, script.js, script.runAt, script.world])));
  if (changed.length) await api.scripting.updateContentScripts(changed);
  if (added.length) await api.scripting.registerContentScripts(added);
  return { granted, removed: stale.flatMap(script => script.matches ?? []) };
}
