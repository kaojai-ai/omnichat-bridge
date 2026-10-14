import assert from "node:assert/strict";
import test from "node:test";
import { withRequestTimeout } from "../extension/lib/request-timeout.js";

test("a hung operation is bounded even if it ignores cancellation", async () => {
  let requestSignal;
  await assert.rejects(withRequestTimeout((signal) => {
    requestSignal = signal;
    return new Promise(() => {});
  }, 5), { name: "TimeoutError" });
  assert.equal(requestSignal.aborted, true);
});

test("caller cancellation releases a request without waiting for its timeout", async () => {
  const controller = new AbortController();
  const request = withRequestTimeout(() => new Promise(() => {}), 60_000, controller.signal);
  controller.abort(new Error("sync cancelled"));
  await assert.rejects(request, /sync cancelled/);
});

test("already cancelled operations never start", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  let called = false;
  await assert.rejects(withRequestTimeout(() => { called = true; }, 60_000, controller.signal), /cancelled/);
  assert.equal(called, false);
});
