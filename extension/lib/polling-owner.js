// One verified polling tab per account in this browser profile. Persisted owners
// survive worker restarts; concurrent callers share the same selection.
export function createPollingOwner({ load, save, tabs, verify, contextOf, beforeHandover = async () => {} }) {
  const selections = new Map();
  const owners = new Map();
  return {
    ownsTab: tabId => [...owners.values()].some(owner => owner.tab_id === tabId),
    isCurrent: (key, tabId, tabContext) => owners.get(key)?.tab_id === tabId && owners.get(key)?.tab_context === tabContext,
    select(context, preferredTab) {
      if (selections.has(context.key)) return selections.get(context.key);
      const selection = (async () => {
        const previous = await load(context);
        const candidates = await tabs(context);
        const priority = tab => tab.id === previous?.tab_id ? 0 : tab.id === preferredTab?.id ? 1 : 2;
        candidates.sort((a, b) => priority(a) - priority(b));
        for (const tab of candidates) {
          const tabContext = contextOf(context, tab);
          const status = await verify(context, tab);
          if (!status || tabContext !== contextOf(context, tab)) continue;
          const owner = { tab_id: tab.id, tab_context: tabContext };
          if (previous?.tab_id && previous.tab_id !== tab.id) await beforeHandover(context, previous);
          if (tabContext !== contextOf(context, tab)) continue;
          if (owner.tab_id !== previous?.tab_id || owner.tab_context !== previous?.tab_context) await save(context, owner);
          owners.set(context.key, owner);
          return { tab, status };
        }
        throw new Error("No verified provider tab is available for polling.");
      })();
      selections.set(context.key, selection);
      void selection.finally(() => {
        if (selections.get(context.key) === selection) selections.delete(context.key);
      }).catch(() => {});
      return selection;
    },
  };
}
