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
