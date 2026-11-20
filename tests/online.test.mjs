import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {roomsFetch} from '../server/rooms.mjs';
import {DEFAULT_RULES,replayRecord} from '../compiled/core/src/index.js';

function database(){
 const sqlite=new DatabaseSync(':memory:');for(const f of readdirSync('drizzle').filter(x=>x.endsWith('.sql')).sort())sqlite.exec(readFileSync('drizzle/'+f,'utf8'));
 return {sqlite,prepare(sql){return {bind(...args){return {async first(){return sqlite.prepare(sql).get(...args)??null;},async run(){const r=sqlite.prepare(sql).run(...args);return {meta:{changes:Number(r.changes)}};}};}};}};
}
async function call(db,path,{method='GET',body,token}={}){
 const r=await roomsFetch(new Request('https://qiline.test/api/rooms'+path,{method,headers:{...(body?{'content-type':'application/json'}:{}),...(token?{'x-qiline-player':token}:{})},body:body?JSON.stringify(body):undefined}),{DB:db});
 return {status:r.status,...await r.json()};
}
async function pair(db){
 const a=await call(db,'',{method:'POST',body:{name:'甲',rules:DEFAULT_RULES}});assert.equal(a.status,201);
 const b=await call(db,'/'+a.room.code+'/join',{method:'POST',body:{name:'乙'}});assert.equal(b.status,200);
 return {code:a.room.code,A:a.playerToken,B:b.playerToken};
}
async function cmd(db,p,actor,payload,id=crypto.randomUUID()){
 const r=await call(db,'/'+p.code,{token:p[actor]});
 return call(db,'/'+p.code+'/command',{method:'POST',token:p[actor],body:{...payload,commandId:id,revision:r.room.revision}});
}
const move=(actor,point)=>({kind:'move',action:{kind:'place',actor,point}});

test('seats are server-owned, completed commands are idempotent, and a third player cannot enter',async()=>{
 const db=database();try{
  const a=await call(db,'',{method:'POST',body:{name:'甲'}}),id=a.room.code;
  let r=await call(db,'/'+id+'/command',{method:'POST',token:a.playerToken,body:{...move('A',40),commandId:crypto.randomUUID(),revision:0}});
  assert.equal(r.error.code,'WAITING_FOR_PLAYER');
  const b=await call(db,'/'+id+'/join',{method:'POST',body:{name:'乙'}});
  assert.equal((await call(db,'/'+id)).status,401);
  assert.equal((await call(db,'/'+id,{token:'wrong-token'})).status,403);
  assert.equal((await call(db,'/'+id+'/join',{method:'POST',body:{name:'丙'}})).error.code,'ROOM_FULL');
  const body={...move('A',40),revision:b.room.revision,commandId:crypto.randomUUID()};
  r=await call(db,'/'+id+'/command',{method:'POST',token:a.playerToken,body});assert.equal(r.status,200);assert.equal(r.room.record.actions.length,1);
  const again=await call(db,'/'+id+'/command',{method:'POST',token:a.playerToken,body});assert.equal(again.alreadyAccepted,true);assert.equal(again.room.record.actions.length,1);
  const forged=await call(db,'/'+id+'/command',{method:'POST',token:b.playerToken,body:{...move('A',30),revision:r.room.revision,commandId:crypto.randomUUID()}});
  assert.equal(forged.status,403);
  const row=db.sqlite.prepare('SELECT * FROM qiline_rooms WHERE code=?').get(id);
  assert.notEqual(row.a_token_hash,a.playerToken);assert.match(row.a_token_hash,/^[0-9a-f]{64}$/);assert.equal('a_token_hash' in r.room,false);
 }finally{db.sqlite.close();}
});
test('swap3 keeps A/B seats fixed; consenting undo removes two commands including a color choice',async()=>{
 const db=database();try{
  const p=await pair(db);for(const point of [40,20,42])assert.equal((await cmd(db,p,'A',move('A',point))).status,200);
  assert.equal((await cmd(db,p,'A',{kind:'move',action:{kind:'choose-color',actor:'A',color:'black'}})).status,409);
  await cmd(db,p,'B',{kind:'move',action:{kind:'choose-color',actor:'B',color:'black'}});
  const first=await cmd(db,p,'A',move('A',30));assert.equal(first.room.record.actions.length,5);
  const pending=await cmd(db,p,'B',{kind:'request-undo'});assert.equal(pending.room.pending.by,'B');
  assert.equal((await cmd(db,p,'B',{kind:'respond',requestId:pending.room.pending.id,accept:true})).status,409);
  assert.equal((await cmd(db,p,'A',move('A',31))).error.code,'CONSENT_REQUIRED');
  const undo=await cmd(db,p,'A',{kind:'respond',requestId:pending.room.pending.id,accept:true});
  assert.equal(undo.room.record.actions.length,3);assert.equal(replayRecord(undo.room.record).value.state.phase.kind,'choose');
  const white=await cmd(db,p,'B',{kind:'move',action:{kind:'choose-color',actor:'B',color:'white'}});
  assert.equal(white.room.me,'B');assert.equal(replayRecord(white.room.record).value.state.owners.white,'B');
  assert.equal((await cmd(db,p,'B',move('B',31))).status,200);
  assert.equal((await cmd(db,p,'A',{kind:'request-cancel'})).status,409);
  const end=await cmd(db,p,'A',{kind:'move',action:{kind:'resign',actor:'A'}});
  assert.equal(replayRecord(end.room.record).value.state.outcome.winner,'B');
  assert.equal((await cmd(db,p,'B',move('B',32))).error.code,'FINISHED');
 }finally{db.sqlite.close();}
});
test('two concurrent moves against one revision commit exactly once, and reconnect reads durable state',async()=>{
 const db=database();try{
  const p=await pair(db),before=await call(db,'/'+p.code,{token:p.A}),revision=before.room.revision;
  const rs=await Promise.all([40,41].map(point=>call(db,'/'+p.code+'/command',{method:'POST',token:p.A,body:{...move('A',point),revision,commandId:crypto.randomUUID()}})));
  assert.deepEqual(rs.map(x=>x.status).sort(),[200,409]);
  const restored=await call(db,'/'+p.code,{token:p.B});assert.equal(restored.room.record.actions.length,1);assert.equal(restored.room.revision,revision+1);
  db.sqlite.prepare('UPDATE qiline_rooms SET b_seen = ? WHERE code = ?').run(Date.now()-60000,p.code);
  const heartbeat=await call(db,'/'+p.code,{token:p.B});assert.equal(heartbeat.room.revision,restored.room.revision);assert.ok(heartbeat.room.serverNow-heartbeat.room.seen.B<1000);
 }finally{db.sqlite.close();}
});
test('a consent request can be withdrawn; opening cancellation needs the other player; expired rooms reject writes',async()=>{
 const db=database();try{
  const p=await pair(db);let r=await cmd(db,p,'A',{kind:'request-cancel'});
  const requestId=r.room.pending.id;
  r=await cmd(db,p,'A',{kind:'cancel-request'});assert.equal(r.room.pending,null);
  assert.equal((await cmd(db,p,'B',{kind:'respond',requestId,accept:true})).status,409);
  r=await cmd(db,p,'B',{kind:'request-cancel'});
  r=await cmd(db,p,'A',{kind:'respond',requestId:r.room.pending.id,accept:true});
  assert.equal(replayRecord(r.room.record).value.state.outcome.kind,'cancelled');
  db.sqlite.prepare('UPDATE qiline_rooms SET expires_at = ? WHERE code = ?').run(Date.now()-1,p.code);
  assert.equal((await call(db,'/'+p.code,{token:p.A})).status,410);
 }finally{db.sqlite.close();}
});
test('rooms work without player names and support multi-round rematches with alternating A/B roles and score tally',async()=>{
 const db=database();try{
  const a=await call(db,'',{method:'POST',body:{rules:DEFAULT_RULES}});assert.equal(a.status,201);
  const b=await call(db,'/'+a.room.code+'/join',{method:'POST',body:{}});assert.equal(b.status,200);
  const p={code:a.room.code,A:a.playerToken,B:b.playerToken};
  assert.equal(b.room.round,1);assert.deepEqual(b.room.tally,{A:0,B:0,draws:0});
  for(const point of [40,20,42])assert.equal((await cmd(db,p,'A',move('A',point))).status,200);
  await cmd(db,p,'B',{kind:'move',action:{kind:'choose-color',actor:'B',color:'black'}});
  await cmd(db,p,'A',{kind:'move',action:{kind:'resign',actor:'A'}});
  assert.equal((await cmd(db,p,'A',{kind:'request-undo'})).error.code,'FINISHED');
  const req=await cmd(db,p,'B',{kind:'request-rematch'});assert.equal(req.status,200);assert.equal(req.room.pending.kind,'rematch');
  assert.equal((await cmd(db,p,'B',{kind:'respond',requestId:req.room.pending.id,accept:true})).status,409);
  const r2=await cmd(db,p,'A',{kind:'respond',requestId:req.room.pending.id,accept:true});
  assert.equal(r2.status,200);assert.equal(r2.room.round,2);
  assert.deepEqual(r2.room.tally,{A:0,B:1,draws:0});
  assert.equal(r2.room.pastGames.length,1);assert.equal(r2.room.pastGames[0].winnerSeat,'B');
  assert.equal(r2.room.me,'B');assert.equal(r2.room.seat,'A');
  const seatB=await call(db,'/'+p.code,{token:p.B});assert.equal(seatB.room.me,'A');assert.equal(seatB.room.seat,'B');
  assert.equal((await cmd(db,p,'A',move('A',40))).status,403);
  assert.equal((await cmd(db,p,'B',move('A',40))).status,200);
  assert.equal((await cmd(db,p,'A',{kind:'request-cancel'})).status,200);
  const reqCancel=await call(db,'/'+p.code,{token:p.B});
  const cancelled=await cmd(db,p,'B',{kind:'respond',requestId:reqCancel.room.pending.id,accept:true});
  assert.equal(replayRecord(cancelled.room.record).value.state.outcome.kind,'cancelled');
  const rematchCancel=await cmd(db,p,'A',{kind:'request-rematch'});
  const r3=await cmd(db,p,'B',{kind:'respond',requestId:rematchCancel.room.pending.id,accept:true});
  assert.equal(r3.room.round,3);assert.deepEqual(r3.room.tally,{A:0,B:1,draws:0});
  assert.equal(r3.room.me,'A');
 }finally{db.sqlite.close();}
});
