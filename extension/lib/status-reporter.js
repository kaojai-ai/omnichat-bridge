// A reporter belongs to exactly one WebSocket generation.
export function createStatusReporter({ send, id = () => crypto.randomUUID(), setTimer = setTimeout, clearTimer = clearTimeout, onExhausted = () => {} }) {
  let sequence = 0;
  let pending = null;
  let acknowledgedKey = null;
  let timer = null;
  let closed = false;
  const delays = [1000, 2000, 4000, 8000, 16000, 30000];
  function cancelTimer() { clearTimer(timer); timer = null; }
  function transmit() {
    if (closed || !pending) return;
    try { send(pending.report); } catch { /* Retry the identical report. */ }
    if (pending.attempt >= delays.length) {
      const report = pending.report;
      timer = setTimer(() => {
        timer = null;
        if (pending?.report !== report) return;
        pending = null;
        acknowledgedKey = null;
        onExhausted(report);
      }, 30000);
      return;
    }
    const report = pending.report;
    timer = setTimer(() => {
      timer = null;
      if (pending?.report !== report) return;
      pending.attempt += 1;
      transmit();
    }, delays[pending.attempt]);
  }
  return {
    publish(status, key) {
      if (closed || (!pending && key === acknowledgedKey) || key === pending?.key) return false;
      cancelTimer();
      pending = { key, attempt: 0, report: { ...status, report_id: id(), sequence: ++sequence } };
      transmit();
      return true;
    },
    acknowledge(ack) {
      if (closed || ack?.type !== "connection_status_ack" || !pending
        || ack.report_id !== pending.report.report_id || ack.sequence !== pending.report.sequence) return false;
      if (ack.ok === true) { acknowledgedKey = pending.key; pending = null; cancelTimer(); }
      else if (ack.retryable === false) { pending = null; cancelTimer(); }
      return true;
    },
    close() { closed = true; pending = null; cancelTimer(); },
  };
}
