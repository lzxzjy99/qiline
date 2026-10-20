import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {allRuleConfigurations,configIdOf,createMatch,applyAction,activePlayer,undoLastCommand,exportRecord,validateRecord} from '../dist/core/src/index.js';
import {value,error,act,p,ready,sequence,fingerprint,replayEqual,finishByPass,handoff,claimTimes} from './helpers.mjs';
const old=JSON.parse(fs.readFileSync(new URL('../fixtures/legacy-scenarios.json',import.meta.url)));
const results=[];
after(()=>{
 fs.mkdirSync(new URL('../reports/',import.meta.url),{recursive:true});
 fs.writeFileSync(new URL('../reports/configuration-matrix.json',import.meta.url),JSON.stringify({
  rulesVersion:'2.1.0-r3',configurations:448,checks:results.length,
  passed:results.filter(r=>r.status==='passed').length,notApplicable:results.filter(r=>r.status==='not-applicable').length,
  failed:results.filter(r=>r.status==='failed').length,results},null,2));
});

for(const cfg of allRuleConfigurations())test(`rules ${configIdOf(cfg)}`,()=>{
 const check=(id,fn,applicable=true)=>{
  if(!applicable){results.push({configId:configIdOf(cfg),id,status:'not-applicable',reason:'immediate confirmation or insufficient delay for this continuation'});return;}
  try{fn();results.push({configId:configIdOf(cfg),id,status:'passed'});}
  catch(e){results.push({configId:configIdOf(cfg),id,status:'failed',message:e.message});e.message=`${id} ${configIdOf(cfg)}: ${e.message}`;throw e;}
 };
 check('OPENING',()=>{
  if(cfg.swap3)for(const color of ['black','white']){
   let m=value(createMatch(cfg));for(const q of ['I2','I4','I6'])m=act(m,'place',q);
   assert.equal(m.state.phase.kind,'choose');assert.equal(m.state.placements,3);assert.equal(m.positions.length,4);
   const before=m;m=act(m,'choose-color',color);assert.equal(m.state.owners[color],'B');
   assert.equal(m.state.phase.toMove,'white');assert.equal(m.state.ply,3);
   assert.equal(value(undoLastCommand(m)),before);replayEqual(m);
  }else{const m=value(createMatch(cfg));assert.equal(activePlayer(m),'A');assert.equal(m.state.phase.toMove,'black');}
 });
 check('C04_REACHABLE_CAPTURE',()=>{
  const m=sequence(ready(cfg),['B1','A1','A2']);assert.equal(m.state.captures.black,1);
  assert.equal(m.state.board[p(m,'A1')],0);assert.equal(m.state.moveLabels[p(m,'A1')],0);replayEqual(m);
 });
 check('C02_REACHABLE_SUICIDE',()=>{
  const m=sequence(ready(cfg),['I1','D5','I3','F5','I7','E4','I9','E6']),before=fingerprint(m);
  error(applyAction(m,{kind:'place',actor:activePlayer(m),point:p(m,'E5')}),'SUICIDE');assert.equal(fingerprint(m),before);
 });
 check('ILLEGAL_IS_ATOMIC',()=>{
  const m=act(ready(cfg),'place','A1'),before=fingerprint(m),actor=activePlayer(m);
  for(const [a,c] of [[{kind:'place',actor,point:p(m,'A1')},'OCCUPIED'],
   [{kind:'place',actor,point:cfg.boardSize**2},'OUT_OF_BOUNDS'],
   [{kind:'pass',actor:actor==='A'?'B':'A'},'WRONG_ACTOR']]){
   error(applyAction(m,a),c);assert.equal(fingerprint(m),before);
  }
 });
 for(const id of ['K01','K03'])check(id,()=>{
  const fixture=old.cases.find(c=>c.id===id);let m=ready(cfg);
  m=sequence(m,fixture.prefix.map(a=>a.point));assert.equal(m.state.outcome,null);const before=m.state.board;
  for(let i=0;i<fixture.cycle.length;i++){
   if(cfg.superko==='positional'&&i===fixture.cycle.length-1){
    const unchanged=fingerprint(m);error(applyAction(m,{kind:'place',actor:activePlayer(m),point:p(m,fixture.cycle[i].point)}),'REPETITION');
    assert.equal(fingerprint(m),unchanged);
   }else m=act(m,'place',fixture.cycle[i].point);
  }
  if(cfg.superko==='off')assert.deepEqual(m.state.board,before);replayEqual(m);
 });
 check('K02_UNDO_BRANCH',()=>{
  const fixture=old.cases.find(c=>c.id==='K01'),before=sequence(ready(cfg),fixture.prefix.map(a=>a.point));
  const after=act(before,'place','C2'),back=value(undoLastCommand(after));assert.equal(back,before);
  assert.equal(fingerprint(act(back,'place','C2')),fingerprint(after));replayEqual(after);
 });
 check('DELAY_ALL_PASSES',()=>{
  let m=sequence(ready(cfg),['A1','I1','B2','I3','C3','I7','D4','I9','E5']),formed=m.state.ply;
  if(cfg.confirmationDelay)assert.deepEqual(claimTimes(m),{black:formed});
  const positionCount=m.positions.length,placements=m.state.placements;
  while(!m.state.outcome){m=act(m,'pass');if(m.state.ply<formed+cfg.confirmationDelay)assert.equal(m.state.outcome,null);}
  assert.equal(m.state.ply,formed+cfg.confirmationDelay);assert.equal(m.state.outcome.color,'black');
  assert.equal(m.positions.length,positionCount);assert.equal(m.state.placements,placements);replayEqual(m);
 });
 check('DUAL_CANDIDATES',()=>{
  let m=sequence(ready(cfg),['A1','E9','B2','F8','C3','G7','D4','H6','E5']);const formed=m.state.ply;
  if(cfg.confirmationDelay){m=act(m,'place','I5');assert.deepEqual(claimTimes(m),{black:formed,white:formed+1});}
  m=finishByPass(m);assert.equal(m.state.outcome.color,'black');assert.equal(m.state.ply,formed+cfg.confirmationDelay);
 });
 check('CAPTURE_AND_COUNTERLINE',()=>{
  let m=sequence(ready(cfg),['A1','A2','B2','B3','C3','C4','D4','D5','I1','F5','I3','E4','I7','C9','I9','G9','E5']);
  m=act(m,'place','E6');const formed=m.state.ply;assert.deepEqual(claimTimes(m),{white:formed});
  m=finishByPass(m);assert.equal(m.state.outcome.color,'white');assert.equal(m.state.ply,formed+cfg.confirmationDelay);
 },cfg.confirmationDelay>0);
 check('BROKEN_CLAIM_RESTARTS',()=>{
  let m=sequence(ready(cfg),handoff.slice(0,17));m=act(m,'place','E6');assert.deepEqual(claimTimes(m),{});
  m=act(m,'place','I5');const formed=m.state.ply;assert.deepEqual(claimTimes(m),{black:formed});
  m=finishByPass(m);assert.equal(m.state.ply,formed+cfg.confirmationDelay);assert.equal(m.state.outcome.color,'black');
 },cfg.confirmationDelay>0);
 check('HANDOFF_MODE',()=>{
  const start=ready(cfg),offset=start.state.ply;let m=sequence(start,handoff);
  const due=offset+(cfg.confirmationDelay===0?17:cfg.confirmationDelay===2?19:
   (cfg.claimMode==='fixed-five'?19:17)+cfg.confirmationDelay);
  m=finishByPass(m);assert.equal(m.state.ply,due);assert.equal(m.state.outcome.color,'black');replayEqual(m);
 });
 for(const which of ['new','old'])check(`OVERLINE_${which.toUpperCase()}_SURVIVES`,()=>{
  const blacks=which==='new'?['A1','B2','C3','D4','E5']:['B2','C3','D4','E5','F6'];
  const whites=['B1','I1','I3','I9'],coords=[];for(let i=0;i<blacks.length;i++){coords.push(blacks[i]);if(i<4)coords.push(whites[i]);}
  const base=ready(cfg),offset=base.state.ply;let m=sequence(base,coords);
  m=act(m,'place','A9');m=act(m,'place',which==='new'?'F6':'A1');
  if(cfg.claimMode==='fixed-five')assert.deepEqual(m.state.claims.map(c=>c.formedAt).sort((a,b)=>a-b),[offset+9,offset+11]);
  m=act(m,'place','A2');const formed=offset+(cfg.claimMode==='fixed-five'&&which==='new'?11:9);
  assert.deepEqual(claimTimes(m),{black:formed});m=finishByPass(m);assert.equal(m.state.ply,formed+cfg.confirmationDelay);
 },cfg.confirmationDelay>=4);
 check('DOUBLE_PASS_AND_RESET',()=>{
  let m=act(ready(cfg),'place','H1');assert.equal(m.state.passStreak,0);
  m=act(m,'pass');assert.equal(m.state.outcome,null);assert.equal(m.state.passStreak,1);
  m=act(m,'pass');assert.deepEqual(m.state.outcome,{kind:'draw',reason:'two-passes'});replayEqual(m);
 });
 check('REACHABLE_FORCED_PASS_ATOMIC_UNDO',()=>{
  let m=value(createMatch(cfg));
  if(cfg.swap3){
   for(const q of ['A2','A1','C1'])m=act(m,'place',q);
   m=act(m,'choose-color','white');m=act(m,'pass');m=act(m,'place','B1');
   if(m.state.phase.toMove==='white')m=act(m,'pass');
  }
  let beforeLast=null;
  for(let q=0;q<cfg.boardSize**2;q++){
   if((q%cfg.boardSize+2*Math.floor(q/cfg.boardSize))%5===0 || m.state.board[q]!==0)continue;
   assert.equal(m.state.phase.toMove,'black');beforeLast=m;m=act(m,'place',q);
   if(m.state.phase.toMove==='white')m=act(m,'pass');assert.equal(m.state.outcome,null);assert.equal(m.state.claims.length,0);
  }
  assert.equal(m.state.phase.toMove,'black');assert.equal(m.state.passStreak,1);
  assert.equal(m.accepted.at(-1).kind,'place');assert.equal(value(undoLastCommand(m)),beforeLast);
  const before=m,transition=value(applyAction(m,{kind:'place',actor:activePlayer(m),point:p(m,'E4')}));
  m=transition.match;const formed=before.state.ply+1;
  assert.equal(transition.events.filter(e=>e.kind==='passed'&&e.automatic).length,cfg.confirmationDelay?1:0);
  if(cfg.confirmationDelay)assert.equal(value(undoLastCommand(m)),before);
  while(!m.state.outcome){const previous=m;m=act(m,'pass');if(!m.state.outcome){assert.equal(m.state.ply,previous.state.ply+2);assert.equal(value(undoLastCommand(m)),previous);}}
  assert.equal(m.state.ply,formed+cfg.confirmationDelay);assert.equal(m.state.outcome.color,'black');replayEqual(m);
 });
 check('RESIGN_AND_FINISHED',()=>{
  const m=ready(cfg),actor=activePlayer(m),end=act(m,'resign',undefined,actor);
  assert.equal(end.state.ply,m.state.ply);assert.notEqual(end.state.outcome.winner,actor);
  error(applyAction(end,{kind:'pass',actor}),'FINISHED');error(undoLastCommand(end),'FINISHED');replayEqual(end);
 });
 check('RECORD_VERSION_AND_FIELDS',()=>{
  const m=act(ready(cfg),'place','A1');replayEqual(m);
  for(const mutate of [r=>delete r.rules.claimMode,r=>r.rulesVersion='2.1.0-r2',r=>r.rules.blocked='loss']){
   const bad=JSON.parse(JSON.stringify(exportRecord(m)));mutate(bad);assert.equal(validateRecord(bad).ok,false);
  }
 });
});
