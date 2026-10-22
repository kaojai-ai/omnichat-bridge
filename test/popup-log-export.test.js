import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../extension/popup.js", import.meta.url), "utf8");
const helpers = source.slice(source.indexOf("function visibleLogs()"), source.indexOf("function renderLogs()"));

test("support export includes warning and lifecycle context when the UI shows errors only", () => {
  const logs = ["error", "warn", "info"].map(level => ({ at: "2026-10-22T00:00:00Z", level,
    area: "provider", event: `test_${level}`, message: `${level} context`, details: { operation: "send" } }));
  const context = vm.createContext({ logs, logLevel: { value: "error" }, Date,
    chrome: { runtime: { getManifest: () => ({ version: "0.6.64" }) } } });
  vm.runInContext(helpers, context);
  assert.equal(vm.runInContext("visibleLogs().length", context), 1, "UI filter remains unchanged");
  const exported = vm.runInContext("formatSupportLogs()", context);
  for (const level of ["error", "warn", "info"]) assert.match(exported, new RegExp(`${level} context`));
  assert.match(exported, /version=0.6.64/);
  assert.match(exported, /provider=all-providers · accounts=all-shops · levels=all · display_filter=error/);
  assert.match(vm.runInContext("logsFilename()", context), /^omnichat-bridge-all-providers-all-shops-v0\.6\.64-/);
});
