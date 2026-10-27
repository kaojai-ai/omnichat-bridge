(() => {
  // Disposable duplicate suppression. Durable capture/checkpoints own correctness.
  function create({ perConversation = 200, perAccount = 10_000, maxEntries = 20_000 } = {}) {
    for (const limit of [perConversation, perAccount, maxEntries]) {
      if (!Number.isInteger(limit) || limit < 1) throw new RangeError("Message ID cache limits must be positive integers.");
    }
    const entries = new Map();
    const accounts = new Map();
    const conversations = new Map();
    const scopeKey = (...parts) => JSON.stringify(parts.map(String));
    function remove(entry) {
      entries.delete(entry.key);
      const account = accounts.get(entry.accountKey);
      const conversation = conversations.get(entry.conversationKey);
      account?.delete(entry.key);
      conversation?.delete(entry.key);
      if (!account?.size) accounts.delete(entry.accountKey);
      if (!conversation?.size) conversations.delete(entry.conversationKey);
    }
    function trim(index, limit) {
      while (index.size > limit) remove(index.values().next().value);
    }
    return {
      get size() { return entries.size; },
      has(provider, account, conversation, id) {
        return entries.has(scopeKey(provider, account, conversation, id));
      },
      add(provider, account, conversation, id) {
        if (![provider, account, conversation, id].every(value => typeof value === "string" && value.length > 0)) return false;
        const key = scopeKey(provider, account, conversation, id);
        if (entries.has(key)) return false;
        const accountKey = scopeKey(provider, account);
        const conversationKey = scopeKey(provider, account, conversation);
        const entry = { key, accountKey, conversationKey, provider, account };
        const accountEntries = accounts.get(accountKey) ?? new Map();
        const conversationEntries = conversations.get(conversationKey) ?? new Map();
        accounts.set(accountKey, accountEntries);
        conversations.set(conversationKey, conversationEntries);
        entries.set(key, entry);
        accountEntries.set(key, entry);
        conversationEntries.set(key, entry);
        trim(conversationEntries, perConversation);
        trim(accountEntries, perAccount);
        trim(entries, maxEntries);
        return true;
      },
      clear(provider, account) {
        if (provider === undefined) {
          entries.clear(); accounts.clear(); conversations.clear();
        } else if (account !== undefined) {
          const scoped = accounts.get(scopeKey(provider, account));
          if (scoped) for (const entry of scoped.values()) remove(entry);
        } else {
          for (const entry of entries.values()) if (entry.provider === provider) remove(entry);
        }
      },
    };
  }
  globalThis.OmnichatMessageIdCache = Object.freeze({ create });
})();
