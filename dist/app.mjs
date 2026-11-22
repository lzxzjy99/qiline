import {DEFAULT_RULES, activePlayer, applyAction, formatPoint, inspectGroup} from './core/src/index.js';
import {createBrowserAI, detectHardwareCapabilities, PERF_MODES} from './ui/ai-host.mjs';
import {createAIThinkingClock, formatThinkingTime} from './ui/ai-timing.mjs';
import {SAVE_KEY, SafeStorage, createGameSession, practiceView, undoPracticePair, respondUndoPair, localCalendarDate, makeWebSave, parseWebSave, phaseView, rulesView, claimsView, colorName, sideColorLabel, levelName, other, errorText} from './ui/model.mjs';
import {isMuted, toggleMuted, playSound, notifyTurnArrival} from './features/sound.mjs';
import {installCornerManual} from './features/manual-widget.mjs';
import {formatAdvisedAction, formatEvalSummary, runAdvisorySearch, saveGameRecordToLibrary} from './features/board-ai.mjs';

const $=id=>document.getElementById(id);
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid=()=>typeof crypto.randomUUID==='function'?crypto.randomUUID():Array.from(crypto.getRandomValues(new Uint32Array(4)),n=>n.toString(16).padStart(8,'0')).join('-');
const PERF_KEY='qiline.perfMode', EVAL_HIDDEN_KEY='qiline.evalHidden', ZOOM_KEY='qiline.boardZoom', ADVISORY_KEY='qiline.advisoryEnabled', ADVISORY_MATCHES_KEY='qiline.advisoryMatches', HANDOFF_KEY='qiline.handoff', REPLAY_TARGET_KEY='qiline.replayTarget';

let session=null, meta={names:['执黑','执白'],aIndex:0,round:1};
let ai=null, aiState=null, aiTelemetry=null, restoreHold=false, observedMatch=null, replaceAction=null;
let inspect=false, labels=false, selected=null, focusPoint=40, flash=[], noticeTimer;
let boardZoom='fit', evalHidden=false, advisoryEnabled=true, lastEvalScore=null, advisory=null, advisoryJob=null, advisoryBusy=false;
const illegalLabels={OCCUPIED:'已有棋子',SUICIDE:'无气自杀点',REPETITION:'禁重复局面',OPENING_CAPTURE:'摆局不能提子'};
let illegalCacheKey='', illegalCacheMap=new Map();

const thinkingClock=createAIThinkingClock();
let thinkingTick=null;
let storageObject;
try {storageObject=window.localStorage;} catch {storageObject={getItem(){throw Error('storage unavailable');},setItem(){throw Error('storage unavailable');}};}
const storage=new SafeStorage(storageObject);
const hwCaps=detectHardwareCapabilities();
let perfMode='turbo';
try {
  const savedPerf=storageObject.getItem(PERF_KEY);if(PERF_MODES.includes(savedPerf))perfMode=savedPerf;
  const savedZoom=storageObject.getItem(ZOOM_KEY);if(['fit','compact','large'].includes(savedZoom))boardZoom=savedZoom;
  evalHidden=storageObject.getItem(EVAL_HIDDEN_KEY)==='1';
  const savedAdv=storageObject.getItem(ADVISORY_KEY);if(savedAdv==='0'||savedAdv==='1')advisoryEnabled=savedAdv==='1';
} catch {}
function readAdvisoryMatch(matchId){
  if(!matchId)return advisoryEnabled;
  try{
    const map=JSON.parse(storageObject.getItem(ADVISORY_MATCHES_KEY)??'{}');
    if(map&&typeof map==='object'&&typeof map[matchId]==='boolean')return map[matchId];
  }catch{}
  return advisoryEnabled;
}
function writeAdvisoryMatch(matchId,allowed){
  advisoryEnabled=!!allowed;
  try{
    storageObject.setItem(ADVISORY_KEY,advisoryEnabled?'1':'0');
    if(matchId){
      const prev=JSON.parse(storageObject.getItem(ADVISORY_MATCHES_KEY)??'{}');
      const entries=Object.entries(prev&&typeof prev==='object'?prev:{}).filter(([k])=>k!==matchId).slice(-49);
      entries.push([matchId,advisoryEnabled]);
      storageObject.setItem(ADVISORY_MATCHES_KEY,JSON.stringify(Object.fromEntries(entries)));
    }
  }catch{}
}
const advisoryAllowed=()=>!!match()&&readAdvisoryMatch(session?.state.matchId);
function fmtCount(n){if(!n||n<0)return '0';if(n>=1000000)return (n/1000000).toFixed(2)+'M';if(n>=1000)return Math.round(n/1000)+'k';return String(n);}

// Offline Electron mode: open the web online-rooms page in the user's browser.
try {
  const isOfflineDesktop=typeof window!=='undefined'&&window.location?.protocol==='qiline:';
  const onlineLink=$('online-nav-link');
  if(isOfflineDesktop&&onlineLink){
    onlineLink.setAttribute('href','https://qiline-online.pages.dev/online.html');
    onlineLink.setAttribute('title','在默认浏览器中打开在线对战网页版');
    onlineLink.onclick=e=>{
      e.preventDefault();
      if(typeof window.qilineDesktop?.openOnline==='function')window.qilineDesktop.openOnline();
      else notice('请使用浏览器访问 https://qiline-online.pages.dev/online.html 进行好友联机。');
    };
  }
} catch {}

let handoffRaw=null;
try {
  handoffRaw=storageObject.getItem(HANDOFF_KEY);
  if(handoffRaw){
    if(typeof storageObject.removeItem==='function')storageObject.removeItem(HANDOFF_KEY);
    else storageObject.setItem(HANDOFF_KEY,'');
  }
} catch {}

const startupRaw=handoffRaw?null:storage.read();
let badStartup=null, startupNote='';
if(handoffRaw){
  try {
    const payload=JSON.parse(handoffRaw);
    const restored=parseWebSave(payload.save,uid());
    if(restored.ok){
      session=restored.value.session;meta=restored.value.players;
      restoreHold=!!practiceView(session);
      startupNote=payload.note||(practiceView(session)?'已从棋谱指定位置载入，点击“继续对局”由 AI 接手或落子。':'已从棋谱指定位置载入，可继续双人对局。');
    }
  } catch {}
}
if(!session && startupRaw) {
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

function clearAdvisory(){
  if(advisoryJob){advisoryJob.cancel();advisoryJob=null;}
  advisoryBusy=false;advisory=null;
}

function illegalPointsFor(m,actor){
  if(!m||!actor||m.state.outcome||!['opening','playing'].includes(m.state.phase.kind))return illegalCacheMap.size?(illegalCacheMap=new Map()):illegalCacheMap;
  const key=`${m.accepted.length}:${m.state.ply}:${actor}:${m.state.phase.placed??''}`;
  if(key===illegalCacheKey)return illegalCacheMap;
  const map=new Map(),n=m.rules.boardSize,board=m.state.board;
  for(let p=0;p<n*n;p++){
    if(board[p]!==0)continue;
    const r=applyAction(m,{kind:'place',actor,point:p});
    if(!r.ok)map.set(p,illegalLabels[r.error.code]??'当前不可落子');
  }
  illegalCacheKey=key;illegalCacheMap=map;return map;
}

async function persistLibraryRecord(silent=true){
  const m=match();if(!m||!session||typeof indexedDB==='undefined')return null;
  try{
    const p=practice();
    const players={
      A:{name:'执黑',...(p&&p.aiActor==='A'?{version:`弈合 AI（${levelName(p.level)}）`}:{})},
      B:{name:'执白',...(p&&p.aiActor==='B'?{version:`弈合 AI（${levelName(p.level)}）`}:{})},
    };
    const title=`${p?`人机(${levelName(p.level)})`:'本地双人'} · ${m.rules.boardSize}路 第${meta.round}局`;
    const saved=await saveGameRecordToLibrary({
      id:`local:${session.state.matchId}`,
      title,
      record:session.exportSave().record,
      outcome:m.state.outcome,
      players,
    });
    if(!silent)notice('已保存到本机棋谱库，可在“棋谱复盘”查看或续下。');
    return saved;
  }catch(e){
    if(!silent)notice(e.message||'未能保存到棋谱库。',true);
    return null;
  }
}

function attachAI(restored=false) {
  clearTimeout(thinkingTick);thinkingTick=null;thinkingClock.reset();
  aiState=null;aiTelemetry=null;lastEvalScore=null;observedMatch=match();restoreHold=restored&&!!practice()&&!!live();
  clearAdvisory();
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
    if(current===observedMatch&&['starting','thinking','retrying'].includes(state.status)){renderAI();return;}
    if(current!==observedMatch){
      const prev=observedMatch;
      flash=current.state.placements>prev.state.placements?[...current.state.lastCaptured]:[];
      observedMatch=current;selected=null;clearAdvisory();save();
      if(current.state.outcome){notifyTurnArrival('win');persistLibraryRecord(true);}
      else if(current.state.claims.length>prev.state.claims.length)notifyTurnArrival('claim');
      else notifyTurnArrival(flash.length?'capture':'notify');
      if(flash.length)setTimeout(()=>{flash=[];renderBoard();},750);
    }
    render();
  },undefined,()=>storage.check(),{
    perfMode,
    onTelemetry:info=>{
      if(session!==owned)return;
      aiTelemetry=info;
      if(Number.isFinite(info?.score))lastEvalScore=info.score;
      renderTelemetry();
    },
  });
  if(!result.ok){session.setPaused(true);aiState={status:'failed',error:result.error};notice(errorText(result.error),true);return;}
  ai=result.value;
  if(restoreHold||storage.conflict)ai.pause();else ai.start();
  aiState=ai.state;
}

function releaseSession(){clearTimeout(thinkingTick);thinkingTick=null;thinkingClock.reset();clearAdvisory();const oldAI=ai;ai=null;aiState=null;aiTelemetry=null;if(oldAI)oldAI.close();else session?.close();}
function installSession(next,players,restored=false){
  releaseSession();session=next;meta=players;inspect=false;selected=null;flash=[];
  advisoryEnabled=readAdvisoryMatch(next?.state?.matchId);
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
  selected=null;clearAdvisory();
  flash=after.state.placements>before.state.placements?[...after.state.lastCaptured]:[];
  if(observedMatch!==after){
    observedMatch=after;save();
    if(after.state.outcome){playSound('win');persistLibraryRecord(true);}
    else if(after.state.claims.length>before.state.claims.length)playSound('claim');
    else if(after.state.placements>before.state.placements)playSound(flash.length?'capture':'stone');
  }
  render();
  if (success) notice(success);
  const delta=after.state.ply-before.state.ply;
  const last=after.accepted.at(-1);
  const automatic=delta-((last?.kind==='place'||last?.kind==='pass')?1:0);
  if (automatic>0) notice(`已自动停手 ${automatic} 次（无合法落点），计时已同步结算。`);
  if (flash.length) setTimeout(()=>{flash=[];renderBoard();},750);
}

function isHardNine(){const m=match(),p=practice();return !!p&&p.level==='hard'&&!!m&&m.rules.boardSize===9&&m.rules.directions==='diagonal'&&m.rules.confirmationDelay===4&&m.rules.claimMode==='fixed-five'&&m.rules.superko==='positional';}

function renderRules() {
  const m=match(),p=practice();
  $('rules-summary').innerHTML=rulesView(m?.rules).map(s=>`<span>${esc(s)}</span>`).join('');
  const badge=$('ai-kernel-badge');
  if(!p||p.level!=='hard'){badge.hidden=true;return;}
  badge.hidden=false;
  const nnue=isHardNine();
  badge.classList.toggle('fallback',!nnue);
  if(!nnue){badge.textContent='通用规则深算内核（v26 限默认 9 路）';return;}
  const bk=aiTelemetry?.backend;
  if(perfMode==='standard'){badge.textContent='Gen-7 NNUE v5 · v26 WASM 单核';return;}
  if(bk==='webgpu'||aiTelemetry?.gpuAvailable){badge.textContent='Gen-7 · v26 WebGPU GPU 神经 MCTS';return;}
  if(bk==='native'||aiTelemetry?.nativeAvailable){badge.textContent='Gen-7 NNUE v5 · v26 原生 AVX2 多核';return;}
  badge.textContent=hwCaps.sabSupported?'Gen-7 NNUE v5 · v26 WASM 多核':'Gen-7 NNUE v5 · v26 WASM 单核';
}

function renderBoard() {
  const m=match(),n=m?.rules.boardSize??9,s=m?.state;
  const oldFocus=document.activeElement?.closest?.('#board')?Number(document.activeElement.dataset.point??focusPoint):null;
  const board=$('board');board.style.setProperty('--n',n);
  const baseMin=n>=15?(n===19?530:430):300;
  board.style.minWidth=boardZoom==='large'?`${Math.max(baseMin,640)}px`:boardZoom==='compact'?`${Math.min(baseMin,340)}px`:`${baseMin}px`;
  board.style.maxWidth=boardZoom==='compact'?'460px':boardZoom==='large'?'760px':'100%';
  $('zoom-select').value=boardZoom;
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
  const actor=m?activePlayer(m):null;
  const canPlay=!!m && !s.outcome && !session.state.paused && humanTurn() && ['opening','playing'].includes(s.phase.kind) && !storage.conflict;
  const ghostColor=canPlay&&!inspect?(s.phase.kind==='opening'?(s.phase.placed===1?'white':'black'):s.phase.toMove):null;
  const illegalMap=canPlay&&!inspect?illegalPointsFor(m,actor):null;
  const advisedPoint=advisory?.action?.kind==='place'&&!s.outcome?advisory.action.point:null;
  focusPoint=Math.min(focusPoint,n*n-1);
  let html=svg;
  for(let y=n-1;y>=0;y--) {
    html+='<div role="row">';
    for(let x=0;x<n;x++) {
      const p=y*n+x,[xx,yy]=xy(p),cell=s?.board[p]??0,color=cell===1?'black':'white',coord=formatPoint(p,n);
      const isLast=cell && s.lastPlacement===p;
      const illegalReason=!cell&&illegalMap?.get(p);
      const isAdvised=advisedPoint===p&&!cell;
      const ghostHtml=!cell&&ghostColor&&!illegalReason?`<span class="ghost-stone ${ghostColor}"></span>`:'';
      const adviseHtml=isAdvised?'<span class="advised-mark" aria-hidden="true">★</span>':'';
      const titleAttr=illegalReason?` title="${esc(illegalReason)}"`:isAdvised?' title="AI 推荐着点"':'';
      const aria=`${coord}，${cell?colorName(color)+'，第'+s.moveLabels[p]+'子':illegalReason||'空点'}${libs.has(p)?'，气':''}${isAdvised?'，AI推荐':''}`;
      html+=`<button role="gridcell" type="button" data-point="${p}" aria-label="${aria}"${titleAttr} tabindex="${p===focusPoint?0:-1}" class="cell keyboard-focus ${stones.has(p)?'selected':''} ${libs.has(p)?'liberty':''} ${illegalReason?'illegal':''} ${isAdvised?'advised':''} ${flash.includes(p)?'flash-capture':''}" style="left:${xx/6}%;top:${yy/6}%;width:${Math.min(48,step*.95)/6}%;height:${Math.min(48,step*.95)/6}%;" ${!inspect&&!canPlay?'disabled':''}>${cell?`<span class="stone ${color} ${isLast?'last':''} ${labels?'with-label':''}">${labels?s.moveLabels[p]:''}</span>`:ghostHtml}${adviseHtml}</button>`;
    }
    html+='</div>';
  }
  board.innerHTML=html;
  if(oldFocus!==null)board.querySelector(`[data-point="${Math.min(oldFocus,n*n-1)}"]`)?.focus({preventScroll:true});
  $('inspect-toggle').setAttribute('aria-pressed',String(inspect));$('labels-toggle').setAttribute('aria-pressed',String(labels));
  $('board-help').textContent=inspect?'查气模式 · 点棋子查看，不会落子':'方向键移动 / Enter落子 · I查气 L手数 P停手 Z悔棋';
  $('inspect-info').hidden=!inspect;
  $('inspect-info').textContent=group?`${colorName(group.color)}棋块：${group.stones.length} 子，${group.liberties.length} 口气。绿圈为空气点。`:'查气模式：点任一棋子查看整块与气；再次点击“查气”返回落子。';
}

function renderEvalAndProgress(){
  const m=match(),box=$('eval-box'),track=$('ai-progress-track'),fill=$('ai-progress-fill');
  const activeScore=advisory?.score??lastEvalScore;
  const summary=Number.isFinite(activeScore)&&m?formatEvalSummary(activeScore,m):null;
  if(!summary||evalHidden){
    if(!summary)box.hidden=true;
    else{
      box.hidden=false;
      $('eval-headline').textContent='局势优势条已隐藏';
      $('eval-toggle').textContent='显示优势条';
      $('eval-bar-fill').style.width='50%';
      $('eval-left').textContent='—';$('eval-right').textContent='—';
    }
  }else{
    box.hidden=false;
    $('eval-toggle').textContent='隐藏优势条';
    $('eval-headline').textContent=summary.headline;
    $('eval-bar-fill').style.width=`${summary.pct}%`;
    $('eval-left').textContent=summary.leftLabel;
    $('eval-right').textContent=summary.rightLabel;
  }
  const thinking=!!aiState&&['starting','thinking','retrying'].includes(aiState.status);
  track.hidden=!thinking;
  if(thinking&&aiTelemetry){
    const pct=aiTelemetry.depth>0?Math.min(96,Math.max(12,Math.round((aiTelemetry.depth/14)*100))):18;
    fill.style.width=`${pct}%`;
  }else if(thinking){
    fill.style.width='15%';
  }
}

function renderAdvisory(){
  const m=match(),card=$('advisory-card'),quick=$('advise-quick-btn'),allowed=advisoryAllowed();
  const blocked=!m||!!m.state.outcome||!allowed;
  card.hidden=!m||!allowed;
  quick.hidden=!m||!allowed;
  quick.disabled=blocked||advisoryBusy;
  $('advise-turn-btn').disabled=blocked||advisoryBusy;
  $('advise-swap-btn').disabled=blocked||advisoryBusy||m?.state.phase.kind!=='playing'||(m?.state.passStreak??0)>0;
  const res=$('advisory-result'),applyBtn=$('advise-apply-btn');
  if(!allowed||!advisory){
    res.hidden=true;applyBtn.hidden=true;return;
  }
  res.hidden=false;
  if(advisory.loading){
    res.innerHTML=`正在为<b>${advisory.targetLabel}</b>计算建议着法…`;
    applyBtn.hidden=true;
    return;
  }
  if(advisory.error){
    res.innerHTML=`<span class="danger">${esc(advisory.error)}</span>`;
    applyBtn.hidden=true;
    return;
  }
  const n=m.rules.boardSize,actionText=formatAdvisedAction(advisory.action,n);
  const ev=Number.isFinite(advisory.score)?formatEvalSummary(advisory.score,m):null;
  res.innerHTML=`<b>${esc(advisory.targetLabel)}</b>：${esc(actionText)}${ev?`<br><small>${esc(ev.headline)}</small>`:''}${advisory.elapsedMs?`<br><small>用时 ${(advisory.elapsedMs/1000).toFixed(1)} 秒${advisory.stats?.completedDepth?` · 深度 ${advisory.stats.completedDepth}`:''}</small>`:''}`;
  const canApply=!advisory.swapped&&!m.state.outcome&&!session?.state.paused&&humanTurn()&&advisory.targetActor===activePlayer(m);
  applyBtn.hidden=!canApply;
}

function renderSoundButton(){
  const btn=$('sound-toggle'),muted=isMuted();
  if(!btn)return;
  btn.setAttribute('aria-pressed',String(muted));
  btn.textContent=muted?'🔇 静音':'🔊 音效';
}

function render() {
  const m=match(),s=m?.state,v=phaseView(m,meta),p=practice();
  renderSoundButton();renderRules();renderBoard();
  $('board-caption').textContent=!m?'准备开局':s.outcome?'终局棋盘':inspect?'查气 · 不会落子':v.title;
  $('move-count').textContent=`第 ${meta.round} 局${m?` · ${s.ply} 手 / ${s.placements} 子`:''}`;
  $('phase-label').textContent=!m?'一起开局':s.outcome?'本局结束':session.state.consent?'等待对方同意':s.phase.kind==='opening'?'01 / 三手换色':s.phase.kind==='choose'?'02 / 选择执色':'对局进行中';
  $('turn-title').textContent=v.title;$('turn-detail').textContent=v.detail;
  $('first-start').hidden=!!m&&!s.outcome;$('first-start').textContent=m?'再下一局 →':'开始对局 →';
  $('choice-actions').hidden=s?.phase.kind!=='choose'||!humanTurn();
  for(const id of ['choose-black','choose-white'])$(id).disabled=!!session?.state.paused||!humanTurn()||storage.conflict;
  $('mode-label').textContent=p?`人机练习 · ${levelName(p.level)}`:'本地双人';
  $('play-context').textContent=p?`本地人机 · 你是 ${p.humanActor}（${m.rules.swap3?(p.humanActor==='A'?'摆局方':'选色方'):(p.humanActor==='A'?'执黑':'执白')}）`:'同一设备，双方轮流操作';
  renderAI();renderAdvisory();
  const active=v.actor;
  $('players').innerHTML=s?.owners
    ?['black','white'].map(color=>{
      const actorKey=s.owners[color];
      const controller=session?.state.controllers[actorKey];
      const badge=p?(controller?.kind==='ai'?'<span class="ai-badge">AI</span>':'<span class="ai-badge">你</span>'):'';
      const roleSub=m?.rules.swap3!==false?(actorKey==='A'?'摆局方 A':'选色方 B'):(color==='black'?'先手方':'后手方');
      return `<div class="player-row ${active===actorKey?'active':''}"><i class="stone-dot ${color}"></i><div class="player-text"><b>${sideColorLabel(color)}${badge}</b><small>${roleSub}</small></div><span class="player-captures">提子<strong>${s.captures[color]}</strong></span></div>`;
    }).join('')
    :['A','B'].map(actorKey=>{
      const controller=session?.state.controllers[actorKey];
      const badge=p?(controller?.kind==='ai'?'<span class="ai-badge">AI</span>':'<span class="ai-badge">你</span>'):'';
      const roleName=actorKey==='A'?'摆局方（A）':'选色方（B）';
      const roleSub=actorKey==='A'?'执色待定 · 摆黑白黑':'执色待定 · 选黑或白';
      return `<div class="player-row ${active===actorKey?'active':''}"><span class="role-dot">${actorKey}</span><div class="player-text"><b>${roleName}${badge}</b><small>${roleSub}</small></div><span class="player-captures">提子<strong>—</strong></span></div>`;
    }).join('');
  const ended=!m||!!s.outcome,paused=!!session?.state.paused;
  $('pass-btn').disabled=ended||paused||!humanTurn()||s?.phase.kind!=='playing'||storage.conflict;
  const recoveryPaused=p&&['retrying','failed'].includes(aiState?.status);
  $('undo-btn').disabled=ended||(paused&&!recoveryPaused)||!!session?.state.competitive||!m?.accepted.length||storage.conflict;
  $('undo-btn').textContent=p?'悔棋两手':'申请悔棋';
  $('end-btn').disabled=ended||storage.conflict;
  $('end-btn').textContent=s?.phase.kind==='opening'||s?.phase.kind==='choose'?'双方取消开局':'认输';
  $('end-btn').textContent=p&&['opening','choose'].includes(s?.phase.kind)?'取消开局':$('end-btn').textContent;
  $('save-library-btn').disabled=!m;$('export-btn').disabled=!m;$('import-btn').disabled=!replaceable()||storage.conflict;
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
    const sideOf=a=>s?.owners?(s.owners.black===a?'执黑方':'执白方'):(a==='A'?'摆局方（A）':'选色方（B）');
    $('consent-panel').innerHTML=`<h3>请${sideOf(responder)}回应</h3><p>${sideOf(c.requester)}申请${text}。请将设备交给对方。</p><div class="consent-buttons"><button data-consent="no">不同意</button><button data-consent="yes">同意${c.kind==='undo'?'悔棋':'取消'}</button></div>`;
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

function renderTelemetry(){
  renderEvalAndProgress();
  renderRules();
  const el=$('ai-telemetry');if(!el)return;
  const hard9=isHardNine(),ended=!live();
  if(!hard9){el.hidden=true;return;}
  const t=aiTelemetry;
  const bk=t?.backend;
  const threads=t?.threads??(perfMode==='standard'?1:(perfMode==='extreme'?hwCaps.extremeThreads:hwCaps.recommendedThreads));
  const ttMB=t?.ttMB??(perfMode==='standard'?14:hwCaps.ttMB);
  if(t?.pondering&&!ended){
    el.hidden=false;el.textContent=`后台预算中 · ${threads} 线程预热 ${ttMB}MB 缓存`;return;
  }
  if(bk==='webgpu'&&perfMode!=='standard'){
    el.hidden=false;
    const gpuTag=t?.gpuLabel?'WebGPU · '+t.gpuLabel:'WebGPU GPU';
    if(t&&t.totalNodes>0){
      const speed=t.nps>0?` · ${fmtCount(t.nps)} 模拟/秒`:'';
      const dep=t.depth>0?` · 深度 ${t.depth}`:'';
      el.textContent=`${gpuTag}${speed}${dep} · ${fmtCount(t.totalNodes)} 模拟`;
      return;
    }
    el.textContent=`就绪：${gpuTag} · 8×96 ResNet MCTS + 战术守护`;
    return;
  }
  if(bk==='native'&&perfMode!=='standard'){
    el.hidden=false;
    if(t&&t.totalNodes>0){
      const speed=t.nps>0?` · ${fmtCount(t.nps)} 节点/秒`:'';
      const dep=t.depth>0?` · 深度 ${t.depth}`:'';
      el.textContent=`原生 AVX2 ${threads} 核${speed}${dep} · ${fmtCount(t.totalNodes)} 节点 · ${ttMB}MB 缓存`;
      return;
    }
    el.textContent=`就绪：原生 AVX2 ${threads} 核并行 · ${ttMB}MB 共享缓存`;
    return;
  }
  if(t&&t.totalNodes>0){
    el.hidden=false;
    const speed=t.nps>0?` · ${fmtCount(t.nps)} 节点/秒`:'';
    const dep=t.depth>0?` · 深度 ${t.depth}`:'';
    el.textContent=`${threads} 线程${speed}${dep} · ${fmtCount(t.totalNodes)} 节点 · ${ttMB}MB 缓存`;
    return;
  }
  el.hidden=false;
  el.textContent=perfMode==='standard'?'单核常驻 · 标准 400 万节点上限（省电静音）':hwCaps.sabSupported?`就绪：${threads} 核并行 · ${ttMB}MB 共享缓存`:`单核满载（当前环境未开启多核隔离）`;
}

function renderAI(){
  renderThinkingTime();
  const p=practice(),ended=!live(),hasEval=Number.isFinite(advisory?.score??lastEvalScore);
  $('ai-panel').hidden=(!p||(ended&&thinkingClock.snapshot.lastElapsedMs===null))&&!hasEval;
  if($('ai-panel').hidden)return;
  if(!p){
    $('ai-indicator').classList.toggle('thinking',false);
    $('ai-status').textContent='双边 AI 推演分析';
    $('ai-detail').textContent='评估结果来自独立推演。';
    $('ai-perf-wrap').hidden=true;$('ai-controls').hidden=true;
    renderEvalAndProgress();
    return;
  }
  const status=aiState?.status??'failed',recovering=status==='retrying',paused=!!session.state.paused&&!recovering,failed=status==='failed';
  $('ai-indicator').classList.toggle('thinking',!ended&&['starting','thinking','retrying'].includes(status));
  $('ai-status').textContent=ended?'本局已结束':storage.conflict?'存档冲突，AI 已停止':restoreHold?'存档已恢复，等待继续':failed?'AI 未能完成这一手':aiState?.hold==='undo'?'已悔棋，等待继续 AI 回合':paused?'对局已暂停':status==='starting'?'AI 准备中':status==='thinking'||recovering?'AI 正在思考':humanTurn()?'轮到你了':'AI 即将行动';
  $('ai-detail').textContent=ended?'已保留本局最后一次 AI 思考用时。':failed?`${aiState?.retryAttempt?'已自动重试 '+aiState.retryAttempt+' 次。':''}${errorText(aiState?.error??{code:'AI_WORKER_FAILED'})}`:restoreHold?'已恢复角色、难度和完整棋谱；继续后再开始新的思考。':aiState?.hold==='undo'?'已撤回操作，AI 不会立即重下。':paused?'棋盘已锁定，查气和导出仍可使用。':p.level==='hard'?'困难 AI 每手最多思考 2 分钟。思考时可查气、暂停或导出存档。':'AI 在本机运行。思考时可查气、暂停或结束对局。';
  const perfWrap=$('ai-perf-wrap'),perfSelect=$('ai-perf-mode');
  if(perfWrap&&perfSelect){
    perfWrap.hidden=ended||!isHardNine();
    perfSelect.value=perfMode;
    perfSelect.disabled=storage.conflict||!ai;
  }
  renderTelemetry();
  $('ai-controls').hidden=ended;
  $('ai-pause').hidden=paused||failed;$('ai-resume').hidden=!paused||failed;$('ai-retry').hidden=!failed;
  for(const id of ['ai-pause','ai-resume','ai-retry'])$(id).disabled=storage.conflict||!ai;
}

function renderRecords() {
  const m=match();let label=0,owners=m&&!m.rules.swap3?{A:'black',B:'white'}:null;
  const items=(m?.accepted??[]).map((a,i)=>{
    let who=owners?(owners[a.actor]==='black'?'执黑':'执白'):(a.actor==='A'?'摆局方':'选色方');
    let text;
    if(a.kind==='place'){
      label++;
      if(!owners&&label<=3)who=label===2?'摆白':'摆黑';
      text=`第 ${label} 子 · ${formatPoint(a.point,m.rules.boardSize)}`;
    }else if(a.kind==='choose-color'){
      owners={[a.actor]:a.color,[other(a.actor)]:a.color==='black'?'white':'black'};
      text=`选择${sideColorLabel(a.color)}`;
    }else text=a.kind==='pass'?'停手':a.kind==='resign'?'认输':'双方取消开局';
    return `<li value="${i+1}"><button type="button" class="move-jump" data-step="${i+1}" title="点击跳转至复盘页第 ${i+1} 步">${i+1}. ${who} · ${text}</button></li>`;
  });
  $('move-list').innerHTML=items.join('');
}

function renderWarning() {
  $('storage-warning').hidden=!storage.warning;
  $('storage-warning').textContent=storage.warning;
  if (badStartup) {const b=document.createElement('button');b.textContent='导出原存档';b.onclick=()=>download(badStartup,'弈合_原始存档.json');$('storage-warning').append(b);}
}

async function requestAdvisory(swapSide=false){
  if(!advisoryAllowed())return;
  const m=match();if(!m||m.state.outcome||advisoryBusy)return;
  clearAdvisory();
  const lvl=$('advisory-level').value||'standard';
  const cur=activePlayer(m);
  const targetActor=swapSide?other(cur):cur;
  const targetLabel=m.state.owners?(m.state.owners.black===targetActor?'执黑':'执白'):(targetActor==='A'?'摆局方 A':'选色方 B');
  advisoryBusy=true;
  advisory={loading:true,targetActor,targetLabel,swapped:swapSide};
  renderAdvisory();
  const job=runAdvisorySearch({match:m,level:lvl,swapSide,seed:crypto.getRandomValues(new Uint32Array(1))[0],onProgress:info=>{
    if(Number.isFinite(info?.score)&&advisory){advisory.score=info.score;renderEvalAndProgress();}
  }});
  advisoryJob=job;
  try{
    const res=await job.promise;
    advisory={...res,targetLabel,loading:false};
    playSound('notify');
  }catch(e){
    advisory={error:e.message||'AI 推演未完成。',targetLabel,loading:false};
  }finally{
    advisoryBusy=false;advisoryJob=null;render();
  }
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
$('zoom-select').onchange=e=>{boardZoom=e.target.value;try{storageObject.setItem(ZOOM_KEY,boardZoom);}catch{}renderBoard();};
$('eval-toggle').onclick=()=>{evalHidden=!evalHidden;try{storageObject.setItem(EVAL_HIDDEN_KEY,evalHidden?'1':'0');}catch{}renderEvalAndProgress();};
$('sound-toggle').onclick=()=>{const muted=toggleMuted();renderSoundButton();if(!muted)playSound('stone');};
$('advise-quick-btn').onclick=()=>requestAdvisory(false);
$('advise-turn-btn').onclick=()=>requestAdvisory(false);
$('advise-swap-btn').onclick=()=>requestAdvisory(true);
$('advise-apply-btn').onclick=()=>{
  if(!advisory?.action||advisory.swapped)return;
  const act=advisory.action;
  operate(()=>session.submit(act.actor,act));
};
$('save-library-btn').onclick=()=>persistLibraryRecord(false);
$('move-list').addEventListener('click',async e=>{
  const btn=e.target.closest('[data-step]');if(!btn||!session)return;
  const step=Number(btn.dataset.step);
  const saved=await persistLibraryRecord(true);
  if(saved){
    try{storageObject.setItem(REPLAY_TARGET_KEY,JSON.stringify({id:saved.id,step}));}catch{}
    window.location.href='./test-records.html';
  }
});
$('open-records-btn').addEventListener('click',()=>{if(match()?.accepted.length)persistLibraryRecord(true);});
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
        if(opening&&session.state.paused)session.setPaused(false);
        return opening?session.requestCancelOpening(p.humanActor):session.submit(p.humanActor,{kind:'resign',actor:p.humanActor});
      });
    };
    $('action-dialog').showModal();return;
  }
  const sideText=a=>m.state.owners?(m.state.owners.black===a?'执黑方':'执白方'):(a==='A'?'摆局方（A）':'选色方（B）');
  $('action-title').textContent=`哪一方要${request}？`;
  $('action-body').innerHTML=`<p class="dialog-note">${kind==='undo'?'每次撤回最后两手操作及其自动动作；不足两手则撤回一手，须对方同意。':opening?'双方同意后取消，不记胜负。':'任一方都可随时认输，确认后本局结束。'}</p><div class="actor-options">${['A','B'].map(a=>`<button data-actor="${a}">${sideText(a)} · ${request}</button>`).join('')}</div>`;
  $('action-body').onclick=e=>{
    const actor=e.target.closest('[data-actor]')?.dataset.actor;if(!actor)return;
    if(kind==='undo'||opening) {
      $('action-dialog').close();operate(()=>kind==='undo'?session.requestUndo(actor):session.requestCancelOpening(actor));return;
    }
    $('action-title').textContent=`确认${sideText(actor)}认输？`;
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
  f.elements.allowAdvisory.checked=defaults?true:advisoryAllowed();
  const p=practice();f.elements.mode.value=defaults?'pvp':p?'practice':'pvp';
  f.elements.level.value=defaults?'standard':p?.level??'standard';
  f.elements.humanActor.value=defaults?'A':p?.humanActor??'A';
  f.elements.player1.value='执黑';f.elements.player2.value='执白';explainDelay();explainMode();
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
  f.elements.player2.required=false;f.elements.competitive.disabled=isPractice;
  if(isPractice)f.elements.competitive.checked=false;
  $('player1-label-text').textContent='执黑';
  const role=f.elements.humanActor.value;
  $('role-explain').textContent=isPractice?`${role==='A'?'你担任 A，AI 担任 B。':role==='B'?'AI 担任 A，你担任 B。':'开局时随机分配你与 AI 的 A / B。'}${f.elements.swap3.checked?'A 连摆黑白黑三子，B 选执黑／执白；选色后身份不变。':'不换色：A 执黑先行，B 执白。'} 人机练习不启用竞技模式。`:'对局中不区分姓名，统一显示为“执黑”与“执白”（三手换色时先由 A 摆局、B 选色）。';
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
  const names=['执黑',isPractice?'弈合 AI':'执白'];
  const humanActor=f.elements.humanActor.value==='random'?(crypto.getRandomValues(new Uint8Array(1))[0]%2?'A':'B'):f.elements.humanActor.value;
  const matchId=uid();
  const allowAdvisory=!!f.elements.allowAdvisory.checked;
  const result=createGameSession({matchId,rules,mode,level:f.elements.level.value,humanActor,seed:crypto.getRandomValues(new Uint32Array(1))[0],competitive:isPractice?false:f.elements.competitive.checked});
  if(!result.ok){notice(errorText(result.error),true);return;}
  const players={names,aIndex:isPractice?(humanActor==='A'?0:1):session?1-meta.aIndex:crypto.getRandomValues(new Uint8Array(1))[0]%2,round:session?meta.round+1:1};
  $('settings-dialog').close();
  const startMsg=rules.swap3?(isPractice?(humanActor==='A'?'已开局：你负责摆局（A），AI 负责选色（B）。':'已开局：AI 负责摆局（A），你负责选色（B）。'):'已开局：请摆局三子，之后由选色方选择执黑或执白。'):'已开局：执黑先行，执白后行。';
  confirmReplacement(()=>{writeAdvisoryMatch(matchId,allowAdvisory);installSession(result.value,players);notice(startMsg);},'重新开始人机练习？');
};
for(const b of document.querySelectorAll('[data-close]'))b.onclick=()=>$(b.dataset.close).close();
installCornerManual();
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
$('ai-perf-mode').onchange=e=>{
  const next=e.target.value;if(!PERF_MODES.includes(next))return;
  perfMode=next;
  try{storageObject.setItem(PERF_KEY,perfMode);}catch{}
  ai?.setPerfMode?.(perfMode);
  renderTelemetry();
  notice(perfMode==='extreme'?'已切换为极限榨干模式（WebGPU 10s 深算 / 全核满载 + 后台预算），将在下一手生效。':perfMode==='turbo'?'已切换为自动榨干模式（优先 WebGPU GPU 神经 MCTS / 物理核心满载）。':'已切换为节能单核模式（v26 WASM 单核，省电静音）。');
};
$('replace-confirm').onclick=()=>{const action=replaceAction;replaceAction=null;$('replace-dialog').close();if(mayChange()&&replaceable())action?.();};
$('replace-dialog').addEventListener('close',()=>{replaceAction=null;});

window.addEventListener('keydown',e=>{
  if(e.metaKey||e.ctrlKey||e.altKey)return;
  const tag=e.target?.tagName;
  if(tag==='INPUT'||tag==='SELECT'||tag==='TEXTAREA')return;
  if($('settings-dialog').open||$('manual-dialog').open||$('action-dialog').open||$('replace-dialog').open)return;
  const k=e.key.toLowerCase();
  if(k==='i'){e.preventDefault();$('inspect-toggle').click();}
  else if(k==='l'){e.preventDefault();$('labels-toggle').click();}
  else if(k==='p'&&!$('pass-btn').disabled){e.preventDefault();$('pass-btn').click();}
  else if(k==='z'&&!$('undo-btn').disabled){e.preventDefault();$('undo-btn').click();}
  else if(k==='m'){e.preventDefault();$('manual-dialog').showModal?.();}
});
try{
  window.qilineDesktop?.onMenuCommand?.(cmd=>{
    if(cmd==='new-game')openSettings();
    else if(cmd==='save-library')persistLibraryRecord(false);
    else if(cmd==='export-save')$('export-btn').click();
    else if(cmd==='import-save')$('import-btn').click();
    else if(cmd==='open-manual')$('manual-dialog').showModal?.();
  });
}catch{}

window.addEventListener('storage',e=>{if((e.key===SAVE_KEY||e.key===null)&&e.newValue!==storage.raw){storage.conflict=true;storage.warning=errorText({code:'STORAGE_CONFLICT'});ai?.pause();render();}});
window.addEventListener('pagehide',()=>releaseSession());
window.addEventListener('pageshow',e=>{if(e.persisted)window.location.reload();});
attachAI(restoreHold);render();if(startupNote)notice(startupNote);
