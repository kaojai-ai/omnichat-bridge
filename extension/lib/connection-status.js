export function isoOrNull(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

export function buildConnectionHealth({
  provider = "shopee",
  tabCount,
  contentReady,
  accountDetected,
  accountMatches,
  realtimeConnected,
  lastRealtimeConnectedAt,
  pendingMessages,
  status,
}) {
  const providerId = typeof provider === "string" && provider.trim() ? provider.trim() : "shopee";
  const legacyShopee = providerId === "shopee";
  const tabClosedReason = legacyShopee ? "seller_chat_tab_closed" : `${providerId}_tab_closed`;
  const bridgeUnavailableReason = legacyShopee
    ? "seller_chat_bridge_unavailable"
    : `${providerId}_bridge_unavailable`;
  const accountNotDetectedReason = legacyShopee
    ? "seller_account_not_detected"
    : `${providerId}_account_not_detected`;
  const accountMismatchReason = legacyShopee
    ? "seller_account_mismatch"
    : `${providerId}_account_mismatch`;
  const realtimeDisconnectedReason = `${providerId}_realtime_disconnected`;
  const deliveryErrorAt = status?.delivery_error ? isoOrNull(status.delivery_error_at) : null;
  const syncErrorAt = status?.sync_error ? isoOrNull(status.sync_error_at) : null;
  const checks = [
    {
      key: "provider_tab",
      status: tabCount ? "pass" : "fail",
      ...(!tabCount ? { reason_code: tabClosedReason } : {}),
    },
    {
      key: "content_bridge",
      status: contentReady ? "pass" : tabCount ? "fail" : "unknown",
      ...(tabCount && !contentReady ? { reason_code: bridgeUnavailableReason } : {}),
    },
    {
      key: "provider_account",
      status: accountMatches ? "pass" : "fail",
      ...(!accountDetected
        ? { reason_code: accountNotDetectedReason }
        : !accountMatches
          ? { reason_code: accountMismatchReason }
          : {}),
    },
    {
      key: "provider_realtime",
      status: realtimeConnected ? "pass" : contentReady ? "fail" : "unknown",
      ...(contentReady && !realtimeConnected
        ? { reason_code: realtimeDisconnectedReason }
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
    reasonCode = tabClosedReason;
  } else if (!contentReady) {
    reasonCode = bridgeUnavailableReason;
  } else if (!accountDetected) {
    reasonCode = accountNotDetectedReason;
  } else if (!accountMatches) {
    reasonCode = accountMismatchReason;
  } else if (!realtimeConnected) {
    reasonCode = realtimeDisconnectedReason;
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
