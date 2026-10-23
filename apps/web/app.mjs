import {DEFAULT_RULES, activePlayer, formatPoint, inspectGroup} from './core/src/index.js';
import {createBrowserAI} from './ui/ai-host.mjs';
import {createAIThinkingClock, formatThinkingTime} from './ui/ai-timing.mjs';
import {SAVE_KEY, SafeStorage, createGameSession, practiceView, undoPracticePair, respondUndoPair, localCalendarDate, makeWebSave, parseWebSave, phaseView, rulesView, claimsView, playerName, colorName, levelName, other, errorText} from './ui/model.mjs';

const $=id=>document.getElementById(id);
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid=()=>typeof crypto.randomUUID==='function'?crypto.randomUUID():Array.from(crypto.getRandomValues(new Uint32Array(4)),n=>n.toString(16).padStart(8,'0')).join('-');
let session=null, meta={names:['玩家一','玩家二'],aIndex:0,round:1};
let ai=null, aiState=null, restoreHold=false, observedMatch=null, replaceAction=null;
let inspect=false, labels=false, selected=null, focusPoint=40, flash=[], noticeTimer;
const thinkingClock=createAIThinkingClock();
let thinkingTick=null;
let storageObject;
try {storageObject=window.localStorage;} catch {storageObject={getItem(){throw Error('storage unavailable');},setItem(){throw Error('storage unavailable');}};}
const storage=new SafeStorage(storageObject);
const startupRaw=storage.read();
let badStartup=null, startupNote='';
if (startupRaw) {
  const restored=parseWebSave(startupRaw,uid());
  if (restored.ok) {session=restored.value.session;meta=restored.value.players;startupNote=practiceView(session)?'已恢复人机对局。确认棋盘后点击“继续对局”。':'已恢复上次对局；未完成的同意请求需重新发起。';restoreHold=!!practiceView(session);}
  else {badStartup=startupRaw;storage.warning=errorText(restored.error)+' 可导出原文件留存。';}
}

function notice(message,error=false) {
  clearTimeout(noticeTimer);$('notice').textContent=message;$('notice').classList.toggle('error',error);$('notice').hidden=false;
  noticeTimer=setTimeout(()=>$('notice').hidden=true,error?6500:3800);
}
const live=()=>session && !session.state.match.state.outcome;
const match=()=>session?.state.match;
const practice=()=>session?practiceView(session):null;
const humanTurn=()=>!!match()&&session.state.controllers[activePlayer(match())]?.kind==='human';
const replaceable=()=>!live()||!!practice();
function attachAI(restored=false) {
  clearTimeout(thinkingTick);thinkingTick=null;thinkingClock.reset();
  aiState=null;observedMatch=match();restoreHold=restored&&!!practice()&&!!live();
  if(!practice())return;
  const owned=session;let announcedError=null;
  const result=createBrowserAI(owned,state=>{
    if(session!==owned||state.status==='closed')return;
    aiState=state;
    thinkingClock.sync({match:owned.state.match,matchId:owned.state.matchId,aiActor:practice().aiActor,status:state.status});
    if(!storage.check()&&!owned.state.paused){ai?.pause();render();return;}
    const current=match();
    if(state.status==='failed'&&!storage.conflict&&state.error!==announcedError){
      announcedError=state.error;notice(`AI 未能完成这一手${state.retryAttempt?'，已自动重试 '+state.retryAttempt+' 次':''}。${errorText(state.error??{code:'AI_WORKER_FAILED'})}`,true);
    }else if(!['failed','retrying'].includes(state.status))announcedError=null;
    // The Worker clock is already running: update only cheap status text before posting.
    if(current===observedMatch&&['starting','thinking','retrying'].includes(state.status)){renderAI();return;}
    if(current!==observedMatch){
      flash=current.state.placements>observedMatch.state.placements?[...current.state.lastCaptured]:[];
      observedMatch=current;selected=null;save();
      if(flash.length)setTimeout(()=>{flash=[];renderBoard();},750);
    }
    render();
  },undefined,()=>storage.check());
  if(!result.ok){session.setPaused(true);aiState={status:'failed',error:result.error};notice(errorText(result.error),true);return;}
  ai=result.value;
  if(restoreHold||storage.conflict)ai.pause();else ai.start();
  aiState=ai.state;
}
function releaseSession(){clearTimeout(thinkingTick);thinkingTick=null;thinkingClock.reset();const oldAI=ai;ai=null;aiState=null;if(oldAI)oldAI.close();else session?.close();}
function installSession(next,players,restored=false){
  releaseSession();session=next;meta=players;inspect=false;selected=null;flash=[];
  focusPoint=Math.floor(match().rules.boardSize**2/2);attachAI(restored);save();render();
}
function confirmReplacement(action,label){
  if(!live()||!practice()){action();return;}
  replaceAction=action;$('replace-title').textContent=label;
  $('replace-dialog').showModal();
}
function save() {
  if (!session) return;
  storage.write(JSON.stringify(makeWebSave(session,meta,uid())));
}
function mayChange() {
  if (storage.check()) return true;
  ai?.pause();notice(errorText({code:'STORAGE_CONFLICT'}),true);render();return false;
}
function operate(fn,success) {
  if (!session || !mayChange()) return;
  const before=session.state.match;
  const result=ai?ai.change(fn):fn();
  if (!result.ok) {notice(errorText(result.error),true);return;}
  const after=session.state.match;
  selected=null;
  flash=after.state.placements>before.state.placements?[...after.state.lastCaptured]:[];
  if(observedMatch!==after){observedMatch=after;save();}render();
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
  const canPlay=!!m && !s.outcome && !session.state.paused && humanTurn() && ['opening','playing'].includes(s.phase.kind) && !storage.conflict;
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
  const m=match(),s=m?.state,v=phaseView(m,meta),active=v.actor,p=practice();
  renderRules();renderBoard();
  $('board-caption').textContent=!m?'准备开局':s.outcome?'终局棋盘':inspect?'查气 · 不会落子':v.title;
  $('move-count').textContent=`第 ${meta.round} 局${m?` · ${s.ply} 手 / ${s.placements} 子`:''}`;
  $('phase-label').textContent=!m?'一起开局':s.outcome?'本局结束':session.state.consent?'等待对方同意':s.phase.kind==='opening'?'01 / 三手换色':s.phase.kind==='choose'?'02 / 选择执色':'对局进行中';
  $('turn-title').textContent=v.title;$('turn-detail').textContent=v.detail;
  $('first-start').hidden=!!m&&!s.outcome;$('first-start').textContent=m?'再下一局 →':'开始对局 →';
  $('choice-actions').hidden=s?.phase.kind!=='choose'||!humanTurn();
  for(const id of ['choose-black','choose-white'])$(id).disabled=!!session?.state.paused||!humanTurn()||storage.conflict;
  $('mode-label').textContent=p?`人机练习 · ${levelName(p.level)}`:'本地双人';
  $('play-context').textContent=p?`本地人机 · 你是 ${p.humanActor} · ${m.rules.swap3?(p.humanActor==='A'?'摆局方':'选色方'):(p.humanActor==='A'?'执黑先行':'执白')}`:'同一设备，双方轮流操作';
  renderAI();
  $('players').innerHTML=['A','B'].map(p=>{
    const color=s?.owners?(s.owners.black===p?'black':'white'):null;
    const controller=session?.state.controllers[p];
    return `<div class="player-row ${active===p?'active':''}">${color?`<i class="stone-dot ${color}"></i>`:`<span class="role-dot">${p}</span>`}<div class="player-text"><b>${esc(playerName(meta,p))}${controller?.kind==='ai'?'<span class="ai-badge">AI</span>':''}</b><small>${p}${m?.rules.swap3!==false?` · ${p==='A'?'摆局方':'选色方'}`:''}${color?` · ${colorName(color)}`:''}</small></div><span class="player-captures">提子<strong>${color?s.captures[color]:'—'}</strong></span></div>`;
  }).join('');
  const ended=!m||!!s.outcome,paused=!!session?.state.paused;
  $('pass-btn').disabled=ended||paused||!humanTurn()||s?.phase.kind!=='playing'||storage.conflict;
  const recoveryPaused=p&&['retrying','failed'].includes(aiState?.status);
  $('undo-btn').disabled=ended||(paused&&!recoveryPaused)||!!session?.state.competitive||!m?.accepted.length||storage.conflict;
  $('undo-btn').textContent=p?'悔棋两手':'申请悔棋';
  $('end-btn').disabled=ended||storage.conflict;
  $('end-btn').textContent=s?.phase.kind==='opening'||s?.phase.kind==='choose'?'双方取消开局':'认输';
  $('end-btn').textContent=p&&['opening','choose'].includes(s?.phase.kind)?'取消开局':$('end-btn').textContent;
  $('export-btn').disabled=!m;$('import-btn').disabled=!replaceable()||storage.conflict;
  $('save-status').textContent=storage.conflict?'存在冲突':storage.warning?'请手动导出':m?'已自动保存':'尚未开局';
  const cs=m?claimsView(m):[];
  $('mobile-status').hidden=ended;
  const nearest=['black','white'].flatMap(color=>{const group=cs.filter(c=>c.color===color);return group.length?[`${colorName(color)} ${group.length}组 · 最近 ${Math.min(...group.map(c=>c.remaining))} 手`]:[];});
  $('mobile-status-text').textContent=`${p&&aiState?.status==='failed'?'AI 未能行棋，请点击“重试 AI”':p&&aiState?.status==='retrying'?'AI 正在思考':paused?(p?'人机对局已暂停':'等待对方同意'):p&&!humanTurn()?'AI 正在思考 · '+v.title:inspect?'查气模式 · '+v.title:v.title}${nearest.length?' ｜ '+nearest.join(' / '):''}`;
  $('claim-count').textContent=cs.length?`${cs.length} 组候选`:'暂无候选';
  $('claims').innerHTML=cs.length?cs.map(c=>`<details class="claim-item"><summary><i class="stone-dot ${c.color}"></i><span>${colorName(c.color)}${m.rules.claimMode==='fixed-five'?'五子组':'持续成五'}</span><strong>${c.remaining} <small>手</small></strong></summary><p>${esc(c.coordinates||'只要同色五连持续存在，允许换线接替。')}<br>形成于第 ${c.formedAt} 手 · 确认点 ${c.dueAt} 手</p></details>`).join(''):`<p class="empty-claims">${s?.outcome?'本局已结束，可查看棋盘或开始新局。':`成五只是开始。<br>${m?.rules.confirmationDelay===0?'本局成五即胜。':`保持连线满 ${m?.rules.confirmationDelay??4} 手，才确认胜利。`}`}</p>`;
  const c=session?.state.consent;
  $('consent-panel').hidden=!c;
  if(c) {
    const responder=other(c.requester),text=c.kind==='undo'?`撤回最后 ${Math.min(2,m.accepted.length)} 手操作`:'取消本次开局';
    $('consent-panel').innerHTML=`<h3>请${esc(playerName(meta,responder))}回应</h3><p>${esc(playerName(meta,c.requester))}申请${text}。请将设备交给对方。</p><div class="consent-buttons"><button data-consent="no">不同意</button><button data-consent="yes">同意${c.kind==='undo'?'悔棋':'取消'}</button></div>`;
  }
  renderRecords();renderWarning();
}
function renderThinkingTime(){
  clearTimeout(thinkingTick);thinkingTick=null;
  const t=thinkingClock.snapshot,p=practice();
  const text=t.elapsedMs!==null?`本手已思考 ${formatThinkingTime(t.elapsedMs)}`:t.lastElapsedMs!==null?`上一手用时 ${formatThinkingTime(t.lastElapsedMs)}`:'';
  $('ai-elapsed').hidden=!p||!text;$('ai-elapsed').textContent=text;
  $('mobile-ai-elapsed').hidden=!p||!text;$('mobile-ai-elapsed').textContent=text?` ｜ ${text}`:'';
  if(p&&live()&&t.running)thinkingTick=setTimeout(renderThinkingTime,100);
}
function renderAI(){
  renderThinkingTime();
  const p=practice(),ended=!live();$('ai-panel').hidden=!p||(ended&&thinkingClock.snapshot.lastElapsedMs===null);
  if(!p||$('ai-panel').hidden)return;
  const status=aiState?.status??'failed',recovering=status==='retrying',paused=!!session.state.paused&&!recovering,failed=status==='failed';
  $('ai-indicator').classList.toggle('thinking',!ended&&['starting','thinking','retrying'].includes(status));
  $('ai-status').textContent=ended?'本局已结束':storage.conflict?'存档冲突，AI 已停止':restoreHold?'存档已恢复，等待继续':failed?'AI 未能完成这一手':aiState?.hold==='undo'?'已悔棋，等待继续 AI 回合':paused?'对局已暂停':status==='starting'?'AI 准备中':status==='thinking'||recovering?'AI 正在思考':humanTurn()?'轮到你了':'AI 即将行动';
  $('ai-detail').textContent=ended?'已保留本局最后一次 AI 思考用时。':failed?`${aiState?.retryAttempt?'已自动重试 '+aiState.retryAttempt+' 次。':''}${errorText(aiState?.error??{code:'AI_WORKER_FAILED'})}`:restoreHold?'已恢复角色、难度和完整棋谱；继续后再开始新的思考。':aiState?.hold==='undo'?'已撤回操作，AI 不会立即重下。':paused?'棋盘已锁定，查气和导出仍可使用。':p.level==='hard'?'困难 AI 每手最多思考 2 分钟。思考时可查气、暂停或导出存档。':'AI 在本机运行。思考时可查气、暂停或结束对局。';
  $('ai-controls').hidden=ended;
  $('ai-pause').hidden=paused||failed;$('ai-resume').hidden=!paused||failed;$('ai-retry').hidden=!failed;
  for(const id of ['ai-pause','ai-resume','ai-retry'])$(id).disabled=storage.conflict||!ai;
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
  if(session.state.paused) {notice(practice()?'请先点击“继续对局”。':'请先由对方回应同意请求。');return;}
  if(!humanTurn()){notice('现在由 AI 操作，请等它完成这一手。');return;}
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
  operate(()=>respondUndoPair(session,other(c.requester),c.id,b.dataset.consent==='yes'),b.dataset.consent==='yes'?'对方已同意，操作已完成。':'对方未同意，继续原局。');
});

function actorDialog(kind) {
  const m=match();if(!m||m.state.outcome)return;
  const opening=['opening','choose'].includes(m.state.phase.kind),request=kind==='undo'?'申请悔棋':opening?'申请取消开局':'认输';
  const p=practice();
  if(p){
    if(kind==='undo'){
      const count=Math.min(2,m.accepted.length);
      operate(()=>{
        if(session.state.paused&&['retrying','failed'].includes(aiState?.status))session.setPaused(false);
        return undoPracticePair(session);
      },`已撤回最后 ${count} 手操作及其自动动作。`);return;
    }
    $('action-title').textContent=opening?'确认取消开局？':'确认认输？';
    $('action-body').innerHTML=`<p class="dialog-note">${opening?'取消本次人机开局，不记胜负。':'确认后 AI 获胜，本局结束。'}</p><div class="confirm-resign"><button id="practice-back">继续查看</button><button id="practice-end" class="danger">${opening?'取消开局':'确认认输'}</button></div>`;
    $('practice-back').onclick=()=>$('action-dialog').close();
    $('practice-end').onclick=()=>{
      $('action-dialog').close();
      operate(()=>{
        // Cancellation is a single synchronous command; never resume the scheduler between steps.
        if(opening&&session.state.paused)session.setPaused(false);
        return opening?session.requestCancelOpening(p.humanActor):session.submit(p.humanActor,{kind:'resign',actor:p.humanActor});
      });
    };
    $('action-dialog').showModal();return;
  }
  $('action-title').textContent=`谁要${request}？`;
  $('action-body').innerHTML=`<p class="dialog-note">${kind==='undo'?'每次撤回最后两手操作及其自动动作；不足两手则撤回一手，须另一位玩家同意。':opening?'双方同意后取消，不记胜负。':'任一方都可随时认输，确认后本局结束。'}</p><div class="actor-options">${['A','B'].map(p=>`<button data-actor="${p}">${esc(playerName(meta,p))}（${p}）${request}</button>`).join('')}</div>`;
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
  const p=practice();f.elements.mode.value=defaults?'pvp':p?'practice':'pvp';
  f.elements.level.value=defaults?'standard':p?.level??'standard';
  f.elements.humanActor.value=defaults?'A':p?.humanActor??'A';
  f.elements.player1.value=p?playerName(meta,p.humanActor):meta.names[0];f.elements.player2.value=p?'玩家二':meta.names[1];explainDelay();explainMode();
}
function openSettings() {
  populateSettings();const locked=!replaceable()||storage.conflict;
  $('settings-lock').hidden=!locked;$('settings-lock').textContent=storage.conflict?errorText({code:'STORAGE_CONFLICT'}):'当前局仍在进行。此处可查看选项；请先正常结束，或双方同意取消开局，再确认新局。';
  $('start-game').disabled=locked;
  $('settings-dialog').showModal();
}
function explainMode(){
  const f=$('settings-form'),isPractice=f.elements.mode.value==='practice';
  $('practice-settings').hidden=!isPractice;$('player2-label').hidden=isPractice;
  f.elements.player2.required=!isPractice;f.elements.competitive.disabled=isPractice;
  if(isPractice)f.elements.competitive.checked=false;
  $('player1-label-text').textContent=isPractice?'你的名字':'玩家一';
  const role=f.elements.humanActor.value;
  $('role-explain').textContent=isPractice?`${role==='A'?'你担任 A，AI 担任 B。':role==='B'?'AI 担任 A，你担任 B。':'开局时随机分配你与 AI 的 A / B。'}${f.elements.swap3.checked?'A 连摆黑白黑三子，B 选色；选色后身份不变。':'不换色：A 执黑先行，B 执白。'} 人机练习不启用竞技模式。`:session?`双人续局轮换 A / B；${[f.elements.player1.value,f.elements.player2.value][1-meta.aIndex]}担任 A。A 摆局，B 选色；关闭换色时 A 执黑先行。`:'双人首局随机分配 A / B。A 摆局，B 选色；关闭换色时 A 执黑先行。';
}
function explainDelay() {
  const delay=Number($('settings-form').elements.confirmationDelay.value);
  $('delay-explain').textContent=delay?`成五后，对手有 ${delay/2} 次拆线机会，第 ${delay} 手确认。形成当手不计入。`:'成五当手获胜，没有额外拆线机会。';
}
$('settings-open').onclick=openSettings;$('first-start').onclick=openSettings;
$('reset-settings').onclick=()=>populateSettings(true);$('settings-form').elements.confirmationDelay.onchange=explainDelay;
$('settings-form').addEventListener('change',e=>{if(['mode','humanActor','swap3'].includes(e.target.name))explainMode();});
$('settings-form').onsubmit=e=>{
  e.preventDefault();if(!replaceable()||!mayChange())return;
  const f=e.currentTarget,rules={...DEFAULT_RULES,boardSize:Number(f.elements.boardSize.value),confirmationDelay:Number(f.elements.confirmationDelay.value),directions:f.elements.directions.value,swap3:f.elements.swap3.checked,superko:f.elements.superko.checked?'positional':'off',claimMode:f.elements.pressure.checked?'color-pressure':'fixed-five'};
  const mode=f.elements.mode.value,isPractice=mode==='practice';
  const names=[f.elements.player1.value.trim(),isPractice?'弈合 AI':f.elements.player2.value.trim()];if(names.some(n=>!n)){notice('请填写双方的名字。',true);return;}
  const humanActor=f.elements.humanActor.value==='random'?(crypto.getRandomValues(new Uint8Array(1))[0]%2?'A':'B'):f.elements.humanActor.value;
  const result=createGameSession({matchId:uid(),rules,mode,level:f.elements.level.value,humanActor,seed:crypto.getRandomValues(new Uint32Array(1))[0],competitive:isPractice?false:f.elements.competitive.checked});
  if(!result.ok){notice(errorText(result.error),true);return;}
  const players={names,aIndex:isPractice?(humanActor==='A'?0:1):session?1-meta.aIndex:crypto.getRandomValues(new Uint8Array(1))[0]%2,round:session?meta.round+1:1};
  $('settings-dialog').close();
  confirmReplacement(()=>{installSession(result.value,players);notice(`本局 A：${playerName(meta,'A')}；B：${playerName(meta,'B')}。`);},'重新开始人机练习？');
};
for(const b of document.querySelectorAll('[data-close]'))b.onclick=()=>$(b.dataset.close).close();
for(const id of ['manual-open','rules-details'])$(id).onclick=()=>$('manual-dialog').showModal();
function download(content,name) {
  const blob=new Blob([content],{type:'application/json;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
$('export-btn').onclick=()=>{if(session)download(JSON.stringify(makeWebSave(session,meta,uid()),null,2),`弈合_第${meta.round}局_${localCalendarDate()}.json`);};
$('import-btn').onclick=()=>$('import-file').click();
$('import-file').onchange=async e=>{
  const file=e.target.files[0];e.target.value='';if(!file)return;
  if(file.size>5*1024*1024){notice(errorText({code:'FILE_TOO_LARGE'}),true);return;}
  let raw;try{raw=await file.text();}catch{notice('无法读取此文件，当前局已保留。',true);return;}
  const result=parseWebSave(raw,uid());
  if(!result.ok){notice(errorText(result.error),true);return;}
  if(!replaceable()){result.value.session.close();notice(errorText({code:'WRONG_PHASE'}),true);return;}
  if(!mayChange())return;
  confirmReplacement(()=>{installSession(result.value.session,result.value.players,true);notice(practice()?'人机存档已恢复，点击“继续对局”开始。':'存档已完整校验并恢复。');},'载入另一份存档？');
};
for(const [id,method] of [['ai-pause','pause'],['ai-resume','resume'],['ai-retry','retry']])$(id).onclick=()=>{
  if(!ai||!mayChange())return;restoreHold=false;const result=ai[method]();if(!result.ok)notice(errorText(result.error),true);aiState=ai.state;render();
};
$('replace-confirm').onclick=()=>{const action=replaceAction;replaceAction=null;$('replace-dialog').close();if(mayChange()&&replaceable())action?.();};
$('replace-dialog').addEventListener('close',()=>{replaceAction=null;});
window.addEventListener('storage',e=>{if((e.key===SAVE_KEY||e.key===null)&&e.newValue!==storage.raw){storage.conflict=true;storage.warning=errorText({code:'STORAGE_CONFLICT'});ai?.pause();render();}});
window.addEventListener('pagehide',()=>releaseSession());
window.addEventListener('pageshow',e=>{if(e.persisted)window.location.reload();});
attachAI(restoreHold);render();if(startupNote)notice(startupNote);
