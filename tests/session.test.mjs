import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createSession} from '../dist/session/src/index.js';
import {DEFAULT_RULES,activePlayer,parsePoint} from '../dist/core/src/index.js';
import {value,error,fingerprint} from './helpers.mjs';
const HUMAN={kind:'human'},AI={kind:'ai',level:'standard',seed:37};
const opts=(patch={})=>({matchId:'M',rules:{...DEFAULT_RULES,swap3:false},...patch});
const session=(patch={})=>value(createSession(opts(patch)));
const place=(s,actor,coord)=>value(s.submit(actor,{kind:'place',actor,point:value(parsePoint(coord,s.state.match.rules.boardSize))}));
const stateText=s=>JSON.stringify(s.state);

test('session validation copies controller settings and freezes published views',()=>{
 const input=opts({controllers:{A:{...HUMAN},B:{...AI}}});const s=value(createSession(input));input.controllers.B.seed=999;
 assert.equal(s.state.controllers.B.seed,37);assert.throws(()=>s.state.controllers.B.seed=999,TypeError);
 for(const bad of [null,{},opts({matchId:''}),opts({controllers:{A:HUMAN,B:{kind:'ai',level:'hard',seed:0}}}),
  opts({competitive:1}),{...opts(),unknown:true}])assert.equal(createSession(bad).ok,false);
});

test('PvP undo requires the other player, blocks live play, then restores the exact complete command',()=>{
 const s=session();const root=s.state.match;place(s,'A','E5');const after=s.state.match;
 const rev=s.state.revision;value(s.requestUndo('A'));assert.equal(s.state.paused,true);assert.ok(s.state.revision>rev);
 assert.equal(s.state.match,after);const request=s.state.consent;
 error(s.respondToConsent('A',request.id,true),'WRONG_ACTOR');
 error(s.respondToConsent('B','old-request',true),'STALE_REQUEST');
 error(s.submit('B',{kind:'pass',actor:'B'}),'PAUSED');
 error(s.setPaused(false),'CONSENT_REQUIRED');
 value(s.respondToConsent('B',request.id,true));assert.equal(s.state.match,root);assert.equal(s.state.paused,false);
 error(s.respondToConsent('B',request.id,true),'STALE_REQUEST');
 assert.ok(s.state.revision>rev);error(s.requestUndo('A'),'NO_UNDO');
});

test('rejecting consent preserves the position and declining party can initiate its own request',()=>{
 const s=session();place(s,'A','E5');const position=s.state.match;
 value(s.requestUndo('B'));const id=s.state.consent.id;value(s.respondToConsent('A',id,false));
 assert.equal(s.state.match,position);assert.equal(s.state.consent,null);assert.equal(s.state.paused,false);
 value(s.requestUndo('A'));assert.notEqual(s.state.consent.id,id);
});

test('opening cancellation cannot be smuggled through approvedBy or unilaterally restarted',()=>{
 const s=session({rules:{...DEFAULT_RULES}});
 error(s.submit('A',{kind:'cancel-opening',actor:'A',approvedBy:['A','B']}),'CONSENT_REQUIRED');
 error(s.newGame('N'),'WRONG_PHASE');
 value(s.requestCancelOpening('B'));assert.equal(s.state.match.state.outcome,null);
 value(s.respondToConsent('A',s.state.consent.id,true));assert.equal(s.state.match.state.outcome.kind,'cancelled');
 assert.deepEqual(s.state.match.accepted.at(-1).approvedBy,['A','B']);
 value(s.newGame('N'));assert.equal(s.state.matchId,'N');assert.equal(s.state.match.state.ply,0);
 error(s.newGame('M'),'WRONG_PHASE');
});

test('competition disables undo, cancellation and tactical hints',()=>{
 const s=session({competitive:true});place(s,'A','E5');
 error(s.requestUndo('A'),'COMPETITIVE');error(s.requestHints('A'),'COMPETITIVE');
 error(s.beginTask('hint','A','H'),'HINTS_DISABLED');
 const opening=session({competitive:true,rules:DEFAULT_RULES});error(opening.requestCancelOpening('A'),'COMPETITIVE');
});

test('both humans must enable hints; either can disable and both have equal access',()=>{
 const s=session();error(s.beginTask('hint','A','X'),'HINTS_DISABLED');
 value(s.requestHints('A'));value(s.respondToConsent('B',s.state.consent.id,true));assert.equal(s.state.hintsEnabled,true);
 const h=value(s.beginTask('hint','B','H'));assert.equal(s.isTaskCurrent(h),true);
 const core=s.state.match;value(s.completeHint(h));assert.equal(s.state.match,core);assert.equal(s.isTaskCurrent(h),false);
 const h2=value(s.beginTask('hint','A','H'));assert.notEqual(h2.revision,h.revision);
 value(s.disableHints('B'));assert.equal(s.state.hintsEnabled,false);error(s.completeHint(h2),'STALE_TASK');
});

test('human cannot impersonate AI; AI action and actor are revalidated on commit',()=>{
 const s=session({controllers:{A:HUMAN,B:AI}});place(s,'A','E5');
 error(s.submit('B',{kind:'pass',actor:'B'}),'WRONG_ACTOR');
 error(s.beginTask('ai','A','X'),'WRONG_ACTOR');
 const token=value(s.beginTask('ai','B','X'));
 error(s.beginTask('ai','B','Y'),'TASK_BUSY');
 const before=stateText(s);error(s.commitAIResult(token,{kind:'place',actor:'B',point:40}),'OCCUPIED');assert.equal(stateText(s),before);
 error(s.commitAIResult(token,{kind:'pass',actor:'A'}),'WRONG_ACTOR');
 value(s.commitAIResult(token,{kind:'place',actor:'B',point:0}));assert.equal(s.state.match.state.board[0],-1);
 error(s.commitAIResult(token,{kind:'pass',actor:'B'}),'STALE_TASK');
});

test('undo cancels AI work; decreasing ply never reuses revision or revives old task id',()=>{
 const s=session({controllers:{A:HUMAN,B:AI}});place(s,'A','E5');
 const x=value(s.beginTask('ai','B','X')),rev=s.state.revision;
 value(s.requestUndo('A'));assert.equal(s.state.match.state.ply,0);assert.ok(s.state.revision>rev);
 error(s.commitAIResult(x,{kind:'place',actor:'B',point:0}),'STALE_TASK');
 place(s,'A','E5');const fresh=value(s.beginTask('ai','B','X'));assert.notEqual(fresh.revision,x.revision);
 error(s.commitAIResult(x,{kind:'pass',actor:'B'}),'STALE_TASK');
 value(s.commitAIResult(fresh,{kind:'pass',actor:'B'}));assert.equal(s.state.match.state.ply,2);
});

test('practice undo is exactly one explicit command, including AI replies',()=>{
 const s=session({controllers:{A:HUMAN,B:AI}});place(s,'A','E5');const humanPosition=s.state.match;
 const t=value(s.beginTask('ai','B','T'));value(s.commitAIResult(t,{kind:'place',actor:'B',point:0}));
 value(s.requestUndo('A'));assert.equal(s.state.match,humanPosition);assert.equal(activePlayer(s.state.match),'B');
 value(s.requestUndo('A'));assert.equal(s.state.match.state.ply,0);
});

test('pause and cancel invalidate tokens, even when task ids are reused',()=>{
 const s=session({controllers:{A:AI,B:HUMAN}});
 const old=value(s.beginTask('ai','A','same'));value(s.setPaused(true));error(s.commitAIResult(old,{kind:'pass',actor:'A'}),'STALE_TASK');
 error(s.beginTask('ai','A','P'),'PAUSED');value(s.setPaused(false));
 const next=value(s.beginTask('ai','A','same'));assert.notEqual(next.revision,old.revision);
 value(s.cancelTask());error(s.commitAIResult(next,{kind:'pass',actor:'A'}),'STALE_TASK');
});

test('new game invalidates previous match tasks and refuses reused match identifiers',()=>{
 const s=session({controllers:{A:AI,B:HUMAN}}),old=value(s.beginTask('ai','A','X'));
 const revision=s.state.revision;value(s.newGame('N'));assert.ok(s.state.revision>revision);
 assert.equal(s.state.matchId,'N');error(s.commitAIResult(old,{kind:'pass',actor:'A'}),'STALE_TASK');
 error(s.newGame('M'),'INVALID_SESSION');error(s.newGame('N'),'INVALID_SESSION');
});

test('save/load fully replays first; failed loads preserve position, task and id availability',()=>{
 const s=session({controllers:{A:HUMAN,B:AI}});place(s,'A','E5');const save=s.exportSave(),expected=fingerprint(s.state.match);
 const old=value(s.beginTask('ai','B','X')),before=stateText(s),invalid=JSON.parse(JSON.stringify(save));
 invalid.record.actions[0].point=81;assert.equal(s.loadSave('LOAD',invalid).ok,false);assert.equal(stateText(s),before);
 value(s.loadSave('LOAD',save));assert.equal(s.state.matchId,'LOAD');assert.equal(s.state.match.state.ply,1);
 assert.equal(s.state.hintsEnabled,false);error(s.commitAIResult(old,{kind:'pass',actor:'B'}),'STALE_TASK');
 assert.equal(fingerprint(s.state.match),expected);
});

test('off-turn resignation works during AI thinking or pending consent and wins terminal race',()=>{
 const s=session({controllers:{A:HUMAN,B:AI}});place(s,'A','E5');const task=value(s.beginTask('ai','B','X'));
 value(s.submit('A',{kind:'resign',actor:'A'}));assert.equal(s.state.match.state.ply,1);
 assert.equal(s.state.match.state.outcome.winner,'B');error(s.commitAIResult(task,{kind:'pass',actor:'B'}),'STALE_TASK');
 const pvp=session();place(pvp,'A','E5');value(pvp.requestUndo('A'));
 value(pvp.submit('B',{kind:'resign',actor:'B'}));assert.equal(pvp.state.match.state.outcome.winner,'A');assert.equal(pvp.state.consent,null);
 error(pvp.requestUndo('A'),'FINISHED');
});

test('closing a session rejects stale work and further state changes',()=>{
 const s=session({controllers:{A:AI,B:HUMAN}}),t=value(s.beginTask('ai','A','X'));
 s.close();assert.equal(s.state.closed,true);error(s.commitAIResult(t,{kind:'pass',actor:'A'}),'STALE_TASK');
 error(s.newGame('N'),'CLOSED');error(s.submit('B',{kind:'resign',actor:'B'}),'CLOSED');
 const revision=s.state.revision;s.close();assert.equal(s.state.revision,revision);
});
