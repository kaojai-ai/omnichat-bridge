import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { createReplyQueue } from "../extension/lib/reply-queue.js";
import { readAccountState, writeAccountState } from "../extension/lib/storage.js";
import { hasScanBacklog, scanResumePaused } from "../extension/lib/sync-state.js";
const source = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const tick = () => new Promise(resolve => setImmediate(resolve));

for (const provider of ["shopee", "line_oa"]) {
  test(`${provider}: upgrade queues a clean restart behind replies and resumes saved coverage`, async () => {
    const adapter = { id: provider }, events = [], queue = createReplyQueue();
    const watermark = "2026-11-02T08:00:00Z";
    const scan = { watermark, started_at: watermark, completed_at: watermark, in_progress: false, conversations: { customer: { message_id: "saved" } } };
    const stored = { scan: { version: 2, accounts: { account: scan, paused: { ...scan, resume_paused: true } } }, pending: ["accepted-locally"] };
    const scope = vm.createContext({ hasScanBacklog, scanResumePaused, readAccountState, writeAccountState,
      STORAGE: { scanState: "scan", config: "config", consent: "consent", detectedAccounts: "detected" },
      readStorage: async () => stored, writeStorage: async patch => Object.assign(stored, patch),
      exclusive: fn => fn(), serializeAccountStorage: fn => fn(), hasLocalConsent: () => true,
      configuredAccountContexts: () => [{ key: "account", adapter }, { key: "paused", adapter }],
      providerAdapters: { list: () => [adapter] }, providerChatTabs: async () => [{ id: 42 }],
      accountSyncs: new Map(), replyQueue: queue,
      verifyProviderBridge: async () => events.push("probe"),
      invalidateProviderTab: () => events.push("invalidate"),
      reinjectProviderBridge: async (_id, _adapter, options) => { assert.equal(options.restart, true); events.push("replace"); return true; },
      ensureProviderBridge: async () => events.push("verify"), ensureLiveConnection: async () => {},
      cancelActiveSync: async (_provider, _tab, reason) => { assert.equal(reason, "extension_updated"); events.push("cancel-old"); },
      recordUnexpected: async (_area, error) => { throw error; },
    });
    vm.runInContext(section("let manualBridgeRepair = null;", "async function applyExtensionUpdate("), scope);
    await scope.repairOpenProviderTabs();
    assert.deepEqual(events, ["probe"], "ordinary retries preserve healthy provider execution");
    events.length = 0;
    let finishReply;
    const busy = queue.run("account", () => new Promise(resolve => { finishReply = resolve; }));
    await tick();
    const upgrading = scope.repairOpenProviderTabs({ restart: true });
    await tick();
    assert.deepEqual(events, ["cancel-old"]);
    finishReply();
    await busy;
    const result = await upgrading;
    assert.equal(result.failed_tabs.length, 0);
    assert.deepEqual(events, ["cancel-old", "invalidate", "replace", "verify"]);
    assert.equal(hasScanBacklog(stored.scan.accounts.account), true);
    assert.equal(stored.scan.accounts.account.watermark, watermark);
    assert.deepEqual(stored.scan.accounts.account.conversations, scan.conversations);
    assert.deepEqual(stored.pending, ["accepted-locally"]);
    assert.equal(stored.scan.accounts.paused.resume_paused, true);
    assert.equal(stored.scan.accounts.paused.in_progress, false);
  });

  test(`${provider}: forced upgrade replaces compatible page code; normal repair only resets recovery`, async () => {
    const events = [], mainStatus = { ready: true, hasAdapters: true, hasProviderAdapter: true, hasUrl: true };
    const scope = vm.createContext({ providerBridgeReinjections: new Map(),
      providerMainBridgeStatus: async () => mainStatus,
      retireProviderMainBridge: async () => events.push("retire-main"),
      retireProviderContentBridge: async () => events.push("retire-content"),
      resetProviderRecovery: async () => events.push("reset"),
      chrome: { scripting: { executeScript: async request => {
        if (request.files) events.push(`${request.world}:${request.files.join(",")}`);
        return [{ result: { hasUrl: true, hasShopee: true, hasAdapters: true, hasProviderAdapter: true } }];
      } } }, recordUnexpected: async (_area, error) => { throw error; },
    });
    vm.runInContext(section("async function reinjectProviderBridge(", "async function reattachOpenProviderBridges("), scope);
    assert.equal(await scope.reinjectProviderBridge(42, { id: provider }), true);
    assert.equal(events.includes("retire-main"), false);
    assert.equal(events.includes("reset"), true);
    events.length = 0;
    assert.equal(await scope.reinjectProviderBridge(42, { id: provider }, { restart: true }), true);
    assert.equal(events[0], "retire-main");
    assert.ok(events.some(event => event.startsWith("MAIN:") && event.includes(`${provider === "line_oa" ? "line-oa" : "shopee"}-realtime.js`)));
    assert.ok(events.some(event => event.startsWith("ISOLATED:") && event.includes("content.js")));
    assert.equal(events.includes("reset"), false);
  });
}

test("LINE main-world retirement disposes the old execution even with a compatible protocol", async () => {
  let disposed = false;
  const scope = vm.createContext({ invalidateBridgeVerification: () => {},
    chrome: { scripting: { executeScript: async ({ func }) => [{ result: vm.runInNewContext(`(${func})()`, {
      window: { __omnichatLineOABridgeControl: { source: "old", dispose: () => { disposed = true; return true; } } },
    }) }] } },
  });
  vm.runInContext(section("async function retireProviderMainBridge(", "async function retireProviderContentBridge("), scope);
  const result = await scope.retireProviderMainBridge(42);
  assert.equal(result.disposed, true);
  assert.equal(disposed, true);
});
