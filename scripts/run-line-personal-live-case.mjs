import { build } from "esbuild";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";
import { randomUUID, webcrypto } from "node:crypto";
import QRCode from "qrcode";
import { linePersonalBrowserPlugins } from "./line-personal-browser-build.mjs";

// Developer test runner, not a hosted connector or a way to access Chrome.
// Its new LINE session exists only in memory. The disk artifacts contain only
// a temporary QR/PIN and sanitized state; they never contain session tokens.
const root = fileURLToPath(new URL("..", import.meta.url));
const output = path.join(root, "tmp/line-personal-live-case");
await mkdir(output, { recursive: true, mode: 0o700 });
const marker = `OMNICHAT-PROBE-${randomUUID()}`;
const reply = `${marker}-REPLY`;
const controller = new AbortController();
const expiry = setTimeout(() => controller.abort(), 15 * 60_000);
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
let writes = Promise.resolve();
function saveState(state) {
  writes = writes.then(() => writeFile(path.join(output, "state.json"),
    `${JSON.stringify({ ...state, updated_at: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 }));
  return writes;
}
await writeFile(path.join(output, "test-case.json"), `${JSON.stringify({ marker, reply }, null, 2)}\n`, { mode: 0o600 });
const result = await build({
  absWorkingDir: root,
  stdin: { contents: 'import { runLiveCase } from "./tools/line-personal-probe/live-case.js"; globalThis.runLiveCase = runLiveCase;', resolveDir: root },
  bundle: true, platform: "browser", format: "iife", target: "chrome120",
  write: false, logLevel: "silent", define: { "globalThis.process": "undefined" },
  plugins: linePersonalBrowserPlugins(),
});
const allowed = new Set(["legy.line-apps.com", "obs.line-apps.com"]);
const checkedFetch = (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.protocol !== "https:" || !allowed.has(url.hostname)) throw new Error("TEST_NETWORK_ORIGIN_NOT_ALLOWED");
  return fetch(request, { redirect: "error" });
};
const context = vm.createContext({
  crypto: webcrypto, TextEncoder, TextDecoder,
  setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
  URL, URLSearchParams, performance, Request, Response, Headers,
  Blob, FormData, ReadableStream, WritableStream, TransformStream,
  AbortController, AbortSignal, navigator: { userAgent: "Chrome" }, fetch: checkedFetch,
}, { codeGeneration: { strings: false, wasm: false } });
context.self = context;
context.window = context;
vm.runInContext(result.outputFiles[0].text, context, { timeout: 10_000 });
console.log(`Independent test case: ${output}`);
console.log("A new QR authorization is required. This does not inspect or control the installed Chrome extension.");
try {
  await context.runLiveCase({
    marker, reply, signal: controller.signal,
    onQr(url) {
      writes = writes.then(async () => {
        if (controller.signal.aborted) return;
        await QRCode.toFile(path.join(output, "qr.png"), url, { width: 360, margin: 2 });
        await writeFile(path.join(output, "state.json"), '{"phase":"scan_test_account_qr"}\n', { mode: 0o600 });
        console.log("QR_READY");
      });
    },
    onPin(pin) {
      writes = writes.then(() => writeFile(path.join(output, "pin.txt"), pin ?? "Check LINE", { mode: 0o600 }));
      console.log("PIN_READY");
    },
    onStatus(state) {
      void saveState(state);
      console.log(state.phase);
      if (state.phase === "waiting_for_oa_challenge") {
        writes = writes.then(async () => {
          await unlink(path.join(output, "qr.png")).catch(() => {});
          await unlink(path.join(output, "pin.txt")).catch(() => {});
        });
      }
    },
  });
} catch {
  await saveState({ phase: controller.signal.aborted ? "cancelled" : "login_or_runtime_failed" });
  console.log(controller.signal.aborted ? "CANCELLED" : "LOGIN_OR_RUNTIME_FAILED");
  process.exitCode = 1;
} finally {
  controller.abort();
  clearTimeout(expiry);
  await writes;
  await unlink(path.join(output, "qr.png")).catch(() => {});
  await unlink(path.join(output, "pin.txt")).catch(() => {});
}
