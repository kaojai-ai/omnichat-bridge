import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createPersonalProfiles } from "../extension/lib/line-personal-profiles.js";
import { participantForBatch } from "../extension/lib/message-batch.js";
const own = `u${"1".repeat(32)}`;
const peer = `u${"2".repeat(32)}`;
const second = `u${"3".repeat(32)}`;
const message = (id = peer) => ({ sender_id: id, participant: { id }, conversation_id: peer });

test("native contact metadata enriches the incoming participant and omits private fields", async () => {
 const profiles = createPersonalProfiles({ loadContact: async mid => ({ mid, displayName: " Native name ", pictureStatus: "avatar/token", statusMessage: "private", accessToken: "private" }) });
 const result = await profiles.enrich(message(), own);
 assert.deepEqual(result.participant, { id: peer, display_name: "Native name", avatar_url: "https://profile.line-scdn.net/avatar/token" });
 assert.ok(!JSON.stringify(result).includes("private"));
});
test("direct HTTPS picturePath is preserved; malformed and missing avatars are omitted", async () => {
 for (const picturePath of ["https://profile.line-scdn.net/avatar", "javascript:bad", "http://insecure", `https://profile.line-scdn.net/${"x".repeat(2_000)}`, null]) {
  const profiles = createPersonalProfiles({ loadContact: async mid => ({ mid, displayName: "Name", picturePath }) });
  assert.equal((await profiles.enrich(message(), own)).participant.avatar_url, picturePath?.startsWith("https:") && picturePath.length <= 2_000 ? picturePath : undefined);
 }
});
test("cache expires, remains bounded and never crosses connection instances", async () => {
 let now = 0, calls = 0;
 const loadContact = async mid => { calls++; return { mid, displayName: "Name" }; };
 const profiles = createPersonalProfiles({ loadContact, now: () => now, ttlMs: 20, maxEntries: 1 });
 await profiles.enrich(message(), own); await profiles.enrich(message(), own); assert.equal(calls, 1);
 now = 21; await profiles.enrich(message(), own); assert.equal(calls, 2);
 await profiles.enrich(message(second), own); await profiles.enrich(message(), own); assert.equal(calls, 4);
 await createPersonalProfiles({ loadContact }).enrich(message(), own); assert.equal(calls, 5);
});
test("concurrent lookups coalesce and failures are negatively cached", async () => {
 let calls = 0;
 const profiles = createPersonalProfiles({ loadContact: async () => { calls++; throw new Error("private failure"); } });
 const results = await Promise.all([profiles.enrich(message(), own), profiles.enrich(message(), own)]);
 await profiles.enrich(message(), own); assert.equal(calls, 1);
 assert.deepEqual(results[0].participant, { id: peer });
});
test("timeout aborts only metadata lookup and still returns the incoming ID", async () => {
 let signal;
 const profiles = createPersonalProfiles({ timeoutMs: 5, loadContact: async (_mid, supplied) => { signal = supplied; return new Promise(() => {}); } });
 assert.deepEqual((await profiles.enrich(message(), own)).participant, { id: peer });
 assert.equal(signal.aborted, true);
});
test("never fetches own outgoing account/group target or trusts another contact identity", async () => {
 let calls = 0;
 const profiles = createPersonalProfiles({ loadContact: async () => { calls++; return { mid: second, displayName: "Wrong" }; } });
 const outgoing = { sender_id: own, participant: { id: `c${"4".repeat(32)}` } };
 assert.equal(await profiles.enrich(outgoing, own), outgoing);
 assert.equal(await profiles.enrich(null, own), null); assert.equal(calls, 0);
 assert.deepEqual((await profiles.enrich(message(), own)).participant, { id: peer });
});
test("Personal groups keep both senders' metadata in one shared batch", () => {
 const source = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
 const start = source.indexOf("function batchFor(");
 const end = source.indexOf("\nfunction selectBatchMessages", start);
 const context = vm.createContext({ participantForBatch, messageProvider: m => m.provider,
 providerAdapterForId: id => ({ id }), crypto: { randomUUID: () => "batch" }, chrome: { runtime: { getManifest: () => ({ version: "test" }) } } });
 vm.runInContext(`${source.slice(start, end)}; globalThis.batch = batchFor;`, context);
 const messages = [peer, second].map(id => ({ provider: "line_personal", conversation_id: "group", sender_id: id, participant: { id, display_name: id === peer ? "First" : "Second" } }));
 messages[0].conversation_avatar_url = "https://profile.line-scdn.net/group/photo";
 messages[1].conversation_name = "Group name";
 const batch = context.batch(messages, "installation");
 assert.equal(batch.conversations[0].display_name, "Group name");
 assert.equal(batch.conversations[0].avatar_url, "https://profile.line-scdn.net/group/photo");
 assert.equal(batch.conversations[0].participants.length, 2);
 assert.equal(batch.conversations[0].participants[1].display_name, "Second");
});

test("group names come from the matching chat while sender profiles stay independent", async () => {
 const group = `c${"3".repeat(32)}`;
 let chatCalls = 0;
 const profiles = createPersonalProfiles({
  loadContact: async mid => ({ mid, displayName: "Sender" }),
  loadChat: async chatMid => { chatCalls++; return { chatMid, chatName: " Group name ", picturePath: "/group/photo" }; },
 });
 const input = { provider: "line_personal", conversation_id: group, conversation_type: "group", sender_id: peer, participant: { id: peer } };
 const result = await profiles.enrich(input, own);
 assert.equal(result.conversation_name, "Group name");
 assert.equal(result.conversation_avatar_url, "https://profile.line-scdn.net/group/photo");
 assert.deepEqual(result.participant, { id: peer, display_name: "Sender" });
 assert.equal((await profiles.enrich({ ...input, sender_id: own }, own)).conversation_name, "Group name");
 assert.equal(chatCalls, 1);
});

test("a failed or mismatched group lookup never blocks or misnames a message", async () => {
 const group = `c${"3".repeat(32)}`;
 const input = { conversation_id: group, conversation_type: "group", sender_id: peer, participant: { id: peer } };
 for (const loadChat of [async () => { throw new Error("unavailable"); }, async () => ({ chatMid: "other", chatName: "Wrong", picturePath: "/wrong" })]) {
  const profiles = createPersonalProfiles({ loadContact: async mid => ({ mid, displayName: "Sender" }), loadChat });
  const result = await profiles.enrich(input, own);
  assert.equal(result.conversation_name, undefined);
  assert.equal(result.conversation_avatar_url, undefined);
  assert.equal(result.participant.display_name, "Sender");
 }
});
