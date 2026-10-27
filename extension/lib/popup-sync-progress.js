export const SYNC_PHASE_LABELS = Object.freeze({
  preparing: "Preparing sync…",
  checking_session: "Checking provider account access…",
  queued: "Waiting for turn…",
  connecting_provider: "Connecting to LINE…",
  waiting_recovery: "Waiting for LINE recovery…",
  sending_pending: "Sending previously queued messages…",
  loading_conversations: "Starting conversation check…",
  checking_conversations: "Checking conversations for missed messages…",
  fetching_messages: "Recovering conversation messages…",
  conversation_complete: "Recovering conversation messages…",
  sending_recovered: "Sending recovered messages to your server…",
  saving_messages: "Saving recovered messages…",
  refreshing_metadata: "Refreshing account and customer info…",
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

export function syncProgressPresentation(progressState, { locale = "en", compact = false } = {}) {
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
  const detail = [text, ...details].join(" · ");
  if (compact) {
    const thai = String(locale).toLowerCase().startsWith("th");
    const queued = phase === "queued" || phase === "waiting_recovery";
    const shortPhase = (thai ? {
      preparing: "กำลังเตรียม…", checking_session: "กำลังตรวจสอบสิทธิ์…", queued: "รอคิว",
      connecting_provider: "กำลังเชื่อมต่อ…", waiting_recovery: "รอคิว",
      refreshing_metadata: "กำลังรีเฟรชข้อมูล", saving_messages: "กำลังบันทึก", sending_pending: "กำลังส่งต่อ", loading_conversations: "กำลังโหลดแชต",
      checking_conversations: "กำลังตรวจสอบแชต", fetching_messages: "กำลังโหลดข้อความ",
      conversation_complete: "กำลังโหลดข้อความ", sending_recovered: "กำลังส่งต่อ",
    } : {
      preparing: "Preparing…", checking_session: "Checking access…", queued: "Queued",
      connecting_provider: "Connecting…", waiting_recovery: "Queued",
      refreshing_metadata: "Refreshing info", saving_messages: "Saving messages", sending_pending: "Forwarding", loading_conversations: "Loading chats",
      checking_conversations: "Checking chats", fetching_messages: "Loading messages",
      conversation_complete: "Loading messages", sending_recovered: "Forwarding",
    })[phase] ?? (thai ? "กำลังซิงค์…" : "Syncing…");
    const measuredCompleted = count(progressState.completed_conversations);
    const measuredTotal = count(progressState.total_conversations);
    const captured = count(progressState.messages_captured);
    const pages = count(progressState.conversation_pages);
    const pending = count(progressState.pending);
    let work = "";
    if (phase === "loading_conversations" && pages > 0) {
      work = thai ? `${pages} หน้า` : `${pages} page${pages === 1 ? "" : "s"}`;
    } else if (["sending_pending", "sending_recovered"].includes(phase) && pending > 0) {
      work = thai ? `${pending} ข้อความ` : `${pending} message${pending === 1 ? "" : "s"}`;
    } else if (["fetching_messages", "conversation_complete"].includes(phase) && captured > 0) {
      work = thai ? `รับแล้ว ${captured} ข้อความ` : `${captured} captured`;
    } else if (counted && measuredCompleted !== null) {
      if (measuredTotal > 0) {
        work = `${measuredCompleted}/${measuredTotal}`;
        if (phase !== "checking_conversations") work += thai ? " แชต" : " chats";
      } else if (measuredCompleted > 0) {
        work = thai ? `ตรวจแล้ว ${measuredCompleted} แชต` : `${measuredCompleted} chats checked`;
      }
    }
    const measuredValue = !queued && counted && measuredCompleted !== null && measuredTotal > 0
      ? Math.min(100, Math.round((measuredCompleted / measuredTotal) * 100)) : null;
    return { active: true, showBar: !queued, value: measuredValue, detail,
      text: shortPhase + (!queued && work ? ` · ${work}` : ""),
    };
  }

  return {
    active: true,
    showBar: phase !== "queued",
    // A missing value is a native indeterminate progress bar, not zero percent.
    value,
    text: detail,
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
