import test from 'node:test';
import assert from 'node:assert/strict';
import {allRuleConfigurations,configIdOf,activePlayer,getLegalPlacements} from '../dist/core/src/index.js';
import {practice,point} from './ai-helpers.mjs';
import {value} from './helpers.mjs';
import {workerFixture} from './worker-fakes.mjs';

// Deterministic Worker-port matrix for scheduler identity/lifecycle; native-thread tests run separately.
for(const cfg of allRuleConfigurations())for(const actor of ['A','B'])for(const level of ['easy','standard','hard'])
test(`worker lifecycle ${configIdOf(cfg)} ${actor} ${level}`,()=>{
 const s=practice(actor,cfg,level);if(actor==='B'){
  if(cfg.swap3)for(const c of ['I2','I4','I6'])value(s.submit('A',{kind:'place',actor:'A',point:point(s,c)}));
  else value(s.submit('A',{kind:'place',actor:'A',point:point(s,'E5')}));
 }
 const f=workerFixture(s);let w=f.start();
 function commit(action){w.ready();assert.equal(w.sent[0].context.actor,actor);assert.equal(w.sent[0].level,level);
  w.emit(w.result(action));assert.equal(w.terminated,1);assert.equal(w.onmessage,null);}
 if(cfg.swap3&&actor==='B'){
  commit({kind:'choose-color',actor:'B',color:level==='easy'?'white':'black'});
  if(activePlayer(s.state.match)!==actor){const human=activePlayer(s.state.match);value(f.driver.change(()=>s.submit(human,{kind:'pass',actor:human})));}
  f.clock.tick();w=f.clock.workers.at(-1);
 }
 commit({kind:'place',actor,point:getLegalPlacements(s.state.match)[0]});
 f.driver.close();assert.equal(s.state.task,null);assert.equal(f.clock.timers.size,0);
 assert.ok(f.clock.workers.every(p=>p.terminated===1));
});
