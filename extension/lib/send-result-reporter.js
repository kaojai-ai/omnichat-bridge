// A final result belongs to one command and its original WebSocket connection.
// Only the result is retried; the provider request must never be replayed here.
export function createSendResultReporter({ requestId, send, deadlineAt, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout, onSettled = () => {} }) {
  let report = null;
  let retryTimer = null;
  let closed = false;
  let attempt = 0;
  const delays = [250, 500, 1000, 2000, 4000];
  const finish = (acknowledged) => {
    if (closed) return;
    closed = true;
    clearTimer(retryTimer);
    clearTimer(expiryTimer);
    onSettled(acknowledged);
  };
  const expiryTimer = setTimer(() => finish(false), Math.max(1, deadlineAt - now()));
  const transmit = () => {
    if (closed || !report) return;
    try { send(report); } catch { /* Retry the same final report until the deadline. */ }
    if (closed) return;
    const remaining = deadlineAt - now();
    if (remaining <= 0) { finish(false); return; }
    retryTimer = setTimer(transmit, Math.min(remaining, delays[Math.min(attempt++, delays.length - 1)]));
  };
  return {
    publish(result) {
      if (closed || report) return false;
      report = { ...result, type: "send_result", request_id: requestId };
      transmit();
      return true;
    },
    acknowledge(message) {
      if (closed || !report || message?.type !== "send_result_ack" || message.request_id !== requestId) return false;
      finish(true);
      return true;
    },
  };
}
