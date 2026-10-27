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


test("log rendering bounds DOM rows while support export retains the complete buffer", () => {
  const logs = Array.from({ length: 350 }, (_, index) => ({ at: "2026-10-26T00:00:00Z", level: "info",
    area: "sync", event: "progress", message: `entry ${index}`, details: {} }));
  const note = {};
  const rows = [];
  const context = vm.createContext({ logs, logLevel: { value: "all" }, Date, language: "en", MAX_VISIBLE_LOGS: 200,
    chrome: { runtime: { getManifest: () => ({ version: "test" }) } },
    document: { querySelector: () => note, createElement: () => ({ dataset: {} }) },
    openLogsButton: {}, logList: { replaceChildren() { rows.length = 0; }, append(row) { rows.push(row); } },
    logEmpty: {}, copyLogsButton: {}, downloadLogsButton: {}, clearLogsButton: { setAttribute() {} }, t: key => key,
  });
  vm.runInContext(helpers + source.slice(source.indexOf("function renderLogs()"), source.indexOf("async function refreshStoredState()")), context);
  vm.runInContext("renderLogs()", context);
  assert.equal(rows.length, 200);
  assert.equal(note.hidden, false);
  assert.match(note.textContent, /latest 200 of 350/);
  assert.match(vm.runInContext("formatSupportLogs()", context), /entry 349/);
});

for (const action of ["copy", "download"]) {
  test(`${action} waits for diagnostic persistence and reloads before exporting`, async () => {
    let finishFlush, finishReload;
    const calls = [], exports = [];
    let snapshot = "stale snapshot";
    const handlers = {};
    const button = name => ({ addEventListener: (_event, handler) => { handlers[name] = handler; } });
    const scope = vm.createContext({
      chrome: { runtime: { sendMessage: message => {
        assert.equal(message.type, "flush_logs");
        calls.push("flush");
        return new Promise(resolve => { finishFlush = resolve; });
      } } },
      loadLogs: () => {
        calls.push("reload");
        return new Promise(resolve => { finishReload = () => { snapshot = "latest buffered diagnostics"; resolve(); }; });
      },
      copyLogsButton: button("copy"), downloadLogsButton: button("download"),
      navigator: { clipboard: { writeText: async text => exports.push(text) } },
      formatSupportLogs: () => snapshot, logsFilename: () => "support.log",
      Blob: class { constructor(parts) { this.text = parts.join(""); } },
      URL: { createObjectURL: blob => { exports.push(blob.text); return "blob:test"; }, revokeObjectURL() {} },
      document: { createElement: () => ({ click() {} }) },
      reportPopupError: () => assert.fail("successful export must not report an error"),
      t: key => key, setTimeout: () => 1,
    });
    vm.runInContext(source.slice(source.indexOf("async function prepareLogExport()"), source.indexOf('logLevel.addEventListener("change"')), scope);
    const exporting = handlers[action]();
    assert.deepEqual(calls, ["flush"]);
    assert.equal(exports.length, 0);
    finishFlush({ ok: true });
    await new Promise(setImmediate);
    assert.deepEqual(calls, ["flush", "reload"]);
    assert.equal(exports.length, 0, "export must wait for the refreshed storage snapshot");
    finishReload();
    await exporting;
    assert.equal(exports.length, 1);
    assert.equal(exports[0].trim(), "latest buffered diagnostics");
  });

  test(`${action} does not export a stale snapshot after diagnostic flush fails`, async () => {
    const handlers = {}, errors = [];
    const button = name => ({ addEventListener: (_event, handler) => { handlers[name] = handler; } });
    const copyButton = button("copy");
    const scope = vm.createContext({
      chrome: { runtime: { sendMessage: async () => ({ ok: false }) } },
      loadLogs: () => assert.fail("failed persistence must stop the export"),
      copyLogsButton: copyButton, downloadLogsButton: button("download"),
      navigator: { clipboard: { writeText: () => assert.fail("must not copy stale logs") } },
      formatSupportLogs: () => assert.fail("must not format stale logs"),
      reportPopupError: (area, error) => errors.push({ area, error }),
      t: key => key, setTimeout: () => 1,
    });
    vm.runInContext(source.slice(source.indexOf("async function prepareLogExport()"), source.indexOf('logLevel.addEventListener("change"')), scope);
    await handlers[action]();
    if (action === "copy") assert.equal(copyButton.textContent, "couldNotCopy");
    else {
      assert.equal(errors.length, 1);
      assert.equal(errors[0].area, "export_logs");
    }
  });
}
