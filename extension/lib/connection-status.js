export function isoOrNull(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

export function buildConnectionHealth({
  tabCount,
  contentReady,
  accountDetected,
  accountMatches,
  realtimeConnected,
  lastRealtimeConnectedAt,
  pendingMessages,
  status,
}) {
  const deliveryErrorAt = status?.delivery_error ? isoOrNull(status.delivery_error_at) : null;
  const syncErrorAt = status?.sync_error ? isoOrNull(status.sync_error_at) : null;
  const checks = [
    {
      key: "provider_tab",
      status: tabCount ? "pass" : "fail",
      ...(!tabCount ? { reason_code: "seller_chat_tab_closed" } : {}),
    },
    {
      key: "content_bridge",
      status: contentReady ? "pass" : tabCount ? "fail" : "unknown",
      ...(tabCount && !contentReady ? { reason_code: "seller_chat_bridge_unavailable" } : {}),
    },
    {
      key: "provider_account",
      status: accountMatches ? "pass" : "fail",
      ...(!accountDetected
        ? { reason_code: "seller_account_not_detected" }
        : !accountMatches
          ? { reason_code: "seller_account_mismatch" }
          : {}),
    },
    {
      key: "provider_realtime",
      status: realtimeConnected ? "pass" : contentReady ? "fail" : "unknown",
      ...(contentReady && !realtimeConnected
        ? { reason_code: "shopee_realtime_disconnected" }
        : {}),
      ...(isoOrNull(lastRealtimeConnectedAt)
        ? { observed_at: lastRealtimeConnectedAt }
        : {}),
    },
  ];

  let reasonCode = "healthy";
  let lastError = null;
  if (deliveryErrorAt) {
    reasonCode = "message_delivery_failed";
    lastError = { code: reasonCode, occurred_at: deliveryErrorAt };
  } else if (syncErrorAt) {
    reasonCode = "message_sync_failed";
    lastError = { code: reasonCode, occurred_at: syncErrorAt };
  } else if (!tabCount) {
    reasonCode = "seller_chat_tab_closed";
  } else if (!contentReady) {
    reasonCode = "seller_chat_bridge_unavailable";
  } else if (!accountDetected) {
    reasonCode = "seller_account_not_detected";
  } else if (!accountMatches) {
    reasonCode = "seller_account_mismatch";
  } else if (!realtimeConnected) {
    reasonCode = "shopee_realtime_disconnected";
  } else if (pendingMessages) {
    reasonCode = "messages_pending";
  }

  return {
    reason_code: reasonCode,
    checks,
    metrics: {
      provider_tabs: tabCount,
      pending_messages: pendingMessages,
    },
    last_capture_at: isoOrNull(status?.last_capture_at),
    last_delivery_at: isoOrNull(status?.last_delivery_at),
    last_sync_at: isoOrNull(status?.last_sync_at),
    last_error: lastError,
  };
}
