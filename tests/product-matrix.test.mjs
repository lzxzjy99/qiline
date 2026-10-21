import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {allRuleConfigurations,configIdOf,activePlayer,applyAction,undoLastCommand} from '../dist/core/src/index.js';
import {runSearch,validateSearchReply} from '../dist/ai/src/index.js';
import {createGameSession,practiceView,undoPracticePair,makeWebSave,parseWebSave,playerName} from '../dist/ui/model.mjs';
import {createRecoveringAI} from '../dist/ui/ai-recovery.mjs';
import {VirtualHost,FakeWorker} from './worker-fakes.mjs';
import {value,fingerprint} from './helpers.mjs';

// Product adapters and recovery use their actual code. Worker ports and scheduling
// clocks are deterministic substitutes; search really runs, capped at 48/96 nodes.
// This is not a matrix of native threads, complete games, or strength measurements.
const results=[];
const phase=process.env.QILINE_MATRIX_PHASE??'P5.6';
assert.ok(['P5.6','P5.7'].includes(phase));
after(()=>{
  const sum=key=>results.reduce((total,row)=>total+(row[key]??0),0);
  writeFileSync(new URL(`../reports/product-${phase.toLowerCase().replace('.','-')}-matrix.json`,import.meta.url),JSON.stringify({
    phase,rulesVersion:'2.1.0-r3',configurations:448,aiRoles:2,levels:2,expected:1792,
    coverage:'Product create/restore/save/pair-undo adapters, bounded recovery and original task authority with virtual Worker ports and clock; actual bounded runSearch, not full games or platform execution.',
    searchBudget:{easy:{maxNodes:48,maxDepth:2},standard:{maxNodes:96,maxDepth:4},clock:'fixed zero inside search; virtual monotonic scheduling outside search'},
    passed:results.filter(row=>row.status==='passed').length,
    failed:results.filter(row=>row.status==='failed').length,
    actualSearchCalls:sum('searchCalls'),acceptedSearchReplies:sum('acceptedReplies'),
    staleCallbacksRejected:sum('staleCallbacks'),injectedFailures:sum('failures'),results,
  },null,2)+'\n');
});

class SearchingPort extends FakeWorker {
  constructor(level,counters){super();this.level=level;this.counters=counters;this.skipSearch=false;this.searched=null;}
  postMessage(request){
    super.postMessage(request);
    if(this.skipSearch)return;
    const budget={...request.budget,maxNodes:this.level==='easy'?48:96};
    this.searched=value(runSearch({...structuredClone(request),budget},{now:()=>0}));
    this.counters.searchCalls++;
    value(validateSearchReply(request,this.searched.reply));
    assert.ok(this.searched.reply.stats.nodes<=budget.maxNodes);
    assert.ok(this.searched.reply.stats.completedDepth<=budget.maxDepth);
    assert.ok(this.searched.details.maxVisitedDepth<=budget.maxDepth);
    assert.ok(['move','timeout'].includes(this.searched.reply.status),JSON.stringify(this.searched));
  }
  complete(){assert.ok(this.searched);this.emit(structuredClone(this.searched.reply));}
}
function fixture(session,level,counters){
  const clock=new VirtualHost();clock.factory=()=>new SearchingPort(level,counters);
  const driver=value(createRecoveringAI(session,clock.host));
  return {session,level,counters,clock,driver};
}
function humanAction(f){
  const match=f.session.state.match,actor=activePlayer(match);
  assert.equal(f.session.state.controllers[actor].kind,'human');
  let action;
  if(match.state.phase.kind==='choose')action={kind:'choose-color',actor,color:'white'};
  else for(let point=0;point<match.state.board.length;point++){
    if(match.state.board[point]!==0)continue;
    const proposal={kind:'place',actor,point};
    if(applyAction(match,proposal).ok){action=proposal;break;}
  }
  assert.ok(action,'a safe legal human command exists in these short positions');
  value(f.driver.change(()=>f.session.submit(actor,action)));return action;
}
function currentPort(f){
  f.clock.tick();const worker=f.clock.workers.at(-1);assert.ok(worker);assert.equal(worker.terminated,0);
  return worker;
}
function searchTurn(f,aiActor,seed){
  const before=f.session.state.match,worker=currentPort(f);worker.ready();
  const request=worker.sent[0];assert.equal(request.context.actor,aiActor);
  assert.equal(request.level,f.level);assert.equal(request.seed,seed);
  assert.equal(applyAction(before,worker.searched.reply.action).ok,true);
  worker.complete();assert.notEqual(f.session.state.match,before);assert.equal(worker.terminated,1);
  assert.equal(worker.onmessage,null);f.counters.acceptedReplies++;return worker;
}
function failTransient(f,worker){
  f.counters.failures++;
  if(f.level==='easy'){
    // A faithful no-action protocol reply, rather than an invented pass or resignation.
    worker.skipSearch=true;worker.ready();
    worker.emit({protocolVersion:1,kind:'result',context:worker.sent[0].context,status:'failed',reason:'no-action',
      stats:{elapsedMs:worker.sent[0].budget.timeMs,nodes:0,completedDepth:0}});
  }else worker.onerror({});
  assert.equal(worker.terminated,1);assert.equal(worker.onmessage,null);
}
function rejectOld(f,callback,message){
  const before=f.session.state;callback({data:message});assert.equal(f.session.state,before);f.counters.staleCallbacks++;
}
function cleanup(f){
  if(!f)return;f.driver.close();assert.equal(f.clock.timers.size,0);
  assert.equal(f.session.state.closed,true);assert.equal(f.session.state.task,null);
  assert.ok(f.clock.workers.every(worker=>worker.terminated===1));
}

for(const cfg of allRuleConfigurations())for(const aiActor of ['A','B'])for(const level of ['easy','standard'])
test(`product pipeline ${configIdOf(cfg)} AI=${aiActor} ${level}`,()=>{
  const row={configId:configIdOf(cfg),aiActor,level,status:'failed',searchCalls:0,acceptedReplies:0,staleCallbacks:0,failures:0};
  const humanActor=aiActor==='A'?'B':'A',seed=level==='easy'?0:0xffffffff;
  const players={names:['林同学','弈合 AI'],aIndex:humanActor==='A'?0:1,round:6};
  let f,restoredFixture;
  try{
    const session=value(createGameSession({matchId:`product-${row.configId}-${aiActor}-${level}`,rules:cfg,
      mode:'practice',humanActor,level,seed,competitive:false}));
    assert.deepEqual(practiceView(session),{humanActor,aiActor,level,seed});
    f=fixture(session,level,row);value(f.driver.start());
    if(aiActor==='B'){
      if(cfg.swap3)for(let i=0;i<3;i++)humanAction(f);else humanAction(f);
    }
    const checkpoint=session.state.match,initialFingerprint=fingerprint(checkpoint);
    let worker=currentPort(f);const originalCallback=worker.onmessage;
    failTransient(f,worker);assert.equal(f.driver.state.status,'retrying');assert.equal(f.driver.state.retryAttempt,1);
    assert.equal(fingerprint(session.state.match),initialFingerprint);
    const abandonedRetry=[...f.clock.timers.values()][0].callback;
    f.clock.tick(249);assert.equal(f.clock.workers.length,1);
    value(f.driver.pause());assert.equal(f.driver.state.status,'paused');assert.equal(f.clock.timers.size,0);
    abandonedRetry();f.clock.tick(1000);assert.equal(f.clock.workers.length,1);
    assert.equal(session.state.match,checkpoint);

    // Explicit resume grants a fresh three-attempt cycle on the same position.
    value(f.driver.resume());worker=currentPort(f);failTransient(f,worker);
    assert.equal(f.driver.state.status,'retrying');f.clock.tick(249);assert.equal(f.clock.workers.length,2);
    f.clock.tick(1);worker=f.clock.workers.at(-1);failTransient(f,worker);
    assert.equal(f.driver.state.retryAttempt,2);f.clock.tick(749);assert.equal(f.clock.workers.length,3);
    f.clock.tick(1);worker=f.clock.workers.at(-1);failTransient(f,worker);
    assert.equal(f.driver.state.status,'failed');assert.equal(f.clock.timers.size,0);
    assert.equal(f.driver.state.error.code,level==='easy'?'AI_NO_RESULT':'AI_WORKER_FAILED');
    f.clock.tick(10000);assert.equal(f.clock.workers.length,4);assert.equal(session.state.match,checkpoint);

    value(f.driver.retry());worker=currentPort(f);worker.ready();
    rejectOld(f,originalCallback,structuredClone(worker.searched.reply));
    worker.complete();row.acceptedReplies++;assert.equal(f.driver.state.retryAttempt,0);
    if(aiActor==='A'&&cfg.swap3){
      // A remains the real actor for all three opening commands. Undo the first two
      // while the third is in flight, exercising the AI hold through the product host.
      assert.equal(activePlayer(session.state.match),'A');searchTurn(f,aiActor,seed);
    }else if(aiActor==='B'&&cfg.swap3){
      // Search really chooses the color. Black gives the human White's next command;
      // choosing White keeps B active immediately. Both paths reach a real AI placement.
      if(activePlayer(session.state.match)!==aiActor)humanAction(f);
      searchTurn(f,aiActor,seed);assert.equal(session.state.match.state.phase.kind,'playing');
      humanAction(f);
    }else humanAction(f);
    assert.equal(activePlayer(session.state.match),aiActor);
    assert.ok(session.state.match.accepted.length>=2);
    const beforeUndo=session.state.match;
    const expected=value(undoLastCommand(value(undoLastCommand(beforeUndo))));
    worker=currentPort(f);worker.ready();const lateCallback=worker.onmessage,lateReply=structuredClone(worker.searched.reply);
    const countBefore=f.clock.workers.length;
    value(f.driver.change(()=>undoPracticePair(session)));
    assert.equal(session.state.match,expected);assert.equal(beforeUndo.accepted.length-expected.accepted.length,2);
    assert.equal(session.state.paused,true);assert.equal(f.driver.state.hold,'undo');
    assert.equal(f.driver.state.status,'paused');assert.equal(worker.terminated,1);assert.equal(f.clock.timers.size,0);
    rejectOld(f,lateCallback,lateReply);f.clock.tick(10000);assert.equal(f.clock.workers.length,countBefore);

    // Persist only the immutable record/settings. Pending tasks, retry history and
    // permission handles never cross the web wrapper or Session instance boundary.
    const saved=makeWebSave(session,players,`p5-6-${row.configId}-${aiActor}-${level}`);
    const restored=value(parseWebSave(JSON.stringify(saved),`restore-${row.configId}-${aiActor}-${level}`));
    assert.equal(restored.mode,'practice');assert.deepEqual(restored.players,players);
    assert.equal(fingerprint(restored.session.state.match),fingerprint(expected));
    assert.deepEqual(restored.session.exportSave(),session.exportSave());
    assert.deepEqual(practiceView(restored.session),{humanActor,aiActor,level,seed});
    assert.equal(playerName(restored.players,humanActor),'林同学');assert.equal(playerName(restored.players,aiActor),'弈合 AI');
    assert.equal(restored.session.state.paused,false);assert.equal(restored.session.state.task,null);
    assert.equal(restored.session.state.consent,null);assert.equal(restored.session.state.hintsEnabled,false);
    cleanup(f);
    restoredFixture=fixture(restored.session,level,row);
    value(restoredFixture.driver.pause());value(restoredFixture.driver.start());restoredFixture.clock.tick(10000);
    assert.equal(restoredFixture.clock.workers.length,0,'restored product session waits for explicit continue');
    value(restoredFixture.driver.resume());const fresh=currentPort(restoredFixture);fresh.ready();
    assert.notEqual(fresh.sent[0].context.requestId,worker.sent[0].context.requestId);
    rejectOld(restoredFixture,lateCallback,lateReply);
    fresh.complete();row.acceptedReplies++;
    assert.equal(restoredFixture.driver.state.retryAttempt,0);assert.notEqual(fingerprint(restored.session.state.match),fingerprint(expected));
    assert.equal(session.state.match,expected,'closing/reloading never lets old callbacks edit the source history');
    cleanup(restoredFixture);row.status='passed';
  }catch(error){row.error=error.message;throw error;}
  finally{
    if(f&&!f.session.state.closed)cleanup(f);
    if(restoredFixture&&!restoredFixture.session.state.closed)cleanup(restoredFixture);
    results.push(row);
  }
});
