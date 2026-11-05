import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createDetectionLogFilter } from '../extension/lib/logs.js';

const detection = {provider:'shopee',provider_account_id:'shop',surface:'new-webchat'};
const detect = (filter, details=detection, level='info', event='account_detected') => filter(level,'provider',event,details);

test('detection admission preserves first, changed and failure observations but suppresses repeats for five minutes', () => {
  let now=0;
  const filter=createDetectionLogFilter(()=>now);
  assert.deepEqual(detect(filter),detection);
  assert.equal(detect(filter),null);
  now=299999;
  assert.equal(detect(filter),null);
  assert.deepEqual(detect(filter,{...detection,provider_account_id:'other'}),{...detection,provider_account_id:'other'});
  assert.deepEqual(detect(filter,detection,'warn'),detection);
  assert.deepEqual(detect(filter,detection,'error','account_detection_failed'),detection);
  now=300000;
  assert.deepEqual(detect(filter),{...detection,suppressed_count:2});
  assert.deepEqual(detect(filter,{...detection,surface:'seller-centre'}),{...detection,surface:'seller-centre'});
  assert.deepEqual(detect(createDetectionLogFilter(()=>now)),detection,'restart records the first observation');
});

test('detection admission bounds distinct accounts to 512 observations', () => {
  const filter=createDetectionLogFilter(()=>0);
  for(let i=0;i<513;i++) detect(filter,{provider:'shopee',provider_account_id:String(i)});
  assert.equal(detect(filter,{provider:'shopee',provider_account_id:'512'}),null);
  assert.notEqual(detect(filter,{provider:'shopee',provider_account_id:'0'}),null,'oldest observation is evicted');
});

test('leader diagnostics record changes after persistence without changing stored state', async () => {
  const source=readFileSync(new URL('../extension/background.js',import.meta.url),'utf8');
  let current={leader_installation_id:'old',leader:false};
  const events=[];
  const write=vm.runInNewContext(`(${source.slice(source.indexOf('async function writeLiveState('),source.indexOf('\nasync function persistProviderSurfaceState')).trim()})`,{
    accountSyncs:new Map(), STORAGE:{live:'live'},readStorage:async()=>({live:current}),
    readAccountState:state=>state,writeAccountState:(_state,_key,value)=>value,
    writeStorage:async value=>{current=value.live;events.push('persist');},
    recordLog:async(_level,_area,event,_message,details)=>events.push({event,details}),
  });
  const context={key:'shop',account:{provider:'shopee',provider_account_id:'shop'}};
  await write(context,{leader_installation_id:'new',leader:true});
  assert.equal(events[0],'persist');
  assert.equal(events[1].event,'leader_changed');
  assert.equal(events[1].details.previous_leader_installation_id,'old');
  assert.equal(events[1].details.leader_installation_id,'new');
  await write(context,{leader_installation_id:'new',leader:true});
  assert.equal(events.length,2);
  await write(context,{socket:'connected'});
  assert.equal(events.length,3,'unrelated live state adds no leadership log');
  await write(context,{leader_installation_id:null,leader:false});
  assert.equal(events.at(-1).details.leader_installation_id,null);
});


test('logging lifecycle disables alarm and aborts upload for every setup or privacy gate', async () => {
  const source=readFileSync(new URL('../extension/background.js',import.meta.url),'utf8');
  const stored={forwardLog:true,logUploadEnabled:true,serverInitialized:true,consent:true};
  const events=[];
  const reconcile=vm.runInNewContext(`(${source.slice(source.indexOf('async function reconcileLogForwarding('),source.indexOf('\nasync function forwardLogsAutomatically')).trim()})`,{
    STORAGE:new Proxy({}, {get:(_target,key)=>key}),readStorage:async()=>stored,
    automaticLogForwardingEnabled:value=>value.forwardLog !== false,
    hasServerInitialized:value=>value.serverInitialized===true,hasLocalConsent:value=>value===true,
    preemptAutomaticLogUpload:()=>events.push('abort'),LOG_UPLOAD_ALARM:'logs',
    chrome:{alarms:{get:async()=>null,create:async()=>events.push('create'),clear:async()=>events.push('clear')}},
  });
  await reconcile();
  assert.deepEqual(events,['create']);
  for (const key of Object.keys(stored)) {
    events.length=0;
    stored[key]=false;
    await reconcile();
    assert.deepEqual(events,['abort','clear'],key);
    stored[key]=true;
  }
});
