import vm from "node:vm";
import { selectableProviders } from "../extension/lib/provider-navigation.js";
import { createAccountSyncCoordinator } from "../extension/lib/sync-coordinator.js";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [html, css, popupSource, backgroundSource] = await Promise.all([
  readFile(new URL("../extension/popup.html", import.meta.url), "utf8"),
  readFile(new URL("../extension/popup.css", import.meta.url), "utf8"),
  readFile(new URL("../extension/popup.js", import.meta.url), "utf8"),
  readFile(new URL("../extension/background.js", import.meta.url), "utf8"),
]);

test("replaces the accounts heading with a provider selector", () => {
  assert.match(html, /<details id="provider-selector" class="provider-selector">/);
  assert.match(html, /<summary id="detected-shops-title"><img id="selected-provider-logo"/);
  assert.match(html, /id="selected-provider-name"/);
  assert.match(html, /id="provider-options"/);
  assert.doesNotMatch(html, /class="provider-link provider-link-line"/);
  assert.match(css, /\.provider-selector summary/);
});

for (const configuredPersonal of [false, true]) {
  test(`provider selector ${configuredPersonal ? "includes configured" : "hides unconfigured"} LINE Personal without an active provider tab`, async () => {
    const nodes = new Map();
    const element = () => ({ children: [], handlers: {}, setAttribute() {},
      replaceChildren() { this.children = []; }, append(...children) { this.children.push(...children); },
      addEventListener(event, callback) { this.handlers[event] = callback; } });
    const adapters = [{ id: "shopee", displayName: "Shopee" }, { id: "line_oa", displayName: "LINE OA" },
      { id: "line_personal", displayName: "LINE Personal" }];
    const accounts = [{ provider: "shopee" }, ...(configuredPersonal ? [{ provider: "line_personal" }] : [])];
    const activations = [];
    const scope = vm.createContext({
      document: { querySelector(id) { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); }, createElement: element },
      providerAdapters: { list: () => adapters }, storedConfig: { accounts }, activeProviderAdapter: null,
      selectableProviders, activateProvider: async adapter => activations.push(adapter.id), chrome: {},
      renderDashboard() { throw new Error("Provider activation should succeed"); },
    });
    const start = popupSource.indexOf("function renderProviderSelector(");
    vm.runInContext(popupSource.slice(start, popupSource.indexOf("// One row layout", start)), scope);
    scope.renderProviderSelector();
    assert.equal(nodes.get("#selected-provider-name").textContent, "SHOPEE");
    const options = nodes.get("#provider-options").children;
    assert.deepEqual(options.map(button => button.children[1].textContent), configuredPersonal
      ? ["LINE OA", "LINE Personal"] : ["LINE OA"]);
    options.at(-1).handlers.click();
    await Promise.resolve();
    assert.deepEqual(activations, [configuredPersonal ? "line_personal" : "line_oa"]);
    assert.equal(nodes.get("#provider-selector").open, false);
  });
}

test("detects the account from the tab that opened the popup", () => {
  assert.match(popupSource, /type: "detect_account",\n      tab_id: popupTabId/);
  assert.match(
    backgroundSource,
    /detectOpenProviderAccount\(message\?\.provider \|\| shopeeAdapter\.id, message\?\.tab_id\)/,
  );
  assert.match(backgroundSource, /async function providerChatTabById\(adapter, tabId\)/);
  assert.match(backgroundSource, /const hasPreferredTab = preferredTabId !== null && preferredTabId !== undefined;/);
});

for (const provider of ["shopee", "line_oa"]) {
  test(`manual ${provider} sync selects only currently accessible configured accounts`, async () => {
    const contexts = ["shopee", "line_oa"].flatMap(id => ["A", "B", "C"].map(account => ({
      key: `${id}:${account}`, adapter: { id }, config: {}, account: { provider: id, provider_account_id: account },
    })));
    const tab = { id: 42, url: "https://provider.example/chat" };
    const syncCoordinator = createAccountSyncCoordinator();
    const calls = [];
    const scope = vm.createContext({ manualBridgeRepair: null, AbortController, syncCoordinator, accountSyncs: syncCoordinator.jobs,
      providerAdapterForId: id => ({ id }), providerChatTabById: async () => tab,
      providerTabContext: () => "verified-session", ensureProviderBridge: async () => {},
      detectOpenProviderAccount: async () => ({ ok: true }),
      providerTabStatus: async () => ({ current_provider_account_id: "B", account_access_verified: true,
        accessible_account_ids: ["A", "B", "unconfigured"] }),
      readStorage: async () => ({}), STORAGE: {}, hasLocalConsent: () => true,
      configuredAccountContexts: () => contexts, providerAccountMatchesTab: () => true,
      accountContextFor: (_stored, id, kind) => contexts.find(context => context.key === `${kind}:${id}`),
      preemptAutomaticLogUpload() {}, throwIfSyncCancelled() {}, exactProviderAccountTab: async () => tab,
      manualSyncTab: async (_context, tabId, options) => {
        assert.equal(tabId, 42);
        assert.equal(options.verified_context, "verified-session");
        return { tab, epoch: "verified-session" };
      },
      queueLiveStateWrite: fn => fn(), writeStorage: async () => {},
      ensureLiveConnection: async () => {}, recordUnexpected: async () => {},
      runAccountSync: async (trigger, control, context) => {
        calls.push({ key: context.key, trigger, tab: control.lockedTabId, shared: control.sharedSession });
        return { recovered: 1 };
      },
    });
    const extract = (start, end) => backgroundSource.slice(backgroundSource.indexOf(start), backgroundSource.indexOf(end, backgroundSource.indexOf(start)));
    vm.runInContext(extract("function requestAccountSync(", "async function retryProviderAccount(")
      + extract("async function syncAccountsForTab(", "async function resumeSync("), scope);
    const result = await scope.syncAccountsForTab(provider, 42, "manual");
    assert.equal(result.ok, true);
    assert.equal(result.partial, false);
    assert.deepEqual(calls, (provider === "shopee" ? ["B"] : ["A", "B"]).map(id => ({
      key: `${provider}:${id}`, trigger: "manual", tab: 42, shared: provider === "line_oa",
    })));
    assert.equal(syncCoordinator.jobs.size, 0);
  });
}

test("shows only configured LINE accounts or the account in the open tab", () => {
  assert.match(popupSource, /from "\.\/lib\/popup-accounts\.js"/);
  assert.match(popupSource, /function bestEffortAccounts\(storedAccounts, tabUrl = ""\)/);
  assert.match(popupSource, /detectedAccounts = bestEffortAccounts\(/);
  assert.match(popupSource, /hydrateDetectedAccounts\(/);
});

test("gates the popup on local consent and clears it with erase all data", () => {
  assert.match(popupSource, /function routeTo\(target\)/);
  assert.match(popupSource, /if \(!consented\(\) && screen !== "consent" && screen !== "privacy"\)/);
  assert.match(popupSource, /storedConsent = null;/);
  assert.match(popupSource, /await chrome\.runtime\.sendMessage\(\{ type: "erase_local_data" \}\)/);
  assert.match(popupSource, /routeTo\("consent"\);/);
  assert.match(popupSource, /if \(!consented\(\)\) \{\n    routeTo\("consent"\);\n    return;\n  \}/);
});

test("hydrates saved accounts and sync status before live detection returns", () => {
  assert.match(popupSource, /STORAGE\.detectedAccounts,/);
  assert.match(popupSource, /detectedAccounts = bestEffortAccounts\(stored\[STORAGE\.detectedAccounts\], activeTab\?\.url\);/);
  assert.match(popupSource, /from "\.\/lib\/popup-sync-progress\.js"/);
  assert.match(popupSource, /syncProgressPresentation\(readAccountState\(storedStatus/);
});

test("links a detected LINE account name to its LINE Chat page", () => {
  assert.match(popupSource, /function lineChatUrl\(account\)/);
  assert.match(popupSource, /https:\/\/chat\.line\.biz\/\$\{encodeURIComponent\(botId\)\}/);
  assert.match(popupSource, /const name = document\.createElement\(lineUrl \? "a" : "strong"\)/);
  assert.match(popupSource, /name\.target = "_blank"/);
  assert.match(css, /\.account-row-line-link/);
});

test("offers an account-scoped discard action beside pending messages", () => {
  assert.match(popupSource, /className = "account-row-pending"/);
  assert.match(popupSource, /type: "discard_pending"/);
  assert.match(popupSource, /provider_account_id: providerAccountId/);
  assert.match(popupSource, /skips older messages for this account and cannot be undone/);
});

test("offers to open Shopee Webchat mini before sync", () => {
  assert.match(popupSource, /item\.account\.provider === "shopee" && item\.live\?\.provider_chat_open === false/);
  assert.match(popupSource, /syncButton\.dataset\.action = sellerCentreChatClosed \? "open_webchat_mini" : "sync"/);
  assert.match(popupSource, /\? t\("openWebchat"\)/);
  assert.match(popupSource, /syncButton\.dataset\.action === "open_webchat_mini"/);
  assert.match(popupSource, /type: "prepare_provider_v3"/);
  assert.match(popupSource, /await detectAccount\(\)/);
});

test("keeps unattended provider recovery opt-in and runs through one health alarm", () => {
  assert.match(html, /class="language-switch" role="group" aria-label="Language"/);
  assert.match(html, /id="language-en"[^>]*data-language="en"/);
  assert.match(html, /id="language-th"[^>]*data-language="th"/);
  assert.match(html, /class="settings-preferences"/);
  assert.equal((html.match(/class="settings-preference(?:\s|")/g) || []).length, 1);
  assert.match(html, /id="unattended-recovery-label"/);
  assert.match(html, /class="toggle-track"/);
  assert.match(html, /id="unattended-recovery"/);
  assert.match(popupSource, /STORAGE\.unattendedRecovery/);
  assert.match(popupSource, /button\.setAttribute\("aria-pressed", String\(selected\)\)/);
  assert.match(popupSource, /writeStorage\(\{ \[STORAGE\.language\]: language \}\)/);
  assert.match(backgroundSource, /const PROVIDER_HEALTH_ALARM = "omnichat-provider-health"/);
  assert.match(backgroundSource, /async function runProviderHealthWatchdog\(\)/);
  assert.match(backgroundSource, /function providerRecoveryUrl\(adapter, account\)/);
  assert.match(backgroundSource, /adapter\.chatUrlForAccount\(account\)/);
  assert.match(backgroundSource, /chrome\.tabs\.create\(\{ url: chatUrl, active: false \}\)/);
  assert.match(backgroundSource, /STORAGE\.providerRecoveryTabs/);
  assert.match(backgroundSource, /providerRecoveryTabLocks/);
  assert.match(backgroundSource, /async function clearProviderRecoveryLiveState\(\)/);
  assert.match(backgroundSource, /markClosedProviderRecoveryTab\(tabId\)/);
  assert.match(backgroundSource, /providerTabHealthy\(status, adapter\)/);
  assert.match(backgroundSource, /last_provider_check_at/);
  assert.doesNotMatch(backgroundSource, /provider_tab_reloaded/);
  assert.match(backgroundSource, /provider_tab_redirected/);
  assert.match(backgroundSource, /startUnattendedProviderSync\(tab, context\)/);
  assert.match(backgroundSource, /type: "sync_now_v3"/);
  assert.match(backgroundSource, /providerAutomaticRetryAt/);
});

test("shows a lightweight shell before popup state finishes loading", () => {
  const loadStart = popupSource.indexOf("async function load()");
  const loadEnd = popupSource.indexOf("\nconsentInput.addEventListener", loadStart);
  const loadSource = popupSource.slice(loadStart, loadEnd);

  assert.match(html, /id="loading-screen" class="loading-screen"/);
  assert.match(html, /id="consent-screen" class="screen" hidden/);
  assert.match(popupSource, /const \[stored, \[activeTab\]\] = await Promise\.all\(\[/);
  assert.match(popupSource, /readStorage\(\[/);
  assert.match(popupSource, /chrome\.tabs\.query\(\{ active: true, currentWindow: true \}\)/);
  assert.match(popupSource, /void installationId\(\)\.then/);
  assert.match(popupSource, /void detectAccount\(\)\.catch/);
  assert.doesNotMatch(loadSource, /STORAGE\.logs/);
  assert.match(popupSource, /async function loadLogs\(\)/);
  assert.match(popupSource, /changes\[STORAGE\.logs\] && !logsScreen\.hidden/);
});

for (const ownsLeadership of [false, true]) {
  test(`${ownsLeadership ? "releases" : "claims"} leadership for the account row only`, async () => {
    let click;
    const requests = [];
    const leader = { append() {}, setAttribute() {}, addEventListener(_event, callback) { click = callback; }, dataset: {} };
    const account = { provider: "line_personal", provider_account_id: "personal-account" };
    const scope = vm.createContext({
      document: { createElement: tag => tag === "button" ? leader : {} },
      readAccountState: () => ({ leader_installation_id: "browser", leader: ownsLeadership }),
      liveState: {}, accountConfigKey: () => "line_personal:personal-account", account, id: account.provider_account_id,
      name: { textContent: "Personal" }, popupTabId: 42, t: value => value,
      chrome: { runtime: { sendMessage: async request => { requests.push(request); return { ok: true }; } } },
      renderDashboard() { throw new Error("Leadership update should succeed"); },
    });
    const start = popupSource.indexOf("  const live = readAccountState(liveState, accountConfigKey(account), null);", popupSource.indexOf("function renderAccountRow("));
    vm.runInContext(popupSource.slice(start, popupSource.indexOf("  copy.append(heading, statusLabel);", start)), scope);
    await click();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].type, ownsLeadership ? "release_leader" : "claim_leader");
    assert.equal(requests[0].provider, "line_personal");
    assert.equal(requests[0].provider_account_id, "personal-account");
    assert.equal(requests[0].tab_id, 42);
    assert.equal(leader.disabled, false);
  });
}
