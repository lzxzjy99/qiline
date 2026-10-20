import test from 'node:test';
import assert from 'node:assert/strict';
import {activePlayer} from '../dist/core/src/index.js';
import {createSession} from '../dist/session/src/index.js';
import {createAIWorkerController} from '../dist/ai/src/index.js';
import {practice,place,point,fromMatch} from './ai-helpers.mjs';
import {value,error,fingerprint} from './helpers.mjs';
import {immediateWin} from './tactical-fixtures.mjs';
import {workerFixture,VirtualHost,FakeWorker} from './worker-fakes.mjs';
const pass={kind:'pass',actor:'A'};

test('host/limit validation is strict and copies limits; PvP never starts an AI worker',()=>{
 const s=practice(),v=new VirtualHost();
 for(const bad of [null,{}, {...v.host,extra:true},{...v.host,now:1}])error(createAIWorkerController(s,bad),'INVALID_AI_REQUEST');
 for(const limits of [null,{}, {startupMs:0,graceMs:1},{startupMs:1,graceMs:-1},{startupMs:10001,graceMs:0},{startupMs:1,graceMs:1001}])
  error(createAIWorkerController(s,v.host,limits),'INVALID_AI_REQUEST');
 error(createAIWorkerController(s,{...v.host,now:()=>NaN}),'AI_WORKER_FAILED');
 const pvp=workerFixture(value(createSession({matchId:'pvp'})));pvp.start();assert.equal(pvp.clock.workers.length,0);assert.equal(pvp.clock.timers.size,0);
});

test('one ready handshake posts one request and duplicate start/sync/ready cannot create a second task',()=>{
 const f=workerFixture(),w=f.start();assert.equal(f.driver.state.status,'starting');assert.equal(w.sent.length,0);
 value(f.driver.start());value(f.driver.sync());f.clock.tick();assert.equal(f.clock.workers.length,1);
 w.ready();w.ready();assert.equal(w.sent.length,1);assert.equal(f.driver.state.status,'thinking');
 assert.equal(w.sent[0].context.actor,'A');f.driver.close();
});

test('a valid reply commits once, detaches listeners, terminates the thread and clears every timer',()=>{
 const f=workerFixture(),w=f.start();w.ready();const callback=w.onmessage,message=w.result(pass);w.emit(message);
 assert.equal(f.session.state.match.state.ply,1);assert.equal(w.terminated,1);assert.equal(w.onmessage,null);
 assert.equal(f.clock.timers.size,0);const before=f.session.state;callback({data:message});f.clock.tick(10000);
 assert.equal(f.session.state,before);assert.equal(f.clock.workers.length,1);
});

test('three opening placements run on separate macrotasks and fresh workers with A staying active',()=>{
 const f=workerFixture(practice('A',{swap3:true}));let w=f.start();
 for(const [i,c]of ['I2','I4','I6'].entries()){
  w.ready();assert.equal(w.sent[0].context.actor,'A');w.emit(w.result({kind:'place',actor:'A',point:point(f.session,c)}));
  assert.equal(w.terminated,1);assert.equal(f.clock.workers.length,i+1);
  if(i<2){f.clock.tick();w=f.clock.workers.at(-1);}
 }
 assert.equal(f.session.state.match.state.phase.kind,'choose');assert.equal(f.clock.timers.size,0);assert.equal(f.clock.workers.length,3);
});

test('B choosing white is followed by a separate B move without an intervening A task',()=>{
 const s=practice('B',{swap3:true});for(const c of ['I2','I4','I6'])place(s,c);
 const f=workerFixture(s),first=f.start();first.ready();first.emit(first.result({kind:'choose-color',actor:'B',color:'white'}));
 assert.equal(activePlayer(s.state.match),'B');assert.equal(f.clock.workers.length,1);f.clock.tick();
 const second=f.clock.workers.at(-1);second.ready();assert.equal(second.sent[0].context.actor,'B');
 second.emit(second.result({kind:'place',actor:'B',point:point(s,'E5')}));
 assert.equal(s.state.match.state.ply,4);assert.equal(activePlayer(s.state.match),'A');assert.equal(f.clock.timers.size,0);
});

test('pause terminates startup and active searches immediately; resume uses a new request identity',()=>{
 for(const thinking of [false,true]){
  const f=workerFixture(),w=f.start();if(thinking)w.ready();const old=w.onmessage,before=f.session.state.match;
  value(f.driver.pause());assert.equal(w.terminated,1);assert.equal(f.clock.timers.size,0);assert.equal(f.driver.state.status,'paused');
  old({data:{protocolVersion:1,kind:'ready'}});assert.equal(f.session.state.match,before);
  value(f.driver.resume());f.clock.tick();const next=f.clock.workers.at(-1);next.ready();
  assert.notEqual(next,w);next.emit(next.result(pass));assert.equal(f.session.state.match.state.ply,1);
 }
});

test('an external direct pause is noticed by the running-task monitor and actually terminates the worker',()=>{
 const f=workerFixture(),w=f.start();w.ready();value(f.session.setPaused(true));
 f.clock.tick(50);assert.equal(w.terminated,1);assert.equal(f.clock.timers.size,0);assert.equal(f.driver.state.status,'paused');
});

test('externally clearing a current task stops it and waits for continue rather than immediately recreating it',()=>{
 const f=workerFixture(),w=f.start();w.ready();value(f.session.cancelTask());f.clock.tick(50);
 assert.equal(w.terminated,1);assert.equal(f.session.state.paused,true);assert.equal(f.driver.state.status,'paused');
 f.clock.tick(1000);assert.equal(f.clock.workers.length,1);assert.equal(f.clock.timers.size,0);
});

test('a reply notices a direct pause even before the monitoring timer fires',()=>{
 const f=workerFixture(),w=f.start();w.ready();const message=w.result(pass),before=f.session.state.match;
 value(f.session.setPaused(true));w.emit(message);assert.equal(f.session.state.match,before);assert.equal(w.terminated,1);
});

test('startup timeout fails and pauses, and explicit retry creates a fresh worker instead of looping',()=>{
 const f=workerFixture(),w=f.start(),before=f.session.state.match;f.clock.tick(100);
 assert.equal(w.terminated,1);assert.equal(f.session.state.match,before);assert.equal(f.driver.state.error.code,'AI_WORKER_FAILED');
 assert.equal(f.driver.state.status,'failed');assert.equal(f.clock.timers.size,0);value(f.driver.start());f.clock.tick(1000);
 assert.equal(f.clock.workers.length,1);value(f.driver.retry());f.clock.tick();const next=f.clock.workers.at(-1);next.ready();next.emit(next.result(pass));
 assert.equal(f.session.state.match.state.ply,1);
});

test('compute hard timeout terminates the actual job and returns no automatic game command',()=>{
 const f=workerFixture(),w=f.start();w.ready();const before=f.session.state.match;
 f.clock.tick(w.sent[0].budget.timeMs+10);assert.equal(w.terminated,1);assert.equal(f.session.state.match,before);
 assert.equal(f.driver.state.error.code,'AI_NO_RESULT');assert.equal(f.session.state.paused,true);assert.equal(f.clock.timers.size,0);
});

test('a late ready or result is rejected by the monotonic deadline even if the timeout callback was delayed',()=>{
 for(const ready of [false,true]){
  const f=workerFixture(),w=f.start();if(ready)w.ready();const before=f.session.state.match;
  f.clock.time=ready?w.sent[0].budget.timeMs+11:101;
  if(ready)w.emit(w.result(pass));else w.ready();
  assert.equal(w.terminated,1);assert.equal(f.session.state.match,before);assert.equal(f.driver.state.status,'failed');
 }
});

test('duplicate readiness cannot extend the compute deadline or post the record twice',()=>{
 const f=workerFixture(),w=f.start();w.ready();const budget=w.sent[0].budget.timeMs;
 f.clock.tick(budget/2);w.ready();assert.equal(w.sent.length,1);f.clock.tick(budget/2+10);
 assert.equal(w.terminated,1);assert.equal(f.driver.state.error.code,'AI_NO_RESULT');
});

test('errors, message decode failures and send failures terminate and pause without moving',()=>{
 for(const kind of ['error','messageerror','send']){
  const f=workerFixture(),w=f.start(),before=f.session.state.match;
  if(kind==='send'){w.postMessage=()=>{throw Error('clone error');};w.ready();}
  else{w.ready();w[kind==='error'?'onerror':'onmessageerror']({});}
  assert.equal(w.terminated,1);assert.equal(f.session.state.match,before);assert.equal(f.driver.state.status,'failed');
  assert.equal(f.clock.timers.size,0);assert.equal(f.session.state.paused,true);
 }
});

test('constructor failure is retryable and never leaves a Session task or timer alive',()=>{
 const f=workerFixture();f.clock.factory=()=>{throw Error('Worker blocked');};f.start();
 assert.equal(f.driver.state.status,'failed');assert.equal(f.session.state.task,null);assert.equal(f.clock.timers.size,0);
 f.clock.factory=null;value(f.driver.retry());f.clock.tick();const w=f.clock.workers.at(-1);w.ready();w.emit(w.result(pass));
 assert.equal(f.session.state.match.state.ply,1);
});

test('malformed responses, forbidden commands and illegal points pause and terminate without changing the board',()=>{
 for(const mutate of [r=>r.extra=1,r=>r.action={kind:'resign',actor:'A'},r=>r.action.point=81,r=>r.context.actor='C',r=>delete r.stats]){
  const f=workerFixture(),w=f.start();w.ready();const before=f.session.state.match,message=w.result({kind:'place',actor:'A',point:40});mutate(message);w.emit(message);
  assert.equal(f.session.state.match,before);assert.equal(f.driver.state.status,'failed');assert.equal(w.terminated,1);assert.equal(f.clock.timers.size,0);
 }
});

test('a well-formed stale correlation is ignored while the current worker remains eligible to reply',()=>{
 const f=workerFixture(),w=f.start();w.ready();const old=w.result(pass);old.context={...old.context,requestId:'old'};
 const before=f.session.state;w.emit(old);assert.equal(f.session.state,before);assert.equal(w.terminated,0);
 w.emit(w.result(pass));assert.equal(f.session.state.match.state.ply,1);assert.equal(w.terminated,1);
});

test('undo returning to AI opening A holds until explicit continue and does not replay immediately',()=>{
 const f=workerFixture(practice('A',{swap3:true})),first=f.start();first.ready();first.emit(first.result({kind:'place',actor:'A',point:40}));
 f.clock.tick();const second=f.clock.workers.at(-1);second.ready();
 value(f.driver.change(()=>f.session.requestUndo('B')));assert.equal(second.terminated,1);assert.equal(f.session.state.match.state.ply,0);
 assert.equal(f.driver.state.hold,'undo');assert.equal(f.session.state.paused,true);f.clock.tick(1000);assert.equal(f.clock.workers.length,2);
 value(f.driver.resume());f.clock.tick();assert.equal(f.clock.workers.length,3);f.driver.close();
});

test('undoing a zero-ply color choice also holds B instead of instantly choosing again',()=>{
 const s=practice('B',{swap3:true});for(const c of ['I2','I4','I6'])place(s,c);
 const f=workerFixture(s),w=f.start();w.ready();w.emit(w.result({kind:'choose-color',actor:'B',color:'white'}));f.clock.tick();
 const next=f.clock.workers.at(-1);next.ready();value(f.driver.change(()=>s.requestUndo('A')));
 assert.equal(s.state.match.state.ply,3);assert.equal(s.state.match.state.phase.kind,'choose');assert.equal(next.terminated,1);
 assert.equal(f.driver.state.hold,'undo');assert.equal(f.clock.timers.size,0);f.driver.close();
});

test('undo returning to a human turn allows the human to move again without an unnecessary AI continue',()=>{
 const s=practice('B');place(s,'E5');const f=workerFixture(s),w=f.start();w.ready();
 value(f.driver.change(()=>s.requestUndo('A')));assert.equal(w.terminated,1);assert.equal(s.state.paused,false);assert.equal(f.driver.state.hold,null);
 value(f.driver.change(()=>s.submit('A',{kind:'place',actor:'A',point:0})));f.clock.tick();assert.equal(f.clock.workers.length,2);f.driver.close();
});

test('failed undo/load commands preserve the existing task and worker',()=>{
 const f=workerFixture(),w=f.start();w.ready();const before=f.session.state;
 error(f.driver.change(()=>f.session.requestUndo('B')),'NO_UNDO');assert.equal(f.session.state,before);
 const bad=structuredClone(f.session.exportSave());bad.record.actions.push({kind:'place',actor:'B',point:0});
 assert.equal(f.driver.change(()=>f.session.loadSave('bad',bad)).ok,false);assert.equal(f.session.state,before);assert.equal(w.terminated,0);
 w.emit(w.result(pass));assert.equal(f.session.state.match.state.ply,1);
});

test('new game and successful load release old work; old callbacks cannot affect the new match',()=>{
 for(const replace of ['new','load']){
  const f=workerFixture(),w=f.start();w.ready();const oldCallback=w.onmessage,oldMessage=w.result(pass),save=f.session.exportSave();
  value(f.driver.change(()=>replace==='new'?f.session.newGame('new'):f.session.loadSave('loaded',save)));
  assert.equal(w.terminated,1);f.clock.tick();const fresh=f.clock.workers.at(-1);fresh.ready();const before=f.session.state;
  assert.notEqual(fresh.sent[0].context.requestId,w.sent[0].context.requestId);oldCallback({data:oldMessage});assert.equal(f.session.state,before);
  fresh.emit(fresh.result(pass));assert.equal(f.session.state.match.state.ply,1);
 }
});

test('resignation, terminal AI replies and closing end work without further automatic tasks',()=>{
 const f=workerFixture(),w=f.start();w.ready();value(f.driver.change(()=>f.session.submit('B',{kind:'resign',actor:'B'})));
 assert.equal(w.terminated,1);assert.equal(f.session.state.match.state.outcome.winner,'A');assert.equal(f.clock.timers.size,0);
 const win=workerFixture(fromMatch(immediateWin())),bot=win.start();bot.ready();bot.emit(bot.result({kind:'place',actor:'A',point:40}));
 assert.equal(win.session.state.match.state.outcome.winner,'A');assert.equal(win.clock.timers.size,0);
 const close=workerFixture(),worker=close.start();worker.ready();close.driver.close();close.driver.close();
 assert.equal(worker.terminated,1);assert.equal(close.session.state.closed,true);assert.equal(close.clock.timers.size,0);error(close.driver.resume(),'CLOSED');
});

test('external Session close is noticed by the active-job monitor',()=>{
 const f=workerFixture(),w=f.start();w.ready();f.session.close();f.clock.tick(50);
 assert.equal(w.terminated,1);assert.equal(f.driver.state.status,'closed');assert.equal(f.clock.timers.size,0);
});

test('pause or close from an observer cannot start or leak a worker',()=>{
 for(const action of ['pause','close']){
  const f=workerFixture();f.clock.observer=state=>{if(state.status==='starting')action==='pause'?f.driver.pause():f.driver.close();};
  f.start();assert.equal(f.clock.workers.length,0);assert.equal(f.clock.timers.size,0);
 }
});

test('a worker created by a reentrant factory after cancellation is still terminated',()=>{
 const f=workerFixture();f.clock.factory=()=>{value(f.driver.pause());return new FakeWorker();};f.start();
 assert.equal(f.clock.workers.length,1);assert.equal(f.clock.workers[0].terminated,1);assert.equal(f.clock.timers.size,0);
});

test('an observer exception does not change game authority or prevent a valid reply',()=>{
 const f=workerFixture();f.clock.observer=()=>{throw Error('render failure');};const w=f.start();w.ready();w.emit(w.result(pass));
 assert.equal(f.session.state.match.state.ply,1);assert.equal(w.terminated,1);
});

test('termination failure blocks replacement workers instead of accumulating running jobs',()=>{
 const f=workerFixture(),w=f.start();w.ready();w.terminate=()=>{throw Error('bad port');};
 error(f.driver.pause(),'AI_WORKER_FAILED');assert.equal(f.driver.state.status,'failed');error(f.driver.retry(),'AI_WORKER_FAILED');assert.equal(f.clock.workers.length,1);
 f.driver.close();
});

test('a regressing host clock fails safely without committing the reply',()=>{
 const f=workerFixture();f.clock.time=10;const w=f.start();w.ready();const before=f.session.state.match;
 f.clock.time=9;w.emit(w.result(pass));assert.equal(f.session.state.match,before);assert.equal(w.terminated,1);assert.equal(f.driver.state.status,'failed');
});
