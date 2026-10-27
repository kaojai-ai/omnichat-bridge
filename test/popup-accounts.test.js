import assert from "node:assert/strict";
import test from "node:test";

import {
  activeSyncAccount,
  currentTabAccount,
  configuredProviderAccounts,
  popupAccountsForSession,
  hydrateDetectedAccounts,
  visibleDetectedAccounts,
} from "../extension/lib/popup-accounts.js";
import "./../extension/lib/provider-adapters.js";
import "./../extension/lib/line-oa.js";
import "./../extension/lib/shopee-url.js";
import "./../extension/lib/shopee-adapter.js";

const lineConfig = {
  version: 3,
  accounts: [{
    provider: "line_oa",
    provider_account_id: "@exampleoa",
    bot_id: "bot-1",
    display_name: "Example OA",
    events_url: "https://example.com/events",
    api_url: "https://example.com/api",
    hmac_secret: "secret",
  }],
};

test("seeds configured accounts for the active provider", () => {
  assert.deepEqual(configuredProviderAccounts(lineConfig, "line_oa"), [{
    provider: "line_oa",
    provider_account_id: "@exampleoa",
    bot_id: "bot-1",
    display_name: "Example OA",
  }]);
  assert.deepEqual(configuredProviderAccounts(lineConfig, "shopee"), []);
});

test("keeps configured accounts visible before live detection finishes", () => {
  const accounts = hydrateDetectedAccounts({
    storedAccounts: [],
    config: lineConfig,
    providerId: "line_oa",
    activeTabUrl: "https://chat.line.biz/bot-1/",
  });
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].provider_account_id, "@exampleoa");
  assert.equal(accounts[0].display_name, "Example OA");
});

test("retains cached display metadata over configured seeds", () => {
  const accounts = hydrateDetectedAccounts({
    storedAccounts: [{
      provider: "line_oa",
      provider_account_id: "@exampleoa",
      bot_id: "bot-1",
      display_name: "Live name",
      detected_at: "2026-09-11T00:00:00.000Z",
    }],
    config: lineConfig,
    providerId: "line_oa",
    activeTabUrl: "https://chat.line.biz/bot-1/",
  });
  assert.equal(accounts[0].display_name, "Live name");
});

test("shows an unconfigured LINE account only when its chat tab is open", () => {
  const detected = [{
    provider: "line_oa",
    provider_account_id: "@other",
    bot_id: "bot-2",
  }];
  assert.deepEqual(
    visibleDetectedAccounts(detected, lineConfig, "https://chat.line.biz/bot-2/"),
    detected,
  );
  assert.deepEqual(
    visibleDetectedAccounts(detected, lineConfig, "https://chat.line.biz/bot-1/"),
    [],
  );
});

test("popup hides inactive configuration while retaining multiple accessible LINE accounts", () => {
  const accounts = [
    { provider: "shopee", provider_account_id: "old" },
    { provider: "shopee", provider_account_id: "current" },
    { provider: "line_oa", provider_account_id: "@one" },
    { provider: "line_oa", provider_account_id: "@two" },
  ];
  const live = { version: 2, accounts: {
    "shopee:current": { active_in_profile: true },
    "line_oa:@one": { active_in_profile: true },
    "line_oa:@two": { active_in_profile: true },
  } };
  assert.deepEqual(popupAccountsForSession(accounts, live), accounts.slice(1));
  assert.deepEqual(popupAccountsForSession(accounts, null), []);
});


test("shows active Shopee first and only the current page as an inactive shop", () => {
  const accounts = [
    { provider: "shopee", provider_account_id: "never-opened" },
    { provider: "shopee", provider_account_id: "page" },
    { provider: "shopee", provider_account_id: "active" },
    { provider: "shopee", provider_account_id: "historical" },
  ];
  const live = { version: 2, accounts: { "shopee:active": { active_in_profile: true } } };
  assert.deepEqual(popupAccountsForSession(accounts, live, [accounts[1]]), [accounts[2], accounts[1]]);
  assert.deepEqual(popupAccountsForSession(accounts, live, [accounts[2]]), [accounts[2]]);
  assert.deepEqual(popupAccountsForSession(accounts, null, [accounts[1]]), [accounts[1]]);
  assert.deepEqual(accounts.map((account) => account.provider_account_id), ["never-opened", "page", "active", "historical"]);
});


test("LINE shows only verified access, not configuration or the stale current page", () => {
  const accounts = ["@one", "@two", "@three"].map((provider_account_id) => ({ provider: "line_oa", provider_account_id }));
  const live = { version: 2, accounts: {
    "line_oa:@one": { active_in_profile: true },
    "line_oa:@two": { active_in_profile: false },
  } };
  assert.deepEqual(popupAccountsForSession(accounts, live, accounts), [accounts[0]]);
  assert.deepEqual(popupAccountsForSession(accounts, null, accounts), []);
});

test("an accessible LINE account remains visible when its sync fails", () => {
  const accounts = ["@one", "@two"].map((provider_account_id) => ({ provider: "line_oa", provider_account_id }));
  const live = { version: 2, accounts: {
    "line_oa:@one": { active_in_profile: true, socket: "connected" },
    "line_oa:@two": { active_in_profile: true, provider_recovery_state: "needs_attention" },
  } };
  assert.deepEqual(popupAccountsForSession(accounts, live), accounts);
});

test("accounts with explicit session problems stay visible without becoming active", () => {
  const reasons = ["waiting_for_tab", "checking_session", "wrong_account", "needs_attention"];
  for (const provider of ["line_oa", "shopee"]) {
    const accounts = reasons.map((reason, index) => ({ provider, provider_account_id: String(index) }));
    const live = { version: 2, accounts: Object.fromEntries(accounts.map((account, index) => [
      `${provider}:${account.provider_account_id}`, { active_in_profile: false, eligibility_reason_code: reasons[index] },
    ])) };
    assert.deepEqual(popupAccountsForSession(accounts, live), accounts);
    assert.ok(Object.values(live.accounts).every(state => state.active_in_profile === false));
  }
});


test("a manually refreshed stored name stays visible after reopening the popup", () => {
  const accounts = hydrateDetectedAccounts({
    storedAccounts: [{ provider: "line_oa", provider_account_id: "@exampleoa", bot_id: "bot-1", display_name: "Refreshed OA" }],
    config: lineConfig, providerId: "line_oa", activeTabUrl: "https://chat.line.biz/bot-1/",
  });
  assert.equal(accounts[0].display_name, "Refreshed OA");
});

test("combined sync reports LINE progress while popup only detects Shopee", () => {
  const config = { accounts: [
    { provider: "shopee", provider_account_id: "1", display_name: "Shop" },
    { provider: "line_oa", provider_account_id: "@line", display_name: "LINE Shop" },
  ] };
  const progress = activeSyncAccount(config, [config.accounts[0]], { version: 2, accounts: {
    "shopee:1": { state: "watching" },
    "line_oa:@line": { state: "syncing", phase: "checking_conversations", completed_conversations: 7 },
  } }, {});
  assert.equal(progress.account.display_name, "LINE Shop");
  assert.equal(progress.syncState.completed_conversations, 7);
  assert.equal(activeSyncAccount(config, [], {}, {}), null);
});

test("current LINE tab selects its bot rather than every accessible account", () => {
  const accounts = [
    { provider: "line_oa", provider_account_id: "@one", bot_id: "bot-one" },
    { provider: "line_oa", provider_account_id: "@two", bot_id: "bot-two" },
  ];
  const config = { accounts };
  assert.equal(currentTabAccount(config, accounts, "line_oa", "https://chat.line.biz/bot-two/chats"), accounts[1]);
  assert.equal(currentTabAccount(config, accounts, "line_oa", "https://chat.line.biz/"), null);
  assert.equal(currentTabAccount(config, accounts, "line_oa", "https://chat.line.biz/unknown/chats"), null);
});
test("Shopee current tab requires one unambiguous configured detected account", () => {
  const account = { provider: "shopee", provider_account_id: "shop" };
  assert.equal(currentTabAccount({ accounts: [account] }, [account], "shopee", ""), account);
  assert.equal(currentTabAccount({ accounts: [] }, [account], "shopee", ""), null);
  assert.equal(currentTabAccount({ accounts: [account] }, [account, account], "shopee", ""), null);
});
