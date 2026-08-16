import assert from "node:assert/strict";
import test from "node:test";

import { participantForBatch } from "../extension/lib/message-batch.js";

test("strips local routing metadata from outbound participants", () => {
  assert.deepEqual(
    participantForBatch({
      id: "buyer-1",
      display_name: "Buyer",
      avatar_url: "https://example.com/avatar.jpg",
      provider_account_id: "1549058683",
    }),
    {
      id: "buyer-1",
      display_name: "Buyer",
      avatar_url: "https://example.com/avatar.jpg",
    },
  );
});

test("does not create an outbound participant without an ID", () => {
  assert.equal(participantForBatch({ display_name: "Buyer" }), null);
});
