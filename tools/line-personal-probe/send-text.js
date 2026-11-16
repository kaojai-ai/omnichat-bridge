// Development probe only. The outcome contains fixed diagnostics, never the
// recipient, plaintext, ciphertext, provider response, or raw exception details.
const ERROR_CODES = new Map([
  ["NoE2EEKey", "E2EE_KEY_UNAVAILABLE"],
  ["No E2EEKey", "E2EE_KEY_UNAVAILABLE"],
  ["E2EEKeyMismatch", "E2EE_KEY_MISMATCH"],
  ["Not support E2EE", "RECIPIENT_E2EE_UNSUPPORTED"],
  ["RequestError", "LINE_REQUEST_REJECTED"],
  ["AbortError", "REQUEST_CANCELLED"],
  ["TimeoutError", "REQUEST_TIMEOUT"],
  ["TypeError", "BROWSER_TRANSPORT_OR_RUNTIME_ERROR"],
]);
const PROVIDER_CODES = new Set([
  "ILLEGAL_ARGUMENT", "AUTHENTICATION_FAILED", "EXCESSIVE_ACCESS", "NOT_FOUND",
  "NOT_AVAILABLE_USER", "NOT_AUTHORIZED_DEVICE", "INVALID_MID", "NOT_A_MEMBER",
  "NOT_AUTHORIZED_SESSION", "NOT_AUTHENTICATED", "ABUSE_BLOCK", "NOT_FRIEND",
  "BLOCK_FRIEND", "NOT_ALLOWED_SECONDARY_DEVICE", "FEATURE_RESTRICTED",
  "E2EE_INVALID_PROTOCOL", "E2EE_RETRY_ENCRYPT", "E2EE_UPDATE_SENDER_KEY",
  "E2EE_UPDATE_RECEIVER_KEY", "E2EE_INVALID_ARGUMENT", "E2EE_INVALID_VERSION",
  "E2EE_SENDER_DISABLED", "E2EE_RECEIVER_DISABLED", "E2EE_SENDER_NOT_ALLOWED",
  "E2EE_RECEIVER_NOT_ALLOWED", "E2EE_PRIMARY_NOT_SUPPORT", "MUST_REFRESH_V3_TOKEN",
]);

function notify(onStage, stage) {
  // Diagnostic observers must not interrupt or retry a send.
  try { onStage?.(stage); } catch { /* Only diagnostic presentation failed. */ }
}

function failure(status, stage, error, signal) {
  const code = signal?.aborted ? "REQUEST_CANCELLED"
    : ERROR_CODES.get(error?.name) ?? "LINE_REQUEST_FAILED";
  const providerCode = error?.data?.code;
  return {
    status, stage, code,
    ...(PROVIDER_CODES.has(providerCode) ? { provider_code: providerCode } : {}),
  };
}

function validate({ to, text, signal }) {
  if (typeof to !== "string" || !/^[ucr][a-f0-9]{32}$/i.test(to)
    || typeof text !== "string" || !text.trim() || text.length > 2_000) {
    return { status: "not_dispatched", stage: "preparation", code: "INVALID_TEST_MESSAGE" };
  }
  if (signal?.aborted) return { status: "not_dispatched", stage: "preparation", code: "REQUEST_CANCELLED" };
  return null;
}

async function dispatch(base, message, { signal, onStage }, acceptedCode) {
  const stage = "provider_dispatch";
  notify(onStage, stage);
  if (signal?.aborted) return { status: "not_dispatched", stage, code: "REQUEST_CANCELLED" };
  try {
    await base.talk.sendMessage(message);
    notify(onStage, "completed");
    return { status: "accepted", stage: "completed", code: acceptedCode };
  } catch (error) {
    return failure("uncertain", stage, error, signal);
  }
}

/**
 * Encrypt first so a rejected key negotiation is definitively not dispatched.
 * After entering sendMessage, any error is conservatively uncertain. Never
 * downgrade encryption and never automatically retry either phase.
 *
 * @returns {Promise<{status: "accepted" | "not_dispatched" | "uncertain", stage: string, code: string, provider_code?: string}>}
 */
export async function sendEncryptedText(base, { to, text, signal, onStage }) {
  const invalid = validate({ to, text, signal });
  if (invalid) return invalid;
  const stage = "encryption";
  notify(onStage, stage);
  if (signal?.aborted) return { status: "not_dispatched", stage, code: "REQUEST_CANCELLED" };
  let chunks;
  try {
    chunks = await base.e2ee.encryptE2EEMessage(to, text, "NONE");
    if (signal?.aborted) return { status: "not_dispatched", stage, code: "REQUEST_CANCELLED" };
    if (!Array.isArray(chunks) || chunks.length !== 5) {
      return { status: "not_dispatched", stage, code: "INVALID_ENCRYPTED_MESSAGE" };
    }
  } catch (error) {
    return failure("not_dispatched", stage, error, signal);
  }
  // Match LINEJS's encrypted sendMessage branch exactly. Plaintext is omitted
  // once chunks exist, so an unsupported peer cannot trigger a cleartext send.
  return dispatch(base, {
    to,
    contentType: "NONE",
    contentMetadata: { e2eeVersion: "2", contentType: "0", e2eeMark: "2" },
    e2ee: true,
    chunks,
  }, { signal, onStage }, "ENCRYPTED_TEXT_SEND_ACCEPTED");
}

/**
 * Explicit, user-authorized OA test mode. The caller must obtain fresh consent
 * for this mode and peer before invoking it. This is never an encryption-error
 * fallback: sendEncryptedText does not call this function under any condition.
 */
export async function sendOATestText(base, { to, text, signal, onStage }) {
  const invalid = validate({ to, text, signal });
  if (invalid) return invalid;
  return dispatch(base, { to, text, e2ee: false }, { signal, onStage }, "OA_TEST_TEXT_SEND_ACCEPTED");
}
