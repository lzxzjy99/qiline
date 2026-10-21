import test from 'node:test';
import assert from 'node:assert/strict';
import {applyAction,formatPoint} from '../dist/core/src/index.js';
import {runSearch,WIN_VALUE,evaluatePosition} from '../dist/ai/src/index.js';
import {featuresOf} from '../dist/ai/src/features.js';
import {orderActions} from '../dist/ai/src/ordering.js';
import {create,sequence,p,value,fingerprint} from './helpers.mjs';
import {searchRequest,frozenClock} from './ai-search-helpers.mjs';

test('open and broken threes keep both attacking and defensive fork points at every board size',()=>{
 for(const boardSize of [9,13,15,19])for(const directions of ['diagonal','four']){
  const m=sequence(create({swap3:false,boardSize,directions,confirmationDelay:0}),['I1','B2','I3','C3','I5','D4']);
  assert.ok(featuresOf(m).white.forks.includes(p(m,'E5')));
  assert.equal(orderActions(m,37).find(c=>c.action.point===p(m,'E5')).critical,true);
 }
 const broken=sequence(create({swap3:false,confirmationDelay:0}),['B2','I1','D4','I3','E5','I5']);
 assert.ok(featuresOf(broken).black.forks.includes(p(broken,'C3')));
 const result=value(runSearch(searchRequest(broken,{maxNodes:512}),frozenClock));
 assert.equal(formatPoint(result.reply.action.point,9),'C3');
 assert.equal(result.details.score,WIN_VALUE);
 let branch=broken;for(const action of result.details.variation)branch=value(applyAction(branch,action)).match;
 assert.equal(branch.state.outcome.winner,'A');
});

test('overlapping windows sharing the same reply do not invent a double threat',()=>{
 const m=sequence(create({swap3:false,confirmationDelay:0}),['A1','I1','B2','I3','E5','I5','F6','I7']);
 const f=featuresOf(m).black;
 for(const point of ['C3','D4']){
  assert.ok(f.forcing.includes(p(m,point)));
  assert.ok(!f.forks.includes(p(m,point)));
 }
});

test('large-board bounded search reaches an opponent reply and blocks the live three',()=>{
 const m=sequence(create({swap3:false,boardSize:19,confirmationDelay:0}),['S1','G7','S3','H8','S5','I9']);
 const before=fingerprint(m),request=searchRequest(m,{maxNodes:96,maxDepth:4});
 const result=value(runSearch(request,frozenClock));
 assert.ok(result.reply.stats.completedDepth>=2);
 assert.ok(['F6','J10'].includes(formatPoint(result.reply.action.point,19)));
 assert.ok(result.reply.stats.nodes<=96);assert.ok(result.details.maxVisitedDepth<=4);
 assert.equal(fingerprint(m),before);
});

test('a tight budget can finish a root layer on an empty 19-board without sacrificing depth bounds',()=>{
 const m=create({swap3:false,boardSize:19}),r=value(runSearch(searchRequest(m,{maxNodes:48,maxDepth:1}),frozenClock));
 assert.equal(r.reply.stats.completedDepth,1);
 assert.equal(r.reply.action.point,p(m,'J10'));
 assert.ok(r.details.rootCandidates<=25);assert.ok(r.reply.stats.nodes<=48);
 assert.equal(r.details.maxVisitedDepth,1);
});

test('the search opening stays compact without assigning colors before B chooses',()=>{
 const m=create(),r=value(runSearch(searchRequest(m,{maxNodes:512,maxDepth:2}),frozenClock));
 assert.equal(r.reply.action.point,p(m,'E5'));
 const next=value(applyAction(m,r.reply.action)).match;
 assert.equal(next.state.owners,null);assert.deepEqual(next.state.phase,{kind:'opening',placed:1});
});

test('stronger heuristics stay bounded and zero-sum across real capture and threat branches',()=>{
 for(const directions of ['diagonal','four'])for(const confirmationDelay of [0,4]){
  let m=sequence(create({swap3:false,directions,confirmationDelay}),['E5','D5','I1','F5','I3','E4']);
  for(let i=0;i<6&&!m.state.outcome;i++){
   const a=evaluatePosition(m,'A'),b=evaluatePosition(m,'B');
   assert.equal(a,-b);assert.ok(Math.abs(a)<WIN_VALUE);assert.ok(Number.isFinite(a));
   const request=searchRequest(m,{maxNodes:256,maxDepth:3}),first=value(runSearch(request,frozenClock));
   assert.deepEqual(value(runSearch(request,frozenClock)),first);
   m=value(applyAction(m,first.reply.action)).match;
  }
 }
});
