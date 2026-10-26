import assert from "node:assert/strict";
import test from "node:test";
import { createDeliveryScheduler } from "../extension/lib/delivery-scheduler.js";
const turn = () => new Promise(resolve => setImmediate(resolve));
test("delivery batches cap concurrency and give queued accounts the next slot", async () => {
  const scheduler = createDeliveryScheduler(2);
  const started = [];
  const finish = new Map();
  const batch = key => scheduler.run(() => new Promise(resolve => { started.push(key); finish.set(key, resolve); }));
  const a = batch("a"), b = batch("b"), c = batch("c");
  await turn();
  assert.deepEqual(started, ["a", "b"]);
  finish.get("a")(); await a;
  const nextA = batch("a-next");
  await turn();
  assert.deepEqual(started, ["a", "b", "c"]);
  finish.get("b")(); await b; await turn();
  assert.deepEqual(started, ["a", "b", "c", "a-next"]);
  finish.get("c")(); finish.get("a-next")();
  await Promise.all([c, nextA]);
});
test("failed delivery releases its slot", async () => {
  const scheduler = createDeliveryScheduler(1);
  await assert.rejects(scheduler.run(() => { throw new Error("offline"); }), /offline/);
  assert.equal(await scheduler.run(() => "next-account"), "next-account");
});
