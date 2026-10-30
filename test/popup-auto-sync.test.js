import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { currentTabSyncAccounts } from "../extension/lib/popup-accounts.js";

const html = await readFile(new URL("../extension/popup.html", import.meta.url), "utf8");
const source = await readFile(new URL("../extension/popup.js", import.meta.url), "utf8");

test("uses unattended recovery as the only automatic provider control", () => {
  const optionIndex = html.indexOf('id="unattended-recovery-option"');
  const syncIndex = html.indexOf('id="sync"');
  assert.ok(optionIndex >= 0);
  assert.ok(syncIndex > optionIndex);
  assert.doesNotMatch(html, /id="auto-open-chat"/);
  assert.doesNotMatch(html, /Open chat and sync automatically/);
});

test("persists unattended recovery without a Shopee-only preference", () => {
  assert.match(source, /STORAGE\.unattendedRecovery/);
  assert.doesNotMatch(source, /STORAGE\.autoOpenSellerCentreChat/);
});

test("loads the LINE adapter in the popup context", () => {
  const providerRegistryImport = source.indexOf('import "./lib/provider-adapters.js";');
  const lineAdapterImport = source.indexOf('import "./lib/line-oa.js";');
  assert.ok(providerRegistryImport >= 0);
  assert.ok(lineAdapterImport > providerRegistryImport);
});

for (const provider of ["shopee", "line_oa"]) {
  test(`config save starts scoped ${provider} sync only after fresh account detection`, async () => {
    const account = { provider, provider_account_id: "account" };
    let available = [account];
    const requests = [];
    const context = vm.createContext({
      isProviderChatTab: true, popupTabId: 7, currentTabSyncAccounts,
      providerAdapters: { forPage: () => ({ id: provider }) },
      chrome: { tabs: { get: async () => ({ id: 7, url: "https://provider.example/chat" }) },
        runtime: { sendMessage: async message => {
          requests.push(message);
          return message.type === "detect_account" ? { ok: true, accounts: available } : { ok: true };
        } } },
      reportConfigurationStatus: () => { throw Error("Unexpected failure"); },
    });
    const start = source.indexOf("async function autoStartSync(config) {");
    vm.runInContext(source.slice(start, source.indexOf("async function load()", start)), context);
    assert.equal(await context.autoStartSync({ accounts: [account] }), true);
    assert.deepEqual(requests.map(message => message.type), ["detect_account", provider === "line_oa" ? "sync_line_tab" : "sync_account"]);
    assert.equal(requests[1].tab_id, 7);
    if (provider === "shopee") {
      assert.equal(requests[1].provider, provider);
      assert.equal(requests[1].provider_account_id, "account");
    }
    requests.length = 0;
    available = [];
    await assert.rejects(context.autoStartSync({ accounts: [account] }), /does not include any detected/);
    assert.deepEqual(requests.map(message => message.type), ["detect_account"]);
  });
}
