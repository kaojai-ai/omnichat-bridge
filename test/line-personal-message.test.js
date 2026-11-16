import assert from "node:assert/strict";
import { test } from "node:test";
import { personalTextMessage } from "../extension/lib/line-personal-message.js";

const own = `u${"1".repeat(32)}`;
const peer = `u${"2".repeat(32)}`;
const group = `c${"3".repeat(32)}`;
const timestamp = Date.parse("2026-11-17T02:00:00Z");
const rawText = (patch = {}) => ({
  id: "native-message", from: peer, to: own, toType: "USER", contentType: "NONE",
  text: "Synthetic incoming text", createdTime: String(timestamp), ...patch,
});

test("Personal direct messages keep account, thread and sender identity separate", async () => {
  const message = await personalTextMessage({}, rawText({ credential: "must-not-forward" }), own);
  assert.equal(message.provider, "line_personal");
  assert.equal(message.provider_account_id, own);
  assert.equal(message.conversation_id, peer);
  assert.equal(message.conversation_type, "user");
  assert.deepEqual(message.participant, { id: peer });
  assert.equal(message.sender_id, peer);
  assert.equal(message.recipient_id, own);
  assert.equal(message.recipient_account_id, own);
  assert.equal(message.sender_account_id, undefined);
  assert.equal(message.event_timestamp, new Date(timestamp).toISOString());
  assert.equal(message.capture_method, "realtime_socket");
  assert.ok(!JSON.stringify(message).includes("must-not-forward"));
});

test("outgoing Personal echoes target the peer conversation rather than the connected account", async () => {
  const message = await personalTextMessage({}, rawText({ from: own, to: peer }), own);
  assert.equal(message.conversation_id, peer);
  assert.equal(message.sender_account_id, own);
  assert.equal(message.recipient_account_id, undefined);
  assert.equal(message.sender_id, own);
  assert.equal(message.recipient_id, peer);
});

test("group and room events retain their actual sender and authenticated account membership", async () => {
  for (const toType of ["GROUP", "ROOM", 1, 2]) {
    const message = await personalTextMessage({}, rawText({ to: group, toType }), own);
    assert.equal(message.conversation_id, group);
    assert.equal(message.conversation_type, "group");
    assert.deepEqual(message.participant, { id: peer });
    assert.equal(message.sender_id, peer);
    assert.equal(message.recipient_id, group);
    assert.equal(message.recipient_account_id, own);
  }
});

test("encrypted text is decrypted before queuing and failures cannot fall back to raw plaintext", async () => {
  const raw = rawText({ chunks: [new Uint8Array([1])], text: "untrusted raw text" });
  let received;
  const base = { e2ee: { async decryptE2EETextMessage(value) { received = value; return ["Decrypted fixture", {}]; } } };
  const message = await personalTextMessage(base, raw, own, "history_recovery");
  assert.equal(received, raw);
  assert.equal(message.text, "Decrypted fixture");
  assert.equal(message.capture_method, "history_recovery");
  assert.equal(message.chunks, undefined);
  const failure = new Error("Synthetic key mismatch");
  await assert.rejects(personalTextMessage({ e2ee: { async decryptE2EETextMessage() { throw failure; } } }, raw, own), (error) => error === failure);
});

test("foreign direct conversations, unsupported content and malformed timestamps are not forwarded", async () => {
  const mustNotDecrypt = { e2ee: { async decryptE2EETextMessage() { throw new Error("Unexpected decryption"); } } };
  for (const raw of [
    rawText({ to: `u${"4".repeat(32)}`, chunks: [new Uint8Array([1])] }),
    rawText({ contentType: "IMAGE" }), rawText({ contentType: "FILE" }),
    rawText({ id: null }), rawText({ from: null }), rawText({ to: null }),
    rawText({ text: "" }), rawText({ createdTime: "invalid" }),
    rawText({ createdTime: 0 }), rawText({ createdTime: -1 }),
  ]) assert.equal(await personalTextMessage(mustNotDecrypt, raw, own), null);
  assert.equal(await personalTextMessage({}, rawText(), null), null);
});

test("text payload limits preserve native IDs and omit cryptographic metadata", async () => {
  const message = await personalTextMessage({}, rawText({ id: 123, contentType: 0,
    text: "x".repeat(20_001), contentMetadata: { accessToken: "must-not-forward" } }), own);
  assert.equal(message.id, "123");
  assert.equal(message.text.length, 20_000);
  assert.equal(message.contentMetadata, undefined);
});
