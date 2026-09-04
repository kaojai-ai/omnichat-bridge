(() => {
  const adapters = new Map();

  function register(adapter) {
    if (!adapter || typeof adapter !== "object" || Array.isArray(adapter)) {
      throw new Error("Provider adapter must be an object.");
    }
    const id = typeof adapter.id === "string" ? adapter.id.trim() : "";
    if (!id || adapters.has(id)) throw new Error(`Provider adapter ${id || "<unknown>"} is invalid or already registered.`);
    if (typeof adapter.matchesUrl !== "function") throw new Error(`Provider adapter ${id} must match chat URLs.`);
    if (adapter.matchesPage !== undefined && typeof adapter.matchesPage !== "function") {
      throw new Error(`Provider adapter ${id} has an invalid page matcher.`);
    }
    if (adapter.validateConfig !== undefined && typeof adapter.validateConfig !== "function") {
      throw new Error(`Provider adapter ${id} has an invalid config validator.`);
    }
    if (adapter.configOrigins !== undefined && typeof adapter.configOrigins !== "function") {
      throw new Error(`Provider adapter ${id} has an invalid config origin resolver.`);
    }
    if (adapter.accountDetectionHints !== undefined && typeof adapter.accountDetectionHints !== "function") {
      throw new Error(`Provider adapter ${id} has an invalid account detection hint resolver.`);
    }
    const capabilities = new Set(Array.isArray(adapter.capabilities) ? adapter.capabilities : []);
    const sendCommands = new Set(Array.isArray(adapter.sendCommands) ? adapter.sendCommands : []);
    const registered = Object.freeze({
      ...adapter,
      id,
      capabilities: Object.freeze([...capabilities]),
      sendCommands: Object.freeze([...sendCommands]),
      supports(capability) {
        return capabilities.has(capability);
      },
      supportsSend(command) {
        return sendCommands.has(command);
      },
    });
    adapters.set(id, registered);
    return registered;
  }

  function get(id) {
    const normalized = typeof id === "string" ? id.trim() : "";
    return adapters.get(normalized) ?? null;
  }

  function list() {
    return [...adapters.values()];
  }

  function forUrl(url) {
    for (const adapter of adapters.values()) {
      if (adapter.matchesUrl(url)) return adapter;
    }
    return null;
  }

  function forPage(url) {
    for (const adapter of adapters.values()) {
      const matches = typeof adapter.matchesPage === "function"
        ? adapter.matchesPage(url)
        : adapter.matchesUrl(url);
      if (matches) return adapter;
    }
    return null;
  }

  globalThis.OmnichatProviderAdapters = Object.freeze({ register, get, list, forUrl, forPage });
})();
