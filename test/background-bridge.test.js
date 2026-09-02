import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");
const manifest = JSON.parse(await readFile(new URL("../extension/manifest.json", import.meta.url), "utf8"));

test("does not reload provider tabs when the content bridge is unavailable", () => {
  assert.doesNotMatch(source, /chrome\.tabs\.reload\s*\(/);
  assert.match(source, /content_unready/);
  assert.match(source, /Refresh the tab manually and try again/);
});

test("reattaches an invalidated content bridge without refreshing the provider page", () => {
  assert.match(source, /async function reinjectProviderBridge\(/);
  assert.match(source, /async function reattachOpenProviderBridges\(/);
  assert.match(source, /chrome\.scripting\.executeScript/);
  assert.match(source, /world: "MAIN"/);
  assert.match(source, /world: "ISOLATED"/);
  assert.match(source, /bridge_reinjected/);
  assert.match(source, /void reattachOpenProviderBridges\(\)\.catch/);
  assert.match(source, /existing\.socket\?\.readyState === WebSocket\.OPEN/);
  assert.match(source, /sendConnectionStatus\(existing\.socket, context\)/);
  assert.ok(manifest.permissions.includes("scripting"));
});

test("bounds the provider sync handoff when a page reload interrupts its response", () => {
  assert.match(source, /PROVIDER_SYNC_RESPONSE_TIMEOUT_MS = 90_000/);
  assert.match(source, /PROVIDER_STATUS_RESPONSE_TIMEOUT_MS = 5_000/);
  assert.match(source, /function sendProviderMessage\(/);
  assert.match(source, /providerMessageTimeout\(label, operation\)/);
  assert.match(source, /sendProviderMessage\(tab\.id, \{[\s\S]*type: "sync_now"/);
  assert.match(source, /type: "get_provider_status"[\s\S]*timeoutMs: PROVIDER_STATUS_RESPONSE_TIMEOUT_MS/);
});

test("resets a stale page-side recovery before reinjection and retries an overlapping sync", () => {
  assert.match(source, /async function resetProviderRecovery\(/);
  assert.match(source, /window\.__omnichatRealtimeBridgeControl/);
  assert.match(source, /Recovery is already running\./);
  assert.match(source, /operation: "retry sync request"/);
  assert.match(source, /state\.recoveryAbortController\?\.abort\(\)/);
});

test("resumes an interrupted sync after the service worker restarts", () => {
  assert.match(source, /async function resumeInterruptedSync\(/);
  assert.match(source, /scanState\?\.in_progress === true/);
  assert.match(source, /\["discovering", "syncing"\]\.includes\(status\?\.state\)/);
  assert.match(source, /void resumeInterruptedSync\(\)\.catch/);
});
