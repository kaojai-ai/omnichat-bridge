import assert from "node:assert/strict";
import test from "node:test";
import { createStatusReporter } from "../extension/lib/status-reporter.js";
function harness() {
  let serial = 0, exhausted = 0;
  const timers = new Map(), sent = [];
  const reporter = createStatusReporter({
    id: () => `report-${++serial}`, send: report => sent.push(report),
    setTimer: callback => { const id = ++serial; timers.set(id, callback); return id; },
    clearTimer: id => timers.delete(id), onExhausted: () => exhausted++,
  });
  const tick = () => { const [id, callback] = timers.entries().next().value; timers.delete(id); callback(); };
  return { reporter, sent, timers, tick, exhausted: () => exhausted };
}
const ack = report => ({ type: "connection_status_ack", report_id: report.report_id, sequence: report.sequence, ok: true });
test("lost ACK retries identical report and matching ACK stops retry", () => {
  const h = harness(); h.reporter.publish({ ready: true }, "ready"); h.tick();
  assert.deepEqual(h.sent[0], h.sent[1]);
  assert.equal(h.reporter.acknowledge({ ...ack(h.sent[0]), report_id: "old" }), false);
  h.reporter.acknowledge(ack(h.sent[0])); assert.equal(h.timers.size, 0);
  assert.equal(h.reporter.publish({ ready: true }, "ready"), false);
});
test("ready-unready-ready supersedes pending report and ignores late ACK", () => {
  const h = harness(); h.reporter.publish({ ready: true }, "ready"); h.reporter.acknowledge(ack(h.sent[0]));
  h.reporter.publish({ ready: false }, "blocked"); h.reporter.publish({ ready: true }, "ready");
  assert.deepEqual(h.sent.map(report => report.ready), [true, false, true]);
  assert.equal(h.reporter.acknowledge(ack(h.sent[1])), false);
  assert.equal(h.reporter.acknowledge(ack(h.sent[2])), true);
});
test("bounded retry exhaustion permits unchanged status on a later health check", () => {
  const h = harness(); h.reporter.publish({ ready: true }, "ready");
  while (h.timers.size) h.tick();
  assert.equal(h.sent.length, 7); assert.equal(h.exhausted(), 1);
  assert.equal(h.reporter.publish({ ready: true }, "ready"), true);
  h.reporter.close(); assert.equal(h.timers.size, 0);
  assert.equal(h.reporter.acknowledge(ack(h.sent.at(-1))), false);
});
