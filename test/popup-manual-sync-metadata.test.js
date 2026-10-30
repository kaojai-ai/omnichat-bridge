import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../extension/popup.js", import.meta.url), "utf8");
const handlerSource = source.slice(source.indexOf("let syncActionId = 0;"), source.indexOf('unattendedRecoveryInput.addEventListener("change"'));
const turn = () => new Promise(resolve => setImmediate(resolve));
const accounts = [
  { provider: "line_oa", provider_account_id: "@one", bot_id: "bot-one" },
  { provider: "line_oa", provider_account_id: "@two", bot_id: "bot-two" },
  { provider: "shopee", provider_account_id: "shop" },
];
function harness({ provider = "shopee", action = "sync", unknown = false, freshAccounts = accounts } = {}) {
  let click;
  let finishPermission;
  let finishPreparation;
  let detections = 0;
  const requests = [];
  const results = [];
  const refreshes = [];
  const button = { dataset: { action }, addEventListener: (_event, handler) => { click = handler; } };
  const scope = vm.createContext({
    syncButton: button, storedConfig: { accounts }, detectedAccounts: accounts, activeProviderAdapter: { id: provider }, pendingAction: "",
    progressArea: {}, status: { classList: { remove() {} } },
    renderDashboard() {}, setStatusAppearance() {}, openConfig() {},
    accountOrigins: config => config.accounts,
    requestTargetPermission: () => new Promise(resolve => { finishPermission = resolve; }),
    detectAccount: async () => { detections += 1; }, refreshStoredState: async () => {},
    providerAdapters: { forPage: () => ({ id: provider }) },
    currentTabSyncAccounts: (_config, detected) => unknown ? [] : detected.filter(account => account.provider === provider),
    findAccountConfig: (_config, account) => account,
    popupTabId: 7, crypto: { randomUUID: () => "request" }, t: key => key,
    chrome: {
      runtime: { sendMessage: message => {
        requests.push(message);
        if (message.type === "detect_account") return Promise.resolve({ ok: true, accounts: freshAccounts });
        if (["sync_line_tab", "sync_account"].includes(message.type)) return new Promise(resolve => refreshes.push(resolve));
        if (message.type === "refresh_metadata") throw new Error("Manual sync must reuse its conversation scan.");
        return Promise.resolve({ ok: true });
      } },
      tabs: { get: async () => ({ id: 7, url: provider === "line_oa" ? "https://chat.line.biz/bot-one/chats" : "https://seller.shopee.co.th/webchat" }), sendMessage: message => { requests.push(message); return new Promise(resolve => { finishPreparation = resolve; }); } },
    },
    showSyncResult: async result => results.push(result),
  });
  vm.runInContext(handlerSource, scope);
  return { scope, requests, refreshes, results, click: () => click(),
    allowPermission: () => finishPermission(), finishPreparation: () => finishPreparation({ ok: true }),
    cancel: () => vm.runInContext("syncActionId += 1", scope), get detections() { return detections; } };
}

for (const provider of ["shopee", "line_oa"]) {
  test(`manual ${provider} sync selects the proper current-tab scope`, async () => {
    const h = harness({ provider });
    const task = h.click();
    assert.equal(h.requests.length, 0);
    await turn();
    assert.deepEqual(h.requests.map(value => value.type), ["detect_account"], "fresh login verification precedes permissions and sync");
    h.allowPermission();
    await turn();
    assert.equal(h.requests.some(value => ["prepare_sync_tab", "cancel_sync", "reset_recovery_v3"].includes(value.type)), false);
    if (provider === "line_oa") {
      const batch = h.requests.filter(value => value.type === "sync_line_tab");
      assert.equal(batch.length, 1);
      assert.equal(batch[0].tab_id, 7);
      assert.equal(batch[0].refresh_metadata, true);
      assert.equal(h.requests.some(value => value.type === "refresh_metadata" || value.type === "sync_account"), false);
    } else {
      const syncs = h.requests.filter(value => value.type === "sync_account");
      assert.deepEqual(syncs.map(value => value.provider_account_id), ["shop"]);
      assert.equal(syncs[0].tab_id, 7);
      assert.equal(syncs[0].refresh_metadata, true);
      assert.equal(h.requests.some(value => value.type === "refresh_metadata"), false);
    }
    assert.equal(h.results.length, 0);
    h.refreshes.forEach(resolve => resolve({ ok: true }));
    await task;
    const sync = h.requests.at(-1);
    assert.equal(sync.type, provider === "line_oa" ? "sync_line_tab" : "sync_account");
    assert.equal(sync.tab_id, 7);
    assert.equal(h.results.length, 1);
  });
}

test("cancelled popup action cannot replace the newer UI when background sync finishes", async () => {
  const h = harness();
  const task = h.click();
  await turn();
  h.allowPermission();
  await turn();
  assert.equal(h.requests.filter(value => value.type === "sync_account").length, 1);
  h.cancel();
  h.refreshes.forEach(resolve => resolve({ ok: true }));
  await task;
  assert.equal(h.results.length, 0);
});

test("detect and open-chat actions do not refresh metadata", async () => {
  const detect = harness({ action: "detect" });
  await detect.click();
  assert.equal(detect.detections, 1);
  assert.equal(detect.requests.length, 0);
  const open = harness({ action: "open_webchat_mini" });
  const task = open.click();
  open.finishPreparation();
  await task;
  assert.equal(open.detections, 1);
  assert.equal(open.requests.some(value => value.type === "refresh_metadata"), false);
});

test("separate metadata controls and presentation are removed", () => {
  assert.doesNotMatch(source, /account-metadata-refresh|metadataRefreshResults|refreshAccountMetadata\(/);
  assert.doesNotMatch(source, /refreshMetadata:|refreshingMetadata:|metadataRefreshFailed:/);
  const autoStart = source.slice(source.indexOf("async function autoStartSync("), source.indexOf("async function load()"));
  assert.doesNotMatch(autoStart, /refresh_metadata/);
});

test("unidentified current account stops before refresh or sync", async () => {
  const h = harness({ unknown: true });
  await h.click();
  assert.deepEqual(h.requests.map(value => value.type), ["detect_account"]);
});

for (const provider of ['line_oa', 'shopee']) {
  test(`repeated ${provider} clicks do not reset or duplicate sync`, async () => {
    const h = harness({ provider });
    const task = h.click();
    await h.click();
    await turn();
    h.allowPermission();
    await turn();
    await h.click();
    assert.equal(h.requests.filter(x => x.type === 'prepare_sync_tab').length, 0);
    assert.equal(h.requests.filter(x => x.type === 'detect_account').length, 1);
    assert.equal(h.requests.filter(x => ['sync_account', 'sync_line_tab'].includes(x.type)).length, 1);
    h.refreshes.forEach(resolve => resolve({ ok: true }));
    await task;
  });
}


test("fresh login verification rejects stale cached access before starting sync", async () => {
  const h = harness({ provider: "line_oa", freshAccounts: [] });
  await h.click();
  assert.deepEqual(h.requests.map(value => value.type), ["detect_account"]);
  assert.equal(h.refreshes.length, 0);
});

test("manual Sync can join background work but stays disabled during its own request", () => {
  const start = source.indexOf('  syncButton.disabled = Boolean(pendingAction);');
  assert.ok(start >= 0);
  const end = source.indexOf('  cancelSyncButton.hidden', start);
  const button = { dataset: {}, setAttribute() {} };
  const context = { syncButton: button, pendingAction: "", anySyncing: true,
    sellerCentreChatClosed: false, activeProviderAdapter: { id: "shopee" },
    anyPending: false, anyError: false, surfaceHint: "", t: key => key };
  vm.runInNewContext(source.slice(start, end), context);
  assert.equal(button.disabled, false);
  context.pendingAction = "checking";
  vm.runInNewContext(source.slice(start, end), context);
  assert.equal(button.disabled, true);
});
