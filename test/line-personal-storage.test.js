import assert from "node:assert/strict";
import { test } from "node:test";
import { personalSessionStorage } from "../extension/lib/line-personal-storage.js";

function sessionArea(initial = {}) {
  const values = structuredClone(initial);
  const calls = [];
  return {
    values, calls,
    async setAccessLevel(value) { calls.push({ operation: "access", value }); },
    async get(key) { calls.push({ operation: "get", key }); return { [key]: structuredClone(values[key]) }; },
    async set(patch) { calls.push({ operation: "set" }); Object.assign(values, structuredClone(patch)); },
  };
}

test("personal credentials are restricted to trusted session contexts before reading their scoped key", async () => {
  const area = sessionArea({
    "line_personal_session:account-a": { authToken: "fixture-token-a" },
    "line_personal_session:account-b": { authToken: "fixture-token-b" },
  });
  const a = await personalSessionStorage("account-a", area);
  const b = await personalSessionStorage("account-b", area);
  assert.deepEqual(area.calls[0], { operation: "access", value: { accessLevel: "TRUSTED_CONTEXTS" } });
  assert.deepEqual(area.calls[1], { operation: "get", key: "line_personal_session:account-a" });
  assert.equal(await a.get("authToken"), "fixture-token-a");
  assert.equal(await b.get("authToken"), "fixture-token-b");
  await a.set("authToken", "fixture-token-a-rotated");
  assert.equal(await b.get("authToken"), "fixture-token-b");
  assert.equal(area.values["line_personal_session:account-b"].authToken, "fixture-token-b");
});

test("concurrent key and token writes serialize without losing either credential", async () => {
  const area = sessionArea();
  const storage = await personalSessionStorage("account-a", area);
  const persist = area.set.bind(area);
  let release;
  let entered;
  const firstEntered = new Promise((resolve) => { entered = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  let writes = 0;
  area.set = async (patch) => {
    writes++;
    if (writes === 1) { entered(); await blocked; }
    await persist(patch);
  };
  const token = storage.set("authToken", "fixture-token");
  const key = storage.set("e2eeKeys:1", "fixture-key");
  await firstEntered;
  assert.equal(writes, 1);
  release();
  await Promise.all([token, key]);
  assert.deepEqual(await storage.getAll(), { authToken: "fixture-token", "e2eeKeys:1": "fixture-key" });
  assert.deepEqual(area.values["line_personal_session:account-a"], await storage.getAll());
});

test("a rejected persistence write does not poison later operations or replace the accepted token", async () => {
  const area = sessionArea({ "line_personal_session:account-a": { authToken: "accepted-fixture-token" } });
  const storage = await personalSessionStorage("account-a", area);
  const persist = area.set.bind(area);
  let failNext = true;
  area.set = async (patch) => {
    if (failNext) { failNext = false; throw new Error("Synthetic quota failure"); }
    await persist(patch);
  };
  const rejected = storage.set("authToken", "rejected-fixture-token");
  const recovered = storage.set("syncRevisions", { revision: 2 });
  await assert.rejects(rejected, /Synthetic quota failure/);
  await recovered;
  assert.equal(await storage.get("authToken"), "accepted-fixture-token");
  assert.deepEqual(await storage.get("syncRevisions"), { revision: 2 });
  assert.equal(area.values["line_personal_session:account-a"].authToken, "accepted-fixture-token");
});

test("clear follows pending writes and removes only the selected account session", async () => {
  const area = sessionArea({ "line_personal_session:account-b": { authToken: "other-fixture-token" } });
  const storage = await personalSessionStorage("account-a", area);
  const pending = storage.set("authToken", "discarded-fixture-token");
  const cleared = storage.clear();
  await Promise.all([pending, cleared]);
  assert.deepEqual(await storage.getAll(), {});
  assert.deepEqual(area.values["line_personal_session:account-a"], {});
  assert.deepEqual(area.values["line_personal_session:account-b"], { authToken: "other-fixture-token" });
  await storage.set("authToken", "new-fixture-token");
  await storage.delete("authToken");
  assert.deepEqual(await storage.getAll(), {});
});

test("missing session storage or failed trusted-context restriction fails closed", async () => {
  await assert.rejects(personalSessionStorage("account-a", null), /Trusted session storage is unavailable/);
  let read = false;
  await assert.rejects(personalSessionStorage("account-a", {
    async setAccessLevel() { throw new Error("Synthetic access restriction failure"); },
    async get() { read = true; return {}; },
  }), /Synthetic access restriction failure/);
  assert.equal(read, false);
});
