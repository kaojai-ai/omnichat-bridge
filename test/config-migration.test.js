import assert from "node:assert/strict";
import test from "node:test";
import { accountMigration, assertMigratableConfig, CONFIG_MIGRATION_ERROR } from "../extension/lib/config-migration.js";
const tenant = "11111111-1111-4111-8111-111111111111";
const old = { provider: "shopee", provider_account_id: "123", api_url: `https://admin.kaojai.ai/api/omnichat/shopee/${tenant}/123`, hmac_secret: "fixture", events_url: "https://example.invalid/events" };
test("migration changes only managed endpoints and keeps environment isolated", () => {
  const result = accountMigration(old, 3);
  assert.equal(result.candidate.api_url, `https://omnichat.kaojai.ai/api/shopee/${tenant}/123`);
  assert.equal(result.candidate.logs_url, "https://ingress.kaojai.ai/logs/omnichat");
  assert.equal(result.candidate.hmac_secret, old.hmac_secret);
  assert.equal(result.candidate.events_url, old.events_url);
  assert.equal(accountMigration({ ...old, api_url: old.api_url.replace(".ai/", ".dev/") }, 3).candidate.logs_url, "https://ingress.kaojai.dev/logs/omnichat");
  assert.equal(accountMigration(result.candidate, 3).candidate, undefined);
});
test("managed malformed and conflicting identities require fresh configuration", () => {
  for (const account of [
    { ...old, provider_account_id: "456" }, { ...old, tenant_id: "other" },
    { ...old, api_url: `${old.api_url}?unexpected=1` }, { ...old, api_url: `${old.api_url}#fragment` },
    { ...old, api_url: old.api_url.replace("https://", "https://user@") },
    { ...old, api_url: old.api_url.replace(tenant, "not-a-uuid") },
    { ...old, api_url: old.api_url.replace("/api/omnichat/", "/unexpected/") },
    { ...old, api_url: "https://admin.kaojai.ai:invalid/api" },
  ]) assert.throws(() => assertMigratableConfig({ version: 3, accounts: [account] }), { message: CONFIG_MIGRATION_ERROR });
  assert.equal(accountMigration({ ...old, api_url: undefined, commands_url: old.api_url }, 2).status, "invalid");
});
test("LINE migration uses canonical account while keeping Basic ID", () => {
  const account = { ...old, provider: "line_oa", provider_account_id: "@example", canonical_provider_account_id: "123", tenant_id: tenant, api_url: old.api_url.replace("/shopee/", "/line_oa/") };
  const result = accountMigration(account, 3);
  assert.equal(result.candidate.provider_account_id, "@example");
  assert.ok(result.candidate.api_url.endsWith("/123"));
});
test("open-source custom endpoints are never rewritten or sent to KaoJai", () => {
  const customLogs = "https://diagnostics.example.invalid/logs";
  assert.equal(accountMigration({ ...old, logs_url: customLogs }, 3).candidate.logs_url, customLogs);
  for (const api_url of ["https://example.invalid/custom", "https://admin.kaojai.ai.example.invalid/api"]) {
    assert.equal(accountMigration({ ...old, api_url }, 3).candidate, undefined);
  }
});
