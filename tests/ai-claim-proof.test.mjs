import test from 'node:test';
import assert from 'node:assert/strict';
import {applyAction,activePlayer,getLegalPlacements} from '../dist/core/src/index.js';
import {securedClaim} from '../dist/ai/src/claim-proof.js';
import {evaluateHardPosition,SECURED_LINE_VALUE,WIN_VALUE} from '../dist/ai/src/evaluation.js';
import {runSearch,validateSearchReply} from '../dist/ai/src/index.js';
import {create,sequence,act,value,fingerprint,p} from './helpers.mjs';
import {searchRequest,frozenClock} from './ai-search-helpers.mjs';

function staircase(patch={},swapped=false){
 let m=create({swap3:false,confirmationDelay:4,...patch});if(swapped)m=act(m,'pass');
 for(const point of ['B2','C2','C3','D3','D4','E4','E5','F5'])m=act(act(m,'place',point),'pass');
 return act(m,'place','F6');
}

test('secured line certificates cover both colors and every supported board, delayed clock and claim mode',()=>{
 for(const boardSize of [9,13,15,19])for(const confirmationDelay of [2,4,6,8,10,12])
 for(const directions of ['diagonal','four'])for(const claimMode of ['fixed-five','color-pressure'])for(const swapped of [false,true]){
  const m=staircase({boardSize,confirmationDelay,directions,claimMode},swapped),before=fingerprint(m),proof=securedClaim(m);
  assert.ok(proof);assert.equal(proof.color,swapped?'white':'black');assert.equal(proof.opponentPlacements,confirmationDelay/2);
  assert.equal(fingerprint(m),before);assert.throws(()=>proof.color='corrupt',TypeError);
  assert.equal(evaluateHardPosition(m,'A'),-evaluateHardPosition(m,'B'));
  assert.equal(Math.abs(evaluateHardPosition(m,'A')),SECURED_LINE_VALUE);assert.ok(SECURED_LINE_VALUE<WIN_VALUE);
 }
});

test('all legal enemy responses to representative certificates are replayed to actual core wins',()=>{
 let leaves=0;
 function prove(m,cert){
  if(m.state.outcome){assert.equal(m.state.outcome.kind,'win');assert.equal(m.state.outcome.color,cert.color);leaves++;return;}
  assert.ok(m.state.ply<cert.dueAt);
  const actor=activePlayer(m),actions=[{kind:'pass',actor}];
  if(m.state.phase.toMove!==cert.color)for(const point of getLegalPlacements(m))actions.push({kind:'place',actor,point});
  for(const action of actions)prove(value(applyAction(m,action)).match,cert);
 }
 for(const confirmationDelay of [2,4])for(const claimMode of ['fixed-five','color-pressure'])for(const swapped of [false,true]){
  const m=staircase({confirmationDelay,claimMode},swapped),before=fingerprint(m);prove(m,securedClaim(m));assert.equal(fingerprint(m),before);
 }
 assert.ok(leaves>10000);
});

test('equal liberty and attack counts never certify a vulnerable corner, but a spent enemy turn can secure it',()=>{
 const m=sequence(create({swap3:false,confirmationDelay:4}),['A1','I1','B2','I3','C3','I5','D4','I7','E5']);
 assert.equal(securedClaim(m),null);
 const attacked=act(act(act(m,'place','A2'),'pass'),'place','B1');assert.equal(attacked.state.claims.length,0);
 assert.ok(securedClaim(act(m,'pass'))); // Only one enemy placement remains after this wasted turn.
 assert.equal(securedClaim(create()),null);
});

test('an older enemy clock blocks a later safe-line certificate in both claim modes',()=>{
 for(const claimMode of ['fixed-five','color-pressure']){
  const m=sequence(create({swap3:false,confirmationDelay:12,claimMode,boardSize:19}),
   ['B2','K2','C3','L3','D4','M4','E5','N5','F6','O6']);
  assert.equal(m.state.claims.length,2);assert.equal(securedClaim(m),null);
 }
});

test('hard prevents a next-turn secured enemy five and passes only under its own surviving proof',()=>{
 for(const claimMode of ['fixed-five','color-pressure']){
  const m=sequence(create({swap3:false,confirmationDelay:4,claimMode}),['A1','B2','I1','C3','I3','D4','I5','E5']);
  const req=searchRequest(m,{maxDepth:2,maxNodes:3000},'hard'),r=value(runSearch(req,frozenClock));
  value(validateSearchReply(req,r.reply));assert.equal(r.reply.action.point,p(m,'F6'));
  let secure=act(staircase({claimMode}),'pass');const before=fingerprint(secure);
  const passReq=searchRequest(secure,{maxNodes:3000,maxDepth:8},'hard'),pass=value(runSearch(passReq,frozenClock));
  assert.deepEqual(pass.reply.action,{kind:'pass',actor:'A'});assert.equal(pass.details.stop,'secured-line');
  const next=value(applyAction(secure,pass.reply.action)).match;assert.equal(next.state.outcome,null);
  assert.equal(fingerprint(secure),before);assert.equal(pass.details.score,SECURED_LINE_VALUE);
 }
});

test('secured shortcuts obey cancellation and tiny budgets without committing or fabricating outcomes',()=>{
 const m=act(staircase(),'pass'),before=fingerprint(m);
 for(const maxNodes of [1,2,3]){
  const req=searchRequest(m,{maxNodes,maxDepth:1},'hard'),r=value(runSearch(req,frozenClock));value(validateSearchReply(req,r.reply));
  assert.ok(r.reply.stats.nodes<=maxNodes);assert.ok(r.details.maxVisitedDepth<=1);
  if('action'in r.reply)assert.equal(applyAction(m,r.reply.action).ok,true);
 }
 const r=value(runSearch(searchRequest(m,{},'hard'),{now:()=>0,isCancelled:()=>true}));
 assert.equal(r.reply.status,'cancelled');assert.ok(!('action'in r.reply));assert.equal(fingerprint(m),before);
});
