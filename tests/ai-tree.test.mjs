import test from 'node:test';
import assert from 'node:assert/strict';
import {alphaBeta} from '../dist/ai/src/tree.js';

function adapter(counter={leaves:0,cuts:0}){return {
 check:()=>{},terminal:n=>typeof n.value==='number',player:n=>n.actor??null,
 evaluate:n=>{counter.leaves++;return n.value;},cutoff:()=>counter.cuts++,
 children:function*(n){for(const [move,node]of Object.entries(n.children))yield{move,node};},
};}
test('the same A player maximizes on consecutive commands instead of flipping signs every ply',()=>{
 const node={actor:'A',children:{again:{actor:'A',children:{good:{value:10},bad:{value:-10}}},
  other:{actor:'B',children:{x:{value:4},y:{value:3}}}}};
 assert.deepEqual(alphaBeta(node,2,'A',adapter()),{value:10,variation:['again','good']});
});
test('B choosing white and moving again is still a maximizing B turn; choosing black gives A the minimizing turn',()=>{
 const node={actor:'B',children:{white:{actor:'B',children:{best:{value:6},worst:{value:-3}}},
  black:{actor:'A',children:{x:{value:5},y:{value:4}}}}};
 assert.deepEqual(alphaBeta(node,2,'B',adapter()),{value:6,variation:['white','best']});
});
test('alpha-beta cuts a reply that cannot improve the root result without changing its value',()=>{
 const node={actor:'A',children:{left:{actor:'B',children:{a:{value:3},b:{value:5}}},
  right:{actor:'B',children:{c:{value:1},d:{value:100}}}}},counter={leaves:0,cuts:0};
 assert.equal(alphaBeta(node,2,'A',adapter(counter)).value,3);assert.equal(counter.leaves,3);assert.equal(counter.cuts,1);
});
test('seeded mixed-turn trees agree with an independent exhaustive minimax oracle',()=>{
 let state=761;const next=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state;};
 const build=depth=>depth===0?{value:next()%101-50}:{actor:next()%2?'A':'B',children:{
  left:build(depth-1),right:build(depth-1),...(next()%3===0?{third:build(depth-1)}:{}),
 }};
 const exhaustive=(node,actor)=>typeof node.value==='number'?node.value:
  (node.actor===actor?Math.max:Math.min)(...Object.values(node.children).map(n=>exhaustive(n,actor)));
 for(let i=0;i<200;i++){const node=build(4);for(const actor of ['A','B'])assert.equal(alphaBeta(node,4,actor,adapter()).value,exhaustive(node,actor));}
});
test('budget/cancellation interrupts propagate out of the tree without an invented score',()=>{
 const stop={},tree=adapter();tree.check=()=>{throw stop;};
 assert.throws(()=>alphaBeta({value:7},0,'A',tree),e=>e===stop);
});
