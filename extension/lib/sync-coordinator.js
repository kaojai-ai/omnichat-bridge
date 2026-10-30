// One recovery per provider session; duplicate account requests share the result.
export function createAccountSyncCoordinator() {
  const jobs = new Map();
  const providers = new Map();
  return {
    jobs,
    run(key, provider, control, operation) {
      const existing = jobs.get(key);
      if (existing) {
        if (control.refreshMetadata) existing.refreshMetadata = true;
        return existing.completion;
      }
      const previous = providers.get(provider) ?? Promise.resolve();
      const result = previous.then(() => operation(control));
      control.completion = result.finally(() => {
        if (jobs.get(key) === control) jobs.delete(key);
      });
      jobs.set(key, control);
      const settled = control.completion.then(() => undefined, () => undefined);
      providers.set(provider, settled);
      void settled.then(() => {
        if (providers.get(provider) === settled) providers.delete(provider);
      });
      return control.completion;
    },
    drain() { return Promise.allSettled([...jobs.values()].map(control => control.completion)); },
  };
}
