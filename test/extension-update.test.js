import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const [readme, html, css, popupSource, backgroundSource, manifest] = await Promise.all([
  readFile(new URL("../README.md", import.meta.url), "utf8"),
  readFile(new URL("../extension/popup.html", import.meta.url), "utf8"),
  readFile(new URL("../extension/popup.css", import.meta.url), "utf8"),
  readFile(new URL("../extension/popup.js", import.meta.url), "utf8"),
  readFile(new URL("../extension/background.js", import.meta.url), "utf8"),
  readFile(new URL("../extension/manifest.json", import.meta.url), "utf8"),
]);

const storeUrl = "https://chromewebstore.google.com/detail/omnichat-bridge/blfmmjdpjoimhnahjbcfimclhgmkjhkn";

test("links the README and title to the Chrome Web Store without changing title color", () => {
  assert.match(readme, new RegExp(`\\(${storeUrl.replaceAll("/", "\\/")}\\)`));
  assert.match(html, new RegExp(`<a class="store-link" href="${storeUrl}" target="_blank" rel="noreferrer">Omnichat Bridge<\\/a>`));
  assert.match(html, new RegExp(`<a id="version" href="${storeUrl}" target="_blank" rel="noreferrer"><\\/a>`));
  assert.match(html, /<a class="ok-production-link" href="https:\/\/okproduction\.co\.th" target="_blank" rel="noreferrer">OK Production Co\.?, Ltd\.<\/a>/);
  assert.match(css, /\.store-link \{[\s\S]*color: inherit;[\s\S]*cursor: pointer;/);
  assert.match(css, /\.store-link:hover \{ color: inherit; \}/);
  assert.match(css, /\.store-link:focus-visible/);
});

function fakeElement() {
  return {
    setAttribute(key, value) { this[key] = value; },
    removeAttribute(key) { delete this[key]; },
  };
}

test("footer update action follows the installed version and clears stale state", () => {
  const version = fakeElement();
  const nodeVersion = fakeElement();
  const button = fakeElement();
  const label = fakeElement();
  button.querySelector = () => label;
  const installed = JSON.parse(manifest).version;
  const scope = vm.createContext({
    chrome: { runtime: { getManifest: () => ({ version: installed }) } },
    document: { querySelector: selector => selector === "#node-version" ? nodeVersion : version }, updateExtensionButton: button,
    t: key => ({ upToDate: "Up to date", updateNow: "Update now", updatingExtension: "Updating…" })[key],
  });
  const start = popupSource.indexOf("function renderExtensionUpdate(");
  vm.runInContext(popupSource.slice(start, popupSource.indexOf("const TRANSLATIONS", start)), scope);
  const render = update => scope.renderExtensionUpdate({ installed_version: installed, ...update });
  render({ status: "available", available_version: "99.0.0" });
  assert.equal(version.textContent, `v${installed}`);
  assert.equal(nodeVersion.textContent, version.textContent);
  assert.equal(button.hidden, false);
  assert.equal(button.disabled, false);
  assert.equal(label.textContent, "Update now");
  assert.equal(button["data-state"], "available");
  assert.match(button.title, /v99\.0\.0/);
  assert.equal(button["aria-label"], "Update now");
  render({ status: "updating" });
  assert.equal(button.hidden, false);
  assert.equal(button.disabled, true);
  assert.equal(label.textContent, "Updating…");
  assert.equal(button["data-state"], "updating");
  render({ status: "current", checked_at: "2026-10-26T01:00:00Z" });
  assert.equal(button.hidden, true, "current installs have no redundant update action");
  assert.match(version.title, /Up to date/);
  assert.equal(button["aria-label"], undefined);
  render({ status: "available", installed_version: "stale-version", available_version: "99.0.0" });
  assert.equal(button.hidden, true, "cached results for an older install cannot offer an update");
  assert.equal(version.title, undefined);
  assert.equal(version.textContent, `v${installed}`);
  const footer = html.match(/<footer>[\s\S]*?<\/footer>/)?.[0];
  assert.ok(footer);
  assert.match(footer, /id="version"/);
  assert.match(footer, /id="update-extension"/);
  assert.equal((html.match(/id="update-extension"/g) || []).length, 1);
});

test("unnamed node uses a translated browser label and clears the previous name", () => {
  const badge = fakeElement();
  const scope = vm.createContext({ deviceNameBadge: badge, storedDeviceName: "Desk browser",
    normalizeDeviceName: value => String(value || "").trim(), t: key => key === "thisBrowser" ? "เบราว์เซอร์นี้" : key });
  const start = popupSource.indexOf("function renderDeviceNameBadge()");
  vm.runInContext(popupSource.slice(start, popupSource.indexOf("function setConfigStatus", start)), scope);
  scope.renderDeviceNameBadge();
  assert.equal(badge.textContent, "Desk browser");
  assert.match(badge.title, /Desk browser/);
  scope.storedDeviceName = " ";
  scope.renderDeviceNameBadge();
  assert.equal(badge.hidden, false);
  assert.equal(badge.textContent, "เบราว์เซอร์นี้");
  assert.equal(badge.title, "");
  assert.doesNotMatch(badge["aria-label"], /Desk browser/);
});

test("uses Chrome's update lifecycle with bounded checks and queued restart", () => {
  assert.match(backgroundSource, /const UPDATE_CHECK_CACHE_MS = 6 \* 60 \* 60_000/);
  assert.match(backgroundSource, /const UPDATE_RETRY_DELAY_MS = 5 \* 60_000/);
  assert.match(backgroundSource, /chrome\.runtime\.requestUpdateCheck\(\)/);
  assert.match(backgroundSource, /chrome\.runtime\.onUpdateAvailable\.addListener/);
  assert.match(backgroundSource, /await syncCoordinator\.drain\(\)/);
  assert.match(backgroundSource, /await exclusive\(async \(\) => \{\s+chrome\.runtime\.reload\(\);/);
  assert.match(popupSource, /type: "check_extension_update"/);
  assert.match(popupSource, /type: "apply_extension_update"/);
});

test("acknowledges successful provider replies before releasing the restart queue", () => {
  const start = backgroundSource.indexOf("async function handleLiveCommand(raw, context, socket)");
  const end = backgroundSource.indexOf("\n}\n\nchrome.storage.onChanged", start);
  const handler = backgroundSource.slice(start, end);
  assert.match(handler, /replyQueue\.run\(context\.key, async \(\) => \{/);
  assert.match(handler, /acknowledge\(\{[\s\S]*ok: true/);
});
