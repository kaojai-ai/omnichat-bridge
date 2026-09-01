import assert from "node:assert/strict";
import test from "node:test";

import {
  STORAGE,
  normalizeDeviceName,
  resetDetectedAccountsFromConfig,
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

test("resets detected accounts from saved config without copying secrets", async () => {
  let written = null;
  globalThis.chrome = {
    storage: {
      local: {
        get: async () => ({
          [STORAGE.config]: {
            version: 2,
            accounts: [{
              provider: "shopee",
              provider_account_id: "1549058683",
              events_url: "https://collector.example.com/events",
              commands_url: "https://admin.example.com/tickets",
              hmac_secret: "must-not-be-copied",
            }],
          },
        }),
        set: async (value) => { written = value; },
      },
    },
  };

  assert.equal(await resetDetectedAccountsFromConfig(), true);
  assert.deepEqual(written, {
    [STORAGE.detectedAccounts]: [{
      provider: "shopee",
      provider_account_id: "1549058683",
    }],
  });
});

test("resets detected accounts for registered providers without copying secrets", async () => {
  const previousAdapters = globalThis.OmnichatProviderAdapters;
  let written = null;
  globalThis.OmnichatProviderAdapters = {
    get(provider) {
      return provider === "line_oa" ? { supports: () => true } : null;
    },
  };
  globalThis.chrome = {
    storage: {
      local: {
        get: async () => ({
          [STORAGE.config]: {
            version: 2,
            accounts: [{
              provider: "line_oa",
              provider_account_id: "channel-1",
              hmac_secret: "must-not-be-copied",
            }],
          },
        }),
        set: async (value) => { written = value; },
      },
    },
  };

  try {
    assert.equal(await resetDetectedAccountsFromConfig(), true);
    assert.deepEqual(written, {
      [STORAGE.detectedAccounts]: [{
        provider: "line_oa",
        provider_account_id: "channel-1",
      }],
    });
  } finally {
    if (previousAdapters === undefined) delete globalThis.OmnichatProviderAdapters;
    else globalThis.OmnichatProviderAdapters = previousAdapters;
  }
});

test("does not reset detected accounts when saved config is empty", async () => {
  let writes = 0;
  globalThis.chrome = {
    storage: {
      local: {
        get: async () => ({ [STORAGE.config]: { version: 2, accounts: [] } }),
        set: async () => { writes += 1; },
      },
    },
  };

  assert.equal(await resetDetectedAccountsFromConfig(), false);
  assert.equal(writes, 0);
});
