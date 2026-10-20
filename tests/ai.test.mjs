import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {activePlayer,applyAction,DEFAULT_RULES,exportRecord} from '../dist/core/src/index.js';
import {createSession} from '../dist/session/src/index.js';
import {AI_BUDGET_LIMITS,AI_PROFILES,beginAITurn,prepareSearch,restorePlayableSession,validateSearchBudget,validateSearchReply} from '../dist/ai/src/index.js';
import {parseWebSave} from '../dist/ui/model.mjs';
import {value,error,create,act,sequence,fingerprint,handoff,p} from './helpers.mjs';
import {practice,fromMatch,point,reply,place,command} from './ai-helpers.mjs';
const clone=structuredClone;

test('requests survive structured clone, replay a branded match and own immutable input data',()=>{
 const s=practice(),turn=value(beginAITurn(s)),before=s.state.match;
 const raw=clone(turn.request),prepared=value(prepareSearch(raw));
 raw.seed=99;raw.record.rules.boardSize=19;raw.record.actions.push({kind:'pass',actor:'A'});
 assert.equal(prepared.request.seed,37);assert.equal(prepared.match.rules.boardSize,9);
 assert.equal(prepared.match.accepted.length,0);assert.equal(s.state.match,before);
 assert.equal(value(applyAction(prepared.match,{kind:'place',actor:'A',point:40})).match.state.ply,1);
 assert.throws(()=>turn.request.budget.maxNodes=999,TypeError);
 assert.throws(()=>prepared.request.record.actions.push({kind:'pass',actor:'A'}),TypeError);
});

test('budgets reject non-integers, unbounded work, missing fields and unknown options before a task starts',()=>{
 assert.deepEqual(value(validateSearchBudget(AI_BUDGET_LIMITS)),AI_BUDGET_LIMITS);
 for(const field of ['timeMs','maxNodes','maxDepth'])for(const bad of [0,-1,0.5,NaN,Infinity,true,'1',AI_BUDGET_LIMITS[field]+1]){
  const budget={...AI_PROFILES.easy,[field]:bad};error(validateSearchBudget(budget),'INVALID_AI_BUDGET');
  const s=practice(),before=s.state;error(beginAITurn(s,{budget}),'INVALID_AI_BUDGET');assert.equal(s.state,before);
 }
 for(const bad of [null,{},[],{...AI_PROFILES.easy,extra:1}])error(validateSearchBudget(bad),'INVALID_AI_BUDGET');
 for(const bad of [null,[],{extra:true}]){const s=practice(),before=s.state;error(beginAITurn(s,bad),'INVALID_AI_REQUEST');assert.equal(s.state,before);}
});

test('request schema rejects unsupported versions, malformed identity/seed, board snapshots and corrupt histories',()=>{
 const turn=value(beginAITurn(practice())),valid=clone(turn.request);
 for(const seed of [0,0xffffffff])assert.equal(value(prepareSearch({...valid,seed})).request.seed,seed);
 for(const mutate of [r=>r.protocolVersion=2,r=>r.kind='hint',r=>r.level='hard',r=>r.seed=-1,r=>r.seed=0x100000000,
  r=>r.seed=0.5,r=>r.extra=1,r=>delete r.record,r=>r.context.revision=-1,r=>r.context.taskId='',
  r=>r.context.requestId='x'.repeat(257),r=>r.context.actor='C',r=>r.context.extra=1,
  r=>r.record={board:Array(81).fill(0)},r=>r.record.rules.rulesVersion='2.0.0',
  r=>r.record.actions.push({kind:'place',actor:'B',point:0})]){
  const bad=clone(valid);mutate(bad);assert.equal(prepareSearch(bad).ok,false);
 }
 error(prepareSearch({...valid,context:{...valid.context,actor:'B'}}),'WRONG_ACTOR');
 error(prepareSearch(null),'INVALID_AI_REQUEST');
});

test('full replay preserves PSK history: identical current board is insufficient for legal recapture',()=>{
 const old=JSON.parse(fs.readFileSync(new URL('../fixtures/legacy-scenarios.json',import.meta.url)));
 const ko=old.cases.find(c=>c.id==='K01');
 for(const superko of ['positional','off']){
  let m=sequence(create({swap3:false,superko}),ko.prefix.map(a=>a.point));m=act(m,'place','C2');
  const s=fromMatch(m),turn=value(beginAITurn(s)),worker=value(prepareSearch(clone(turn.request))).match;
  assert.equal(fingerprint(worker),fingerprint(m));assert.equal(worker.positions.length,10);
  const recapture={kind:'place',actor:activePlayer(worker),point:p(worker,'C3')},probe=applyAction(worker,recapture);
  assert.equal(probe.ok,superko==='off');
  if(superko==='positional'){
   error(probe,'REPETITION');const before=s.state.match;
   error(turn.accept(reply(turn,recapture)),'REPETITION');assert.equal(s.state.match,before);assert.equal(s.state.paused,true);
  }else value(turn.accept(reply(turn,recapture)));
 }
});

test('all claim clocks, simultaneous candidates, passes and line inheritance survive worker reconstruction',()=>{
 for(const claimMode of ['fixed-five','color-pressure']){
  let m=sequence(create({swap3:false,claimMode}),handoff);m=act(m,'pass');
  if(m.state.outcome){ // Pressure matures at 21; use the state one command earlier.
   m=sequence(create({swap3:false,claimMode}),handoff);
  }
  const s=fromMatch(m),before=s.state.match,turn=value(beginAITurn(s));
  const worker=value(prepareSearch(clone(turn.request))).match;
  assert.equal(fingerprint(worker),fingerprint(m));assert.ok(worker.state.claims.length>0);
  for(const claim of worker.state.claims)assert.equal(claim.dueAt-claim.formedAt,4);
  assert.equal(s.state.match,before);
 }
 const m=sequence(create({swap3:false,confirmationDelay:12}),['A1','I2','B2','H3','C3','G4','D4','F5','E5','E6','F6']);
 const worker=value(prepareSearch(clone(value(beginAITurn(fromMatch(m))).request))).match;
 assert.equal(worker.state.claims.length,3);assert.equal(fingerprint(worker),fingerprint(m));
});

test('AI keeps player A through three opening placements; simulations and choosing color do not advance the live clock',()=>{
 const s=practice('A',{swap3:true});
 for(const coord of ['I2','I4','I6']){
  const before=s.state.match.state.ply,turn=value(beginAITurn(s));
  const worker=value(prepareSearch(clone(turn.request))).match;
  value(applyAction(worker,{kind:'place',actor:'A',point:point(s,coord)}));assert.equal(s.state.match.state.ply,before);
  value(turn.accept(reply(turn,{kind:'place',actor:'A',point:point(s,coord)})));
 }
 assert.equal(s.state.match.state.phase.kind,'choose');
 value(s.submit('B',{kind:'choose-color',actor:'B',color:'black'}));
 assert.equal(s.state.match.state.ply,3);assert.equal(activePlayer(s.state.match),'A');
 assert.equal(value(beginAITurn(s)).request.context.actor,'A');
});

test('AI player B may choose white and take the immediately following white move as the same player',()=>{
 const s=practice('B',{swap3:true});for(const c of ['I2','I4','I6'])place(s,c);
 command(s,{kind:'choose-color',actor:'B',color:'white'});assert.equal(activePlayer(s.state.match),'B');
 place(s,'E5');assert.equal(s.state.match.state.ply,4);assert.equal(activePlayer(s.state.match),'A');
});

test('an AI opening placement cannot capture, and a rejected suggestion retains both stones and the opening clock',()=>{
 const s=practice('A',{swap3:true});place(s,'A2');place(s,'A1');
 const turn=value(beginAITurn(s)),before=s.state.match;
 error(turn.accept(reply(turn,{kind:'place',actor:'A',point:point(s,'B1')})),'OPENING_CAPTURE');
 assert.equal(s.state.match,before);assert.equal(s.state.match.state.ply,2);assert.equal(s.state.paused,true);
});

test('delayed line maturity is resolved by the shared core, including AI passes and true-player ownership',()=>{
 for(const claimMode of ['fixed-five','color-pressure']){
  const s=fromMatch(sequence(create({swap3:false,claimMode}),handoff),'A');
  while(!s.state.match.state.outcome)command(s,{kind:'pass',actor:activePlayer(s.state.match)});
  assert.equal(s.state.match.state.ply,claimMode==='fixed-five'?23:21);
  assert.equal(s.state.match.state.outcome.winner,'A');assert.equal(s.state.match.state.outcome.reason,'line');
  error(beginAITurn(s),'FINISHED');
 }
});

test('the original Session handle stays private; a serialized context/token cannot authorize a move',()=>{
 const s=practice(),turn=value(beginAITurn(s)),before=s.state;
 error(s.commitAIResult(turn.request.context,{kind:'pass',actor:'A'}),'STALE_TASK');
 error(s.commitAIResult(clone(s.state.task),{kind:'pass',actor:'A'}),'STALE_TASK');assert.equal(s.state,before);
 value(turn.accept(reply(turn,{kind:'pass',actor:'A'})));assert.equal(s.state.match.state.ply,1);
 const after=s.state;error(turn.accept(reply(turn,{kind:'pass',actor:'A'})),'STALE_AI_TASK');assert.equal(s.state,after);
});

test('a timeout may commit its best legal move even if the final atomic operation overshot the time budget',()=>{
 const s=practice(),turn=value(beginAITurn(s));
 value(turn.accept(reply(turn,{kind:'place',actor:'A',point:40},'timeout',{
  elapsedMs:turn.request.budget.timeMs+2,nodes:turn.request.budget.maxNodes,completedDepth:0,
 })));
 assert.equal(s.state.match.state.ply,1);assert.equal(s.state.paused,false);assert.equal(s.state.task,null);
});

test('stale request, match, revision, task or actor identities never disturb a newer live task',()=>{
 for(const field of ['requestId','matchId','revision','taskId','actor']){
  const s=practice(),turn=value(beginAITurn(s)),message=reply(turn,{kind:'pass',actor:'A'}),before=s.state;
  message.context[field]=field==='revision'?0:field==='actor'?'B':'old';
  error(turn.accept(message),'STALE_AI_TASK');assert.equal(s.state,before);assert.equal(turn.isCurrent,true);
 }
});

test('pause/resume and task cancellation invalidate old replies without changing a resumed task',()=>{
 for(const cancel of [s=>s.setPaused(true),s=>s.cancelTask()]){
  const s=practice(),old=value(beginAITurn(s));value(cancel(s));value(s.setPaused(false));
  const current=value(beginAITurn(s)),before=s.state;
  error(old.accept(reply(old,{kind:'pass',actor:'A'})),'STALE_AI_TASK');assert.equal(s.state,before);
  error(current.accept(reply(old,{kind:'pass',actor:'A'})),'STALE_AI_TASK');assert.equal(s.state,before);
  value(current.accept(reply(current,{kind:'place',actor:'A',point:40})));
 }
});

test('undo, new game and successful load invalidate outstanding work while failed loads preserve it',()=>{
 for(const replace of ['undo','new','load']){
  const s=practice('B');place(s,'E5');const old=value(beginAITurn(s)),save=s.exportSave();
  if(replace==='undo')value(s.requestUndo('A'));
  if(replace==='new')value(s.newGame('new'));
  if(replace==='load')value(s.loadSave('loaded',save));
  const before=s.state;error(old.accept(reply(old,{kind:'pass',actor:'B'})),'STALE_AI_TASK');assert.equal(s.state,before);
 }
 const s=practice('B');place(s,'E5');const turn=value(beginAITurn(s)),bad=clone(s.exportSave()),before=s.state;
 bad.record.actions[0].point=81;assert.equal(s.loadSave('bad',bad).ok,false);assert.equal(s.state,before);
 value(turn.accept(reply(turn,{kind:'place',actor:'B',point:0})));
});

test('resignation and closing win their race against an outstanding AI reply',()=>{
 for(const finish of [s=>s.submit('B',{kind:'resign',actor:'B'}),s=>{s.close();return {ok:true,value:s.state};}]){
  const s=practice(),turn=value(beginAITurn(s));value(finish(s));const before=s.state;
  error(turn.accept(reply(turn,{kind:'pass',actor:'A'})),'STALE_AI_TASK');
  error(turn.stop(),'STALE_AI_TASK');assert.equal(s.state,before);
 }
});

test('freshly restored sessions use distinct request IDs even when match ID, revision, and board are identical',()=>{
 const first=practice(),old=value(beginAITurn(first)),save=first.exportSave();
 const second=value(restorePlayableSession('M',save)).session,current=value(beginAITurn(second));
 assert.equal(current.request.context.revision,old.request.context.revision);
 assert.notEqual(current.request.context.requestId,old.request.context.requestId);
 const before=second.state;error(current.accept(reply(old,{kind:'pass',actor:'A'})),'STALE_AI_TASK');assert.equal(second.state,before);
 value(current.accept(reply(current,{kind:'place',actor:'A',point:40})));
});

test('malformed messages and invalid statistics pause the current task without accepting a command',()=>{
 const mutations=[r=>r.protocolVersion=2,r=>r.kind='search',r=>r.extra=1,r=>delete r.context,r=>delete r.action,
  r=>r.status='unknown',r=>r.stats.nodes=-1,r=>r.stats.nodes=1000001,r=>r.stats.completedDepth=13,
  r=>r.stats.elapsedMs=NaN,r=>r.stats.elapsedMs=Infinity,r=>r.stats.nodes=0.5,r=>r.stats.extra=1];
 for(const mutate of mutations){
  const s=practice(),turn=value(beginAITurn(s)),before=s.state.match,message=reply(turn,{kind:'pass',actor:'A'});mutate(message);
  assert.equal(turn.accept(message).ok,false);assert.equal(s.state.match,before);assert.equal(s.state.paused,true);assert.equal(s.state.task,null);
 }
 const s=practice(),turn=value(beginAITurn(s));error(turn.accept(null),'INVALID_AI_REPLY');assert.equal(s.state.paused,true);
});

test('forbidden commands, impersonation and phase errors never become automatic resignations or passes',()=>{
 const actions=[{kind:'resign',actor:'A'},{kind:'cancel-opening',actor:'A',approvedBy:['A','B']},
  {kind:'place',actor:'B',point:0},{kind:'choose-color',actor:'A',color:'white'},
  {kind:'place',actor:'A',point:81},{kind:'place',actor:'A',point:true},{kind:'pass',actor:'A',extra:true}];
 for(const action of actions){
  const s=practice(),turn=value(beginAITurn(s)),before=s.state.match;
  assert.equal(turn.accept(reply(turn,action)).ok,false);assert.equal(s.state.match,before);assert.equal(s.state.paused,true);
 }
 const s=practice('A',{swap3:true}),turn=value(beginAITurn(s)),before=s.state.match;
 error(turn.accept(reply(turn,{kind:'pass',actor:'A'})),'WRONG_PHASE');assert.equal(s.state.match,before);
});

test('occupied points and suicide suggestions are rechecked by the shared core without corrupting the match',()=>{
 for(const [coords,target,code] of [[['E5','D5'],'E5','OCCUPIED'],[['I1','D5','I3','F5','I7','E4','I9','E6'],'E5','SUICIDE']]){
  const m=sequence(create({swap3:false}),coords),s=fromMatch(m),turn=value(beginAITurn(s)),before=s.state.match;
  error(turn.accept(reply(turn,{kind:'place',actor:activePlayer(m),point:p(m,target)})),code);
  assert.equal(s.state.match,before);assert.equal(s.state.paused,true);
 }
});

test('explicit worker cancellation, crashes and no-result timeouts pause; retry requires a new task',()=>{
 for(const [reason,code] of [['cancelled','AI_CANCELLED'],['worker-error','AI_WORKER_FAILED'],['no-result','AI_NO_RESULT']]){
  const s=practice(),turn=value(beginAITurn(s)),before=s.state.match;
  error(turn.stop(reason),code);assert.equal(s.state.match,before);assert.equal(s.state.paused,true);assert.equal(s.state.task,null);
  error(beginAITurn(s),'PAUSED');value(s.setPaused(false));const retry=value(beginAITurn(s));
  assert.notEqual(turn.request.context.requestId,retry.request.context.requestId);
  error(turn.accept(reply(turn,{kind:'pass',actor:'A'})),'STALE_AI_TASK');
  value(retry.accept(reply(retry,{kind:'place',actor:'A',point:40})));
 }
});

test('cancelled/failed reply variants carry no command; timeouts without a best action pause',()=>{
 for(const [status,reason,code] of [['cancelled',null,'AI_CANCELLED'],['failed','internal','AI_WORKER_FAILED'],['failed','no-action','AI_NO_RESULT'],['timeout',null,'INVALID_AI_REPLY']]){
  const s=practice(),turn=value(beginAITurn(s)),before=s.state.match,message=reply(turn,null,status);
  if(reason)message.reason=reason;error(turn.accept(message),code);assert.equal(s.state.match,before);assert.equal(s.state.paused,true);
 }
 const turn=value(beginAITurn(practice()));
 for(const message of [{...reply(turn,null,'failed'),reason:'unknown'},reply(turn,{kind:'pass',actor:'A'},'cancelled')])
  error(validateSearchReply(turn.request,message),'INVALID_AI_REPLY');
});

test('successful replies are copied and frozen; caller mutation cannot change an accepted action',()=>{
 const s=practice(),turn=value(beginAITurn(s)),raw=reply(turn,{kind:'place',actor:'A',point:40});
 const parsed=value(validateSearchReply(turn.request,raw));raw.action.point=0;raw.stats.nodes=999;
 assert.equal(parsed.action.point,40);assert.equal(parsed.stats.nodes,1);assert.throws(()=>parsed.action.point=80,TypeError);
 value(turn.accept({...raw,action:{kind:'place',actor:'A',point:40}}));raw.action.point=80;
 assert.equal(s.state.match.state.board[40],1);assert.equal(s.state.match.state.board[80],0);
});

test('forced automatic passes stay attached to one explicit command, replay identically and undo together',()=>{
 let m=create({swap3:false});
 for(let q=0;q<81;q++){
  if((q%9+2*Math.floor(q/9))%5===0 || m.state.board[q]!==0)continue;
  m=act(m,'place',q);if(m.state.phase.toMove==='white')m=act(m,'pass');
 }
 const s=fromMatch(m),turn=value(beginAITurn(s)),before=s.state.match;
 const expected=value(applyAction(m,{kind:'place',actor:'A',point:p(m,'E4')})).match;
 value(turn.accept(reply(turn,{kind:'place',actor:'A',point:p(m,'E4')})));
 assert.equal(s.state.match.state.ply,before.state.ply+2);assert.equal(fingerprint(s.state.match),fingerprint(expected));
 const restored=value(restorePlayableSession('restored',s.exportSave())).session;
 assert.equal(fingerprint(restored.state.match),fingerprint(expected));
 value(s.requestUndo('B'));assert.equal(fingerprint(s.state.match),fingerprint(before));
});

test('legacy PvP/session/raw record saves and AI role/level/seed settings restore without runtime permissions',()=>{
 const human=value(createSession({matchId:'human',rules:DEFAULT_RULES}));
 for(const raw of [human.exportSave(),JSON.stringify(human.exportSave()),exportRecord(human.state.match)]){
  const restored=value(restorePlayableSession('fresh',raw));assert.equal(restored.mode,'pvp');
  assert.equal(restored.session.state.task,null);assert.equal(restored.session.state.hintsEnabled,false);
 }
 for(const actor of ['A','B'])for(const level of ['easy','standard'])for(const seed of [0,0xffffffff]){
  const s=practice(actor,{},level,seed);if(actor==='B')place(s,'E5');
  const turn=value(beginAITurn(s));value(s.setPaused(true));
  const save=s.exportSave();assert.deepEqual(Object.keys(save).sort(),['competitive','controllers','record','sessionSchemaVersion']);
  const restored=value(restorePlayableSession('fresh',clone(save)));assert.equal(restored.mode,'practice');
  assert.deepEqual(restored.session.state.controllers,s.state.controllers);
  assert.equal(restored.session.state.task,null);assert.equal(restored.session.state.paused,false);
  assert.equal(restored.session.state.consent,null);assert.equal(restored.session.state.hintsEnabled,false);
  const next=value(beginAITurn(restored.session));assert.equal(next.request.level,level);assert.equal(next.request.seed,seed);
  const before=restored.session.state;error(next.accept(reply(turn,{kind:'pass',actor})),'STALE_AI_TASK');assert.equal(restored.session.state,before);
 }
});

test('unsupported modes, extra controller settings, runtime fields and corrupt saves are rejected; PvP web gate stays intact',()=>{
 const good=practice().exportSave();
 for(const mutate of [r=>r.controllers.B={kind:'ai',level:'easy',seed:1},r=>r.competitive=true,
  r=>r.controllers.A.engine='v1',r=>r.controllers.A.seed=-1,r=>r.task={taskId:'forged'},
  r=>r.paused=true,r=>r.sessionSchemaVersion=2,r=>r.record.actions.push({kind:'place',actor:'B',point:0})]){
  const bad=clone(good);mutate(bad);assert.equal(restorePlayableSession('fresh',bad).ok,false);
 }
 for(const raw of ['{',null,{},[]])assert.equal(restorePlayableSession('fresh',raw).ok,false);
 error(parseWebSave(good,'web'),'AI_UNAVAILABLE');
 const pvp=value(createSession({matchId:'pvp'})),before=pvp.state;
 error(beginAITurn(pvp),'AI_MODE_UNSUPPORTED');assert.equal(pvp.state,before);
 const humanTurn=practice('B');error(beginAITurn(humanTurn),'WRONG_ACTOR');
 const both=value(createSession({matchId:'both',controllers:{A:{kind:'ai',level:'easy',seed:1},B:{kind:'ai',level:'easy',seed:2}}}));
 error(beginAITurn(both),'AI_MODE_UNSUPPORTED');
});

test('terminal records can be restored but cannot start search or be reconstructed as a live worker request',()=>{
 const s=practice(),turn=value(beginAITurn(s));value(s.submit('B',{kind:'resign',actor:'B'}));
 const save=s.exportSave(),restored=value(restorePlayableSession('finished',save)).session;
 error(beginAITurn(restored),'FINISHED');error(prepareSearch({...turn.request,record:save.record}),'FINISHED');
});
