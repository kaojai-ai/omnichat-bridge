// Bounds the entire operation, including response body reads. Cancellation alone
// is insufficient when a provider ignores its AbortSignal.
export async function withRequestTimeout(operation, timeoutMs, signal) {
  const controller = new AbortController();
  let timer;
  let abort;
  const interrupted = new Promise((_, reject) => {
    abort = () => {
      const error = signal?.reason ?? new Error("Request cancelled.");
      controller.abort(error);
      reject(error);
    };
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => {
      const error = new Error("Request timed out.");
      error.name = "TimeoutError";
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    if (signal?.aborted) return await interrupted;
    return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), interrupted]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
