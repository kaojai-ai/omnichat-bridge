/** Session-local public contact metadata; lookup failures never block delivery. */
export function createPersonalProfiles({ loadContact, loadChat, signal, now = Date.now, timeoutMs = 1_000,
  maxEntries = 500, ttlMs = 5 * 60_000, negativeTtlMs = 30_000 }) {
  const cache = new Map();
  const pending = new Map();
  async function lookup(id, chat = false) {
    const key = `${chat ? "chat" : "contact"}:${id}`;
    const found = cache.get(key);
    if (found && found.expires > now()) return found.profile;
    if (pending.has(key)) return pending.get(key);
    if (pending.size >= maxEntries) return {};
    const task = (async () => {
      const controller = new AbortController();
      let timer;
      let profile = {};
      try {
        const deadline = new Promise((_, reject) => { timer = setTimeout(() => {
          controller.abort(); reject(new Error("Contact lookup timed out"));
        }, timeoutMs); });
        const contact = await Promise.race([(chat ? loadChat : loadContact)(id, signal
          ? AbortSignal.any([signal, controller.signal]) : controller.signal), deadline]);
        if (chat ? contact?.chatMid === id : contact?.mid === id) {
          const name = chat ? contact.chatName : contact.displayName;
          const display_name = typeof name === "string" ? name.trim().slice(0, 512) : "";
          let avatar_url;
          if (typeof contact.picturePath === "string" && contact.picturePath.startsWith("https://")) {
            try { const url = new URL(contact.picturePath); if (!url.username && !url.password) avatar_url = url.href; } catch {}
          }
          if (!avatar_url && chat && typeof contact.picturePath === "string"
            && /^\/?[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(contact.picturePath)) {
            avatar_url = `https://profile.line-scdn.net/${contact.picturePath.replace(/^\//, "")}`;
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
        cache.delete(key);
        cache.set(key, { profile, expires: now() + (Object.keys(profile).length ? ttlMs : negativeTtlMs) });
        while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
      }
      return profile;
    })();
    pending.set(key, task);
    try { return await task; } finally { pending.delete(key); }
  }
  return {
    async enrich(message, ownId) {
      if (!message || signal?.aborted) return message;
      const isContact = message.sender_id !== ownId && /^u[a-f0-9]{32}$/i.test(message.sender_id ?? "");
      const isGroup = loadChat && message.conversation_type === "group" && /^[cr][a-f0-9]{32}$/i.test(message.conversation_id ?? "");
      if (!isContact && !isGroup) return message;
      const [profile, chat] = await Promise.all([
        isContact ? lookup(message.sender_id) : {},
        isGroup ? lookup(message.conversation_id, true) : {},
      ]);
      return { ...message, ...(isContact ? { participant: { ...message.participant, ...profile } } : {}),
        ...(chat.display_name ? { conversation_name: chat.display_name } : {}),
        ...(chat.avatar_url ? { conversation_avatar_url: chat.avatar_url } : {}) };
    },
  };
}
