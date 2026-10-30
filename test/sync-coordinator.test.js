import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { createAccountSyncCoordinator } from "../extension/lib/sync-coordinator.js";

const source = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("same-provider accounts serialize while another provider proceeds, and failures release the queue", async () => {
  const coordinator = createAccountSyncCoordinator();
  const first = deferred();
  const events = [];
  const shopee = coordinator.run("shopee:a", "shopee", {}, () => { events.push("shopee:a"); return first.promise; });
  const rejection = assert.rejects(shopee, /failed/);
  const next = coordinator.run("shopee:b", "shopee", {}, () => events.push("shopee:b"));
  const line = coordinator.run("line_oa:a", "line_oa", {}, () => events.push("line_oa:a"));
  await tick();
  assert.deepEqual(events, ["shopee:a", "line_oa:a"]);
  first.reject(new Error("failed"));
  await Promise.all([rejection, next, line]);
  assert.deepEqual(events, ["shopee:a", "line_oa:a", "shopee:b"]);
  await coordinator.drain();
  assert.equal(coordinator.jobs.size, 0);
});

test("duplicate account work shares its promise and promotes manual metadata without a second scan", async () => {
  const coordinator = createAccountSyncCoordinator();
  const finish = deferred();
  let runs = 0;
  const control = { refreshMetadata: false };
  const first = coordinator.run("line_oa:a", "line_oa", control, () => { runs++; return finish.promise; });
  const duplicate = coordinator.run("line_oa:a", "line_oa", { refreshMetadata: true }, () => assert.fail("duplicate scan"));
  assert.equal(first, duplicate);
  assert.equal(control.refreshMetadata, true);
  await tick();
  finish.resolve({ recovered: 3 });
  assert.deepEqual(await duplicate, { recovered: 3 });
  assert.equal(runs, 1);
});

function accountHarness() {
  const syncCoordinator = createAccountSyncCoordinator();
  const contexts = new Map();
  const events = [];
  const finishes = new Map();
  const sandbox = {
    syncCoordinator, accountSyncs: syncCoordinator.jobs, AbortController,
    STORAGE: { config: "config", detectedAccounts: "detected", consent: "consent", serverInitialized: "initialized", logUploadEnabled: "logs" },
    readStorage: async () => ({ consent: true, initialized: true }),
    hasLocalConsent: value => value === true, hasServerInitialized: stored => stored.initialized,
    accountContextFor: (_stored, id, provider) => contexts.get(`${provider}:${id}`),
    preemptAutomaticLogUpload: () => {},
    throwIfSyncCancelled: signal => { if (signal.aborted) throw Object.assign(new Error("cancelled"), { name: "AbortError" }); },
    syncCancelledError: () => Object.assign(new Error("cancelled"), { name: "AbortError" }),
    exactProviderAccountTab: async (context, id) => { events.push(`verify:${context.key}`); return { id }; },
    providerTabContext: (tab, provider) => `${provider}:${tab.id}`,
    runAccountSync: async (trigger, control, context) => {
      events.push(`scan:${context.key}:${trigger}`);
      return finishes.get(context.key)?.promise ?? { provider_account_id: context.account.provider_account_id };
    },
    queueLiveStateWrite: action => action(), writeStorage: async () => {},
    ensureLiveConnection: async () => {}, recordUnexpected: async () => {},
  };
  const start = source.indexOf("function requestAccountSync(");
  const end = source.indexOf("async function retryProviderAccount(", start);
  const request = vm.runInNewContext(`(${source.slice(start, end).trim()})`, sandbox);
  return { events, finishes, coordinator: syncCoordinator, request,
    context(provider, id) {
      const context = { key: `${provider}:${id}`, adapter: { id: provider }, account: { provider, provider_account_id: id }, config: {} };
      contexts.set(context.key, context);
      return context;
    },
  };
}

test("manual, automatic and queued cancellation use the same account/provider coordinator", async () => {
  const h = accountHarness();
  const a = h.context("line_oa", "a");
  const b = h.context("line_oa", "b");
  const shopee = h.context("shopee", "shop");
  const first = deferred();
  h.finishes.set(a.key, first);
  const automatic = h.request(a, "automatic", { tab_id: 1 });
  const manual = h.request(a, "manual", { tab_id: 1 });
  const controller = new AbortController();
  const queued = h.request(b, "automatic", { tab_id: 1, controller });
  const rejected = assert.rejects(queued, { name: "AbortError" });
  const otherProvider = h.request(shopee, "manual", { tab_id: 2 });
  await tick();
  controller.abort();
  assert.equal(h.coordinator.jobs.get(a.key).refreshMetadata, true);
  assert.deepEqual(h.events, ["verify:line_oa:a", "verify:shopee:shop", "scan:line_oa:a:automatic", "scan:shopee:shop:manual"]);
  first.resolve({ recovered: 8 });
  const results = await Promise.all([automatic, manual, rejected, otherProvider]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(h.events.some(event => event.includes("line_oa:b")), false, "cancelled queued account never verifies or scans");
});

test("content resume is scoped to a verified sender tab and never accepts an account ID from its payload", async () => {
  const calls = [];
  const adapter = { id: "shopee", matchesUrl: url => url.startsWith("https://shopee.example/") };
  const sandbox = {
    providerAdapterForId: provider => provider === "shopee" ? adapter : null,
    providerChatTabById: async (_adapter, id) => id === 7 ? { id, url: "https://shopee.example/chat" } : null,
    STORAGE: { serverInitialized: "initialized", unattendedRecovery: "recovery", consent: "consent" },
    readStorage: async () => ({ initialized: true, recovery: true, consent: true }),
    hasServerInitialized: stored => stored.initialized, hasLocalConsent: value => value,
    syncAccountsForTab: async (...args) => { calls.push(args); return { ok: true }; },
    invalidateProviderTab: () => {},
  };
  const start = source.indexOf("async function resumeSync(");
  const end = source.indexOf("async function resumeInterruptedSync(", start);
  const resume = vm.runInNewContext(`(${source.slice(start, end).trim()})`, sandbox);
  await resume({ type: "resume_sync", provider: "shopee", provider_account_id: "untrusted-other" }, { tab: { id: 7, url: "https://shopee.example/chat" } });
  assert.deepEqual(calls, [["shopee", 7, "automatic"]]);
  assert.equal((await resume({ provider: "shopee" }, { tab: { id: 7, url: "https://line.example/chat" } })).skipped, "unverified_sender");
  assert.equal((await resume({ provider: "shopee" }, {})).skipped, "unverified_sender");
  assert.equal(calls.length, 1);
});

test("startup resumes only interrupted configured accounts instead of every account", async () => {
  const contexts = [
    { key: "shopee:a", adapter: { id: "shopee" } },
    { key: "line_oa:b", adapter: { id: "line_oa" } },
    { key: "line_oa:c", adapter: { id: "line_oa" } },
  ];
  const requested = [];
  const sandbox = {
    STORAGE: { serverInitialized: "initialized", consent: "consent", config: "config", detectedAccounts: "detected", status: "status", scanState: "scan" },
    readStorage: async () => ({ initialized: true, consent: true, scan: { "shopee:a": { in_progress: true } }, status: { "line_oa:b": { state: "syncing" }, "line_oa:c": { state: "watching" } } }),
    hasServerInitialized: stored => stored.initialized, hasLocalConsent: value => value,
    configuredAccountContexts: () => contexts,
    readAccountState: (state, key, fallback) => state?.[key] ?? fallback,
    requestAccountSync: async (context, trigger) => { requested.push([context.key, trigger]); return {}; },
  };
  const start = source.indexOf("async function resumeInterruptedSync(");
  const end = source.indexOf("function messageKey(", start);
  const resume = vm.runInNewContext(`(${source.slice(start, end).trim()})`, sandbox);
  await resume();
  assert.deepEqual(requested, [["shopee:a", "automatic"], ["line_oa:b", "automatic"]]);
});

test("checkpoint writes reject superseded requests and recheck cancellation after storage awaits", async () => {
  const controller = new AbortController();
  const control = { controller, accountKey: "shopee:a", adapter: { id: "shopee" }, providerAccountId: "a", tabId: 7, providerRequestId: "current" };
  const storageRead = deferred();
  let writes = 0;
  const sandbox = {
    accountSyncs: new Map([[control.accountKey, control]]),
    syncCancelledError: () => Object.assign(new Error("cancelled"), { name: "AbortError" }),
    exclusive: task => task(),
    getAccountScanState: () => storageRead.promise,
    writeAccountScanState: async (_context, patch) => { patch({ conversations: {} }); writes++; },
    compareMessageCursor: () => 1,
  };
  const guardStart = source.indexOf("function isCurrentSyncControl(");
  const guardEnd = source.indexOf("async function initializeAndStartSync(", guardStart);
  const cursorStart = source.indexOf("async function advanceScanCursor(");
  const cursorEnd = source.indexOf("function exclusive(", cursorStart);
  const persist = vm.runInNewContext(`(() => { ${source.slice(guardStart, guardEnd)}\n${source.slice(cursorStart, cursorEnd)}; return persistSyncCheckpoint; })()`, sandbox);
  const message = { type: "advance_scan_cursor", provider: "shopee", provider_account_id: "a", request_id: "current:page", conversation_id: "conversation", cursor: { event_timestamp: "2026-10-30T00:00:00Z", message_id: "1" } };
  await assert.rejects(persist({ ...message, request_id: "previous:page" }, 7), { name: "AbortError" });
  await assert.rejects(persist(message, 8), { name: "AbortError" });
  const pending = persist(message, 7);
  controller.abort();
  storageRead.resolve({ context: {} });
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(writes, 0, "late recovery cannot advance the account checkpoint");
});

test("a new request waits for cancelled account cleanup before starting a replacement", async () => {
  const h = accountHarness();
  const context = h.context("shopee", "shop");
  const first = deferred();
  h.finishes.set(context.key, first);
  const old = h.request(context, "automatic", { tab_id: 7 });
  await tick();
  h.coordinator.jobs.get(context.key).controller.abort();
  const replacement = h.request(context, "manual", { tab_id: 7 });
  await tick();
  assert.equal(h.events.filter(event => event.startsWith("scan:")).length, 1);
  h.finishes.delete(context.key);
  first.resolve({ cancelled: true });
  await Promise.all([old, replacement]);
  assert.deepEqual(h.events.filter(event => event.startsWith("scan:")), ["scan:shopee:shop:automatic", "scan:shopee:shop:manual"]);
});

test("revoking one LINE account preserves peers while cancelling the tab still aborts all its jobs", async () => {
  const h = accountHarness();
  const a = h.context("line_oa", "a");
  const b = h.context("line_oa", "b");
  const c = h.context("line_oa", "c");
  const finishA = deferred();
  const finishB = deferred();
  h.finishes.set(a.key, finishA);
  h.finishes.set(b.key, finishB);
  const parent = new AbortController();
  const first = h.request(a, "manual", { tab_id: 7, controller: parent });
  const second = h.request(b, "manual", { tab_id: 7, controller: parent });
  await tick();
  h.coordinator.jobs.get(a.key).controller.abort();
  assert.equal(parent.signal.aborted, false, "account cancellation cannot abort its parent tab");
  assert.equal(h.coordinator.jobs.get(b.key).controller.signal.aborted, false);
  finishA.resolve({ cancelled: true });
  await first;
  await tick();
  assert.ok(h.events.includes("scan:line_oa:b:manual"), "accessible peer proceeds after the revoked account releases its slot");
  const third = h.request(c, "manual", { tab_id: 7, controller: parent });
  const rejected = assert.rejects(third, { name: "AbortError" });
  parent.abort();
  assert.equal(h.coordinator.jobs.get(b.key).controller.signal.aborted, true);
  assert.equal(h.coordinator.jobs.get(c.key).controller.signal.aborted, true);
  finishB.resolve({ cancelled: true });
  await Promise.all([second, rejected]);
  assert.equal(h.events.some(event => event.includes("line_oa:c")), false);
});

test("routine LINE checkpoints survive completed jobs but reject stale polls, access and session changes", async () => {
  let epoch = 1;
  let configured = true;
  let consent = true;
  let beforeWrite = () => {};
  const writes = [];
  const tab = { id: 7 };
  const status = { account_access_verified: true, accessible_account_ids: ["a"],
    provider_polling_request_id: "poll:current", provider_polling_account_id: "a" };
  const sandbox = {
    accountSyncs: new Map(), // Includes the service-worker restart case.
    STORAGE: { config: "config", detectedAccounts: "detected", consent: "consent" },
    providerAdapterForId: id => ({ id }),
    providerChatTabById: async (_adapter, id) => id === 7 ? tab : null,
    providerTabContext: () => String(epoch),
    readStorage: async () => ({ consent }),
    accountContextFor: (_stored, id) => configured && id === "a" ? { key: "line_oa:a" } : null,
    hasLocalConsent: value => value === true,
    providerTabStatus: async () => status,
    syncCancelledError: () => Object.assign(new Error("cancelled"), { name: "AbortError" }),
    exclusive: task => task(),
    getAccountScanState: async () => ({ context: {} }),
    writeAccountScanState: async (_context, patch) => { beforeWrite(); writes.push(patch({ conversations: {} })); },
    compareMessageCursor: () => 1,
  };
  const start = source.indexOf("function isCurrentSyncControl(");
  const end = source.indexOf("async function initializeAndStartSync(", start);
  const cursorStart = source.indexOf("async function advanceScanCursor(");
  const cursorEnd = source.indexOf("function exclusive(", cursorStart);
  const persist = vm.runInNewContext(`(() => { ${source.slice(start, end)}\n${source.slice(cursorStart, cursorEnd)}; return persistSyncCheckpoint; })()`, sandbox);
  const message = { type: "advance_scan_cursor", provider: "line_oa", provider_account_id: "a",
    request_id: "poll:current:chat:cursor:0", conversation_id: "first",
    cursor: { event_timestamp: "2026-10-30T00:00:00Z", message_id: "1" } };
  await persist(message, 7);
  await persist({ ...message, conversation_id: "second" }, 7);
  assert.equal(writes.length, 2, "routine scans can advance beyond their first conversation");
  await assert.rejects(persist({ ...message, request_id: "poll:previous:chat:cursor:0" }, 7), { name: "AbortError" });
  await assert.rejects(persist(message, 8), { name: "AbortError" });
  status.provider_polling_account_id = "b";
  await assert.rejects(persist(message, 7), { name: "AbortError" });
  status.provider_polling_account_id = "a";
  status.accessible_account_ids = [];
  await assert.rejects(persist(message, 7), { name: "AbortError" });
  status.accessible_account_ids = ["a"];
  configured = false;
  await assert.rejects(persist(message, 7), { name: "AbortError" });
  configured = true;
  consent = false;
  await assert.rejects(persist(message, 7), { name: "AbortError" });
  consent = true;
  beforeWrite = () => { epoch++; };
  await assert.rejects(persist(message, 7), { name: "AbortError" });
  assert.equal(writes.length, 2, "session invalidation during storage waiting cannot advance checkpoints");
});
