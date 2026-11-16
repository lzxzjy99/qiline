import {DEFAULT_RULES,replayRecord,activePlayer,applyAction} from '../core/src/index.js';
import {esc,phaseText,ruleLabels,renderBoard,renderClaims,colorName,actorColor,downloadJSON} from './common.mjs';
const $=id=>document.getElementById(id),SESSIONS='qiline.online.seats.v1',CURRENT='qiline.online.current.v1';
let credentials=null,room=null,match=null,timer=null,polling=false,busy=false,connected=false,failures=0,inspect=false,labels=false,point=null;
const uuid=()=>crypto.randomUUID();
const RECONNECT_MESSAGE='连接暂时中断，正在自动重连。请先核对棋盘，再继续落子。';
function message(text){$('online-message').textContent=text;$('online-message').hidden=!text;}
function savedSeats(){try{const list=JSON.parse(localStorage.getItem(SESSIONS)??'[]');return Array.isArray(list)?list.filter(x=>x&&/^[A-HJ-NP-Z2-9]{8}$/.test(x.code)&&['A','B'].includes(x.actor)&&typeof x.token==='string'):[];}catch{return [];}}
function saveSeat(){try{
 sessionStorage.setItem(CURRENT,JSON.stringify(credentials));
 const list=savedSeats().filter(x=>x.code!==credentials.code||x.actor!==credentials.actor);
 list.unshift({...credentials,savedAt:Date.now()});localStorage.setItem(SESSIONS,JSON.stringify(list.slice(0,20)));
 }catch{message('浏览器未能保存重连身份，请保持本页面打开。');}}
async function api(path,{method='GET',body,token=credentials?.token}={}){
 const abort=new AbortController(),timeout=setTimeout(()=>abort.abort(),10000);
 try{
  const r=await fetch(path,{method,body:body===undefined?undefined:JSON.stringify(body),headers:{...(body===undefined?{}:{'content-type':'application/json'}),...(token?{'x-qiline-player':token}:{})},cache:'no-store',signal:abort.signal});
  let result;try{result=await r.json();}catch{throw Error('房间服务暂时不可用，请稍后重试。');}
  if(!r.ok||!result.ok){const e=Error(result.error?.message??'房间操作未完成。');e.code=result.error?.code;e.status=r.status;throw e;}
  return result;
 }finally{clearTimeout(timeout);}
}
function acceptRoom(next){
 if(next.code!==credentials?.code)return;
 if(room&&next.revision<room.revision)return;
 const changed=!room||next.revision!==room.revision,reconnected=!connected;
 if(changed){const replay=replayRecord(next.record);if(!replay.ok)throw Error('服务器棋谱未通过规则校验，已锁定棋盘。');match=replay.value;point=null;}
 room=next;credentials.actor=next.me;connected=true;failures=0;
 if(reconnected&&$('online-message').textContent===RECONNECT_MESSAGE)message('连接已恢复，棋盘已与服务器同步。');
 $('room-lobby').hidden=true;$('online-room').hidden=false;
 if(changed||reconnected)render();else renderConnection();
}
function schedule(){clearTimeout(timer);if(credentials)timer=setTimeout(poll,Math.min(10000,1500*(2**Math.min(failures,3))));}
async function poll(){if(!credentials||polling)return;polling=true;
 try{acceptRoom((await api('/api/rooms/'+credentials.code)).room);}
 catch(e){connected=false;failures++;if(room)render();else renderConnection();if(e.status===401||e.status===403||e.status===404||e.status===410){message(e.message);credentials=null;clearTimeout(timer);if(room)render();else renderLobby();}else message(RECONNECT_MESSAGE);}
 finally{polling=false;schedule();}
}
function renderConnection(){
 const el=$('room-connection');el.classList.toggle('offline',!connected);
 el.querySelector('span').textContent=connected?`已同步 · 你是${credentials?.actor??room?.me??''}`:'正在重新连接';
 if(room&&match)renderPlayers();
}
function renderPlayers(){
 const active=activePlayer(match),me=credentials?.actor??room.me;
 $('online-players').innerHTML=['A','B'].map(a=>{
  const color=actorColor(match,a),online=room.joined[a]&&(room.serverNow-room.seen[a]<45000);
  return `<div class="player-row ${active===a?'active':''}">${color?`<i class="stone-dot ${color}"></i>`:`<span class="role-dot">${a}</span>`}<div class="player-text"><b>${esc(room.names[a])}${a===me?' · 你':''}</b><small>${a}${color?' · '+colorName(color):' · '+(a==='A'?'摆局方':'选色方')} · ${!room.joined[a]?'等待加入':online?'最近在线':'暂未同步'}</small></div><span class="player-captures">提子<strong>${color?match.state.captures[color]:'—'}</strong></span></div>`;
 }).join('');
}
function render(){
 if(!room||!match)return;const me=credentials?.actor??room.me,s=match.state,v=phaseText(match,room.names);
 $('room-code').textContent=room.code;$('online-rules').innerHTML=ruleLabels(match.rules).map(x=>`<span>${esc(x)}</span>`).join('');
 $('online-title').textContent=!room.joined.B?'等待对手加入':v.title;
 $('online-detail').textContent=!room.joined.B?'复制邀请链接，或将上方八位房间码发给对手。对方加入后开始。':v.detail;
 $('online-phase').textContent=s.outcome?'本局结束':room.pending?'等待双方确认':'好友对战';
 $('online-your-role').textContent=`你是${me}${s.owners?'，执'+colorName(actorColor(match,me)):'，'+(me==='A'?'负责摆局':'负责选色')}。`;
 $('online-board-caption').textContent=inspect?'查气模式':s.outcome?'终局棋盘':room.joined.B?v.title:'等待对手加入';$('online-ply').textContent=`第${s.ply}手`;
 const canOperate=!!credentials&&connected&&!busy&&room.joined.B&&!room.pending&&!s.outcome;
 const turn=canOperate&&activePlayer(match)===me;
 const group=renderBoard($('board'),match,{labels,inspect,selected:point,onPoint:inspect?p=>{point=p;render();}:turn&&['opening','playing'].includes(s.phase.kind)?p=>move({kind:'place',actor:me,point:p}):null});
 $('online-inspect').setAttribute('aria-pressed',inspect);$('online-labels').setAttribute('aria-pressed',labels);$('online-inspection').hidden=!inspect;
 $('online-inspection').textContent=group?`${colorName(group.color)}：${group.stones.length}子，${group.liberties.length}口气。`:'点击棋子查看整块与气，不会落子。';
 $('online-choices').hidden=s.phase.kind!=='choose';for(const id of ['online-black','online-white'])$(id).disabled=!turn||s.phase.kind!=='choose';
 $('online-pass').disabled=!turn||s.phase.kind!=='playing';$('online-undo').disabled=!canOperate||!match.accepted.length;
 $('online-end').disabled=!canOperate;$('online-end').textContent=['opening','choose'].includes(s.phase.kind)?'申请取消开局':'认输';
 renderClaims($('online-claims'),match);renderConsent();renderConnection();
}
function renderConsent(){
 const p=room.pending,el=$('online-consent');el.hidden=!p;if(!p)return;
 const own=p.by===credentials?.actor,what=p.kind==='undo'?'撤回最后两手操作':'取消本次开局';
 el.innerHTML=`<h3>${own?'等待对方同意':esc(room.names[p.by])+'请求'}${what}</h3><p>${p.kind==='undo'?'不足两手时撤回一手，选色也算一次操作。':'双方同意后取消，不记录胜负。'}</p><div class="consent-buttons">${own?'<button data-consent="withdraw">撤回申请</button>':'<button data-consent="accept">同意</button><button data-consent="reject">拒绝</button>'}</div>`;
 for(const b of el.querySelectorAll('button'))b.disabled=busy||!connected;
}
async function command(payload){
 if(!credentials||!room||busy)return;busy=true;render();
 try{const r=await api('/api/rooms/'+credentials.code+'/command',{method:'POST',body:{...payload,revision:room.revision,commandId:uuid()}});acceptRoom(r.room);message('');}
 catch(e){message(e.name==='AbortError'?'这次请求未收到确认，正在核对服务器棋盘，请勿重复落子。':e.message);
  try{acceptRoom((await api('/api/rooms/'+credentials.code)).room);}catch{connected=false;}
 }finally{busy=false;render();schedule();}
}
function move(action){
 if(!match)return;const preview=applyAction(match,action);
 if(!preview.ok){message({OCCUPIED:'这里已有棋子。',SUICIDE:'这手没有气，不能落子。',REPETITION:'这手会重复历史棋盘。',OPENING_CAPTURE:'摆局时不能提子，请换一个位置。'}[preview.error.code]??'当前不能进行这项操作。');return;}
 command({kind:'move',action});
}
function renderLobby(){
 $('room-lobby').hidden=false;$('online-room').hidden=true;
 const seats=savedSeats();$('resume-rooms').hidden=!seats.length;
 $('resume-list').innerHTML=seats.map((s,i)=>`<button data-resume="${i}">${esc(s.code)} · ${esc(s.name??s.actor)}（${s.actor}）</button>`).join('');
 $('resume-list').onclick=e=>{const b=e.target.closest('[data-resume]');if(b)restore(seats[Number(b.dataset.resume)]);};
}
function enter(next,playerToken){
 clearTimeout(timer);credentials={code:next.code,actor:next.me,token:playerToken,name:next.names[next.me]};room=null;match=null;
 saveSeat();acceptRoom(next);history.replaceState(null,'',location.pathname+'?room='+next.code);schedule();
}
async function restore(seat){
 if(busy)return;busy=true;credentials=seat;room=null;match=null;message('正在恢复房间身份…');
 try{const r=await api('/api/rooms/'+seat.code);enter(r.room,seat.token);message('已恢复原来的身份与服务器棋谱。');}
 catch(e){credentials=null;message(e.message);renderLobby();}finally{busy=false;if(room)render();}
}
function lobbyBusy(value){busy=value;$('create-submit').disabled=value;$('join-submit').disabled=value;}
$('create-room').onsubmit=async e=>{
 e.preventDefault();if(busy)return;lobbyBusy(true);const f=e.currentTarget;
 const rules={...DEFAULT_RULES,boardSize:Number(f.elements.boardSize.value),confirmationDelay:Number(f.elements.confirmationDelay.value),directions:f.elements.directions.value,swap3:f.elements.swap3.checked,superko:f.elements.superko.checked?'positional':'off',claimMode:f.elements.pressure.checked?'color-pressure':'fixed-five'};
 try{const r=await api('/api/rooms',{method:'POST',body:{name:f.elements.name.value.trim(),rules},token:null});enter(r.room,r.playerToken);message('房间已创建，请分享邀请链接。');}catch(e){message(e.name==='AbortError'?'创建房间未收到确认，请稍后再试。':e.message);}finally{lobbyBusy(false);if(room)render();}
};
$('join-room').onsubmit=async e=>{
 e.preventDefault();if(busy)return;const f=e.currentTarget,id=f.elements.code.value.trim().toUpperCase();
 if(!/^[A-HJ-NP-Z2-9]{8}$/.test(id)){message('请输入八位房间码，不含I、O、0、1。');return;}lobbyBusy(true);
 try{const r=await api('/api/rooms/'+id+'/join',{method:'POST',body:{name:f.elements.name.value.trim()},token:null});enter(r.room,r.playerToken);message('已加入房间，身份与棋谱已保存。');}catch(e){message(e.name==='AbortError'?'加入房间未收到确认，请稍后重试。':e.message);}finally{lobbyBusy(false);if(room)render();}
};
$('online-black').onclick=()=>move({kind:'choose-color',actor:credentials.actor,color:'black'});$('online-white').onclick=()=>move({kind:'choose-color',actor:credentials.actor,color:'white'});
$('online-pass').onclick=()=>move({kind:'pass',actor:credentials.actor});$('online-undo').onclick=()=>command({kind:'request-undo'});
$('online-end').onclick=()=>['opening','choose'].includes(match.state.phase.kind)?command({kind:'request-cancel'}):$('resign-dialog').showModal();
for(const id of ['resign-close','resign-cancel'])$(id).onclick=()=>$('resign-dialog').close();
$('resign-confirm').onclick=()=>{$('resign-dialog').close();move({kind:'resign',actor:credentials.actor});};
$('online-consent').onclick=e=>{const v=e.target.closest('[data-consent]')?.dataset.consent;if(!v)return;command(v==='withdraw'?{kind:'cancel-request'}:{kind:'respond',requestId:room.pending.id,accept:v==='accept'});};
$('online-inspect').onclick=()=>{inspect=!inspect;point=null;render();};$('online-labels').onclick=()=>{labels=!labels;render();};
$('copy-invite').onclick=async()=>{const link=location.origin+'/online.html?room='+room.code;try{await navigator.clipboard.writeText(link);message('邀请链接已复制。');}catch{message('请复制邀请链接：'+link);}};
$('room-lobby-back').onclick=()=>{clearTimeout(timer);credentials=null;room=null;match=null;try{sessionStorage.removeItem(CURRENT);}catch{}history.replaceState(null,'',location.pathname);message('身份仍保存在本机，可随时恢复房间。');renderLobby();};
$('online-export').onclick=()=>downloadJSON({type:'qiline-test-records',schemaVersion:1,games:[{id:`online:${room.code}:${room.createdAt}`,title:`在线房间 ${room.code}`,record:room.record,status:match.state.outcome?'terminal':'unfinished',players:{A:{name:room.names.A},B:{name:room.names.B}},searches:[]}]},`弈合_在线对局_${room.code}.json`);
window.addEventListener('pagehide',()=>clearTimeout(timer));
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&credentials){clearTimeout(timer);poll();}});
renderLobby();const invited=new URL(location.href).searchParams.get('room')?.toUpperCase();if(invited)$('join-code').value=invited.slice(0,8);
try{const current=JSON.parse(sessionStorage.getItem(CURRENT)??'null');if(current&&(!invited||current.code===invited)&&savedSeats().some(s=>s.code===current.code&&s.actor===current.actor&&s.token===current.token))restore(current);}catch{}
