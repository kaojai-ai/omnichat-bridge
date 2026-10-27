// One policy owns readiness, command eligibility and temporary uncertainty.
// Evidence lives only in this worker and is bound to its tab/session context.
export function createSessionEligibility({
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onRecheck = () => {},
  onEvent = () => {},
} = {}) {
  const sessions = new Map();
  let nextGeneration = 0;
  function cancel(state) {
    for (const timer of state.timers) clearTimer(timer);
    state.timers = [];
  }
  function emit(key, state, event) {
    try { Promise.resolve(onEvent(key, event, { duration_ms: state.unknownSince === null ? 0 : now() - state.unknownSince })).catch(() => {}); } catch {}
  }
  function snapshot(state, key) {
    const unknown = state.mode === "unknown";
    const elapsed = unknown ? now() - state.unknownSince : 0;
    if (unknown && state.hadReady && elapsed >= 30_000 && !state.expired) {
      state.expired = true;
      state.generation = ++nextGeneration;
      emit(key, state, "grace_expired");
    }
    if (unknown && elapsed >= 60_000 && !state.warned) {
      state.warned = true;
      emit(key, state, "needs_attention");
    }
    const grace = unknown && state.hadReady && !state.expired;
    const eligible = state.mode === "verified" || grace;
    return {
      eligible,
      reason_code: grace ? "provider_check_grace" : state.mode === "verified" ? "ready"
        : state.mode === "missing" ? "waiting_for_tab" : state.mode === "mismatch" ? "wrong_account"
          : state.mode === "blocked" ? state.reason : elapsed >= 60_000 ? "needs_attention" : "checking_session",
      generation: state.generation,
      retain_transport: !["missing", "mismatch"].includes(state.mode),
      unknown,
      account_verified: state.accountVerified,
      evidence: eligible ? state.evidence : null,
      last_evidence: state.evidence,
      context: state.context,
      ...(grace ? { readiness_grace_expires_at: new Date(state.unknownSince + 30_000).toISOString() } : {}),
    };
  }
  function notify(key, state) {
    if (sessions.get(key) !== state) return;
    try { Promise.resolve(onRecheck(key, snapshot(state, key))).catch(() => {}); } catch {}
  }
  function observe(key, { hasTab, verified, explicitMismatch, identity = null, context = null,
    ready = verified, account_verified = verified, evidence = null, reason_code = "provider_unready" } = {}) {
    const mode = !hasTab ? "missing" : explicitMismatch ? "mismatch" : verified ? ready ? "verified" : "blocked" : "unknown";
    const previous = sessions.get(key);
    if (previous) snapshot(previous, key); // Expiry cannot be bypassed by a late successful probe.
    const sameContext = previous?.context === context;
    const resolvedIdentity = mode === "unknown" && sameContext ? previous?.identity ?? null : identity;
    const sameIdentity = previous?.identity === resolvedIdentity;
    if (previous && previous.mode === mode && sameContext && sameIdentity) {
      if (mode === "verified") previous.evidence = evidence;
      if (mode === "blocked") previous.reason = reason_code;
      previous.accountVerified = account_verified;
      return snapshot(previous, key);
    }
    if (previous) cancel(previous);
    const recovering = previous?.mode === "unknown" && mode === "verified" && sameContext && sameIdentity;
    const hadReady = mode === "unknown" && sameContext && previous?.mode === "verified";
    const preserveGeneration = hadReady || (recovering && !previous.expired);
    if (recovering) emit(key, previous, "recovered");
    const state = { mode, identity: resolvedIdentity, context, generation: preserveGeneration ? previous.generation : ++nextGeneration,
      unknownSince: mode === "unknown" ? now() : null, hadReady, expired: false, warned: false,
      evidence: mode === "verified" ? evidence : hadReady ? previous.evidence : null,
      reason: reason_code, accountVerified: account_verified, timers: [] };
    sessions.set(key, state);
    if (mode === "unknown") {
      emit(key, state, hadReady ? "grace_started" : "check_started");
      for (const delay of [5_000, 15_000, 30_000, 60_000]) state.timers.push(setTimer(() => notify(key, state), delay));
    }
    return snapshot(state, key);
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
  return {
    observe, reset,
    generation: (key) => sessions.has(key) ? snapshot(sessions.get(key), key).generation : null,
    isCurrent: (key, generation) => {
      const state = sessions.has(key) ? snapshot(sessions.get(key), key) : null;
      return Boolean(state?.eligible && state.generation === generation);
    },
    state: (key) => sessions.has(key) ? snapshot(sessions.get(key), key) : null,
  };
}
