import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { accountConfigKey, findAccountConfig, validateConfigFile } from "../extension/lib/config.js";

const source = await readFile(new URL("../extension/popup.js", import.meta.url), "utf8");
const start = source.indexOf("async function changeAccountConfiguration(");
const end = source.indexOf("async function copyProviderAccountId", start);
function harness({ confirmDelete = true, writeError = null } = {}) {
  const account = { provider: "shopee", provider_account_id: "one", events_url: "https://example.com/events",
    api_url: "https://example.com/api", hmac_secret: "secret" };
  const other = { ...account, provider_account_id: "two" };
  const storage = { config: { version: 3, history_days: 30, accounts: [account, other] },
    pending: ["saved message"], checkpoint: { watermark: "saved cursor" }, serverInitialized: true };
  const writes = [];
  const messages = [];
  const scope = vm.createContext({ changingAccountConfig: false, storedConfig: { version: 3, accounts: [] },
    STORAGE: { config: "config" }, readStorage: async () => storage,
    configOrEmpty: value => value, validateConfigFile, accountConfigKey, configInput: {},
    confirm: () => confirmDelete, t: key => key,
    writeStorage: async value => { if (writeError) throw new Error(writeError); writes.push(value); Object.assign(storage, value); },
    refreshStoredState: async () => {}, renderDashboard: (...args) => messages.push(args), reportPopupError() {},
  });
  vm.runInContext(source.slice(start, end), scope);
  return { scope, account, other, storage, writes, messages };
}

test("on/off controls persist the current saved JSON and retain other accounts and local data", async () => {
  const h = harness();
  await h.scope.changeAccountConfiguration(h.account, "toggle");
  assert.equal(h.storage.config.accounts[0].enabled, false);
  assert.equal(h.storage.config.accounts[1].provider_account_id, "two");
  assert.equal(h.storage.config.accounts[1].enabled, undefined);
  assert.equal(h.storage.config.history_days, 30);
  assert.deepEqual(Object.keys(h.writes[0]), ["config"]);
  assert.equal(JSON.parse(h.scope.configInput.value).accounts[0].enabled, false);
  await h.scope.changeAccountConfiguration(h.account, "toggle");
  assert.equal(h.storage.config.accounts[0].enabled, true);
  assert.deepEqual(h.storage.pending, ["saved message"]);
  assert.deepEqual(h.storage.checkpoint, { watermark: "saved cursor" });
  assert.equal(h.storage.serverInitialized, true);
});

test("delete removes only the selected configuration after confirmation", async () => {
  const h = harness();
  await h.scope.changeAccountConfiguration(h.account, "delete");
  assert.deepEqual(h.storage.config.accounts.map(account => account.provider_account_id), ["two"]);
  assert.equal(h.storage.config.history_days, 30);
  assert.deepEqual(Object.keys(h.writes[0]), ["config"]);
  assert.deepEqual(h.storage.pending, ["saved message"]);
  assert.deepEqual(h.storage.checkpoint, { watermark: "saved cursor" });
  const cancelled = harness({ confirmDelete: false });
  await cancelled.scope.changeAccountConfiguration(cancelled.account, "delete");
  assert.equal(cancelled.writes.length, 0);
});

test("failed account edits keep the saved configuration and surface the error", async () => {
  const h = harness({ writeError: "Storage unavailable" });
  await h.scope.changeAccountConfiguration(h.account, "toggle");
  assert.equal(h.storage.config.accounts[0].enabled, undefined);
  assert.equal(h.scope.changingAccountConfig, false);
  assert.deepEqual(h.messages.at(-1), ["Storage unavailable", true]);
});

test("disabled row status overrides stale healthy or syncing state", () => {
  const account = { provider: "shopee", provider_account_id: "one", enabled: false };
  const scope = vm.createContext({ storedConfig: { accounts: [account] }, accountConfigKey, findAccountConfig, t: key => key });
  const start = source.indexOf("function accountRowStatus(");
  vm.runInContext(source.slice(start, source.indexOf("async function retryAccount", start)), scope);
  const state = scope.accountRowStatus(account);
  assert.equal(state.label, "accountOff");
  assert.equal(state.loading, undefined);
  assert.equal(state.action, undefined);
});


test("access-denied row offers manual recovery even while its live socket is connected", () => {
  const account = { provider: "shopee", provider_account_id: "one" };
  for (const denial of ["stored", "live"]) {
    const storedStatus = {};
    const liveState = {};
    const scope = vm.createContext({ storedConfig: { accounts: [account] }, accountConfigKey, findAccountConfig,
      storedStatus, liveState, t: key => key,
      readAccountState: state => state === storedStatus ? { account_access_denied: denial === "stored" }
        : { socket: "connected", send_ready: true, receive_reason_code: denial === "live" ? "provider_access_denied" : "healthy" },
    });
    const start = source.indexOf("function accountRowStatus(");
    vm.runInContext(source.slice(start, source.indexOf("async function retryAccount", start)), scope);
    const state = scope.accountRowStatus(account);
    assert.equal(state.label, "accountAccessDenied");
    assert.equal(state.state, "error");
    assert.equal(state.hint, "accountAccessDeniedHint");
    assert.equal(state.accessDenied, true);
  }
});
