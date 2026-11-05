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
  const scope = vm.createContext({ withRequestTimeout, preemptAutomaticLogUpload: () => {}, activeProviderSendAccounts: new Set(),
    Date: class extends Date { static now() { return now; } },
    sessionEligibility: policy, providerAdapters: globalThis.OmnichatProviderAdapters,
    providerChatTabs: async () => tabs, providerLabel: () => provider,
    sendProviderMessage: async () => { probes++; return result; }, PROVIDER_STATUS_RESPONSE_TIMEOUT_MS: 5000, PROVIDER_HEALTH_STALE_MS: 60_000,
    STORAGE: {}, readStorage: async () => ({}), readAccountState: (_state, _key, fallback) => fallback,
    normalizeDeviceName: () => "", buildConnectionHealth, persistProviderSurfaceState: async () => {},
    canonicalProviderAccountId: () => "shop", installationId: () => installation,
    chrome: { runtime: { getPlatformInfo: async () => ({ os: "mac" }), getManifest: () => ({ version: "test" }) } },
    accountSyncs: new Map(), lineTabSyncs: new Map(),
    liveConnections: new Map(), stopAccountLiveConnection: (key, _connection, reason) => { closed.push({ key, reason }); scope.liveConnections.delete(key); },
    runProviderHealthWatchdog: async () => {}, recordUnexpected: async () => {},
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
  healthy.send_verified_at = new Date(now).toISOString();
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
    await assert.rejects(h.select(), /readiness is unavailable or stale/, "unknown evidence does not authorize a new send");
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
    await assert.rejects(h.select(), /readiness is unavailable or stale/);
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
    h.result = { ...h.healthy, realtime_connected: false, ...(provider === "shopee" ? { surface_ready: false } : { account_access_verified: false }) };
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
    h.result = provider === "shopee" ? { ...h.healthy, surface_ready: false }
      : { ...h.healthy, account_access_verified: false };
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
    + part("const activeProviderSendAccounts =", "async function selectCommandTab(")
    + part("async function handleLiveCommand(", "chrome.storage.onChanged.addListener"), h.scope);
}
for (const provider of ["shopee", "line_oa"]) {
  test(`${provider}: cached readiness permits one provider attempt; duplicate command never retries an uncertain result`, async () => {
    const h = fixture(provider);
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
  const select = h.scope.selectSendContext;
  h.scope.selectSendContext = async (...args) => {
    const selected = await select(...args);
    h.scope.invalidateProviderTab(h.tab.id, "provider_tab_navigated");
    return selected;
  };
  const result = await h.scope.sendViaProvider({ provider: "shopee", provider_account_id: "shop", type: "send_text", conversation_id: "conversation", request_id: "request", text: "reply" });
  assert.equal(result.ok, false);
  assert.equal(sends, 0);
});

test("late older positive observations cannot overwrite a newer confirmed failure", async () => {
  const h = fixture();
  await h.assess();
  const blocked = await h.scope.providerReadiness(h.context, { tabs: [h.tab], statuses: [{ ...h.healthy, realtime_connected: false, surface_ready: false }], observation: 100 });
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
  test(`${provider}: no readiness probes per queued send and no dispatch after a queued session change`, async () => {
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
    assert.equal(h.probes - before, 0, "cached tab selection never probes on send");
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
  test(`${provider}: cached send never persists selection or initializes a bridge`, async () => {
    const h = fixture(provider);
    await h.assess();
    let sends = 0;
    wireSender(h, async () => { sends++; return { ok: true, provider_message_id: "receipt" }; });
    h.scope.rememberCommandTab = () => assert.fail("send must not persist selection");
    h.scope.ensureProviderBridge = () => assert.fail("send must not initialize a bridge");
    h.scope.providerChatTabs = () => assert.fail("send must not discover tabs");
    h.scope.providerTabStatus = () => assert.fail("send must not probe readiness");
    const result = await h.scope.sendViaProvider({ provider, provider_account_id: "shop", type: "send_text",
      conversation_id: "conversation", request_id: "warm", text: "reply" });
    assert.equal(result.ok, true);
    assert.equal(sends, 1);
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
  await assert.rejects(h.select, /readiness is unavailable or stale/);
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
    type: "send_text", conversation_id: "conversation", request_id: request, execution_budget_ms: deadline - 100_000, text: "fixture" });
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

test("a command that exhausts its relative budget in queue never reaches the provider", async () => {
  const h = fixture();
  await h.assess();
  let attempts = 0;
  wireSender(h, async () => { attempts++; return { ok: true, provider_message_id: "receipt" }; });
  h.scope.replyQueue = { run: (_key, action) => { h.now = 100_021; return action(); } };
  const socket = { readyState: 1, sent: [], send(body) { this.sent.push(JSON.parse(body)); } };
  await h.scope.handleLiveCommand(JSON.stringify({ provider: "shopee", provider_account_id: "shop",
    type: "send_text", conversation_id: "conversation", request_id: "queued", execution_budget_ms: 20 }), h.context, socket);
  assert.equal(attempts, 0);
  assert.equal(socket.sent[0].dispatch_started, false);
  assert.equal(socket.sent[0].error_code, "OMNICHAT_DEADLINE_EXPIRED");
  assert.notEqual(socket.sent[0].uncertain, true);
});

test("expired cached evidence rejects locally and repeated reports cannot renew it", async () => {
  const h = fixture();
  await h.assess();
  let attempts = 0;
  let refreshes = 0;
  wireSender(h, async () => { attempts++; return { ok: true }; });
  h.scope.runProviderHealthWatchdog = async () => { refreshes++; };
  h.now = 220_000;
  assert.equal(h.policy.state(h.context.key).eligible, false);
  assert.equal((await h.assess()).eligible, false, "same old timestamp must not renew evidence");
  const failure = await h.scope.sendViaProvider({ provider: "shopee", provider_account_id: "shop", type: "send_text",
    conversation_id: "conversation", request_id: "expired" });
  assert.equal(failure.dispatch_started, false);
  assert.match(failure.error, /readiness is unavailable or stale/);
  assert.equal(failure.retryable, true);
  assert.equal(failure.error_code, "OMNICHAT_BRIDGE_NOT_READY");
  assert.equal(attempts, 0);
  assert.equal(refreshes, 1);
});

for (const provider of ["shopee", "line_oa"]) {
  test(`${provider}: inactive tabs can send and a verified backup replaces an unresponsive sender`, async () => {
    const h = fixture(provider);
    h.tab.active = false;
    const backup = { ...h.tab, id: 2 };
    h.tabs = [h.tab, backup];
    const assess = statuses => h.scope.providerReadiness(h.context, { tabs: [h.tab, backup], statuses });
    const initial = await assess([h.healthy, h.healthy]);
    assert.equal(initial.eligible, true);
    assert.equal(initial.evidence.tab.id, h.tab.id);
    const grace = await assess([null, h.healthy]);
    assert.equal(grace.evidence.tab.id, backup.id);
    assert.notEqual(grace.generation, initial.generation);
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


test("outbound selection does not await a stalled extra tab", async () => {
  const h = fixture();
  const backup = { ...h.tab, id: 2 };
  h.tabs = [h.tab, backup];
  await h.assess();
  h.scope.providerTabStatus = tab => tab.id === h.tab.id ? Promise.resolve(h.healthy) : new Promise(() => {});
  h.scope.providerTabStatus = () => assert.fail("cached send must not probe any tab");
  const selected = await h.scope.selectSendContext(h.context);
  assert.equal(selected.tab.id, h.tab.id);
});

for (const provider of ["line_oa", "shopee"]) {
  test(`${provider}: malformed tab responses stay uncertain through socket acknowledgement and duplicate replay`, async () => {
    for (const response of [undefined, null, "invalid", {}, [], { ok: "true" }, { ok: 0 }]) {
      const h = fixture(provider);
      await h.assess();
      let sends = 0;
      wireSender(h, async () => { sends++; return response; });
      const socket = { readyState: 1, sent: [], send(body) { this.sent.push(JSON.parse(body)); } };
      const command = JSON.stringify({ provider, provider_account_id: "shop", type: "send_text",
        conversation_id: "conversation", request_id: "malformed", text: "fixture" });
      await h.scope.handleLiveCommand(command, h.context, socket);
      await h.scope.handleLiveCommand(command, h.context, socket);
      assert.equal(sends, 1, "an ambiguous provider attempt must never be sent again");
      assert.equal(socket.sent.length, 2);
      for (const result of socket.sent) {
        assert.equal(result.ok, false);
        assert.equal(result.uncertain, true);
        assert.equal(result.dispatch_started, true);
        assert.equal(result.execution_stage, "provider_dispatch");
        assert.equal(result.retryable, false);
        assert.equal(result.error_code, "OMNICHAT_PROVIDER_RESULT_MISSING");
      }
    }
  });
  test(`${provider}: valid provider success, rejection and uncertainty preserve their outcome`, async () => {
    for (const response of [{ ok: true, provider_message_id: "receipt" },
      { ok: false, error: "Provider rejected reply." }, { ok: false, uncertain: true, error: "Unconfirmed." }]) {
      const h = fixture(provider);
      await h.assess();
      wireSender(h, async () => response);
      const result = await h.scope.sendViaProvider({ provider, provider_account_id: "shop", type: "send_text",
        conversation_id: "conversation", request_id: "valid", text: "fixture" });
      assert.equal(result.ok, response.ok);
      assert.equal(result.uncertain, response.uncertain);
      assert.equal(result.provider_message_id, response.provider_message_id);
      assert.equal(result.dispatch_started, true);
    }
  });
}

for (const provider of ["shopee", "line_oa"]) {
  test(`${provider}: missing, future and expired verification timestamps never authorize a send`, async () => {
    const h = fixture(provider);
    for (const timestamp of [null, "invalid", new Date(100_001).toISOString(), new Date(-20_000).toISOString()]) {
      h.result = { ...h.healthy, send_verified_at: timestamp };
      assert.equal((await h.assess()).eligible, false);
      await assert.rejects(h.select(), /readiness is unavailable or stale/);
    }
  });
  test(`${provider}: failed inbound polling leaves independently verified sending available`, async () => {
    const h = fixture(provider);
    h.result = { ...h.healthy, realtime_connected: false, provider_check_outcome: "unknown",
      last_provider_check_at: null, capabilities: { ...h.healthy.capabilities, message_recovery: false } };
    const snapshot = await h.snapshot();
    assert.equal(snapshot.send_ready, true);
    assert.equal(snapshot.receive_ready, false);
    assert.equal((await h.select()).id, h.tab.id);
  });
}

for (const provider of ["shopee", "line_oa"]) {
  test(`${provider}: changed session rejects before dispatch with safe failover classification`, async () => {
    const h = fixture(provider);
    const ready = await h.assess();
    let attempts = 0;
    wireSender(h, async () => { attempts++; return { ok: true }; });
    h.scope.invalidateProviderTab(h.tab.id, "navigation");
    const failure = await h.scope.sendViaProvider({ provider, provider_account_id: "shop", type: "send_text",
      conversation_id: "conversation", request_id: "changed" }, { expectedGeneration: ready.generation });
    assert.equal(attempts, 0);
    assert.equal(failure.dispatch_started, false);
    assert.equal(failure.retryable, true);
    assert.equal(failure.error_code, "OMNICHAT_BRIDGE_NOT_READY");
  });
}

for (const provider of ["shopee", "line_oa"]) {
  test(`${provider}: stable message support comes from adapter, not page feature flags`, async () => {
    const h = fixture(provider);
    h.result = { ...h.healthy, capabilities: { message_recovery: false },
      command_capabilities_by_account: {}, surface: provider === "shopee" ? "new-webchat" : "line-oa" };
    const snapshot = await h.snapshot();
    assert.equal(snapshot.send_ready, true);
    assert.deepEqual(Array.from(snapshot.command_capabilities), Array.from(h.context.adapter.sendCommands));
  });
}
test("Shopee video routing supports New Webchat and regional Seller Centre", async () => {
  const h = fixture();
  h.result = { ...h.healthy, surface: "seller-centre" };
  assert.equal((await h.snapshot()).command_capabilities.includes("send_video"), true);
  h.context.account.country = "MY";
  h.scope.hasRegionalShopeePermission = async () => true;
  h.tab.url = "https://seller.shopee.com.my/";
  assert.equal((await h.snapshot()).command_capabilities.includes("send_video"), true);
  h.context.account.country = "TH";
  h.tab.url = "https://seller.shopee.co.th/new-webchat/conversations";
  h.result = { ...h.healthy, surface: "new-webchat" };
  assert.equal((await h.snapshot()).command_capabilities.includes("send_video"), true);
});
