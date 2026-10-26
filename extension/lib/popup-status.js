import { sanitizeLogText } from "./logs.js";

const SELLER_CENTRE_SURFACE = "seller-centre";

export function providerConnectionStatus(live) {
  if (live?.socket !== "connected") return null;
  if (live.provider_recovery_state === "needs_attention") {
    return {
      label: "CONNECTED · ACTION REQUIRED",
      state: "error",
      hint: live.provider_recovery_reason || "The provider tab needs attention before syncing can continue.",
      action: "logs",
    };
  }
  if (live.provider_recovery_state === "opening") {
    return {
      label: "CONNECTED · OPENING PROVIDER",
      state: "neutral", loading: true,
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
    state: "neutral", loading: true,
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
      state: "neutral",
      hint: "Connected to your server. Open Seller Centre Chat to start syncing.",
    };
  }
  return {
    label: "CONNECTED · INITIALIZING",
    state: "neutral", loading: true,
    hint: "Connected to your server. Seller Centre Chat is initializing.",
  };
}

function latestSuccessfulActivityAt(state) {
  return [state?.last_sync_at, state?.last_capture_at, state?.last_delivery_at]
    .filter((value) => typeof value === "string" && Number.isFinite(Date.parse(value)))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
}

// An inactive shop cannot determine the dashboard action for the active shop.
export function currentAccountSyncFailure(state, live) {
  if (live?.active_in_profile === false) return "";
  return latestSyncFailure([state]);
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

export function transportConnectionStatus(live) {
  if (live?.socket === "connecting") return {
    label: "CONNECTING", state: "neutral", loading: true, hint: "Connecting this account to your target server.",
  };
  if (live?.socket === "reconnecting") return {
    label: "RECOVERING CONNECTION", state: "neutral", loading: true,
    hint: "The connection is recovering automatically. Keep Chrome online; provider readiness is checked separately.",
  };
  if (live?.socket === "disconnected") return {
    label: "TARGET UNREACHABLE", state: "error", action: "logs",
    hint: "Check your network and target server configuration, then retry from the extension.",
  };
  return null;
}

// Startup discovery is not evidence that configuration is missing.
export function accountDiscoveryStatus({ detecting, hasConfiguration, inactiveShopee = false }) {
  if (detecting) return { label: "detectingShop", hint: "detectingShop", action: "sync" };
  if (hasConfiguration && inactiveShopee) return { label: "inactiveShop", hint: "sessionUnverified", action: "detect" };
  if (hasConfiguration) return { label: "waitingForShop", hint: "shopUnknown", action: "sync" };
  return { label: "needConfig", hint: "configurationMissing", action: "configure" };
}

export function sessionConnectionStatus(live) {
  return {
    waiting_for_tab: {
      label: "OPEN PROVIDER CHAT", state: "neutral",
      hint: "Open this account's provider chat so the bridge can verify its session.",
    },
    checking_session: {
      label: "CHECKING SESSION", state: "neutral", loading: true,
      hint: "Rechecking this account's session. Commands are paused until access is verified.",
    },
    wrong_account: {
      label: "ACCOUNT NOT AVAILABLE", state: "neutral",
      hint: "This account is not available in the current provider login. Open the matching account and check again.",
    },
    needs_attention: {
      label: "SESSION NEEDS ATTENTION", state: "error",
      hint: "The session could not be verified. Open the provider chat, check its login, and retry.",
    },
  }[live?.eligibility_reason_code] ?? null;
}

export function accountConnectionStatus(live) {
  const session = sessionConnectionStatus(live);
  if (session) return session;
  if (live?.endpoint_not_found && live.socket !== "connected") return {
    label: "SERVER ENDPOINT NOT FOUND", state: "error", action: "logs",
    hint: "Cannot connect to the KaoJai server: endpoint not found (404). Check the extension connection settings and server deployment, then retry.",
  };
  // Recovery can run before a server socket exists.
  if (live?.provider_recovery_state === "opening") return {
    label: "OPENING PROVIDER CHAT", state: "neutral", loading: true,
    hint: live.provider_recovery_reason || "Opening the provider chat…",
  };
  if (live?.provider_recovery_state === "needs_attention") return {
    label: "ACTION REQUIRED", state: "error", action: "logs",
    hint: live.provider_recovery_reason || "The provider tab needs attention. Open its chat and retry.",
  };
  const transport = transportConnectionStatus(live);
  if (transport) return transport;
  if (live?.socket === "connected" && live?.provider_surface === SELLER_CENTRE_SURFACE
    && live.provider_chat_open !== false && live.provider_realtime_connected === false) return {
    label: "WAITING FOR SHOPEE CONNECTION", state: "neutral", loading: true,
    hint: "Waiting for Shopee's live connection. Keep its chat open.",
  };
  return sellerCentreConnectionStatus(live) || providerConnectionStatus(live) || {
    label: "WAITING FOR CONNECTION", state: "neutral",
    hint: "Waiting for connection status. Keep the provider chat open; retry if this continues.",
  };
}
