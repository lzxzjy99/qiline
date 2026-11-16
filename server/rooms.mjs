import {DEFAULT_RULES,createMatch,replayRecord,exportRecord,applyAction,undoLastCommand,activePlayer} from '../compiled/core/src/index.js';

const RETENTION=7*24*60*60*1000;
class RoomError extends Error {constructor(status,code,message){super(message);this.status=status;this.code=code;}}
const fail=(status,code,message)=>{throw new RoomError(status,code,message);};
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json;charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}});
const hash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),n=>n.toString(16).padStart(2,'0')).join('');
const token=()=>btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
const code=()=>Array.from(crypto.getRandomValues(new Uint8Array(8)),b=>'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b&31]).join('');
function name(value,fallback){
 const n=value===undefined?fallback:typeof value==='string'?value.trim():'';
 if(!n||n.length>24)fail(400,'INVALID_NAME','名字请填写1至24个字符。');return n;
}
async function bodyOf(request){
 if(!request.headers.get('content-type')?.startsWith('application/json'))fail(415,'JSON_REQUIRED','请使用网页中的房间操作。');
 let size=0,parts=[];const reader=request.body?.getReader();
 if(!reader)fail(400,'INVALID_REQUEST','请求内容不完整。');
 while(true){const r=await reader.read();if(r.done)break;size+=r.value.length;
  if(size>16384){await reader.cancel();fail(413,'TOO_LARGE','请求内容过大。');}parts.push(r.value);}
 const bytes=new Uint8Array(size);let offset=0;for(const p of parts){bytes.set(p,offset);offset+=p.length;}
 try{const value=JSON.parse(new TextDecoder().decode(bytes));if(!value||Array.isArray(value)||typeof value!=='object')throw Error();return value;}
 catch{fail(400,'INVALID_REQUEST','请求内容无效。');}
}
async function loadRoom(db,id,now){
 const row=await db.prepare('SELECT * FROM qiline_rooms WHERE code = ?').bind(id).first();
 if(!row)fail(404,'ROOM_NOT_FOUND','没有找到这个房间，请检查房间码。');
 if(row.expires_at<=now)fail(410,'ROOM_EXPIRED','房间已过期，请创建新房间。');
 return row;
}
async function seatOf(row,request){
 const value=request.headers.get('x-qiline-player');if(!value||value.length>100)fail(401,'PLAYER_REQUIRED','请先加入房间，或恢复已保存的身份。');
 const h=await hash(value);if(h===row.a_token_hash)return 'A';if(h===row.b_token_hash)return 'B';
 fail(403,'NOT_YOUR_SEAT','这个身份不能操作此房间。');
}
function publicRoom(row,me){
 const s=JSON.parse(row.state_json);
 return {code:row.code,revision:row.revision,me,record:s.record,names:s.names,pending:s.pending,
  joined:{A:true,B:!!row.b_token_hash},seen:{A:row.a_seen,B:row.b_seen},
  serverNow:Date.now(),
  createdAt:row.created_at,updatedAt:row.updated_at,expiresAt:row.expires_at,
  acknowledgedCommandId:s.receipts?.[me]?.id??null};
}
const coreValue=r=>{if(!r.ok)fail(409,r.error.code,{
 OCCUPIED:'这里已有棋子。',SUICIDE:'这手没有气，不能落子。',REPETITION:'这手会重复历史棋盘，不能落子。',
 WRONG_ACTOR:'现在应由另一方操作。',WRONG_PHASE:'当前阶段不能进行这项操作。',FINISHED:'这局已经结束。',
 OPENING_CAPTURE:'摆局时不能提子，请换一个位置。',NO_UNDO:'当前没有可撤回的操作。',
 }[r.error.code]??'这项操作未通过规则校验，请核对棋盘。');return r.value;};

export async function roomsFetch(request,env){
 try{
  const db=env.DB;if(!db)fail(503,'ROOM_SERVICE_UNAVAILABLE','在线房间暂不可用，请稍后再试。');
  const pathname=new URL(request.url).pathname,now=Date.now();
  if(pathname==='/api/rooms'&&request.method==='POST'){
   const b=await bodyOf(request),m=coreValue(createMatch(b.rules??DEFAULT_RULES)),a=token(),aHash=await hash(a);
   const data={record:exportRecord(m),names:{A:name(b.name,'玩家A'),B:'等待加入'},pending:null,receipts:{}};
   for(let attempt=0;attempt<3;attempt++){
    const id=code();
    const r=await db.prepare('INSERT OR IGNORE INTO qiline_rooms (code,a_token_hash,b_token_hash,state_json,revision,a_seen,b_seen,created_at,updated_at,expires_at) VALUES (?,?,NULL,?,0,?,0,?,?,?)')
     .bind(id,aHash,JSON.stringify(data),now,now,now,now+RETENTION).run();
    if(r.meta.changes){const row=await loadRoom(db,id,now);return json({ok:true,playerToken:a,room:publicRoom(row,'A')},201);}
   }
   fail(503,'ROOM_BUSY','暂时无法创建房间，请稍后再试。');
  }
  const route=pathname.match(/^\/api\/rooms\/([A-HJ-NP-Z2-9]{8})(?:\/(join|command))?$/);
  if(!route)fail(404,'ROOM_NOT_FOUND','房间地址无效。');
  const [,id,operation]=route;let row=await loadRoom(db,id,now);
  if(operation==='join'&&request.method==='POST'){
   const b=await bodyOf(request);
   if(row.b_token_hash)fail(409,'ROOM_FULL','房间已有两位玩家。若你已加入，请恢复原来的身份。');
   const playerToken=token(),bHash=await hash(playerToken),data=JSON.parse(row.state_json);
   data.names.B=name(b.name,'玩家B');
   const result=await db.prepare('UPDATE qiline_rooms SET b_token_hash = ?,state_json = ?,revision = revision + 1,b_seen = ?,updated_at = ?,expires_at = ? WHERE code = ? AND revision = ? AND b_token_hash IS NULL')
    .bind(bHash,JSON.stringify(data),now,now,now+RETENTION,id,row.revision).run();
   if(!result.meta.changes)fail(409,'ROOM_FULL','另一位玩家刚刚加入了这个房间。');
   row=await loadRoom(db,id,now);return json({ok:true,playerToken,room:publicRoom(row,'B')});
  }
  const seat=await seatOf(row,request);
  if(!operation&&request.method==='GET'){
   const column=seat==='A'?'a_seen':'b_seen';
   if(now-row[column]>=15000){await db.prepare(`UPDATE qiline_rooms SET ${column} = ? WHERE code = ?`).bind(now,id).run();row[column]=now;}
   return json({ok:true,room:publicRoom(row,seat)});
  }
  if(operation!=='command'||request.method!=='POST')fail(405,'METHOD_NOT_ALLOWED','不支持这项操作。');
  const b=await bodyOf(request),data=JSON.parse(row.state_json);
  if(typeof b.commandId!=='string'||!/^[a-zA-Z0-9_-]{8,80}$/.test(b.commandId))fail(400,'INVALID_REQUEST','操作标识无效。');
  const signature=JSON.stringify({kind:b.kind,action:b.action??null,accept:b.accept??null,requestId:b.requestId??null});
  const receipt=data.receipts?.[seat];
  if(receipt?.id===b.commandId){
   if(receipt.signature!==signature)fail(409,'COMMAND_CONFLICT','这次操作已处理，请同步棋盘后重试。');
   return json({ok:true,room:publicRoom(row,seat),alreadyAccepted:true});
  }
  if(b.revision!==row.revision)fail(409,'STATE_CHANGED','棋局刚刚更新，正在同步最新棋盘。');
  if(!row.b_token_hash)fail(409,'WAITING_FOR_PLAYER','等待另一位玩家加入后开始。');
  let match=coreValue(replayRecord(data.record));
  if(match.state.outcome)fail(409,'FINISHED','这局已经结束，可导出棋谱或创建新房间。');
  if(b.kind==='cancel-request'){
   if(!data.pending||data.pending.by!==seat)fail(409,'NO_REQUEST','没有可撤回的申请。');data.pending=null;
  }else if(b.kind==='respond'){
   const p=data.pending;
   if(!p||p.id!==b.requestId||p.by===seat||typeof b.accept!=='boolean')fail(409,'STALE_REQUEST','这项申请已失效，请同步后再操作。');
   if(b.accept){
    if(p.kind==='undo'){
     const count=Math.min(2,match.accepted.length);
     for(let i=0;i<count;i++)match=coreValue(undoLastCommand(match));
    }else match=coreValue(applyAction(match,{kind:'cancel-opening',actor:p.by,approvedBy:['A','B']})).match;
   }
   data.pending=null;
  }else{
   if(data.pending)fail(409,'CONSENT_REQUIRED','请先回应或撤回当前申请。');
   if(b.kind==='request-undo'){
    if(!match.accepted.length)fail(409,'NO_UNDO','还没有可撤回的操作。');
    data.pending={id:b.commandId,kind:'undo',by:seat};
   }else if(b.kind==='request-cancel'){
    if(!['opening','choose'].includes(match.state.phase.kind))fail(409,'WRONG_PHASE','正式行棋后不能取消开局，可选择认输。');
    data.pending={id:b.commandId,kind:'cancel',by:seat};
   }else if(b.kind==='move'){
    if(b.action?.actor!==seat)fail(403,'NOT_YOUR_SEAT','只能操作自己的身份。');
    if(!['place','pass','choose-color','resign'].includes(b.action?.kind))fail(400,'INVALID_ACTION','不支持这项棋盘操作。');
    match=coreValue(applyAction(match,b.action)).match;
   }else fail(400,'INVALID_ACTION','不支持这项操作。');
  }
  data.record=exportRecord(match);data.receipts??={};data.receipts[seat]={id:b.commandId,signature};
  const column=seat==='A'?'a_seen':'b_seen';
  const result=await db.prepare(`UPDATE qiline_rooms SET state_json = ?,revision = revision + 1,${column} = ?,updated_at = ?,expires_at = ? WHERE code = ? AND revision = ?`)
   .bind(JSON.stringify(data),now,now,now+RETENTION,id,row.revision).run();
  if(!result.meta.changes)fail(409,'STATE_CHANGED','棋局刚刚更新，正在同步最新棋盘。');
  row=await loadRoom(db,id,now);return json({ok:true,room:publicRoom(row,seat)});
 }catch(e){
  if(e instanceof RoomError)return json({ok:false,error:{code:e.code,message:e.message}},e.status);
  console.error('Online room request failed:',e.message);
  return json({ok:false,error:{code:'ROOM_SERVICE_UNAVAILABLE',message:'房间服务暂时无法连接，请稍后重试。'}},503);
 }
}
