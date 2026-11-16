// Read-only export of locally saved research games. No search or benchmark mutation.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {replayRecord} from '../compiled/core/src/index.js';
const hash=x=>createHash('sha256').update(x).digest('hex');
function read(file){const raw=fs.readFileSync(file,'utf8').trimEnd(),prefix='{"schemaVersion":1,"data":',cut=raw.lastIndexOf(',"sha256":"'),e=JSON.parse(raw);
 if(!raw.startsWith(prefix)||hash(raw.slice(prefix.length,cut))!==e.sha256)throw Error('记录校验失败：'+file);return e.data;}
function version(policy){const n=policy?.match(/^native-nine-v(\d+)/);return n?'原生AI v'+n[1]:policy?.startsWith('frozen-product-')?'产品 '+policy.slice(15):policy??'';}
try{
 const [folderArg,outArg]=process.argv.slice(2);if(!folderArg||!outArg)throw Error('用法：node tools/export-test-records.mjs 测试结果目录 输出JSON路径');
 const folder=path.resolve(folderArg),out=path.resolve(outArg),plan=read(path.join(folder,'plan.json')),games=[];
 for(let i=0;i<plan.games.length;i++){
  const gd=path.join(folder,'games','g'+String(i).padStart(3,'0')),ff=path.join(gd,'game-final.json'),cf=path.join(gd,'checkpoint.json');
  if(!fs.existsSync(ff)&&!fs.existsSync(cf))continue;
  const g=fs.existsSync(ff)?read(ff):{...read(cf),status:'unfinished',id:plan.games[i].id,candidateActor:plan.games[i].candidateActor};
  const r=replayRecord(g.record);if(!r.ok)throw Error(`第${i+1}局棋谱校验失败。`);
  const searches=[],policies={};
  for(let j=0;j<g.record.actions.length;j++){
   const d=path.join(gd,'searches','s'+String(j).padStart(4,'0')),f=path.join(d,'result.json');if(!fs.existsSync(f))continue;
   const saved=read(f),reply=saved.result.reply,native=path.join(d,'native.json'),n=fs.existsSync(native)?read(native):null;
   policies[g.record.actions[j].actor]=saved.policy;
   searches.push({revision:j,elapsedMs:reply.stats.elapsedMs,nodes:reply.stats.nodes,
    completedDepth:n?n.completedIteration:reply.stats.completedDepth,maxVisitedDepth:saved.result.details.maxVisitedDepth});
  }
  const kind=plan.stage==='formal-80-percent-acceptance'?'正式验收':fs.existsSync(path.join(folder,'gate.json'))?'开发筛选':plan.mode==='preflight'?'启动自检':'测试对局';
  games.push({id:g.id??plan.games[i].id,title:`${kind} · 第${i+1}局 · 候选${g.candidateActor??plan.games[i].candidateActor}`,
   record:g.record,status:g.status,candidateActor:g.candidateActor??plan.games[i].candidateActor,
   players:Object.fromEntries(['A','B'].map(a=>[a,{name:a===(g.candidateActor??plan.games[i].candidateActor)?'候选AI':'对照AI',version:version(policies[a])}])),searches});
 }
 if(!games.length)throw Error('尚无已保存棋谱，不生成空文件。');
 fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify({type:'qiline-test-records',schemaVersion:1,exportedAt:new Date().toISOString(),games},null,2)+'\n');
 console.log(`已导出${games.length}局记录与逐手用时：${out}`);
}catch(e){console.error(e.message);process.exitCode=1;}
