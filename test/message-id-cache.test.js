import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
const source = await readFile(new URL("../extension/lib/message-id-cache.js", import.meta.url), "utf8");
const context = vm.createContext({});
vm.runInContext(source, context);
const create = context.OmnichatMessageIdCache.create;

test("cache enforces conversation, account and instance limits in insertion order", () => {
  const cache = create({ perConversation: 2, perAccount: 3, maxEntries: 4 });
  const add = (account, chat, id) => cache.add("line", account, chat, id);
  add("a", "chat", "1"); add("a", "chat", "2");
  assert.equal(cache.has("line", "a", "chat", "1"), true);
  add("a", "chat", "3");
  assert.equal(cache.has("line", "a", "chat", "1"), false, "reads do not refresh order");
  add("a", "other", "4"); add("a", "other", "5");
  assert.equal(cache.has("line", "a", "chat", "2"), false);
  add("b", "chat", "6"); add("b", "chat", "7");
  assert.equal(cache.size, 4);
  assert.equal(cache.has("line", "a", "chat", "3"), false);
});
test("IDs are scoped, scoped clear preserves other accounts, repeated IDs do not grow memory", () => {
  const cache = create();
  for (const provider of ["shopee", "line"]) for (const account of ["a", "b"]) {
    for (let repeat = 0; repeat < 10; repeat++) cache.add(provider, account, "chat", "1");
  }
  assert.equal(cache.size, 4);
  cache.clear("line", "a");
  assert.equal(cache.size, 3);
  assert.equal(cache.has("shopee", "a", "chat", "1"), true);
  cache.clear("shopee");
  assert.equal(cache.size, 1);
  cache.clear();
  assert.equal(cache.size, 0);
  cache.add("line", "a", "chat", "1");
  assert.equal(cache.size, 1, "cleared indexes can be reused");
});
test("long synthetic workload remains bounded with empty scopes evicted", () => {
  const cache = create();
  for (let account = 0; account < 4; account++) {
    for (let message = 0; message < 12_000; message++) cache.add("line", String(account), String(message % 60), String(message));
  }
  assert.equal(cache.size, 20_000);
  assert.equal(cache.has("line", "0", "0", "0"), false);
  cache.clear("line", "3");
  assert.equal(cache.size, 10_000);
});
