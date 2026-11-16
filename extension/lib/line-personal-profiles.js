/** Session-local public contact metadata; lookup failures never block delivery. */
export function createPersonalProfiles({ loadContact, signal, now = Date.now, timeoutMs = 1_000,
  maxEntries = 500, ttlMs = 5 * 60_000, negativeTtlMs = 30_000 }) {
  const cache = new Map();
  const pending = new Map();
  async function lookup(id) {
    const found = cache.get(id);
    if (found && found.expires > now()) return found.profile;
    if (pending.has(id)) return pending.get(id);
    if (pending.size >= maxEntries) return {};
    const task = (async () => {
      const controller = new AbortController();
      let timer;
      let profile = {};
      try {
        const deadline = new Promise((_, reject) => { timer = setTimeout(() => {
          controller.abort(); reject(new Error("Contact lookup timed out"));
        }, timeoutMs); });
        const contact = await Promise.race([loadContact(id, signal
          ? AbortSignal.any([signal, controller.signal]) : controller.signal), deadline]);
        if (contact?.mid === id) {
          const display_name = typeof contact.displayName === "string" ? contact.displayName.trim().slice(0, 512) : "";
          let avatar_url;
          if (typeof contact.picturePath === "string" && contact.picturePath.startsWith("https://")) {
            try { const url = new URL(contact.picturePath); if (!url.username && !url.password) avatar_url = url.href; } catch {}
          }
          if (!avatar_url && typeof contact.pictureStatus === "string" && /^[a-zA-Z0-9_/-]+$/.test(contact.pictureStatus)) {
            avatar_url = `https://profile.line-scdn.net/${contact.pictureStatus.replace(/^\/+/, "")}`;
          }
          if (avatar_url?.length > 2_000) avatar_url = undefined;
          profile = { ...(display_name ? { display_name } : {}), ...(avatar_url ? { avatar_url } : {}) };
        }
      } catch { /* Profile availability must not affect the message queue. */ }
      finally { clearTimeout(timer); }
      if (!signal?.aborted) {
        cache.delete(id);
        cache.set(id, { profile, expires: now() + (Object.keys(profile).length ? ttlMs : negativeTtlMs) });
        while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
      }
      return profile;
    })();
    pending.set(id, task);
    try { return await task; } finally { pending.delete(id); }
  }
  return {
    async enrich(message, ownId) {
      if (!message || message.sender_id === ownId || !/^u[a-f0-9]{32}$/i.test(message.sender_id ?? "") || signal?.aborted) return message;
      const profile = await lookup(message.sender_id);
      return { ...message, participant: { ...message.participant, ...profile } };
    },
  };
}
