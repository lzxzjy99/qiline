import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DEFAULT_RULES,RULES_VERSION,allRuleConfigurations,configIdOf,createMatch,applyAction,activePlayer,
 getLegalActions,getLegalPlacements,inspectGroup,undoLastCommand,exportRecord,validateRecord,parseRecord,
 parsePoint,formatPoint} from '../dist/core/src/index.js';
import {collectGroups,simulatePlacement,geometryPossible} from '../dist/core/src/geometry.js';
import {value,error,create,act,p,fingerprint,replayEqual,sequence,finishByPass,handoff,claimTimes} from './helpers.mjs';

test('all 448 configurations are complete, unique and immutable',()=>{
 const configs=allRuleConfigurations();assert.equal(configs.length,448);
 assert.equal(new Set(configs.map(configIdOf)).size,448);
 assert.equal(DEFAULT_RULES.confirmationDelay,4);assert.equal(DEFAULT_RULES.claimMode,'fixed-five');
 for(const boardSize of [9,13,15,19]){
  const m=create({boardSize});assert.equal(m.state.board.length,boardSize**2);
  for(let q=0;q<boardSize**2;q++)assert.equal(value(parsePoint(formatPoint(q,boardSize),boardSize)),q);
 }
 for(const patch of [{boardSize:81},{boardSize:true},{confirmationDelay:3},{confirmationDelay:'4'},
  {claimMode:'mixed'},{swap3:1},{blocked:'loss'},{rulesVersion:'2.0.0'}]){
  assert.equal(createMatch({...DEFAULT_RULES,...patch}).ok,false);
 }
 for(const x of [null,[],{},true])error(createMatch(x),'INVALID_RULES');
});

test('corner capture, suicide escape and deduplication use P1 geometry fixtures',()=>{
 const old=JSON.parse(fs.readFileSync(new URL('../fixtures/legacy-scenarios.json',import.meta.url)));
 for(const n of [9,13,15,19])for(const c of old.cases.filter(c=>c.category==='capture')){
  const board=Array(n*n).fill(0),point=s=>value(parsePoint(s,n));
  for(const s of c.black??[])board[point(s)]=1;
  for(const s of c.white??[])board[point(s)]=-1;
  const before=board.slice(),r=simulatePlacement(board,point(c.move.point),'black',n);
  assert.deepEqual(board,before);
  if(c.expected.legal)assert.deepEqual(value(r).captured,c.expected.captured.map(point).sort((a,b)=>a-b));
  else error(r,c.expected.error);
 }
});

function independentPlacement(board,p,c,n){
 const b=board.slice();if(b[p])return null;b[p]=c;
 const adjacency=q=>{const x=q%n,y=Math.floor(q/n);return [[x-1,y],[x+1,y],[x,y-1],[x,y+1]]
  .filter(([a,d])=>a>=0&&d>=0&&a<n&&d<n).map(([a,d])=>d*n+a);};
 const groups=()=>{const seen=new Set(),out=[];
  for(let q=0;q<b.length;q++)if(b[q]&&!seen.has(q)){
   const stones=[q],libs=new Set();seen.add(q);
   for(let j=0;j<stones.length;j++)for(const r of adjacency(stones[j])){
    if(!b[r])libs.add(r);else if(b[r]===b[q]&&!seen.has(r)){seen.add(r);stones.push(r);}
   }
   out.push({c:b[q],stones,libs});
  }return out;
 };
 const captured=[];
 for(const g of groups())if(g.c===-c&&!g.libs.size)captured.push(...g.stones);
 for(const q of captured)b[q]=0;
 if(!groups().find(g=>g.stones.includes(p)).libs.size)return null;
 return {board:b,captured:captured.sort((a,b)=>a-b)};
}
test('exhaustive 3x3 legal local boards agree with independent full-board capture oracle',()=>{
 let valid=0,probes=0;
 for(let encoded=0;encoded<3**9;encoded++){
  let num=encoded;const board=Array.from({length:9},()=>{const c=[0,1,-1][num%3];num=Math.floor(num/3);return c;});
  const groups=collectGroups(board,3);if(groups.groups.some(g=>!g.liberties.size))continue;valid++;
  for(let p=0;p<9;p++)if(board[p]===0)for(const color of ['black','white']){
   const expected=independentPlacement(board,p,color==='black'?1:-1,3);
   const actual=simulatePlacement(board,p,color,3,groups);
   assert.equal(geometryPossible(board,p,color,3,groups),expected!==null);
   assert.equal(actual.ok,expected!==null);
   if(expected)assert.deepEqual(actual.value,expected);else error(actual,'SUICIDE');probes++;
  }
 }
 assert.equal(valid,12675);assert.equal(probes,89926);
 fs.mkdirSync(new URL('../reports/',import.meta.url),{recursive:true});
 fs.writeFileSync(new URL('../reports/geometry.json',import.meta.url),JSON.stringify({assignments:19683,validBoards:valid,moveProbes:probes,disagreements:0},null,2));
});

test('swap ownership, opening pass/capture refusal, inspection and exact transaction events',()=>{
 let m=create();error(applyAction(m,{kind:'pass',actor:'A'}),'WRONG_PHASE');
 m=act(m,'place','A2');m=act(m,'place','A1');
 const before=fingerprint(m);error(applyAction(m,{kind:'place',actor:'A',point:p(m,'B1')}),'OPENING_CAPTURE');
 assert.equal(fingerprint(m),before);
 m=act(m,'place','E5');assert.equal(m.state.phase.kind,'choose');
 const chosen=act(m,'choose-color','black');assert.deepEqual(chosen.state.owners,{black:'B',white:'A'});
 assert.equal(activePlayer(chosen),'A');assert.equal(chosen.state.ply,3);
 assert.equal(value(undoLastCommand(chosen)),m);
 error(applyAction(m,{kind:'choose-color',actor:'A',color:'white'}),'WRONG_ACTOR');
 assert.equal(value(inspectGroup(m,p(m,'I9'))),null);
 const g=value(inspectGroup(m,p(m,'A1')));assert.deepEqual(g.stones,[p(m,'A1')]);
 error(inspectGroup(m,81),'OUT_OF_BOUNDS');
 let k=create({swap3:false});k=act(k,'place','B1');k=act(k,'place','A1');
 const r=value(applyAction(k,{kind:'place',actor:'A',point:p(k,'A2')}));
 assert.deepEqual(r.events.filter(e=>e.kind==='captured').map(e=>e.points),[[p(k,'A1')]]);
 assert.equal(r.match.state.moveLabels[p(k,'A1')],0);
 assert.equal(r.match.state.moveLabels[p(k,'A2')],3);
 const passed=act(r.match,'pass');assert.equal(passed.state.placements,3);
 assert.deepEqual(passed.state.lastCaptured,[p(k,'A1')]);
});

test('public state, commands, events and exported records resist external mutation; fake matches fail',()=>{
 const input={...DEFAULT_RULES,swap3:false};const root=value(createMatch(input));input.boardSize=19;
 assert.equal(root.rules.boardSize,9);
 const command={kind:'place',actor:'A',point:0},r=value(applyAction(root,command));command.point=80;
 assert.equal(r.match.accepted[0].point,0);assert.equal(root.state.board[0],0);
 for(const change of [()=>r.match.state.board[0]=0,()=>r.match.state.phase.toMove='black',
  ()=>r.match.accepted.push(command),()=>r.events[0].point=80,()=>exportRecord(r.match).actions.push(command)])assert.throws(change,TypeError);
 assert.equal(r.match.state.board[0],1);
 error(applyAction(JSON.parse(JSON.stringify(r.match)),command),'INVALID_MATCH');
 error(applyAction(null,command),'INVALID_MATCH');
});

test('default handoff waits to ply 23, optional pressure wins at 21; every five has its own clock',()=>{
 for(const mode of ['fixed-five','color-pressure']){
  let m=sequence(create({swap3:false,claimMode:mode}),handoff);assert.equal(m.state.ply,20);
  assert.deepEqual(claimTimes(m),{black:mode==='fixed-five'?19:17});
  m=act(m,'pass');assert.equal(!!m.state.outcome,mode==='color-pressure');
  m=finishByPass(m);assert.equal(m.state.ply,mode==='fixed-five'?23:21);
  replayEqual(m);error(undoLastCommand(m),'FINISHED');
 }
});

test('a single move creating six stones chooses a numeric canonical winning five in immediate mode',()=>{
 for(const boardSize of [9,13,15,19])for(const directions of ['diagonal','four'])for(const winningColor of ['black','white']){
  const target=['I1','H2','G3','E5','D6','F4'],filler=['A1','A3','A5','A7','A9','C1'],coords=[];
  for(let i=0;i<6;i++){
   if(winningColor==='black'){coords.push(target[i]);if(i<5)coords.push(filler[i]);}
   else coords.push(filler[i],target[i]);
  }
  const m=sequence(create({boardSize,directions,swap3:false,confirmationDelay:0}),coords);
  assert.equal(m.state.outcome.color,winningColor);assert.equal(m.state.ply,winningColor==='black'?11:12);
  assert.deepEqual(m.state.claims[0].points,['I1','H2','G3','F4','E5'].map(q=>p(m,q)));replayEqual(m);
 }
});

test('same-color crossing fives share a formation time without producing ambiguous outcomes in all configurations',()=>{
 for(const cfg of allRuleConfigurations()){
  let m=value(createMatch(cfg));
  if(cfg.swap3){for(const q of ['I2','I4','I6'])m=act(m,'place',q);m=act(m,'choose-color','white');m=act(m,'pass');}
  const offset=m.state.ply,black=['A1','B2','C3','D4','A9','B8','C7','D6','E5'],white=['I1','I3','I5','I7','I9','G1','G3','G9'];
  const coords=[];for(let i=0;i<black.length;i++){coords.push(black[i]);if(i<white.length)coords.push(white[i]);}
  m=sequence(m,coords);
  if(cfg.confirmationDelay){
   assert.equal(m.state.claims.length,cfg.claimMode==='fixed-five'?2:1);assert.deepEqual(claimTimes(m),{black:offset+17});
  }
  m=finishByPass(m);assert.equal(m.state.outcome.color,'black');assert.equal(m.state.ply,offset+17+cfg.confirmationDelay);replayEqual(m);
 }
});

test('record loading validates every command and version; invalid input never alters the active match',()=>{
 let m=sequence(create({swap3:false}),['E5','D5','F5']);const before=fingerprint(m),record=exportRecord(m);
 replayEqual(m);assert.equal(value(parseRecord(JSON.stringify(record))).state.ply,3);
 error(parseRecord('{broken'),'INVALID_RECORD');
 for(const mutate of [r=>r.schemaVersion=99,r=>r.schemaVersion=true,r=>r.rulesVersion='2.1.0-r2',
  r=>r.rules.claimMode='mixed',r=>delete r.rules.claimMode,r=>r.rules.blocked='loss',r=>r.untrustedState={board:[]},
  r=>r.actions[0].point=true,r=>r.actions.push({kind:'pass',actor:'A'}),
  r=>r.actions[1].point=r.actions[0].point,r=>r.actions[0].extra=1]){
  const bad=JSON.parse(JSON.stringify(record));mutate(bad);assert.equal(validateRecord(bad).ok,false);
  assert.equal(fingerprint(m),before);
 }
 const invalid=JSON.parse(JSON.stringify(record));invalid.actions[1].point=invalid.actions[0].point;
 const e=error(validateRecord(invalid),'INVALID_RECORD');assert.equal(e.path,'actions[1]');assert.equal(e.cause,'OCCUPIED');
});

test('off-turn resignation, cancellation consent, no post-terminal commands, and legal action lists',()=>{
 let m=act(create({swap3:false}),'place','E5');
 assert.deepEqual(getLegalActions(m,'A').map(a=>a.kind),['resign']);
 const end=act(m,'resign',undefined,'A');assert.equal(end.state.outcome.color,'white');assert.equal(end.state.ply,1);
 for(const a of [{kind:'pass',actor:'B'},{kind:'resign',actor:'B'}])error(applyAction(end,a),'FINISHED');
 assert.equal(getLegalPlacements(end).length,0);error(undoLastCommand(end),'FINISHED');
 const root=create();error(applyAction(root,{kind:'cancel-opening',actor:'A',approvedBy:['A']}),'CONSENT_REQUIRED');
 const cancelled=act(root,'cancel-opening',['B','A'],'B');assert.equal(cancelled.state.outcome.kind,'cancelled');
 assert.equal(cancelled.state.ply,0);replayEqual(cancelled);error(undoLastCommand(cancelled),'FINISHED');
 error(applyAction(cancelled,{kind:'place',actor:'A',point:0}),'FINISHED');
});
