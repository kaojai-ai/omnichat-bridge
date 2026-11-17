export function selectableProviders(adapters, config, hiddenFeatures = false) {
  return adapters.filter((adapter) => adapter.id !== "line_personal"
    || hiddenFeatures
    || config?.accounts?.some((account) => account.provider === "line_personal"));
}

/** Prefer an already-active provider tab; never create a duplicate on lookup failure. */
export async function activateProvider(adapter, config, browser, hiddenFeatures = false) {
  if (!adapter || !selectableProviders([adapter], config, hiddenFeatures).length) throw new Error("Provider is not configured.");
  const tabs = await browser.tabs.query({});
  const existing = tabs.filter((tab) => adapter.matchesPage?.(tab.url) || adapter.matchesUrl(tab.url))
    .sort((a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active)) || (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
  if (existing) {
    await browser.tabs.update(existing.id, { active: true });
    if (Number.isInteger(existing.windowId)) await browser.windows?.update?.(existing.windowId, { focused: true });
    return existing;
  }
  const account = config?.accounts?.find((candidate) => candidate.provider === adapter.id);
  return browser.tabs.create({ url: adapter.chatUrlForAccount?.(account) ?? adapter.chatUrl, active: true });
}
