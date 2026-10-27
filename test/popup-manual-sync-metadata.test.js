import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../extension/popup.js", import.meta.url), "utf8");
const handlerSource = source.slice(source.indexOf("let syncActionId = 0;"), source.indexOf('unattendedRecoveryInput.addEventListener("change"'));
const turn = () => new Promise(resolve => setImmediate(resolve));
const accounts = [
  { provider: "line_oa", provider_account_id: "@one" },
  { provider: "line_oa", provider_account_id: "@two" },
  { provider: "shopee", provider_account_id: "shop" },
];
function harness({ provider = "shopee", action = "sync", refreshMode = "deferred" } = {}) {
  let click;
  let finishPermission;
  let finishPreparation;
  let detections = 0;
  const requests = [];
  const results = [];
  const refreshes = [];
  const button = { dataset: { action }, addEventListener: (_event, handler) => { click = handler; } };
  const scope = vm.createContext({
    syncButton: button, storedConfig: { accounts }, activeProviderAdapter: { id: provider }, pendingAction: "",
    progressArea: {}, status: { classList: { remove() {} } },
    renderDashboard() {}, setStatusAppearance() {}, openConfig() {},
    accountOrigins: config => config.accounts,
    requestTargetPermission: () => new Promise(resolve => { finishPermission = resolve; }),
    detectAccount: async () => { detections += 1; }, refreshStoredState: async () => {},
    popupTabId: 7, crypto: { randomUUID: () => "request" }, t: key => key,
    chrome: {
      runtime: { sendMessage: message => {
        requests.push(message);
        if (message.type === "refresh_metadata") {
          if (refreshMode === "failed") return Promise.reject(new Error("Provider unavailable"));
          if (refreshMode === "partial") return Promise.resolve({ ok: true, partial: true, customer_count: 10 });
          return new Promise(resolve => refreshes.push(resolve));
        }
        return Promise.resolve({ ok: true });
      } },
      tabs: { sendMessage: message => { requests.push(message); return new Promise(resolve => { finishPreparation = resolve; }); } },
    },
    showSyncResult: async result => results.push(result),
  });
  vm.runInContext(handlerSource, scope);
  return { scope, requests, refreshes, results, click: () => click(),
    allowPermission: () => finishPermission(), finishPreparation: () => finishPreparation({ ok: true }),
    cancel: () => vm.runInContext("syncActionId += 1", scope), get detections() { return detections; } };
}

for (const provider of ["shopee", "line_oa"]) {
  test(`manual ${provider} sync refreshes exactly its configured scope after permission and before sync`, async () => {
    const h = harness({ provider });
    const task = h.click();
    assert.equal(h.requests.length, 0);
    h.allowPermission();
    await turn();
    const expected = provider === "line_oa" ? accounts.slice(0, 2) : accounts;
    assert.deepEqual(h.requests.map(value => value.provider_account_id), expected.map(value => value.provider_account_id));
    assert.ok(h.requests.every(value => value.type === "refresh_metadata"));
    assert.equal(h.results.length, 0);
    h.refreshes.forEach(resolve => resolve({ ok: true }));
    await task;
    const sync = h.requests.at(-1);
    assert.equal(sync.type, "sync_now");
    assert.equal(sync.provider, provider === "line_oa" ? "line_oa" : undefined);
    assert.equal(h.results.length, 1);
  });
}

for (const refreshMode of ["failed", "partial"]) {
  test(`metadata ${refreshMode} does not block message sync or replace its result`, async () => {
    const h = harness({ refreshMode });
    const task = h.click();
    h.allowPermission();
    await task;
    assert.equal(h.requests.at(-1).type, "sync_now");
    assert.equal(h.results.length, 1);
    assert.equal(h.results[0].ok, true);
  });
}

test("cancel or newer action during metadata refresh cannot launch a delayed sync", async () => {
  const h = harness();
  const task = h.click();
  h.allowPermission();
  await turn();
  h.cancel();
  h.refreshes.forEach(resolve => resolve({ ok: true }));
  await task;
  assert.equal(h.requests.some(value => value.type === "sync_now"), false);
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
  assert.doesNotMatch(source, /Refresh account & customer info|รีเฟรชข้อมูลบัญชีและลูกค้า/);
  const autoStart = source.slice(source.indexOf("async function autoStartSync("), source.indexOf("async function load()"));
  assert.doesNotMatch(autoStart, /refresh_metadata/);
});
