import { sanitizeLogText } from "./logs.js";

const SELLER_CENTRE_SURFACE = "seller-centre";

export function providerConnectionStatus(live) {
  if (live?.socket !== "connected") return null;
  if (live.provider_recovery_state === "needs_attention") {
    return {
      label: "CONNECTED · ACTION REQUIRED",
      state: "warning",
      hint: live.provider_recovery_reason || "The provider tab needs attention before syncing can continue.",
      action: "logs",
    };
  }
  if (live.provider_recovery_state === "opening") {
    return {
      label: "CONNECTED · OPENING PROVIDER",
      state: "warning",
      hint: live.provider_recovery_reason || "The provider tab is opening.",
    };
  }
  if (live.provider_recovery_state === "ready") {
    return {
      label: "CONNECTED · PROVIDER READY",
      state: "ready",
      hint: "Connected to your server. The provider bridge is ready.",
    };
  }
  return {
    label: "CONNECTED · CHECKING PROVIDER",
    state: "warning",
    hint: "Connected to your server. Provider readiness is still being checked.",
  };
}

export function sellerCentreConnectionStatus(live) {
  if (live?.socket !== "connected" || live?.provider_surface !== SELLER_CENTRE_SURFACE) return null;
  if (["opening", "needs_attention"].includes(live.provider_recovery_state)) {
    return providerConnectionStatus(live);
  }
  if (live.provider_surface_ready === true) {
    return {
      label: "CONNECTED · CHAT READY",
      state: "ready",
      hint: "Seller Centre Chat is ready and syncing can continue automatically.",
    };
  }
  if (live.provider_chat_open === false) {
    return {
      label: "CONNECTED · OPEN CHAT",
      state: "warning",
      hint: "Connected to your server. Open Seller Centre Chat to start syncing.",
    };
  }
  return {
    label: "CONNECTED · INITIALIZING",
    state: "warning",
    hint: "Connected to your server. Seller Centre Chat is initializing.",
  };
}

function latestSuccessfulActivityAt(state) {
  return [state?.last_sync_at, state?.last_capture_at, state?.last_delivery_at]
    .filter((value) => typeof value === "string" && Number.isFinite(Date.parse(value)))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
}

export function latestSyncFailure(states) {
  const failures = states.flatMap((state) => [
    {
      message: state?.delivery_error,
      at: state?.delivery_error_at,
      stage: "Sending queued messages",
      accountLabel: state?.account_label,
      successfulActivityAt: latestSuccessfulActivityAt(state),
    },
    {
      message: state?.sync_error,
      at: state?.sync_error_at,
      stage: "Checking provider messages",
      accountLabel: state?.account_label,
      successfulActivityAt: latestSuccessfulActivityAt(state),
    },
  ]).filter((failure) => {
    if (!failure.message) return false;
    const errorAt = Date.parse(failure.at ?? "");
    const successfulAt = Date.parse(failure.successfulActivityAt ?? "");
    return !Number.isFinite(errorAt)
      || !Number.isFinite(successfulAt)
      || successfulAt <= errorAt;
  });
  failures.sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
  const failure = failures[0];
  if (!failure) return "";
  const detail = sanitizeLogText(failure.message);
  const accountLabel = failure.accountLabel ? ` (${sanitizeLogText(failure.accountLabel)})` : "";
  if (/failed to fetch|networkerror|network request failed/i.test(detail)) {
    return `${failure.stage}${accountLabel} failed: ${detail}. No HTTP response was available. Check your connection and server availability, then retry.`;
  }
  return `${failure.stage}${accountLabel} failed: ${detail}`;
}
