import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { syncProgressPresentation } from "../extension/lib/popup-sync-progress.js";

const source = readFileSync(new URL("../extension/popup.js", import.meta.url), "utf8");
const labels = source.slice(source.indexOf("function accountLabel("), source.indexOf("function logPopup("));
const rendering = source.slice(source.indexOf("function createAccountActionIcon("), source.indexOf("function renderDashboard("));
function element(tag) {
  return { tag, children: [], dataset: {}, attributes: {}, handlers: {}, classList: { add() {} },
    append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; },
    setAttribute(key, value) { this.attributes[key] = value; },
    addEventListener(event, handler) { this.handlers[event] = handler; },
  };
}
const flatten = root => [root, ...root.children.flatMap(flatten)];

for (const provider of ["line_oa", "shopee"]) {
  test(`${provider} compact row retains accessible scoped actions and safe unknown progress`, () => {
    const account = { provider, provider_account_id: "account-one", display_name: "Account One", bot_id: "account-one" };
    const list = element("div");
    const calls = [];
    let syncing = true;
    let supportsRecovery = true;
    const syncState = {};
    const pendingState = {};
    const scanState = {};
    const scope = vm.createContext({
      document: { createElement: element, createElementNS: (_namespace, tag) => element(tag) },
      popupAccountsForSession: accounts => accounts,
      detectedAccounts: [account], liveState: {}, pageAccounts: [], accountList: list,
      accountListEmpty: element("div"), detectingAccount: false, activeProviderAdapter: { id: provider },
      adapterForAccount: () => ({ id: provider, displayName: provider === "shopee" ? "Shopee Seller Chat" : "LINE Official Account", accountName: provider === "line_oa" ? "LINE OA" : "Shop", supports: capability => supportsRecovery && capability === "message_recovery" }),
      accountRowStatus: () => ({ label: syncing ? "Loading…" : "Sync failed", state: syncing ? "neutral" : "error", loading: syncing, hint: syncing ? "" : "History request returned 401. Check the provider login.", action: syncing ? undefined : "logs" }),
      lineChatUrl: () => provider === "line_oa" ? "https://chat.line.biz/account-one" : null,
      syncProgressPresentation, storedStatus: syncState, pendingStates: pendingState, scanStates: scanState,
      accountConfigKey: candidate => `${candidate.provider}:${candidate.provider_account_id}`,
      readAccountState: (state, _key, fallback) => state === pendingState ? ["one", "two"]
        : state === syncState ? { state: syncing ? "syncing" : "error", phase: "fetching_messages" } : fallback,
      storedConfig: {}, findAccountConfig: () => account, metadataRefreshes: new Map(), metadataRefreshResults: new Map(),
      retryingAccounts: new Set(), createCopyIcon: () => element("svg"), copyProviderAccountId: () => {},
      openLogs: level => calls.push(["logs", level]),
      retryAccount: candidate => calls.push(["retry", candidate]),
      discardPending: (candidate, _button, count) => calls.push(["discard", candidate, count]),
      t: (key, count) => key === "retry" ? "Retry now" : key === "pending" ? `${count} pending` : key,
    });
    vm.runInContext(labels + rendering, scope);
    scope.renderDetectedAccounts();
    let nodes = flatten(list);
    const badge = nodes.find(node => node.className === "provider-badge");
    const name = nodes.find(node => node.textContent === "Account One");
    assert.ok(badge, "the account row identifies its provider");
    assert.equal(badge.textContent, provider === "line_oa" ? "LINE" : "SHOPEE");
    assert.equal(badge.dataset.provider, provider);
    assert.ok(name, "the saved account name has no automatic provider prefix");
    assert.ok(nodes.indexOf(badge) < nodes.indexOf(name), "provider badge precedes the account name");
    if (provider === "line_oa") {
      assert.equal(name.href, "https://chat.line.biz/account-one");
      assert.equal(name.target, "_blank");
    }
    const bar = nodes.find(node => node.tag === "progress");
    assert.ok(bar, "both providers expose row progress");
    assert.equal(bar.value, undefined, "unknown work uses an indeterminate bar");
    assert.equal(bar.attributes["aria-label"], "Loading…");
    const actionButtons = nodes.filter(node => node.className === "account-action");
    assert.equal(actionButtons.length, 2);
    assert.equal(actionButtons.find(node => /Retry/.test(node.attributes["aria-label"])).disabled, false,
      "a stuck loading row can still request a guarded retry");
    assert.equal(actionButtons.find(node => /Discard/.test(node.attributes["aria-label"])).disabled, true,
      "pending data cannot be discarded during sync");
    scope.retryingAccounts.add(`${provider}:account-one`);
    scope.renderDetectedAccounts();
    assert.equal(flatten(list).find(node => /Retry/.test(node.attributes?.["aria-label"] ?? "")).disabled, true);
    scope.retryingAccounts.clear();
    assert.ok(actionButtons.some(node => node.attributes["aria-label"] === "Retry now: Account One"));
    assert.ok(actionButtons.some(node => /Discard 2 pending messages/.test(node.attributes["aria-label"])));
    syncing = false;
    scope.renderDetectedAccounts();
    nodes = flatten(list);
    assert.ok(nodes.some(node => node.textContent === "Account One"), "account name is retained");
    for (const button of nodes.filter(node => node.className === "account-action")) {
      assert.equal(button.disabled, false);
      button.handlers.click();
    }
    assert.deepEqual(calls, [["retry", account], ["discard", account, 2]]);
    const failure = nodes.find(node => node.textContent === "Sync failed");
    assert.equal(failure.dataset.state, "error");
    assert.equal(failure.dataset.loading, "false");
    assert.equal(failure.title, "History request returned 401. Check the provider login. · Open error logs");
    failure.handlers.click({ preventDefault() {}, stopPropagation() {} });
    assert.deepEqual(calls.at(-1), ["logs", "error"]);
    supportsRecovery = false;
    scope.renderDetectedAccounts();
    const unavailableActions = flatten(list).filter(node => node.className === "account-action");
    assert.equal(unavailableActions.some(node => /Retry/.test(node.attributes["aria-label"])), false,
      "providers without message recovery never offer an unsupported retry");
    assert.equal(unavailableActions.some(node => /Discard/.test(node.attributes["aria-label"])), true,
      "local pending-data actions remain available independently of recovery capability");
  });
}


function metadataHarness() {
  const account = { provider: "shopee", provider_account_id: "shop-a", display_name: "Shop A" };
  const list = element("div");
  const requests = [];
  let finish;
  let reloads = 0;
  const scope = vm.createContext({
    document: { createElement: element, createElementNS: (_namespace, tag) => element(tag) },
    popupAccountsForSession: accounts => accounts,
    detectedAccounts: [account], liveState: {}, pageAccounts: [], accountList: list,
    accountListEmpty: element("div"), detectingAccount: false, activeProviderAdapter: { id: "shopee" },
    adapterForAccount: () => ({ id: "shopee", displayName: "Shopee", accountName: "Shop", supports: () => true }),
    accountRowStatus: () => ({ label: "READY", state: "ready", loading: false }),
    lineChatUrl: () => null, syncProgressPresentation, storedStatus: {}, pendingStates: {}, scanStates: {},
    accountConfigKey: candidate => `${candidate.provider}:${candidate.provider_account_id}`,
    readAccountState: (_state, _key, fallback) => fallback,
    storedConfig: {}, findAccountConfig: () => account,
    metadataRefreshes: new Map(), metadataRefreshResults: new Map(), retryingAccounts: new Set(),
    createCopyIcon: () => element("svg"), copyProviderAccountId: () => {},
    chrome: { runtime: { sendMessage: message => { requests.push(message); return new Promise(resolve => { finish = resolve; }); } } },
    refreshStoredState: async () => { reloads += 1; },
    t: (key, count) => ({ refreshMetadata: "Refresh account & customer info", refreshingMetadata: "Refreshing info…",
      metadataRefreshed: `Refreshed ${count} recent customers.`, metadataPartial: "Some info could not be refreshed.",
      metadataOlder: "Up to 100 recent conversations; older customers may remain unchanged.",
      metadataRefreshFailed: "Could not refresh info. Cached info was kept." }[key] ?? key),
  });
  const refreshStart = source.indexOf("async function refreshAccountMetadata(account) {");
  const refreshEnd = source.indexOf("async function copyProviderAccountId", refreshStart);
  vm.runInContext(labels + rendering + source.slice(refreshStart, refreshEnd), scope);
  scope.renderDashboard = () => scope.renderDetectedAccounts();
  scope.renderDetectedAccounts();
  return { scope, account, requests, finish: value => finish(value), get reloads() { return reloads; },
    nodes: () => flatten(list), button: () => flatten(list).find(node => node.className === "account-metadata-refresh") };
}

test("manual metadata action coalesces clicks and shows progress independently of readiness", async () => {
  const h = metadataHarness();
  assert.equal(h.button().textContent, "Refresh account & customer info");
  const first = h.scope.refreshAccountMetadata(h.account);
  const second = h.scope.refreshAccountMetadata(h.account);
  await Promise.resolve();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].type, "refresh_metadata");
  assert.equal(h.requests[0].provider_account_id, "shop-a");
  assert.equal(h.button().disabled, true);
  assert.equal(h.button().textContent, "Refreshing info…");
  assert.equal(h.nodes().find(node => node.className === "account-row-status").textContent, "READY");
  h.finish({ ok: true, account_refreshed: true, customer_count: 10, partial: false });
  await Promise.all([first, second]);
  assert.equal(h.button().disabled, false);
  assert.equal(h.reloads, 1);
  const outcome = h.nodes().find(node => node.className === "account-metadata-result");
  assert.match(outcome.textContent, /Refreshed 10 recent customers/);
  assert.match(outcome.textContent, /older customers may remain unchanged/);
  assert.equal(h.scope.retryingAccounts.size, 0);
});

for (const [name, result, expected] of [
  ["partial", { ok: true, account_refreshed: true, customer_count: 25, partial: true }, /Some info could not be refreshed/],
  ["failure", { ok: false, error: "Sensitive provider detail" }, /Could not refresh info. Cached info was kept/],
]) {
  test(`metadata ${name} settles its own result without changing the ready status`, async () => {
    const h = metadataHarness();
    const task = h.scope.refreshAccountMetadata(h.account);
    await Promise.resolve();
    h.finish(result);
    await task;
    const outcome = h.nodes().find(node => node.className === "account-metadata-result");
    assert.match(outcome.textContent, expected);
    assert.doesNotMatch(outcome.textContent, /Sensitive provider detail/);
    assert.equal(h.button().disabled, false);
    assert.equal(h.nodes().find(node => node.className === "account-row-status").dataset.state, "ready");
    assert.equal(h.scope.retryingAccounts.size, 0);
  });
}
