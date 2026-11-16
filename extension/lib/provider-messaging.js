/** One request interface for provider content scripts and extension-owned tabs. */
export function createProviderMessenger({ sendToTab, timeoutMs = 30_000 }) {
  const peers = new Map();
  function attach(tabId, port) {
    const pending = new Map();
    const previous = peers.get(tabId);
    previous?.dispose();
    const peer = { port, pending, dispose };
    peers.set(tabId, peer);
    function dispose() {
      if (peers.get(tabId) === peer) peers.delete(tabId);
      for (const request of pending.values()) request.reject(new Error("Provider connection closed."));
      pending.clear();
      port.onMessage.removeListener?.(receive);
      port.onDisconnect.removeListener?.(dispose);
    }
    function receive(message) {
      if (message?.kind !== "provider_response" || !pending.has(message.id)) return;
      pending.get(message.id).resolve(message.result);
    }
    port.onMessage.addListener(receive);
    port.onDisconnect.addListener(dispose);
    return dispose;
  }
  function send(tabId, message, options = {}) {
    const peer = peers.get(tabId);
    if (!peer) return sendToTab(tabId, message);
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      let timer;
      const finish = (callback, value) => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        peer.pending.delete(id);
        callback(value);
      };
      const abort = () => finish(reject, new DOMException("Provider request cancelled", "AbortError"));
      if (options.signal?.aborted) return abort();
      peer.pending.set(id, { resolve: (value) => finish(resolve, value), reject: (error) => finish(reject, error) });
      timer = setTimeout(() => finish(reject, new DOMException("Provider response timed out", "TimeoutError")), options.timeoutMs ?? timeoutMs);
      options.signal?.addEventListener("abort", abort, { once: true });
      try { peer.port.postMessage({ kind: "provider_request", id, message }); }
      catch { finish(reject, new Error("Provider connection closed.")); }
    });
  }
  return { attach, send, has: (tabId) => peers.has(tabId) };
}
