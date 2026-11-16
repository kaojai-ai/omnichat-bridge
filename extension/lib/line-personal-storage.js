/** Chrome session storage is restricted to trusted extension contexts by default.
 * It survives tab closure, but is discarded on browser restart/extension update.
 * Never put these credentials in local config, logs or exportable storage. */
export async function personalSessionStorage(scope, area = chrome.storage.session) {
  if (!area) throw new Error("Trusted session storage is unavailable.");
  await area.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" });
  const key = `line_personal_session:${scope}`;
  let values = (await area.get(key))[key] ?? {};
  let writes = Promise.resolve();
  const mutate = (change) => {
    const next = writes.then(async () => {
      const updated = change({ ...values });
      await area.set({ [key]: updated });
      values = updated;
    });
    writes = next.catch(() => {});
    return next;
  };
  return {
    async get(name) { await writes; return values[name]; },
    set: (name, value) => mutate((next) => ({ ...next, [name]: value })),
    delete: (name) => mutate((next) => { delete next[name]; return next; }),
    clear: () => mutate(() => ({})),
    async getAll() { await writes; return { ...values }; },
  };
}
