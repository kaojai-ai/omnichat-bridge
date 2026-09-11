export const SYNC_PHASE_LABELS = Object.freeze({
  preparing: "Preparing sync…",
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

export function syncProgressPresentation(progressState) {
  if (!progressState || !["discovering", "syncing"].includes(progressState.state)) {
    return null;
  }

  const phase = typeof progressState.phase === "string" ? progressState.phase : "";
  const completed = Number(progressState.completed_conversations) || 0;
  const total = Number(progressState.total_conversations) || 0;
  const phaseLabel = SYNC_PHASE_LABELS[phase] ?? (
    progressState.state === "discovering" ? "Starting sync…" : "Syncing…"
  );

  if (total > 0 && (COUNTED_PHASES.has(phase) || !phase || phase === "checking_conversations")) {
    const percent = Math.round((completed / total) * 100);
    return {
      active: true,
      showBar: true,
      value: percent,
      text: `Checking conversation ${completed} of ${total} · ${percent}%`,
    };
  }

  if (completed > 0 && COUNTED_PHASES.has(phase)) {
    return {
      active: true,
      showBar: false,
      value: 0,
      text: `Checking provider conversations… ${completed} checked`,
    };
  }

  return {
    active: true,
    showBar: false,
    value: 0,
    text: phaseLabel,
  };
}
