import assert from "node:assert/strict";
import test from "node:test";

const source = await (await import("node:fs/promises")).readFile(new URL("../extension/line-oa-realtime.js", import.meta.url), "utf8");

test("LINE send verification prefers the provider sendId", () => {
  assert.match(source, /sentProviderSendId/);
  assert.match(source, /sentMessageMatches\(message, command, providerSendId\)/);
  assert.match(source, /sentProviderSendId\(message\) === providerSendId/);
});

test("LINE send verification emits only the matched message", () => {
  assert.match(source, /messages: \[matchingMessage\]/);
});
