import test from 'node:test';
import assert from 'node:assert/strict';
import {AI_PROFILES,runSearch,beginAITurn,validateSearchReply} from '../dist/ai/src/index.js';
import {activePlayer,applyAction,DEFAULT_RULES} from '../dist/core/src/index.js';
import {createGameSession,makeWebSave,parseWebSave,practiceView,levelName,undoPracticePair} from '../dist/ui/model.mjs';
import {createRecoveringAI} from '../dist/ui/ai-recovery.mjs';
import {value,create,sequence,p,fingerprint} from './helpers.mjs';
import {VirtualHost} from './worker-fakes.mjs';
import {searchRequest,frozenClock} from './ai-search-helpers.mjs';
import {closedFourThreat,remoteCapture} from './tactical-fixtures.mjs';

test('hard is a separate profile with more time, nodes and depth than standard',()=>{
 assert.equal(levelName('hard'),'困难');
 for(const field of ['timeMs','maxNodes','maxDepth'])assert.ok(AI_PROFILES.hard[field]>AI_PROFILES.standard[field]);
 assert.deepEqual(AI_PROFILES.hard,{timeMs:120000,maxNodes:4000000,maxDepth:16});
});

test('hard sessions preserve A/B, difficulty, seed and full record through export and restoration',()=>{
 for(const humanActor of ['A','B']){
  const session=value(createGameSession({matchId:'hard-save',mode:'practice',humanActor,level:'hard',seed:941}));
  const aiActor=humanActor==='A'?'B':'A';
  assert.equal(session.state.controllers[aiActor].level,'hard');
  if(humanActor==='A')for(const point of [0,20,80])value(session.submit('A',{kind:'place',actor:'A',point}));
  const players={names:['人类','弈合 AI'],aIndex:humanActor==='A'?0:1,round:1};
  const save=makeWebSave(session,players,'snapshot'),restored=value(parseWebSave(JSON.stringify(save),'restored'));
  assert.deepEqual(practiceView(restored.session),{humanActor,aiActor,level:'hard',seed:941});
  assert.equal(fingerprint(restored.session.state.match),fingerprint(session.state.match));
  const clock=new VirtualHost(),driver=value(createRecoveringAI(restored.session,clock.host));
  value(driver.pause());value(driver.start());clock.tick(10000);assert.equal(clock.workers.length,0);driver.close();
 }
});

test('hard critical search blocks immediate wins and keeps remote captures in both claim modes',()=>{
 const threat=closedFourThreat(),before=fingerprint(threat);
 const request=searchRequest(threat,{maxNodes:2000,maxDepth:8},'hard'),r=value(runSearch(request,frozenClock));
 value(validateSearchReply(request,r.reply));assert.equal(r.reply.action.point,p(threat,'E5'));
 assert.equal(fingerprint(threat),before);
 for(const claimMode of ['fixed-five','color-pressure']){
  const {match,capturePoint}=remoteCapture(claimMode);
  const result=value(runSearch(searchRequest(match,{maxNodes:2000,maxDepth:8},'hard'),frozenClock));
  assert.equal(result.reply.action.point,capturePoint);
 }
});

test('hard threat extensions remain inside every requested node and absolute depth cap',()=>{
 const m=sequence(create({swap3:false,confirmationDelay:0}),['B2','I1','C3','I3','D4','I5']);
 for(const maxDepth of [1,2,3,4,6,8,12,16])for(const maxNodes of [1,2,48,200]){
  const request=searchRequest(m,{maxDepth,maxNodes},'hard'),r=value(runSearch(request,frozenClock));
  value(validateSearchReply(request,r.reply));assert.ok(r.details.maxVisitedDepth<=maxDepth);
  assert.ok(r.reply.stats.completedDepth<=maxDepth);assert.ok(r.reply.stats.nodes<=maxNodes);
  assert.ok(r.details.variation.length<=maxDepth);
  if('action'in r.reply)assert.equal(applyAction(m,r.reply.action).ok,true);
 }
});

test('hard jobs remain cancellable during long thinking and old replies cannot commit',()=>{
 const session=value(createGameSession({matchId:'hard-pause',mode:'practice',humanActor:'B',level:'hard',rules:{...DEFAULT_RULES,swap3:false}}));
 const clock=new VirtualHost(),driver=value(createRecoveringAI(session,clock.host));
 value(driver.start());clock.tick();const worker=clock.workers.at(-1);worker.ready();
 assert.equal(worker.sent[0].budget.timeMs,120000);assert.equal(worker.sent[0].level,'hard');
 const old=worker.onmessage,reply=worker.result({kind:'place',actor:'A',point:40}),before=session.state.match;
 clock.tick(3000);assert.equal(driver.state.status,'thinking');
 value(driver.pause());assert.equal(worker.terminated,1);old({data:reply});clock.tick(30000);
 assert.equal(session.state.match,before);assert.equal(session.state.paused,true);assert.equal(clock.timers.size,0);driver.close();
});

test('hard search is deterministic at fixed resources, including its killer/history ordering',()=>{
 const m=sequence(create({swap3:false}),['D4','D5','E5','E6','F6','A9']);
 const request=searchRequest(m,{maxNodes:3000,maxDepth:8},'hard');
 assert.deepEqual(value(runSearch(request,frozenClock)),value(runSearch(structuredClone(request),frozenClock)));
});
