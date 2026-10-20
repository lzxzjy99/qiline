import test from 'node:test';
import assert from 'node:assert/strict';
import {activePlayer,exportRecord,DEFAULT_RULES} from '../dist/core/src/index.js';
import {createSession} from '../dist/session/src/index.js';
import {beginAITurn} from '../dist/ai/src/index.js';
import {createGameSession,practiceView,makeWebSave,parseWebSave,playerName,errorText} from '../dist/ui/model.mjs';
import {command,reply} from './ai-helpers.mjs';

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
    {matchId:'x',mode:'practice',level:'hard'}, {matchId:'x',mode:'practice',seed:-1},
    {matchId:'x',mode:'practice',seed:0x100000000},{matchId:'x',mode:'practice',competitive:'false'},
    {matchId:'x',mode:'practice',extra:true}];
  for(const input of invalid)assert.equal(createGameSession(input).ok,false,JSON.stringify(input));
  assert.equal(createGameSession({matchId:'x',mode:'practice',competitive:true}).error.code,'AI_MODE_UNSUPPORTED');
  const save=create().exportSave();
  for(const controllers of [{A:{kind:'human'},B:{kind:'ai',level:'hard',seed:1}},
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
