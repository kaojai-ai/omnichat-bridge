import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import "../extension/lib/provider-adapters.js";
import { LINE_PERSONAL_ORIGINS } from "../extension/lib/line-personal.js";
import { permissionPatterns } from "../extension/lib/permission-patterns.js";
import { accountOrigins } from "../extension/lib/config.js";

const popup = await readFile(new URL("../extension/popup.js", import.meta.url), "utf8");
const personal = await readFile(new URL("../extension/line-personal-client.js", import.meta.url), "utf8");

const permissionHelpers = popup.slice(popup.indexOf("function requestTargetPermission("), popup.indexOf("function setStatusAppearance("));

test("Sync checks grants without requesting permission after asynchronous work", async () => {
  let granted = true;
  const scope = vm.createContext({ permissionPatterns, t: key => key, chrome: { permissions: {
    contains: async ({ origins }) => { assert.deepEqual(Array.from(origins), ["https://server.example/*"]); return granted; },
    request: () => assert.fail("Permission checks must never prompt"),
  } } });
  vm.runInContext(permissionHelpers, scope);
  await scope.checkTargetPermission(["wss://server.example/live", "https://server.example/events"]);
  granted = false;
  await assert.rejects(scope.checkTargetPermission(["https://server.example/events"]), /serverAccessNeeded/);
});

for (const outcome of ["declined", "granted", "rejected", "thrown"]) {
  test(`Save configuration persists independently of permission: ${outcome}`, async () => {
    const changes = [];
    let finishPermission;
    let status;
    let click;
    const button = { addEventListener: (_event, handler) => { click = handler; } };
    const config = { accounts: [
      { provider: "shopee", country: "MY", events_url: "https://shop.example/events", commands_url: "wss://shop.example/live", image_server_url: "https://images.example" },
      { provider: "shopee", country: "PH", enabled: false, events_url: "https://disabled.example" },
    ] };
    const scope = vm.createContext({
      permissionPatterns, accountOrigins, storedConfig: { accounts: [] }, STORAGE: { config: "config" },
      document: { querySelector: () => button }, configInput: { value: JSON.stringify(config) }, deviceNameInput: { value: "Device" },
      t: key => key, validateConfigFile: value => value, normalizeDeviceName: value => value,
      renderProviderSelector() {}, renderDeviceNameBadge() {}, logPopup() {}, renderConfigEditor() {}, setConfigStatus: (...args) => { status = args; },
      writeStorage: async values => { changes.push("save"); assert.deepEqual(JSON.parse(JSON.stringify(values.config)), config); },
      autoStartSync: async () => { changes.push("sync"); return true; },
      chrome: { permissions: { request: ({ origins }) => {
        changes.push("request");
        assert.deepEqual(Array.from(origins), ["https://shop.example/*", "https://images.example/*"]);
        if (outcome === "thrown") throw new Error("Permission API unavailable");
        return new Promise((resolve, reject) => {
          finishPermission = () => outcome === "rejected"
            ? reject(new Error("Permission API unavailable"))
            : resolve(outcome === "granted");
        });
      } } },
    });
    const handler = popup.slice(popup.indexOf('document.querySelector("#save-config").addEventListener'), popup.indexOf('document.querySelector("#import-config").addEventListener'));
    vm.runInContext(permissionHelpers + handler, scope);
    const task = click({ currentTarget: button });
    assert.deepEqual(changes, ["request", "save"], "save starts without waiting for the permission result");
    finishPermission?.();
    await task;
    assert.deepEqual(changes, outcome === "granted" ? ["request", "save", "sync"] : ["request", "save"]);
    if (outcome === "rejected" || outcome === "thrown") {
      assert.deepEqual(status, ["Configuration saved. Permission API unavailable", true]);
    }
    assert.equal(button.disabled, false);
  });
}

for (const granted of [false, true]) {
  test(`LINE Connect requests access before awaiting consent; grant=${granted}`, async () => {
    let click, requested = false, starts = 0;
    const scope = vm.createContext({ session: null, AbortController, Date, scope: "setup",
      LINE_PERSONAL_ORIGINS, permissionPatterns,
      ui: { connect: { addEventListener: (_event, handler) => { click = handler; } }, disconnect: {} },
      chrome: { permissions: { request: ({ origins }) => {
        requested = true;
        assert.deepEqual(Array.from(origins), ["https://legy.line-apps.com/*", "https://obs.line-apps.com/*"]);
        return Promise.resolve(granted);
      } } },
      requireConsent: async () => { assert.equal(requested, true); return true; }, report() {}, changed() {},
      navigator: { locks: { request: async (_key, _options, callback) => callback({}) } },
      start: async () => { starts++; },
    });
    vm.runInContext(personal.slice(personal.indexOf("function requestLinePersonalAccess"), personal.indexOf("function waitForReconnect")), scope);
    vm.runInContext(personal.slice(personal.indexOf('ui.connect.addEventListener("click"'), personal.indexOf('ui.disconnect.addEventListener')), scope);
    const task = click();
    assert.equal(requested, true);
    await task;
    assert.equal(starts, granted ? 1 : 0);
    assert.equal(Boolean(scope.session), granted);
  });
}


test("LINE Personal server permission scope excludes LINE transport hosts", () => {
  const origins = accountOrigins({ accounts: [{ provider: "line_personal", events_url: "https://bridge.example/events" }] });
  assert.deepEqual(origins, ["https://bridge.example/events"]);
});
