import assert from "node:assert/strict";
import { test } from "node:test";
import { createBrowserFetch } from "../tools/line-personal-probe/browser-fetch.js";

function pendingFetch() {
  return (_request, { signal }) => new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

test("Stop immediately cancels a pending long poll without issuing another request", async () => {
  const session = new AbortController();
  let requests = 0;
  const fetch = createBrowserFetch(session.signal, { fetch: (...args) => {
    requests++;
    return pendingFetch()(...args);
  } });
  const pending = fetch(new Request("https://legy.line-apps.com/SYNC4"));
  const stopped = new Error("Test session stopped");
  session.abort(stopped);
  await assert.rejects(pending, (error) => error === stopped);
  await assert.rejects(fetch("https://legy.line-apps.com/SYNC4"), (error) => error === stopped);
  assert.equal(requests, 1);
});

test("the browser transport preserves the upstream request deadline", async () => {
  const session = new AbortController();
  const upstream = new AbortController();
  const fetch = createBrowserFetch(session.signal, { fetch: pendingFetch() });
  const pending = fetch(new Request("https://legy.line-apps.com/SYNC4", { signal: upstream.signal }));
  const expired = new DOMException("Test upstream deadline", "TimeoutError");
  upstream.abort(expired);
  await assert.rejects(pending, (error) => error === expired);
  assert.equal(session.signal.aborted, false);
});

test("a successful request keeps its response and HTTP failures stay sanitized", async () => {
  const session = new AbortController();
  const response = new Response("test response");
  const fetch = createBrowserFetch(session.signal, { fetch: async (_request, { signal }) => {
    assert.equal(signal.aborted, false);
    return response;
  } });
  assert.equal(await fetch("https://legy.line-apps.com/SYNC4"), response);
  const failed = createBrowserFetch(session.signal, { fetch: async () => new Response("private provider error", { status: 401 }) });
  await assert.rejects(failed("https://legy.line-apps.com/SYNC4"), { message: "LINE_HTTP_REQUEST_FAILED" });
});
