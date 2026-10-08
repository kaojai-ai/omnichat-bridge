import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../extension/shopee-realtime.js", import.meta.url), "utf8");
const start = source.indexOf("  let socketProfileRefresh = null;");
const end = source.indexOf("  const sellerCentreHistoryRequest", start);
function setup(fetch) {
  const captured = [];
  const errors = [];
  const state = {
    listTemplate: { url: "https://seller.shopee.co.th/webchat/api/v1.2/conversations", init: { credentials: "include" } },
    profilesByConversation: new Map(),
    recoveryEpoch: 0,
    nativeFetch: fetch,
  };
  const refresh = vm.runInNewContext(`${source.slice(start, end)}; refreshSocketProfiles`, {
    state, Request, AbortSignal, SELLER_CENTRE_POLL_INTERVAL_MS: 3000,
    isBridgeActive: () => true, conversationItems: (body) => body,
    captureProfiles: (profiles) => captured.push(profiles),
    logAsyncError: (_event, error) => errors.push(error),
  });
  return { refresh, state, captured, errors };
}
const messages = [{ conversation_id: "chat-1" }];

test("refreshes an ID-only cached profile before forwarding and shares concurrent lookup", async () => {
  let calls = 0;
  let finish;
  const bridge = setup(async (request) => {
    calls++;
    assert.equal(request.credentials, "include");
    assert.ok(request.signal);
    await new Promise((resolve) => { finish = resolve; });
    return { ok: true, json: async () => [{ id: "chat-1", to_name: "Buyer" }] };
  });
  bridge.state.profilesByConversation.set("chat-1", { id: "buyer" });
  const first = bridge.refresh(messages);
  const second = bridge.refresh(messages);
  finish();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(bridge.captured[0][0].to_name, "Buyer");
});

test("known names avoid profile requests", async () => {
  const bridge = setup(() => assert.fail("unnecessary lookup"));
  bridge.state.profilesByConversation.set("chat-1", { display_name: "Buyer" });
  await bridge.refresh(messages);
  assert.equal(bridge.captured.length, 0);
});

test("lookup failures allow delivery and throttle repeated missing profiles", async () => {
  let calls = 0;
  const bridge = setup(async () => { calls++; throw new Error("timeout"); });
  await bridge.refresh(messages);
  await bridge.refresh(messages);
  assert.equal(calls, 1);
  assert.equal(bridge.errors.length, 1);
});

test("a shop reset discards the old lookup response", async () => {
  const bridge = setup(async () => {
    bridge.state.recoveryEpoch++;
    return { ok: true, json: async () => [{ id: "chat-1", to_name: "Wrong shop" }] };
  });
  await bridge.refresh(messages);
  assert.equal(bridge.captured.length, 0);
});
