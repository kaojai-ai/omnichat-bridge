import assert from "node:assert/strict";
import test from "node:test";

import {
  accountConnectionStatus,
  accountDiscoveryStatus,
  latestSyncFailure,
  currentAccountSyncFailure,
  transportConnectionStatus,
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
      state: "error",
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
      state: "neutral",
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

test("keeps the standalone New Webchat connected label", () => {
  assert.equal(sellerCentreConnectionStatus({ socket: "connected", provider_surface: "new-webchat" }), null);
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

test("connection recovery is visible independently from provider readiness", () => {
  assert.equal(transportConnectionStatus({ socket: "connecting" }).label, "CONNECTING");
  assert.equal(transportConnectionStatus({ socket: "reconnecting", provider_recovery_state: "ready" }).state, "neutral");
  assert.equal(transportConnectionStatus({ socket: "disconnected" }).action, "logs");
  assert.equal(transportConnectionStatus({ socket: "connected" }), null);
});


test("account discovery never claims missing configuration while still running", () => {
  for (const hasConfiguration of [true, false]) {
    assert.equal(accountDiscoveryStatus({ detecting: true, hasConfiguration }).label, "detectingShop");
  }
  assert.equal(accountDiscoveryStatus({ detecting: false, hasConfiguration: true }).label, "waitingForShop");
  assert.equal(accountDiscoveryStatus({ detecting: false, hasConfiguration: false }).action, "configure");
});

test("chat recovery is visible before the target socket connects", () => {
  assert.equal(accountConnectionStatus({ provider_recovery_state: "opening" }).label, "OPENING PROVIDER CHAT");
  assert.equal(accountConnectionStatus({ provider_recovery_state: "needs_attention" }).action, "logs");
});

test("captured request templates do not imply a healthy Shopee realtime connection", () => {
  const live = { ...connected, provider_surface_ready: true, provider_chat_open: true,
    provider_recovery_state: "ready", provider_realtime_connected: false };
  assert.equal(accountConnectionStatus(live).label, "WAITING FOR SHOPEE CONNECTION");
  assert.equal(accountConnectionStatus({ ...live, provider_realtime_connected: true }).state, "ready");
  assert.equal(accountConnectionStatus({ ...live, socket: "reconnecting" }).label, "RECOVERING CONNECTION");
});

test("server 404 takes precedence over Shopee login guidance and clears on connection", () => {
  const live = { socket: "reconnecting", endpoint_not_found: true,
    provider_recovery_state: "needs_attention", provider_recovery_reason: "Log in to Shopee" };
  const status = accountConnectionStatus(live);
  assert.equal(status.state, "error");
  assert.match(status.hint, /endpoint not found \(404\)/);
  assert.doesNotMatch(status.hint, /Log in/);
  assert.notEqual(accountConnectionStatus({ ...live, socket: "connected" }).label, status.label);
});


test("healthy provider does not hide a failed history sync or undelivered messages", () => {
  const state = { sync_error: "History request returned 401", sync_error_at: "2026-10-26T01:00:00Z" };
  assert.match(currentAccountSyncFailure(state, { provider_recovery_state: "ready" }), /History request returned 401/);
  assert.match(currentAccountSyncFailure({ ...state, delivery_error: "Target returned 503", delivery_error_at: "2026-10-26T01:01:00Z" }, { provider_recovery_state: "ready" }), /Sending queued messages/);
  assert.equal(currentAccountSyncFailure({ ...state, last_sync_at: "2026-10-26T01:02:00Z" }, { provider_recovery_state: "ready" }), "");
});

test("configured inactive Shopee shop offers a connection check instead of retrying sync", () => {
  const action = accountDiscoveryStatus({ detecting: false, hasConfiguration: true, inactiveShopee: true });
  assert.equal(action.action, "detect");
  assert.equal(action.label, "inactiveShop");
});

test("inactive account does not turn another shop's dashboard into retry state", () => {
  assert.equal(currentAccountSyncFailure({ sync_error: "Old shop failed" }, { active_in_profile: false }), "");
});

test("session uncertainty and revoked access never appear ready because a socket remains open", () => {
  const cases = {
    waiting_for_tab: ["OPEN PROVIDER CHAT", /Open this account's provider chat/],
    checking_session: ["CHECKING SESSION", /Commands are paused/],
    wrong_account: ["ACCOUNT NOT AVAILABLE", /current provider login/],
    needs_attention: ["SESSION NEEDS ATTENTION", /could not be verified/],
  };
  for (const [reason, [label, hint]] of Object.entries(cases)) {
    const view = accountConnectionStatus({ socket: "connected", provider_recovery_state: "ready", eligibility_reason_code: reason });
    assert.equal(view.label, label);
    assert.match(view.hint, hint);
    assert.notEqual(view.state, "ready");
  }
  assert.equal(accountConnectionStatus({ socket: "connected", provider_recovery_state: "ready", eligibility_reason_code: "ready" }).state, "ready");
});
