import assert from "node:assert/strict";
import test from "node:test";
import { publishExtension } from "../scripts/publish-chrome-web-store.mjs";

const options = { publisherId: "publisher-123", extensionId: "a".repeat(32), token: "private-token",
  version: "1.0.12", zip: new Uint8Array([80, 75]) };
function fixture(responses, preflight = true) {
  const calls = [], waits = [];
  return { calls, waits, run: () => publishExtension({ ...options,
    sleep: async ms => waits.push(ms),
    fetch: async (url, init) => {
      if (preflight) { preflight = false; return json(baseStatus); }
      calls.push({ url, ...init });
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response;
    },
  }) };
}
const json = body => Response.json(body);
const baseStatus = { name: `publishers/${options.publisherId}/items/${options.extensionId}`, itemId: options.extensionId };
const revision = (version, state = "PENDING_REVIEW") => ({ state, distributionChannels: [{ crxVersion: version }] });
const pendingStatus = { ...baseStatus, submittedItemRevisionStatus: revision("1.0.11") };

test("uploads the built ZIP and submits once, preserving Google review", async () => {
  const h = fixture([json({ uploadState: "SUCCEEDED", crxVersion: options.version }), json({ state: "PENDING_REVIEW" })]);
  assert.deepEqual(await h.run(), { version: options.version, state: "PENDING_REVIEW" });
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0].url, `https://chromewebstore.googleapis.com/upload/v2/publishers/${options.publisherId}/items/${options.extensionId}:upload`);
  assert.equal(h.calls[0].body, options.zip);
  assert.equal(h.calls[0].headers.Authorization, `Bearer ${options.token}`);
  assert.deepEqual(JSON.parse(h.calls[1].body), { publishType: "DEFAULT_PUBLISH", skipReview: false });
  assert.equal(h.calls[1].method, "POST");
});

test("async upload must succeed before publication", async () => {
  const h = fixture([json({ uploadState: "IN_PROGRESS" }), json({ lastAsyncUploadState: "IN_PROGRESS" }),
    json({ lastAsyncUploadState: "SUCCEEDED" }), json({ state: "PENDING_REVIEW" })]);
  await h.run();
  assert.deepEqual(h.waits, [5000, 5000]);
  assert.deepEqual(h.calls.map(call => call.method ?? "GET"), ["POST", "GET", "GET", "POST"]);
});

for (const state of ["FAILED", "NOT_FOUND", undefined]) {
  test(`upload ${state} never calls publish`, async () => {
    const h = fixture([json({ uploadState: state })]);
    await assert.rejects(h.run(), /publish was not called/);
    assert.equal(h.calls.length, 1);
  });
}

test("a pending upload has a bounded wait and never publishes on timeout", async () => {
  const h = fixture([json({ uploadState: "IN_PROGRESS" }), ...Array.from({ length: 30 }, () => json({ lastAsyncUploadState: "IN_PROGRESS" }))]);
  await assert.rejects(h.run(), /publish was not called/);
  assert.equal(h.waits.length, 30);
  assert.ok(h.calls.every(call => !call.url.endsWith(":publish")));
});

test("version mismatch never publishes", async () => {
  const h = fixture([json({ uploadState: "SUCCEEDED", crxVersion: "1.0.13" })]);
  await assert.rejects(h.run(), /version mismatch/);
  assert.equal(h.calls.length, 1);
});

test("uncertain publish is not retried and private errors are not exposed", async () => {
  const h = fixture([json({ uploadState: "SUCCEEDED" }), new Error("private-token: raw response")]);
  await assert.rejects(h.run(), error => error.message.includes("outcome unknown") && !error.message.includes(options.token));
  assert.equal(h.calls.length, 2);
});

test("API rejection is not retried and response content is never exposed", async () => {
  const h = fixture([new Response("private-token raw provider error", { status: 403 })]);
  await assert.rejects(h.run(), error => error.message.includes("HTTP 403") && !error.message.includes(options.token));
  assert.equal(h.calls.length, 1);
});


test("older pending revision is rechecked, cancelled once with empty response, then replaced", async () => {
  const h = fixture([json(pendingStatus), json(pendingStatus), new Response(null, { status: 204 }),
    json({ ...baseStatus, submittedItemRevisionStatus: revision("1.0.11", "CANCELLED") }),
    json({ uploadState: "SUCCEEDED", crxVersion: options.version }), json({ state: "PENDING_REVIEW" })], false);
  assert.equal((await h.run()).state, "PENDING_REVIEW");
  assert.deepEqual(h.calls.map(c => c.url.split(":").at(-1)), ["fetchStatus", "fetchStatus", "cancelSubmission", "fetchStatus", "upload", "publish"]);
  assert.equal(h.calls[2].body, undefined);
});
for (const value of ["1.0.13", "1.1", "bad", undefined]) {
  test(`unsafe pending version ${value} never mutates`, async () => {
    const h = fixture([json({ ...baseStatus, submittedItemRevisionStatus: revision(value) })], false);
    await assert.rejects(h.run());
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].method, undefined);
  });
}
test("same pending version is idempotent", async () => {
  const h = fixture([json({ ...baseStatus, submittedItemRevisionStatus: revision(options.version) })], false);
  assert.deepEqual(await h.run(), { version: options.version, state: "PENDING_REVIEW" });
  assert.equal(h.calls.length, 1);
});
for (const change of [
  { submittedItemRevisionStatus: revision("1.0.13") },
  { submittedItemRevisionStatus: revision("1.0.11", "STAGED") },
  { publishedItemRevisionStatus: revision("1.0.11", "PUBLISHED") },
]) {
  test(`concurrent revision change stops cancellation ${JSON.stringify(change)}`, async () => {
    const h = fixture([json(pendingStatus), json({ ...pendingStatus, ...change })], false);
    await assert.rejects(h.run(), /changed before cancellation/);
    assert.ok(h.calls.every(c => !c.method));
  });
}
for (const unsafe of [
  { ...baseStatus, itemId: "b".repeat(32) },
  { ...baseStatus, takenDown: true },
  { ...baseStatus, lastAsyncUploadState: "IN_PROGRESS" },
  { ...baseStatus, submittedItemRevisionStatus: { state: "PENDING_REVIEW", distributionChannels: [{crxVersion:"1.0.10"},{crxVersion:"1.0.11"}] } },
  { ...baseStatus, submittedItemRevisionStatus: revision("1.0.11", "STAGED") },
  { ...baseStatus, publishedItemRevisionStatus: revision("2.0", "PUBLISHED") },
]) {
  test(`ambiguous or unsafe Store status stops ${JSON.stringify(unsafe)}`, async () => {
    const h = fixture([json(unsafe)], false);
    await assert.rejects(h.run());
    assert.ok(h.calls.every(c => !c.method));
  });
}
test("unconfirmed cancellation never uploads", async () => {
  const h = fixture([json(pendingStatus),json(pendingStatus),new Response(null,{status:204}),json(pendingStatus)],false);
  await assert.rejects(h.run(), /cancellation not confirmed/);
  assert.equal(h.calls.length, 4);
});
test("uncertain cancellation is not retried", async () => {
  const h = fixture([json(pendingStatus),json(pendingStatus),new Error("private-token")],false);
  await assert.rejects(h.run(), /outcome unknown/);
  assert.equal(h.calls.length, 3);
});
