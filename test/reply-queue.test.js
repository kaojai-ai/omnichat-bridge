import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { createReplyQueue } from "../extension/lib/reply-queue.js";

const source = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
function harness(sendViaProvider) {
  const replyQueue = createReplyQueue();
  const background = deferred();
  const events = [];
  const sandbox = {
    replyQueue, liveCommandResults: new Map(), liveConnections: new Map(),
    scheduleKeepalive: () => {}, WebSocket: { OPEN: 1 }, Date,
    providerAdapterForCommand: (command) => ({ id: command.provider, supportsSend: () => true }),
    messageProviderAccountId: (command) => command.provider_account_id,
    canonicalProviderAccountId: (context) => context.account.provider_account_id,
    exclusive: (action) => background.promise.then(action), sendViaProvider,
    recordUnexpected: async () => {}, sendConnectionStatus: async () => {},
    installationId: async () => "installation", activeSync: null,
    STORAGE: { extensionUpdate: "update" },
    readStorage: async () => ({ update: { status: "available" } }),
    updateStateForCurrentVersion: (state) => state, storeExtensionUpdate: async () => {},
    chrome: { runtime: { reload: () => events.push("reload") } },
  };
  const start = source.indexOf("async function handleLiveCommand(");
  const end = source.indexOf("\nchrome.storage.onChanged", start);
  const run = vm.runInNewContext(`(${source.slice(start, end).trim()})`, sandbox);
  const updateStart = source.indexOf("async function applyExtensionUpdate(");
  const updateEnd = source.indexOf("\nchrome.runtime.onMessage", updateStart);
  const update = vm.runInNewContext(`(${source.slice(updateStart, updateEnd).trim()})`, sandbox);
  const socket = { readyState: 1, sent: [], send(data) {
    const result = JSON.parse(data);
    this.sent.push(result);
    events.push(`ack:${result.request_id}`);
  } };
  return {
    replyQueue, background, events, socket, update,
    send(request, account = "shop", provider = "shopee") {
      return run(JSON.stringify({ type: "send_text", provider, provider_account_id: account, request_id: request }),
        { key: `${provider}:${account}`, account: { provider, provider_account_id: account } }, socket);
    },
  };
}

test("live replies finish while a background upload is blocked", async () => {
  const h = harness(async () => ({ ok: true, provider_message_id: "receipt" }));
  const done = h.send("reply");
  await tick();
  assert.equal(h.socket.sent.length, 1);
  assert.equal(h.socket.sent[0].ok, true);
  h.background.resolve();
  await done;
});

test("same-account replies stay ordered, other shops and providers can send", async () => {
  const first = deferred();
  const started = [];
  const h = harness((command) => {
    started.push(command.request_id);
    return command.request_id === "first" ? first.promise : Promise.resolve({ ok: true, provider_message_id: command.request_id });
  });
  const jobs = [h.send("first"), h.send("second"), h.send("other-shop", "other"), h.send("other-provider", "shop", "line_oa")];
  await tick();
  assert.deepEqual(started, ["first", "other-shop", "other-provider"]);
  first.reject(new Error("Provider rejected first reply"));
  await Promise.all(jobs);
  assert.equal(started.at(-1), "second");
  assert.equal(h.socket.sent.find((item) => item.request_id === "second").ok, true);
});

test("duplicate requests queued behind another reply send only once", async () => {
  const first = deferred();
  const started = [];
  const h = harness((command) => {
    started.push(command.request_id);
    return command.request_id === "first" ? first.promise : Promise.resolve({ ok: true, provider_message_id: "receipt" });
  });
  const jobs = [h.send("first"), h.send("duplicate"), h.send("duplicate")];
  await tick();
  assert.deepEqual(started, ["first"]);
  first.resolve({ ok: true, provider_message_id: "first-receipt" });
  await Promise.all(jobs);
  assert.deepEqual(started, ["first", "duplicate"]);
  assert.equal(h.socket.sent.filter((item) => item.request_id === "duplicate").length, 2);
});

test("update waits for queued replies and their acknowledgements before restarting", async () => {
  const first = deferred();
  const h = harness((command) => command.request_id === "first" ? first.promise : Promise.resolve({ ok: true, provider_message_id: "second-receipt" }));
  h.background.resolve();
  const sends = [h.send("first"), h.send("second")];
  await tick();
  const update = h.update();
  await tick();
  assert.deepEqual(h.events, []);
  await h.send("during-update");
  assert.equal(h.socket.sent.find((item) => item.request_id === "during-update").ok, false);
  first.resolve({ ok: true, provider_message_id: "first-receipt" });
  await Promise.all([...sends, update]);
  assert.deepEqual(h.events.slice(-3), ["ack:first", "ack:second", "reload"]);
});

test("concurrent tab selections preserve both accounts", async () => {
  let stored = {};
  const start = source.indexOf("function rememberCommandTab(");
  const end = source.indexOf("\nasync function commandTab", start);
  const remember = vm.runInNewContext(`(${source.slice(start, end).trim()})`, {
    commandTabWriteQueue: Promise.resolve(), STORAGE: { commandTab: "tabs" },
    readStorage: async () => ({ tabs: { ...stored } }),
    writeAccountState: (current, account, tab) => ({ ...current, [account]: tab }),
    writeStorage: async ({ tabs }) => { await tick(); stored = tabs; },
  });
  await Promise.all([remember("shopee:one", 1), remember("shopee:two", 2)]);
  assert.deepEqual(stored, { "shopee:one": 1, "shopee:two": 2 });
});
