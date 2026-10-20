// Test-only adapter. The production core has no process, filesystem or clock imports.
import readline from 'node:readline';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {createMatch,applyAction,undoLastCommand,exportRecord,replayRecord,getLegalPlacements} from '../dist/core/src/index.js';
let match=null;
const color=c=>c==='black'?1:-1;
function snapshot(m){
 const s=m.state;
 for(let p=0;p<s.board.length;p++)assert.equal(s.board[p]===0,s.moveLabels[p]===0);
 const labels=s.moveLabels.filter(n=>n>0);assert.equal(new Set(labels).size,labels.length);
 assert.ok(labels.every(n=>n<=s.placements));
 if(s.lastPlacement!==null)assert.notEqual(s.board[s.lastPlacement],0);
 assert.ok(s.lastCaptured.every(p=>s.board[p]===0));
 const claims=s.claims.map(c=>({color:color(c.color),points:c.points,formedAt:c.formedAt,dueAt:c.dueAt}));
 claims.sort((a,b)=>{if(a.color!==b.color)return a.color-b.color;for(let i=0;i<a.points.length;i++)if(a.points[i]!==b.points[i])return a.points[i]-b.points[i];return 0;});
 return {board:s.board,phase:s.phase.kind,opened:m.rules.swap3?Math.min(3,s.placements):0,
  toMove:s.phase.kind==='playing'?color(s.phase.toMove):null,owners:s.owners,ply:s.ply,placements:s.placements,
  captures:s.captures,claims,passStreak:s.passStreak,
  outcome:s.outcome===null?null:s.outcome.kind==='win'?['win',color(s.outcome.color),s.outcome.reason]
   :s.outcome.kind==='draw'?['draw',0,s.outcome.reason]:['cancelled',0,s.outcome.reason],
  positionCount:m.positions.length,historyHash:crypto.createHash('sha256').update(m.positions.join('')).digest('hex'),commandCount:m.accepted.length};
}
for await (const line of readline.createInterface({input:process.stdin,crlfDelay:Infinity})){
 try{
  const req=JSON.parse(line);let r;
  if(req.op==='new')r=createMatch(req.rules);
  else if(req.op==='action'){
   const result=applyAction(match,req.action);r=result.ok?{ok:true,value:result.value.match}:result;
  }else if(req.op==='undo')r=undoLastCommand(match);
  else if(req.op==='replay')r=replayRecord(exportRecord(match));
  else if(req.op==='legal'){
   process.stdout.write(JSON.stringify({ok:true,points:getLegalPlacements(match)})+'\n');continue;
  }else throw new Error('unknown test operation');
  if(r.ok){if(req.op!=='replay')match=r.value;process.stdout.write(JSON.stringify({ok:true,state:snapshot(r.value)})+'\n');}
  else process.stdout.write(JSON.stringify({ok:false,error:r.error,state:match?snapshot(match):null})+'\n');
 }catch(error){process.stdout.write(JSON.stringify({fatal:error.stack??String(error)})+'\n');}
}
