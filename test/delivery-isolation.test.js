import assert from "node:assert/strict";
import test from "node:test";

import { deliverWithIsolation } from "../extension/lib/delivery-isolation.js";

const message = (id) => ({ id });
const isScopedFailure = (error) => error?.server_error_code === "provider_account_not_participant";

test("isolates one message-scoped delivery failure", async () => {
  const messages = [message("good-1"), message("bad"), message("good-2")];
  const calls = [];
  const result = await deliverWithIsolation(
    messages,
    async (batch) => {
      calls.push(batch.map((item) => item.id));
      if (batch.some((item) => item.id === "bad")) {
        const error = new Error("Target server returned 403: provider_account_not_participant");
        error.server_error_code = "provider_account_not_participant";
        throw error;
      }
    },
    isScopedFailure,
  );

  assert.deepEqual(result.delivered.map((item) => item.id), ["good-1", "good-2"]);
  assert.deepEqual(result.failed.map(({ message: item }) => item.id), ["bad"]);
  assert.equal(result.blocked, null);
  assert.ok(calls.length > 1);
});

test("keeps server-skipped messages out of delivered messages", async () => {
  const messages = [message("skipped"), message("accepted")];
  const result = await deliverWithIsolation(
    messages,
    async () => ({ skipped: [messages[0]] }),
    isScopedFailure,
  );

  assert.deepEqual(result.delivered.map((item) => item.id), ["accepted"]);
  assert.deepEqual(result.skipped.map((item) => item.id), ["skipped"]);
  assert.deepEqual(result.failed, []);
  assert.equal(result.blocked, null);
});

test("does not split a non-message-scoped failure", async () => {
  const messages = [message("one"), message("two")];
  const calls = [];
  const result = await deliverWithIsolation(
    messages,
    async (batch) => {
      calls.push(batch);
      throw new TypeError("Failed to fetch.");
    },
    isScopedFailure,
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(result.delivered, []);
  assert.equal(result.failed.length, 0);
  assert.deepEqual(result.blocked.messages, messages);
  assert.match(result.blocked.error.message, /Failed to fetch/);
});
