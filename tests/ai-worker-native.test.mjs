import test from 'node:test';
import assert from 'node:assert/strict';
import {fromMatch,practice} from './ai-helpers.mjs';
import {value} from './helpers.mjs';
import {closedFourThreat} from './tactical-fixtures.mjs';
import {nativeFixture} from './native-worker-host.mjs';

test('the real worker entry replays, searches, returns only its reply and is physically terminated',{timeout:7000},async()=>{
 const s=fromMatch(closedFourThreat()),f=nativeFixture(s);
 try{
  value(f.driver.start());await f.until(state=>state.status==='idle'&&s.state.match.state.ply===9);
  assert.equal(s.state.match.state.lastPlacement,40);assert.equal(f.ports.length,1);
  assert.equal(f.ports[0].sent[0].record.actions.length,8);assert.equal(f.ports[0].messages[0].kind,'ready');
  assert.equal(f.ports[0].messages[1].kind,'result');assert.equal(f.ports[0].messages[1].details,undefined);
  assert.equal(f.ports[0].terminated,1);assert.equal(f.timers.size,0);
  await Promise.all(f.terminations);assert.equal(f.ports[0].exited,true);
 }finally{await f.cleanup();}
});

test('a genuinely CPU-bound thread is terminated by the compute watchdog while the main event loop stays responsive',{timeout:7000},async()=>{
 const s=practice('A',{},'easy'),f=nativeFixture(s,'hang',{startupMs:2000,graceMs:0}),before=s.state.match;
 let heartbeats=0;const pulse=setInterval(()=>{if(f.ports[0]?.sent.length)heartbeats++;},5);
 try{
  value(f.driver.start());await f.until(state=>state.status==='failed');
  assert.equal(f.driver.state.error.code,'AI_NO_RESULT');assert.equal(s.state.match,before);assert.ok(heartbeats>=2);
  assert.equal(f.ports[0].terminated,1);await Promise.all(f.terminations);assert.equal(f.ports[0].exited,true);assert.equal(f.timers.size,0);
 }finally{clearInterval(pulse);await f.cleanup();}
});

test('startup watchdog and explicit pause terminate real threads and leave no task or timer behind',{timeout:7000},async()=>{
 for(const mode of ['startup-hang','hang']){
  const s=practice('A',{},'easy'),f=nativeFixture(s,mode,{startupMs:mode==='startup-hang'?60:2000,graceMs:100});
  try{
   value(f.driver.start());
   if(mode==='hang'){
    await f.until(state=>state.status==='thinking');await new Promise(resolve=>setTimeout(resolve,20));value(f.driver.pause());
   }else await f.until(state=>state.status==='failed');
   assert.equal(s.state.paused,true);assert.equal(s.state.task,null);assert.equal(f.ports[0].terminated,1);
   await Promise.all(f.terminations);assert.equal(f.ports[0].exited,true);assert.equal(f.timers.size,0);
  }finally{await f.cleanup();}
 }
});
