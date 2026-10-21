import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {runSearch as current,AI_PROFILES,validateSearchReply} from '../dist/ai/src/index.js';
import {createMatch,applyAction,activePlayer,exportRecord,formatPoint,replayRecord,DEFAULT_RULES} from '../dist/core/src/index.js';
import {beginAITurn} from '../dist/ai/src/index.js';
import {createSession} from '../dist/session/src/index.js';
import {platform,release,cpus} from 'node:os';

// A separate checkout/snapshot must contain the unchanged compiled/{ai,core,session}.
const baselineRoot=process.argv[2];
if(!baselineRoot)throw Error('Usage: node scripts/benchmark-ai-strength.mjs <baseline-root> [report-path]');
const {runSearch:baseline}=await import(pathToFileURL(resolve(baselineRoot,'compiled/ai/src/search.js')).href);
const reportPath=process.argv[3]??'reports/ai-p5-7-strength.json';
const value=r=>{assert.equal(r.ok,true,JSON.stringify(r));return r.value;};
const controllers={A:{kind:'ai',level:'standard',seed:37},B:{kind:'human'}};
const template=value(beginAITurn(value(createSession({matchId:'strength-benchmark',rules:{...DEFAULT_RULES,swap3:false},controllers})))).request;
const request=(m,seed,budget)=>({...template,context:{...template.context,actor:activePlayer(m)},record:exportRecord(m),seed,budget});
const clock={now:()=>0},games=[];
const conditions={boardSize:9,swap3:true,directions:['diagonal','four'],delays:[0,4],seeds:[17,83,941],maxNodes:2000,maxDepth:6,timeMs:10000,maxCommands:100,clock:'fixed zero; node/depth limited',roles:'each seed/configuration alternates the improved player A/B'};
for(const seed of conditions.seeds)for(const directions of conditions.directions)for(const confirmationDelay of conditions.delays)for(const improvedActor of ['A','B']){
 let match=value(createMatch({...DEFAULT_RULES,boardSize:9,swap3:true,directions,confirmationDelay}));const moves=[];
 for(let turn=0;turn<conditions.maxCommands&&!match.state.outcome;turn++){
  const actor=activePlayer(match),req=request(match,seed,{timeMs:10000,maxNodes:conditions.maxNodes,maxDepth:conditions.maxDepth});
  const result=value((actor===improvedActor?current:baseline)(req,clock));value(validateSearchReply(req,result.reply));
  assert.ok('action' in result.reply,'a real game requires a move');
  moves.push({actor,action:result.reply.action,depth:result.reply.stats.completedDepth,nodes:result.reply.stats.nodes});
  match=value(applyAction(match,result.reply.action)).match;
 }
 // An unfinished game is never adjudicated using either engine's own heuristic.
 const game={seed,directions,confirmationDelay,improvedActor,outcome:match.state.outcome,plies:match.state.ply,record:exportRecord(match),moves};
 const replay=value(replayRecord(game.record));assert.deepEqual(replay.state,match.state);
 games.push(game);console.log(JSON.stringify({seed,directions,confirmationDelay,improvedActor,outcome:game.outcome,plies:game.plies}));
}
const summary={games:games.length,wins:games.filter(g=>g.outcome?.kind==='win'&&g.outcome.winner===g.improvedActor).length,losses:games.filter(g=>g.outcome?.kind==='win'&&g.outcome.winner!==g.improvedActor).length,draws:games.filter(g=>g.outcome?.kind==='draw').length,unfinished:games.filter(g=>!g.outcome).length};
const timings=[];
for(const boardSize of [9,19])for(const level of ['easy','standard'])for(const phase of ['empty','threat']){
 let match=value(createMatch({...DEFAULT_RULES,boardSize,swap3:false,confirmationDelay:0}));
 if(phase==='threat')for(const point of [0,10,2,20,4,30])match=value(applyAction(match,{kind:'place',actor:activePlayer(match),point})).match;
 for(const [engine,search]of [['baseline',baseline],['improved',current]]){
  const req={...request(match,37,AI_PROFILES[level]),level},start=performance.now(),result=value(search(req));
  value(validateSearchReply(req,result.reply));
  timings.push({boardSize,level,phase,engine,wallMs:Math.round(performance.now()-start),stats:result.reply.stats,status:result.reply.status,action:'action'in result.reply?result.reply.action:null});
 }
}
const report={stage:'P5.7',version:JSON.parse(readFileSync('package.json','utf8')).version,baselineCommit:'59b3bcabf14d45f66579696fb819de85590ac067',baselineSearchSHA256:createHash('sha256').update(readFileSync(join(baselineRoot,'compiled/ai/src/search.js'))).digest('hex'),environment:{os:platform(),release:release(),node:process.version,cpu:cpus()[0]?.model},conditions,summary,timings,games,limits:'Small deterministic regression comparison, not a general win-rate estimate or fairness proof; wall-clock samples depend on this host. Historical 0.5.6 Windows package is unchanged.'};
writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({summary,report:reportPath}));
