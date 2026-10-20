import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {activePlayer,applyAction,inspectGroup} from '../dist/core/src/index.js';
import {beginAITurn,runSearch,validateSearchReply,evaluatePosition,WIN_VALUE,AI_PROFILES,SEARCH_POLICIES} from '../dist/ai/src/index.js';
import {orderActions} from '../dist/ai/src/ordering.js';
import {create,act,p,sequence,value,error,fingerprint,handoff} from './helpers.mjs';
import {fromMatch} from './ai-helpers.mjs';
import {searchRequest,frozenClock} from './ai-search-helpers.mjs';
import {immediateWin,closedFourThreat,openFourThreat,remoteCapture} from './tactical-fixtures.mjs';
const outcome=(m,budget={},level='standard',host=frozenClock)=>value(runSearch(searchRequest(m,budget,level),host));

test('an actual immediate win is returned with a legal command and bounded depth/nodes',()=>{
 for(const boardSize of [9,13,15,19])for(const directions of ['diagonal','four']){
  const m=immediateWin({boardSize,directions}),before=fingerprint(m),req=searchRequest(m),result=value(runSearch(req,frozenClock));
  assert.equal(result.reply.action.point,p(m,'E5'));assert.equal(result.details.stop,'terminal-win');
  assert.equal(result.reply.stats.nodes,2);assert.equal(result.reply.stats.completedDepth,1);
  assert.equal(result.details.maxVisitedDepth,1);value(validateSearchReply(req,result.reply));
  assert.equal(fingerprint(m),before);
 }
});

test('both difficulty policies block a direct winning reply',()=>{
 for(const level of ['easy','standard']){
  const m=closedFourThreat(),result=outcome(m,{maxDepth:AI_PROFILES[level].maxDepth},level);
  assert.equal(result.reply.action.point,p(m,'E5'));assert.equal(result.reply.stats.completedDepth,AI_PROFILES[level].maxDepth);
  assert.ok(result.details.cutoffs>0);
 }
});

test('standard looks deeply enough to confirm a three-command fork that easy has not reached',()=>{
 const m=sequence(create({swap3:false,confirmationDelay:0}),['B2','I1','C3','I3','D4','I5']);
 const easy=outcome(m,{maxDepth:2},'easy'),standard=outcome(m,{maxDepth:4},'standard');
 assert.equal(standard.reply.action.point,p(m,'E5'));assert.equal(standard.details.score,WIN_VALUE);
 assert.ok(easy.details.score<WIN_VALUE);assert.equal(easy.reply.stats.completedDepth,2);
 let branch=m;for(const action of standard.details.variation)branch=value(applyAction(branch,action)).match;
 assert.equal(branch.state.outcome.winner,'A');assert.equal(standard.details.variation.length,3);
 assert.ok(SEARCH_POLICIES.standard.quietWidth>SEARCH_POLICIES.easy.quietWidth);
});

test('far captures of the entire pending line remain in both levels and both claim modes',()=>{
 for(const mode of ['fixed-five','color-pressure'])for(const level of ['easy','standard']){
  const {match:m,capturePoint}=remoteCapture(mode),result=outcome(m,{maxDepth:AI_PROFILES[level].maxDepth},level);
  assert.equal(result.reply.action.point,capturePoint);assert.equal(result.reply.action.actor,'B');
  const next=value(applyAction(m,result.reply.action)).match;
  assert.equal(next.state.captures.white-m.state.captures.white,12);assert.equal(next.state.claims.filter(c=>c.color==='black').length,0);
 }
});

test('critical ordering contains global capture, atari rescue, four completion/block points and pass despite any quiet width',()=>{
 const {match:m,capturePoint}=remoteCapture();assert.equal(orderActions(m,1).find(a=>a.action.point===capturePoint).critical,true);
 const rescue=sequence(create({swap3:false}),['E5','D5','I1','F5','I3','E4']);
 assert.equal(orderActions(rescue,1).find(a=>a.action.point===p(rescue,'E6')).critical,true);
 const four=closedFourThreat();assert.equal(orderActions(four,1).find(a=>a.action.point===p(four,'E5')).critical,true);
 assert.ok(orderActions(four,1).some(a=>a.action.kind==='pass'&&a.critical));
});

test('a one-node budget yields no invented action; its failure pauses the Session',()=>{
 const s=fromMatch(create({swap3:false})),turn=value(beginAITurn(s,{budget:{timeMs:10000,maxNodes:1,maxDepth:4}})),before=s.state.match;
 const result=value(runSearch(turn.request,frozenClock));assert.equal(result.reply.status,'failed');assert.equal(result.reply.reason,'no-action');
 assert.equal(result.reply.stats.nodes,1);assert.equal(result.reply.stats.completedDepth,0);
 error(turn.accept(result.reply),'AI_NO_RESULT');assert.equal(s.state.match,before);assert.equal(s.state.paused,true);
});

test('a two-node budget retains the first verified legal candidate and never exceeds its allowance',()=>{
 const m=create({swap3:false}),result=outcome(m,{maxNodes:2});
 assert.equal(result.reply.status,'timeout');assert.equal(result.reply.stats.nodes,2);assert.equal(result.reply.stats.completedDepth,0);
 assert.equal(applyAction(m,result.reply.action).ok,true);assert.equal(result.details.maxVisitedDepth,1);
});

test('all tested small node budgets are hard limits, including incomplete first iterations',()=>{
 const m=closedFourThreat();for(const maxNodes of [1,2,3,7,30,75,100,300]){
  const result=outcome(m,{maxNodes,maxDepth:4});assert.ok(result.reply.stats.nodes<=maxNodes);
  assert.ok(result.reply.stats.completedDepth<=4);assert.ok(result.details.maxVisitedDepth<=4);
  if('action'in result.reply)assert.equal(applyAction(m,result.reply.action).ok,true);
 }
});

test('an interrupted deeper iteration returns the last fully completed iteration and its principal variation',()=>{
 const m=closedFourThreat(),one=outcome(m,{maxDepth:1}),budget=one.reply.stats.nodes+1;
 const interrupted=outcome(m,{maxDepth:4,maxNodes:budget});
 assert.equal(interrupted.reply.status,'timeout');assert.equal(interrupted.reply.stats.completedDepth,1);
 assert.deepEqual(interrupted.reply.action,one.reply.action);assert.deepEqual(interrupted.details.variation,one.details.variation);
 assert.equal(interrupted.details.score,one.details.score);assert.equal(interrupted.reply.stats.nodes,budget);
});

test('all configured depth caps count explicit commands, never automatic passes as additional search depth',()=>{
 const m=closedFourThreat();for(const maxDepth of [1,2,3,4]){
  const result=outcome(m,{maxDepth});assert.equal(result.reply.stats.completedDepth,maxDepth);
  assert.ok(result.details.maxVisitedDepth<=maxDepth);assert.ok(result.details.variation.length<=maxDepth);
 }
});

test('replay consumes the time budget and stops before any trustworthy action can be produced',()=>{
 const m=closedFourThreat(),req=searchRequest(m,{timeMs:5});let now=-1;
 const result=value(runSearch(req,{now:()=>++now}));
 assert.equal(result.reply.status,'failed');assert.equal(result.reply.reason,'no-action');assert.equal(result.details.stop,'time');
 assert.equal(result.reply.stats.nodes,0);assert.ok(!('action'in result.reply));value(validateSearchReply(req,result.reply));
});

test('a deadline after the first root returns its verified candidate instead of inventing a pass',()=>{
 const m=create({swap3:false}),req=searchRequest(m,{timeMs:8});let now=-1;
 const result=value(runSearch(req,{now:()=>++now}));
 assert.equal(result.reply.status,'timeout');assert.equal(result.details.stop,'time');
 assert.equal(result.reply.action.kind,'place');assert.equal(applyAction(m,result.reply.action).ok,true);
 assert.equal(result.reply.stats.completedDepth,0);value(validateSearchReply(req,result.reply));
});

test('cancellation during replay emits no action and never restores or modifies a live task',()=>{
 const m=closedFourThreat(),req=searchRequest(m);let checks=0;
 const result=value(runSearch(req,{now:()=>0,isCancelled:()=>++checks>=4}));
 assert.equal(result.reply.status,'cancelled');assert.equal(result.reply.stats.nodes,0);assert.ok(!('action'in result.reply));
});

test('cancellation after candidates exist still emits no move',()=>{
 const req=searchRequest(create({swap3:false}));let checks=0;
 const result=value(runSearch(req,{now:()=>0,isCancelled:()=>++checks>=20}));
 assert.equal(result.reply.status,'cancelled');assert.ok(result.reply.stats.nodes>1);assert.ok(!('action'in result.reply));
});

test('a cancellation already observed remains latched even if the deadline is reached while reporting',()=>{
 const req=searchRequest(create({swap3:false}));let checks=0,cancelled=false;
 const result=value(runSearch(req,{now:()=>cancelled?10000:0,isCancelled:()=>{
  if(++checks===20){cancelled=true;return true;}return false;
 }}));
 assert.equal(result.reply.status,'cancelled');assert.ok(result.reply.stats.nodes>1);assert.ok(!('action'in result.reply));
});

test('bad clocks and host faults cannot produce a move',()=>{
 const req=searchRequest(create({swap3:false}));
 error(runSearch(req,{now:()=>NaN}),'AI_WORKER_FAILED');error(runSearch(req,{now:()=>-1}),'AI_WORKER_FAILED');
 for(const bad of [null,{extra:1},{now:1},{isCancelled:1}])error(runSearch(req,bad),'INVALID_AI_REQUEST');
 let calls=0;const backwards=value(runSearch(req,{now:()=>calls++===0?10:9}));
 assert.equal(backwards.reply.status,'failed');assert.equal(backwards.reply.reason,'internal');assert.ok(!('action'in backwards.reply));
 const failure=value(runSearch(req,{now:()=>0,isCancelled:()=>{throw Error('host fault');}}));
 assert.equal(failure.reply.status,'failed');assert.equal(failure.reply.reason,'internal');
});

test('full positional-superko history excludes illegal recaptures, and rejected attempts consume allowance',()=>{
 const ko=JSON.parse(fs.readFileSync(new URL('../fixtures/legacy-scenarios.json',import.meta.url))).cases.find(c=>c.id==='K01');
 for(const superko of ['positional','off']){
  let m=sequence(create({swap3:false,superko}),ko.prefix.map(a=>a.point));m=act(m,'place','C2');
  const before=fingerprint(m),short=outcome(m,{maxNodes:2});
  if(superko==='positional'){assert.equal(short.reply.status,'failed');assert.equal(short.reply.reason,'no-action');}
  else {assert.equal(short.reply.action.point,p(m,'C3'));assert.equal(short.reply.status,'timeout');}
  const result=outcome(m,{maxDepth:2,maxNodes:1000});assert.equal(applyAction(m,result.reply.action).ok,true);
  if(superko==='positional')assert.notEqual(result.reply.action.point,p(m,'C3'));
  assert.equal(fingerprint(m),before);
 }
});

test('each fixed-five clock and the color-pressure inherited clock survive every search branch',()=>{
 for(const claimMode of ['fixed-five','color-pressure']){
  const m=sequence(create({swap3:false,claimMode}),handoff),before=fingerprint(m),req=searchRequest(m);
  const result=value(runSearch(req,frozenClock));assert.equal(fingerprint(m),before);
  let branch=m;for(const action of result.details.variation){
   branch=value(applyAction(branch,action)).match;
   for(const claim of branch.state.claims)assert.equal(claim.dueAt-claim.formedAt,4);
  }
  value(validateSearchReply(req,result.reply));
 }
});

test('actual color choice binds B correctly and white choice permits B to move again',()=>{
 const m=sequence(create(),['A1','E5','I9']),result=outcome(m,{maxDepth:2});
 assert.deepEqual(result.reply.action,{kind:'choose-color',actor:'B',color:'white'});
 const next=value(applyAction(m,result.reply.action)).match;assert.equal(activePlayer(next),'B');
 assert.equal(result.details.variation[1].actor,'B');
});

test('A may maximize across three consecutive opening commands without changing ownership or advancing the live board',()=>{
 const m=create(),before=fingerprint(m),result=outcome(m,{maxDepth:3,maxNodes:10000});
 assert.equal(result.reply.stats.completedDepth,3);assert.equal(fingerprint(m),before);
 let branch=m;for(const action of result.details.variation){assert.equal(action.actor,'A');branch=value(applyAction(branch,action)).match;}
 assert.equal(branch.state.phase.kind,'choose');assert.equal(branch.state.ply,3);
});

test('terminal values dominate heuristics and remain zero-sum for actual player identity',()=>{
 const m=closedFourThreat();assert.equal(evaluatePosition(m,'A'),-evaluatePosition(m,'B'));
 assert.ok(Math.abs(evaluatePosition(m,'A'))<WIN_VALUE);
 const finished=value(applyAction(m,{kind:'resign',actor:'B'})).match;
 assert.equal(evaluatePosition(finished,'A'),WIN_VALUE);assert.equal(evaluatePosition(finished,'B'),-WIN_VALUE);
 let draw=create({swap3:false});draw=act(draw,'pass');draw=act(draw,'pass');assert.equal(evaluatePosition(draw,'A'),0);
});

test('pass wins an already due claim and draws when every placement loses immediately',()=>{
 let m=sequence(create({swap3:false}),['A1','I1','B2','I3','C3','I5','D4','I7','E5']);for(let i=0;i<3;i++)m=act(m,'pass');
 const win=outcome(m);assert.deepEqual(win.reply.action,{kind:'pass',actor:'A'});
 let threat=openFourThreat();threat=act(threat,'place','I9');threat=act(threat,'pass');
 const draw=outcome(threat,{maxDepth:2});assert.deepEqual(draw.reply.action,{kind:'pass',actor:'A'});
 assert.equal(value(applyAction(threat,draw.reply.action)).match.state.outcome.kind,'draw');
});

test('automatic passes stay inside one explicit search command and one live commit',()=>{
 let m=create({swap3:false});
 for(let q=0;q<81;q++){
  if((q%9+2*Math.floor(q/9))%5===0||m.state.board[q]!==0)continue;
  m=act(m,'place',q);if(m.state.phase.toMove==='white')m=act(m,'pass');
 }
 const s=fromMatch(m),turn=value(beginAITurn(s,{budget:{timeMs:10000,maxNodes:1000,maxDepth:2}}));
 const result=value(runSearch(turn.request,frozenClock));const before=s.state.match;
 value(turn.accept(result.reply));assert.equal(s.state.match.accepted.length,before.accepted.length+1);
 assert.ok(result.details.maxVisitedDepth<=2);assert.ok(s.state.match.state.ply>before.state.ply);
});

test('real search replies commit at most once and become stale after pause/new game',()=>{
 for(const change of ['none','pause','new']){
  const s=fromMatch(closedFourThreat()),turn=value(beginAITurn(s)),result=value(runSearch(turn.request,frozenClock));
  if(change==='pause')value(s.setPaused(true));if(change==='new')value(s.newGame('new'));
  const before=s.state;
  if(change==='none'){value(turn.accept(result.reply));const after=s.state;error(turn.accept(result.reply),'STALE_AI_TASK');assert.equal(s.state,after);}
  else{error(turn.accept(result.reply),'STALE_AI_TASK');assert.equal(s.state,before);}
 }
});

test('corrupt records, unknown versions and wrong actors are rejected before producing any action',()=>{
 const good=searchRequest(closedFourThreat());
 for(const mutate of [r=>r.protocolVersion=2,r=>r.context.actor='B',r=>r.record.actions.at(-1).point=r.record.actions[0].point,
  r=>r.record.extra=1,r=>r.record.rulesVersion='old',r=>r.record.actions.push({kind:'pass',actor:'A',extra:1})]){
  const bad=structuredClone(good);mutate(bad);assert.equal(runSearch(bad,frozenClock).ok,false);
 }
 const terminal=act(create({swap3:false}),'resign',undefined,'A');
 error(runSearch({...good,record:{...good.record,actions:terminal.accepted,rules:terminal.rules}},frozenClock),'FINISHED');
});

test('same request, seed and deterministic resource clock reproduce the selected move and statistics',()=>{
 const req=searchRequest(closedFourThreat(),{maxNodes:350,maxDepth:4});
 const a=value(runSearch(req,frozenClock)),b=value(runSearch(structuredClone(req),frozenClock));
 assert.deepEqual(a,b);assert.throws(()=>a.reply.action.point=0,TypeError);assert.throws(()=>a.details.variation.pop(),TypeError);
});

test('the actual monotonic clock can stop search before any entire large-board layer completes',()=>{
 const req=searchRequest(create({swap3:false,boardSize:19}),{timeMs:1,maxDepth:4});
 const result=value(runSearch(req));assert.equal(result.details.stop,'time');assert.equal(result.reply.stats.completedDepth,0);
 assert.ok(result.reply.stats.nodes<=req.budget.maxNodes);value(validateSearchReply(req,result.reply));
});

test('real-clock searches obey each default level profile on small and large boards',()=>{
 for(const boardSize of [9,19])for(const level of ['easy','standard']){
  const m=create({swap3:false,boardSize}),req=searchRequest(m,AI_PROFILES[level],level),result=value(runSearch(req));
  value(validateSearchReply(req,result.reply));assert.ok(result.reply.stats.nodes<=req.budget.maxNodes);
  assert.ok(result.reply.stats.completedDepth<=req.budget.maxDepth);assert.ok(result.details.maxVisitedDepth<=req.budget.maxDepth);
  if('action'in result.reply)assert.equal(applyAction(m,result.reply.action).ok,true);
  else{assert.equal(result.reply.reason,'no-action');assert.equal(result.details.stop,'time');}
 }
});
