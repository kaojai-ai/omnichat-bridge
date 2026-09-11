import assert from "node:assert/strict";
import test from "node:test";

import {
  configuredProviderAccounts,
  hydrateDetectedAccounts,
  visibleDetectedAccounts,
} from "../extension/lib/popup-accounts.js";
import "./../extension/lib/provider-adapters.js";
import "./../extension/lib/line-oa.js";
import "./../extension/lib/shopee-url.js";
import "./../extension/lib/shopee-adapter.js";

const lineConfig = {
  version: 3,
  accounts: [{
    provider: "line_oa",
    provider_account_id: "@kaojai",
    bot_id: "bot-1",
    display_name: "KaoJai OA",
    events_url: "https://example.com/events",
    api_url: "https://example.com/api",
    hmac_secret: "secret",
  }],
};

test("seeds configured accounts for the active provider", () => {
  assert.deepEqual(configuredProviderAccounts(lineConfig, "line_oa"), [{
    provider: "line_oa",
    provider_account_id: "@kaojai",
    bot_id: "bot-1",
    display_name: "KaoJai OA",
  }]);
  assert.deepEqual(configuredProviderAccounts(lineConfig, "shopee"), []);
});

test("keeps configured accounts visible before live detection finishes", () => {
  const accounts = hydrateDetectedAccounts({
    storedAccounts: [],
    config: lineConfig,
    providerId: "line_oa",
    activeTabUrl: "https://chat.line.biz/bot-1/",
  });
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].provider_account_id, "@kaojai");
  assert.equal(accounts[0].display_name, "KaoJai OA");
});

test("merges live detection on top of configured seeds", () => {
  const accounts = hydrateDetectedAccounts({
    storedAccounts: [{
      provider: "line_oa",
      provider_account_id: "@kaojai",
      bot_id: "bot-1",
      display_name: "Live name",
      detected_at: "2026-09-11T00:00:00.000Z",
    }],
    config: lineConfig,
    providerId: "line_oa",
    activeTabUrl: "https://chat.line.biz/bot-1/",
  });
  assert.equal(accounts[0].display_name, "Live name");
});

test("shows an unconfigured LINE account only when its chat tab is open", () => {
  const detected = [{
    provider: "line_oa",
    provider_account_id: "@other",
    bot_id: "bot-2",
  }];
  assert.deepEqual(
    visibleDetectedAccounts(detected, lineConfig, "https://chat.line.biz/bot-2/"),
    detected,
  );
  assert.deepEqual(
    visibleDetectedAccounts(detected, lineConfig, "https://chat.line.biz/bot-1/"),
    [],
  );
});
