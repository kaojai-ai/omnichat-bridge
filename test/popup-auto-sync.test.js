import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const html = await readFile(new URL("../extension/popup.html", import.meta.url), "utf8");
const source = await readFile(new URL("../extension/popup.js", import.meta.url), "utf8");

test("shows an opt-in Seller Centre landing sync control above the manual sync action", () => {
  const optionIndex = html.indexOf('id="auto-sync-option"');
  const syncIndex = html.indexOf('id="sync"');
  assert.ok(optionIndex >= 0);
  assert.ok(syncIndex > optionIndex);
  assert.match(html, /id="auto-open-chat" type="checkbox"/);
  assert.match(html, /Open chat and sync automatically/);
});

test("persists the landing preference and asks the active Seller Centre tab to apply it", () => {
  assert.match(source, /STORAGE\.autoOpenSellerCentreChat/);
  assert.match(source, /type: "auto_open_chat_and_sync_v3"/);
});

test("loads the LINE adapter in the popup context", () => {
  const providerRegistryImport = source.indexOf('import "./lib/provider-adapters.js";');
  const lineAdapterImport = source.indexOf('import "./lib/line-oa.js";');
  assert.ok(providerRegistryImport >= 0);
  assert.ok(lineAdapterImport > providerRegistryImport);
});
