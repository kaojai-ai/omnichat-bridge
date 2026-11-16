import assert from "node:assert/strict";
import { before, test } from "node:test";
import { createCipheriv, createDecipheriv, createHash, createHmac, diffieHellman, generateKeyPairSync, hkdfSync, webcrypto } from "node:crypto";
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
        import { personalCommandClient } from "./extension/lib/line-personal-command.js";
        import { createBrowserFetch } from "./extension/lib/line-personal-fetch.js";
        globalThis.CommandBaseClient = BaseClient;
        globalThis.CommandMemoryStorage = MemoryStorage;
        globalThis.personalCommandClient = personalCommandClient;
        globalThis.createBrowserFetch = createBrowserFetch;
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

test("command deadlines abort the native transport independently while preserving session tokens and request sequencing", async () => {
  const calls = [];
  context.fetch = (input, init) => {
    const request = new Request(input, init);
    calls.push(request);
    return new Promise((resolve, reject) => {
      const abort = () => reject(new DOMException("Test request aborted", "AbortError"));
      if (request.signal.aborted) abort();
      else request.signal.addEventListener("abort", abort, { once: true });
    });
  };
  await vm.runInContext(`(async () => {
    globalThis.pollController = new AbortController();
    globalThis.commandController = new AbortController();
    globalThis.commandBase = new CommandBaseClient({
      device: "ANDROIDSECONDARY", storage: new CommandMemoryStorage(),
      fetch: createBrowserFetch(pollController.signal),
    });
    commandBase.authToken = "fixture-original";
    commandBase.profile = { mid: "u" + "1".repeat(32) };
    commandBase.on("update:authtoken", (token) => { commandBase.authToken = token; });
    globalThis.scopedCommand = personalCommandClient(commandBase, commandController.signal);
    globalThis.secondCommand = personalCommandClient(commandBase, commandController.signal);
    globalThis.requestSequences = await Promise.all([
      commandBase.getReqseq(), scopedCommand.getReqseq(), secondCommand.getReqseq(),
    ]);
    scopedCommand.emit("update:authtoken", "fixture-rotated");
  })()`, context);
  assert.deepEqual(Array.from(context.requestSequences), [0, 1, 2]);
  assert.equal(context.scopedCommand.storage, context.commandBase.storage);
  assert.equal(context.scopedCommand.profile, context.commandBase.profile);
  assert.equal(context.commandBase.authToken, "fixture-rotated");
  assert.equal(context.scopedCommand.authToken, "fixture-rotated");
  context.scopedCommand.authToken = "fixture-next";
  assert.equal(context.secondCommand.authToken, "fixture-next");

  const polling = vm.runInContext('commandBase.fetch("https://legy.line-apps.com/SYNC4")', context);
  const command = vm.runInContext('scopedCommand.fetch("https://legy.line-apps.com/S4")', context);
  const pollCancelled = assert.rejects(polling, { name: "AbortError" });
  const commandCancelled = assert.rejects(command, { name: "AbortError" });
  assert.equal(calls.length, 2);
  context.commandController.abort();
  await commandCancelled;
  assert.equal(calls[1].signal.aborted, true, "reply deadline reaches the underlying fetch request");
  assert.equal(calls[0].signal.aborted, false, "the independent poll transport remains active");
  assert.equal(context.pollController.signal.aborted, false);
  context.pollController.abort();
  await pollCancelled;
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

test("actual LINEJS browser text send produces native-verifiable E2EE chunks", async () => {
  const sender = generateKeyPairSync("x25519");
  const receiver = generateKeyPairSync("x25519");
  const rawPublic = (key) => key.export({ type: "spki", format: "der" }).subarray(-32);
  context.senderPrivate = sender.privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32).toString("base64");
  context.senderPublic = rawPublic(sender.publicKey).toString("base64");
  context.receiverPublic = Array.from(rawPublic(receiver.publicKey));
  await vm.runInContext(`(async () => {
    client.profile = { mid: "u11111111111111111111111111111111" };
    const key = JSON.stringify({ keyId: 1, privKey: senderPrivate, pubKey: senderPublic, e2eeVersion: 1 });
    await client.storage.set("e2eeKeys:" + client.profile.mid, key);
    await client.storage.set("e2eeKeys:1", key);
    client.talk.negotiateE2EEPublicKey = async () => ({ specVersion: 2,
      publicKey: { keyId: 2, keyData: BrowserBuffer.from(receiverPublic) } });
    const encrypt = client.e2ee.encryptE2EEMessage.bind(client.e2ee);
    client.e2ee.encryptE2EEMessage = async (...args) => {
      const chunks = await encrypt(...args);
      globalThis.textChunks = chunks;
      return chunks;
    };
    globalThis.dispatches = 0;
    client.request.request = async (_payload, method) => {
      if (method !== "sendMessage") throw new Error("Unexpected request");
      dispatches++;
      return { id: "synthetic-provider-message" };
    };
    await client.talk.sendMessage({ to: "u22222222222222222222222222222222",
      text: "Offline encrypted text fixture", e2ee: true });
  })()`, context);
  assert.equal(context.dispatches, 1);
  const [salt, encrypted, nonce, senderId, receiverId] = context.textChunks.map((value) => Buffer.from(value));
  const shared = diffieHellman({ privateKey: sender.privateKey, publicKey: receiver.publicKey });
  const key = createHash("sha256").update(shared).update(salt).update("Key").digest();
  const version = Buffer.alloc(4);
  version.writeInt32BE(2);
  const aad = Buffer.concat([
    Buffer.from("u22222222222222222222222222222222"), Buffer.from("u11111111111111111111111111111111"),
    senderId, receiverId, version, Buffer.alloc(4),
  ]);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(encrypted.subarray(-16));
  const plain = Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]);
  assert.deepEqual(JSON.parse(plain.toString()), { text: "Offline encrypted text fixture" });
});

test("a peer without E2EE support fails before actual LINEJS message dispatch", async () => {
  await vm.runInContext(`(async () => {
    globalThis.dispatches = 0;
    client.talk.negotiateE2EEPublicKey = async () => ({ specVersion: -1 });
    try {
      await client.talk.sendMessage({ to: "u22222222222222222222222222222222",
        text: "Must never be sent", e2ee: true });
      throw new Error("Expected unsupported recipient rejection");
    } catch (error) {
      if (error.name !== "Not support E2EE") throw error;
    }
  })()`, context);
  assert.equal(context.dispatches, 0);
});
