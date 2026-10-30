import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const popup = await readFile(new URL("../extension/popup.js", import.meta.url), "utf8");
const start = popup.indexOf("async function retryAccount(account) {");
const end = popup.indexOf("\nasync function copyProviderAccountId", start);
assert.ok(start >= 0 && end > start);

function harness(result) {
  const requests = [];
  const configs = [];
  const account = { provider: "line_oa", provider_account_id: "@failed" };
  const context = {
    accountConfigKey: (item) => `${item.provider}:${item.provider_account_id}`,
    retryingAccounts: new Set(), accountRetryErrors: new Map(),
    storedConfig: { accounts: [{ provider_account_id: "@healthy" }, account] },
    findAccountConfig: (_config, item) => item,
    accountOrigins: (config) => { configs.push(config); return []; },
    requestTargetPermission: async () => {},
    chrome: { runtime: { sendMessage: async (message) => { requests.push(message); return result; } } },
    renderDashboard() {}, refreshStoredState: async () => {}, reportPopupError() {},
  };
  vm.createContext(context);
  vm.runInContext(`${popup.slice(start, end)}\nthis.retryAccount = retryAccount;`, context);
  return { context, account, requests, configs };
}

test("row retry targets only the failed LINE account and leaves other accounts untouched", async () => {
  const { context, account, requests, configs } = harness({ ok: true });
  await context.retryAccount(account);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].type, "sync_account");
  assert.equal(requests[0].provider_account_id, "@failed");
  assert.equal(requests[0].refresh_metadata, true);
  assert.equal(configs[0].accounts.length, 1);
  assert.equal(configs[0].accounts[0], account);
  assert.equal(context.storedConfig.accounts.length, 2);
  assert.equal(context.retryingAccounts.size, 0);
});

test("row retry failure settles loading and records an error only for that account", async () => {
  const { context, account } = harness({ ok: false, error: "Access check timed out" });
  await context.retryAccount(account);
  assert.equal(context.retryingAccounts.size, 0);
  assert.equal(context.accountRetryErrors.size, 1);
  assert.equal(context.accountRetryErrors.get("line_oa:@failed").message, "Access check timed out");
  assert.equal(context.accountRetryErrors.has("line_oa:@healthy"), false);
});

test("row retry surfaces recovery errors even when the runtime envelope succeeded", async () => {
  const { context, account } = harness({ ok: true, error: "Recovery failed" });
  await context.retryAccount(account);
  assert.equal(context.accountRetryErrors.get("line_oa:@failed").message, "Recovery failed");
  assert.equal(context.retryingAccounts.size, 0);
});
