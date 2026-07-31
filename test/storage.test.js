import assert from "node:assert/strict";
import test from "node:test";

import {
  STORAGE,
  normalizeDeviceName,
  writeStorage,
} from "../extension/lib/storage.js";

test("device name is optional, trimmed, bounded, and persisted locally", async () => {
  let written = null;
  globalThis.chrome = {
    storage: {
      local: {
        set: async (value) => { written = value; },
      },
    },
  };

  assert.equal(normalizeDeviceName(null), "");
  const name = normalizeDeviceName(`  ${"Front desk MacBook".padEnd(90, "!")}  `);
  await writeStorage({ [STORAGE.deviceName]: name });
  assert.equal(name.length, 80);
  assert.deepEqual(written, { [STORAGE.deviceName]: name });
});
