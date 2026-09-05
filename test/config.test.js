import assert from "node:assert/strict";
import test from "node:test";

import { accountOrigins, validateConfigFile } from "../extension/lib/config.js";

test("optional image and logs URLs are validated and included in requested origins", () => {
  const config = validateConfigFile({
    version: 2,
    accounts: [{
      provider: "shopee",
      provider_account_id: "123",
      events_url: "https://collector.example.com/omnichat/events",
      commands_url: "https://admin.example.com/omnichat/tickets",
      control_url: "https://admin.example.com/omnichat/control",
      image_server_url: "https://images.example.com",
      logs_url: "https://logs.example.com/omnichat/logs",
      hmac_secret: "local-secret",
    }],
  });

  assert.equal(config.accounts[0].image_server_url, "https://images.example.com/");
  assert.equal(config.accounts[0].logs_url, "https://logs.example.com/omnichat/logs");
  assert.deepEqual(accountOrigins(config), [
    "https://collector.example.com/omnichat/events",
    "https://admin.example.com/omnichat/tickets",
    "https://admin.example.com/omnichat/control",
    "https://images.example.com/",
    "https://logs.example.com/omnichat/logs",
  ]);
});

test("image server URL must use HTTPS", () => {
  assert.throws(() => validateConfigFile({
    version: 2,
    accounts: [{
      provider: "shopee",
      provider_account_id: "123",
      events_url: "https://collector.example.com/omnichat/events",
      commands_url: "https://admin.example.com/omnichat/tickets",
      image_server_url: "http://images.example.com",
      hmac_secret: "local-secret",
    }],
  }), /Image server URL must use HTTPS/);
});

test("logs URL must use HTTPS", () => {
  assert.throws(() => validateConfigFile({
    version: 2,
    accounts: [{
      provider: "shopee",
      provider_account_id: "123",
      events_url: "https://collector.example.com/omnichat/events",
      commands_url: "https://admin.example.com/omnichat/tickets",
      logs_url: "http://logs.example.com/omnichat/logs",
      hmac_secret: "local-secret",
    }],
  }), /Logs URL must use HTTPS/);
});

test("imports shared configurations without rejecting unsupported provider entries", () => {
  const config = validateConfigFile({
    version: 2,
    generated_by: "admin",
    accounts: [
      {
        provider: "line_oa",
        provider_account_id: "channel-1",
        tenant_id: "tenant-1",
        bot_id: "bot-1",
        sync_key_url: "https://sync.example.com/v3",
        hmac_secret: "line-secret",
      },
      {
        provider: "shopee",
        provider_account_id: "shop-1",
        events_url: "https://collector.example.com/events",
        commands_url: "https://admin.example.com/tickets",
        hmac_secret: "shopee-secret",
        provider_specific_extra: "ignored",
      },
      {
        provider: "future_provider",
        provider_account_id: "future-1",
        arbitrary: "ignored",
      },
    ],
  });

  assert.deepEqual(config, {
    version: 2,
    accounts: [{
      provider: "shopee",
      provider_account_id: "shop-1",
      events_url: "https://collector.example.com/events",
      commands_url: "https://admin.example.com/tickets",
      hmac_secret: "shopee-secret",
    }],
  });
});

test("delegates validation and origins to a registered provider adapter", () => {
  const previous = globalThis.OmnichatProviderAdapters;
  globalThis.OmnichatProviderAdapters = {
    get(provider) {
      return provider === "line_oa"
        ? {
          validateConfig(value) {
            return {
              provider: "line_oa",
              provider_account_id: String(value.provider_account_id).trim(),
              endpoint_url: String(value.endpoint_url).trim(),
              hmac_secret: String(value.hmac_secret).trim(),
            };
          },
          configOrigins(account) {
            return [account.endpoint_url];
          },
        }
        : null;
    },
  };

  try {
    const config = validateConfigFile({
      version: 2,
      accounts: [{
        provider: "line_oa",
        provider_account_id: "channel-1",
        endpoint_url: "https://line.example.com/events",
        hmac_secret: "line-secret",
        unused_field: "ignored",
      }],
    });
    assert.deepEqual(accountOrigins(config), ["https://line.example.com/events"]);
    assert.deepEqual(config.accounts[0], {
      provider: "line_oa",
      provider_account_id: "channel-1",
      endpoint_url: "https://line.example.com/events",
      hmac_secret: "line-secret",
    });
  } finally {
    if (previous === undefined) delete globalThis.OmnichatProviderAdapters;
    else globalThis.OmnichatProviderAdapters = previous;
  }
});
