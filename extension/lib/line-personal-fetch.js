// LINEJS supplies request-specific deadlines (including 180-second long polls).
// The outer ceiling must allow those requests to finish while keeping Stop
// immediately abortable. It also bounds requests with no upstream deadline.
export function createBrowserFetch(signal, { fetch = globalThis.fetch, timeoutMs = 195_000 } = {}) {
  return async (input, init) => {
    signal.throwIfAborted();
    const request = new Request(input, init);
    const response = await fetch(request, {
      signal: AbortSignal.any([request.signal, signal, AbortSignal.timeout(timeoutMs)]),
    });
    if (!response.ok) throw new Error("LINE_HTTP_REQUEST_FAILED");
    return response;
  };
}
