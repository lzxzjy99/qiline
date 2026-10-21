import test from 'node:test';
import assert from 'node:assert/strict';
import {allRuleConfigurations,configIdOf,activePlayer,getLegalPlacements} from '../dist/core/src/index.js';
import {beginAITurn,prepareSearch,AI_PROFILES} from '../dist/ai/src/index.js';
import {value,error,fingerprint} from './helpers.mjs';
import {practice,point,reply,place,command} from './ai-helpers.mjs';

// 448 rule configurations × 2 true-player roles × 3 levels. These verify contracts, not playing strength.
for(const cfg of allRuleConfigurations())for(const actor of ['A','B'])for(const level of ['easy','standard','hard'])
test(`AI contract ${configIdOf(cfg)} ${actor} ${level}`,()=>{
 const s=practice(actor,cfg,level,actor==='A'?0:0xffffffff);
 function ai(action){
  const before=s.state.match,turn=value(beginAITurn(s));
  assert.equal(turn.request.context.actor,actor);assert.equal(s.state.match,before);
  assert.equal(turn.request.level,level);assert.deepEqual(turn.request.budget,AI_PROFILES[level]);
  const worker=value(prepareSearch(structuredClone(turn.request)));
  assert.equal(fingerprint(worker.match),fingerprint(before));assert.equal(s.state.match,before);
  value(turn.accept(reply(turn,action,level==='easy'?'move':'timeout')));
  const committed=s.state;error(turn.accept(reply(turn,action)),'STALE_AI_TASK');assert.equal(s.state,committed);
 }
 if(cfg.swap3){
  for(const coord of ['I2','I4','I6']){
   const a={kind:'place',actor:'A',point:point(s,coord)};
   if(actor==='A')ai(a);else value(s.submit('A',a));
  }
  assert.equal(s.state.match.state.phase.kind,'choose');
  const choice={kind:'choose-color',actor:'B',color:level==='easy'?'black':'white'};
  if(actor==='B')ai(choice);else value(s.submit('B',choice));
  assert.equal(s.state.match.state.owners[choice.color],'B');
  assert.equal(s.state.match.state.ply,3);
 }else if(actor==='B')place(s,'E5');
 // Choosing white may leave B active again; choosing black may leave A active again.
 if(activePlayer(s.state.match)!==actor)command(s,{kind:'pass',actor:activePlayer(s.state.match)});
 assert.equal(activePlayer(s.state.match),actor);
 const before=s.state.match.state.ply;
 ai({kind:'place',actor,point:getLegalPlacements(s.state.match)[0]});
 assert.equal(s.state.match.state.ply,before+1);assert.equal(s.state.match.state.outcome,null);
});
