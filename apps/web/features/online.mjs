import {DEFAULT_RULES,replayRecord,activePlayer,applyAction} from '../core/src/index.js';
import {esc,phaseText,ruleLabels,renderBoard,renderClaims,colorName,actorColor,actorRoleName,downloadJSON,computeIllegalPoints} from './common.mjs';
import {isMuted,toggleMuted,playSound,notifyTurnArrival} from './sound.mjs';
import {installCornerManual} from './manual-widget.mjs';
import {saveGameRecordToLibrary} from './board-ai.mjs';

const $=id=>document.getElementById(id),SESSIONS='qiline.online.seats.v1',CURRENT='qiline.online.current.v1',ZOOM_KEY='qiline.boardZoom';
let credentials=null,room=null,match=null,timer=null,clockTick=null,polling=false,busy=false,connected=false,failures=0,inspect=false,labels=false,point=null;
let boardZoom='fit';
try{const z=localStorage.getItem(ZOOM_KEY);if(['fit','compact','large'].includes(z))boardZoom=z;}catch{}
const clockState={roundKey:'',activeSeat:null,turnStartedAt:Date.now(),totalMs:{A:0,B:0}};
const uuid=()=>crypto.randomUUID();
const RECONNECT_MESSAGE='连接暂时中断，正在自动重连。请先核对棋盘，再继续落子。';
function message(text){$('online-message').textContent=text;$('online-message').hidden=!text;}
function fmtClock(ms){const s=Math.max(0,Math.floor(ms/1000)),m=Math.floor(s/60),sec=String(s%60).padStart(2,'0');return `${m}:${sec}`;}
function renderSoundBtn(){const b=$('sound-toggle'),m=isMuted();if(b){b.setAttribute('aria-pressed',String(m));b.textContent=m?'🔇 静音':'🔊 音效';}}

function savedSeats(){try{const list=JSON.parse(localStorage.getItem(SESSIONS)??'[]');return Array.isArray(list)?list.filter(x=>x&&/^[A-HJ-NP-Z2-9]{8}$/.test(x.code)&&['A','B'].includes(x.actor)&&typeof x.token==='string'):[];}catch{return [];}}
function writeSeats(list){try{localStorage.setItem(SESSIONS,JSON.stringify(list.slice(0,20)));}catch{}}
function saveSeat(){try{
 sessionStorage.setItem(CURRENT,JSON.stringify(credentials));
 const list=savedSeats().filter(x=>!(x.code===credentials.code&&(x.token===credentials.token||(credentials.seat&&x.seat===credentials.seat)||x.actor===credentials.actor)));
 list.unshift({...credentials,savedAt:Date.now()});writeSeats(list);
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

const seatFor=(r,actor)=>r?.roles?.B===actor?'B':(r?.roles?.A===actor?'A':actor);
const mySeatOf=()=>room?.seat??credentials?.seat??seatFor(room,credentials?.actor??room?.me??'A');

function syncTurnClock(nextRoom,nextMatch){
  const key=`${nextRoom.code}:${nextRoom.round??1}`;
  const now=Date.now();
  if(clockState.roundKey!==key){
    clockState.roundKey=key;clockState.activeSeat=null;clockState.turnStartedAt=now;clockState.totalMs={A:0,B:0};
  }else if(clockState.activeSeat){
    clockState.totalMs[clockState.activeSeat]+=Math.max(0,now-clockState.turnStartedAt);
  }
  const activeActor=nextMatch?.state.outcome||!nextRoom.joined?.B?null:activePlayer(nextMatch);
  clockState.activeSeat=activeActor?seatFor(nextRoom,activeActor):null;
  clockState.turnStartedAt=now;
  clearInterval(clockTick);
  if(clockState.activeSeat){
    clockTick=setInterval(()=>{if(room&&match&&!match.state.outcome)renderPlayers();},1000);
  }
}

async function persistOnlineRound(targetRoom,targetMatch,roundObj=null,silent=true){
  if(typeof indexedDB==='undefined')return null;
  const rn=roundObj?roundObj.round:(targetRoom.round??1);
  const rec=roundObj?roundObj.record:targetRoom.record;
  const outcome=roundObj?roundObj.outcome:targetMatch?.state?.outcome;
  try{
    return await saveGameRecordToLibrary({
      id:`online:${targetRoom.code}:${targetRoom.createdAt}:r${rn}`,
      title:`在线房间 ${targetRoom.code} 第${rn}局`,
      record:rec,
      outcome,
      players:{A:{name:'摆局方'},B:{name:'选色方'}},
    });
  }catch(e){if(!silent)message(e.message||'未能保存到棋谱库。');return null;}
}

function acceptRoom(next){
 if(next.code!==credentials?.code)return;
 if(room&&next.revision<room.revision)return;
 const prevMatch=match,prevPending=room?.pending;
 const changed=!room||next.revision!==room.revision,reconnected=!connected,roundChanged=room&&next.round&&next.round!==room.round;
 if(changed){const replay=replayRecord(next.record);if(!replay.ok)throw Error('服务器棋谱未通过规则校验，已锁定棋盘。');match=replay.value;point=null;}
 room=next;credentials.actor=next.me;if(next.seat)credentials.seat=next.seat;if(roundChanged)saveSeat();
 connected=true;failures=0;
 if(changed){
  syncTurnClock(next,match);
  if(prevMatch&&!roundChanged&&match.accepted.length>prevMatch.accepted.length){
   const last=match.accepted.at(-1);
   if(last&&last.actor!==next.me){
    if(match.state.outcome)notifyTurnArrival('win');
    else if(match.state.claims.length>prevMatch.state.claims.length)notifyTurnArrival('claim');
    else notifyTurnArrival(match.state.lastCaptured?.length?'capture':'notify');
   }
  }else if(prevMatch&&match.state.outcome&&!prevMatch.state.outcome){
   notifyTurnArrival('win');
  }else if(next.pending&&next.pending.id!==prevPending?.id&&(next.pending.bySeat?next.pending.bySeat!==next.seat:next.pending.by!==next.me)){
   notifyTurnArrival('notify');
  }
  if(match.state.outcome)persistOnlineRound(next,match,null,true);
 }
 if(roundChanged)message(`已开启第${next.round}局（双方已轮换先后）。`);
 else if(reconnected&&$('online-message').textContent===RECONNECT_MESSAGE)message('连接已恢复，棋盘已与服务器同步。');
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
 const me=credentials?.actor??room?.me??'';
 const roleText=match?actorRoleName(match,me):(me==='A'?'摆局方':'选色方');
 el.querySelector('span').textContent=connected?`已同步 · 第${room?.round??1}局 · 你是${roleText}`:'正在重新连接';
 if(room&&match)renderPlayers();
}
function renderPlayers(){
 const active=activePlayer(match),me=credentials?.actor??room.me,now=Date.now();
 $('online-players').innerHTML=['A','B'].map(a=>{
  const color=actorColor(match,a),seat=seatFor(room,a),online=room.joined[seat]&&(room.serverNow-room.seen[seat]<45000);
  const title=color?colorName(color):(a==='A'?'摆局方（A）':'选色方（B）');
  const badge=a===me?' <span class="ai-badge">你</span>':'';
  const status=!room.joined[seat]?'等待加入':online?'在线':'暂未同步';
  const elapsedTurn=clockState.activeSeat===seat?Math.max(0,now-clockState.turnStartedAt):0;
  const totalSeat=(clockState.totalMs[seat]??0)+elapsedTurn;
  const clockText=room.joined[seat]?` · ${clockState.activeSeat===seat?`本手 ${fmtClock(elapsedTurn)} / `:''}累计 ${fmtClock(totalSeat)}`:'';
  return `<div class="player-row ${active===a?'active':''}">${color?`<i class="stone-dot ${color}"></i>`:`<span class="role-dot">${a}</span>`}<div class="player-text"><b>${title}${badge}</b><small>${color?`${a==='A'?'原摆局方':'原选色方'} · `:''}${status}${clockText}</small></div><span class="player-captures">提子<strong>${color?match.state.captures[color]:'—'}</strong></span></div>`;
 }).join('');
}
function renderHistory(){
 const mySeat=mySeatOf(),oppSeat=mySeat==='A'?'B':'A',t=room.tally??{A:0,B:0,draws:0};
 $('online-tally').textContent=`你 ${t[mySeat]} 胜 · 对手 ${t[oppSeat]} 胜${t.draws?` · ${t.draws} 平`:''}`;
 const past=Array.isArray(room.pastGames)?room.pastGames:[];
 $('online-history-list').innerHTML=past.length?[...past].reverse().map(g=>{
  const text=g.outcome?.kind==='win'?(g.winnerSeat===mySeat?'你胜':g.winnerSeat?'对手胜':'分出胜负'):g.outcome?.kind==='draw'?'和棋':'开局取消';
  const colorTag=g.outcome?.kind==='win'?`（${colorName(g.outcome.color)}）`:'';
  return `<div class="online-history-item"><span>第${g.round}局 · <b>${text}${colorTag}</b></span><span class="online-history-item-btns"><button type="button" data-save-round="${g.round}">存库</button><button type="button" data-export-round="${g.round}">导出</button></span></div>`;
 }).join(''):'<p class="online-history-empty">首局结束后可点“再来一局”，战绩与每局棋谱会自动记录。</p>';
}
function render(){
 if(!room||!match)return;const me=credentials?.actor??room.me,s=match.state,v=phaseText(match),round=room.round??1;
 $('room-code').textContent=room.code;$('room-round-badge').textContent=`第${round}局`;
 $('online-rules').innerHTML=ruleLabels(match.rules).map(x=>`<span>${esc(x)}</span>`).join('');
 $('online-title').textContent=!room.joined.B?'等待对手加入':v.title;
 $('online-detail').textContent=!room.joined.B?'复制房间码或邀请链接发给对手，对方加入后立即开始。':v.detail;
 $('online-phase').textContent=s.outcome?`第${round}局结束`:room.pending?'等待双方确认':`好友对战 · 第${round}局`;
 $('online-your-role').textContent=s.owners?`你本局${colorName(actorColor(match,me))}。`:`你本局担任${me==='A'?'摆局方（A）':'选色方（B）'}。`;
 $('online-board-caption').textContent=inspect?'查气模式':s.outcome?'终局棋盘':room.joined.B?v.title:'等待对手加入';$('online-ply').textContent=`第${s.ply}手`;
 const canOperate=!!credentials&&connected&&!busy&&room.joined.B&&!room.pending&&!s.outcome;
 const turn=canOperate&&activePlayer(match)===me;
 const canPlace=turn&&['opening','playing'].includes(s.phase.kind);
 const ghostColor=canPlace&&!inspect?(s.phase.kind==='opening'?(s.phase.placed===1?'white':'black'):s.phase.toMove):null;
 const illegalPoints=canPlace&&!inspect?computeIllegalPoints(match,me):null;
 const group=renderBoard($('board'),match,{labels,inspect,selected:point,ghostColor,illegalPoints,zoom:boardZoom,onPoint:inspect?p=>{point=p;render();}:canPlace?p=>move({kind:'place',actor:me,point:p}):null});
 $('online-zoom').value=boardZoom;
 $('online-inspect').setAttribute('aria-pressed',inspect);$('online-labels').setAttribute('aria-pressed',labels);$('online-inspection').hidden=!inspect;
 $('online-inspection').textContent=group?`${colorName(group.color)}：${group.stones.length}子，${group.liberties.length}口气。`:'点击棋子查看整块与气，不会落子。';
 $('online-choices').hidden=s.phase.kind!=='choose';for(const id of ['online-black','online-white'])$(id).disabled=!turn||s.phase.kind!=='choose';
 $('online-rematch-wrap').hidden=!s.outcome||!room.joined.B;
 $('online-rematch').disabled=!credentials||!connected||busy||!!room.pending;
 $('online-rematch').textContent=s.outcome?.kind==='cancelled'?'重新开一局':'再来一局（轮换先后）';
 $('online-pass').disabled=!turn||s.phase.kind!=='playing';$('online-undo').disabled=!canOperate||!match.accepted.length;
 $('online-end').disabled=!canOperate;$('online-end').textContent=['opening','choose'].includes(s.phase.kind)?'申请取消开局':'认输';
 renderClaims($('online-claims'),match);renderHistory();renderConsent();renderConnection();
}
function renderConsent(){
 const p=room.pending,el=$('online-consent');el.hidden=!p;if(!p)return;
 const mySeat=mySeatOf(),own=p.bySeat?p.bySeat===mySeat:p.by===credentials?.actor;
 const what=p.kind==='undo'?'撤回最后两手操作':p.kind==='rematch'?'开启下一局（再来一局）':'取消本次开局';
 const desc=p.kind==='undo'?'不足两手时撤回一手，选色也算一次操作。':p.kind==='rematch'?'同意后保留本局成绩并立即开启下一局（胜负或和棋后双方轮换先后）。':'双方同意后取消，不记录胜负。';
 el.innerHTML=`<h3>${own?'等待对方同意':'对方请求'}${what}</h3><p>${desc}</p><div class="consent-buttons">${own?'<button data-consent="withdraw">撤回申请</button>':'<button data-consent="accept">同意</button><button data-consent="reject">拒绝</button>'}</div>`;
 for(const b of el.querySelectorAll('button'))b.disabled=busy||!connected;
}
async function command(payload){
 if(!credentials||!room||busy)return;busy=true;render();
 try{
  const r=await api('/api/rooms/'+credentials.code+'/command',{method:'POST',body:{...payload,revision:room.revision,commandId:uuid()}});
  if(payload.kind==='move'){
   if(payload.action?.kind==='place')playSound('stone');
  }
  acceptRoom(r.room);message('');
 }catch(e){message(e.name==='AbortError'?'这次请求未收到确认，正在核对服务器棋盘，请勿重复落子。':e.message);
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
 clearInterval(clockTick);clockTick=null;
 const seats=savedSeats();$('resume-rooms').hidden=!seats.length;
 $('resume-list').innerHTML=seats.map((s,i)=>`<span class="resume-chip"><button type="button" data-resume="${i}">${esc(s.code)} · 恢复对局</button><button type="button" class="resume-remove" data-remove-seat="${i}" aria-label="移除 ${esc(s.code)}">×</button></span>`).join('');
 $('resume-list').onclick=e=>{
  const rm=e.target.closest('[data-remove-seat]');
  if(rm){const idx=Number(rm.dataset.removeSeat);const next=seats.filter((_,k)=>k!==idx);writeSeats(next);renderLobby();return;}
  const b=e.target.closest('[data-resume]');if(b)restore(seats[Number(b.dataset.resume)]);
 };
}
function enter(next,playerToken){
 clearTimeout(timer);credentials={code:next.code,actor:next.me,seat:next.seat??next.me,token:playerToken};room=null;match=null;
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
 try{const r=await api('/api/rooms',{method:'POST',body:{rules},token:null});enter(r.room,r.playerToken);message('房间已创建，可复制房间码或邀请链接发给对手。');}catch(e){message(e.name==='AbortError'?'创建房间未收到确认，请稍后再试。':e.message);}finally{lobbyBusy(false);if(room)render();}
};
$('join-room').onsubmit=async e=>{
 e.preventDefault();if(busy)return;const f=e.currentTarget,id=f.elements.code.value.trim().toUpperCase();
 if(!/^[A-HJ-NP-Z2-9]{8}$/.test(id)){message('请输入八位房间码，不含I、O、0、1。');return;}lobbyBusy(true);
 try{const r=await api('/api/rooms/'+id+'/join',{method:'POST',body:{},token:null});enter(r.room,r.playerToken);message('已加入房间，身份与棋谱已保存。');}catch(e){message(e.name==='AbortError'?'加入房间未收到确认，请稍后再试。':e.message);}finally{lobbyBusy(false);if(room)render();}
};
$('clear-resume').onclick=()=>{writeSeats([]);renderLobby();message('已清空本机保存的历史房间列表。');};
$('online-black').onclick=()=>move({kind:'choose-color',actor:credentials.actor,color:'black'});$('online-white').onclick=()=>move({kind:'choose-color',actor:credentials.actor,color:'white'});
$('online-pass').onclick=()=>move({kind:'pass',actor:credentials.actor});$('online-undo').onclick=()=>command({kind:'request-undo'});
$('online-rematch').onclick=()=>command({kind:'request-rematch'});
$('online-end').onclick=()=>['opening','choose'].includes(match.state.phase.kind)?command({kind:'request-cancel'}):$('resign-dialog').showModal();
for(const id of ['resign-close','resign-cancel'])$(id).onclick=()=>$('resign-dialog').close();
$('resign-confirm').onclick=()=>{$('resign-dialog').close();move({kind:'resign',actor:credentials.actor});};
$('online-consent').onclick=e=>{const v=e.target.closest('[data-consent]')?.dataset.consent;if(!v)return;command(v==='withdraw'?{kind:'cancel-request'}:{kind:'respond',requestId:room.pending.id,accept:v==='accept'});};
$('online-history-list').onclick=async e=>{
 const saveBtn=e.target.closest('[data-save-round]');
 if(saveBtn){const g=room.pastGames?.find(x=>String(x.round)===saveBtn.dataset.saveRound);if(g){const saved=await persistOnlineRound(room,null,g,false);if(saved)message(`已将第 ${g.round} 局保存到本机棋谱库。`);}return;}
 const rn=e.target.closest('[data-export-round]')?.dataset.exportRound;if(!rn)return;
 const g=room.pastGames?.find(x=>String(x.round)===rn);
 if(g)downloadJSON({type:'qiline-test-records',schemaVersion:1,games:[{id:`online:${room.code}:${room.createdAt}:r${g.round}`,title:`在线房间 ${room.code} 第${g.round}局`,record:g.record,status:'terminal',players:{A:{name:'摆局方'},B:{name:'选色方'}},searches:[]}]},`弈合_在线对局_${room.code}_第${g.round}局.json`);
};
$('online-inspect').onclick=()=>{inspect=!inspect;point=null;render();};$('online-labels').onclick=()=>{labels=!labels;render();};
$('online-zoom').onchange=e=>{boardZoom=e.target.value;try{localStorage.setItem(ZOOM_KEY,boardZoom);}catch{}render();};
$('sound-toggle').onclick=()=>{const m=toggleMuted();renderSoundBtn();if(!m)playSound('stone');};
$('copy-code').onclick=async()=>{try{await navigator.clipboard.writeText(room.code);message(`房间码 ${room.code} 已复制。`);}catch{message('房间码：'+room.code);}};
$('copy-invite').onclick=async()=>{const link=location.origin+'/online.html?room='+room.code;try{await navigator.clipboard.writeText(link);message('邀请链接已复制。');}catch{message('请复制邀请链接：'+link);}};
$('room-lobby-back').onclick=()=>{clearTimeout(timer);clearInterval(clockTick);clockTick=null;credentials=null;room=null;match=null;try{sessionStorage.removeItem(CURRENT);}catch{}history.replaceState(null,'',location.pathname);message('身份仍保存在本机，可随时恢复房间。');renderLobby();};
$('online-save-library').onclick=async()=>{if(!room||!match)return;const saved=await persistOnlineRound(room,match,null,false);if(saved)message(`已将第 ${room.round??1} 局保存到本机棋谱库，可前往“棋谱复盘”逐步查看或 AI 推演。`);};
$('online-export').onclick=()=>downloadJSON({type:'qiline-test-records',schemaVersion:1,games:[{id:`online:${room.code}:${room.createdAt}:r${room.round??1}`,title:`在线房间 ${room.code} 第${room.round??1}局`,record:room.record,status:match.state.outcome?'terminal':'unfinished',players:{A:{name:'摆局方'},B:{name:'选色方'}},searches:[]}]},`弈合_在线对局_${room.code}_第${room.round??1}局.json`);
window.addEventListener('pagehide',()=>{clearTimeout(timer);clearInterval(clockTick);});
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&credentials){clearTimeout(timer);poll();}});
installCornerManual();renderSoundBtn();renderLobby();const invited=new URL(location.href).searchParams.get('room')?.toUpperCase();if(invited)$('join-code').value=invited.slice(0,8);
try{const current=JSON.parse(sessionStorage.getItem(CURRENT)??'null');if(current&&(!invited||current.code===invited)&&savedSeats().some(s=>s.code===current.code&&s.token===current.token))restore(current);}catch{}
