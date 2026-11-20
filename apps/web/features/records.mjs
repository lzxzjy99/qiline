import {esc,duration,actionText,phaseText,ruleLabels,renderBoard,renderClaims,downloadJSON,colorName,actorRoleName} from './common.mjs';
import {decodeRecords,framesOf,recordLabel,counts,mergeRecord,bundleOf} from './records-model.mjs';
import {openRecords,readAll,saveAll,removeRecord} from './records-store.mjs';
import {isMuted,toggleMuted,playSound} from './sound.mjs';
import {installCornerManual} from './manual-widget.mjs';
import {buildMatchFrameRecord,formatAdvisedAction,formatEvalSummary,runAdvisorySearch} from './board-ai.mjs';
import {activePlayer} from '../core/src/index.js';

const $=id=>document.getElementById(id),ZOOM_KEY='qiline.boardZoom',HANDOFF_KEY='qiline.handoff',REPLAY_TARGET_KEY='qiline.replayTarget';
let db=null,games=[],selected=null,frames=[],cursor=0,timer=null,inspect=false,labels=false,point=null;
let boardZoom='fit',advisory=null,advisoryJob=null,advisoryBusy=false;
try{const z=localStorage.getItem(ZOOM_KEY);if(['fit','compact','large'].includes(z))boardZoom=z;}catch{}

try{
  if(window.location?.protocol==='qiline:'){
    const onlineLink=$('online-nav-link');
    if(onlineLink){
      onlineLink.setAttribute('href','https://qiline-online.pages.dev/online.html');
      onlineLink.setAttribute('title','在默认浏览器中打开在线对战网页版');
      onlineLink.onclick=e=>{
        e.preventDefault();
        if(typeof window.qilineDesktop?.openOnline==='function')window.qilineDesktop.openOnline();
        else message('请用浏览器访问 https://qiline-online.pages.dev/online.html 进行好友联机。');
      };
    }
  }
}catch{}

function message(text){$('record-message').textContent=text;$('record-message').hidden=!text;}
function renderSoundBtn(){const b=$('sound-toggle'),m=isMuted();if(b){b.setAttribute('aria-pressed',String(m));b.textContent=m?'🔇 静音':'🔊 音效';}}
try{db=await openRecords();games=await readAll(db);}catch{db=null;message('浏览器暂时无法保存记录。仍可导入临时回放，刷新后请重新导入。');}

function sorted(){return [...games].sort((a,b)=>(b.updatedAt??b.importedAt)-(a.updatedAt??a.importedAt)||b.importedAt-a.importedAt||a.title.localeCompare(b.title,'zh-CN'));}
function winColorOf(g){if(g.outcome?.kind!=='win')return null;return g.outcome.color??null;}

function clearAdvisory(){
  if(advisoryJob){advisoryJob.cancel();advisoryJob=null;}
  advisoryBusy=false;advisory=null;
}

function renderLibrary(){
 const c=counts(games);
 const blackWins=games.filter(g=>winColorOf(g)==='black').length;
 const whiteWins=games.filter(g=>winColorOf(g)==='white').length;
 $('record-count').textContent=`本机共 ${c.total} 局（黑胜 ${blackWins} · 白胜 ${whiteWins} · 终局 ${c.ended}）${games.some(g=>g.candidateActor)?` · 候选${c.candidateWins}胜`:''}`;
 $('records-export').disabled=!games.length;$('records-empty').hidden=!!games.length;$('records-layout').hidden=!games.length;
 $('library-count').textContent=`${games.length} 局`;
 const filter=$('records-filter').value,q=$('records-search').value.trim().toLowerCase();
 const items=sorted().filter(g=>{
  if(q&&!`${g.title} ${g.id}`.toLowerCase().includes(q))return false;
  if(filter==='black-win')return winColorOf(g)==='black';
  if(filter==='white-win')return winColorOf(g)==='white';
  if(filter==='unfinished')return g.status!=='terminal'||!g.outcome;
  if(filter==='wins')return g.status==='terminal'&&g.winner===g.candidateActor&&!!g.candidateActor;
  if(filter==='losses')return g.status==='terminal'&&!!g.candidateActor&&g.winner!==g.candidateActor;
  return true;
 });
 $('records-list').innerHTML=items.length?items.map(g=>{
  const endText=g.outcome?.kind==='win'?`${colorName(g.outcome.color)}胜`:g.outcome?.kind==='draw'?'和棋':g.outcome?'开局取消':'未完局';
  const ver=[g.players?.A?.version,g.players?.B?.version].filter(Boolean).join(' vs ');
  return `<button class="record-card ${g.id===selected?.id?'selected':''}" data-id="${esc(g.id)}" aria-pressed="${g.id===selected?.id}"><b>${esc(g.title)}</b><span>${esc(endText)} <small>${g.record.actions.length}手</small></span><small>${esc(ver||`${g.record.rules.boardSize}路 · ${g.record.rules.swap3?'三手换色':'直接开局'}`)}</small></button>`;
 }).join(''):'<p class="micro">没有符合筛选的棋谱。</p>';
}

function stop(){clearTimeout(timer);timer=null;$('replay-play').textContent='播放';}
function select(g,startCursor=0){stop();clearAdvisory();selected=g;frames=framesOf(g.record);cursor=Math.max(0,Math.min(frames.length-1,startCursor));point=null;renderLibrary();renderRecord();}

function renderAdvisoryPanel(m){
 const ended=!!m.state.outcome;
 const cur=activePlayer(m);
 const swapDisabled=ended||advisoryBusy||m.state.phase.kind!=='playing'||m.state.passStreak>0;
 $('replay-advise-btn').disabled=ended||advisoryBusy;
 $('replay-advise-swap-btn').disabled=swapDisabled;
 $('continue-black-ai').disabled=ended;$('continue-white-ai').disabled=ended;$('continue-pvp').disabled=ended;
 $('continue-hint').textContent=ended?'当前已到终局一步；向左退回任意一步即可从该局面继续下棋或请求 AI 建议。':`将保留第 ${cursor} 步之前的全部走子与规则，进入对局板继续实战：`;
 if(m.state.owners){
  $('continue-black-ai').textContent='从此处开始：我执黑 vs AI →';
  $('continue-white-ai').innerHTML='<span>从此处开始：我执白 vs AI</span><span>→</span>';
 }else{
  $('continue-black-ai').textContent='从此处开始：我当摆局方(A) vs AI →';
  $('continue-white-ai').innerHTML='<span>从此处开始：我当选色方(B) vs AI</span><span>→</span>';
 }
 const evalBox=$('replay-eval-box'),res=$('replay-advise-result');
 if(!advisory){evalBox.hidden=true;res.hidden=true;return;}
 if(advisory.loading){
  res.hidden=false;res.innerHTML=`正在为<b>${esc(advisory.targetLabel)}</b>推演建议着法…`;
  evalBox.hidden=true;return;
 }
 if(advisory.error){
  res.hidden=false;res.innerHTML=`<span class="danger">${esc(advisory.error)}</span>`;
  evalBox.hidden=true;return;
 }
 const ev=Number.isFinite(advisory.score)?formatEvalSummary(advisory.score,m):null;
 if(ev){
  evalBox.hidden=false;
  $('replay-eval-headline').textContent=ev.headline;
  $('replay-eval-fill').style.width=`${ev.pct}%`;
  $('replay-eval-left').textContent=ev.leftLabel;
  $('replay-eval-right').textContent=ev.rightLabel;
 }else evalBox.hidden=true;
 res.hidden=false;
 res.innerHTML=`<b>${esc(advisory.targetLabel)}</b>：${esc(formatAdvisedAction(advisory.action,m.rules.boardSize))}${advisory.elapsedMs?`<br><small>用时 ${(advisory.elapsedMs/1000).toFixed(1)} 秒${advisory.stats?.completedDepth?` · 深度 ${advisory.stats.completedDepth}`:''}</small>`:''}`;
}

function renderRecord(){
 if(!selected)return;const g=selected,m=frames[cursor],s=m.state,n=m.rules.boardSize,v=phaseText(m);
 $('record-title').textContent=g.title;
 $('record-players').textContent=['A','B'].map(a=>`${actorRoleName(m,a)}${g.players[a].version?'（'+g.players[a].version+'）':''}${g.candidateActor===a?' · 候选':''}`).join('  /  ');
 $('record-rules').innerHTML=ruleLabels(m.rules).map(x=>`<span>${esc(x)}</span>`).join('');
 $('record-phase').textContent=v.title;$('record-ply').textContent=`棋局第${s.ply}手`;$('record-position').textContent=`第 ${cursor} / ${g.record.actions.length} 步`;
 const advisedPoint=advisory?.action?.kind==='place'&&!s.outcome?advisory.action.point:null;
 const group=renderBoard($('board'),m,{labels,inspect,selected:point,advisedPoint,zoom:boardZoom,onPoint:inspect?p=>{point=p;renderRecord();}:null});
 $('record-zoom').value=boardZoom;
 $('record-inspection').hidden=!inspect;$('record-inspection').textContent=group?`${colorName(group.color)}：${group.stones.length}子，${group.liberties.length}口气。`:'点击棋子查看整块与气，不会落子。';
 $('record-inspect').setAttribute('aria-pressed',inspect);$('record-labels').setAttribute('aria-pressed',labels);
 const action=g.record.actions[cursor-1],stat=g.searches.find(x=>x.revision===cursor-1),pre=cursor>0?frames[cursor-1]:m;
 $('replay-action').textContent=action?`${actorRoleName(pre,action.actor)} · ${actionText(action,n)}`:'开局空盘';
 $('replay-thinking').textContent=action?duration(stat?.elapsedMs):'使用下方按钮、滑块或点击右侧步数跳转。';
 $('replay-search-details').hidden=!stat;$('replay-search').textContent=stat?[stat.completedDepth===undefined?'':stat.completedDepth?`已完成${stat.completedDepth}层搜索`:'直接判断',stat.nodes===undefined?'':`${stat.nodes.toLocaleString()}个计费节点`,stat.maxVisitedDepth===undefined?'':`最大访问深度${stat.maxVisitedDepth}`].filter(Boolean).join(' · '):'';
 renderClaims($('replay-claims'),m);$('record-result').textContent=recordLabel(g);
 $('replay-range').max=g.record.actions.length;$('replay-range').value=cursor;
 for(const id of ['replay-first','replay-prev'])$(id).disabled=cursor===0;
 for(const id of ['replay-last','replay-next'])$(id).disabled=cursor===g.record.actions.length;
 $('replay-play').disabled=!g.record.actions.length;
 $('replay-moves').innerHTML=g.record.actions.map((a,i)=>{const stepFrame=frames[i]??m;return `<li><button data-index="${i+1}" class="${cursor===i+1?'active':''}" aria-current="${cursor===i+1?'step':'false'}"><span>${i+1}. ${actorRoleName(stepFrame,a.actor)} · ${esc(actionText(a,n))}</span><small>${g.searches.find(x=>x.revision===i)?.elapsedMs===undefined?'':duration(g.searches.find(x=>x.revision===i).elapsedMs)}</small></button></li>`;}).join('');
 $('replay-moves').querySelector('button.active')?.scrollIntoView({block:'nearest'});
 $('record-id').textContent=g.id;$('record-status-note').textContent=g.status.includes('censored')?'这是一份异常或截断记录，不能计作直接获胜。':!g.outcome?'未完局棋谱：可直接点击下方“从此处开始”接续对战。':'终局棋谱：可退回任意一步重新推演或由 AI 接手续下。';
 renderAdvisoryPanel(m);
}

function go(n){stop();clearAdvisory();cursor=Math.max(0,Math.min(frames.length-1,n));point=null;playSound('stone');renderRecord();}
function play(){if(!selected)return;if(cursor===frames.length-1){cursor=0;renderRecord();}$('replay-play').textContent='暂停';
 const tick=()=>{if(cursor>=frames.length-1){stop();return;}cursor++;clearAdvisory();point=null;playSound('stone');renderRecord();timer=setTimeout(tick,Number($('replay-speed').value));};timer=setTimeout(tick,Number($('replay-speed').value));}

async function requestAdvisory(swapSide=false){
  if(!selected||advisoryBusy)return;
  const m=frames[cursor];if(!m||m.state.outcome)return;
  clearAdvisory();
  const level=$('replay-advise-level').value||'standard';
  const cur=activePlayer(m),targetActor=swapSide?(cur==='A'?'B':'A'):cur;
  const targetLabel=m.state.owners?(m.state.owners.black===targetActor?'执黑':'执白'):(targetActor==='A'?'摆局方 A':'选色方 B');
  advisoryBusy=true;advisory={loading:true,targetActor,targetLabel,swapped:swapSide};
  renderAdvisoryPanel(m);
  const job=runAdvisorySearch({match:m,level,swapSide,seed:crypto.getRandomValues(new Uint32Array(1))[0]});
  advisoryJob=job;
  try{
    const res=await job.promise;
    advisory={...res,targetLabel,loading:false};
    playSound('notify');
  }catch(e){
    advisory={error:e.message||'AI 推演未完成。',targetLabel,loading:false};
  }finally{
    advisoryBusy=false;advisoryJob=null;renderRecord();
  }
}

function continueFromCursor(mode,preferColor='black'){
  if(!selected)return;
  const m=frames[cursor];
  if(!m||m.state.outcome){message('当前步已终局，请退回前一步后再从此处继续下棋。');return;}
  const frameRecord=buildMatchFrameRecord(selected.record,cursor);
  const level=$('replay-advise-level').value||'standard';
  const seed=crypto.getRandomValues(new Uint32Array(1))[0];
  let humanActor='A';
  if(m.state.owners){
    humanActor=preferColor==='black'?m.state.owners.black:m.state.owners.white;
  }else{
    humanActor=preferColor==='black'?'A':'B';
  }
  const controllers=mode==='practice'
    ?{[humanActor]:{kind:'human'},[humanActor==='A'?'B':'A']:{kind:'ai',level,seed}}
    :{A:{kind:'human'},B:{kind:'human'}};
  const save={
    webSchemaVersion:1,
    snapshotId:crypto.randomUUID(),
    players:{names:['执黑',mode==='practice'?'弈合 AI':'执白'],aIndex:humanActor==='A'?0:1,round:1},
    session:{sessionSchemaVersion:1,record:frameRecord,controllers,competitive:false},
  };
  const note=mode==='practice'
    ?`已从《${selected.title}》第 ${cursor} 步载入人机续下（${preferColor==='black'?(m.state.owners?'你执黑':'你任摆局方 A'):(m.state.owners?'你执白':'你任选色方 B')}），点击“继续对局”开始。`
    :`已从《${selected.title}》第 ${cursor} 步载入本地双人续下。`;
  try{
    localStorage.setItem(HANDOFF_KEY,JSON.stringify({save,note}));
    window.location.href='./index.html';
  }catch{message('无法跳转载入续下，请尝试导出后再导入。');}
}

async function importFiles(files){
 stop();let imported=0,last=null;const errors=[];
 for(const file of files){try{
  if(file.size>20*1024*1024)throw Error('单文件不能超过20MB。');
  const decoded=await decodeRecords(await file.text(),file.name),updated=decoded.map(g=>mergeRecord(games.find(x=>x.id===g.id),g));
  if(db)await saveAll(db,updated);
  for(const g of updated){const i=games.findIndex(x=>x.id===g.id);if(i<0)games.push(g);else games[i]=g;last=g;imported++;}
 }catch(e){errors.push(`${file.name}：${e.message}`);}}
 message([imported?`已导入或更新 ${imported} 局。`:'',...errors].filter(Boolean).join('\n'));renderLibrary();if(last)select(last);
}

$('records-import').onclick=()=>$('records-files').click();$('records-files').onchange=e=>{const files=[...e.target.files];e.target.value='';importFiles(files);};
$('records-filter').onchange=renderLibrary;$('records-search').oninput=renderLibrary;
$('records-list').onclick=e=>{const id=e.target.closest('[data-id]')?.dataset.id;if(id)select(games.find(g=>g.id===id));};
$('replay-first').onclick=()=>go(0);$('replay-prev').onclick=()=>go(cursor-1);$('replay-next').onclick=()=>go(cursor+1);$('replay-last').onclick=()=>go(frames.length-1);
$('replay-play').onclick=()=>timer?stop():play();$('replay-range').oninput=e=>go(Number(e.target.value));
$('replay-moves').onclick=e=>{const i=e.target.closest('[data-index]')?.dataset.index;if(i)go(Number(i));};
$('record-inspect').onclick=()=>{inspect=!inspect;point=null;renderRecord();};$('record-labels').onclick=()=>{labels=!labels;renderRecord();};
$('record-zoom').onchange=e=>{boardZoom=e.target.value;try{localStorage.setItem(ZOOM_KEY,boardZoom);}catch{}renderRecord();};
$('sound-toggle').onclick=()=>{const m=toggleMuted();renderSoundBtn();if(!m)playSound('stone');};
$('replay-advise-btn').onclick=()=>requestAdvisory(false);
$('replay-advise-swap-btn').onclick=()=>requestAdvisory(true);
$('continue-black-ai').onclick=()=>continueFromCursor('practice','black');
$('continue-white-ai').onclick=()=>continueFromCursor('practice','white');
$('continue-pvp').onclick=()=>continueFromCursor('pvp','black');
$('records-export').onclick=()=>downloadJSON(bundleOf(games),'弈合_本机棋谱库.json');
$('record-export-one').onclick=()=>downloadJSON(bundleOf([selected]),`弈合_${selected.title.replace(/[\\/:*?"<>|]/g,'_')}.json`);
$('record-remove').onclick=async()=>{if(!selected)return;try{if(db)await removeRecord(db,selected.id);games=games.filter(g=>g.id!==selected.id);selected=null;stop();clearAdvisory();renderLibrary();if(games.length)select(sorted()[0]);message('已移除本机记录，原文件保留。');}catch{message('未能移除，记录仍保留。');}};
window.addEventListener('dragover',e=>{if(e.dataTransfer?.types.includes('Files')){e.preventDefault();document.body.classList.add('file-drag');}});
window.addEventListener('dragleave',e=>{if(!e.relatedTarget)document.body.classList.remove('file-drag');});
window.addEventListener('drop',e=>{if(e.dataTransfer?.files?.length){e.preventDefault();document.body.classList.remove('file-drag');importFiles([...e.dataTransfer.files]);}});

installCornerManual();renderSoundBtn();renderLibrary();
let jumpTarget=null;
try{
  const raw=localStorage.getItem(REPLAY_TARGET_KEY);
  if(raw){jumpTarget=JSON.parse(raw);localStorage.removeItem(REPLAY_TARGET_KEY);}
}catch{}
if(jumpTarget?.id){
  const target=games.find(g=>g.id===jumpTarget.id);
  if(target)select(target,Number(jumpTarget.step??0));
  else if(games.length)select(sorted()[0]);
}else if(games.length){
  select(sorted()[0]);
}
