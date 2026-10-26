export const SYNC_PHASE_LABELS = Object.freeze({
  preparing: "Preparing sync…",
  checking_session: "Checking provider account access…",
  connecting_provider: "Connecting to LINE…",
  waiting_recovery: "Waiting for LINE recovery…",
  sending_pending: "Sending previously queued messages…",
  loading_conversations: "Starting conversation check…",
  checking_conversations: "Checking conversations for missed messages…",
  fetching_messages: "Recovering conversation messages…",
  conversation_complete: "Recovering conversation messages…",
  sending_recovered: "Sending recovered messages to your server…",
});

const COUNTED_PHASES = new Set([
  "checking_conversations",
  "fetching_messages",
  "conversation_complete",
]);

function count(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
}

export function syncProgressPresentation(progressState, { locale = "en" } = {}) {
  if (!progressState || !["discovering", "syncing"].includes(progressState.state)) {
    return null;
  }

  const phase = typeof progressState.phase === "string" ? progressState.phase : "";
  const completed = count(progressState.completed_conversations) ?? 0;
  const total = count(progressState.total_conversations) ?? 0;
  const phaseLabel = SYNC_PHASE_LABELS[phase] ?? (
    progressState.state === "discovering" ? "Starting sync…" : "Syncing…"
  );
  const counted = COUNTED_PHASES.has(phase) || !phase;
  const value = total > 0 && counted ? Math.min(100, Math.round((completed / total) * 100)) : null;
  let text = phaseLabel;
  if (value !== null) text += ` ${Math.min(completed, total)} of ${total} conversations · ${value}%`;
  else if (completed > 0 && counted) text += ` ${completed} conversations checked`;

  const details = [];
  for (const [field, label] of [
    ["pages_fetched", "pages fetched"],
    ["messages_captured", "messages captured"],
    ["pending", "pending"],
  ]) {
    const amount = count(progressState[field]);
    if (amount !== null) details.push(`${amount} ${label}`);
  }
  const progressedAt = Date.parse(progressState.last_progress_at ?? "");
  if (Number.isFinite(progressedAt)) {
    details.push(`Last progress ${new Date(progressedAt).toLocaleTimeString(locale, {
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    })}`);
  }
  return {
    active: true,
    showBar: true,
    // A missing value is a native indeterminate progress bar, not zero percent.
    value,
    text: [text, ...details].join(" · "),
  };
}

// One trailing refresh for a burst, with no overlapping reads/renders. Events
// arriving during a refresh schedule another pass with the latest stored state.
export function createCoalescedRefresh(refresh, {
  intervalMs = 1000,
  now = () => Date.now(),
  schedule = (callback, delay) => setTimeout(callback, delay),
} = {}) {
  let timer = null;
  let running = false;
  let dirty = false;
  let lastRefreshAt = -Infinity;
  function request() {
    dirty = true;
    if (timer !== null || running) return;
    timer = schedule(async () => {
      timer = null;
      dirty = false;
      running = true;
      lastRefreshAt = now();
      try {
        await refresh();
      } finally {
        lastRefreshAt = now();
        running = false;
        if (dirty) request();
      }
    }, Math.max(0, intervalMs - (now() - lastRefreshAt)));
  }
  return request;
}
