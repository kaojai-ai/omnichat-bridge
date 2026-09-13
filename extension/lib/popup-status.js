import { sanitizeLogText } from "./logs.js";

const SELLER_CENTRE_SURFACE = "seller-centre";

export function sellerCentreConnectionStatus(live) {
  if (live?.socket !== "connected" || live?.provider_surface !== SELLER_CENTRE_SURFACE) return null;
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

export function latestSyncFailure(states) {
  const failures = states.flatMap((state) => [
    { message: state?.delivery_error, at: state?.delivery_error_at, stage: "Sending queued messages" },
    { message: state?.sync_error, at: state?.sync_error_at, stage: "Checking provider messages" },
  ]).filter((failure) => failure.message);
  failures.sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
  const failure = failures[0];
  if (!failure) return "";
  const detail = sanitizeLogText(failure.message);
  if (/failed to fetch|networkerror|network request failed/i.test(detail)) {
    return `${failure.stage} failed: ${detail}. No HTTP response was available. Check your connection and server availability, then retry.`;
  }
  return `${failure.stage} failed: ${detail}`;
}
