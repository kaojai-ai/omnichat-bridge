import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../extension/popup.js", import.meta.url), "utf8");
const html = await readFile(new URL("../extension/popup.html", import.meta.url), "utf8");
function harness() {
  const requests = [];
  let finish;
  const button = { attributes: {}, setAttribute(key, value) { this.attributes[key] = value; } };
  const status = { dataset: {} };
  const scope = vm.createContext({ submittingLogs: false, submitLogsButton: button, logSubmitStatus: status,
    chrome: { runtime: { sendMessage: message => { requests.push(message); return new Promise(resolve => { finish = resolve; }); } } },
    t: (key, count) => `${key}${count === undefined ? "" : `:${count}`}`,
  });
  vm.runInContext(source.slice(source.indexOf("async function submitLogs()"), source.indexOf('submitLogsButton.addEventListener("click"')), scope);
  return { scope, requests, button, status, finish: result => finish(result) };
}

test("log controls place highlighted Submit after neutral Download and Copy/Trash below logs", () => {
  const toolbar = html.slice(html.indexOf('<div class="log-toolbar">'), html.indexOf('<div id="log-list"'));
  assert.match(toolbar, /id="download-logs" class="secondary-button compact-button"/);
  assert.match(toolbar, /id="submit-logs" class="log-submit-button compact-button"/);
  assert.ok(toolbar.indexOf('id="download-logs"') < toolbar.indexOf('id="submit-logs"'));
  assert.doesNotMatch(toolbar, /id="(?:copy|clear)-logs"/);
  assert.ok(html.indexOf('id="copy-logs"') > html.indexOf('id="log-list"'));
  assert.ok(html.indexOf('id="clear-logs"') < html.indexOf('<footer>'));
});

test("logs submit starts only manually and coalesces clicks while busy", async () => {
  const h = harness();
  assert.equal(h.requests.length, 0);
  const first = h.scope.submitLogs();
  const duplicate = h.scope.submitLogs();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].type, "submit_logs");
  assert.equal(h.button.disabled, true);
  assert.equal(h.button.attributes["aria-busy"], "true");
  assert.equal(h.status.textContent, "submittingLogs");
  h.finish({ ok: true, submitted: 100, remaining: 0 });
  await Promise.all([first, duplicate]);
  assert.equal(h.status.dataset.state, "success");
  assert.equal(h.status.textContent, "logsSubmitted:100");
  assert.equal(h.button.disabled, false);
  assert.equal(h.scope.submittingLogs, false);
});

for (const [name, result, state, text] of [
  ["partial", { ok: false, submitted: 25, remaining: 10 }, "partial", /logsSubmitted:25.*logsSubmitRemaining:10/],
  ["failure", { ok: false, submitted: 0, remaining: 10, error: "Private server detail" }, "error", /^logsSubmitFailed$/],
]) {
  test(`logs submit shows ${name} without replaying automatically`, async () => {
    const h = harness();
    const task = h.scope.submitLogs();
    h.finish(result);
    await task;
    assert.equal(h.status.dataset.state, state);
    assert.match(h.status.textContent, text);
    assert.doesNotMatch(h.status.textContent, /Private server detail/);
    assert.equal(h.requests.length, 1);
    assert.equal(h.button.disabled, false);
  });
}
