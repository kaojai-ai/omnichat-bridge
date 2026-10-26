// Unknown access never grants eligibility. Retry timing is scoped to a continuous
// unknown episode, so repeated probes cannot restart the grace period forever.
export function createSessionEligibility({
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onRecheck = () => {},
} = {}) {
  const sessions = new Map();
  let nextGeneration = 0;

  function cancel(state) {
    for (const timer of state.timers) clearTimer(timer);
    state.timers = [];
  }

  function snapshot(state) {
    return { eligible: state.mode === "verified", reason_code: state.mode === "verified" ? "ready"
      : state.mode === "missing" ? "waiting_for_tab"
        : state.mode === "mismatch" ? "wrong_account"
          : now() - state.unknownSince >= 30_000 ? "needs_attention" : "checking_session",
    generation: state.generation };
  }

  function notify(key, state) {
    if (sessions.get(key) !== state) return;
    try { Promise.resolve(onRecheck(key, snapshot(state))).catch(() => {}); } catch {}
  }

  function observe(key, { hasTab, verified, explicitMismatch, identity = null } = {}) {
    const mode = !hasTab ? "missing" : explicitMismatch ? "mismatch" : verified ? "verified" : "unknown";
    const previous = sessions.get(key);
    const sameIdentity = previous?.identity === identity;
    if (previous && previous.mode === mode && sameIdentity) return snapshot(previous);
    if (previous) cancel(previous);
    const state = { mode, identity, generation: ++nextGeneration,
      unknownSince: mode === "unknown" ? now() : null, timers: [] };
    sessions.set(key, state);
    if (mode === "unknown") {
      // The final callback publishes needs_attention even if no external probe runs.
      for (const delay of [5_000, 15_000, 30_000]) {
        state.timers.push(setTimer(() => notify(key, state), delay));
      }
    }
    return snapshot(state);
  }

  function generation(key) {
    return sessions.get(key)?.generation ?? null;
  }

  function isCurrent(key, candidate) {
    const state = sessions.get(key);
    return Boolean(state && state.mode === "verified" && state.generation === candidate);
  }

  function reset(key) {
    if (arguments.length === 0) {
      for (const state of sessions.values()) cancel(state);
      sessions.clear();
    } else {
      const state = sessions.get(key);
      if (state) cancel(state);
      sessions.delete(key);
    }
  }

  return { observe, generation, isCurrent, reset,
    state: (key) => sessions.has(key) ? snapshot(sessions.get(key)) : null,
  };
}
