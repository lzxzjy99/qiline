import test from 'node:test';
import assert from 'node:assert/strict';
import {applyAction} from '../dist/core/src/index.js';
import {runSearch,AI_PROFILES,WIN_VALUE,validateSearchReply,evaluatePosition} from '../dist/ai/src/index.js';
import {featuresOf,liveLinesOf,claimTacticalPoints} from '../dist/ai/src/features.js';
import {orderActions} from '../dist/ai/src/ordering.js';
import {create,sequence,act,p,value,fingerprint} from './helpers.mjs';
import {searchRequest,frozenClock} from './ai-search-helpers.mjs';

const levels=['easy','standard','hard'];
const swapColors=m=>{
 let next=act(create(m.rules),'pass');
 for(const action of m.accepted)next=act(next,action.kind,action.point);
 return next;
};
const race=claimMode=>sequence(create({swap3:false,boardSize:19,claimMode}),[
 'A1','C2','B2','D3','C3','E4','D4','F5','K1','C1','L2','S3','M3','S5','N4','S7','E5','B1',
]);
const search=(m,level,budget={})=>{
 const request=searchRequest(m,{...AI_PROFILES[level],maxNodes:2000,...budget},level);
 const result=value(runSearch(request,frozenClock));value(validateSearchReply(request,result.reply));
 assert.ok(result.reply.stats.nodes<=request.budget.maxNodes);
 assert.ok(result.details.maxVisitedDepth<=request.budget.maxDepth);
 return result;
};

test('fixed-five protects the earlier pending five before making a later five, even at the shallow fallback',()=>{
 for(const swapped of [false,true]){
 const m=swapped?swapColors(race('fixed-five')):race('fixed-five'),before=fingerprint(m);
 const color=swapped?'white':'black',actor=swapped?'B':'A',enemy=swapped?'A':'B',formedAt=swapped?18:17;
 for(const level of levels)for(const maxDepth of [1,2,AI_PROFILES[level].maxDepth]){
  const r=search(m,level,{maxDepth});assert.equal(r.reply.action.point,p(m,'A2'));
  const saved=value(applyAction(m,r.reply.action)).match;
  assert.ok(saved.state.claims.some(c=>c.color===color&&c.formedAt===formedAt));
  const due=act(act(saved,'pass'),'pass');assert.equal(due.state.outcome.winner,actor);
 }
 // Ignoring the old line permits the capture; the later white clock wins the race.
 const ignored=act(act(act(act(m,'place','O5'),'place','A2'),'pass'),'pass');
 assert.equal(ignored.state.outcome.winner,enemy);assert.equal(fingerprint(m),before);
 }
});

test('color-pressure may preserve the earlier clock with a safe replacement five',()=>{
 const m=race('color-pressure');
 for(const level of levels){
  const r=search(m,level,{maxDepth:2});assert.equal(r.reply.action.point,p(m,'O5'));
  let next=value(applyAction(m,r.reply.action)).match;
  next=act(next,'place','A2');assert.equal(next.state.board[p(next,'A1')],0);
  assert.equal(next.state.claims.find(c=>c.color==='black').formedAt,17);
  next=act(next,'pass');assert.equal(next.state.outcome.winner,'A');
 }
});

test('even a proven losing reply keeps pressure on the surviving five instead of playing elsewhere',()=>{
 for(const claimMode of ['fixed-five','color-pressure'])for(const swapped of [false,true])for(const level of levels){
  const base=sequence(create({swap3:false,claimMode}),['A1','I1','B2','I3','C3','I5','D4','I7','E5']);
  const m=swapped?swapColors(base):base;
  const r=search(m,level,{maxNodes:2000,maxDepth:level==='easy'?2:8});
  assert.ok(['A2','B1'].some(point=>r.reply.action.point===p(m,point)));
  const next=value(applyAction(m,r.reply.action)).match;
  assert.equal(featuresOf(next).groups.at[p(next,'A1')].liberties.size,1);
  if(r.details.score===-WIN_VALUE){
   // A forcing search can prove the loss; the attack is useful resistance, not a fabricated escape.
   let branch=m;for(const action of r.details.variation)branch=value(applyAction(branch,action)).match;
   assert.equal(branch.state.outcome.winner,swapped?'B':'A');
  }
 }
});

test('only captures of real five groups get claim-breaking priority in either claim mode',()=>{
 for(const claimMode of ['fixed-five','color-pressure']){
  const m=sequence(create({swap3:false,claimMode}),['I9','I8','A1','B1','B2','F2','C3','G3','D4','H4','E5']);
  const ordered=orderActions(m,1),capture=point=>ordered.find(a=>a.action.point===p(m,point));
  assert.ok(capture('A2').order>capture('H9').order+1000000);
  for(const level of levels){
   const r=search(m,level,{maxDepth:2});assert.equal(r.reply.action.point,p(m,'A2'));
   const next=value(applyAction(m,r.reply.action)).match;
   assert.equal(next.state.claims.filter(c=>c.color==='black').length,0);
  }
 }
});

test('all remote liberties of a vulnerable completed five survive quiet pruning',()=>{
 // Three liberties are beyond the old two-liberty ordering rule.
 let m=create({swap3:false,confirmationDelay:12});
 const black=['A1','B1','B2','C2','C3','D3','D4','E4','E6','E7','E8'],final='E5';
 const liberties=new Set(['F6','F7','F8'].map(s=>p(m,s)));
 const target=new Set([...black,final].map(s=>p(m,s))),boundary=new Set();
 for(const q of [...target,...liberties]){
  const x=q%9,y=Math.floor(q/9);
  for(const [a,b]of [[x-1,y],[x+1,y],[x,y-1],[x,y+1]])if(a>=0&&a<9&&b>=0&&b<9){
   const point=b*9+a;if(!target.has(point)&&!liberties.has(point))boundary.add(point);
  }
 }
 for(let i=0;i<black.length;i++){m=act(m,'place',black[i]);if(i<black.length-1)m=act(m,'pass');}
 let placed=0;for(const point of boundary){if(placed++)m=act(m,'pass');m=act(m,'place',point);}
 m=act(m,'place',final);
 assert.equal(liveLinesOf(m).length,1);
 const group=featuresOf(m).groups.at[0];assert.equal(group.liberties.size,3);
 const orders=orderActions(m,1);
 for(const point of group.liberties){assert.equal(orders.find(a=>a.action.point===point).critical,true);assert.ok(claimTacticalPoints(m).has(point));}
 // The core, not the hint, verifies a full legal capture sequence.
 for(const point of group.liberties){m=act(m,'place',point);if(m.state.board[0])m=act(m,'pass');}
 assert.equal(m.state.claims.length,0);assert.equal(m.state.board[0],0);
});

test('claim evaluation remains finite, zero-sum and respects who can answer an atari next',()=>{
 for(const claimMode of ['fixed-five','color-pressure']){
  const waiting=sequence(create({swap3:false,claimMode}),['A1','B1','B2','I3','C3','I5','D4','I7','E5']);
  const ownTurn=act(waiting,'pass');
  assert.ok(evaluatePosition(ownTurn,'A')>evaluatePosition(waiting,'A'));
  for(const m of [waiting,ownTurn,race(claimMode)]){
   assert.equal(evaluatePosition(m,'A'),-evaluatePosition(m,'B'));
   assert.ok(Math.abs(evaluatePosition(m,'A'))<WIN_VALUE);assert.ok(Number.isFinite(evaluatePosition(m,'A')));
  }
 }
});

test('extra claim candidates and hard extensions still honour interruption, node and absolute depth limits',()=>{
 const m=race('fixed-five'),before=fingerprint(m);
 for(const level of levels)for(const maxNodes of [1,2,30,100])for(const maxDepth of [1,2,6]){
  const r=search(m,level,{maxNodes,maxDepth});
  if('action'in r.reply)assert.equal(applyAction(m,r.reply.action).ok,true);
 }
 let checks=0;
 const r=value(runSearch(searchRequest(m,{maxDepth:12},'hard'),{now:()=>0,isCancelled:()=>++checks>=100}));
 assert.equal(r.reply.status,'cancelled');assert.ok(!('action'in r.reply));assert.equal(fingerprint(m),before);
});
