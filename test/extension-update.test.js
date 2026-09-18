import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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

test("shows a compact, translated update state beside the manifest version", () => {
  assert.match(html, /id="version"/);
  assert.match(html, /id="update-extension"/);
  assert.match(popupSource, /upToDate: "Up to date"/);
  assert.match(popupSource, /updateNow: "Update now"/);
  assert.match(popupSource, /updatingExtension: "Updating…"/);
  assert.match(popupSource, /upToDate: "เป็นเวอร์ชันล่าสุด"/);
  assert.match(popupSource, /updateNow: "อัปเดตตอนนี้"/);
  assert.match(popupSource, /updateExtensionButton\.textContent = "Latest"/);
  assert.match(css, /\.update-extension \{[\s\S]*padding: 0 3px;/);
  assert.match(popupSource, /STORAGE\.extensionUpdate/);
});

test("uses Chrome's update lifecycle with bounded checks and queued restart", () => {
  assert.match(backgroundSource, /const UPDATE_CHECK_CACHE_MS = 6 \* 60 \* 60_000/);
  assert.match(backgroundSource, /const UPDATE_RETRY_DELAY_MS = 5 \* 60_000/);
  assert.match(backgroundSource, /chrome\.runtime\.requestUpdateCheck\(\)/);
  assert.match(backgroundSource, /chrome\.runtime\.onUpdateAvailable\.addListener/);
  assert.match(backgroundSource, /await activeSync\?\.catch/);
  assert.match(backgroundSource, /await exclusive\(async \(\) => \{\n    chrome\.runtime\.reload\(\);/);
  assert.match(popupSource, /type: "check_extension_update"/);
  assert.match(popupSource, /type: "apply_extension_update"/);
});

test("acknowledges successful provider replies before releasing the restart queue", () => {
  const start = backgroundSource.indexOf("async function handleLiveCommand(raw, context, socket)");
  const end = backgroundSource.indexOf("\n}\n\nchrome.storage.onChanged", start);
  const handler = backgroundSource.slice(start, end);
  assert.match(handler, /await exclusive\(async \(\) => \{/);
  assert.match(handler, /socket\.send\(JSON\.stringify\(\{[\s\S]*ok: true/);
  assert.match(manifest, /"version": "0\.6\.32"/);
});
