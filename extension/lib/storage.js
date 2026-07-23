export const STORAGE = {
  config: "config",
  consent: "local_consent",
  detectedAccount: "detected_account",
  installationId: "installation_id",
  pending: "pending_messages",
  status: "status",
  targetCursor: "target_sync_cursor",
  lastResumeSyncAt: "last_resume_sync_at"
};

export const readStorage = (keys) => chrome.storage.local.get(keys);
export const writeStorage = (values) => chrome.storage.local.set(values);

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
