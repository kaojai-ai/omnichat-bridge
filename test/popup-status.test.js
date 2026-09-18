import assert from "node:assert/strict";
import test from "node:test";

import {
  latestSyncFailure,
  providerConnectionStatus,
  sellerCentreConnectionStatus,
} from "../extension/lib/popup-status.js";

const connected = {
  socket: "connected",
  provider_surface: "seller-centre",
};

test("separates a connected server from a provider that needs attention", () => {
  assert.deepEqual(
    providerConnectionStatus({
      socket: "connected",
      provider_recovery_state: "needs_attention",
      provider_recovery_reason: "The tracked provider tab was closed.",
    }),
    {
      label: "CONNECTED · ACTION REQUIRED",
      state: "warning",
      hint: "The tracked provider tab was closed.",
      action: "logs",
    },
  );
});

test("shows provider readiness independently from the live server socket", () => {
  assert.equal(
    providerConnectionStatus({ socket: "connected", provider_recovery_state: "ready" }).label,
    "CONNECTED · PROVIDER READY",
  );
  assert.equal(
    providerConnectionStatus({ socket: "connected" }).label,
    "CONNECTED · CHECKING PROVIDER",
  );
});

test("distinguishes a connected Seller Centre bridge before mini-chat is open", () => {
  assert.deepEqual(
    sellerCentreConnectionStatus({ ...connected, provider_surface_ready: false, provider_chat_open: false }),
    {
      label: "CONNECTED · OPEN CHAT",
      state: "warning",
      hint: "Connected to your server. Open Seller Centre Chat to start syncing.",
    },
  );
});

test("shows Seller Centre initialization separately after mini-chat opens", () => {
  assert.equal(
    sellerCentreConnectionStatus({ ...connected, provider_surface_ready: false, provider_chat_open: true }).label,
    "CONNECTED · INITIALIZING",
  );
});

test("lets an unhealthy Seller Centre recovery state override a stale surface label", () => {
  assert.equal(
    sellerCentreConnectionStatus({
      ...connected,
      provider_recovery_state: "needs_attention",
      provider_recovery_reason: "The bridge is unavailable.",
      provider_surface_ready: false,
      provider_chat_open: true,
    }).label,
    "CONNECTED · ACTION REQUIRED",
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

test("hides a sync error after a later successful activity", () => {
  assert.equal(
    latestSyncFailure([{
      sync_error: "Open LINE Official Account to sync messages.",
      sync_error_at: "2026-09-18T05:00:00.000Z",
      last_sync_at: "2026-09-18T05:10:00.000Z",
    }]),
    "",
  );
});

test("scopes the latest sync error to its provider account", () => {
  assert.equal(
    latestSyncFailure([{
      account_label: "LINE OA: Support",
      sync_error: "Open LINE Official Account to sync messages.",
      sync_error_at: "2026-09-18T05:00:00.000Z",
    }]),
    "Checking provider messages (LINE OA: Support) failed: Open LINE Official Account to sync messages.",
  );
});
