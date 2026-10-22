import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { createCipheriv, webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../extension/lib/shopee-video.js", import.meta.url), "utf8");
const sandbox = vm.createContext({ ArrayBuffer, Uint8Array, DataView, Blob, FormData, AbortSignal, Date, setTimeout,
  crypto: webcrypto, atob, TextEncoder, TextDecoder });
vm.runInContext(source, sandbox);
const { upload, md5 } = sandbox.OmnichatShopeeVideo;
const bytes = new TextEncoder().encode("abc").buffer;
const json = body => ({ ok: true, status: 200, json: async () => body });
const plaintextToken = vid => `test-access:signature:policy-${vid}`;
function encryptedToken(text) {
  const cipher = createCipheriv("aes-128-cbc", Buffer.from("shopee_vod_00120"), Buffer.from("1234567887654321"));
  return Buffer.concat([cipher.update(text, "utf8"), cipher.final()]).toString("base64");
}
const grant = (vid = "sg-test-1", changes = {}) => ({ code: 0, data: { vid, services: [{
  serviceid: "wscloud", token: encryptedToken(plaintextToken(vid)), uploaddomain: "https://up-ws-sg.vod.susercontent.com",
  domain: "https://down-ws-global.vod.susercontent.com", ...changes,
}] } });

function fixture({ initial = null, transferStatus = 200, registerOk = true, status = null } = {}) {
  const requests = [];
  const chatRequests = [];
  let grants = 0;
  const fetch = async (url, init) => {
    requests.push({ url, init });
    assert.equal(init.credentials, "omit", "upload service must not receive browser credentials");
    if (url.endsWith("/preupload")) return json(initial ?? grant(`sg-test-${++grants}`));
    if (url.endsWith("/file/upload")) return { ok: transferStatus === 200, status: transferStatus };
    if (url.endsWith("/reportupload")) return json({ code: 0 });
    throw new Error(`Unexpected upload endpoint: ${url}`);
  };
  const chatRequest = async (path, init) => {
    chatRequests.push({ path, init });
    if (path === "report_upload") return { ok: registerOk };
    if (path === "upload_status") return json(status ?? { status: "successful", video: "https://down-ws-global.vod.susercontent.com/processed.mp4",
      thumbnail: "https://down-ws-global.vod.susercontent.com/thumb.jpg", width: 320, height: 240, duration: 2500 });
    throw new Error(`Unexpected chat endpoint: ${path}`);
  };
  return { requests, chatRequests, options: { bytes, type: "video/mp4", deadline: Date.now() + 5000, fetch, chatRequest } };
}

test("video upload uses a fresh grant per upload and the observed registration protocol", async () => {
  const f = fixture();
  const first = await upload(f.options);
  const second = await upload(f.options);
  assert.equal(first.vid, "sg-test-1");
  assert.equal(second.vid, "sg-test-2");
  assert.equal(first.duration_seconds, 3);
  assert.equal(first.thumb_width, 320);
  const preupload = JSON.parse(f.requests[0].init.body);
  assert.equal(preupload.biz, 120);
  assert.equal(preupload.ver, 2);
  assert.equal(preupload.mediatype, 1);
  const transfer = f.requests.find(request => request.url.endsWith("/file/upload"));
  assert.equal(transfer.init.body.get("token"), plaintextToken("sg-test-1"));
  assert.notEqual(transfer.init.body.get("token"), grant().data.services[0].token, "opaque encrypted grant must never be uploaded unchanged");
  assert.equal(transfer.init.body.get("key"), "sg-test-1.ori.mp4");
  assert.equal(transfer.init.body.get("file").type, "video/mp4");
  assert.equal(transfer.init.body.get("file").size, bytes.byteLength);
  const report = JSON.parse(f.requests.find(request => request.url.endsWith("/reportupload")).init.body);
  assert.equal(report.md5, "900150983cd24fb0d6963f7d28e17f72");
  assert.equal(report.fsize, 3);
  assert.equal(report.serviceid, "wscloud");
  const registration = JSON.parse(f.chatRequests[0].init.body);
  assert.deepEqual(registration, { extend_id: "sg-test-1", file_size: 3, md5: report.md5,
    vid: "sg-test-1", video_url: "https://down-ws-global.vod.susercontent.com/sg-test-1.ori.mp4" });
  assert.deepEqual(f.chatRequests.map(request => request.path), ["report_upload", "upload_status", "report_upload", "upload_status"]);
  assert.equal(f.requests.some(request => /messages/.test(request.url)), false, "uploader must never send chat messages");
});

test("video transfer failure prevents registration and any later chat action", async () => {
  const f = fixture({ transferStatus: 503 });
  await assert.rejects(upload(f.options), /transfer returned 503/);
  assert.equal(f.requests.length, 2);
  assert.equal(f.chatRequests.length, 0);
});

for (const changes of [
  { uploaddomain: "https://up-ws-sg.vod.susercontent.com.attacker.example" },
  { domain: "https://attacker.example" },
  { token: "" },
]) {
  test(`rejects unsupported upload grant before transferring bytes: ${JSON.stringify(changes)}`, async () => {
    const f = fixture({ initial: grant("sg-test-1", changes) });
    await assert.rejects(upload(f.options), /service is unsupported/);
    assert.equal(f.requests.length, 1);
    assert.equal(f.chatRequests.length, 0);
  });
}

test("an expired deadline performs no network action", async () => {
  const f = fixture();
  await assert.rejects(upload({ ...f.options, deadline: Date.now() - 1 }), /deadline expired/);
  assert.equal(f.requests.length, 0);
  assert.equal(f.chatRequests.length, 0);
});

test("deadline aborts a stalled transfer without registration", async () => {
  const f = fixture();
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(upload({ ...f.options, deadline: Date.now() + 25,
      fetch: async (url, init) => {
        if (url.endsWith("/preupload")) return json(grant());
        return new Promise((_, reject) => {
          const abort = () => reject(init.signal.reason);
          if (init.signal.aborted) abort();
          else init.signal.addEventListener("abort", abort, { once: true });
        });
      },
    }), error => error.name === "TimeoutError");
  } finally { clearTimeout(keepAlive); }
  assert.equal(f.chatRequests.length, 0);
});

test("failed registration and incomplete processing metadata cannot become send content", async () => {
  const register = fixture({ registerOk: false });
  await assert.rejects(upload(register.options), /registration failed/);
  assert.deepEqual(register.chatRequests.map(request => request.path), ["report_upload"]);
  const incomplete = fixture({ status: { status: "successful", video: "https://example.com/video.mp4" } });
  await assert.rejects(upload(incomplete.options), /metadata is incomplete/);
});

test("MD5 matches upload-report vectors", () => {
  for (const [input, expected] of [
    ["", "d41d8cd98f00b204e9800998ecf8427e"],
    ["abc", "900150983cd24fb0d6963f7d28e17f72"],
    ["message digest", "f96b697d7cb7938d525a2f31aaf161d0"],
    ["1234567890".repeat(8), "57edf4a22be3c955ac49da2e2107b67a"],
  ]) assert.equal(md5(new TextEncoder().encode(input).buffer), expected);
});

test("malformed encrypted upload token fails before transmitting any file", async () => {
  const f = fixture({ initial: grant("sg-test-1", { token: "this-is-not-valid-base64-or-ciphertext" }) });
  await assert.rejects(upload(f.options));
  assert.equal(f.requests.length, 1);
  assert.equal(f.chatRequests.length, 0);
});

test("videos above the verified single-upload limit fail before requesting a grant", async () => {
  const f = fixture();
  await assert.rejects(upload({ ...f.options, bytes: new ArrayBuffer(5 * 1024 * 1024 + 1) }), /5 MB or smaller/);
  assert.equal(f.requests.length, 0);
  assert.equal(f.chatRequests.length, 0);
});

test("video failures retain upload stage and HTTP status without upload grants", async () => {
  for (const [stage, fetch, chatRequest, status] of [
    ["upload_grant", async () => ({ ok: false, status: 429 }), undefined, 429],
    ["upload_transfer", undefined, undefined, 503],
    ["upload_report", undefined, async () => ({ ok: false, status: 403 }), 403],
    ["upload_processing", undefined, async path => path === "report_upload" ? { ok: true, status: 200 }
      : { ...json({ status: "error", token: "private-provider-token" }), ok: false, status: 502 }, 502],
  ]) {
    const f = fixture({ transferStatus: stage === "upload_transfer" ? status : 200 });
    await assert.rejects(upload({ ...f.options, ...(fetch ? { fetch } : {}), ...(chatRequest ? { chatRequest } : {}) }), error => {
      assert.equal(error.diagnostics.stage, stage);
      assert.equal(error.diagnostics.http_status, status);
      assert.equal(error.diagnostics.operation, "upload");
      assert.equal(error.diagnostics.failure_kind, "provider_rejection");
      assert.doesNotMatch(JSON.stringify(error.diagnostics), /private-provider-token|https:|signature|policy/);
      return true;
    });
  }
});

test("video provider code rejection retains the bounded code and no response body", async () => {
  const f = fixture({ initial: { code: 1002, message: "private message", token: "private token" } });
  await assert.rejects(upload(f.options), error => {
    assert.equal(error.diagnostics.native_error_code, "1002");
    assert.equal(error.diagnostics.stage, "upload_grant");
    assert.equal(error.diagnostics.http_status, 200);
    assert.doesNotMatch(JSON.stringify(error.diagnostics), /private/);
    return true;
  });
  assert.equal(f.requests.length, 1, "rejection must not retry or transfer");
});
