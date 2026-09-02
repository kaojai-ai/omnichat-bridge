import assert from "node:assert/strict";
import test from "node:test";

import { sellerCentreConnectionStatus } from "../extension/lib/popup-status.js";

const connected = {
  socket: "connected",
  provider_surface: "seller-centre",
};

test("distinguishes a connected Seller Centre bridge before mini-chat is open", () => {
  assert.deepEqual(
    sellerCentreConnectionStatus({ ...connected, provider_surface_ready: false, provider_chat_open: false }),
    {
      label: "CONNECTED · OPEN CHAT",
      state: "warning",
      hint: "Connected to KaoJai. Open Seller Centre Chat to start syncing.",
    },
  );
});

test("shows Seller Centre initialization separately after mini-chat opens", () => {
  assert.equal(
    sellerCentreConnectionStatus({ ...connected, provider_surface_ready: false, provider_chat_open: true }).label,
    "CONNECTED · INITIALIZING",
  );
});

test("shows a ready Seller Centre chat after its request templates are captured", () => {
  assert.deepEqual(
    sellerCentreConnectionStatus({ ...connected, provider_surface_ready: true, provider_chat_open: true }),
    {
      label: "CONNECTED · CHAT READY",
      state: "ready",
      hint: "Seller Centre Chat is ready and syncing can continue automatically.",
    },
  );
});

test("does not change the legacy connected label", () => {
  assert.equal(sellerCentreConnectionStatus({ socket: "connected", provider_surface: "legacy" }), null);
});
