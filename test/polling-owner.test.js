import test from "node:test";
import assert from "node:assert/strict";
import { createPollingOwner } from "../extension/lib/polling-owner.js";

function fixture() {
  const stored = new Map();
  const events = [];
  let candidates = [{ id: 1 }, { id: 2 }];
  const options = {
    load: async context => stored.get(context.key),
    save: async (context, owner) => { events.push(`save:${owner.tab_id}`); stored.set(context.key, owner); },
    tabs: async () => [...candidates],
    verify: async () => ({ ready: true }),
    contextOf: (_context, tab) => `epoch:${tab.id}`,
    beforeHandover: async (_context, previous) => { events.push(`stop:${previous.tab_id}`); },
  };
  return { options, stored, events, setTabs: tabs => { candidates = tabs; } };
}

test("concurrent polling starts and worker restarts retain one owner per account", async () => {
  const { options, stored } = fixture();
  const owner = createPollingOwner(options);
  const context = { key: "account" };
  const first = owner.select(context, { id: 1 });
  const second = owner.select(context, { id: 2 });
  assert.equal(first, second);
  assert.equal((await first).tab.id, 1);
  assert.equal((await createPollingOwner(options).select(context, { id: 2 })).tab.id, 1);
  assert.equal((await owner.select({ key: "other" }, { id: 2 })).tab.id, 2);
  assert.equal(stored.size, 2);
});

test("handover stops the old owner before granting its verified replacement", async () => {
  const { options, events, setTabs } = fixture();
  let verified = 1;
  options.verify = async (_context, tab) => tab.id === verified ? {} : null;
  const owner = createPollingOwner(options);
  const context = { key: "account" };
  await owner.select(context);
  verified = 2;
  await owner.select(context);
  assert.deepEqual(events, ["save:1", "stop:1", "save:2"]);
  assert.equal(owner.isCurrent(context.key, 1, "epoch:1"), false);
  assert.equal(owner.isCurrent(context.key, 2, "epoch:2"), true);
  setTabs([]);
  await assert.rejects(owner.select(context), /No verified/);
});

test("failed handover never grants a competing polling owner", async () => {
  const { options, stored } = fixture();
  const context = { key: "account" };
  stored.set(context.key, { tab_id: 1 });
  options.verify = async (_context, tab) => tab.id === 2 ? {} : null;
  options.beforeHandover = async () => { throw new Error("Sync still running"); };
  await assert.rejects(createPollingOwner(options).select(context), /Sync still running/);
  assert.equal(stored.get(context.key).tab_id, 1);
});

test("navigation during verification cannot grant stale ownership", async () => {
  const { options } = fixture();
  let epoch = 1;
  options.contextOf = () => epoch;
  options.verify = async () => { epoch++; return {}; };
  await assert.rejects(createPollingOwner(options).select({ key: "account" }), /No verified/);
});
