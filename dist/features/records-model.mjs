import {createMatch,applyAction,exportRecord} from '../core/src/index.js';

export function framesOf(record){
 if(!Array.isArray(record?.actions)||record.actions.length>4096)throw Error('单局记录无效或超过4096次操作。');
 const start=createMatch(record.rules);if(!start.ok)throw Error('记录中的规则不受支持。');
 if(record.schemaVersion!==1||record.rulesVersion!=='2.1.0-r3')throw Error('不支持这个棋谱版本。');
 const frames=[start.value];
 for(let i=0;i<record.actions.length;i++){
  const r=applyAction(frames.at(-1),record.actions[i]);if(!r.ok)throw Error(`第${i+1}次操作未通过规则校验（${r.error.code}）。`);frames.push(r.value.match);
 }return frames;
}
const sha=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),b=>b.toString(16).padStart(2,'0')).join('');
function valueEnd(raw,start){
 const opening=raw[start];let quoted=false,escape=false,depth=0;
 if(opening==='{'||opening==='['){for(let i=start;i<raw.length;i++){
  const c=raw[i];if(quoted){if(escape)escape=false;else if(c==='\\')escape=true;else if(c==='"')quoted=false;continue;}
  if(c==='"')quoted=true;else if(c==='{'||c==='[')depth++;else if(c==='}'||c===']'){depth--;if(depth===0)return i+1;}
 }}else if(opening==='"'){for(let i=start+1;i<raw.length;i++){if(escape)escape=false;else if(raw[i]==='\\')escape=true;else if(raw[i]==='"')return i+1;}}
 else{let i=start;while(i<raw.length&&raw[i]!==','&&raw[i]!=='}')i++;return i;}
 throw Error('文件封装不完整。');
}
function envelopeDataText(raw){
 let i=raw.indexOf('{')+1;
 while(i<raw.length){while(/[\s,]/.test(raw[i]))i++;if(raw[i]==='}')break;
  const end=valueEnd(raw,i),key=JSON.parse(raw.slice(i,end));i=end;while(/\s/.test(raw[i]))i++;if(raw[i++]!==':')break;while(/\s/.test(raw[i]))i++;
  const finish=valueEnd(raw,i);if(key==='data')return raw.slice(i,finish);i=finish;
 }throw Error('无法读取文件封装。');
}
export async function decodeRecords(text,filename='导入记录'){
 text=text.replace(/^\uFEFF/,'');
 let input;try{input=JSON.parse(text);}catch{throw Error('不是有效的JSON文件。');}
 if(input?.schemaVersion===1&&typeof input.sha256==='string'&&input.data){
  if(await sha(envelopeDataText(text))!==input.sha256)throw Error('文件校验码不一致，请导入原始记录。');input=input.data;
 }
 let games,players=null;
 if(input?.type==='qiline-test-records'){
  if(input.schemaVersion!==1)throw Error('不支持这个测试记录版本。');games=input.games;
 }else if(Array.isArray(input?.rows))games=input.rows;
 else if(input?.webSchemaVersion===1){
  const p=input.players;players=p?{A:{name:p.names[p.aIndex]},B:{name:p.names[1-p.aIndex]}}:null;
  games=[{record:input.session?.record,players}];
 }else if(input?.record)games=[input];
 else if(input?.sessionSchemaVersion)games=[{record:input.record}];
 else if(input?.rules&&input?.actions)games=[{record:input}];
 else if(input?.request?.record)games=[{id:input.request.context?.matchId,record:input.request.record,status:'unfinished'}];
 else throw Error('请选择测试汇总、对局记录、存档或导出的测试记录文件；测试计划不能回放。');
 if(!Array.isArray(games)||!games.length||games.length>500)throw Error('文件需包含1至500局棋谱。');
 const results=[];
 for(const g of games){
  const frames=framesOf(g.record),m=frames.at(-1),record=exportRecord(m),outcome=m.state.outcome;
  const status=typeof g.status==='string'?g.status:(outcome?'terminal':'unfinished');
  if(status==='terminal'&&!outcome)throw Error('记录标为终局，但棋谱尚未结束。');
  if(g.winner!==undefined&&g.winner!==(outcome?.kind==='win'?outcome.winner:null))throw Error('文件中的胜负与棋谱回放不一致。');
  const p=g.players??players??{},safePlayer=a=>({name:typeof p[a]?.name==='string'?p[a].name.slice(0,80):`玩家${a}`,
   version:typeof p[a]?.version==='string'?p[a].version.slice(0,140):''});
  const searches=Array.isArray(g.searches)?g.searches.filter(s=>s&&Number.isInteger(s.revision)&&s.revision>=0&&s.revision<record.actions.length).map(s=>({revision:s.revision,
   ...Object.fromEntries(['elapsedMs','nodes','completedDepth','maxVisitedDepth'].filter(k=>Number.isFinite(s[k])&&s[k]>=0).map(k=>[k,s[k]]))})):[];
  const id=typeof g.id==='string'&&g.id&&g.id.length<=300?g.id:await sha(JSON.stringify(record));
  results.push({id,title:typeof g.title==='string'?g.title.slice(0,160):typeof g.id==='string'?g.id.slice(0,160):filename,record,status,
   candidateActor:['A','B'].includes(g.candidateActor)?g.candidateActor:null,players:{A:safePlayer('A'),B:safePlayer('B')},searches,
   outcome,winner:outcome?.kind==='win'?outcome.winner:null,error:typeof g.error==='string'?g.error.slice(0,6000):null,
   importedAt:Date.now(),updatedAt:Date.now()});
 }return results;
}
export function recordLabel(g){return g.status.includes('censored')?'异常／截断':g.outcome?.kind==='win'?`${g.winner}获胜`:g.outcome?.kind==='draw'?'和棋':g.outcome?'已取消':'未完局';}
export function counts(games){return {total:games.length,ended:games.filter(g=>g.status==='terminal'&&g.outcome).length,
 candidateWins:games.filter(g=>g.status==='terminal'&&g.outcome?.kind==='win'&&g.candidateActor===g.winner).length};}
export function mergeRecord(old,next){
 if(!old)return next;
 const a=old.record,b=next.record;
 if(JSON.stringify(a.rules)!==JSON.stringify(b.rules))throw Error('同名记录的规则不同，原记录已保留。');
 const common=Math.min(a.actions.length,b.actions.length);
 for(let i=0;i<common;i++)if(JSON.stringify(a.actions[i])!==JSON.stringify(b.actions[i]))throw Error('同名记录出现不同分支，原记录已保留。');
 return b.actions.length<a.actions.length?old:{...next,importedAt:old.importedAt};
}
export const bundleOf=games=>({type:'qiline-test-records',schemaVersion:1,exportedAt:new Date().toISOString(),games});
