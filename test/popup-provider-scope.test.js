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
  assert.match(popupSource, /from "\.\/lib\/popup-accounts\.js"/);
  assert.match(popupSource, /function bestEffortAccounts\(storedAccounts, tabUrl = ""\)/);
  assert.match(popupSource, /detectedAccounts = bestEffortAccounts\(/);
  assert.match(popupSource, /hydrateDetectedAccounts\(/);
});

test("gates the popup on local consent and clears it with erase all data", () => {
  assert.match(popupSource, /function routeTo\(target\)/);
  assert.match(popupSource, /if \(!consented\(\) && screen !== "consent" && screen !== "privacy"\)/);
  assert.match(popupSource, /storedConsent = null;/);
  assert.match(popupSource, /await chrome\.storage\.local\.clear\(\);/);
  assert.match(popupSource, /routeTo\("consent"\);/);
  assert.match(popupSource, /if \(!consented\(\)\) \{\n    routeTo\("consent"\);\n    return;\n  \}/);
});

test("hydrates saved accounts and sync status before live detection returns", () => {
  assert.match(popupSource, /STORAGE\.detectedAccounts,/);
  assert.match(popupSource, /detectedAccounts = bestEffortAccounts\(stored\[STORAGE\.detectedAccounts\], activeTab\?\.url\);/);
  assert.match(popupSource, /from "\.\/lib\/popup-sync-progress\.js"/);
  assert.match(popupSource, /syncProgressPresentation\(progressState\)/);
});

test("shows provider badges and account names separately", () => {
  assert.match(html, /<h2 id="account-title">Provider<\/h2>/);
  assert.match(html, /id="provider-badges" class="provider-badges"/);
  assert.match(popupSource, /badge\.dataset\.provider = provider/);
  assert.match(popupSource, /function providerBadgeLabel\(provider, adapter\)/);
  assert.match(popupSource, /if \(provider === "line_oa"\) return "LINE"/);
  assert.match(popupSource, /if \(provider === "shopee"\) return "Shopee"/);
  assert.match(css, /\.provider-badge\[data-provider="line_oa"\] \{ background: #06c755; \}/);
  assert.match(css, /\.provider-badge\[data-provider="shopee"\] \{ background: var\(--shopee\); \}/);
  assert.match(popupSource, /return `LINE OA: \$\{displayName\}`/);
  assert.match(popupSource, /return `Shop: \$\{displayName\}`/);
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

test("offers to open Shopee Webchat mini before sync", () => {
  assert.match(popupSource, /const canOpenSellerCentreChat = activeProviderSurface === "seller-centre"/);
  assert.match(popupSource, /syncButton\.disabled = !canOpenSellerCentreChat/);
  assert.match(popupSource, /canOpenSellerCentreChat \? t\("openWebchat"\) : t\("sync"\)/);
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
  assert.match(backgroundSource, /async function resetProviderRecoveryTabs\(\)/);
  assert.match(backgroundSource, /markClosedProviderRecoveryTab\(tabId\)/);
  assert.match(backgroundSource, /providerTabHealthy\(status, adapter\)/);
  assert.match(backgroundSource, /last_provider_check_at/);
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

test("changes leader status only for the active provider", () => {
  assert.match(popupSource, /\{ type: "release_leader", provider: activeProviderAdapter\?\.id \}/);
  assert.match(popupSource, /\{ type: "claim_leader", provider: activeProviderAdapter\?\.id, tab_id: popupTabId \}/);
});
