import assert from "node:assert/strict";
import test from "node:test";
import { createMetadataCache } from "../extension/lib/metadata-cache.js";

function fixture({ stored, load, save } = {}) {
  const writes = [];
  const timers = new Map();
  let clock = 1_000;
  let loads = 0;
  const cache = createMetadataCache({
    load: async () => { loads += 1; return load ? load() : stored; },
    save: async (value) => { if (save) await save(value); writes.push(structuredClone(value)); },
    now: () => clock++,
    setTimer: (callback) => { timers.set(callback, callback); return callback; },
    clearTimer: (callback) => timers.delete(callback),
  });
  return { cache, writes, timers, loads: () => loads };
}

function message(overrides = {}) {
  return {
    conversation_id: "conversation", provider_account_id: "shop", id: "message",
    participant: { id: "customer", display_name: "First name", avatar_url: "https://example.com/first.png" },
    omnichat: { routing: { fields: { to_id: "recipient" } } },
    ...overrides,
  };
}

test("metadata survives hydration without persisting message content or access evidence", async () => {
  const first = fixture();
  const original = message({ text: "private message", ready: true });
  await first.cache.enrich("tenant:shopee:shop", original);
  await first.cache.flush();
  const stored = first.writes.at(-1);
  assert.deepEqual(Object.keys(stored.records[0]).sort(),
    ["scope", "conversation_id", "id", "provider_account_id", "display_name", "avatar_url", "updated_at"].sort());
  const second = fixture({ stored });
  const result = await second.cache.enrich("tenant:shopee:shop", message({
    participant: { id: "customer", display_name: "New provider name", avatar_url: "https://example.com/new.png", role: "customer" },
  }));
  assert.equal(result.participant.display_name, "First name");
  assert.equal(result.participant.avatar_url, "https://example.com/first.png");
  assert.equal(result.participant.role, "customer");
  assert.deepEqual(result.omnichat, original.omnichat);
  assert.equal(second.writes.length, 0);
});

test("normal processing fills missing fields without overwriting known values or causing repeat writes", async () => {
  const f = fixture();
  await f.cache.enrich("scope", message({ participant: { id: "customer", display_name: "Cached" } }));
  const filled = await f.cache.enrich("scope", message());
  assert.equal(filled.participant.display_name, "Cached");
  assert.equal(filled.participant.avatar_url, "https://example.com/first.png");
  await f.cache.flush();
  const savedAt = f.writes.at(-1).records[0].updated_at;
  for (let i = 0; i < 20; i++) await f.cache.enrich("scope", message());
  await f.cache.flush();
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].records[0].updated_at, savedAt);
  assert.equal(f.timers.size, 0);
});

test("manual refresh overwrites returned display values and preserves omitted fields", async () => {
  const f = fixture();
  await f.cache.enrich("scope", message());
  const count = await f.cache.refresh("scope", [
    { conversation_id: "conversation", id: "customer", display_name: "Refreshed" },
    { conversation_id: "conversation", id: "customer", display_name: "Refreshed" },
    { conversation_id: "invalid", id: "invalid", display_name: "" },
  ]);
  const result = await f.cache.enrich("scope", message());
  assert.equal(count, 1);
  assert.equal(result.participant.display_name, "Refreshed");
  assert.equal(result.participant.avatar_url, "https://example.com/first.png");
});

test("tenant, provider account, conversation, and customer identity remain isolated", async () => {
  const f = fixture();
  await f.cache.enrich("tenant-a:shopee:shop", message());
  for (const [scope, overrides] of [
    ["tenant-b:shopee:shop", {}],
    ["tenant-a:line:shop", {}],
    ["tenant-a:shopee:other-shop", {}],
    ["tenant-a:shopee:shop", { conversation_id: "other-conversation" }],
    ["tenant-a:shopee:shop", { participant: { id: "other-customer", display_name: "Independent" } }],
  ]) {
    const result = await f.cache.enrich(scope, message({ participant: { id: "customer", display_name: "Independent" }, ...overrides }));
    assert.equal(result.participant.display_name, "Independent");
  }
  await f.cache.flush();
  assert.equal(f.writes.at(-1).records.length, 6);
});

test("concurrent callers share hydration and batch writes", async () => {
  let releaseLoad;
  const f = fixture({ load: () => new Promise((resolve) => { releaseLoad = resolve; }) });
  const calls = [f.cache.enrich("one", message()), f.cache.enrich("two", message())];
  await Promise.resolve();
  assert.equal(f.loads(), 1);
  releaseLoad(undefined);
  await Promise.all(calls);
  assert.equal(f.timers.size, 1);
  await f.cache.flush();
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].records.length, 2);
});

test("updates arriving during a save are persisted without concurrent saves", async () => {
  let releaseSave;
  let saves = 0;
  const f = fixture({ save: async () => {
    if (++saves === 1) await new Promise((resolve) => { releaseSave = resolve; });
  } });
  await f.cache.enrich("scope", message());
  const flushing = f.cache.flush();
  while (!releaseSave) await Promise.resolve();
  await f.cache.refresh("scope", [{ conversation_id: "conversation", id: "customer", display_name: "During save" }]);
  const concurrentFlush = f.cache.flush();
  assert.equal(saves, 1);
  releaseSave();
  await Promise.all([flushing, concurrentFlush]);
  assert.equal(saves, 2);
  assert.equal(f.writes.at(-1).records[0].display_name, "During save");
});

test("failed save retains dirty state for explicit retry", async () => {
  let failing = true;
  const f = fixture({ save: async () => { if (failing) throw new Error("Storage unavailable"); } });
  await f.cache.enrich("scope", message());
  await assert.rejects(f.cache.flush(), /Storage unavailable/);
  assert.equal(f.writes.length, 0);
  failing = false;
  await f.cache.flush();
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].records[0].display_name, "First name");
});

test("failed hydration keeps enrichment advisory and never overwrites unread persisted data", async () => {
  const f = fixture({ load: async () => { throw new Error("Cannot read storage"); } });
  const first = await f.cache.enrich("scope", message());
  assert.equal(first.participant.display_name, "First name");
  const cached = await f.cache.enrich("scope", message({ participant: { id: "customer", display_name: "Later" } }));
  assert.equal(cached.participant.display_name, "First name");
  assert.equal(f.loads(), 1);
  assert.equal(f.timers.size, 0);
  await assert.rejects(f.cache.flush(), /Cannot read storage/);
  assert.equal(f.writes.length, 0);
});

test("metadata field bounds use UTF-8 and reject unsafe avatars or oversized identities", async () => {
  const f = fixture();
  await f.cache.refresh("scope", [
    { conversation_id: "conversation", id: "customer", display_name: "ก".repeat(200), avatar_url: "http://example.com/avatar" },
    { conversation_id: "oversized", id: "a".repeat(513), display_name: "Ignored" },
    { conversation_id: "credentials", id: "other", avatar_url: "https://user:secret@example.com/avatar" },
  ]);
  await f.cache.flush();
  const saved = f.writes.at(-1).records;
  assert.equal(saved.length, 1);
  assert.ok(new TextEncoder().encode(saved[0].display_name).length <= 256);
  assert.equal(saved[0].avatar_url, undefined);
});

test("per-account eviction keeps recently refreshed entries and never renews on reads", async () => {
  const f = fixture();
  const profiles = Array.from({ length: 1_000 }, (_, i) => ({ conversation_id: String(i), id: String(i), display_name: String(i) }));
  await f.cache.refresh("scope", profiles);
  await f.cache.enrich("scope", message({ conversation_id: "1", participant: { id: "1", display_name: "ignored" } }));
  await f.cache.refresh("scope", [{ ...profiles[0], display_name: "Refreshed first" }]);
  await f.cache.refresh("scope", [{ conversation_id: "new", id: "new", display_name: "new" }]);
  await f.cache.flush();
  const saved = f.writes.at(-1).records;
  assert.equal(saved.length, 1_000);
  assert.equal(saved.some((row) => row.id === "0" && row.display_name === "Refreshed first"), true);
  assert.equal(saved.some((row) => row.id === "1"), false);
});

test("installation count remains bounded across accounts", async () => {
  const f = fixture();
  for (let account = 0; account < 6; account++) {
    await f.cache.refresh(`scope-${account}`, Array.from({ length: 1_000 }, (_, i) => ({
      conversation_id: String(i), id: String(i), display_name: "Customer",
    })));
  }
  await f.cache.flush();
  const saved = f.writes.at(-1).records;
  assert.equal(saved.length, 5_000);
  assert.equal(saved.some((row) => row.scope === "scope-0"), false);
});

test("encoded storage budget bounds large records and evicts oldest", async () => {
  const f = fixture();
  const avatar = `https://example.com/${"a".repeat(1_900)}`;
  for (let account = 0; account < 3; account++) {
    await f.cache.refresh(`scope-${account}`, Array.from({ length: 700 }, (_, i) => ({
      conversation_id: String(i), id: String(i), display_name: "Customer", avatar_url: avatar,
    })));
  }
  await f.cache.flush();
  const saved = f.writes.at(-1);
  assert.ok(new TextEncoder().encode(JSON.stringify(saved)).length <= 2 * 1024 * 1024);
  assert.ok(saved.records.length < 2_100);
  assert.equal(saved.records.some((row) => row.scope === "scope-0"), false);
  assert.equal(saved.records.some((row) => row.scope === "scope-2"), true);
});

test("hydration enforces limits and strips invalid or non-metadata fields", async () => {
  const f = fixture({ stored: { version: 1, records: [
    ...Array.from({ length: 1_001 }, (_, i) => ({ scope: "scope", conversation_id: String(i), id: String(i),
      display_name: "Customer", updated_at: i, ready: true, token: "not persisted" })),
    { scope: "scope", conversation_id: "bad", id: "bad", avatar_url: "javascript:alert(1)", updated_at: 0 },
  ] } });
  await f.cache.flush();
  const saved = f.writes.at(-1).records;
  assert.equal(saved.length, 1_000);
  assert.equal(saved.some((row) => row.id === "0"), false);
  assert.ok(saved.every((row) => !("ready" in row) && !("token" in row)));
});

test("dispose fences a pending load and prevents delayed hydration or new operations from persisting", async () => {
  let releaseLoad;
  const f = fixture({ load: () => new Promise((resolve) => { releaseLoad = resolve; }) });
  const original = message();
  const enriching = f.cache.enrich("scope", original);
  while (!releaseLoad) await Promise.resolve();
  let disposed = false;
  const disposing = f.cache.dispose().then(() => { disposed = true; });
  await Promise.resolve();
  assert.equal(disposed, false);
  assert.equal(await f.cache.refresh("scope", [{ conversation_id: "new", id: "new", display_name: "New" }]), 0);
  releaseLoad({ version: 1, records: [{ scope: "scope", conversation_id: "conversation", id: "customer",
    display_name: "Old persisted name", updated_at: 1 }] });
  await disposing;
  assert.equal(await enriching, original);
  assert.equal(await f.cache.enrich("scope", original), original);
  await f.cache.flush();
  assert.equal(f.timers.size, 0);
  assert.equal(f.writes.length, 0);
});

test("dispose cancels pending persistence and ignores a timer callback already queued", async () => {
  const f = fixture();
  await f.cache.enrich("scope", message());
  const callback = [...f.timers.values()][0];
  assert.equal(typeof callback, "function");
  await f.cache.dispose();
  assert.equal(f.timers.size, 0);
  callback();
  await f.cache.flush();
  assert.equal(f.writes.length, 0);
});

test("dispose drains an in-flight save before data can be cleared and never starts the dirty follow-up save", async () => {
  let releaseSave;
  const f = fixture({ save: () => new Promise((resolve) => { releaseSave = resolve; }) });
  await f.cache.enrich("scope", message());
  const flushing = f.cache.flush();
  while (!releaseSave) await Promise.resolve();
  await f.cache.refresh("scope", [{ conversation_id: "new", id: "new", display_name: "Queued during save" }]);
  let disposed = false;
  const disposing = f.cache.dispose().then(() => { disposed = true; });
  await Promise.resolve();
  assert.equal(disposed, false);
  releaseSave();
  await Promise.all([flushing, disposing]);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].records.length, 1);
  await f.cache.flush();
  await f.cache.refresh("scope", [{ conversation_id: "later", id: "later", display_name: "Later" }]);
  await f.cache.flush();
  assert.equal(f.writes.length, 1);
});
