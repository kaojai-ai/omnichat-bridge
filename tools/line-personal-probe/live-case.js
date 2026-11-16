import { BaseClient } from "@evex-dev/linejs/base";
import { MemoryStorage } from "@evex-dev/linejs/storage";
import { createBrowserFetch } from "./browser-fetch.js";
import { sendOATestText } from "./send-text.js";

// Independent local test session. Never reads the installed Chrome extension,
// its page, credentials or storage. Only the exact one-time OA challenge can
// trigger one reply; other conversations are not exposed or acted on.
export async function runLiveCase({ marker, reply, signal, onQr, onPin, onStatus }) {
  const storage = new MemoryStorage();
  const base = new BaseClient({ device: "ANDROIDSECONDARY", storage, fetch: createBrowserFetch(signal) });
  const startedAt = Date.now();
  const counts = { operations: 0, received: 0, decrypted: 0, matched: 0, reply_attempts: 0 };
  const status = (phase, extra = {}) => onStatus({ phase, ...counts, ...extra });
  let completed = false;
  let outcome;
  base.on("update:authtoken", (token) => { if (!signal.aborted) base.authToken = token; });
  base.on("qrcall", (url) => { if (!signal.aborted) onQr(url); });
  base.on("pincall", (pin) => { if (!signal.aborted) onPin(/^\d{4,8}$/.test(String(pin)) ? String(pin) : null); });
  const revisions = { revision: 0, globalRev: 0, individualRev: 0 };
  try {
    status("authorizing");
    await base.loginProcess.withQrCode({});
    signal.throwIfAborted();
    await base.loginProcess.ready();
    signal.throwIfAborted();
    if (!base.profile?.mid) throw new Error("PROFILE_NOT_VERIFIED");
    status("waiting_for_oa_challenge");
    let failures = 0;
    while (!signal.aborted && !completed) {
      try {
        const response = await base.talk.sync({ ...revisions, limit: 100 });
        signal.throwIfAborted();
        const result = response.operationResponse;
        if (response.fullSyncResponse?.nextRevision != null) revisions.revision = response.fullSyncResponse.nextRevision;
        if (result?.globalEvents?.lastRevision != null) revisions.globalRev = result.globalEvents.lastRevision;
        if (result?.individualEvents?.lastRevision != null) revisions.individualRev = result.individualEvents.lastRevision;
        for (const operation of result?.operations ?? []) {
          if (operation.revision != null) revisions.revision = operation.revision;
          counts.operations++;
          if (operation.type !== "RECEIVE_MESSAGE" || !operation.message) continue;
          counts.received++;
          const message = operation.message;
          if (message.to !== base.profile.mid || (message.toType !== "USER" && message.toType !== 0)
            || !/^[u][a-f0-9]{32}$/i.test(message.from ?? "")
            || !Number.isFinite(Number(message.createdTime))
            || Number(message.createdTime) < startedAt - 5_000) continue;
          let text = message.text;
          if (message.chunks?.length) {
            try {
              [text] = await base.e2ee.decryptE2EETextMessage(message);
              counts.decrypted++;
            } catch {
              status("incoming_decryption_failed");
              continue;
            }
          }
          if (text !== marker) continue;
          counts.matched++;
          status("oa_challenge_verified");
          // This runner is expressly for the user's own OA test chat. OA mode
          // is selected in advance, not as a downgrade after an E2EE failure.
          signal.throwIfAborted();
          counts.reply_attempts++;
          completed = true;
          outcome = await sendOATestText(base, { to: message.from, text: reply, signal });
          status("oa_reply_result", { outcome });
          break;
        }
        failures = 0;
      } catch {
        if (completed) {
          outcome ??= { status: "uncertain", stage: "provider_dispatch", code: "LINE_REQUEST_FAILED" };
          break;
        }
        if (signal.aborted) break;
        failures++;
        status("poll_failed", { consecutive_failures: failures });
        if (failures >= 3) break;
      }
    }
    if (!completed) status("stopped_without_reply");
  } finally {
    base.authToken = "";
    base.profile = undefined;
    await storage.clear();
    status("session_discarded", { ...(outcome ? { outcome } : {}) });
  }
}
