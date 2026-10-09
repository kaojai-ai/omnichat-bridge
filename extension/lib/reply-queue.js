// Replies must not wait for background uploads. Serialize only the same account.
export function createReplyQueue() {
  const pending = new Map();
  let paused = false;
  return {
    run(account, action) {
      if (paused) return Promise.reject(new Error("Extension update is in progress. Retry after it restarts."));
      const result = (pending.get(account) ?? Promise.resolve()).then(action);
      const settled = result.then(() => undefined, () => undefined);
      pending.set(account, settled);
      void settled.then(() => {
        if (pending.get(account) === settled) pending.delete(account);
      });
      return result;
    },
    async pauseAndDrain() {
      paused = true;
      await Promise.all(pending.values());
    },
    resume() {
      paused = false;
    },
  };
}
