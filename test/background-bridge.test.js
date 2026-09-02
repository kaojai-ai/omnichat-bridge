import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

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

test("keeps connection status compatible with the server's strict version 1 envelope", () => {
  const statusStart = source.indexOf("async function connectionStatusSnapshot(");
  const statusEnd = source.indexOf("\n}\n\nasync function sendConnectionStatus", statusStart);
  assert.ok(statusStart >= 0);
  assert.ok(statusEnd > statusStart);
  const statusSource = source.slice(statusStart, statusEnd);
  assert.match(statusSource, /schema: "omnichat\.connection_status"/);
  assert.match(statusSource, /version: 1/);
  assert.match(statusSource, /health,/);
  assert.doesNotMatch(statusSource, /provider_surface:/);
  assert.doesNotMatch(statusSource, /provider_capabilities:/);
  assert.doesNotMatch(statusSource, /provider_realtime_transport:/);
});

test("does not redeclare page bridge dependencies during reattachment", () => {
  assert.match(source, /hasUrl: Boolean\(globalThis\.OmnichatShopeeUrl\)/);
  assert.match(source, /hasShopeeAdapter: Boolean\(globalThis\.OmnichatProviderAdapters\?\.get\?\.\("shopee"\)\)/);
  assert.match(source, /const mainFiles = \[/);
  assert.match(source, /const isolatedFiles = \[/);
  assert.match(source, /\.\.\.\(mainStatus\.hasUrl \? \[\] : \["lib\/shopee-url\.js"\]\)/);
  assert.match(source, /\.\.\.\(isolatedStatus\.hasShopee \? \[\] : \["lib\/shopee\.js"\]\)/);
});

test("bounds the provider sync handoff when a page reload interrupts its response", () => {
  assert.match(source, /PROVIDER_SYNC_RESPONSE_TIMEOUT_MS = 90_000/);
  assert.match(source, /PROVIDER_STATUS_RESPONSE_TIMEOUT_MS = 5_000/);
  assert.match(source, /function sendProviderMessage\(/);
  assert.match(source, /providerMessageTimeout\(label, operation\)/);
  assert.match(source, /sendProviderMessage\(tab\.id, \{[\s\S]*type: "sync_now_v3"/);
  assert.match(source, /type: "get_provider_status_v3"[\s\S]*timeoutMs: PROVIDER_STATUS_RESPONSE_TIMEOUT_MS/);
  assert.match(source, /const providerBridgeReinjections = new Map\(\)/);
  assert.match(source, /providerBridgeReinjections\.get\(tabId\)/);
});

test("resets a stale page-side recovery before reinjection and retries an overlapping sync", () => {
  assert.match(source, /async function resetProviderRecovery\(/);
  assert.match(source, /window\.__omnichatRealtimeBridgeControl/);
  assert.match(source, /Recovery is already running\./);
  assert.match(source, /operation: "retry sync request"/);
  assert.match(source, /state\.recoveryAbortController\?\.abort\(\)/);
});

test("retires old bridge listeners before reattaching without a provider reload", () => {
  assert.match(source, /const BRIDGE_SOURCE = "omnichat-realtime-bridge-v3"/);
  assert.match(source, /response\.bridge_source === BRIDGE_SOURCE/);
  assert.match(source, /!bridgeReady && await reinjectProviderBridge\(tabId, adapter\)/);
  assert.match(source, /async function retireProviderMainBridge\(/);
  assert.match(source, /async function retireProviderContentBridge\(/);
  assert.match(source, /typeof control\?\.dispose === "function"/);
  assert.match(source, /await retireProviderContentBridge\(tabId\)/);
  assert.match(source, /type: "sync_now_v3"/);
});

test("resumes an interrupted sync after the service worker restarts", () => {
  assert.match(source, /async function resumeInterruptedSync\(/);
  assert.match(source, /scanState\?\.in_progress === true/);
  assert.match(source, /\["discovering", "syncing"\]\.includes\(status\?\.state\)/);
  assert.match(source, /void resumeInterruptedSync\(\)\.catch/);
});

test("requires an already-open Shopee tab for outbound replies", () => {
  const sendStart = source.indexOf("async function sendViaProvider(");
  const sendEnd = source.indexOf("\n}\n\nasync function selectCommandTab", sendStart);
  assert.ok(sendStart >= 0);
  assert.ok(sendEnd > sendStart);
  const sendSource = source.slice(sendStart, sendEnd);
  assert.match(sendSource, /commandTab\(context, \{ createIfMissing: false, prepareForSend: true \}\)/);
  assert.doesNotMatch(sendSource, /chrome\.tabs\.create\s*\(/);
  assert.match(source, /Open \$\{label\} in Chrome before sending a reply\./);
});

test("prepares Seller Centre and ranks it ahead of a stored legacy tab", () => {
  const commandStart = source.indexOf("async function commandTab(");
  const commandEnd = source.indexOf("\n}\n\nfunction providerAdapterForCommand", commandStart);
  assert.ok(commandStart >= 0);
  assert.ok(commandEnd > commandStart);
  const commandSource = source.slice(commandStart, commandEnd);
  assert.match(commandSource, /prepareForSend = false/);
  assert.match(commandSource, /prepareProviderTab\(candidate, adapter\)/);
  assert.match(commandSource, /for \(const candidate of orderedTabs\)/);
  assert.match(commandSource, /isReadyProviderTab\(candidate, adapter\)/);
  assert.match(commandSource, /orderedTabs\[0\] \?\? selectedTab/);
  assert.match(source, /function orderProviderTabs\(adapter, tabs, preferredTabId = null\)/);
  assert.match(source, /leftRank !== rightRank/);
  assert.match(source, /leftActive = left\.active === true/);
  assert.match(source, /type: "prepare_provider_v3"/);
  assert.match(source, /operation: "surface preparation"/);
});

test("orders a ready Seller Centre candidate ahead of a preferred legacy tab", () => {
  const start = source.indexOf("function orderProviderTabs(");
  const end = source.indexOf("\n}\n\nasync function providerTabStatus", start);
  assert.ok(start >= 0);
  assert.ok(end > start);
  const orderProviderTabs = vm.runInNewContext(`(${source.slice(start, end + 2)})`);
  const adapter = {
    surfacePriority: ["seller-centre", "legacy"],
    surfaceForUrl(url) {
      return url.includes("/portal/") ? "seller-centre" : "legacy";
    },
  };
  const ordered = orderProviderTabs(adapter, [
    { id: 7, url: "https://seller.shopee.co.th/new-webchat/conversations", active: true },
    { id: 3, url: "https://seller.shopee.co.th/portal/chat-management", active: false },
  ], 7);
  assert.deepEqual(Array.from(ordered, (tab) => tab.id), [3, 7]);
});

test("does not cross-send a Seller Centre command through the legacy endpoint", () => {
  const sendStart = source.indexOf("async function sendViaProvider(");
  const sendEnd = source.indexOf("\n}\n\nasync function selectCommandTab", sendStart);
  assert.ok(sendStart >= 0);
  assert.ok(sendEnd > sendStart);
  const sendSource = source.slice(sendStart, sendEnd);
  assert.match(sendSource, /prepareForSend: true/);
  assert.doesNotMatch(sendSource, /sendPath|webchat\/api\/v1\.2\/messages/);
  assert.match(source, /surfaceForUrl\?\.\(tab\.url\) === "seller-centre"/);
});

test("keeps tab creation limited to an explicit open-tab action", () => {
  const openStart = source.indexOf("async function openCommandTab(");
  const openEnd = source.indexOf("\n}\n", openStart);
  assert.ok(openStart >= 0);
  assert.ok(openEnd > openStart);
  assert.match(source.slice(openStart, openEnd), /commandTab\(context, \{ createIfMissing: true \}\)/);
});
