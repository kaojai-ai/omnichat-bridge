import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../extension/line-personal-client.js", import.meta.url), "utf8");
const recovery = source.slice(source.indexOf("function waitForReconnect("), source.indexOf("async function history("));

test("LINE sync backs off, retries immediately on click, resets after success, and stops on rejected login", async () => {
  const delays = [];
  const controller = new AbortController();
  const reconnect = Object.assign(new EventTarget(), { hidden: true });
  const countdown = { hidden: true };
  const connect = {};
  const deleted = [];
  const statuses = [];
  let persisted = 0;
  let attempts = 0;
  let permissionRequests = 0;
  const value = {
    controller,
    ready: true,
    bootstrapRequested: true,
    storage: {
      get: async () => undefined,
      set: async () => { persisted++; },
      delete: async (key) => { deleted.push(key); },
    },
    base: { talk: { sync: async () => {
      attempts++;
      if (attempts === 7) return {};
      if (attempts === 9) throw { data: { code: "NOT_AUTHORIZED_DEVICE" } };
      throw new Error("temporary failure");
    } } },
  };
  const context = vm.createContext({
    ui: { reconnect, countdown, connect },
    scope: "configured-account",
    receipts: new Map(),
    active: () => !controller.signal.aborted,
    configured: async () => true,
    changed() {},
    requestLinePersonalAccess: () => { permissionRequests++; return Promise.resolve(true); },
    report: (...args) => statuses.push(args),
    setInterval: () => 0,
    clearInterval() {},
    setTimeout: (finish, delay) => {
      delays.push(delay);
      setImmediate(() => {
        if (delays.length === 2) {
          assert.equal(reconnect.hidden, false);
          assert.equal(countdown.textContent, "Retrying in 4s");
          reconnect.dispatchEvent(new Event("click"));
          assert.equal(permissionRequests, 1, "manual reconnect requests access directly from the click");
        } else finish();
      });
      return 0;
    },
    clearTimeout() {},
  });
  vm.runInContext(recovery, context);
  await context.poll(value);
  assert.deepEqual(delays, [2000, 4000, 8000, 16000, 30000, 30000, 250, 2000]);
  assert.equal(persisted, 1);
  assert.equal(permissionRequests, 1, "automatic retries do not request access");
  assert.equal(value.ready, false);
  assert.equal(reconnect.hidden, true);
  assert.equal(countdown.hidden, true);
  assert.equal(connect.textContent, "Reconnect LINE");
  assert.deepEqual(deleted, ["authToken"]);
  assert.ok(statuses.some(([, , ready]) => ready));
});
