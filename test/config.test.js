import assert from "node:assert/strict";
import test from "node:test";

import { accountOrigins, validateConfigFile } from "../extension/lib/config.js";

test("accepts the shared configuration and ignores other providers and extra fields", () => {
  const config = validateConfigFile({
    version: 2,
    generated_by: "admin",
    accounts: [
      {
        provider: "line_oa",
        provider_account_id: "channel-1",
        tenant_id: "tenant-1",
        bot_id: "bot-1",
        sync_key_url: "https://sync.kaojai.ai/api/line-oa-sync/v3",
        hmac_secret: "line-secret",
      },
      {
        provider: "shopee",
        provider_account_id: "123",
        events_url: "https://collector.example.com/omnichat/events",
        commands_url: "https://admin.example.com/omnichat/tickets",
        hmac_secret: "local-secret",
        tenant_id: "tenant-1",
        bot_id: "bot-1",
        unknown_field: "ignored",
      },
    ],
  });

  assert.deepEqual(config, {
    version: 2,
    accounts: [{
      provider: "shopee",
      provider_account_id: "123",
      events_url: "https://collector.example.com/omnichat/events",
      commands_url: "https://admin.example.com/omnichat/tickets",
      hmac_secret: "local-secret",
    }],
  });
});

test("optional image and logs URLs are validated and included in requested origins", () => {
  const config = validateConfigFile({
    version: 2,
    accounts: [{
      provider: "shopee",
      provider_account_id: "123",
      events_url: "https://collector.example.com/omnichat/events",
      commands_url: "https://admin.example.com/omnichat/tickets",
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
