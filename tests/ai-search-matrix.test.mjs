import test from 'node:test';
import assert from 'node:assert/strict';
import {allRuleConfigurations,activePlayer,configIdOf} from '../dist/core/src/index.js';
import {beginAITurn,runSearch,validateSearchReply} from '../dist/ai/src/index.js';
import {value,fingerprint} from './helpers.mjs';
import {practice,point} from './ai-helpers.mjs';

for(const cfg of allRuleConfigurations())for(const actor of ['A','B'])for(const level of ['easy','standard','hard'])
test(`bounded search ${configIdOf(cfg)} ${actor} ${level}`,()=>{
 const s=practice(actor,cfg,level,level==='easy'?0:0xffffffff);
 if(actor==='B'){
  if(cfg.swap3)for(const c of ['I2','I4','I6'])value(s.submit('A',{kind:'place',actor:'A',point:point(s,c)}));
  else value(s.submit('A',{kind:'place',actor:'A',point:point(s,'E5')}));
 }
 function ai(){
  const budget={timeMs:10000,maxNodes:level==='easy'?48:96,maxDepth:level==='easy'?2:4};
  const before=s.state.match,turn=value(beginAITurn(s,{budget})),result=value(runSearch(structuredClone(turn.request),{now:()=>0}));
  assert.equal(s.state.match,before);value(validateSearchReply(turn.request,result.reply));
  assert.ok(result.reply.stats.nodes<=budget.maxNodes);assert.ok(result.reply.stats.completedDepth<=budget.maxDepth);
  assert.ok(result.details.maxVisitedDepth<=budget.maxDepth);assert.equal(result.reply.action.actor,actor);
  value(turn.accept(result.reply));assert.notEqual(fingerprint(s.state.match),fingerprint(before));
 }
 ai();
 if(cfg.swap3&&actor==='B'){
  if(activePlayer(s.state.match)!=='B'){const human=activePlayer(s.state.match);value(s.submit(human,{kind:'pass',actor:human}));}
  // A stronger evaluation may choose black; A's explicit handoff pass then also counts.
  const beforePly=s.state.match.state.ply,beforeCommands=s.state.match.accepted.length;
  ai();assert.equal(s.state.match.state.ply,beforePly+1);
  assert.equal(s.state.match.accepted.length,beforeCommands+1);
 }
});
