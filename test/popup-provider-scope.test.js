import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [html, css, popupSource, backgroundSource] = await Promise.all([
  readFile(new URL("../extension/popup.html", import.meta.url), "utf8"),
  readFile(new URL("../extension/popup.css", import.meta.url), "utf8"),
  readFile(new URL("../extension/popup.js", import.meta.url), "utf8"),
  readFile(new URL("../extension/background.js", import.meta.url), "utf8"),
]);

test("opens LINE Chat from the provider landing screen", () => {
  assert.match(
    html,
    /<a class="provider-link provider-link-line" href="https:\/\/chat\.line\.biz\/" target="_blank" rel="noreferrer"><span>LINE Official Account<\/span><small>Open Chat<\/small><\/a>/,
  );
  assert.doesNotMatch(html, /LINE Official Account<\/span><small>Coming soon<\/small>/);
  assert.match(css, /\.provider-link-line \{ background: #06c755; \}/);
});

test("detects the account from the tab that opened the popup", () => {
  assert.match(popupSource, /type: "detect_account",\n      tab_id: popupTabId/);
  assert.match(
    backgroundSource,
    /detectOpenProviderAccount\(message\?\.provider \|\| shopeeAdapter\.id, message\?\.tab_id\)/,
  );
  assert.match(backgroundSource, /async function providerChatTabById\(adapter, tabId\)/);
  assert.match(backgroundSource, /const hasPreferredTab = preferredTabId !== null && preferredTabId !== undefined;/);
});

test("keeps manual sync scoped to every configured detected account", () => {
  const start = backgroundSource.indexOf("async function runUnifiedSync(trigger, control)");
  const end = backgroundSource.indexOf("\n}\n\nasync function resumeSync", start);
  assert.ok(start >= 0);
  assert.ok(end > start);
  const syncSource = backgroundSource.slice(start, end);
  assert.match(syncSource, /const contexts = configuredAccountContexts\(stored\);/);
  assert.match(syncSource, /for \(const context of contexts\)/);
  assert.match(syncSource, /runAccountSync\(trigger, control, context\)/);
});

test("shows only configured LINE accounts or the account in the open tab", () => {
  assert.match(popupSource, /function visibleDetectedAccounts\(accounts, activeTabUrl = ""\)/);
  assert.match(popupSource, /Boolean\(findAccountConfig\(storedConfig, account\)\)/);
  assert.match(popupSource, /String\(account\.bot_id \?\? ""\)\.trim\(\) === openLineBotId/);
  assert.match(popupSource, /detectedAccounts = visibleDetectedAccounts\(providerAccounts, activeTab\?\.url\)/);
});

test("labels a detected LINE account with its provider and display name", () => {
  assert.match(popupSource, /return `LINE OA: \$\{displayName\}`/);
  assert.match(popupSource, /name\.textContent = accountDisplayLabel\(account, adapter\)/);
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
  assert.match(css, /\.discard-pending-link/);
});
