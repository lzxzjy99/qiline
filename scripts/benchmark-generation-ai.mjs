import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';
import {createHash} from 'node:crypto';
import {preparePredecessor,predecessorRoot,PREDECESSOR_COMMIT} from './prepare-ai-predecessor.mjs';
const value=r=>{assert.equal(r.ok,true,JSON.stringify(r));return r.value;};
const plan=JSON.parse(readFileSync(new URL('../benchmarks/generation-plan.json',import.meta.url)));
if(!isMainThread){
 const candidate=await import(pathToFileURL(resolve(workerData.candidate,'ai/src/index.js')));
 const previous=await import(pathToFileURL(resolve(predecessorRoot,'ai/src/index.js')));
 const core=await import(new URL('../dist/core/src/index.js',import.meta.url));
 const {game,scale,realClock,timeScale}=workerData;
 let match=value(core.createMatch({...core.DEFAULT_RULES,boardSize:game.boardSize,swap3:plan.swap3,directions:game.directions,confirmationDelay:game.confirmationDelay,claimMode:game.claimMode}));
 const moves=[],started=performance.now();
 for(let command=0;command<plan.maxCommands&&!match.state.outcome;command++){
  const actor=core.activePlayer(match),isCandidate=actor===game.candidateActor,engine=isCandidate?candidate:previous;
  const profile=engine.AI_PROFILES.hard,budget=realClock?{...profile,timeMs:Math.max(1,Math.round(profile.timeMs*timeScale))}:{...profile,timeMs:30000,maxNodes:Math.max(48,Math.round(profile.maxNodes*scale))};
  const request={protocolVersion:1,kind:'search',context:{requestId:`g${game.id}-r${command}`,matchId:`g${game.id}`,revision:command,taskId:`t${command}`,actor},level:'hard',seed:game.seed,record:core.exportRecord(match),budget};
  // The old boundary remains its historical 10-second validation limit even in scaled trials.
  if(!isCandidate&&budget.timeMs>10000)budget.timeMs=10000;
  const r=value(engine.runSearch(request,realClock?{}:{now:()=>0}));value(engine.validateSearchReply(request,r.reply));
  assert.ok('action'in r.reply,JSON.stringify(r));assert.ok(r.reply.stats.nodes<=budget.maxNodes);assert.ok(r.details.maxVisitedDepth<=budget.maxDepth);
  moves.push({generation:isCandidate?'candidate':'predecessor',action:r.reply.action,stats:r.reply.stats,maxVisitedDepth:r.details.maxVisitedDepth});
  match=value(core.applyAction(match,r.reply.action)).match;
  parentPort.postMessage({progress:{id:game.id,command:command+1,generation:isCandidate?'candidate':'predecessor',stats:r.reply.stats,wallMs:performance.now()-started}});
 }
 const record=core.exportRecord(match);assert.deepEqual(value(core.replayRecord(record)).state,match.state);
 parentPort.postMessage({...game,outcome:match.state.outcome,plies:match.state.ply,commands:record.actions.length,moves,record,wallMs:performance.now()-started});
}else{
 const predecessor=await preparePredecessor();
 const args=process.argv.slice(2),arg=(name,fallback)=>{const i=args.indexOf(name);return i<0?fallback:args[i+1];};
 const holdout=args.includes('--holdout'),quick=args.includes('--quick');
 const realClock=!args.includes('--scaled');
 const scale=Number(arg('--scale','0.01')),jobs=Number(arg('--jobs','2'));
 const timeScale=Number(arg('--time-scale','1'));assert.ok(timeScale>0&&timeScale<=1);
 if(holdout)assert.equal(timeScale,1,'Formal acceptance cannot use shortened clocks.');
 const candidate=resolve(arg('--candidate','dist'));
 const candidateEngine=await import(pathToFileURL(resolve(candidate,'ai/src/index.js')));
 const reportPath=arg('--output',holdout?'reports/ai-p5-10-generation-holdout.json':'build/generation-selection.json');
 const seeds=holdout?plan.holdoutSeeds:quick?[37]:plan.selectionSeeds;
 const games=[];
 for(const [index,seed]of seeds.entries())for(const directions of plan.directions)for(const confirmationDelay of plan.confirmationDelays)for(const candidateActor of plan.candidateActors)
  games.push({id:games.length,seed,boardSize:holdout?plan.holdoutBoards[index]:9,claimMode:holdout?plan.holdoutClaimModes[index]:'fixed-five',directions,confirmationDelay,candidateActor});
 const coreHash=file=>createHash('sha256').update(readFileSync(resolve(candidate,file))).digest('hex');
 const candidateFiles=['ai/src/search.js','ai/src/tree.js','ai/src/evaluation.js','ai/src/features.js','ai/src/ordering.js','ai/src/protocol.js',...(existsSync(resolve(candidate,'ai/src/claim-proof.js'))?['ai/src/claim-proof.js']:[])];
 const hashes=Object.fromEntries(candidateFiles.map(file=>[file,coreHash(file)]));
 if(holdout)writeFileSync('build/generation-active-holdout.json',JSON.stringify({pid:process.pid,startedAt:new Date().toISOString(),candidate,reportPath,jobs,status:'running'}));
 const results=[],running=new Set(),progress=new Map();let next=0;
 const summarize=()=>{const wins=results.filter(g=>g.outcome?.kind==='win'&&g.outcome.winner===g.candidateActor).length;
  return {scheduled:games.length,completed:results.length,wins,losses:results.filter(g=>g.outcome?.kind==='win'&&g.outcome.winner!==g.candidateActor).length,
   draws:results.filter(g=>g.outcome?.kind==='draw').length,unfinished:results.filter(g=>!g.outcome).length,winRate:wins/games.length,
   accepted:holdout&&realClock&&results.length===games.length&&wins/games.length>=plan.target};};
 const save=()=>writeFileSync(reportPath,JSON.stringify({stage:'P5.10',predecessorCommit:PREDECESSOR_COMMIT,plan,
  conditions:{holdout,realClock,timeScale,scale:realClock?1:scale,jobs,candidateHashes:hashes,predecessor,previousProfile:{timeMs:8000,maxNodes:200000,maxDepth:12},candidateProfile:candidateEngine.AI_PROFILES.hard},summary:summarize(),games:results.slice().sort((a,b)=>a.id-b.id)},null,2)+'\n');
 await new Promise((done,fail)=>{
  const dispatch=()=>{
   while(running.size<jobs&&next<games.length){
    const game=games[next++],w=new Worker(new URL(import.meta.url),{workerData:{candidate,game,realClock,timeScale,scale}});running.add(w);
    w.on('message',result=>{
     if(result.progress){progress.set(game.id,result.progress);writeFileSync(reportPath+'.progress.json',JSON.stringify([...progress.values()]));return;}
     progress.delete(game.id);results.push(result);save();console.log(JSON.stringify({...game,outcome:result.outcome,commands:result.commands,wallMs:Math.round(result.wallMs),summary:summarize()}));
    });
    w.on('error',fail);w.on('exit',code=>{running.delete(w);if(code!==0)fail(Error(`Worker exited ${code}`));else if(next===games.length&&running.size===0)done();else dispatch();});
   }
  };dispatch();
 });
 for(const file of candidateFiles)assert.equal(coreHash(file),hashes[file],'candidate changed during benchmark');
 if(holdout)writeFileSync('build/generation-active-holdout.json',JSON.stringify({pid:process.pid,candidate,reportPath,jobs,status:'complete',summary:summarize()}));
 console.log(JSON.stringify({report:reportPath,summary:summarize()}));
}
