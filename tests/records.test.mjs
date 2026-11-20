import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DEFAULT_RULES,createMatch,applyAction,exportRecord} from '../compiled/core/src/index.js';
import {decodeRecords,framesOf,mergeRecord,counts} from '../dist/features/records-model.mjs';
import {prepareAdvisoryMatch,scoreToBlackWinPct,buildMatchFrameRecord} from '../dist/features/board-ai.mjs';
function record(actions,rules={...DEFAULT_RULES,swap3:false}){
 let m=createMatch(rules).value;for(const a of actions){const r=applyAction(m,a);assert.ok(r.ok,JSON.stringify(r));m=r.value.match;}return exportRecord(m);
}
test('replay restores captures and counts four subsequent actions before confirming a five',async()=>{
 const captured=record([{kind:'place',actor:'A',point:1},{kind:'place',actor:'B',point:0},{kind:'place',actor:'A',point:9}]);
 let frames=framesOf(captured);assert.equal(frames[2].state.board[0],-1);assert.equal(frames[3].state.board[0],0);assert.equal(frames[3].state.captures.black,1);
 const moves=[];for(let i=0;i<5;i++){moves.push({kind:'place',actor:'A',point:i*10});if(i<4)moves.push({kind:'place',actor:'B',point:8+i*9});}
 for(const actor of ['B','A','B','A'])moves.push({kind:'pass',actor});
 frames=framesOf(record(moves));assert.equal(frames[9].state.claims[0].dueAt-frames[9].state.ply,4);assert.equal(frames[12].state.outcome,null);assert.equal(frames[13].state.outcome.winner,'A');
});
test('native envelopes are checked against exact data bytes and corrupt files do not import',async()=>{
 const r=record([{kind:'place',actor:'A',point:40}]),data={id:'测试/一',record:r,status:'unfinished',error:'引号"与括号}都不是封装边界'};
 const raw=JSON.stringify(data),h=createHash('sha256').update(raw).digest('hex');
 const wrapped=`{\n "schemaVersion":1, "data":${raw}, "sha256":"${h}"\n}`;
 const games=await decodeRecords(wrapped);assert.equal(games[0].record.actions.length,1);
 await assert.rejects(decodeRecords(wrapped.replace(h,'0'.repeat(64))),/校验码/);
 await assert.rejects(decodeRecords(JSON.stringify({record:{...r,actions:[{kind:'place',actor:'B',point:40}]}})),/第1次/);
});
test('imports both-AI test records read-only, keeps web player names, and never counts censored wins',async()=>{
 const r=record([{kind:'place',actor:'A',point:40},{kind:'resign',actor:'B'}]);
 const games=await decodeRecords(JSON.stringify({type:'qiline-test-records',schemaVersion:1,games:[{id:'a',record:r,status:'terminal',candidateActor:'A'},{id:'b',record:r,status:'runtime-censored',candidateActor:'A'}]}));
 assert.deepEqual(counts(games),{total:2,ended:1,candidateWins:1});
 const web=await decodeRecords(JSON.stringify({webSchemaVersion:1,players:{names:['甲','乙'],aIndex:1},session:{record:r,controllers:{A:{kind:'ai'},B:{kind:'ai'}}}}));
 assert.equal(web[0].players.A.name,'乙');assert.equal(web[0].players.B.name,'甲');
});
test('new snapshots extend a record; shorter or divergent imports do not overwrite the saved game',async()=>{
 const a=record([{kind:'place',actor:'A',point:40}]),b=record([{kind:'place',actor:'A',point:40},{kind:'place',actor:'B',point:20}]);
 const [old]=await decodeRecords(JSON.stringify({id:'same',record:a})),[newer]=await decodeRecords(JSON.stringify({id:'same',record:b}));
 assert.equal(mergeRecord(old,newer).record.actions.length,2);assert.equal(mergeRecord(newer,old),newer);
 const [other]=await decodeRecords(JSON.stringify({id:'same',record:record([{kind:'place',actor:'A',point:30}])}));
 assert.throws(()=>mergeRecord(old,other),/不同分支/);assert.equal(old.record.actions.length,1);
});
test('advisory framing supports both sides, preserves black-perspective eval scores, and slices arbitrary cursors for replay handoff',()=>{
 const r=record([{kind:'place',actor:'A',point:40},{kind:'place',actor:'B',point:20},{kind:'place',actor:'A',point:42}]);
 const frames=framesOf(r);
 const cur=prepareAdvisoryMatch(frames[1],{swapSide:false});
 assert.equal(cur.ok,true);assert.equal(cur.targetActor,'B');assert.equal(cur.targetColor,'white');
 const swapped=prepareAdvisoryMatch(frames[1],{swapSide:true});
 assert.equal(swapped.ok,true);assert.equal(swapped.targetActor,'A');assert.equal(swapped.targetColor,'black');
 const pct=scoreToBlackWinPct(350,frames[1]);
 assert.ok(pct>70&&pct<80,`expected black pct near 73, got ${pct}`);
 const slice=buildMatchFrameRecord(r,2);
 assert.equal(slice.actions.length,2);
});
