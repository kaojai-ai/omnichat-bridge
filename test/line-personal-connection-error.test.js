import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../extension/line-personal-client.js", import.meta.url), "utf8");
const scope = vm.createContext({});
vm.runInContext(source.slice(source.indexOf("function connectionFailureMessage("), source.indexOf("async function start(")), scope);

test("post-PIN errors distinguish HTTP failure from profile, key and local registration failures without leaking provider content", () => {
  const secret = "private-token-and-account-details";
  assert.equal(scope.connectionFailureMessage("profile", { httpStatus: 404, message: secret }),
    "LINE profile failed (HTTP 404). Click Connect to try again.");
  assert.match(scope.connectionFailureMessage("QR login", { name: "E2EEKeyMismatch", message: secret }), /E2EEKeyMismatch/);
  assert.match(scope.connectionFailureMessage("account registration", { message: secret, name: secret }), /account registration failed \(connection failed\)/);
  assert.doesNotMatch(scope.connectionFailureMessage("QR login", { message: secret, name: secret }), /private-token/);
});

for (const [reason, preserve] of [[{ httpStatus: 404 }, true], [{ httpStatus: 503 }, true], [{ name: "TimeoutError" }, true], [{ name: "E2EEKeyMismatch" }, false], [{ name: "NoE2EEKey" }, false], [{ httpStatus: 401 }, false]]) {
  test(`failed saved login preserves session only for transient failures: ${JSON.stringify(reason)}`, async () => {
    let cleared = 0, options;
    const value = { controller: new AbortController() };
    const stored = { authToken: "private-token", e2eeKey: "private-key" };
    const storage = { get: async key => stored[key], clear: async () => { cleared++; for (const key of Object.keys(stored)) delete stored[key]; } };
    const messages = [];
    const context = vm.createContext({ session: value, scope: "setup",
      personalSessionStorage: async () => storage, createBrowserFetch: () => {},
      active: candidate => candidate === value && !candidate.controller.signal.aborted,
      BaseClient: class {
        constructor(input) { options = input; this.on = () => {}; this.loginProcess = { login: async () => { throw Object.assign(new Error("private-provider-error"), reason); } }; }
      },
      createPersonalProfiles: () => ({}), changed() {}, report: message => messages.push(message),
      ui: { connect: {}, disconnect: {} },
    });
    vm.runInContext(source.slice(source.indexOf("function isTransientConnectionError("), source.indexOf("async function disconnect(")), context);
    await context.start(value);
    assert.equal(cleared, preserve ? 0 : 1);
    assert.equal(Boolean(stored.authToken), preserve);
    assert.equal(Boolean(stored.e2eeKey), preserve);
    assert.equal(options.legy.encrypted, false);
    assert.equal(value.controller.signal.aborted, true);
    assert.ok(messages.every(message => !message.includes("private-")));
  });
}
