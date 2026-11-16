import assert from "node:assert/strict";
import test from "node:test";
import { initializeConnectionPage } from "../extension/lib/connection-page.js";

function harness(consent) {
  const nodes = new Map();
  function node(key) {
    if (!nodes.has(key)) nodes.set(key, {
      hidden: false, checked: false, handlers: {}, textContent: "",
      querySelector: selector => node(`${key} ${selector}`),
      closest: selector => node(`${key} ${selector}`),
      addEventListener(event, callback) { this.handlers[event] = callback; },
      append() {}, prepend() {}, remove() {},
    });
    return nodes.get(key);
  }
  let stored = consent;
  let changed;
  let revoked = 0;
  globalThis.chrome = {
    runtime: { getURL: path => path, getManifest: () => ({ version: "1.0.0" }) },
    storage: { local: {
      get: async () => ({ local_consent: stored }),
      set: async values => { stored = values.local_consent; },
    }, onChanged: { addListener: listener => { changed = listener; } } },
  };
  globalThis.document = { querySelector: node, importNode: value => value, createElement: () => node("settings") };
  globalThis.DOMParser = class { parseFromString() { return { querySelector: node }; } };
  globalThis.fetch = async () => ({ ok: true, text: async () => "popup" });
  return { node, init: () => initializeConnectionPage({ onConsentRevoked: () => { revoked++; } }),
    get consent() { return stored; }, get revoked() { return revoked; },
    async revoke() { stored = null; changed({ local_consent: {} }, "local"); await Promise.resolve(); await Promise.resolve(); },
  };
}

test("connection setup requires explicit consent and shares the popup policy", async () => {
  const h = harness();
  const requireConsent = await h.init();
  assert.equal(await requireConsent(), false);
  assert.equal(h.node("#personal-connection").hidden, true);
  assert.equal(h.node("#consent-screen").hidden, false);
  assert.equal(h.node("#consent-screen #continue").disabled, true);
  await h.node("#consent-screen #continue").handlers.click();
  assert.equal(h.consent, undefined);
  const checkbox = h.node("#consent-screen #consent");
  checkbox.checked = true;
  checkbox.handlers.change();
  await h.node("#consent-screen #continue").handlers.click();
  assert.equal(h.consent.policy_version, 2);
  assert.ok(h.consent.accepted_at);
  assert.equal(await requireConsent(), true);
  assert.equal(h.node("#personal-connection").hidden, false);
  h.node("footer #open-privacy").handlers.click();
  assert.equal(h.node("#personal-connection").hidden, true);
  h.node("#consent-screen #close-privacy").handlers.click();
  assert.equal(h.node("#personal-connection").hidden, false);
  await h.revoke();
  assert.equal(h.revoked, 1);
  assert.equal(await requireConsent(), false);
  assert.equal(h.node("#personal-connection").hidden, true);
});

test("existing popup consent opens setup immediately; an obsolete policy does not", async () => {
  for (const version of [1, 2]) {
    const h = harness({ policy_version: version, accepted_at: new Date().toISOString() });
    const requireConsent = await h.init();
    assert.equal(await requireConsent(), version === 2);
    assert.equal(h.node("#personal-connection").hidden, version !== 2);
    assert.equal(h.node(".brand #node-version").textContent, "v1.0.0");
    assert.equal(h.node("footer #version").textContent, "v1.0.0");
  }
});
