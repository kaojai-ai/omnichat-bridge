import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { accountOrigins } from "../extension/lib/config.js";
import { regionalShopeeOrigins } from "../extension/lib/regional-permissions.js";

const popup = await readFile(new URL("../extension/popup.js", import.meta.url), "utf8");
const personal = await readFile(new URL("../extension/line-personal-client.js", import.meta.url), "utf8");

test("Sync checks grants without requesting permission after asynchronous work", async () => {
  let granted = true, prompts = 0, renders = 0;
  const scope = vm.createContext({ URL, chrome: { permissions: {
    contains: async ({ origins }) => { assert.deepEqual(Array.from(origins), ["https://server.example/*"]); return granted; },
    request: () => { prompts++; throw Error("Sync must never prompt"); },
  } }, renderRegionalAccess: () => { renders++; } });
  vm.runInContext(popup.slice(popup.indexOf("async function checkTargetPermission("), popup.indexOf("function setStatusAppearance(")), scope);
  await scope.checkTargetPermission(["wss://server.example/live", "https://server.example/events"]);
  granted = false;
  await assert.rejects(scope.checkTargetPermission(["https://server.example/events"]), /Allow server access/);
  assert.equal(prompts, 0);
  assert.equal(renders, 1);
});

for (const provider of [null, "shopee"]) {
  test(`missing access buttons remain usable with ${provider ?? "unknown"} provider`, async () => {
    const buttons = [], requests = [];
    const container = { replaceChildren() { buttons.length = 0; }, append: button => buttons.push(button) };
    const config = { accounts: [
      { provider: "shopee", country: "MY", events_url: "https://shop.example/events" },
      { provider: "line_personal", events_url: "https://personal.example/events" },
    ] };
    const scope = vm.createContext({ URL, storedConfig: config, activeProviderAdapter: provider && { id: provider },
      regionalShopeeOrigins, accountOrigins, language: "en", consented: () => true, t: (_key, country) => country,
      globalThis: { OmnichatShopeeUrl: { countryForUrl: url => url.includes("shopee") ? "MY" : null } },
      document: { querySelector: () => container, createElement: () => ({ addEventListener(_event, callback) { this.click = callback; } }) },
      chrome: { permissions: { contains: async () => false, request: args => { requests.push(args); return Promise.resolve(false); } },
        runtime: { sendMessage: () => assert.fail("Denied access must not affect runtime") } },
      refreshStoredState() {}, reportPopupError: () => assert.fail("Unexpected error"),
    });
    vm.runInContext(popup.slice(popup.indexOf("async function renderRegionalAccess("), popup.indexOf("const emptyConfig =")), scope);
    await scope.renderRegionalAccess();
    assert.ok(buttons.some(button => button.textContent === "MY"), "regional grant is discoverable before tab URL access");
    if (provider) assert.ok(buttons.every(button => !button.textContent.includes("personal.example")));
    buttons.find(button => button.textContent.includes("shop.example")).click();
    assert.deepEqual(Array.from(requests[0].origins), ["https://shop.example/*"], "grant is requested immediately for only the selected origin");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(config.accounts.length, 2);
  });
}

for (const granted of [false, true]) {
  test(`LINE Connect requests only LINE hosts before awaiting consent; grant=${granted}`, async () => {
    let click, requested = false, starts = 0;
    const scope = vm.createContext({ session: null, AbortController, Date, scope: "setup",
      ui: { connect: { addEventListener: (_event, handler) => { click = handler; } }, disconnect: {} },
      chrome: { permissions: { request: ({ origins }) => {
        requested = true;
        assert.deepEqual(Array.from(origins), ["https://legy.line-apps.com/*", "https://gf.line.naver.jp/*", "https://obs.line-apps.com/*"]);
        return Promise.resolve(granted);
      } } },
      requireConsent: async () => { assert.equal(requested, true); return true; }, report() {}, changed() {},
      navigator: { locks: { request: async (_key, _options, callback) => callback({}) } },
      start: async () => { starts++; },
    });
    vm.runInContext(personal.slice(personal.indexOf('ui.connect.addEventListener("click"'), personal.indexOf('ui.disconnect.addEventListener')), scope);
    const task = click();
    assert.equal(requested, true);
    await task;
    assert.equal(starts, granted ? 1 : 0);
    assert.equal(Boolean(scope.session), granted);
  });
}
