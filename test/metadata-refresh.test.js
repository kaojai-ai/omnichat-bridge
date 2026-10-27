import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = Object.fromEntries(await Promise.all(["shopee", "line-oa"].map(async (provider) => [provider,
  await readFile(new URL(`../extension/${provider}-realtime.js`, import.meta.url), "utf8")])));
const plain = (input) => JSON.parse(JSON.stringify(input));

// Exercise the actual command handler with controlled provider list responses.
// No page polling, message recovery or command send work is bootstrapped here.
function refreshFixture(provider, { count = 125, failPage = 0, changePage = 0, expirePage = 0 } = {}) {
  let now = 1_000;
  let changed = false;
  const requests = [];
  const posts = [];
  const state = { routeSessionEpoch: 1, currentAccountId: "shop-1", listTemplate: {
    url: "https://seller.test/conversations?offset=25&limit=25", init: { method: "GET" },
  } };
  const window = { location: { href: "https://chat.line.biz/bot/chats" } };
  const account = provider === "shopee" ? "shop-1" : "@shop";
  const row = (index) => provider === "shopee"
    ? { id: `chat-${index}`, shop_id: account, to_id: `buyer-${index}`, to_name: `Buyer ${index}`, to_avatar: "https://image.test/avatar" }
    : { chatId: `chat-${index}`, profile: { userId: `buyer-${index}`, displayName: `Buyer ${index}`, pictureUrl: "https://image.test/avatar" } };
  const list = async (input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    requests.push(url);
    if (url.pathname.endsWith("/bots")) return { list: [{ basicSearchId: account, botId: "bot-1", name: "Shop" }] };
    assert.match(url.pathname, /(?:conversations|chats)$/);
    const offset = Number(url.searchParams.get(provider === "shopee" ? "offset" : "next")) || 0;
    const page = offset / 25 + 1;
    if (page === changePage) { changed = true; state.routeSessionEpoch += 1; window.location.href += "?changed"; }
    if (page === expirePage) now = 40_000;
    if (page === failPage) throw new Error("Provider unavailable.");
    const items = Array.from({ length: Math.min(25, count - offset) }, (_, i) => row(offset + i));
    return provider === "shopee" ? { conversations: items, next: offset + 25 < count ? String(offset + 25) : null }
      : { list: items, next: offset + 25 < count ? String(offset + 25) : null };
  };
  const context = vm.createContext({
    window, state, URL, Request, Set, Math, Date: { now: () => now },
    value: (input) => input == null ? "" : String(input).trim(),
    normalizeBasicId: (input) => input == null ? "" : `@${String(input).replace(/^@+/, "")}`,
    isBridgeActive: () => !changed, disposed: false, metadataSessionEpoch: 0,
    post: (message) => posts.push(plain(message)),
    detectSessionAccount: async () => [{ provider: "shopee", provider_account_id: account, display_name: "Shop" }],
    lookupTemplateFrom: async (template) => ({ ...template, init: { ...template.init } }),
    fetchProviderJson: list, shopeeError: () => false,
    conversationItems: (body) => body.conversations,
    nextConversationRequest: async (request, body) => {
      if (!body.next) return null;
      const url = new URL(request.url); url.searchParams.set("offset", body.next); return new Request(url);
    },
    apiBase: "https://chat.line.biz/api", json: list, CHAT_PAGE_LIMIT: 25,
    chatUrl: (botId, next) => `https://chat.line.biz/api/v2/bots/${botId}/chats${next ? `?next=${next}` : ""}`,
    cursor: (input) => input || null, OmnichatLineOA: { chatItems: (body) => body.list },
  });
  const start = source[provider].indexOf("  async function refreshMetadata(command) {");
  const end = source[provider].indexOf(provider === "shopee" ? "\n  async function detectCurrentAccount" : "\n  const listener", start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(`${source[provider].slice(start, end)}; globalThis.refresh = refreshMetadata;`, context);
  return { requests, posts, async run(overrides = {}) {
    await context.refresh({ request_id: "refresh-1", provider_account_id: account, deadline_at: 31_000, limit: 100, ...overrides });
    return posts.at(-1);
  } };
}

for (const provider of ["shopee", "line-oa"]) {
  test(`${provider} manual refresh caps pagination at 100 customers and never reads messages`, async () => {
    const fixture = refreshFixture(provider);
    const result = await fixture.run();
    assert.equal(result.ok, true);
    assert.equal(result.partial, true);
    assert.equal(result.profiles.length, 100);
    assert.equal(result.profiles[0].id, "buyer-0");
    assert.equal(result.profiles[99].conversation_id, "chat-99");
    assert.equal(fixture.requests.filter((url) => !url.pathname.endsWith("/bots")).length, 4);
    assert.ok(fixture.requests.every((url) => !url.pathname.includes("messages")));
  });
  test(`${provider} partial list failure preserves completed pages`, async () => {
    const result = await refreshFixture(provider, { failPage: 2 }).run();
    assert.equal(result.ok, true);
    assert.equal(result.partial, true);
    assert.equal(result.profiles.length, 25);
    assert.ok(result.account);
  });
  test(`${provider} changed context discards old metadata`, async () => {
    const result = await refreshFixture(provider, { changePage: 2 }).run();
    assert.equal(result.ok, false);
    assert.deepEqual(result.profiles, []);
    assert.equal(result.account, undefined);
  });
  test(`${provider} expired refresh discards late metadata`, async () => {
    const result = await refreshFixture(provider, { expirePage: 2 }).run();
    assert.equal(result.ok, false);
    assert.deepEqual(result.profiles, []);
    assert.equal(result.account, undefined);
  });
  test(`${provider} wrong account cannot return cached metadata`, async () => {
    const result = await refreshFixture(provider).run({ provider_account_id: "wrong-account" });
    assert.equal(result.ok, false);
    assert.deepEqual(result.profiles, []);
    assert.equal(result.account, undefined);
  });
}

test("Shopee known metadata is skipped while fresh routing continues to reach content", () => {
  const posts = [];
  let route;
  const context = vm.createContext({
    state: { profilesByConversation: new Map() }, URL,
    value: (input) => input == null ? "" : String(input).trim(),
    rememberRoute: (conversation) => { route = { to_id: conversation.to_id, observed_at: "2026-10-27T00:00:00.000Z", observed_fields: { to_id: conversation.to_id, biz_id: conversation.biz_id } }; },
    cachedRoute: () => route,
    post: (message) => posts.push(plain(message)),
  });
  const start = source.shopee.indexOf("  const captureProfiles = (conversations) => {");
  const end = source.shopee.indexOf("\n  const messageIdOf", start);
  vm.runInContext(`${source.shopee.slice(start, end)}; globalThis.capture = captureProfiles;`, context);
  context.capture([{ id: "chat", shop_id: "shop", to_id: "123", to_name: "Original", biz_id: "1" }]);
  context.capture([{ id: "chat", shop_id: "shop", to_id: "123", to_name: "Changed", biz_id: "2" }]);
  assert.equal(posts[0].profiles[0].display_name, "Original");
  assert.equal(posts[1].profiles[0].display_name, undefined);
  assert.equal(posts[1].profiles[0].omnichat.routing.fields.biz_id, "2");
  assert.equal(context.state.profilesByConversation.get("chat").display_name, "Original");
});

test("LINE natural metadata fills missing fields once and isolates customer/account identities", () => {
  const posts = [];
  const context = vm.createContext({ metadataProfilesByAccount: new Map(), Map, URL,
    value: (input) => input == null ? "" : String(input).trim(), post: (message) => posts.push(plain(message)) });
  const start = source["line-oa"].indexOf("  function captureChatProfile(providerAccountId, chat) {");
  const end = source["line-oa"].indexOf("\n  async function queueMessagePage", start);
  vm.runInContext(`${source["line-oa"].slice(start, end)}; globalThis.capture = captureChatProfile;`, context);
  const chat = (userId, name, pictureUrl) => ({ chatId: "chat", profile: { userId, displayName: name, pictureUrl } });
  context.capture("account-a", chat("buyer-a", "Original"));
  context.capture("account-a", chat("buyer-a", "Changed", "https://image.test/avatar"));
  context.capture("account-a", chat("buyer-a", "Changed again", "https://image.test/changed"));
  assert.equal(posts.length, 2);
  assert.equal(posts[0].profiles[0].display_name, "Original");
  assert.equal(posts[1].profiles[0].display_name, undefined);
  assert.equal(posts[1].profiles[0].avatar_url, "https://image.test/avatar");
  context.capture("account-a", chat("buyer-b", "Different customer"));
  context.capture("account-b", chat("buyer-a", "Different account"));
  assert.equal(posts.length, 4);
  for (let i = 0; i < 1_001; i += 1) context.capture("account-c", { chatId: `chat-${i}`, profile: { displayName: `Customer ${i}` } });
  assert.equal(context.metadataProfilesByAccount.get("account-c").size, 1_000);
});
