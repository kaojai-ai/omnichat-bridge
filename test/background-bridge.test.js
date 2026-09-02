import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");

test("does not reload provider tabs when the content bridge is unavailable", () => {
  assert.doesNotMatch(source, /chrome\.tabs\.reload\s*\(/);
  assert.match(source, /content_unready/);
  assert.match(source, /Refresh the tab manually and try again/);
});
