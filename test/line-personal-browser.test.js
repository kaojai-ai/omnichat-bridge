import assert from "node:assert/strict";
import { before, test } from "node:test";
import { createCipheriv, createHmac, hkdfSync, webcrypto } from "node:crypto";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { linePersonalBrowserPlugins } from "../scripts/line-personal-browser-build.mjs";

let context;
before(async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const result = await build({
    absWorkingDir: root,
    stdin: {
      contents: `
        import crypto from "node:crypto";
        import { BaseClient } from "@evex-dev/linejs/base";
        import { MemoryStorage } from "@evex-dev/linejs/storage";
        import { Buffer } from "node:buffer";
        globalThis.BrowserBuffer = Buffer;
        globalThis.browserCrypto = crypto;
        globalThis.client = new BaseClient({ device: "ANDROIDSECONDARY", storage: new MemoryStorage(),
          fetch() { throw new Error("Unexpected network request during offline verification"); } });
      `,
      resolveDir: root,
    },
    bundle: true, platform: "browser", format: "iife", target: "chrome120",
    write: false, logLevel: "silent",
    define: { "globalThis.process": "undefined" },
    plugins: linePersonalBrowserPlugins(),
  });
  context = vm.createContext({
    crypto: webcrypto, TextEncoder, TextDecoder,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    URL, URLSearchParams, performance, Request, Response, Headers,
    Blob, FormData, ReadableStream, WritableStream, TransformStream,
    AbortController, AbortSignal, navigator: { userAgent: "Chrome" },
  }, { codeGeneration: { strings: false, wasm: false } });
  context.self = context;
  context.window = context;
  vm.runInContext(result.outputFiles[0].text, context, { timeout: 10_000 });
});

test("browser bundle initializes without eval, Node globals or authentication", () => {
  assert.equal(context.process, undefined);
  assert.ok(context.client.loginProcess);
  assert.ok(context.client.talk);
  assert.ok(!context.client.authToken);
});

test("browser HKDF matches RFC 5869 test case 1", async () => {
  const result = await vm.runInContext(`new Promise((resolve, reject) => {
    browserCrypto.hkdf("sha256", new Uint8Array(22).fill(11),
      Uint8Array.from({ length: 13 }, (_, i) => i),
      Uint8Array.from({ length: 10 }, (_, i) => 240 + i), 42,
      (error, key) => error ? reject(error) : resolve(Array.from(new Uint8Array(key))));
  })`, context);
  assert.equal(Buffer.from(result).toString("hex"),
    "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865");
});

test("browser authentication-tag comparison rejects altered bytes and unequal lengths", () => {
  assert.equal(vm.runInContext("browserCrypto.timingSafeEqual(new Uint8Array([1,2]), new Uint8Array([1,2]))", context), true);
  assert.equal(vm.runInContext("browserCrypto.timingSafeEqual(new Uint8Array([1,2]), new Uint8Array([1,3]))", context), false);
  assert.throws(() => vm.runInContext("browserCrypto.timingSafeEqual(new Uint8Array(1), new Uint8Array(2))", context), /equal byte lengths/);
});

test("LINEJS browser encrypted media matches native crypto and rejects tampering", async () => {
  const plaintext = Buffer.from("LINE Personal offline media verification fixture");
  const key = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
  context.fixture = Array.from(plaintext);
  context.fixtureKey = Array.from(key);
  const encrypted = await vm.runInContext(`(async () => {
    globalThis.encryptedFixture = await client.e2ee.encryptByKeyMaterial(
      new Uint8Array(fixture), BrowserBuffer.from(fixtureKey));
    return Array.from(encryptedFixture.encryptedData);
  })()`, context);

  const derived = Buffer.from(hkdfSync("sha256", key, Buffer.alloc(0), "FileEncryption", 76));
  const cipher = createCipheriv("aes-256-ctr", derived.subarray(0, 32), Buffer.concat([derived.subarray(64, 76), Buffer.alloc(4)]));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = createHmac("sha256", derived.subarray(32, 64)).update(ciphertext).digest();
  assert.deepEqual(Buffer.from(encrypted), Buffer.concat([ciphertext, tag]));
  assert.equal(context.encryptedFixture.keyMaterial, key.toString("base64"));

  const decrypted = await vm.runInContext(`client.e2ee.decryptByKeyMaterial(
    encryptedFixture.encryptedData, encryptedFixture.keyMaterial).then(value => Array.from(value))`, context);
  assert.deepEqual(Buffer.from(decrypted), plaintext);
  await assert.rejects(vm.runInContext(`(async () => {
    const tampered = new Uint8Array(encryptedFixture.encryptedData);
    tampered[0] ^= 1;
    return client.e2ee.decryptByKeyMaterial(tampered, new Uint8Array(fixtureKey));
  })()`, context), /HMAC verification failed/);
  await assert.rejects(vm.runInContext("client.e2ee.decryptByKeyMaterial(new Uint8Array(2), new Uint8Array(fixtureKey))", context), /too short/);
});
