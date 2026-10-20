import test from 'node:test';
import assert from 'node:assert/strict';
import {createSession} from '../dist/session/src/index.js';
import {createRecoveringAI} from '../dist/ui/ai-recovery.mjs';
import {practice,place} from './ai-helpers.mjs';
import {value,error} from './helpers.mjs';
import {VirtualHost,FakeWorker} from './worker-fakes.mjs';

const limits={startupMs:100,graceMs:10};
function fixture(session=practice('A',{},'easy')) {
 const clock=new VirtualHost(),driver=value(createRecoveringAI(session,clock.host,limits));
 const start=()=>{value(driver.start());clock.tick();return clock.workers.at(-1);};
 return {session,clock,driver,start};
}
function failWorker(f,kind='error') {
 const worker=f.clock.workers.at(-1);worker.ready();
 if(kind==='invalid')worker.emit({...worker.result({kind:'pass',actor:'A'}),extra:true});
 else worker.onerror({});
 return worker;
}
function resultFailure(worker,status,reason) {
 const {action,...reply}=worker.result(null,{status,...(reason?{reason}:{})});
 return reply;
}

test('recovery wrapper retains raw validation and never creates a PvP Worker',()=>{
 const f=fixture(value(createSession({matchId:'pvp'})));f.start();
 assert.equal(f.clock.workers.length,0);assert.equal(f.clock.timers.size,0);f.driver.close();
 const clock=new VirtualHost();error(createRecoveringAI(null,clock.host,limits),'INVALID_AI_REQUEST');
 error(createRecoveringAI(practice(),{...clock.host,extra:true},limits),'INVALID_AI_REQUEST');
});

test('recoverable failure waits 250/750 ms then exposes final failure after three fresh Workers',()=>{
 const f=fixture(),first=f.start(),before=f.session.state.match,ids=[];
 first.ready();ids.push(first.sent[0].context.requestId);first.onerror({});
 assert.equal(first.terminated,1);assert.equal(f.driver.state.status,'retrying');
 assert.equal(f.session.state.match,before);assert.equal(f.session.state.paused,true);
 assert.equal(f.clock.states.some(s=>s.status==='failed'),false);
 f.clock.tick(249);assert.equal(f.clock.workers.length,1);f.clock.tick(1);
 const second=f.clock.workers.at(-1);second.ready();ids.push(second.sent[0].context.requestId);second.onerror({});
 assert.equal(f.driver.state.status,'retrying');f.clock.tick(749);assert.equal(f.clock.workers.length,2);f.clock.tick(1);
 const third=f.clock.workers.at(-1);third.ready();ids.push(third.sent[0].context.requestId);third.onerror({});
 assert.equal(f.driver.state.status,'failed');assert.equal(f.driver.state.error.code,'AI_WORKER_FAILED');
 assert.equal(f.clock.states.filter(s=>s.status==='failed').length,1);
 assert.equal(new Set(ids).size,3);assert.equal(f.clock.workers.every(w=>w.terminated===1),true);
 assert.equal(f.clock.timers.size,0);f.clock.tick(10000);assert.equal(f.clock.workers.length,3);
 assert.equal(f.session.state.match,before);f.driver.close();
});

test('hard search timeout and malformed replies are eligible for bounded recovery without a game action',()=>{
 for(const kind of ['timeout','invalid','no-result']){
  const f=fixture(),w=f.start(),before=f.session.state.match;w.ready();
  if(kind==='timeout')f.clock.tick(w.sent[0].budget.timeMs+limits.graceMs);
  else if(kind==='no-result')w.emit(resultFailure(w,'failed','no-action'));
  else w.emit({...w.result({kind:'pass',actor:'A'}),extra:true});
  assert.equal(f.driver.state.status,'retrying');assert.equal(f.session.state.match,before);
  assert.equal(w.terminated,1);f.clock.tick(250);assert.equal(f.clock.workers.length,2);f.driver.close();
 }
});

test('repeated start and sync preserve one scheduled recovery and the visible retrying state',()=>{
 const f=fixture();f.start();failWorker(f);
 for(let i=0;i<3;i++){
  assert.equal(value(f.driver.start()).status,'retrying');assert.equal(value(f.driver.sync()).status,'retrying');
  assert.equal(f.driver.state.status,'retrying');assert.equal(f.clock.timers.size,1);
 }
 f.clock.tick(250);assert.equal(f.clock.workers.length,2);failWorker(f);f.clock.tick(750);
 assert.equal(f.clock.workers.length,3);failWorker(f);assert.equal(f.driver.state.status,'failed');f.driver.close();
});

test('startup failure retries on the same position and can recover with a fresh successful Worker',()=>{
 const f=fixture(),before=f.session.state.match;let attempts=0;
 f.clock.factory=()=>{if(++attempts===1)throw Error('temporary constructor error');return new FakeWorker();};
 f.start();assert.equal(f.driver.state.status,'retrying');assert.equal(f.session.state.match,before);
 f.clock.tick(250);const w=f.clock.workers.at(-1);w.ready();w.emit(w.result({kind:'pass',actor:'A'}));
 assert.equal(attempts,2);assert.equal(f.session.state.match.state.ply,1);assert.equal(f.driver.state.status,'idle');
 assert.equal(f.clock.timers.size,0);f.driver.close();
});

test('cancelled replies and legal-protocol illegal moves never enter automatic recovery',()=>{
 for(const kind of ['cancelled','occupied']){
  const session=practice('A',{swap3:true},'easy');if(kind==='occupied')place(session,'E5');
  const f=fixture(session),w=f.start(),before=f.session.state.match;w.ready();
  w.emit(kind==='cancelled'?resultFailure(w,'cancelled'):w.result({kind:'place',actor:'A',point:40}));
  assert.equal(f.driver.state.status,'failed');assert.equal(f.session.state.match,before);assert.equal(w.terminated,1);
  f.clock.tick(10000);assert.equal(f.clock.workers.length,1);assert.equal(f.clock.timers.size,0);f.driver.close();
 }
});

test('manual retry resets the recovery budget only when explicitly requested',()=>{
 const f=fixture();f.start();failWorker(f);f.clock.tick(250);failWorker(f);f.clock.tick(750);failWorker(f);
 assert.equal(f.driver.state.status,'failed');value(f.driver.retry());f.clock.tick();assert.equal(f.clock.workers.length,4);
 failWorker(f);assert.equal(f.driver.state.status,'retrying');f.clock.tick(250);assert.equal(f.clock.workers.length,5);
 failWorker(f);f.clock.tick(750);assert.equal(f.clock.workers.length,6);failWorker(f);
 assert.equal(f.driver.state.status,'failed');assert.equal(f.clock.timers.size,0);f.driver.close();
});

test('successful position change restores both retries for the next consecutive AI command',()=>{
 const f=fixture(practice('A',{swap3:true},'easy'));f.start();failWorker(f);f.clock.tick(250);failWorker(f);f.clock.tick(750);
 const success=f.clock.workers.at(-1);success.ready();success.emit(success.result({kind:'place',actor:'A',point:40}));
 f.clock.tick();assert.equal(f.clock.workers.length,4);assert.equal(f.session.state.match.state.ply,1);
 failWorker(f);assert.equal(f.driver.state.status,'retrying');f.clock.tick(249);assert.equal(f.clock.workers.length,4);
 f.clock.tick(1);assert.equal(f.clock.workers.length,5);failWorker(f);f.clock.tick(750);
 assert.equal(f.clock.workers.length,6);failWorker(f);assert.equal(f.driver.state.status,'failed');f.driver.close();
});

test('pause and close during retry delay cancel timers and cannot be revived by old retry callbacks',()=>{
 for(const action of ['pause','close']){
  const f=fixture();f.start();failWorker(f);assert.equal(f.driver.state.status,'retrying');
  const callbacks=[...f.clock.timers.values()].map(t=>t.callback);
  if(action==='pause')value(f.driver.pause());else f.driver.close();
  assert.equal(f.clock.timers.size,0);for(const callback of callbacks)callback();f.clock.tick(10000);
  assert.equal(f.clock.workers.length,1);assert.equal(f.session.state.paused,true);
  if(action==='close')assert.equal(f.driver.state.status,'closed');else f.driver.close();
 }
});

test('explicit resume from waiting is immediate and starts a new bounded recovery budget',()=>{
 const f=fixture();f.start();failWorker(f);value(f.driver.pause());value(f.driver.resume());f.clock.tick();
 assert.equal(f.clock.workers.length,2);failWorker(f);assert.equal(f.driver.state.status,'retrying');
 f.clock.tick(249);assert.equal(f.clock.workers.length,2);f.clock.tick(1);assert.equal(f.clock.workers.length,3);
 failWorker(f);f.clock.tick(750);assert.equal(f.clock.workers.length,4);failWorker(f);
 assert.equal(f.driver.state.status,'failed');assert.equal(f.clock.timers.size,0);f.driver.close();
});

test('failed commands preserve pending recovery while successful commands cancel it',()=>{
 for(const command of ['failed','resign']){
  const f=fixture();f.start();failWorker(f);const callbacks=[...f.clock.timers.values()].map(t=>t.callback);
  const result=f.driver.change(()=>command==='failed'?f.session.requestUndo('B'):f.session.submit('B',{kind:'resign',actor:'B'}));
  assert.equal(result.ok,command!=='failed');
  if(command==='failed'){
   assert.equal(f.clock.timers.size,1);assert.equal(f.driver.state.status,'retrying');
   f.clock.tick(249);assert.equal(f.clock.workers.length,1);f.clock.tick(1);assert.equal(f.clock.workers.length,2);
  }else{
   assert.equal(f.clock.timers.size,0);for(const callback of callbacks)callback();f.clock.tick(10000);
   assert.equal(f.clock.workers.length,1);assert.equal(f.session.state.match.state.outcome.winner,'A');
  }f.driver.close();
 }
});

test('new match or loaded save discards the old retry even when a retained timeout callback fires',()=>{
 for(const command of ['new','load']){
  const f=fixture();f.start();failWorker(f);const old=[...f.clock.timers.values()].map(t=>t.callback),save=f.session.exportSave();
  value(f.driver.change(()=>command==='new'?f.session.newGame('new'):f.session.loadSave('loaded',save)));
  f.clock.tick();const current=f.clock.workers.at(-1);assert.equal(f.clock.workers.length,2);
  for(const callback of old)callback();f.clock.tick(10);
  assert.equal(f.clock.workers.length,2);assert.equal(current.terminated,0);f.driver.close();
 }
});

test('direct external position change, close or terminal command prevents a delayed retry',()=>{
 for(const action of ['new','close','resign']){
  const f=fixture();f.start();failWorker(f);
  if(action==='new')value(f.session.newGame('external'));
  else if(action==='close')f.session.close();
  else value(f.session.submit('B',{kind:'resign',actor:'B'}));
  f.clock.tick(10000);assert.equal(f.clock.workers.length,1);assert.equal(f.clock.timers.size,0);f.driver.close();
 }
});

test('pause or close reentered by a retrying observer cannot leave a retry timer or resurrect work',()=>{
 for(const action of ['pause','close']){
  const f=fixture();f.clock.observer=state=>{if(state.status==='retrying')action==='pause'?f.driver.pause():f.driver.close();};
  f.start();failWorker(f);f.clock.tick(10000);assert.equal(f.clock.workers.length,1);
  assert.equal(f.clock.timers.size,0);assert.equal(f.session.state.paused,true);f.driver.close();
 }
});

test('manual retry reentered by retrying observer uses one fresh task and cancels the delayed attempt',()=>{
 const f=fixture();let once=false;
 f.clock.observer=state=>{if(state.status==='retrying'&&!once){once=true;value(f.driver.retry());}};
 f.start();failWorker(f);f.clock.tick();assert.equal(f.clock.workers.length,2);
 const w=f.clock.workers.at(-1);w.ready();w.emit(w.result({kind:'pass',actor:'A'}));f.clock.tick(10000);
 assert.equal(f.clock.workers.length,2);assert.equal(f.session.state.match.state.ply,1);assert.equal(f.clock.timers.size,0);f.driver.close();
});

test('observer presentation failure does not block recovery or legal submission',()=>{
 const f=fixture();f.clock.observer=()=>{throw Error('render failed');};f.start();failWorker(f);f.clock.tick(250);
 const w=f.clock.workers.at(-1);w.ready();w.emit(w.result({kind:'pass',actor:'A'}));
 assert.equal(f.session.state.match.state.ply,1);assert.equal(f.clock.timers.size,0);f.driver.close();
});

test('a Worker termination failure cannot accumulate replacement Workers through automatic recovery',()=>{
 const f=fixture(),w=f.start();w.ready();w.terminate=()=>{throw Error('cannot terminate');};w.onerror({});
 f.clock.tick(10000);assert.equal(f.clock.workers.length,1);assert.equal(f.driver.state.status,'failed');
 assert.equal(f.clock.timers.size,0);f.driver.close();
});

test('invalid retry policies are rejected before any task, timer or Worker is created',()=>{
 const clock=new VirtualHost(),session=practice();
 for(const policy of [null,{},false,{retryDelays:null},{retryDelays:'250,750'},{retryDelays:[1,2,3]},
  {retryDelays:[-1]},{retryDelays:[5001]},{retryDelays:[1.5]},{retryDelays:[NaN]},
  {retryDelays:[Infinity]},{retryDelays:[undefined]},{retryDelays:Array(2)}]){
  error(createRecoveringAI(session,clock.host,limits,policy),'INVALID_AI_REQUEST');
 }
 assert.equal(clock.workers.length,0);assert.equal(clock.timers.size,0);assert.equal(session.state.task,null);
});

test('a failed recovery timer allocation exposes final failure and never loops on sync',()=>{
 const f=fixture();f.start();const oldSet=f.clock.host.setTimer;
 f.clock.host.setTimer=(callback,delay)=>{if(delay===250)throw Error('timer unavailable');return oldSet(callback,delay);};
 failWorker(f);assert.equal(f.driver.state.status,'failed');assert.equal(f.clock.timers.size,0);
 for(let i=0;i<3;i++){value(f.driver.sync());f.clock.tick(10000);}
 assert.equal(f.clock.workers.length,1);assert.equal(f.session.state.match.state.ply,0);f.driver.close();
});

test('a successful no-op command cancels waiting recovery without consuming another attempt',()=>{
 const f=fixture();f.start();failWorker(f);
 value(f.driver.change(()=>f.session.setPaused(true)));
 assert.equal(f.clock.timers.size,0);assert.equal(f.driver.state.status,'failed');
 f.clock.tick(10000);assert.equal(f.clock.workers.length,1);f.driver.close();
});
