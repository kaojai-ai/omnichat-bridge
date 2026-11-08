import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { forwardLogLevel } from '../extension/lib/log-forwarding.js';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../extension/popup.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../extension/popup.html', import.meta.url), 'utf8');
test('Forward Log sits below device name and persists immediately without config save', async () => {
  assert.ok(html.indexOf('id="forward-log"') > html.indexOf('id="device-name"'));
  assert.ok(html.indexOf('id="config"') < html.indexOf('id="device-name"'));
  let change;
  const writes=[];
  const input={value:"warn",disabled:false,addEventListener:(_,handler)=>{change=handler;}};
  const scope=vm.createContext({forwardLogInput:input,forwardLog:"info",forwardLogLevel,STORAGE:{forwardLog:'forward_log'},writeStorage:async value=>writes.push(value),reportPopupError:()=>{throw Error('unexpected')}});
  vm.runInContext(source.slice(source.indexOf('forwardLogInput.addEventListener("change"')),scope);
  await change();
  assert.equal(writes[0].forward_log,"warn");
  assert.equal(scope.forwardLog,"warn");
  assert.equal(input.disabled,false);
});
test('saved off hydration survives opening settings and description uses translations', () => {
  const stored={forward_log:false};
  const scope=vm.createContext({stored,STORAGE:{forwardLog:'forward_log'},forwardLog:"info",forwardLogLevel,forwardLogInput:{}});
  const start=source.indexOf('  forwardLog = forwardLogLevel(stored);');
  vm.runInContext(source.slice(start,source.indexOf('\n  applyTranslations();',start)),scope);
  assert.equal(scope.forwardLogInput.value,"off");
  assert.match(source,/t\("forwardLogDescription"\)/);
});

test('failed level change restores the saved preference', async () => {
  let change;
  let reported = false;
  const input = {value: "off", disabled: false, addEventListener: (_, handler) => { change = handler; }};
  const scope = vm.createContext({forwardLogInput: input, forwardLog: "info", STORAGE: {forwardLog: "forward_log"},
    writeStorage: async () => { throw new Error("storage unavailable"); }, reportPopupError: () => { reported = true; }});
  vm.runInContext(source.slice(source.indexOf('forwardLogInput.addEventListener("change"')), scope);
  await change();
  assert.equal(input.value, "info");
  assert.equal(scope.forwardLog, "info");
  assert.equal(input.disabled, false);
  assert.equal(reported, true);
});
