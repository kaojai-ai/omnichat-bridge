import { BaseClient } from "@evex-dev/linejs/base";
import { MemoryStorage } from "@evex-dev/linejs/storage";
import QRCode from "qrcode";
import { createBrowserFetch } from "../../extension/lib/line-personal-fetch.js";
import { sendEncryptedText, sendUnsealedText } from "../../extension/lib/provider-text-send.js";

const element = (id) => document.getElementById(id);
const ui = Object.fromEntries([
  "consent", "connect", "stop", "status", "authorization", "qr", "pin-label", "pin",
  "counts", "events", "destination", "message", "send", "send-status", "use-latest", "oa-peer",
].map((id) => [id, element(id)]));
const MAX_DIAGNOSTICS = 12;
const MAX_POLL_FAILURES = 3;
const MESSAGE_TYPES = new Set(["NONE", "IMAGE", "VIDEO", "AUDIO", "FILE", "STICKER", "LOCATION", "CONTACT"]);
let current = null;

function active(session) {
  return current === session && !session.controller.signal.aborted;
}

function diagnostic(code) {
  const row = document.createElement("li");
  row.textContent = `${new Date().toLocaleTimeString()} · ${code}`;
  ui.events.prepend(row);
  while (ui.events.children.length > MAX_DIAGNOSTICS) ui.events.lastElementChild.remove();
}

function safeError(error) {
  if (error?.name === "AbortError") return "REQUEST_CANCELLED";
  if (error?.name === "TimeoutError") return "REQUEST_TIMEOUT";
  if (error?.name === "TypeError") return "BROWSER_TRANSPORT_OR_RUNTIME_ERROR";
  return "LINE_REQUEST_FAILED";
}

function clearAuthorization() {
  ui.authorization.hidden = true;
  ui["pin-label"].hidden = true;
  ui.pin.textContent = "";
  ui.qr.getContext("2d")?.clearRect(0, 0, ui.qr.width, ui.qr.height);
}

function renderCounts(session) {
  const { operations, received, decrypted, sent, failed } = session.counts;
  ui.counts.textContent = `Operations: ${operations} · Received: ${received} · Encrypted text decrypted: ${decrypted} · Sent echoes: ${sent} · Decryption failures: ${failed}`;
}

async function stop(status = "Stopped. Local credentials cleared.") {
  const previous = current;
  current = null;
  previous?.controller.abort();
  if (previous) {
    previous.ready = false;
    previous.base.authToken = "";
    previous.base.profile = undefined;
    await previous.storage.clear();
  }
  clearAuthorization();
  ui.status.textContent = status;
  ui.connect.disabled = !ui.consent.checked;
  ui.stop.disabled = true;
  ui.send.disabled = true;
  ui["use-latest"].disabled = true;
  ui["send-status"].textContent = "Not connected. Stopping cannot recall a message already sent.";
  ui.destination.value = "";
  ui.message.value = "";
  ui["oa-peer"].checked = false;
}

function delay(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

// Poll request/response SYNC4. The high-level client uses duplex PUSH, whose
// indefinite request stream is not suitable for a browser half-duplex fetch.
async function poll(session) {
  const revisions = { revision: 0, globalRev: 0, individualRev: 0 };
  let consecutiveFailures = 0;
  while (active(session)) {
    try {
      const response = await session.base.talk.sync({ ...revisions, limit: 100 });
      if (!active(session)) return;
      const operations = response.operationResponse;
      if (response.fullSyncResponse?.nextRevision != null) revisions.revision = response.fullSyncResponse.nextRevision;
      if (operations?.globalEvents?.lastRevision != null) revisions.globalRev = operations.globalEvents.lastRevision;
      if (operations?.individualEvents?.lastRevision != null) revisions.individualRev = operations.individualEvents.lastRevision;
      for (const operation of operations?.operations ?? []) {
        if (!active(session)) return;
        session.counts.operations++;
        if (operation.revision != null) revisions.revision = operation.revision;
        const incoming = operation.type === "RECEIVE_MESSAGE";
        if (!incoming && operation.type !== "SEND_MESSAGE") continue;
        if (incoming) session.counts.received++;
        else session.counts.sent++;
        if (!operation.message) continue;
        try {
          const message = operation.message;
          if (incoming) {
            const destination = message.toType === "USER" || message.toType === 0 ? message.from : message.to;
            if (/^[ucr][a-f0-9]{32}$/i.test(destination ?? "")) {
              session.latestDestination = destination;
              ui["use-latest"].disabled = false;
            }
          }
          const encryptedText = (message.contentType === "NONE" || message.contentType === 0) && Boolean(message.chunks?.length);
          if (encryptedText) {
            await session.base.e2ee.decryptE2EETextMessage(message);
            if (active(session)) session.counts.decrypted++;
          }
          if (!active(session)) return;
          const type = MESSAGE_TYPES.has(message.contentType) ? message.contentType
            : Number.isInteger(message.contentType) && message.contentType >= 0 && message.contentType <= 100
              ? `TYPE_${message.contentType}` : "OTHER";
          const encryption = encryptedText ? "ENCRYPTED_TEXT_DECRYPTED"
            : message.chunks?.length || message.contentMetadata?.e2eeVersion ? "ENCRYPTED_NOT_DECRYPTED" : "NO_E2EE_CHUNKS";
          diagnostic(`${incoming ? "RECEIVED" : "SENT_ECHO"}_${type}_${encryption}`);
        } catch {
          if (!active(session)) return;
          session.counts.failed++;
          diagnostic("MESSAGE_DECRYPTION_FAILED");
        }
      }
      renderCounts(session);
      consecutiveFailures = 0;
      await delay(1_000, session.controller.signal);
    } catch (error) {
      if (!active(session)) return;
      consecutiveFailures++;
      diagnostic(`POLL_${safeError(error)}`);
      if (consecutiveFailures >= MAX_POLL_FAILURES) {
        await stop("Stopped after three polling failures. No automatic re-login was attempted.");
        return;
      }
      await delay(2_000 * consecutiveFailures, session.controller.signal);
    }
  }
}

ui.consent.addEventListener("change", () => { ui.connect.disabled = Boolean(current) || !ui.consent.checked; });
ui.stop.addEventListener("click", () => { void stop(); });
ui["use-latest"].addEventListener("click", () => {
  if (current?.ready && current.latestDestination) ui.destination.value = current.latestDestination;
});
ui.connect.addEventListener("click", async () => {
  if (current || !ui.consent.checked) return;
  const controller = new AbortController();
  const storage = new MemoryStorage();
  let base;
  try {
    base = new BaseClient({ device: "ANDROIDSECONDARY", legy: { encrypted: false }, fetch: createBrowserFetch(controller.signal), storage });
  } catch (error) {
    diagnostic(`INITIALIZE_${safeError(error)}`);
    ui.status.textContent = "Browser client initialization failed. No login was started.";
    return;
  }
  const session = { controller, storage, base, ready: false, sending: false, counts: { operations: 0, received: 0, decrypted: 0, sent: 0, failed: 0 } };
  current = session;
  ui.events.replaceChildren();
  renderCounts(session);
  ui.connect.disabled = true;
  ui.stop.disabled = false;
  ui.status.textContent = "Requesting QR authorization. Approve only in the test account's LINE app.";
  base.on("update:authtoken", (token) => {
    if (active(session)) base.authToken = token;
  });
  base.on("qrcall", (url) => {
    if (!active(session)) return;
    ui.authorization.hidden = false;
    const canvas = document.createElement("canvas");
    void QRCode.toCanvas(canvas, url, { width: 280, margin: 2 }).then(() => {
      if (!active(session)) return;
      ui.qr.width = canvas.width;
      ui.qr.height = canvas.height;
      ui.qr.getContext("2d")?.drawImage(canvas, 0, 0);
    }).catch(() => {
      if (active(session)) { diagnostic("QR_RENDER_FAILED"); void stop("QR rendering failed. Connection stopped."); }
    });
  });
  base.on("pincall", (pin) => {
    if (!active(session)) return;
    ui["pin-label"].hidden = false;
    ui.pin.textContent = /^\d{4,8}$/.test(String(pin)) ? String(pin) : "Check LINE";
  });
  // Intentionally no library log listener: upstream diagnostics can contain
  // credentials, profile data, payloads and encryption key material.
  try {
    await base.loginProcess.withQrCode({});
    if (!active(session)) { base.authToken = ""; await storage.clear(); return; }
    await base.loginProcess.ready();
    if (!active(session)) { base.authToken = ""; await storage.clear(); return; }
    if (!base.profile?.mid) throw new Error("PROFILE_VERIFICATION_FAILED");
    session.ready = true;
    clearAuthorization();
    ui.status.textContent = "Connected. Own profile verified; identity hidden. Polling for operations.";
    ui.send.disabled = false;
    ui["send-status"].textContent = "Ready. Send only to a test recipient you control.";
    diagnostic("LOGIN_PROFILE_VERIFIED");
    void poll(session);
  } catch (error) {
    if (!active(session)) { base.authToken = ""; await storage.clear(); return; }
    diagnostic(`LOGIN_${safeError(error)}`);
    await stop("Login failed. Local credentials cleared; press Connect to try again manually.");
  }
});

ui.send.addEventListener("click", async () => {
  const session = current;
  if (!session?.ready || session.sending || !active(session)) return;
  const to = ui.destination.value.trim();
  const text = ui.message.value.trim();
  if (!/^[ucr][a-f0-9]{32}$/i.test(to) || !text || text.length > 2_000) {
    ui["send-status"].textContent = "Enter a valid test user/group ID and 1–2,000 characters.";
    return;
  }
  session.sending = true;
  ui.send.disabled = true;
  const send = ui["oa-peer"].checked ? sendUnsealedText : sendEncryptedText;
  try {
    const outcome = await send(session.base, {
      to, text, signal: session.controller.signal,
      onStage(stage) {
        if (!active(session)) return;
        ui["send-status"].textContent = stage === "encryption" ? "Preparing encrypted text…" : "Sending once…";
      },
    });
    if (!active(session)) return;
    diagnostic(`SEND_${outcome.status.toUpperCase()}_${outcome.code}${outcome.provider_code ? `_${outcome.provider_code}` : ""}`);
    if (outcome.status === "accepted") {
      ui.message.value = "";
      ui["send-status"].textContent = "LINE accepted the send. Confirm its appearance on the recipient's device.";
    } else if (outcome.status === "not_dispatched") {
      ui["send-status"].textContent = `Not sent: ${outcome.code}. No message was dispatched.`;
    } else {
      ui["send-status"].textContent = `Send not confirmed: ${outcome.code}. Check the recipient before retrying.`;
    }
  } finally {
    session.sending = false;
    if (active(session)) ui.send.disabled = !session.ready;
  }
});

window.addEventListener("pagehide", () => { void stop(); });
