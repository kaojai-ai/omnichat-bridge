import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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
