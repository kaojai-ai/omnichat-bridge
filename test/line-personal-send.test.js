import assert from "node:assert/strict";
import { test } from "node:test";
import { sendEncryptedText, sendPersonalText, sendUnsealedText } from "../extension/lib/provider-text-send.js";

const to = `u${"a".repeat(32)}`;
const text = "private test text";
const chunks = Array.from({ length: 5 }, (_, i) => new Uint8Array([i]));

function fixture({ encrypt, send } = {}) {
  const encrypted = [];
  const dispatched = [];
  return {
    encrypted, dispatched,
    base: {
      e2ee: { async encryptE2EEMessage(...args) { encrypted.push(args); return encrypt ? encrypt(...args) : chunks; } },
      talk: { async sendMessage(input) { dispatched.push(input); return send ? send(input) : { id: "private-provider-id" }; } },
    },
  };
}

for (const [name, code] of [
  ["NoE2EEKey", "E2EE_KEY_UNAVAILABLE"],
  ["No E2EEKey", "E2EE_KEY_UNAVAILABLE"],
  ["E2EEKeyMismatch", "E2EE_KEY_MISMATCH"],
  ["Not support E2EE", "RECIPIENT_E2EE_UNSUPPORTED"],
  ["RequestError", "LINE_REQUEST_REJECTED"],
  ["TypeError", "BROWSER_TRANSPORT_OR_RUNTIME_ERROR"],
  ["TimeoutError", "REQUEST_TIMEOUT"],
]) {
  test(`${name} during negotiation is not dispatched and never falls back to plaintext`, async () => {
    const { base, dispatched, encrypted } = fixture({ encrypt() {
      throw Object.assign(new Error(`secret recipient ${to}`), { name });
    } });
    const outcome = await sendEncryptedText(base, { to, text });
    assert.deepEqual(outcome, { status: "not_dispatched", stage: "encryption", code });
    assert.equal(dispatched.length, 0);
    assert.equal(encrypted.length, 1);
  });
}

test("cancellation while encryption is pending prevents dispatch", async () => {
  const controller = new AbortController();
  let resolveEncryption;
  const { base, dispatched } = fixture({ encrypt() {
    return new Promise((resolve) => { resolveEncryption = resolve; });
  } });
  const pending = sendEncryptedText(base, { to, text, signal: controller.signal });
  controller.abort();
  resolveEncryption(chunks);
  assert.deepEqual(await pending, { status: "not_dispatched", stage: "encryption", code: "REQUEST_CANCELLED" });
  assert.equal(dispatched.length, 0);
});

test("accepted send preserves recipient and encrypted metadata without passing plaintext", async () => {
  const stages = [];
  const { base, dispatched, encrypted } = fixture();
  const outcome = await sendEncryptedText(base, { to, text, onStage: (stage) => stages.push(stage) });
  assert.deepEqual(encrypted, [[to, text, "NONE"]]);
  assert.deepEqual(dispatched, [{
    to, contentType: "NONE", contentMetadata: { e2eeVersion: "2", contentType: "0", e2eeMark: "2" },
    e2ee: true, chunks,
  }]);
  assert.deepEqual(stages, ["encryption", "provider_dispatch", "completed"]);
  assert.deepEqual(outcome, { status: "accepted", stage: "completed", code: "ENCRYPTED_TEXT_SEND_ACCEPTED" });
  assert.ok(!JSON.stringify(outcome).includes("private-provider-id"));
});

test("any failure after dispatch begins is uncertain, with exactly one dispatch", async () => {
  const { base, dispatched, encrypted } = fixture({ send() { throw new TypeError("private response body"); } });
  const outcome = await sendEncryptedText(base, { to, text });
  assert.deepEqual(outcome, { status: "uncertain", stage: "provider_dispatch", code: "BROWSER_TRANSPORT_OR_RUNTIME_ERROR" });
  assert.equal(dispatched.length, 1);
  assert.equal(encrypted.length, 1);
});

test("cancellation after dispatch begins remains uncertain", async () => {
  const controller = new AbortController();
  const { base, dispatched } = fixture({ send() {
    controller.abort();
    throw Object.assign(new Error("sensitive request"), { name: "AbortError" });
  } });
  const outcome = await sendEncryptedText(base, { to, text, signal: controller.signal });
  assert.deepEqual(outcome, { status: "uncertain", stage: "provider_dispatch", code: "REQUEST_CANCELLED" });
  assert.equal(dispatched.length, 1);
});

test("only fixed diagnostics and allowlisted provider codes leave the helper", async () => {
  for (const providerCode of ["E2EE_RECEIVER_DISABLED", `secret-${to}`, 88]) {
    const { base } = fixture({ encrypt() {
      throw Object.assign(new Error(`${text}: token=secret`), {
        name: `private-error-${to}`, stack: "private-stack", data: { code: providerCode, payload: text, token: "secret" },
      });
    } });
    const result = await sendEncryptedText(base, { to, text });
    assert.deepEqual(result, {
      status: "not_dispatched", stage: "encryption", code: "LINE_REQUEST_FAILED",
      ...(providerCode === "E2EE_RECEIVER_DISABLED" ? { provider_code: providerCode } : {}),
    });
    assert.ok(!JSON.stringify(result).includes(text));
    assert.ok(!JSON.stringify(result).includes(to));
    assert.ok(!JSON.stringify(result).includes("secret"));
  }
});

test("invalid input, pre-cancelled requests and malformed encrypted output never dispatch", async () => {
  for (const input of [{ to: "invalid", text }, { to, text: "" }, { to, text: "x".repeat(2_001) }]) {
    const { base, encrypted, dispatched } = fixture();
    assert.equal((await sendEncryptedText(base, input)).code, "INVALID_MESSAGE");
    assert.equal(encrypted.length, 0);
    assert.equal(dispatched.length, 0);
  }
  const controller = new AbortController();
  controller.abort();
  const cancelled = fixture();
  assert.equal((await sendEncryptedText(cancelled.base, { to, text, signal: controller.signal })).code, "REQUEST_CANCELLED");
  assert.equal(cancelled.encrypted.length, 0);
  const malformed = fixture({ encrypt() { return []; } });
  assert.equal((await sendEncryptedText(malformed.base, { to, text })).code, "INVALID_ENCRYPTED_MESSAGE");
  assert.equal(malformed.dispatched.length, 0);
});

test("diagnostic observer cannot cause an automatic retry or interrupt an accepted send", async () => {
  const { base, dispatched } = fixture();
  const outcome = await sendEncryptedText(base, { to, text, onStage() { throw new Error("UI diagnostic failed"); } });
  assert.equal(outcome.status, "accepted");
  assert.equal(dispatched.length, 1);
});

test("explicit OA test mode preserves text and deliberately bypasses encryption once", async () => {
  const stages = [];
  const { base, dispatched, encrypted } = fixture({ encrypt() { throw new Error("Encryption must not run in explicit OA mode"); } });
  const outcome = await sendUnsealedText(base, { to, text, onStage: (stage) => stages.push(stage) });
  assert.deepEqual(dispatched, [{ to, text, e2ee: false }]);
  assert.equal(encrypted.length, 0);
  assert.deepEqual(stages, ["provider_dispatch", "completed"]);
  assert.deepEqual(outcome, { status: "accepted", stage: "completed", code: "UNSEALED_TEXT_SEND_ACCEPTED" });
});

test("an encrypted failure never automatically switches to OA test mode", async () => {
  const { base, dispatched } = fixture({ encrypt() { throw Object.assign(new Error(to), { name: "Not support E2EE" }); } });
  const result = await sendEncryptedText(base, { to, text });
  assert.equal(result.status, "not_dispatched");
  assert.equal(result.code, "RECIPIENT_E2EE_UNSUPPORTED");
  assert.equal(dispatched.length, 0);
});

test("OA test mode honors cancellation before entering send and never retries after uncertainty", async () => {
  const before = new AbortController();
  const cancelled = fixture();
  const notDispatched = await sendUnsealedText(cancelled.base, {
    to, text, signal: before.signal,
    onStage(stage) { if (stage === "provider_dispatch") before.abort(); },
  });
  assert.deepEqual(notDispatched, { status: "not_dispatched", stage: "provider_dispatch", code: "REQUEST_CANCELLED" });
  assert.equal(cancelled.dispatched.length, 0);
  const after = new AbortController();
  const failed = fixture({ send() {
    after.abort();
    throw Object.assign(new Error(`token=secret ${text} ${to}`), { name: "AbortError" });
  } });
  const uncertain = await sendUnsealedText(failed.base, { to, text, signal: after.signal });
  assert.deepEqual(uncertain, { status: "uncertain", stage: "provider_dispatch", code: "REQUEST_CANCELLED" });
  assert.equal(failed.dispatched.length, 1);
  assert.equal(failed.encrypted.length, 0);
  assert.ok(!JSON.stringify(uncertain).includes(text));
  assert.ok(!JSON.stringify(uncertain).includes(to));
  assert.ok(!JSON.stringify(uncertain).includes("secret"));
});

test("OA test mode shares validation and provider-error sanitization", async () => {
  const invalid = fixture();
  assert.equal((await sendUnsealedText(invalid.base, { to: "invalid", text })).code, "INVALID_MESSAGE");
  assert.equal(invalid.dispatched.length, 0);
  const failed = fixture({ send() {
    throw Object.assign(new Error(`private ${to}`), { name: "RequestError", data: { code: "NOT_FRIEND", private: text } });
  } });
  assert.deepEqual(await sendUnsealedText(failed.base, { to, text }), {
    status: "uncertain", stage: "provider_dispatch", code: "LINE_REQUEST_REJECTED", provider_code: "NOT_FRIEND",
  });
  assert.equal(failed.dispatched.length, 1);
});

test("native E2EE capability selects encrypted dispatch and exposes only an explicitly requested receipt", async () => {
  const { base, encrypted, dispatched } = fixture({ send() {
    return { id: "native-receipt", token: "must-not-return", text: "must-not-return" };
  } });
  const queries = [];
  base.talk.negotiateE2EEPublicKey = async (value) => { queries.push(value); return { specVersion: 2 }; };
  const result = await sendPersonalText(base, { to, text, receipt: true });
  assert.deepEqual(queries, [{ mid: to }]);
  assert.equal(encrypted.length, 1);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].e2ee, true);
  assert.equal(dispatched[0].text, undefined);
  assert.equal(result.status, "accepted");
  assert.equal(result.provider_message_id, "native-receipt");
  assert.ok(!JSON.stringify(result).includes("must-not-return"));
});

test("an explicitly unsealed native peer uses one transport send without attempting encryption", async () => {
  const { base, encrypted, dispatched } = fixture({ encrypt() { throw new Error("Must not encrypt an unsealed peer"); } });
  base.talk.negotiateE2EEPublicKey = async () => ({ specVersion: -1 });
  const result = await sendPersonalText(base, { to, text });
  assert.equal(encrypted.length, 0);
  assert.deepEqual(dispatched, [{ to, text, e2ee: false }]);
  assert.equal(result.code, "UNSEALED_TEXT_SEND_ACCEPTED");
  assert.equal(result.provider_message_id, undefined);
});

test("missing or unsupported peer capability cannot select plaintext or dispatch a message", async () => {
  for (const capability of [null, {}, { specVersion: 0 }, { specVersion: 1 }, { specVersion: "2" }]) {
    const { base, encrypted, dispatched } = fixture();
    base.talk.negotiateE2EEPublicKey = async () => capability;
    const result = await sendPersonalText(base, { to, text });
    assert.deepEqual(result, { status: "not_dispatched", stage: "preparation", code: "RECIPIENT_E2EE_UNSUPPORTED" });
    assert.equal(encrypted.length, 0);
    assert.equal(dispatched.length, 0);
  }
});

test("failed capability lookup and failed encryption never trigger an unsealed retry", async () => {
  const lookup = fixture();
  lookup.base.talk.negotiateE2EEPublicKey = async () => {
    throw Object.assign(new Error(`private token ${text}`), { name: "RequestError", data: { code: "NOT_FRIEND" } });
  };
  assert.deepEqual(await sendPersonalText(lookup.base, { to, text }), {
    status: "not_dispatched", stage: "preparation", code: "LINE_REQUEST_REJECTED", provider_code: "NOT_FRIEND",
  });
  assert.equal(lookup.encrypted.length, 0);
  assert.equal(lookup.dispatched.length, 0);
  const encryption = fixture({ encrypt() { throw Object.assign(new Error("Private key details"), { name: "NoE2EEKey" }); } });
  encryption.base.talk.negotiateE2EEPublicKey = async () => ({ specVersion: 2 });
  assert.equal((await sendPersonalText(encryption.base, { to, text })).code, "E2EE_KEY_UNAVAILABLE");
  assert.equal(encryption.dispatched.length, 0);
});

test("groups and rooms bypass direct-peer capability lookup and always require encryption", async () => {
  for (const prefix of ["c", "r"]) {
    const { base, encrypted, dispatched } = fixture();
    base.talk.negotiateE2EEPublicKey = async () => { throw new Error("Unexpected direct-peer lookup"); };
    const destination = `${prefix}${"a".repeat(32)}`;
    const result = await sendPersonalText(base, { to: destination, text });
    assert.equal(result.status, "accepted");
    assert.equal(encrypted.length, 1);
    assert.equal(encrypted[0][0], destination);
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].e2ee, true);
  }
});

test("cancellation during capability lookup prevents either send mode from dispatching", async () => {
  for (const specVersion of [-1, 2]) {
    const controller = new AbortController();
    const { base, encrypted, dispatched } = fixture();
    let resolveLookup;
    base.talk.negotiateE2EEPublicKey = () => new Promise((resolve) => { resolveLookup = resolve; });
    const pending = sendPersonalText(base, { to, text, signal: controller.signal });
    controller.abort();
    resolveLookup({ specVersion });
    assert.equal((await pending).code, "REQUEST_CANCELLED");
    assert.equal(encrypted.length, 0);
    assert.equal(dispatched.length, 0);
  }
});

test("native-mode uncertain delivery never retries and receipts stay absent unless requested", async () => {
  const { base, dispatched } = fixture({ send() { throw new TypeError("Private transport failure"); } });
  base.talk.negotiateE2EEPublicKey = async () => ({ specVersion: -1 });
  const result = await sendPersonalText(base, { to, text, receipt: true });
  assert.equal(result.status, "uncertain");
  assert.equal(result.provider_message_id, undefined);
  assert.equal(dispatched.length, 1);
});
