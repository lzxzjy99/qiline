import {activePlayer,formatPoint,inspectGroup} from '../core/src/index.js';
export const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const colorName=c=>c==='black'?'黑棋':'白棋';
export const duration=ms=>typeof ms==='number'&&Number.isFinite(ms)?(ms>=60000?`${Math.floor(ms/60000)}分${((ms%60000)/1000).toFixed(1)}秒`:`${(ms/1000).toFixed(1)}秒`):'未记录用时';
export const actorColor=(m,a)=>m.state.owners?(m.state.owners.black===a?'black':'white'):null;
export const actorRoleName=(m,a)=>{const c=actorColor(m,a);return c?colorName(c):(a==='A'?'摆局方':'选色方');};
export function phaseText(m,_names){
 const s=m.state,p=s.phase;
 if(s.outcome){const o=s.outcome;return o.kind==='win'?{title:`${colorName(o.color)}获胜`,detail:`${colorName(o.color)} · ${o.reason==='line'?'五连已确认':'对方认输'}`}:
  {title:o.kind==='draw'?'本局和棋':'开局已取消',detail:o.kind==='draw'?'双方连续停手，没有待确认五连。':'双方同意取消开局。'};}
 if(p.kind==='opening')return {title:`摆局方摆${p.placed===1?'白棋':'黑棋'}`,detail:`三手换色 · 第${p.placed+1}/3子，摆局不能提子。`};
 if(p.kind==='choose')return {title:'选色方选择执色',detail:'选色方选择黑或白，之后白棋先行。'};
 const a=activePlayer(m);return {title:`${colorName(p.toMove)}行棋`,detail:s.passStreak?'上一手停手；有五连时仍继续确认。':'提子按上下左右，五连按本局方向确认。'};
}
export function actionText(a,n){return a.kind==='place'?`落子 ${formatPoint(a.point,n)}`:a.kind==='choose-color'?`选择${colorName(a.color)}`:a.kind==='pass'?'停一手':a.kind==='resign'?'认输':'取消开局';}
export function ruleLabels(r){return [`${r.boardSize}路`,r.directions==='diagonal'?'对角线':'四方向',`确认延迟${r.confirmationDelay}手`,r.swap3?'三手换色':'直接开局',r.claimMode==='fixed-five'?'固定五子':'换线继承',r.superko==='positional'?'全局禁重复':'允许重复'];}
export function renderClaims(el,m){
 el.innerHTML=m.state.claims.length?m.state.claims.map(c=>`<div class="claim-item"><div><i class="stone-dot ${c.color}"></i> ${colorName(c.color)}五连 <strong>余${Math.max(0,c.dueAt-m.state.ply)}手</strong></div><p>${c.points.map(p=>formatPoint(p,m.rules.boardSize)).join(' · ')}</p></div>`).join(''):'<p class="empty-claims">暂无等待确认的五连。</p>';
}
export function renderBoard(el,m,{labels=false,onPoint=null,inspect=false,selected=null}={}){
 const n=m.rules.boardSize,s=m.state,pad=38,step=524/(n-1),xy=p=>[pad+(p%n)*step,pad+(n-1-Math.floor(p/n))*step];
 const focus=Math.max(0,Math.min(n*n-1,Number(el.dataset.focus??Math.floor(n*n/2))));el.style.minWidth=n>=15?`${n===19?530:430}px`:'290px';
 el.setAttribute('aria-label',`${n}路棋盘，${inspect?'查气':onPoint?'在线行棋':'只读棋盘'}。方向键移动，回车确认。`);
 el.setAttribute('aria-rowcount',n);el.setAttribute('aria-colcount',n);
 let group=null;if(selected!==null){const r=inspectGroup(m,selected);if(r.ok)group=r.value;}
 const stones=new Set(group?.stones??[]),libs=new Set(group?.liberties??[]);
 let html='<svg viewBox="0 0 600 600" aria-hidden="true"><g class="grid-lines">';
 for(let i=0;i<n;i++){const a=pad+i*step;html+=`<path d="M38 ${a}H562 M${a} 38V562"/>`;}
 html+='</g>';const stars=n===9?[2,4,6]:n===13?[3,6,9]:n===15?[3,7,11]:[3,9,15];
 for(const x of stars)for(const y of stars)html+=`<circle class="star-point" cx="${pad+x*step}" cy="${pad+y*step}" r="2.5"/>`;
 for(let i=0;i<n;i++){const a=pad+i*step;html+=`<text class="coordinate" x="${a}" y="21">${String.fromCharCode(65+i)}</text><text class="coordinate" x="${a}" y="589">${String.fromCharCode(65+i)}</text><text class="coordinate" x="17" y="${a+5}">${n-i}</text><text class="coordinate" x="584" y="${a+5}">${n-i}</text>`;}
 for(const c of s.claims){const a=xy(c.points[0]),b=xy(c.points.at(-1));html+=`<path class="claim-line" d="M${a[0]} ${a[1]}L${b[0]} ${b[1]}"/>`;}
 html+='</svg>';
 for(let y=n-1;y>=0;y--){html+='<div role="row">';for(let x=0;x<n;x++){
  const p=y*n+x,[xx,yy]=xy(p),cell=s.board[p],color=cell===1?'black':'white';
  html+=`<button type="button" role="gridcell" data-point="${p}" tabindex="${p===focus?0:-1}" class="cell ${stones.has(p)?'selected':''} ${libs.has(p)?'liberty':''}" style="left:${xx/6}%;top:${yy/6}%;width:${Math.min(48,step*.95)/6}%;height:${Math.min(48,step*.95)/6}%;" aria-label="${formatPoint(p,n)}，${cell?colorName(color):'空点'}${libs.has(p)?'，气':''}" ${!onPoint?'disabled':''}>${cell?`<span class="stone ${color} ${s.lastPlacement===p?'last':''} ${labels?'with-label':''}">${labels?s.moveLabels[p]:''}</span>`:''}</button>`;
 }html+='</div>';}
 el.innerHTML=html;
 el.onclick=e=>{const b=e.target.closest('[data-point]');if(b&&onPoint){el.dataset.focus=b.dataset.point;onPoint(Number(b.dataset.point));}};
 el.onkeydown=e=>{
  const p=Number(document.activeElement?.dataset.point??el.dataset.focus??focus);let q=p;
  if(e.key==='ArrowUp')q=Math.min(n*n-1,p+n);else if(e.key==='ArrowDown')q=Math.max(0,p-n);
  else if(e.key==='ArrowLeft')q=Math.max(Math.floor(p/n)*n,p-1);else if(e.key==='ArrowRight')q=Math.min(Math.floor(p/n)*n+n-1,p+1);else return;
  e.preventDefault();el.dataset.focus=String(q);for(const b of el.querySelectorAll('[data-point]'))b.tabIndex=Number(b.dataset.point)===q?0:-1;el.querySelector(`[data-point="${q}"]`)?.focus();
 };
 return group;
}
export function downloadJSON(data,filename){const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
