import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {activePlayer,applyAction,getLegalPlacements,inspectGroup} from '../dist/core/src/index.js';
import {analyzeTactics,listAIActions,pickBasicAction,recommendBasicAction,beginAITurn,prepareSearch} from '../dist/ai/src/index.js';
import {value,error,create,act,p,sequence,fingerprint,handoff} from './helpers.mjs';
import {fromMatch,reply} from './ai-helpers.mjs';
import {remoteCapture,immediateWin,closedFourThreat,openFourThreat} from './tactical-fixtures.mjs';
const candidateAt=(analysis,m,point)=>analysis.candidates.find(c=>c.action.kind==='place'&&c.action.point===p(m,point));

test('all legal roots survive enumeration, including distant placements and pass; consent and resign are excluded',()=>{
 const m=act(create({swap3:false,boardSize:19}),'place','J10'),before=fingerprint(m);
 const analysis=value(analyzeTactics(m)),actions=value(listAIActions(m));
 assert.deepEqual(actions.filter(a=>a.kind==='place').map(a=>a.point),getLegalPlacements(m));
 assert.equal(analysis.candidates.length,actions.length);assert.ok(candidateAt(analysis,m,'S19'));
 assert.ok(actions.some(a=>a.kind==='pass'));assert.ok(actions.every(a=>a.kind==='place'||a.kind==='pass'));
 for(const c of analysis.candidates)assert.equal(applyAction(m,c.action).ok,true);
 assert.equal(fingerprint(m),before);
});

test('one-move wins outrank all nonterminal scores for every board size and allowed direction mode',()=>{
 for(const boardSize of [9,13,15,19])for(const directions of ['diagonal','four']){
  const m=immediateWin({boardSize,directions}),result=value(recommendBasicAction(m,17));
  assert.equal(result.action.point,p(m,'E5'));assert.equal(result.analysis.candidates[0].tier,5);
  assert.equal(value(applyAction(m,result.action)).match.state.outcome.winner,'A');
 }
});

test('an opponent corner four is blocked; every witnessed losing reply is verified by the core',()=>{
 const m=closedFourThreat(),result=value(recommendBasicAction(m));
 assert.equal(result.action.point,p(m,'E5'));assert.equal(result.analysis.candidates[0].critical,true);
 assert.ok(result.analysis.candidates[0].reasons.includes('avoid-loss'));
 for(const c of result.analysis.candidates)if(c.signals.opponentWinningReply){
  const end=value(applyAction(c.next,c.signals.opponentWinningReply)).match;
  assert.equal(end.state.outcome.winner,'B');assert.equal(c.tier,1);
 }
});

test('two open ends are not mislabeled as a complete defense when blocking only one end',()=>{
 const m=openFourThreat(),analysis=value(analyzeTactics(m));
 assert.ok(analysis.candidates.every(c=>c.tier===1));
 for(const coord of ['A1','F6'])assert.ok(candidateAt(analysis,m,coord).signals.opponentWinningReply);
});

test('a delayed opponent line is prevented before formation when no earlier friendly claim can win first',()=>{
 for(const confirmationDelay of [2,4,6,8,10,12]){
  const m=closedFourThreat({confirmationDelay}),result=value(recommendBasicAction(m));
  assert.equal(result.action.point,p(m,'E5'));
  assert.equal(result.analysis.candidates[0].signals.opponentLineReplies,0);
  assert.ok(result.analysis.candidates.some(c=>c.signals.opponentLineReplies>0));
 }
});

test('a pending earlier friendly claim can be pursued instead of treating every later opposing five as a forced win',()=>{
 const m=sequence(create({swap3:false,confirmationDelay:4}),['A1','E9','B2','F8','C3','G7','D4','H6','E5','A9']);
 const analysis=value(analyzeTactics(m)),quiet=candidateAt(analysis,m,'I1');
 const enemyLine=value(applyAction(quiet.next,{kind:'place',actor:'B',point:p(m,'I5')})).match;
 assert.ok(enemyLine.state.claims.some(c=>c.color==='white'));
 assert.ok(enemyLine.state.claims.find(c=>c.color==='black').dueAt<enemyLine.state.claims.find(c=>c.color==='white').dueAt);
 assert.equal(quiet.signals.opponentLineReplies,0);
});

test('a remote last liberty captures the whole connected five and is retained in both confirmation modes',()=>{
 for(const mode of ['fixed-five','color-pressure']){
  const {match:m,capturePoint,line}=remoteCapture(mode),result=value(recommendBasicAction(m));
  assert.equal(result.action.point,capturePoint);assert.equal(result.action.actor,'B');
  assert.ok(line.every(q=>Math.max(Math.abs(q%9-capturePoint%9),Math.abs(Math.floor(q/9)-Math.floor(capturePoint/9)))>=3));
  const best=result.analysis.candidates[0];assert.equal(best.signals.captured,12);
  assert.equal(best.signals.brokenOpponentClaims,1);assert.equal(best.critical,true);assert.equal(best.tier,3);
  assert.equal(best.next.state.claims.filter(c=>c.color==='black').length,0);
  assert.ok(result.analysis.candidates.filter(c=>c!==best).every(c=>c.tier===1));
 }
});

test('atari rescue can use a direct extension and avoids leaving the original stone with one liberty',()=>{
 const m=sequence(create({swap3:false}),['E5','D5','I1','F5','I3','E4']);
 assert.equal(value(inspectGroup(m,p(m,'E5'))).liberties.length,1);
 const result=value(recommendBasicAction(m));assert.equal(result.action.point,p(m,'E6'));
 assert.equal(result.analysis.candidates[0].signals.rescued,1);assert.equal(result.analysis.candidates[0].critical,true);
 assert.ok(value(inspectGroup(result.analysis.candidates[0].next,p(m,'E5'))).liberties.length>=2);
});

test('rescue by capturing elsewhere is recognized rather than requiring placement on the endangered group liberty',()=>{
 const m=sequence(create({swap3:false}),['B1','A1','I1','B2','I3','H8']);
 const endangered=value(inspectGroup(m,p(m,'B1')));assert.deepEqual(endangered.liberties,[p(m,'C1')]);
 const result=value(recommendBasicAction(m));assert.equal(result.action.point,p(m,'A2'));
 assert.equal(result.analysis.candidates[0].signals.captured,1);assert.equal(result.analysis.candidates[0].signals.rescued,1);
});

test('new self-atari groups are signaled and a quiet self-atari is avoided when safe alternatives exist',()=>{
 const m=sequence(create({swap3:false}),['I1','D5','I3','F5','I5','E4']);
 const analysis=value(analyzeTactics(m)),atari=candidateAt(analysis,m,'E5');
 assert.equal(atari.signals.selfAtari,1);assert.ok(atari.reasons.includes('self-atari'));
 assert.notEqual(value(pickBasicAction(analysis)).point,p(m,'E5'));
});

test('positional-superko recapture is excluded while off permits it, preserving the live history',()=>{
 const old=JSON.parse(fs.readFileSync(new URL('../fixtures/legacy-scenarios.json',import.meta.url))).cases.find(c=>c.id==='K01');
 for(const superko of ['positional','off']){
  let m=sequence(create({swap3:false,superko}),old.prefix.map(a=>a.point));m=act(m,'place','C2');
  const before=fingerprint(m),analysis=value(analyzeTactics(m));
  assert.equal(!!candidateAt(analysis,m,'C3'),superko==='off');
  assert.equal(applyAction(m,value(pickBasicAction(analysis))).ok,true);assert.equal(fingerprint(m),before);
 }
});

test('opening candidates reject a capture and never include pass or fabricated color choice',()=>{
 let m=create();m=act(m,'place','A2');m=act(m,'place','A1');
 const result=value(recommendBasicAction(m));assert.ok(result.analysis.candidates.every(c=>c.action.kind==='place'));
 assert.equal(candidateAt(result.analysis,m,'B1'),undefined);
 assert.equal(applyAction(m,result.action).ok,true);assert.equal(m.state.ply,2);
});

test('opening chooses the center, then a compact two-step separation, with A retaining three actions',()=>{
 for(const boardSize of [9,13,15,19]){
  let m=create({boardSize});const mid=(boardSize-1)/2;
  let result=value(recommendBasicAction(m,5));assert.equal(result.action.point,mid*boardSize+mid);m=act(m,'place',result.action.point);
  result=value(recommendBasicAction(m,5));const q=result.action.point;
  assert.equal(Math.max(Math.abs(q%boardSize-mid),Math.abs(Math.floor(q/boardSize)-mid)),2);m=act(m,'place',q);
  assert.equal(activePlayer(m),'A');result=value(recommendBasicAction(m,5));m=act(m,'place',result.action.point);
  assert.equal(m.state.phase.kind,'choose');assert.equal(activePlayer(m),'B');assert.equal(m.state.ply,3);
 }
});

test('B chooses the statically stronger color; choosing white leaves B to play again',()=>{
 for(const [coords,color] of [[['A1','E5','I9'],'white'],[['E5','A1','F6'],'black']]){
  const m=sequence(create(),coords),result=value(recommendBasicAction(m));
  assert.deepEqual(result.action,{kind:'choose-color',actor:'B',color});
  const next=value(applyAction(m,result.action)).match;
  assert.equal(next.state.owners[color],'B');assert.equal(next.state.ply,3);
  assert.equal(activePlayer(next),color==='white'?'B':'A');
 }
});

test('horizontal geometry is used only with four-direction rules, never as a separate win adjudicator',()=>{
 for(const directions of ['diagonal','four']){
  const m=sequence(create({swap3:false,confirmationDelay:0,directions}),['A1','I2','B1','I4','C1','I6','D1','I8']);
  const candidate=candidateAt(value(analyzeTactics(m)),m,'E1');
  assert.equal(candidate.tier===5,directions==='four');assert.equal(!!candidate.next.state.outcome,directions==='four');
 }
});

test('filling a gap to form an overline is recognized through the core in immediate mode',()=>{
 const m=sequence(create({swap3:false,confirmationDelay:0}),['I1','A1','H2','A3','G3','A5','E5','A7','D6','A9']);
 const result=value(recommendBasicAction(m));assert.equal(result.action.point,p(m,'F4'));
 assert.equal(value(applyAction(m,result.action)).match.state.outcome.winner,'A');
});

test('separate fixed-five clocks and color-pressure inheritance remain intact in recommended branches',()=>{
 for(const claimMode of ['fixed-five','color-pressure']){
  const m=sequence(create({swap3:false,claimMode}),handoff),before=fingerprint(m);
  const analysis=value(analyzeTactics(m));assert.equal(fingerprint(m),before);
  for(const c of analysis.candidates){
   assert.equal(fingerprint(c.next),fingerprint(value(applyAction(m,c.action)).match));
   for(const claim of c.next.state.claims)assert.equal(claim.dueAt-claim.formedAt,4);
  }
 }
});

test('pass is selected when it immediately confirms an existing winning line',()=>{
 for(const claimMode of ['fixed-five','color-pressure']){
  let m=sequence(create({swap3:false,claimMode}),['A1','I1','B2','I3','C3','I5','D4','I7','E5']);
  for(let i=0;i<3;i++)m=act(m,'pass');
  const result=value(recommendBasicAction(m));assert.deepEqual(result.action,{kind:'pass',actor:'A'});
  assert.equal(result.analysis.candidates[0].next.state.outcome.winner,'A');
 }
});

test('pass takes a legal draw when every placement permits an immediate opposing win',()=>{
 let m=openFourThreat();m=act(m,'place','I9');m=act(m,'pass');
 const result=value(recommendBasicAction(m));assert.deepEqual(result.action,{kind:'pass',actor:'A'});
 assert.equal(value(applyAction(m,result.action)).match.state.outcome.kind,'draw');
 assert.ok(result.analysis.candidates.filter(c=>c.action.kind==='place').every(c=>c.tier===1));
});

test('terminal wins outrank a larger nonterminal geometric score',()=>{
 const m=immediateWin(),analysis=value(analyzeTactics(m));
 const winning=analysis.candidates.filter(c=>c.tier===5),others=analysis.candidates.filter(c=>c.tier!==5);
 assert.ok(winning.length>0&&others.length>0);assert.equal(value(pickBasicAction(analysis)).point,p(m,'E5'));
 assert.ok(analysis.candidates[0].tier>analysis.candidates.at(-1).tier);
 assert.ok(others.some(c=>c.score>analysis.candidates[0].score));
});

test('analysis and recommendations are immutable and repeatable for the same seed without consuming a live command',()=>{
 const m=act(create(),'place','E5'),before=fingerprint(m),analysis=value(analyzeTactics(m));
 const tied=analysis.candidates.filter(c=>c.tier===analysis.candidates[0].tier&&c.score===analysis.candidates[0].score);
 assert.ok(tied.length>1);
 for(const seed of [0,1,37,0xffffffff])assert.deepEqual(value(pickBasicAction(analysis,seed)),value(pickBasicAction(analysis,seed)));
 const choices=new Set(Array.from({length:32},(_,seed)=>JSON.stringify(value(pickBasicAction(analysis,seed)))));
 assert.ok(choices.size>1);assert.ok(choices.size<=tied.length);
 assert.throws(()=>analysis.candidates.pop(),TypeError);assert.throws(()=>analysis.candidates[0].signals.captured=99,TypeError);
 assert.equal(fingerprint(m),before);
 for(const seed of [-1,0.5,NaN,Infinity,0x100000000,'1'])error(recommendBasicAction(m,seed),'INVALID_AI_REQUEST');
});

test('invalid or finished matches cannot silently generate a move',()=>{
 for(const bad of [null,{},JSON.parse(JSON.stringify(create()))]){
  error(listAIActions(bad),'INVALID_MATCH');error(analyzeTactics(bad),'INVALID_MATCH');
 }
 const finished=act(create({swap3:false}),'resign',undefined,'A');
 error(recommendBasicAction(finished),'FINISHED');
});

test('a reconstructed worker match can produce a real tactical decision and commit once through the P5.1 adapter',()=>{
 const m=closedFourThreat(),s=fromMatch(m),turn=value(beginAITurn(s)),before=s.state.match;
 const prepared=value(prepareSearch(structuredClone(turn.request))),decision=value(recommendBasicAction(prepared.match,prepared.request.seed));
 assert.equal(s.state.match,before);assert.equal(decision.action.point,p(m,'E5'));
 value(turn.accept(reply(turn,decision.action)));assert.equal(s.state.match.state.ply,m.state.ply+1);
 error(turn.accept(reply(turn,decision.action)),'STALE_AI_TASK');
});

test('breaking the older fixed-five window saves a turn, while color-pressure inherits the older clock',()=>{
 for(const claimMode of ['fixed-five','color-pressure']){
  let m=sequence(create({swap3:false,confirmationDelay:12,claimMode}),['A1','B1','B2','E6','C3','G6','D4','F5','E5','I9','F6']);
  for(let i=0;i<8;i++)m=act(m,'pass');
  const analysis=value(analyzeTactics(m)),old=candidateAt(analysis,m,'A2'),newer=candidateAt(analysis,m,'F7');
  assert.equal(old.signals.captured,1);assert.equal(newer.signals.captured,1);
  if(claimMode==='fixed-five'){
   assert.equal(value(pickBasicAction(analysis)).point,p(m,'A2'));
   assert.equal(old.tier,3);assert.equal(newer.tier,1);
   assert.equal(old.next.state.claims[0].formedAt,11);
  }else{
   assert.equal(old.tier,1);assert.equal(newer.tier,1);
   assert.equal(old.next.state.claims[0].formedAt,9);
   assert.equal(old.signals.brokenOpponentClaims,0);
  }
 }
});

test('automatic passes produced by a root placement are evaluated as part of that one command',()=>{
 let m=create({swap3:false});
 for(let q=0;q<81;q++){
  if((q%9+2*Math.floor(q/9))%5===0 || m.state.board[q]!==0)continue;
  m=act(m,'place',q);if(m.state.phase.toMove==='white')m=act(m,'pass');
 }
 const before=fingerprint(m),analysis=value(analyzeTactics(m)),root=candidateAt(analysis,m,'E4');
 assert.equal(root.next.state.ply,m.state.ply+2);assert.equal(root.next.accepted.length,m.accepted.length+1);
 assert.equal(activePlayer(root.next),'A');assert.equal(fingerprint(m),before);
 assert.equal(value(pickBasicAction(analysis)).kind,'place');
});

test('headless basic AI games keep commands legal through opening, play, captures and terminal checks',()=>{
 for(const patch of [{swap3:true},{swap3:false,directions:'four',confirmationDelay:0}]){
  let m=create(patch),steps=0;
  while(!m.state.outcome && steps<60){
   const before=m,result=value(recommendBasicAction(m,steps+1));
   assert.equal(result.action.actor,activePlayer(m));
   m=value(applyAction(m,result.action)).match;
   assert.ok(m.state.ply>=before.state.ply);assert.equal(m.accepted.length,before.accepted.length+1);steps++;
  }
  assert.ok(steps>=4);assert.ok(steps<=60);
 }
});
