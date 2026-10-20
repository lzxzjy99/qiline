import {DEFAULT_RULES, activePlayer, formatPoint, inspectGroup} from './core/src/index.js';
import {createSession} from './session/src/index.js';
import {SAVE_KEY, SafeStorage, makeWebSave, parseWebSave, phaseView, rulesView, claimsView, playerName, colorName, other, errorText} from './ui/model.mjs';

const $=id=>document.getElementById(id);
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid=()=>typeof crypto.randomUUID==='function'?crypto.randomUUID():Array.from(crypto.getRandomValues(new Uint32Array(4)),n=>n.toString(16).padStart(8,'0')).join('-');
let session=null, meta={names:['玩家一','玩家二'],aIndex:0,round:1};
let inspect=false, labels=false, selected=null, focusPoint=40, flash=[], noticeTimer;
let storageObject;
try {storageObject=window.localStorage;} catch {storageObject={getItem(){throw Error('storage unavailable');},setItem(){throw Error('storage unavailable');}};}
const storage=new SafeStorage(storageObject);
const startupRaw=storage.read();
let badStartup=null, startupNote='';
if (startupRaw) {
  const restored=parseWebSave(startupRaw,uid());
  if (restored.ok) {session=restored.value.session;meta=restored.value.players;startupNote='已恢复上次对局；未完成的同意请求需重新发起。';}
  else {badStartup=startupRaw;storage.warning=errorText(restored.error)+' 可导出原文件留存。';}
}

function notice(message,error=false) {
  clearTimeout(noticeTimer);$('notice').textContent=message;$('notice').classList.toggle('error',error);$('notice').hidden=false;
  noticeTimer=setTimeout(()=>$('notice').hidden=true,error?6500:3800);
}
const live=()=>session && !session.state.match.state.outcome;
const match=()=>session?.state.match;
function save() {
  if (!session) return;
  storage.write(JSON.stringify(makeWebSave(session,meta,uid())));
}
function mayChange() {
  if (storage.check()) return true;
  notice(errorText({code:'STORAGE_CONFLICT'}),true);render();return false;
}
function operate(fn,success) {
  if (!session || !mayChange()) return;
  const before=session.state.match;
  const result=fn();
  if (!result.ok) {notice(errorText(result.error),true);return;}
  const after=session.state.match;
  selected=null;
  flash=after.state.placements>before.state.placements?[...after.state.lastCaptured]:[];
  save();render();
  if (success) notice(success);
  const delta=after.state.ply-before.state.ply;
  const last=after.accepted.at(-1);
  const automatic=delta-((last?.kind==='place'||last?.kind==='pass')?1:0);
  if (automatic>0) notice(`已自动停手 ${automatic} 次（无合法落点），计时已同步结算。`);
  if (flash.length) setTimeout(()=>{flash=[];renderBoard();},750);
}
function renderRules() {
  $('rules-summary').innerHTML=rulesView(match()?.rules).map(s=>`<span>${esc(s)}</span>`).join('');
}
function renderBoard() {
  const m=match(),n=m?.rules.boardSize??9,s=m?.state;
  const oldFocus=document.activeElement?.closest?.('#board')?Number(document.activeElement.dataset.point??focusPoint):null;
  const board=$('board');board.style.setProperty('--n',n);board.style.minWidth=n>=15?`${n===19?530:430}px`:'310px';
  board.setAttribute('aria-label',`${n}路棋盘，${inspect?'查气模式':'落子模式'}。方向键移动，Enter或空格确认。`);
  board.setAttribute('aria-rowcount',String(n));board.setAttribute('aria-colcount',String(n));
  const pad=38,step=(600-pad*2)/(n-1),xy=p=>[pad+(p%n)*step,pad+(n-1-Math.floor(p/n))*step];
  let svg='<svg viewBox="0 0 600 600" aria-hidden="true"><g class="grid-lines">';
  for(let i=0;i<n;i++) {const a=pad+i*step;svg+=`<path d="M${pad} ${a}H${600-pad} M${a} ${pad}V${600-pad}"/>`;}
  svg+='</g>';
  const star=n===9?[2,4,6]:n===13?[3,6,9]:n===15?[3,7,11]:[3,9,15];
  for(const y of star)for(const x of star)svg+=`<circle class="star-point" cx="${pad+x*step}" cy="${pad+y*step}" r="2.5"/>`;
  for(let i=0;i<n;i++) {
    const a=pad+i*step;
    svg+=`<text class="coordinate" x="${a}" y="21">${String.fromCharCode(65+i)}</text><text class="coordinate" x="${a}" y="589">${String.fromCharCode(65+i)}</text><text class="coordinate" x="17" y="${a+5}">${n-i}</text><text class="coordinate" x="584" y="${a+5}">${n-i}</text>`;
  }
  for(const c of s?.claims??[]) if(c.points.length) {
    const a=xy(c.points[0]),b=xy(c.points.at(-1));svg+=`<path class="claim-line" d="M${a[0]} ${a[1]}L${b[0]} ${b[1]}"/>`;
  }
  svg+='</svg>';
  let group=null;
  if (s && selected!==null) {const r=inspectGroup(m,selected);if(r.ok)group=r.value;}
  const stones=new Set(group?.stones??[]),libs=new Set(group?.liberties??[]);
  const canPlay=!!m && !s.outcome && !session.state.paused && ['opening','playing'].includes(s.phase.kind) && !storage.conflict;
  focusPoint=Math.min(focusPoint,n*n-1);
  // Rows are displayed from highest coordinate to 1; points retain core row-major indexing.
  let html=svg;
  for(let y=n-1;y>=0;y--) {
    html+='<div role="row">';
    for(let x=0;x<n;x++) {
      const p=y*n+x,[xx,yy]=xy(p),cell=s?.board[p]??0,color=cell===1?'black':'white',coord=formatPoint(p,n);
      const isLast=cell && s.lastPlacement===p;
      const aria=`${coord}，${cell?colorName(color)+'，第'+s.moveLabels[p]+'子':'空点'}${libs.has(p)?'，气':''}`;
      html+=`<button role="gridcell" type="button" data-point="${p}" aria-label="${aria}" tabindex="${p===focusPoint?0:-1}" class="cell keyboard-focus ${stones.has(p)?'selected':''} ${libs.has(p)?'liberty':''} ${flash.includes(p)?'flash-capture':''}" style="left:${xx/6}%;top:${yy/6}%;width:${Math.min(48,step*.95)/6}%;height:${Math.min(48,step*.95)/6}%;" ${!inspect&&!canPlay?'disabled':''}>${cell?`<span class="stone ${color} ${isLast?'last':''} ${labels?'with-label':''}">${labels?s.moveLabels[p]:''}</span>`:''}</button>`;
    }
    html+='</div>';
  }
  board.innerHTML=html;
  if(oldFocus!==null)board.querySelector(`[data-point="${Math.min(oldFocus,n*n-1)}"]`)?.focus({preventScroll:true});
  $('inspect-toggle').setAttribute('aria-pressed',String(inspect));$('labels-toggle').setAttribute('aria-pressed',String(labels));
  $('board-help').textContent=inspect?'查气模式 · 点棋子查看，不会落子':'交叉点落子 · 方向键移动 / Enter 确认';
  $('inspect-info').hidden=!inspect;
  $('inspect-info').textContent=group?`${colorName(group.color)}棋块：${group.stones.length} 子，${group.liberties.length} 口气。绿圈为空气点。`:'查气模式：点任一棋子查看整块与气；再次点击“查气”返回落子。';
}
function render() {
  const m=match(),s=m?.state,v=phaseView(m,meta),active=v.actor;
  renderRules();renderBoard();
  $('board-caption').textContent=!m?'准备开局':s.outcome?'终局棋盘':inspect?'查气 · 不会落子':v.title;
  $('move-count').textContent=`第 ${meta.round} 局${m?` · ${s.ply} 手 / ${s.placements} 子`:''}`;
  $('phase-label').textContent=!m?'一起开局':s.outcome?'本局结束':session.state.consent?'等待对方同意':s.phase.kind==='opening'?'01 / 三手换色':s.phase.kind==='choose'?'02 / 选择执色':'对局进行中';
  $('turn-title').textContent=v.title;$('turn-detail').textContent=v.detail;
  $('first-start').hidden=!!m&&!s.outcome;$('first-start').textContent=m?'再下一局 →':'开始对局 →';
  $('choice-actions').hidden=s?.phase.kind!=='choose';
  for(const id of ['choose-black','choose-white'])$(id).disabled=!!session?.state.paused||storage.conflict;
  $('players').innerHTML=['A','B'].map(p=>{
    const color=s?.owners?(s.owners.black===p?'black':'white'):null;
    return `<div class="player-row ${active===p?'active':''}">${color?`<i class="stone-dot ${color}"></i>`:`<span class="role-dot">${p}</span>`}<div class="player-text"><b>${esc(playerName(meta,p))}</b><small>${p}${m?.rules.swap3!==false?` · ${p==='A'?'摆局方':'选色方'}`:''}${color?` · ${colorName(color)}`:''}</small></div><span class="player-captures">提子<strong>${color?s.captures[color]:'—'}</strong></span></div>`;
  }).join('');
  const ended=!m||!!s.outcome,paused=!!session?.state.paused;
  $('pass-btn').disabled=ended||paused||s?.phase.kind!=='playing'||storage.conflict;
  $('undo-btn').disabled=ended||paused||!!session?.state.competitive||!m?.accepted.length||storage.conflict;
  $('end-btn').disabled=ended||storage.conflict;
  $('end-btn').textContent=s?.phase.kind==='opening'||s?.phase.kind==='choose'?'双方取消开局':'认输';
  $('export-btn').disabled=!m;$('import-btn').disabled=!!live()||storage.conflict;
  $('save-status').textContent=storage.conflict?'存在冲突':storage.warning?'请手动导出':m?'已自动保存':'尚未开局';
  const cs=m?claimsView(m):[];
  $('mobile-status').hidden=ended;
  const nearest=['black','white'].flatMap(color=>{const group=cs.filter(c=>c.color===color);return group.length?[`${colorName(color)} ${group.length}组 · 最近 ${Math.min(...group.map(c=>c.remaining))} 手`]:[];});
  $('mobile-status').textContent=`${paused?'等待对方同意':inspect?'查气模式 · '+v.title:v.title}${nearest.length?' ｜ '+nearest.join(' / '):''}`;
  $('claim-count').textContent=cs.length?`${cs.length} 组候选`:'暂无候选';
  $('claims').innerHTML=cs.length?cs.map(c=>`<details class="claim-item"><summary><i class="stone-dot ${c.color}"></i><span>${colorName(c.color)}${m.rules.claimMode==='fixed-five'?'五子组':'持续成五'}</span><strong>${c.remaining} <small>手</small></strong></summary><p>${esc(c.coordinates||'只要同色五连持续存在，允许换线接替。')}<br>形成于第 ${c.formedAt} 手 · 确认点 ${c.dueAt} 手</p></details>`).join(''):`<p class="empty-claims">${s?.outcome?'本局已结束，可查看棋盘或开始新局。':`成五只是开始。<br>${m?.rules.confirmationDelay===0?'本局成五即胜。':`保持连线满 ${m?.rules.confirmationDelay??4} 手，才确认胜利。`}`}</p>`;
  const c=session?.state.consent;
  $('consent-panel').hidden=!c;
  if(c) {
    const responder=other(c.requester),text=c.kind==='undo'?'撤回最后一条操作':'取消本次开局';
    $('consent-panel').innerHTML=`<h3>请${esc(playerName(meta,responder))}回应</h3><p>${esc(playerName(meta,c.requester))}申请${text}。请将设备交给对方。</p><div class="consent-buttons"><button data-consent="no">不同意</button><button data-consent="yes">同意${c.kind==='undo'?'悔棋':'取消'}</button></div>`;
  }
  renderRecords();renderWarning();
}
function renderRecords() {
  const m=match();let label=0;
  const items=(m?.accepted??[]).map((a,i)=>{
    let text=a.kind==='place'?`第 ${++label} 子 · ${formatPoint(a.point,m.rules.boardSize)}`:a.kind==='pass'?'停手':a.kind==='choose-color'?`选择${colorName(a.color)}`:a.kind==='resign'?'认输':'双方取消开局';
    return `<li value="${i+1}">${esc(playerName(meta,a.actor))} · ${text}</li>`;
  });
  $('move-list').innerHTML=items.slice(-120).join('');
}
function renderWarning() {
  $('storage-warning').hidden=!storage.warning;
  $('storage-warning').textContent=storage.warning;
  if (badStartup) {const b=document.createElement('button');b.textContent='导出原存档';b.onclick=()=>download(badStartup,'弈合_原始存档.json');$('storage-warning').append(b);}
}
function onPoint(p) {
  focusPoint=p;
  if(inspect) {selected=p;renderBoard();return;}
  const m=match();if(!m) {openSettings();return;}
  if(session.state.paused) {notice('请先由对方回应同意请求。');return;}
  const actor=activePlayer(m);if(!actor)return;
  operate(()=>session.submit(actor,{kind:'place',actor,point:p}));
}
$('board').addEventListener('click',e=>{const b=e.target.closest('[data-point]');if(b)onPoint(Number(b.dataset.point));});
$('board').addEventListener('keydown',e=>{
  const n=match()?.rules.boardSize??9;let p=Number(e.target.dataset.point??focusPoint),x=p%n,y=Math.floor(p/n);
  if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(e.key)) {
    e.preventDefault();if(e.key==='ArrowLeft')x=Math.max(0,x-1);if(e.key==='ArrowRight')x=Math.min(n-1,x+1);if(e.key==='ArrowUp')y=Math.min(n-1,y+1);if(e.key==='ArrowDown')y=Math.max(0,y-1);if(e.key==='Home')x=0;if(e.key==='End')x=n-1;
    focusPoint=y*n+x;for(const b of $('board').querySelectorAll('[data-point]'))b.tabIndex=Number(b.dataset.point)===focusPoint?0:-1;
    $('board').querySelector(`[data-point="${focusPoint}"]`)?.focus({preventScroll:true});
  } else if(e.key==='Enter'||e.key===' ') {e.preventDefault();onPoint(p);}
});
$('inspect-toggle').onclick=()=>{inspect=!inspect;selected=null;render();};
$('labels-toggle').onclick=()=>{labels=!labels;renderBoard();};
$('pass-btn').onclick=()=>{const actor=activePlayer(match());operate(()=>session.submit(actor,{kind:'pass',actor}));};
for(const color of ['black','white'])$('choose-'+color).onclick=()=>operate(()=>session.submit('B',{kind:'choose-color',actor:'B',color}));
$('consent-panel').addEventListener('click',e=>{
  const b=e.target.closest('[data-consent]'),c=session?.state.consent;if(!b||!c)return;
  operate(()=>session.respondToConsent(other(c.requester),c.id,b.dataset.consent==='yes'),b.dataset.consent==='yes'?'对方已同意，操作已完成。':'对方未同意，继续原局。');
});

function actorDialog(kind) {
  const m=match();if(!m||m.state.outcome)return;
  const opening=['opening','choose'].includes(m.state.phase.kind),request=kind==='undo'?'申请悔棋':opening?'申请取消开局':'认输';
  $('action-title').textContent=`谁要${request}？`;
  $('action-body').innerHTML=`<p class="dialog-note">${kind==='undo'?'每次撤回最后一条玩家命令，须另一位玩家同意。':opening?'双方同意后取消，不记胜负。':'任一方都可随时认输，确认后本局结束。'}</p><div class="actor-options">${['A','B'].map(p=>`<button data-actor="${p}">${esc(playerName(meta,p))}（${p}）${request}</button>`).join('')}</div>`;
  $('action-body').onclick=e=>{
    const actor=e.target.closest('[data-actor]')?.dataset.actor;if(!actor)return;
    if(kind==='undo'||opening) {
      $('action-dialog').close();operate(()=>kind==='undo'?session.requestUndo(actor):session.requestCancelOpening(actor));return;
    }
    $('action-title').textContent=`确认${playerName(meta,actor)}认输？`;
    $('action-body').innerHTML='<p class="dialog-note">对方将立即获胜，终局后不能悔棋。</p><div class="confirm-resign"><button id="resign-back">继续对局</button><button id="resign-confirm" class="danger">确认认输</button></div>';
    $('resign-back').onclick=()=>$('action-dialog').close();
    $('resign-confirm').onclick=()=>{$('action-dialog').close();operate(()=>session.submit(actor,{kind:'resign',actor}));};
  };
  $('action-dialog').showModal();
}
$('undo-btn').onclick=()=>actorDialog('undo');$('end-btn').onclick=()=>actorDialog('end');

function populateSettings(defaults=false) {
  const f=$('settings-form'),r=defaults?DEFAULT_RULES:match()?.rules??DEFAULT_RULES;
  for(const radio of f.elements.boardSize)radio.checked=Number(radio.value)===r.boardSize;
  f.elements.confirmationDelay.value=r.confirmationDelay;f.elements.directions.value=r.directions;
  f.elements.swap3.checked=r.swap3;f.elements.superko.checked=r.superko==='positional';f.elements.pressure.checked=r.claimMode==='color-pressure';
  f.elements.competitive.checked=defaults?false:session?.state.competitive??false;
  f.elements.player1.value=meta.names[0];f.elements.player2.value=meta.names[1];explainDelay();
}
function openSettings() {
  populateSettings();const locked=!!live()||storage.conflict;
  $('settings-lock').hidden=!locked;$('settings-lock').textContent=storage.conflict?errorText({code:'STORAGE_CONFLICT'}):'当前局仍在进行。此处可查看选项；请先正常结束，或双方同意取消开局，再确认新局。';
  $('start-game').disabled=locked;
  $('role-explain').textContent=session?`续局将轮换 A / B 角色；${meta.names[1-meta.aIndex]}担任 A。A 摆局，B 选色；关闭换色时 A 执黑先行。`:'首局随机分配 A / B。A 摆局，B 选色；关闭换色时 A 执黑先行。';
  $('settings-dialog').showModal();
}
function explainDelay() {
  const delay=Number($('settings-form').elements.confirmationDelay.value);
  $('delay-explain').textContent=delay?`成五后，对手有 ${delay/2} 次拆线机会，第 ${delay} 手确认。形成当手不计入。`:'成五当手获胜，没有额外拆线机会。';
}
$('settings-open').onclick=openSettings;$('first-start').onclick=openSettings;
$('reset-settings').onclick=()=>populateSettings(true);$('settings-form').elements.confirmationDelay.onchange=explainDelay;
$('settings-form').onsubmit=e=>{
  e.preventDefault();if(live()||!mayChange())return;
  const f=e.currentTarget,rules={...DEFAULT_RULES,boardSize:Number(f.elements.boardSize.value),confirmationDelay:Number(f.elements.confirmationDelay.value),directions:f.elements.directions.value,swap3:f.elements.swap3.checked,superko:f.elements.superko.checked?'positional':'off',claimMode:f.elements.pressure.checked?'color-pressure':'fixed-five'};
  const names=[f.elements.player1.value.trim(),f.elements.player2.value.trim()];if(names.some(n=>!n)){notice('请填写双方的名字。',true);return;}
  const result=createSession({matchId:uid(),rules,competitive:f.elements.competitive.checked});
  if(!result.ok){notice(errorText(result.error),true);return;}
  const previous=!!session;session?.close();session=result.value;
  meta={names,aIndex:previous?1-meta.aIndex:crypto.getRandomValues(new Uint8Array(1))[0]%2,round:previous?meta.round+1:1};
  inspect=false;selected=null;focusPoint=Math.floor(rules.boardSize*rules.boardSize/2);flash=[];
  save();$('settings-dialog').close();render();notice(`本局 A：${playerName(meta,'A')}；B：${playerName(meta,'B')}。`);
};
for(const b of document.querySelectorAll('[data-close]'))b.onclick=()=>$(b.dataset.close).close();
for(const id of ['manual-open','rules-details'])$(id).onclick=()=>$('manual-dialog').showModal();
function download(content,name) {
  const blob=new Blob([content],{type:'application/json;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
$('export-btn').onclick=()=>{if(session)download(JSON.stringify(makeWebSave(session,meta,uid()),null,2),`弈合_第${meta.round}局_${new Date().toISOString().slice(0,10)}.json`);};
$('import-btn').onclick=()=>$('import-file').click();
$('import-file').onchange=async e=>{
  const file=e.target.files[0];e.target.value='';if(!file)return;
  if(file.size>5*1024*1024){notice(errorText({code:'FILE_TOO_LARGE'}),true);return;}
  let raw;try{raw=await file.text();}catch{notice('无法读取此文件，当前局已保留。',true);return;}
  const result=parseWebSave(raw,uid());
  if(!result.ok){notice(errorText(result.error),true);return;}
  if(live()){notice(errorText({code:'WRONG_PHASE'}),true);return;}
  if(!mayChange())return;
  session?.close();session=result.value.session;meta=result.value.players;inspect=false;selected=null;flash=[];
  save();render();notice('存档已完整校验并恢复。');
};
window.addEventListener('storage',e=>{if(e.key===SAVE_KEY && e.newValue!==storage.raw){storage.conflict=true;storage.warning=errorText({code:'STORAGE_CONFLICT'});render();}});
render();if(startupNote)notice(startupNote);
