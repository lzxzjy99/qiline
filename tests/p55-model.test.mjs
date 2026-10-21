import test from 'node:test';
import assert from 'node:assert/strict';
import {activePlayer,exportRecord,DEFAULT_RULES} from '../dist/core/src/index.js';
import {createSession} from '../dist/session/src/index.js';
import {beginAITurn} from '../dist/ai/src/index.js';
import {createGameSession,practiceView,undoPracticePair,respondUndoPair,makeWebSave,parseWebSave,playerName,errorText} from '../dist/ui/model.mjs';
import {command,reply} from './ai-helpers.mjs';
import {workerFixture} from './worker-fakes.mjs';
import {fingerprint} from './helpers.mjs';

const value=result=>{assert.equal(result.ok,true,JSON.stringify(result));return result.value;};
const create=(patch={})=>value(createGameSession({matchId:'practice',mode:'practice',...patch}));
const act=(session,kind,fields={})=>command(session,{kind,actor:activePlayer(session.state.match),...fields});
const metadata=humanActor=>({names:['林同学','弈合 AI'],aIndex:humanActor==='A'?0:1,round:3});

for(const humanActor of ['A','B'])for(const level of ['easy','standard'])for(const swap3 of [false,true]) {
  test(`practice ${humanActor}/${level}/swap3=${swap3} keeps identity through play and wrapped restore`,()=>{
    const original=create({humanActor,level,seed:0xffffffff,rules:{...DEFAULT_RULES,swap3}});
    const aiActor=humanActor==='A'?'B':'A',players=metadata(humanActor);
    assert.deepEqual(practiceView(original),{humanActor,aiActor,level,seed:0xffffffff});
    assert.equal(original.state.controllers[humanActor].kind,'human');
    assert.equal(original.state.controllers[aiActor].kind,'ai');
    act(original,'place',{point:30});
    if(swap3){
      act(original,'place',{point:40});act(original,'place',{point:50});
      assert.equal(activePlayer(original.state.match),'B');
      act(original,'choose-color',{color:'white'});
      assert.equal(activePlayer(original.state.match),'B','B chooses white and acts again');
    }
    act(original,'place',{point:0});
    const saved=makeWebSave(original,players,'snapshot-3');
    assert.equal(saved.webSchemaVersion,1);assert.equal(saved.session.sessionSchemaVersion,1);
    const restored=value(parseWebSave(JSON.stringify(saved),'restored'));
    assert.equal(restored.mode,'practice');assert.deepEqual(restored.players,players);
    assert.deepEqual(restored.session.state.match.state,original.state.match.state);
    assert.deepEqual(restored.session.exportSave(),original.exportSave());
    assert.deepEqual(practiceView(restored.session),{humanActor,aiActor,level,seed:0xffffffff});
    assert.equal(playerName(restored.players,humanActor),'林同学');
    assert.equal(playerName(restored.players,aiActor),'弈合 AI');
    assert.equal(restored.session.state.task,null);assert.equal(restored.session.state.paused,false);
  });
}

test('new-game adapter keeps dual-human and competitive dual-human games available',()=>{
  for(const competitive of [false,true]) {
    const session=value(createGameSession({matchId:'pvp',competitive}));
    assert.equal(practiceView(session),null);assert.equal(session.state.competitive,competitive);
    assert.deepEqual(session.state.controllers,{A:{kind:'human'},B:{kind:'human'}});
    const restored=value(parseWebSave(session.exportSave(),'restored'));
    assert.equal(restored.mode,'pvp');assert.equal(restored.session.state.competitive,competitive);
    assert.deepEqual(restored.players,{names:['玩家A','玩家B'],aIndex:0,round:1});
  }
  assert.equal(practiceView(null),null);
});

test('bare practice SessionSave has names mapped to human identity rather than color',()=>{
  for(const humanActor of ['A','B']) {
    const original=create({humanActor});
    const restored=value(parseWebSave(original.exportSave(),'restored'));
    assert.equal(restored.mode,'practice');
    assert.equal(playerName(restored.players,humanActor),'玩家');
    assert.equal(playerName(restored.players,humanActor==='A'?'B':'A'),'弈合 AI');
  }
});

test('raw MatchRecord discards AI settings and restores as two humans',()=>{
  const original=create({humanActor:'B',rules:{...DEFAULT_RULES,swap3:false}});
  act(original,'place',{point:40});
  const restored=value(parseWebSave(JSON.stringify(exportRecord(original.state.match)),'record'));
  assert.equal(restored.mode,'pvp');assert.equal(practiceView(restored.session),null);
  assert.deepEqual(restored.session.state.controllers,{A:{kind:'human'},B:{kind:'human'}});
  assert.deepEqual(restored.session.state.match.state,original.state.match.state);
});

test('restoring during AI calculation removes runtime authority and paused status',()=>{
  const original=create({humanActor:'B',rules:{...DEFAULT_RULES,swap3:false}});
  const oldTurn=value(beginAITurn(original));
  value(original.setPaused(true));
  const restored=value(parseWebSave(makeWebSave(original,metadata('B'),'during-search'),'new-instance')).session;
  assert.equal(restored.state.task,null);assert.equal(restored.state.paused,false);
  assert.equal(restored.state.consent,null);assert.equal(restored.state.hintsEnabled,false);
  assert.equal(oldTurn.isCurrent,false);
  const fresh=value(beginAITurn(restored));
  assert.notEqual(fresh.request.context.requestId,oldTurn.request.context.requestId);
  assert.equal(fresh.accept(reply(oldTurn,{kind:'place',actor:'A',point:40})).ok,false);
  assert.equal(restored.state.match.state.placements,0);
  value(fresh.accept(reply(fresh,{kind:'place',actor:'A',point:40})));
  assert.equal(restored.state.match.state.placements,1);
});

test('legacy web wrapper keeps human names and A/B mapping while accepting valid AI save',()=>{
  const original=create({humanActor:'B',level:'easy',seed:17});
  const saved=makeWebSave(original,metadata('B'),'legacy');
  const restored=value(parseWebSave(saved,'restored'));
  assert.deepEqual(restored.players,metadata('B'));
  assert.equal(playerName(restored.players,'A'),'弈合 AI');
  assert.equal(playerName(restored.players,'B'),'林同学');
  assert.equal(restored.session.state.controllers.A.level,'easy');
});

test('competitive AI and double-AI saves are rejected in bare and wrapped formats',()=>{
  const original=create(),save=original.exportSave();
  const badSaves=[{...save,competitive:true},{...save,controllers:{
    A:{kind:'ai',level:'easy',seed:1},B:{kind:'ai',level:'standard',seed:2}
  }}];
  for(const bad of badSaves)for(const input of [bad,{webSchemaVersion:1,snapshotId:'x',players:metadata('A'),session:bad}]){
    const restored=parseWebSave(input,'rejected');
    assert.equal(restored.ok,false);assert.equal(restored.error.code,'AI_MODE_UNSUPPORTED');
  }
  assert.deepEqual(original.exportSave(),save,'rejected imports do not alter existing game');
});

test('practice options and damaged controllers are validated before creating a playable game',()=>{
  const invalid=[null,{}, {matchId:'x',mode:'network'}, {matchId:'x',mode:'practice',humanActor:'black'},
    {matchId:'x',mode:'practice',level:'expert'}, {matchId:'x',mode:'practice',seed:-1},
    {matchId:'x',mode:'practice',seed:0x100000000},{matchId:'x',mode:'practice',competitive:'false'},
    {matchId:'x',mode:'practice',extra:true}];
  for(const input of invalid)assert.equal(createGameSession(input).ok,false,JSON.stringify(input));
  assert.equal(createGameSession({matchId:'x',mode:'practice',competitive:true}).error.code,'AI_MODE_UNSUPPORTED');
  const save=create().exportSave();
  for(const controllers of [{A:{kind:'human'},B:{kind:'ai',level:'expert',seed:1}},
    {A:{kind:'human'},B:{kind:'ai',level:'easy',seed:1,paused:true}}]){
    assert.equal(parseWebSave({...save,controllers},'invalid').ok,false);
  }
});

test('practice errors describe paused or unsupported state with a recovery action',()=>{
  assert.match(errorText({code:'AI_MODE_UNSUPPORTED'}),/非竞技.*双 AI/);
  assert.match(errorText({code:'AI_WORKER_FAILED'}),/暂停.*重试/);
  assert.match(errorText({code:'AI_NO_RESULT'}),/超时.*重试/);
  assert.match(errorText({code:'AI_CANCELLED'}),/继续 AI/);
});

test('direct session API still rejects non-human submission in practice mode',()=>{
  const session=create({humanActor:'B',rules:{...DEFAULT_RULES,swap3:false}});
  const before=session.state.match;
  assert.equal(session.submit('A',{kind:'place',actor:'A',point:40}).error.code,'WRONG_ACTOR');
  assert.equal(session.state.match,before);
  // The shared UI adapter does not introduce an alternative rules or permission path.
  const pvp=value(createSession({matchId:'existing'}));
  assert.equal(value(parseWebSave(pvp.exportSave(),'old')).mode,'pvp');
});

for(const humanActor of ['A','B']) {
  test(`paired practice undo by fixed human ${humanActor} withdraws both explicit commands`,()=>{
    const session=create({humanActor,rules:{...DEFAULT_RULES,swap3:false}}),initial=session.state.match;
    act(session,'place',{point:40});act(session,'place',{point:0});
    const before=session.state;
    assert.equal(value(undoPracticePair(session)),session.state);
    assert.equal(session.state.match,initial);assert.equal(session.state.match.accepted.length,0);
    assert.equal(session.state.revision,before.revision+2);
    assert.equal(session.state.consent,null);assert.equal(session.state.task,null);
    assert.equal(practiceView(session).humanActor,humanActor);
  });

  test(`paired practice undo by human ${humanActor} withdraws the only available command`,()=>{
    const session=create({humanActor}),initial=session.state.match;
    act(session,'place',{point:40});const before=session.state;
    value(undoPracticePair(session));assert.equal(session.state.match,initial);
    assert.equal(session.state.revision,before.revision+1);
  });

  test(`paired practice undo by human ${humanActor} counts zero-ply color choice as one command`,()=>{
    const session=create({humanActor});
    for(const point of [30,40,50])act(session,'place',{point});
    const choose=session.state.match;
    act(session,'choose-color',{color:'white'});act(session,'place',{point:0});
    const before=session.state.match;
    value(undoPracticePair(session));assert.equal(session.state.match,choose);
    assert.equal(before.accepted.length-session.state.match.accepted.length,2);
    assert.equal(before.state.ply-session.state.match.state.ply,1);
    assert.equal(session.state.match.state.phase.kind,'choose');
    act(session,'choose-color',{color:'black'});
    value(undoPracticePair(session));
    assert.equal(session.state.match.accepted.length,2);
    assert.equal(session.state.match.state.phase.kind,'opening');
    assert.equal(session.state.match.state.phase.placed,2);
  });
}

test('paired undo restores complete claim clocks, PSK history and record rather than editing the board',()=>{
  const session=create({rules:{...DEFAULT_RULES,swap3:false}});
  for(const point of [0,8,10,26,20,44,30,62,40])act(session,'place',{point});
  const before=fingerprint(session.state.match),claims=session.state.match.state.claims;
  assert.equal(claims.length,1);
  act(session,'place',{point:80});act(session,'place',{point:1});
  value(undoPracticePair(session));
  assert.equal(fingerprint(session.state.match),before);
  assert.deepEqual(session.state.match.state.claims,claims);
  assert.equal(value(parseWebSave(session.exportSave(),'after-undo')).session.state.match.state.ply,9);
});

test('one host change observes only final paired undo, terminates search and holds a restored AI turn',()=>{
  const session=create({humanActor:'A',rules:{...DEFAULT_RULES,swap3:false}});
  act(session,'place',{point:40});const target=session.state.match;
  act(session,'place',{point:0});act(session,'place',{point:1});
  const fixture=workerFixture(session),worker=fixture.start();worker.ready();
  const oldCallback=worker.onmessage,late=worker.result({kind:'place',actor:'B',point:2});
  const observed=[];fixture.clock.observer=()=>observed.push(session.state.match.accepted.length);
  value(fixture.driver.change(()=>undoPracticePair(session)));
  assert.equal(session.state.match,target);assert.equal(worker.terminated,1);
  assert.equal(session.state.task,null);assert.equal(session.state.paused,true);
  assert.equal(fixture.driver.state.hold,'undo');assert.equal(fixture.clock.timers.size,0);
  assert.deepEqual(observed,[1],'host never observes or schedules from the first intermediate undo');
  oldCallback({data:late});fixture.clock.tick(1000);
  assert.equal(session.state.match,target);assert.equal(fixture.clock.workers.length,1);
  fixture.driver.close();
});

test('paired undo returning to human leaves play available without requiring AI continue',()=>{
  const session=create({humanActor:'A',rules:{...DEFAULT_RULES,swap3:false}});
  act(session,'place',{point:40});act(session,'place',{point:0});
  const fixture=workerFixture(session);fixture.start();
  value(fixture.driver.change(()=>undoPracticePair(session)));
  assert.equal(activePlayer(session.state.match),'A');assert.equal(session.state.paused,false);
  assert.equal(fixture.driver.state.hold,null);assert.equal(fixture.clock.workers.length,0);
  assert.equal(fixture.clock.timers.size,0);fixture.driver.close();
});

test('paired undo gates fail without partially changing history or runtime state',()=>{
  const check=(session,code)=>{
    const before=session.state;
    const result=undoPracticePair(session);
    assert.equal(result.ok,false);assert.equal(result.error.code,code);
    assert.equal(session.state,before);
  };
  check(create(),'NO_UNDO');
  const paused=create();act(paused,'place',{point:40});value(paused.setPaused(true));check(paused,'PAUSED');
  const closed=create();act(closed,'place',{point:40});closed.close();check(closed,'CLOSED');
  const finished=create({rules:{...DEFAULT_RULES,swap3:false}});
  value(finished.submit('A',{kind:'resign',actor:'A'}));check(finished,'FINISHED');
  const pvp=value(createGameSession({matchId:'pvp'}));
  value(pvp.submit('A',{kind:'place',actor:'A',point:40}));check(pvp,'AI_MODE_UNSUPPORTED');
  for(const competitive of [false,true]) {
    const session=value(createSession({matchId:'unsupported',competitive,controllers:{
      A:{kind:'ai',level:'easy',seed:1},B:competitive?{kind:'human'}:{kind:'ai',level:'standard',seed:2}
    }}));
    check(session,competitive?'COMPETITIVE':'AI_MODE_UNSUPPORTED');
  }
  for(const invalid of [null,{}, {state:create().state}])assert.equal(undoPracticePair(invalid).error.code,'INVALID_SESSION');
});

const dual=(rules={})=>value(createGameSession({matchId:'dual',rules:{...DEFAULT_RULES,swap3:false,...rules}}));
const request=(session,actor='A')=>{value(session.requestUndo(actor));return session.state.consent;};

for(const requester of ['A','B']) {
  test(`one consent response from ${requester==='A'?'B':'A'} authorizes exactly two PvP commands`,()=>{
    const session=dual();act(session,'place',{point:40});const target=session.state.match;
    act(session,'place',{point:0});act(session,'place',{point:1});
    const consent=request(session,requester),responder=requester==='A'?'B':'A';
    assert.equal(session.state.match.accepted.length,3);
    assert.equal(value(respondUndoPair(session,responder,consent.id,true)),session.state);
    assert.equal(session.state.match,target);assert.equal(session.state.match.accepted.length,1);
    assert.equal(session.state.consent,null);assert.equal(session.state.paused,false);
  });
}

test('consented paired PvP undo falls back to the only available command',()=>{
  const session=dual(),target=session.state.match;act(session,'place',{point:40});
  const consent=request(session);
  value(respondUndoPair(session,'B',consent.id,true));
  assert.equal(session.state.match,target);assert.equal(session.state.consent,null);assert.equal(session.state.paused,false);
});

test('declining paired undo keeps both commands and clears the original consent normally',()=>{
  const session=dual();act(session,'place',{point:40});act(session,'place',{point:0});
  const target=session.state.match,consent=request(session);
  value(respondUndoPair(session,'B',consent.id,false));
  assert.equal(session.state.match,target);assert.equal(session.state.match.accepted.length,2);
  assert.equal(session.state.consent,null);assert.equal(session.state.paused,false);
});

test('paired consent refuses wrong responder and stale or competing requests without changing state',()=>{
  const session=dual();act(session,'place',{point:40});act(session,'place',{point:0});
  const old=request(session),original=session.state;
  for(const [responder,id,accept,code] of [['A',old.id,true,'WRONG_ACTOR'],['C',old.id,true,'WRONG_ACTOR'],
    ['B','wrong',true,'STALE_REQUEST'],['B',old.id,'yes','WRONG_ACTOR']]) {
    const result=respondUndoPair(session,responder,id,accept);
    assert.equal(result.ok,false);assert.equal(result.error.code,code);assert.equal(session.state,original);
  }
  value(respondUndoPair(session,'B',old.id,false));
  const competing=request(session,'B'),pending=session.state;
  assert.notEqual(competing.id,old.id);
  assert.equal(respondUndoPair(session,'A',old.id,true).error.code,'STALE_REQUEST');
  assert.equal(session.state,pending);assert.equal(session.state.consent,competing);
  value(respondUndoPair(session,'A',competing.id,true));assert.equal(session.state.match.accepted.length,0);
});

test('consented pair counts zero-ply color choice and restores its complete previous opening state',()=>{
  const session=dual({swap3:true});act(session,'place',{point:30});act(session,'place',{point:40});
  const target=session.state.match;
  act(session,'place',{point:50});act(session,'choose-color',{color:'white'});
  const before=session.state.match,consent=request(session);
  value(respondUndoPair(session,'B',consent.id,true));
  assert.equal(session.state.match,target);
  assert.equal(before.accepted.length-session.state.match.accepted.length,2);
  assert.equal(before.state.ply-session.state.match.state.ply,1);
  assert.equal(session.state.match.state.phase.kind,'opening');assert.equal(session.state.match.state.phase.placed,2);
});

test('opening cancellation consent delegates unchanged and never triggers a second undo',()=>{
  for(const accept of [false,true]) {
    const session=dual({swap3:true});act(session,'place',{point:40});
    const target=session.state.match;value(session.requestCancelOpening('A'));const consent=session.state.consent;
    value(respondUndoPair(session,'B',consent.id,accept));
    assert.equal(session.state.consent,null);
    if(accept){assert.equal(session.state.match.state.outcome.kind,'cancelled');assert.equal(session.state.match.accepted.length,2);}
    else assert.equal(session.state.match,target);
  }
});

test('paired response preserves closed, no-consent and invalid-session rejection contracts',()=>{
  assert.equal(respondUndoPair(null,'B','x',true).error.code,'INVALID_SESSION');
  const session=dual();assert.equal(respondUndoPair(session,'B','x',true).error.code,'STALE_REQUEST');
  act(session,'place',{point:40});const consent=request(session);session.close();const before=session.state;
  assert.equal(respondUndoPair(session,'B',consent.id,true).error.code,'CLOSED');assert.equal(session.state,before);
});
