import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { syncProgressPresentation } from "../extension/lib/popup-sync-progress.js";

const source = readFileSync(new URL("../extension/popup.js", import.meta.url), "utf8");
const rendering = source.slice(source.indexOf("function createAccountActionIcon("), source.indexOf("function renderDashboard("));
function element(tag) {
  return { tag, children: [], dataset: {}, attributes: {}, handlers: {}, classList: { add() {} },
    append(...children) { this.children.push(...children); }, replaceChildren() { this.children = []; },
    setAttribute(key, value) { this.attributes[key] = value; },
    addEventListener(event, handler) { this.handlers[event] = handler; },
  };
}
const flatten = root => [root, ...root.children.flatMap(flatten)];

for (const provider of ["line_oa", "shopee"]) {
  test(`${provider} compact row retains accessible scoped actions and safe unknown progress`, () => {
    const account = { provider, provider_account_id: "account-one", display_name: "Account One" };
    const list = element("div");
    const calls = [];
    let syncing = true;
    const syncState = {};
    const pendingState = {};
    const scanState = {};
    const scope = vm.createContext({
      document: { createElement: element, createElementNS: (_namespace, tag) => element(tag) },
      popupAccountsForSession: accounts => accounts,
      detectedAccounts: [account], liveState: {}, pageAccounts: [], accountList: list,
      accountListEmpty: element("div"), detectingAccount: false, activeProviderAdapter: { id: provider },
      adapterForAccount: () => ({ id: provider }), accountLabel: () => provider === "line_oa" ? "LINE OA" : "Shop",
      accountDisplayLabel: candidate => candidate.display_name,
      accountRowStatus: () => ({ label: syncing ? "Loading messages…" : "FAILED", state: syncing ? "neutral" : "error", loading: syncing }),
      lineChatUrl: () => provider === "line_oa" ? "https://chat.line.biz/account-one" : null,
      syncProgressPresentation, storedStatus: syncState, pendingStates: pendingState, scanStates: scanState,
      accountConfigKey: candidate => `${candidate.provider}:${candidate.provider_account_id}`,
      readAccountState: (state, _key, fallback) => state === pendingState ? ["one", "two"]
        : state === syncState ? { state: syncing ? "syncing" : "error", phase: "fetching_messages" } : fallback,
      retryingAccounts: new Set(), createCopyIcon: () => element("svg"), copyProviderAccountId: () => {},
      retryAccount: candidate => calls.push(["retry", candidate]),
      discardPending: (candidate, _button, count) => calls.push(["discard", candidate, count]),
      t: (key, count) => key === "retry" ? "Retry now" : key === "pending" ? `${count} pending` : key,
    });
    vm.runInContext(rendering, scope);
    scope.renderDetectedAccounts();
    let nodes = flatten(list);
    const bar = nodes.find(node => node.tag === "progress");
    assert.ok(bar, "both providers expose row progress");
    assert.equal(bar.value, undefined, "unknown work uses an indeterminate bar");
    assert.equal(bar.attributes["aria-label"], "Loading messages…");
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
  });
}
