import test from 'node:test';
import assert from 'node:assert/strict';
import {allRuleConfigurations,activePlayer,configIdOf,getLegalActions} from '../dist/core/src/index.js';
import {beginAITurn,prepareSearch,analyzeTactics,pickBasicAction} from '../dist/ai/src/index.js';
import {value,fingerprint} from './helpers.mjs';
import {practice,point,reply} from './ai-helpers.mjs';

for(const cfg of allRuleConfigurations())for(const actor of ['A','B'])for(const level of ['easy','standard'])
test(`basic AI ${configIdOf(cfg)} ${actor} ${level}`,()=>{
 const s=practice(actor,cfg,level,level==='easy'?0:0xffffffff);
 function ai(){
  const before=s.state.match,turn=value(beginAITurn(s)),worker=value(prepareSearch(structuredClone(turn.request)));
  const analysis=value(analyzeTactics(worker.match)),chosen=value(pickBasicAction(analysis,worker.request.seed));
  const legal=getLegalActions(worker.match).filter(a=>a.kind!=='resign'&&a.kind!=='cancel-opening');
  assert.deepEqual(new Set(analysis.candidates.map(c=>JSON.stringify(c.action))),new Set(legal.map(a=>JSON.stringify(a))));
  assert.equal(analysis.actor,actor);assert.equal(chosen.actor,actor);assert.equal(s.state.match,before);
  const candidate=analysis.candidates.find(c=>JSON.stringify(c.action)===JSON.stringify(chosen));
  value(turn.accept(reply(turn,chosen)));assert.equal(fingerprint(s.state.match),fingerprint(candidate.next));
  return chosen;
 }
 if(cfg.swap3){
  if(actor==='A')for(let i=0;i<3;i++){assert.equal(activePlayer(s.state.match),'A');assert.equal(ai().kind,'place');}
  else for(const coord of ['I2','I4','I6'])value(s.submit('A',{kind:'place',actor:'A',point:point(s,coord)}));
  assert.equal(s.state.match.state.phase.kind,'choose');
  if(actor==='B')assert.equal(ai().kind,'choose-color');
  else value(s.submit('B',{kind:'choose-color',actor:'B',color:level==='easy'?'black':'white'}));
 }else if(actor==='B')value(s.submit('A',{kind:'place',actor:'A',point:point(s,'E5')}));
 if(activePlayer(s.state.match)!==actor){const human=activePlayer(s.state.match);value(s.submit(human,{kind:'pass',actor:human}));}
 assert.equal(s.state.match.state.phase.kind,'playing');assert.equal(activePlayer(s.state.match),actor);
 const before=s.state.match.state.ply;assert.equal(ai().kind,'place');
 assert.equal(s.state.match.state.ply,before+1);assert.equal(s.state.match.state.outcome,null);
});
