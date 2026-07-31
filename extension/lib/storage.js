export const STORAGE = {
  config: "config",
  consent: "local_consent",
  detectedAccount: "detected_account",
  installationId: "installation_id",
  deviceName: "device_name",
  pending: "pending_messages",
  status: "status",
  targetCursor: "target_sync_cursor",
  lastResumeSyncAt: "last_resume_sync_at",
  scanState: "sync_scan_state",
  deliveryRetry: "delivery_retry_state",
  live: "live_status",
  commandTab: "command_tab",
  serverInitialized: "server_initialized",
  logs: "operational_logs",
  logOutbox: "operational_log_outbox",
  logUploadEnabled: "operational_log_upload_enabled"
};

export const readStorage = (keys) => chrome.storage.local.get(keys);
export const writeStorage = (values) => chrome.storage.local.set(values);

export function readAccountState(container, key, fallback) {
  return key && container?.version === 2 && container.accounts?.[key] !== undefined
    ? container.accounts[key]
    : fallback;
}

export function writeAccountState(container, key, value) {
  return {
    version: 2,
    accounts: {
      ...(container?.version === 2 ? container.accounts : {}),
      [key]: value,
    },
  };
}

export function hasLocalConsent(consent) {
  return Boolean(consent?.accepted_at && consent?.policy_version === 2);
}

export async function installationId() {
  const stored = await readStorage([STORAGE.installationId]);
  if (stored[STORAGE.installationId]) return stored[STORAGE.installationId];
  const value = crypto.randomUUID();
  await writeStorage({ [STORAGE.installationId]: value });
  return value;
}

export function normalizeDeviceName(value) {
  return typeof value === "string" ? value.trim().slice(0, 80) : "";
}
