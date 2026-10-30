import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../extension/popup.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../extension/popup.html', import.meta.url), 'utf8');
test('Forward Log sits below device name and persists immediately without config save', async () => {
  assert.ok(html.indexOf('id="forward-log"') > html.indexOf('id="device-name"'));
  assert.ok(html.indexOf('id="forward-log"') < html.indexOf('id="config"'));
  let change;
  const writes=[];
  const input={checked:false,disabled:false,addEventListener:(_,handler)=>{change=handler;}};
  const scope=vm.createContext({forwardLogInput:input,forwardLog:true,STORAGE:{forwardLog:'forward_log'},writeStorage:async value=>writes.push(value),reportPopupError:()=>{throw Error('unexpected')}});
  vm.runInContext(source.slice(source.indexOf('forwardLogInput.addEventListener("change"')),scope);
  await change();
  assert.equal(writes[0].forward_log,false);
  assert.equal(scope.forwardLog,false);
  assert.equal(input.disabled,false);
});
test('saved off hydration survives opening settings and description uses translations', () => {
  const stored={forward_log:false};
  const scope=vm.createContext({stored,STORAGE:{forwardLog:'forward_log'},forwardLog:true,forwardLogInput:{}});
  const start=source.indexOf('  forwardLog = stored[STORAGE.forwardLog] !== false;');
  vm.runInContext(source.slice(start,source.indexOf('\n  applyTranslations();',start)),scope);
  assert.equal(scope.forwardLogInput.checked,false);
  assert.match(source,/t\("forwardLogDescription"\)/);
});
