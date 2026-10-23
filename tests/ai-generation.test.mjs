import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {alphaBeta} from '../dist/ai/src/tree.js';
import {orderActions,retainActions,actionKey} from '../dist/ai/src/ordering.js';
import {featuresOf,shareFeaturePool,liveLinesOf} from '../dist/ai/src/features.js';
import {runSearch,AI_PROFILES,validateSearchReply} from '../dist/ai/src/index.js';
import {applyAction} from '../dist/core/src/index.js';
import {create,sequence,value,fingerprint} from './helpers.mjs';
import {searchRequest,frozenClock} from './ai-search-helpers.mjs';

test('PVS agrees with exhaustive minimax on mixed A/B turns and fractional scores',()=>{
 let state=9271;const random=()=>state=(Math.imul(state,1664525)+1013904223)>>>0;
 const build=depth=>depth===0?{value:(random()%101-50)/7}:{actor:random()%2?'A':'B',children:[build(depth-1),build(depth-1),...(random()%2?[build(depth-1)]:[])]};
 const oracle=(n,root)=>typeof n.value==='number'?n.value:(n.actor===root?Math.max:Math.min)(...n.children.map(c=>oracle(c,root)));
 const tree={principalVariation:true,check:()=>{},terminal:n=>typeof n.value==='number',player:n=>n.actor,
  evaluate:n=>n.value,children:function*(n){for(const [move,node]of n.children.entries())yield{move,node};},cutoff:()=>{}};
 for(let i=0;i<160;i++){const n=build(4);for(const root of ['A','B'])assert.equal(alphaBeta(n,4,root,tree).value,oracle(n,root));}
});

test('a failed PVS scout is searched again before a better root branch replaces the principal variation',()=>{
 const n={actor:'A',children:[{value:4},{actor:'B',children:[{value:12},{value:7}]}]};let leaves=0;
 const tree={principalVariation:true,check:()=>{},terminal:n=>typeof n.value==='number',player:n=>n.actor,
  evaluate:n=>{leaves++;return n.value;},children:function*(n){for(const [move,node]of n.children.entries())yield{move,node};},cutoff:()=>{}};
 const r=alphaBeta(n,2,'A',tree);assert.equal(r.value,7);assert.equal(r.variation[0],1);assert.ok(leaves>3);
});

test('same-path bound entries preserve exhaustive values across narrow probes and full re-searches',()=>{
 let rng=907;const rand=()=>rng=(Math.imul(rng,1664525)+1013904223)>>>0;
 const build=(d,path='')=>d?{path,actor:rand()%2?'A':'B',children:Array.from({length:2+rand()%3},(_,i)=>build(d-1,path+'/'+i))}:{path,value:(rand()%401-200)/7};
 const oracle=(n,root)=>!n.children?n.value:(n.actor===root?Math.max:Math.min)(...n.children.map(c=>oracle(c,root)));
 for(let i=0;i<200;i++)for(const root of ['A','B']){
  const n=build(4),expected=oracle(n,root),entries=new Map();let hits=0;
  const tree={principalVariation:true,check:()=>{},terminal:n=>!n.children,player:n=>n.actor,evaluate:n=>n.value,cutoff:()=>{},
   children:function*(n){for(const [move,node]of n.children.entries())yield{move,node};},
   lookup:(n,d)=>{const entry=entries.get(`${d}:${n.path}`);if(entry)hits++;return entry;},store:(n,d,e)=>entries.set(`${d}:${n.path}`,e)};
  const window=expected+(rand()%11-5)/7;alphaBeta(n,4,root,tree,window,window+0.000001);
  const result=alphaBeta(n,4,root,tree);assert.equal(result.value,expected);assert.ok(hits>0);
  assert.equal(result.variation.reduce((p,m)=>p.children[m],n).value,expected);
  assert.deepEqual(alphaBeta(n,4,root,tree),result);
  const stop={};tree.check=()=>{throw stop;};assert.throws(()=>alphaBeta(n,4,root,tree),e=>e===stop);
 }
});

test('a preferred quiet move uses its quota slot before learned ordering and cannot change scout/re-search membership',()=>{
 const proposals=orderActions(create({swap3:false}),37),preferred=proposals.find(p=>p.action.point===0).action;
 const selected=retainActions(proposals,preferred,4),quiet=selected.filter(p=>!p.critical);
 assert.equal(quiet.length,4);assert.ok(quiet.some(p=>actionKey(p.action)===actionKey(preferred)));
 const retained=ordered=>{let count=0;return ordered.filter(p=>p.critical||count++<4).map(p=>actionKey(p.action)).sort();};
 assert.deepEqual(retained(selected),retained([...selected].reverse()));
 assert.ok(selected.filter(p=>p.critical).some(p=>p.action.kind==='pass'));
});

test('geometry reuse shares identical boards without sharing claim clocks, histories or search values',()=>{
 let a=sequence(create({swap3:false}),['B2','I1','C3','I3','D4','I5','E5','I7','F6']);
 const b=value(applyAction(a,{kind:'pass',actor:'B'})).match,pool=new Map();
 shareFeaturePool(a,pool);shareFeaturePool(b,pool);
 assert.equal(featuresOf(a),featuresOf(b));assert.notEqual(a.state.ply,b.state.ply);
 assert.equal(liveLinesOf(a)[0].dueAt-a.state.ply,4);assert.equal(liveLinesOf(b)[0].dueAt-b.state.ply,3);
 const four=sequence(create({swap3:false,directions:'four'}),['B2','I1','C3','I3','D4','I5','E5','I7','F6']);
 shareFeaturePool(four,pool);assert.notEqual(featuresOf(a),featuresOf(four));
 assert.equal(pool.size,2);assert.equal(a.state.outcome,null);assert.equal(b.state.outcome,null);
});

test('hard examines every legal third opening placement before narrowing its completed search',()=>{
 const m=sequence(create(),['B2','F6']),before=fingerprint(m);
 const hard=value(runSearch(searchRequest(m,{maxDepth:1,maxNodes:1000},'hard'),frozenClock));
 assert.equal(hard.reply.stats.completedDepth,1);assert.equal(hard.details.rootCandidates,79);
 const standard=value(runSearch(searchRequest(m,{maxDepth:1,maxNodes:1000},'standard'),frozenClock));
 assert.equal(standard.details.rootCandidates,24);assert.equal(fingerprint(m),before);
});

test('more thinking stays interruptible, never exceeds absolute budgets and leaves the live board untouched',()=>{
 const m=sequence(create({swap3:false}),['D4','D5','E5','E6','F6','A9']),before=fingerprint(m);
 for(const maxDepth of [1,2,4,8,12])for(const maxNodes of [1,2,48,400]){
  const req=searchRequest(m,{maxDepth,maxNodes},'hard'),r=value(runSearch(req,frozenClock));value(validateSearchReply(req,r.reply));
  assert.ok(r.reply.stats.nodes<=maxNodes);assert.ok(r.details.maxVisitedDepth<=maxDepth);
  assert.ok(r.details.variation.length<=maxDepth);
  if('action'in r.reply)assert.equal(applyAction(m,r.reply.action).ok,true);
 }
 let checks=0;const r=value(runSearch(searchRequest(m,AI_PROFILES.hard,'hard'),{now:()=>0,isCancelled:()=>++checks>90}));
 assert.equal(r.reply.status,'cancelled');assert.ok(!('action'in r.reply));assert.equal(fingerprint(m),before);
});

test('the generation benchmark fixes the actual v0.5.9 hard opponent and counts every scheduled game',()=>{
 const plan=JSON.parse(readFileSync(new URL('../benchmarks/generation-plan.json',import.meta.url)));
 assert.equal(plan.predecessorVersion,'0.5.9');assert.equal(plan.predecessorCommit,'bf1fb00355295ae6b8d1cb8fd200c17148508e83');
 assert.equal(plan.target,0.8);assert.equal(plan.holdoutGames,40);
 assert.equal(plan.holdoutSeeds.length*plan.directions.length*plan.confirmationDelays.length*plan.candidateActors.length,40);
 assert.equal(new Set([...plan.selectionSeeds,...plan.holdoutSeeds]).size,plan.selectionSeeds.length+plan.holdoutSeeds.length);
 assert.equal(plan.holdoutClaimModes.length,plan.holdoutSeeds.length);assert.equal(plan.holdoutBoards.length,plan.holdoutSeeds.length);
});
