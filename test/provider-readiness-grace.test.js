import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { installProviderPolicy } from "./helpers/provider-policy.js";
import { createSessionEligibility } from "../extension/lib/session-eligibility.js";
import { withRequestTimeout } from "../extension/lib/request-timeout.js";
import { createReplyQueue } from "../extension/lib/reply-queue.js";
import { sanitizeSendDiagnostics } from "../extension/lib/logs.js";
import { buildConnectionHealth } from "../extension/lib/connection-status.js";
import "../extension/lib/shopee-url.js";
import "../extension/lib/provider-adapters.js";
import "../extension/lib/shopee-adapter.js";
import "../extension/lib/line-oa.js";
const source = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
const part = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
function fixture(provider = "shopee") {
  let now = 100_000;
  let result;
  let probes = 0;
  let resolveInstallation;
  let installation = Promise.resolve("installation");
  const events = [];
  const timerCallbacks = [];
  const adapter = globalThis.OmnichatProviderAdapters.get(provider);
  const context = { key: `${provider}:shop`, adapter, account: { provider, provider_account_id: "shop" } };
  const tab = { id: 1, url: provider === "shopee" ? "https://seller.shopee.co.th/new-webchat/conversations" : "https://chat.line.biz/" };
  let tabs = [tab];
  const closed = [];
  const policy = createSessionEligibility({ now: () => now, setTimer: (callback, delay) => { timerCallbacks.push({ callback, at: now + delay }); return callback; },
    clearTimer: () => {}, onEvent: (_key, event, details) => events.push({ event, ...details }) });
  const scope = vm.createContext({
    Date: class extends Date { static now() { return now; } },
    sessionEligibility: policy, providerAdapters: globalThis.OmnichatProviderAdapters,
    providerChatTabs: async () => tabs, providerLabel: () => provider,
    sendProviderMessage: async () => { probes++; return result; }, PROVIDER_STATUS_RESPONSE_TIMEOUT_MS: 5000, PROVIDER_HEALTH_STALE_MS: 60_000,
    STORAGE: {}, readStorage: async () => ({}), readAccountState: (_state, _key, fallback) => fallback,
    normalizeDeviceName: () => "", buildConnectionHealth, persistProviderSurfaceState: async () => {},
    canonicalProviderAccountId: () => "shop", installationId: () => installation,
    chrome: { runtime: { getPlatformInfo: async () => ({ os: "mac" }), getManifest: () => ({ version: "test" }) } },
    activeSyncControl: null, providerAutomaticRecoveries: new Map(), lineTabSyncs: new Map(),
    liveConnections: new Map(), stopAccountLiveConnection: (key, _connection, reason) => { closed.push({ key, reason }); scope.liveConnections.delete(key); },
    rememberCommandTab: async () => {},
  });
  installProviderPolicy(scope);
  vm.runInContext(part("function orderProviderTabs(", "async function providerTabStatus(")
    + part("function providerTabIsReady(", "async function isReadyProviderTab(")
    + part("async function providerTabStatus(", "function providerTabIsReady(")
    + part("async function connectionStatusSnapshot(", "function statusPublishKey(")
    + part("async function selectSendContext(", "function providerAdapterForCommand(")
    + part("function invalidateProviderSession(", "chrome.tabs.onUpdated.addListener"), scope);
  const healthy = provider === "shopee"
    ? { ok: true, current_provider_account_id: "shop", surface_ready: true, realtime_connected: true,
      capabilities: Object.fromEntries(["account_detection", "message_observation", "message_recovery", "send_text", "send_image", "send_product"].map((key) => [key, true])) }
    : { ok: true, account_access_verified: true, accessible_account_ids: ["shop"], realtime_connected: true,
      command_capabilities_by_account: { shop: ["send_text", "send_image"] } };
  result = healthy;
  return { scope, policy, context, tab, healthy, closed, events, timerCallbacks,
    set result(value) { result = value; }, set now(value) { now = value; }, set tabs(value) { tabs = value; },
    get probes() { return probes; },
    assess: () => scope.providerReadiness(context), snapshot: () => scope.connectionStatusSnapshot(context),
    select: () => scope.commandTab(context, { prepareForSend: true }),
    deferInstallation() { installation = new Promise((resolve) => { resolveInstallation = resolve; }); },
    finishInstallation() { resolveInstallation("installation"); },
  };
}
for (const provider of ["shopee", "line_oa"]) {
  test(`${provider}: missing response has fixed 30s grace, restores same generation, and warns only at60s`, async () => {
    const h = fixture(provider);
    const ready = await h.assess();
    assert.equal(ready.eligible, true);
    h.result = null;
    const grace = await h.snapshot();
    assert.equal(grace.ready, true);
    assert.equal(grace.reason_code, "provider_check_grace");
    assert.equal(grace.readiness_grace_expires_at, new Date(130_000).toISOString());
    assert.equal((await h.select()).id, h.tab.id, "command preflight consumes the same recent evidence");
    h.now = 129_999;
    assert.equal((await h.snapshot()).readiness_grace_expires_at, grace.readiness_grace_expires_at);
    h.result = h.healthy;
    const recovered = await h.snapshot();
    assert.equal(recovered.ready, true);
    assert.equal(recovered.readiness_grace_expires_at, undefined);
    assert.equal(h.policy.generation(h.context.key), ready.generation);
    h.result = null;
    await h.assess();
    h.now = 160_000;
    const expired = await h.snapshot();
    assert.equal(expired.ready, false);
    assert.equal(expired.reason_code, "checking_session");
    assert.equal(expired.readiness_grace_expires_at, undefined);
    assert.notEqual(h.policy.generation(h.context.key), ready.generation);
    await assert.rejects(h.select(), /not ready/);
    assert.equal(h.policy.state(h.context.key).retain_transport, true);
    h.now = 190_000;
    assert.equal((await h.snapshot()).reason_code, "needs_attention");
    await h.snapshot();
    assert.equal(h.events.filter((entry) => entry.event === "needs_attention").length, 1);
    assert.equal(h.events.filter((entry) => entry.event === "grace_expired").length, 1);
    assert.equal(h.events.find((entry) => entry.event === "recovered").duration_ms, 29_999);
  });
  test(`${provider}: confirmed negatives and a restarted worker never borrow recent readiness`, async () => {
    const h = fixture(provider);
    await h.assess();
    h.result = { ...h.healthy, realtime_connected: false };
    assert.equal((await h.snapshot()).ready, false);
    h.result = null;
    assert.equal((await h.snapshot()).ready, false, "negative evidence cannot become grace");
    h.result = h.healthy;
    await h.assess();
    h.result = provider === "shopee" ? { ...h.healthy, current_provider_account_id: "other" }
      : { ...h.healthy, accessible_account_ids: ["other"] };
    assert.equal((await h.assess()).retain_transport, false);
    h.result = h.healthy;
    await h.assess();
    h.result = provider === "shopee" ? { ...h.healthy, capabilities: { ...h.healthy.capabilities, send_text: false } }
      : { ...h.healthy, command_capabilities_by_account: { shop: [] } };
    assert.equal((await h.snapshot()).ready, false);
    h.result = h.healthy;
    await h.assess();
    h.policy.reset();
    h.result = null;
    assert.equal((await h.snapshot()).ready, false, "no evidence survives worker restart");
    h.tabs = [];
    assert.equal((await h.assess()).retain_transport, false);
  });
}
test("navigation only invalidates the affected evidence tab; in-flight old reads cannot restore it", async () => {
  const h = fixture();
  await h.assess();
  h.scope.liveConnections.set(h.context.key, {});
  h.scope.invalidateProviderTab(99, "unused_tab_navigated");
  assert.equal(h.closed.length, 0);
  assert.equal(h.policy.state(h.context.key).eligible, true);
  let finish;
  h.result = new Promise((resolve) => { finish = resolve; });
  const pending = h.assess();
  await new Promise((resolve) => setImmediate(resolve));
  h.scope.invalidateProviderTab(h.tab.id, "provider_tab_navigated");
  finish(h.healthy);
  assert.equal(await pending, null);
  assert.equal(h.policy.state(h.context.key), null);
  assert.equal(h.closed[0].reason, "provider_tab_navigated");
});
test("simultaneous provider checks share one tab/session request", async () => {
  const h = fixture();
  let finish;
  h.result = new Promise((resolve) => { finish = resolve; });
  const pending = [h.assess(), h.assess(), h.assess()];
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.probes, 1);
  finish(h.healthy);
  const policies = await Promise.all(pending);
  assert.ok(policies.every((policy) => policy.eligible));
});
test("grace expiry during asynchronous installation lookup cannot publish ready", async () => {
  const h = fixture();
  await h.assess();
  h.result = null;
  await h.assess();
  h.deferInstallation();
  const pending = h.snapshot();
  await new Promise((resolve) => setImmediate(resolve));
  h.now = 130_000;
  h.finishInstallation();
  const report = await pending;
  assert.equal(report.ready, false);
  assert.equal(report.readiness_grace_expires_at, undefined);
});

function wireSender(h, send) {
  Object.assign(h.scope, {
    providerAdapterForCommand: () => h.context.adapter,
    messageProviderAccountId: (message) => message.provider_account_id,
    accountContextFor: (_stored, account) => account === "shop" ? h.context : null,
    ensureProviderBridge: async () => {},
    withRequestTimeout, sanitizeSendDiagnostics, replyQueue: createReplyQueue(), liveCommandResults: new Map(),
    WebSocket: { OPEN: 1 }, scheduleKeepalive: () => {},
    recordUnexpected: async () => {}, recordLog: async () => {}, sendConnectionStatus: async () => {},
    shopeeAdapter: globalThis.OmnichatProviderAdapters.get("shopee"),
  });
  h.scope.chrome.tabs = { sendMessage: send };
  vm.runInContext(part("function liveCommandContexts(", "function providerSessionEpoch(")
    + part("async function lineSessionContexts(", "function messageProviderAccountId(")
    + part("async function sendViaProvider(", "async function selectCommandTab(")
    + part("async function handleLiveCommand(", "chrome.storage.onChanged.addListener"), h.scope);
}
for (const provider of ["shopee", "line_oa"]) {
  test(`${provider}: grace permits one provider attempt; duplicate command never retries an uncertain result`, async () => {
    const h = fixture(provider);
    await h.assess();
    h.result = null;
    await h.assess();
    const sent = [];
    let finish;
    wireSender(h, async (tabId, message) => {
      sent.push({ tabId, message });
      await new Promise((resolve) => { finish = resolve; });
      return { ok: false, uncertain: true, error: "Provider confirmation unavailable" };
    });
    const socket = { readyState: 1, sent: [], send(body) { this.sent.push(JSON.parse(body)); } };
    const message = JSON.stringify({ provider, provider_account_id: "shop", type: "send_text", conversation_id: "conversation", request_id: "request", text: "reply" });
    const jobs = [h.scope.handleLiveCommand(message, h.context, socket), h.scope.handleLiveCommand(message, h.context, socket)];
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].tabId, h.tab.id);
    assert.equal(sent[0].message.provider_account_id, "shop");
    if (provider === "line_oa") assert.equal(sent[0].message.browser_provider_account_id, "shop");
    finish();
    await Promise.all(jobs);
    await h.scope.handleLiveCommand(message, h.context, socket);
    assert.equal(sent.length, 1, "uncertain provider delivery is never resent automatically");
    assert.ok(socket.sent.every((ack) => ack.ok === false && ack.uncertain === true));
  });
}
test("navigation after tab selection blocks the final provider attempt", async () => {
  const h = fixture();
  await h.assess();
  let sends = 0;
  wireSender(h, async () => { sends++; return { ok: true }; });
  h.scope.ensureProviderBridge = async () => h.scope.invalidateProviderTab(h.tab.id, "provider_tab_navigated");
  const result = await h.scope.sendViaProvider({ provider: "shopee", provider_account_id: "shop", type: "send_text", conversation_id: "conversation", request_id: "request", text: "reply" });
  assert.equal(result.ok, false);
  assert.equal(sends, 0);
});

test("late older positive observations cannot overwrite a newer confirmed failure", async () => {
  const h = fixture();
  await h.assess();
  const blocked = await h.scope.providerReadiness(h.context, { tabs: [h.tab], statuses: [{ ...h.healthy, realtime_connected: false }], observation: 100 });
  assert.equal(blocked.eligible, false);
  const stale = await h.scope.providerReadiness(h.context, { tabs: [h.tab], statuses: [h.healthy], observation: 99 });
  assert.equal(stale.eligible, false);
  assert.equal(h.policy.state(h.context.key).generation, blocked.generation);
});

for (const provider of ["shopee", "line_oa"]) {
  test(`${provider}: typed missing probe results use fixed grace, confirmed failures still block`, async () => {
    const h = fixture(provider);
    await h.assess();
    h.result = { ok: false, provider_check_outcome: "unknown", error: "Provider check timed out." };
    const grace = await h.snapshot();
    assert.equal(grace.ready, true);
    assert.equal(grace.reason_code, "provider_check_grace");
    assert.equal(grace.readiness_grace_expires_at, new Date(130_000).toISOString());
    h.now = 129_000;
    assert.equal((await h.snapshot()).readiness_grace_expires_at, grace.readiness_grace_expires_at);
    h.now = 130_000;
    assert.equal((await h.snapshot()).ready, false);
    h.result = h.healthy;
    assert.equal((await h.snapshot()).ready, true);
    h.result = { ok: false, provider_check_outcome: "failed" };
    assert.equal((await h.snapshot()).ready, false);
    h.result = { ok: false, provider_check_outcome: "unknown" };
    assert.equal((await h.snapshot()).ready, false, "missing evidence cannot resurrect a confirmed failed session");
  });
}

test("LINE refreshed access-check uncertainty reaches the same readiness policy", async () => {
  const h = fixture("line_oa");
  await h.assess();
  h.scope.ensureProviderBridge = async () => {};
  vm.runInContext(part("async function lineSessionContexts(", "async function activeLiveCommandContexts("), h.scope);
  h.result = { ok: false, provider_check_outcome: "unknown" };
  assert.equal((await h.scope.lineSessionContexts([h.context], { refresh: true })).length, 1);
  assert.equal(h.policy.state(h.context.key).reason_code, "provider_check_grace");
  h.result = { ok: false, provider_check_outcome: "failed" };
  assert.equal((await h.scope.lineSessionContexts([h.context], { refresh: true })).length, 0);
  assert.equal(h.policy.state(h.context.key).eligible, false);
});


test("Shopee polling uncertainty cannot hide a known account switch", async () => {
  const h = fixture("shopee");
  await h.assess();
  h.result = { ...h.healthy, provider_check_outcome: "unknown", current_provider_account_id: "other" };
  const result = await h.snapshot();
  assert.equal(result.ready, false);
  assert.equal(result.reason_code, "wrong_account");
});

for (const provider of ["shopee", "line_oa"]) {
  test(`${provider}: one readiness probe per queued send and no dispatch after a queued session change`, async () => {
    const h = fixture(provider);
    await h.assess();
    const sent = [];
    let finish;
    wireSender(h, async (_tabId, message) => {
      sent.push(message);
      await new Promise(resolve => { finish = resolve; });
      return { ok: true, provider_message_id: "sent" };
    });
    const socket = { readyState: 1, sent: [], send(value) { this.sent.push(JSON.parse(value)); } };
    const command = { provider, provider_account_id: "shop", type: "send_text", conversation_id: "conversation", text: "reply" };
    const before = h.probes;
    const first = h.scope.handleLiveCommand(JSON.stringify({ ...command, request_id: "first" }), h.context, socket);
    const second = h.scope.handleLiveCommand(JSON.stringify({ ...command, request_id: "queued" }), h.context, socket);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sent.length, 1);
    assert.equal(h.probes - before, 1, "ready tab is selected once after leaving the queue");
    h.scope.invalidateProviderTab(h.tab.id, "provider_tab_navigated");
    h.result = h.healthy;
    await h.assess();
    finish();
    await Promise.all([first, second]);
    assert.equal(sent.length, 1, "a verified replacement session cannot execute an older queued command");
    assert.equal(socket.sent.find(result => result.request_id === "queued").ok, false);
  });
}

test("missing bridge responses invalidate initialization reuse without changing provider-uncertainty rules", async () => {
  const h = fixture("shopee");
  await h.assess();
  const certificate = { provider: "shopee", epoch: 0, verified: true };
  h.scope.providerBridgeChecks.set(h.tab.id, certificate);
  h.result = { ...h.healthy, provider_check_outcome: "unknown" };
  await h.assess();
  assert.equal(certificate.verified, true, "a responding bridge can report provider uncertainty");
  h.result = { ok: false, provider_check_outcome: "unknown" };
  await h.assess();
  assert.equal(certificate.verified, false, "a missing page response must check or repair initialization before dispatch");
});

for (const provider of ["shopee", "line_oa"]) {
  test(`${provider}: a replacement session during tab persistence cannot adopt an old send`, async () => {
    const h = fixture(provider);
    await h.assess();
    let sends = 0;
    wireSender(h, async () => { sends++; return { ok: true }; });
    h.scope.rememberCommandTab = async () => {
      h.scope.invalidateProviderTab(h.tab.id, "navigation");
      await h.assess();
    };
    await assert.rejects(h.scope.sendViaProvider({ provider, provider_account_id: "shop", type: "send_text",
      conversation_id: "conversation", request_id: "stale", text: "reply" }), /session changed during tab selection/);
    assert.equal(sends, 0);
  });
  test(`${provider}: bridge initialization cannot replace the selected send generation`, async () => {
    const h = fixture(provider);
    await h.assess();
    let sends = 0;
    wireSender(h, async () => { sends++; return { ok: true }; });
    h.scope.ensureProviderBridge = async () => {
      h.scope.invalidateProviderTab(h.tab.id, "navigation");
      await h.assess();
    };
    const result = await h.scope.sendViaProvider({ provider, provider_account_id: "shop", type: "send_text",
      conversation_id: "conversation", request_id: "stale", text: "reply" });
    assert.equal(result.ok, false);
    assert.equal(sends, 0);
  });
}

test("MY readiness ignores another market's identity and refuses wrong-region sends", async () => {
  const h = fixture();
  h.context.account.country = "MY";
  const myTab = { id: 2, url: "https://seller.shopee.com.my/new-webchat/conversations" };
  const result = await h.scope.providerReadiness(h.context, {
    tabs: [h.tab, myTab], statuses: [{ ...h.healthy, current_provider_account_id: "other-th-shop" }, h.healthy],
  });
  assert.equal(result.eligible, true);
  assert.equal(result.evidence.tab.id, 2);
  h.tabs = [h.tab];
  assert.equal((await h.assess()).eligible, false);
  await assert.rejects(h.select, /not ready for this account/);
});

test("revoked country access cannot borrow ready status from already injected regional tabs", async () => {
  const h = fixture();
  h.context.account.country = "MY";
  h.scope.hasRegionalShopeePermission = async () => false;
  const result = await h.scope.providerReadiness(h.context, {
    tabs: [{ id: 2, url: "https://seller.shopee.com.my/new-webchat/conversations" }], statuses: [h.healthy],
  });
  assert.equal(result.eligible, false);
  assert.equal(result.evidence, null);
});

for (const provider of ["shopee", "line_oa"]) {
  test(`${provider}: focus changes preserve the account sender and queued generation`, async () => {
    const h = fixture(provider);
    h.tab.active = true;
    const other = { ...h.tab, id: 2, active: false };
    h.tabs = [h.tab, other];
    const initial = await h.assess();
    h.tab.active = false;
    other.active = true;
    const stable = await h.assess();
    assert.equal(stable.evidence.tab.id, h.tab.id);
    assert.equal(stable.generation, initial.generation);
    const selected = await h.scope.selectSendContext(h.context, { expectedGeneration: initial.generation });
    assert.equal(selected.tab.id, h.tab.id);
    h.tabs = [other];
    const replacement = await h.assess();
    assert.equal(replacement.evidence.tab.id, other.id);
    assert.notEqual(replacement.generation, initial.generation);
    await assert.rejects(h.scope.selectSendContext(h.context, { expectedGeneration: initial.generation }), /session changed/);
  });
}

test("worker deadline releases a stalled reply queue and caches uncertain delivery", async () => {
  const h = fixture("line_oa");
  await h.assess();
  const attempts = [];
  wireSender(h, async (_tab, command) => {
    attempts.push(command.request_id);
    if (command.request_id === "stalled") return new Promise(() => {});
    return { ok: true, provider_message_id: "next-receipt" };
  });
  const socket = { readyState: 1, sent: [], send(body) { this.sent.push(JSON.parse(body)); } };
  const command = (request, deadline) => JSON.stringify({ provider: "line_oa", provider_account_id: "shop",
    type: "send_text", conversation_id: "conversation", request_id: request, deadline_at_ms: deadline, text: "fixture" });
  const stalled = command("stalled", 100_020);
  await Promise.all([
    h.scope.handleLiveCommand(stalled, h.context, socket),
    h.scope.handleLiveCommand(command("next", 101_000), h.context, socket),
  ]);
  assert.deepEqual(attempts, ["stalled", "next"]);
  const failure = socket.sent.find(result => result.request_id === "stalled");
  assert.equal(failure.ok, false);
  assert.equal(failure.uncertain, true);
  const cached = await h.scope.liveCommandResults.get("line_oa:shop:stalled").result;
  assert.equal(cached.diagnostics.delivery_uncertain, true);
  assert.equal(socket.sent.find(result => result.request_id === "next").ok, true);
  await h.scope.handleLiveCommand(stalled, h.context, socket);
  assert.equal(attempts.filter(id => id === "stalled").length, 1);
});

test("expired bridge preflight cannot dispatch a late reply", async () => {
  const h = fixture();
  await h.assess();
  let finish;
  let attempts = 0;
  wireSender(h, async () => { attempts++; return { ok: true }; });
  h.scope.ensureProviderBridge = () => new Promise(resolve => { finish = resolve; });
  await assert.rejects(h.scope.sendViaProvider({ provider: "shopee", provider_account_id: "shop", type: "send_text",
    conversation_id: "conversation", request_id: "expired", deadline_at_ms: 100_020 }), { name: "TimeoutError" });
  finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 0);
});

for (const provider of ["shopee", "line_oa"]) {
  test(`${provider}: inactive tabs can send and transient probes do not switch senders`, async () => {
    const h = fixture(provider);
    h.tab.active = false;
    const backup = { ...h.tab, id: 2 };
    h.tabs = [h.tab, backup];
    const assess = statuses => h.scope.providerReadiness(h.context, { tabs: [h.tab, backup], statuses });
    const initial = await assess([h.healthy, h.healthy]);
    assert.equal(initial.eligible, true);
    assert.equal(initial.evidence.tab.id, h.tab.id);
    const grace = await assess([null, h.healthy]);
    assert.equal(grace.evidence.tab.id, h.tab.id);
    assert.equal(grace.generation, initial.generation);
    assert.equal(grace.reason_code, "provider_check_grace");
    h.now = 129_999;
    assert.equal((await assess([null, h.healthy])).evidence.tab.id, h.tab.id);
    h.now = 130_000;
    const replacement = await assess([null, h.healthy]);
    assert.equal(replacement.evidence.tab.id, backup.id);
    assert.equal(replacement.eligible, true);
    assert.notEqual(replacement.generation, initial.generation);
  });

  test(`${provider}: closing the assigned background tab selects a verified background replacement`, async () => {
    const h = fixture(provider);
    h.tab.active = false;
    const backup = { ...h.tab, id: 2 };
    h.tabs = [h.tab, backup];
    await h.assess();
    h.scope.invalidateProviderTab(h.tab.id, "provider_tab_closed");
    h.tabs = [backup];
    const replacement = await h.assess();
    assert.equal(replacement.eligible, true);
    assert.equal(replacement.evidence.tab.id, backup.id);
    const sent = [];
    wireSender(h, async (tabId) => { sent.push(tabId); return { ok: true, provider_message_id: "receipt" }; });
    const result = await h.scope.sendViaProvider({ provider, provider_account_id: "shop", type: "send_text",
      conversation_id: "conversation", request_id: "replacement" });
    assert.equal(result.ok, true);
    assert.deepEqual(sent, [backup.id]);
  });
}
