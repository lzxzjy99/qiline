import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {replayRecord,DEFAULT_RULES} from '../dist/core/src/index.js';
import {AI_PROFILES} from '../dist/ai/src/index.js';
import {preparePredecessor,predecessorRoot,PREDECESSOR_COMMIT} from './prepare-ai-predecessor.mjs';
const path=process.argv[2]??'reports/ai-p5-10-generation-holdout.json';
const report=JSON.parse(readFileSync(path)),plan=JSON.parse(readFileSync('benchmarks/generation-plan.json'));
const predecessor=await preparePredecessor(),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
assert.equal(report.predecessorCommit,PREDECESSOR_COMMIT);assert.deepEqual(report.conditions.predecessor,predecessor);
assert.deepEqual(report.plan,plan);assert.equal(report.conditions.holdout,true);assert.equal(report.conditions.realClock,true);
assert.equal(report.conditions.timeScale,1);
assert.deepEqual(report.conditions.previousProfile,{timeMs:8000,maxNodes:200000,maxDepth:12});
assert.deepEqual(report.conditions.candidateProfile,AI_PROFILES.hard);
for(const [file,expected]of Object.entries(report.conditions.candidateHashes))assert.equal(sha(readFileSync(resolve('dist',file))),expected,file);
for(const [file,expected]of Object.entries(predecessor.hashes))assert.equal(sha(readFileSync(resolve(predecessorRoot,file.slice('compiled/'.length)))),expected,file);
assert.equal(report.games.length,plan.holdoutGames);assert.equal(new Set(report.games.map(g=>g.id)).size,plan.holdoutGames);
const expected=[];
for(const [i,seed]of plan.holdoutSeeds.entries())for(const directions of plan.directions)for(const confirmationDelay of plan.confirmationDelays)for(const candidateActor of plan.candidateActors)
 expected.push({seed,boardSize:plan.holdoutBoards[i],claimMode:plan.holdoutClaimModes[i],directions,confirmationDelay,candidateActor});
let wins=0,losses=0,draws=0,unfinished=0;const buckets={};
for(const game of report.games){
 for(const [key,expectedValue]of Object.entries(expected[game.id]))assert.equal(game[key],expectedValue,`${game.id}/${key}`);
 assert.equal(game.record.rules.swap3,plan.swap3);
 assert.deepEqual(game.record.rules,{...DEFAULT_RULES,swap3:plan.swap3,boardSize:game.boardSize,directions:game.directions,
  confirmationDelay:game.confirmationDelay,claimMode:game.claimMode});
 for(const key of ['boardSize','claimMode','directions','confirmationDelay'])assert.equal(game.record.rules[key],game[key]);
 const replay=replayRecord(game.record);assert.equal(replay.ok,true);const match=replay.value;
 assert.deepEqual(match.state.outcome,game.outcome);assert.equal(match.state.ply,game.plies);
 assert.equal(game.record.actions.length,game.commands);assert.equal(game.moves.length,game.commands);
 assert.ok(Number.isInteger(game.commands)&&game.commands<=plan.maxCommands);
 assert.deepEqual(game.moves.map(m=>m.action),game.record.actions);
 for(const move of game.moves){
  const isCandidate=move.action.actor===game.candidateActor,profile=isCandidate?AI_PROFILES.hard:report.conditions.previousProfile;
  assert.equal(move.generation,isCandidate?'candidate':'predecessor');
  assert.ok(move.stats.nodes<=profile.maxNodes);assert.ok(move.stats.completedDepth<=profile.maxDepth);
  assert.ok(move.maxVisitedDepth<=profile.maxDepth);assert.ok(Number.isFinite(move.stats.elapsedMs)&&move.stats.elapsedMs>=0);
 }
 const won=game.outcome?.kind==='win'&&game.outcome.winner===game.candidateActor;
 if(won)wins++;else if(game.outcome?.kind==='win')losses++;else if(game.outcome?.kind==='draw')draws++;else unfinished++;
 for(const label of [`board/${game.boardSize}`,`actor/${game.candidateActor}`,`direction/${game.directions}`,`delay/${game.confirmationDelay}`,`claims/${game.claimMode}`]){
  const row=buckets[label]??={games:0,wins:0};row.games++;if(won)row.wins++;
 }
}
const summary={scheduled:plan.holdoutGames,completed:report.games.length,wins,losses,draws,unfinished,winRate:wins/plan.holdoutGames,
 accepted:wins/plan.holdoutGames>=plan.target};
assert.deepEqual(report.summary,summary);
for(const row of Object.values(buckets))row.winRate=row.wins/row.games;
const output={verifiedOn:new Date().toISOString(),report:path,reportSHA256:sha(readFileSync(path)),predecessorCommit:PREDECESSOR_COMMIT,
 candidateHashes:report.conditions.candidateHashes,conditions:report.conditions,summary,buckets,
 checks:{allScheduledGamesPresent:true,allGamesReplayed:true,allMoveStatsBounded:true,predecessorBytesPinned:true,publishedCandidateMatchesBenchmark:true,allDrawsAndUnfinishedCounted:true}};
writeFileSync('reports/ai-p5-10-generation-audit.json',JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify({summary,buckets}));
assert.equal(summary.accepted,true,'The 80% production gate has not been met; preserve the failed report.');
