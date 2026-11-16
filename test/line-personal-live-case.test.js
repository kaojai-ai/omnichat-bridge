import assert from "node:assert/strict";
import { before, test } from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const own = `u${"1".repeat(32)}`;
const oa = `u${"2".repeat(32)}`;
const marker = "OMNICHAT-PROBE-SYNTHETIC-CHALLENGE";
let source;
before(async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const result = await build({
    absWorkingDir: root,
    stdin: { contents: 'import { runLiveCase } from "./tools/line-personal-probe/live-case.js"; globalThis.run = runLiveCase;', resolveDir: root },
    bundle: true, format: "iife", platform: "browser", write: false, logLevel: "silent",
    plugins: [{ name: "synthetic-line-service", setup(build) {
      build.onResolve({ filter: /^@evex-dev\/linejs\/(base|storage)$/ }, (args) => ({ path: args.path, namespace: "synthetic" }));
      build.onLoad({ filter: /.*/, namespace: "synthetic" }, () => ({ contents: `
        export class MemoryStorage { async clear() { fixture.cleared = true; } }
        export class BaseClient {
          constructor({ storage }) {
            this.storage = storage;
            this.profile = { mid: fixture.own };
            this.loginProcess = { withQrCode: async () => {}, ready: async () => {} };
            this.talk = {
              sync: async () => {
                if (!fixture.batches.length) { fixture.controller.abort(); return {}; }
                return { operationResponse: { operations: fixture.batches.shift() } };
              },
              sendMessage: async (value) => {
                fixture.sends.push(value);
                if (fixture.sendError) throw new Error("Private test response");
                return { id: "synthetic" };
              }
            };
          }
          on() {}
        }
      ` }));
    } }],
  });
  source = result.outputFiles[0].text;
});

function incoming(overrides = {}) {
  return { type: "RECEIVE_MESSAGE", revision: 1, message: {
    from: oa, to: own, toType: "USER", createdTime: Date.now(), text: marker, ...overrides,
  } };
}

async function run(batches, { sendError = false, throwAfterReply = false } = {}) {
  const fixture = { own, batches, sends: [], controller: new AbortController(), sendError };
  const states = [];
  const context = vm.createContext({ fixture, Request, AbortSignal, Date });
  vm.runInContext(source, context);
  await context.run({ marker, reply: `${marker}-REPLY`, signal: fixture.controller.signal,
    onQr() { throw new Error("Synthetic login must not require QR"); }, onPin() {},
    onStatus(state) {
      states.push(JSON.parse(JSON.stringify(state)));
      if (throwAfterReply && state.phase === "oa_reply_result") throw new Error("Observer failed");
    },
  });
  return { fixture, states };
}

test("only a fresh exact direct-to-self challenge can trigger the one-time OA reply", async () => {
  const { fixture, states } = await run([[
    incoming({ text: "unrelated conversation" }),
    incoming({ createdTime: Date.now() - 600_000 }),
    incoming({ to: `u${"3".repeat(32)}` }),
    incoming({ toType: "GROUP", to: `c${"4".repeat(32)}` }),
    incoming(), incoming(),
  ]]);
  assert.equal(fixture.sends.length, 1);
  assert.equal(fixture.sends[0].to, oa);
  assert.equal(fixture.sends[0].text, `${marker}-REPLY`);
  assert.equal(fixture.sends[0].e2ee, false);
  assert.equal(fixture.cleared, true);
  assert.equal(states.at(-1).phase, "session_discarded");
  assert.equal(states.at(-1).outcome.status, "accepted");
  assert.ok(!JSON.stringify(states).includes(oa));
  assert.ok(!JSON.stringify(states).includes(marker));
});

test("unmatched traffic never sends a message", async () => {
  const { fixture, states } = await run([[incoming({ text: "different challenge" })]]);
  assert.equal(fixture.sends.length, 0);
  assert.equal(fixture.cleared, true);
  assert.ok(states.some((state) => state.phase === "stopped_without_reply"));
});

test("uncertain sends are not retried and retain a final outcome", async () => {
  const { fixture, states } = await run([[incoming()], [incoming()]], { sendError: true });
  assert.equal(fixture.sends.length, 1);
  assert.equal(states.at(-1).outcome.status, "uncertain");
});

test("a failing observer cannot cause a duplicate send", async () => {
  const { fixture, states } = await run([[incoming()], [incoming()]], { throwAfterReply: true });
  assert.equal(fixture.sends.length, 1);
  assert.equal(states.at(-1).outcome.status, "accepted");
});
