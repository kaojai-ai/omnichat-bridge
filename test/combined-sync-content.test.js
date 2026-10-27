import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../extension/content.js", import.meta.url), "utf8");
const plain = value => JSON.parse(JSON.stringify(value));
const turn = () => new Promise(resolve => setImmediate(resolve));
function section(start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first);
  return source.slice(first, last);
}
function fixture(provider) {
  const page = [];
  const runtime = [];
  const logs = [];
  const context = vm.createContext({
    providerAdapter: { id: provider, supports: () => true },
    isBridgeActive: () => true, isConfigured: async () => true,
    preparingRecoveries: new Map(), recoveries: new Map(),
    crypto: { randomUUID: () => "generated" }, touchRecovery() {},
    post: message => page.push(plain(message)),
    sendRuntimeMessage: async message => {
      runtime.push(plain(message));
      return { ok: true, checkpoint: { watermark: "cursor", refresh_metadata: true } };
    },
    log: async (...entry) => { logs.push(entry); return { ok: true }; },
    providerFailureDiagnostics: () => ({}), document: { documentElement: { dataset: {} } },
  });
  vm.runInContext(section("  async function requestRecovery(", "  function cancelRecovery(")
    + section("  function cancelRecovery(", "  async function requestAccountDetection(")
    + section("  async function handleRecoveryComplete(", "  function setComposerText(")
    + section("  const onRuntimeMessage =", "  const requestLifecycleResumeSync ="), context);
  return { context, page, runtime, logs,
    command(message) {
      let ack;
      const retained = vm.runInContext("onRuntimeMessage", context)(message, {}, result => { ack = result; });
      assert.equal(retained, false);
      assert.deepEqual(plain(ack), { ok: true, started: true, request_id: message.request_id });
    },
  };
}

for (const provider of ["shopee", "line_oa"]) {
  for (const manual of [true, false]) {
    test(`${provider} ${manual ? "manual" : "automatic"} scan forwards an explicit metadata flag through one recovery`, async () => {
      const h = fixture(provider);
      h.command({ type: "sync_now_v3", provider, provider_account_id: "account-a", request_id: "attempt-a",
        ...(manual ? { refresh_metadata: true } : {}) });
      await turn();
      assert.equal(h.page.length, 1);
      assert.equal(h.page[0].type, "sync_v3");
      assert.equal(h.page[0].refresh_metadata, manual);
      assert.equal(h.page[0].checkpoint.refresh_metadata, manual,
        "stored checkpoint flags cannot cause automatic refresh");
      assert.equal(h.page[0].checkpoint.watermark, "cursor");
      const metadata = { ok: true, account: { provider_account_id: "account-a", display_name: "Account" },
        profiles: [{ conversation_id: "chat-a", id: "buyer-a", provider_account_id: "account-a", display_name: "Buyer" }] };
      await h.context.handleRecoveryComplete({ type: "recovery_complete", request_id: "attempt-a",
        provider_account_id: "account-a", ok: true, recovered: 2, queued: 2, ...(manual ? { metadata } : {}) });
      await turn();
      const completions = h.runtime.filter(message => message.type === "sync_complete");
      assert.equal(completions.length, 1);
      assert.equal(completions[0].provider, provider);
      assert.equal(completions[0].provider_account_id, "account-a");
      assert.equal(completions[0].request_id, "attempt-a");
      assert.deepEqual(completions[0].result.metadata, manual ? metadata : undefined);
      assert.equal(completions[0].result.recovered, 2);
      assert.equal(h.runtime.some(message => message.type === "refresh_metadata"), false,
        "metadata shares recovery rather than starting a separate refresh request");
      assert.doesNotMatch(JSON.stringify(h.logs), /display_name|profiles|Buyer/);
      assert.doesNotMatch(h.context.document.documentElement.dataset.omnichatRecovery, /metadata|profiles|Buyer/);
    });
  }
}
