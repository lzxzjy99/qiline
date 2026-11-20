import {esc,duration,actionText,phaseText,ruleLabels,renderBoard,renderClaims,downloadJSON,colorName,actorRoleName} from './common.mjs';
import {decodeRecords,framesOf,recordLabel,counts,mergeRecord,bundleOf} from './records-model.mjs';
import {openRecords,readAll,saveAll,removeRecord} from './records-store.mjs';
const $=id=>document.getElementById(id);let db=null,games=[],selected=null,frames=[],cursor=0,timer=null,inspect=false,labels=false,point=null;
function message(text){$('record-message').textContent=text;$('record-message').hidden=!text;}
try{db=await openRecords();games=await readAll(db);}catch{db=null;message('浏览器暂时无法保存记录。仍可导入临时回放，刷新后请重新导入。');}
function sorted(){return [...games].sort((a,b)=>b.importedAt-a.importedAt||a.title.localeCompare(b.title,'zh-CN'));}
function renderLibrary(){
 const c=counts(games);$('record-count').textContent=`已导入${c.total}局 · ${c.ended}局终局${games.some(g=>g.candidateActor)?` · 候选${c.candidateWins}胜`:''}`;
 $('records-export').disabled=!games.length;$('records-empty').hidden=!!games.length;$('records-layout').hidden=!games.length;
 $('library-count').textContent=`${games.length}局`;
 const filter=$('records-filter').value;
 const items=sorted().filter(g=>filter==='all'||filter==='wins'&&(g.status==='terminal'&&g.winner===g.candidateActor&&!!g.candidateActor)||filter==='losses'&&(g.status==='terminal'&&!!g.candidateActor&&g.winner!==g.candidateActor)||filter==='unfinished'&&(g.status!=='terminal'||!g.outcome));
 $('records-list').innerHTML=items.length?items.map(g=>`<button class="record-card ${g.id===selected?.id?'selected':''}" data-id="${esc(g.id)}" aria-pressed="${g.id===selected?.id}"><b>${esc(g.title)}</b><span>${esc(recordLabel(g))} <small>${g.record.actions.length}次操作</small></span><small>${g.players.A.version||g.players.B.version?[g.players.A.version,g.players.B.version].filter(Boolean).join(' vs '):`${g.record.rules.boardSize}路对局`}</small></button>`).join(''):'<p class="micro">没有符合筛选的记录。</p>';
}
function stop(){clearTimeout(timer);timer=null;$('replay-play').textContent='播放';}
function select(g){stop();selected=g;frames=framesOf(g.record);cursor=0;point=null;renderLibrary();renderRecord();}
function renderRecord(){
 if(!selected)return;const g=selected,m=frames[cursor],s=m.state,n=m.rules.boardSize,v=phaseText(m);
 $('record-title').textContent=g.title;$('record-players').textContent=['A','B'].map(a=>`${actorRoleName(m,a)}${g.players[a].version?'（'+g.players[a].version+'）':''}${g.candidateActor===a?' · 候选':''}`).join('  /  ');
 $('record-rules').innerHTML=ruleLabels(m.rules).map(x=>`<span>${esc(x)}</span>`).join('');
 $('record-phase').textContent=v.title;$('record-ply').textContent=`棋局第${s.ply}手`;$('record-position').textContent=`操作${cursor} / ${g.record.actions.length}`;
 const group=renderBoard($('board'),m,{labels,inspect,selected:point,onPoint:inspect?p=>{point=p;renderRecord();}:null});
 $('record-inspection').hidden=!inspect;$('record-inspection').textContent=group?`${colorName(group.color)}：${group.stones.length}子，${group.liberties.length}口气。`:'点击棋子查看整块与气，不会落子。';
 $('record-inspect').setAttribute('aria-pressed',inspect);$('record-labels').setAttribute('aria-pressed',labels);
 const action=g.record.actions[cursor-1],stat=g.searches.find(x=>x.revision===cursor-1),pre=cursor>0?frames[cursor-1]:m;
 $('replay-action').textContent=action?`${actorRoleName(pre,action.actor)} · ${actionText(action,n)}`:'开局前';
 $('replay-thinking').textContent=action?duration(stat?.elapsedMs):'使用前后箭头，或点击操作记录定位。';
 $('replay-search-details').hidden=!stat;$('replay-search').textContent=stat?[stat.completedDepth===undefined?'':stat.completedDepth?`已完成${stat.completedDepth}层搜索`:'直接判断',stat.nodes===undefined?'':`${stat.nodes.toLocaleString()}个计费节点`,stat.maxVisitedDepth===undefined?'':`最大访问深度${stat.maxVisitedDepth}`].filter(Boolean).join(' · '):'';
 renderClaims($('replay-claims'),m);$('record-result').textContent=recordLabel(g);
 $('replay-range').max=g.record.actions.length;$('replay-range').value=cursor;
 for(const id of ['replay-first','replay-prev'])$(id).disabled=cursor===0;
 for(const id of ['replay-last','replay-next'])$(id).disabled=cursor===g.record.actions.length;
 $('replay-play').disabled=!g.record.actions.length;
 $('replay-moves').innerHTML=g.record.actions.map((a,i)=>{const stepFrame=frames[i]??m;return `<li><button data-index="${i+1}" class="${cursor===i+1?'active':''}" aria-current="${cursor===i+1?'step':'false'}"><span>${i+1}. ${actorRoleName(stepFrame,a.actor)} · ${esc(actionText(a,n))}</span><small>${g.searches.find(x=>x.revision===i)?.elapsedMs===undefined?'':duration(g.searches.find(x=>x.revision===i).elapsedMs)}</small></button></li>`;}).join('');
 $('record-id').textContent=g.id;$('record-status-note').textContent=g.status.includes('censored')?'这是一份异常或截断记录，不能计作直接获胜。':!g.outcome?'此记录尚未结束，展示导入时已保存的棋盘。重新导入较新文件可更新。':'胜负已按棋谱重新计算。导入记录仅用于回放，不代替完整验收。';
}
function go(n){stop();cursor=Math.max(0,Math.min(frames.length-1,n));point=null;renderRecord();}
function play(){if(!selected)return;if(cursor===frames.length-1){cursor=0;renderRecord();}$('replay-play').textContent='暂停';
 const tick=()=>{if(cursor>=frames.length-1){stop();return;}cursor++;point=null;renderRecord();timer=setTimeout(tick,Number($('replay-speed').value));};timer=setTimeout(tick,Number($('replay-speed').value));}
async function importFiles(files){
 stop();let imported=0,last=null;const errors=[];
 for(const file of files){try{
  if(file.size>20*1024*1024)throw Error('单文件不能超过20MB。');
  const decoded=await decodeRecords(await file.text(),file.name),updated=decoded.map(g=>mergeRecord(games.find(x=>x.id===g.id),g));
  if(db)await saveAll(db,updated);
  for(const g of updated){const i=games.findIndex(x=>x.id===g.id);if(i<0)games.push(g);else games[i]=g;last=g;imported++;}
 }catch(e){errors.push(`${file.name}：${e.message}`);}}
 message([imported?`已导入或更新${imported}局。`:'',...errors].filter(Boolean).join('\n'));renderLibrary();if(last)select(last);
}
$('records-import').onclick=()=>$('records-files').click();$('records-files').onchange=e=>{const files=[...e.target.files];e.target.value='';importFiles(files);};
$('records-filter').onchange=renderLibrary;$('records-list').onclick=e=>{const id=e.target.closest('[data-id]')?.dataset.id;if(id)select(games.find(g=>g.id===id));};
$('replay-first').onclick=()=>go(0);$('replay-prev').onclick=()=>go(cursor-1);$('replay-next').onclick=()=>go(cursor+1);$('replay-last').onclick=()=>go(frames.length-1);
$('replay-play').onclick=()=>timer?stop():play();$('replay-range').oninput=e=>go(Number(e.target.value));
$('replay-moves').onclick=e=>{const i=e.target.closest('[data-index]')?.dataset.index;if(i)go(Number(i));};
$('record-inspect').onclick=()=>{inspect=!inspect;point=null;renderRecord();};$('record-labels').onclick=()=>{labels=!labels;renderRecord();};
$('records-export').onclick=()=>downloadJSON(bundleOf(games),'弈合_本机对局记录.json');$('record-export-one').onclick=()=>downloadJSON(bundleOf([selected]),'弈合_单局回放.json');
$('record-remove').onclick=async()=>{if(!selected)return;try{if(db)await removeRecord(db,selected.id);games=games.filter(g=>g.id!==selected.id);selected=null;stop();renderLibrary();if(games.length)select(sorted()[0]);message('已移除本机记录，原文件保留。');}catch{message('未能移除，记录仍保留。');}};
window.addEventListener('dragover',e=>{if(e.dataTransfer?.types.includes('Files')){e.preventDefault();document.body.classList.add('file-drag');}});
window.addEventListener('dragleave',e=>{if(!e.relatedTarget)document.body.classList.remove('file-drag');});
window.addEventListener('drop',e=>{e.preventDefault();document.body.classList.remove('file-drag');if(e.dataTransfer?.files.length)importFiles([...e.dataTransfer.files]);});
window.addEventListener('pagehide',stop);renderLibrary();if(games.length)select(sorted()[0]);
