import assert from 'node:assert/strict';
import {writeFileSync,readFileSync} from 'node:fs';
import {runSearch,validateSearchReply,AI_PROFILES} from '../dist/ai/src/index.js';
import {createMatch,applyAction,activePlayer,exportRecord,replayRecord,DEFAULT_RULES} from '../dist/core/src/index.js';
const value=r=>{assert.equal(r.ok,true,JSON.stringify(r));return r.value;};
const quick=process.argv.includes('--quick');
const holdout=process.argv.includes('--holdout');
const conditions={boardSize:9,swap3:true,seeds:quick?[37]:holdout?[101,271,809]:[17,83,941],directions:['diagonal','four'],delays:[0,4],
  budgets:{standard:{timeMs:10000,maxNodes:1200,maxDepth:6},hard:{timeMs:10000,maxNodes:12000,maxDepth:12}},
  maxCommands:100,clock:'fixed zero; scaled node-limited comparison; not production wall-clock games',roles:'hard alternates A/B for every seed/configuration'};
const games=[];
for(const seed of conditions.seeds)for(const directions of conditions.directions)for(const confirmationDelay of conditions.delays)for(const hardActor of ['A','B']){
 let match=value(createMatch({...DEFAULT_RULES,boardSize:9,swap3:true,directions,confirmationDelay}));const moves=[];
 for(let i=0;i<conditions.maxCommands&&!match.state.outcome;i++){
  const actor=activePlayer(match),level=actor===hardActor?'hard':'standard';
  const request={protocolVersion:1,kind:'search',context:{requestId:`g${games.length}-r${i}`,matchId:`g${games.length}`,revision:i,taskId:`t${i}`,actor},level,seed,record:exportRecord(match),budget:conditions.budgets[level]};
  const result=value(runSearch(request,{now:()=>0}));value(validateSearchReply(request,result.reply));
  assert.ok('action'in result.reply,'no result');
  moves.push({level,actor,action:result.reply.action,stats:result.reply.stats,maxVisitedDepth:result.details.maxVisitedDepth});
  match=value(applyAction(match,result.reply.action)).match;
 }
 const record=exportRecord(match);assert.deepEqual(value(replayRecord(record)).state,match.state);
 const game={seed,directions,confirmationDelay,hardActor,outcome:match.state.outcome,plies:match.state.ply,record,moves};games.push(game);
 console.log(JSON.stringify({seed,directions,confirmationDelay,hardActor,outcome:game.outcome,plies:game.plies}));
}
const summary={games:games.length,hardWins:games.filter(g=>g.outcome?.kind==='win'&&g.outcome.winner===g.hardActor).length,standardWins:games.filter(g=>g.outcome?.kind==='win'&&g.outcome.winner!==g.hardActor).length,draws:games.filter(g=>g.outcome?.kind==='draw').length,unfinished:games.filter(g=>!g.outcome).length};
const report={stage:'P5.8',version:JSON.parse(readFileSync('package.json','utf8')).version,conditions,productionProfiles:AI_PROFILES,summary,games,limits:'Small deterministic regression sample at scaled node budgets, not a general win-rate/strength guarantee or full platform test.'};
const path=quick?'build/hard-quick.json':holdout?'reports/ai-p5-8-hard-holdout.json':'reports/ai-p5-8-hard-strength.json';writeFileSync(path,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({summary,report:path}));
