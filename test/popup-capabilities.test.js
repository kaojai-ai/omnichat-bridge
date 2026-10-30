import test from 'node:test';
import assert from 'node:assert/strict';
import { accountCapabilityStatus, accountCapabilitySummary } from '../extension/lib/popup-status.js';
const t = key => key;
test('connected leader status cannot imply sending or sync readiness', () => {
  const live={socket:'connected',leader:true,send_ready:false,sync_ready:false};
  assert.equal(accountCapabilityStatus(live,t).label,'preparingChat');
  assert.equal(accountCapabilityStatus(live,t).state,'neutral');
  assert.equal(accountCapabilitySummary(live,t),'capConnected · sendUnavailable · syncUnavailable');
});
test('send and sync capabilities remain independent', () => {
  assert.equal(accountCapabilityStatus({socket:'connected',send_ready:true,sync_ready:false},t).label,'syncUnavailable');
  assert.equal(accountCapabilityStatus({socket:'connected',send_ready:true,sync_ready:true},t).state,'ready');
});
test('missing tabs, authentication and preparation have actionable labels', () => {
  assert.equal(accountCapabilityStatus({send_ready:false,eligibility_reason_code:'waiting_for_tab'},t).label,'waitingBrowser');
  assert.equal(accountCapabilityStatus({send_ready:false,eligibility_reason_code:'login_required'},t).label,'loginRequired');
  assert.equal(accountCapabilityStatus({socket:'connected',send_ready:false,provider_recovery_state:'opening'},t).label,'preparingChat');
  assert.equal(accountCapabilityStatus({socket:'reconnecting',send_ready:false},t),null);
});
test('legacy status retains existing presentation', () => {
  assert.equal(accountCapabilityStatus({socket:'connected',leader:true},t),null);
  assert.equal(accountCapabilitySummary({socket:'connected'},t),'');
});
