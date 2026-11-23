import {activePlayer,applyAction,createMatch,exportRecord,formatPoint} from '../core/src/index.js';
import {AI_PROFILES,AI_PROTOCOL_VERSION} from '../ai/src/index.js';
import {SHARED_TT_STRIDE,CTRL_JOB_SEQ,CTRL_MAX_DEPTH,CTRL_ACTIVE_WORKERS,CTRL_TT_GEN,CTRL_THREAD_COUNT,CTRL_NODES_BASE,CTRL_NODES_STRIDE,CTRL_BUFFER_BYTES} from '../ai/src/v21-engine.js';
import {openRecords,readAll,saveAll} from './records-store.mjs';
import {mergeRecord} from './records-model.mjs';

export function isV21Rules(rules){
  return !!rules&&rules.boardSize===9&&rules.directions==='diagonal'&&rules.confirmationDelay===4
    &&rules.claimMode==='fixed-five'&&rules.superko==='positional';
}

export function scoreToBlackWinPct(score,match){
  if(!Number.isFinite(score)||!match)return null;
  const owners=match.state?.owners;
  const sideScore=owners?(owners.black==='A'?score:-score):score;
  if(Math.abs(sideScore)>=500000)return sideScore>0?99:1;
  const pct=100/(1+Math.exp(-sideScore/350));
  return Math.max(2,Math.min(98,Math.round(pct)));
}

export function formatEvalSummary(score,match){
  const pct=scoreToBlackWinPct(score,match);
  if(pct===null)return null;
  const owners=match?.state?.owners;
  const sideScore=owners?(owners.black==='A'?score:-score):score;
  if(!owners)return {pct,leftLabel:`摆局方 A ${pct}%`,rightLabel:`选色方 B ${100-pct}%`,headline:pct>=55?'摆局方略占优':pct<=45?'选色方略占优':'双方均势'};
  if(Math.abs(sideScore)>=500000)return {pct,leftLabel:`执黑 ${pct}%`,rightLabel:`执白 ${100-pct}%`,headline:sideScore>0?'执黑胜势已定':'执白胜势已定'};
  return {
    pct,
    leftLabel:`执黑 ${pct}%`,
    rightLabel:`执白 ${100-pct}%`,
    headline:pct>=56?`执黑占优（${pct}%）`:pct<=44?`执白占优（${100-pct}%）`:`局面接近均势（黑 ${pct}%）`,
  };
}

export function formatAdvisedAction(action,boardSize){
  if(!action)return '暂无建议';
  if(action.kind==='place')return `建议落子 ${formatPoint(action.point,boardSize)}`;
  if(action.kind==='pass')return '建议停一手';
  if(action.kind==='choose-color')return `建议选择${action.color==='black'?'执黑':'执白'}`;
  return '建议操作';
}

export function prepareAdvisoryMatch(match,{swapSide=false}={}){
  if(!match||match.state.outcome)return {ok:false,reason:'当前局面已结束，无法继续推演。'};
  let targetMatch=match;
  if(swapSide){
    if(match.state.phase.kind!=='playing')return {ok:false,reason:'仅正式行棋阶段支持换边假设推演。'};
    if(match.state.passStreak>0)return {ok:false,reason:'上一手已停手，再停手将触发和棋，无法虚停换边。'};
    const cur=activePlayer(match);
    const next=applyAction(match,{kind:'pass',actor:cur});
    if(!next.ok||next.value.match.state.outcome)return {ok:false,reason:'当前局面暂不支持换边推演。'};
    targetMatch=next.value.match;
  }
  const targetActor=activePlayer(targetMatch);
  if(!targetActor)return {ok:false,reason:'当前没有待行动的一方。'};
  const targetColor=targetMatch.state.owners
    ?(targetMatch.state.owners.black===targetActor?'black':'white')
    :(targetMatch.state.phase.kind==='opening'?(targetMatch.state.phase.placed===1?'white':'black'):null);
  return {ok:true,match:targetMatch,record:exportRecord(targetMatch),targetActor,targetColor};
}

export function runAdvisorySearch({match,level='standard',swapSide=false,seed=1,onProgress}){
  const prepared=prepareAdvisoryMatch(match,{swapSide});
  if(!prepared.ok)return {promise:Promise.reject(Error(prepared.reason)),cancel:()=>{}};
  const {record,targetActor,targetColor}=prepared;
  const profile=AI_PROFILES[level]??AI_PROFILES.standard;
  const request={
    protocolVersion:AI_PROTOCOL_VERSION,
    kind:'search',
    context:{requestId:`adv-${Date.now()}-${Math.random().toString(16).slice(2)}`,matchId:'advisory',revision:record.actions.length,taskId:'advisory',actor:targetActor},
    record,
    level,
    seed:(Number(seed)>>>0)||1,
    budget:profile,
  };
  const workers=[];
  let ctrl=null;
  let cancel=()=>{};
  const promise=new Promise((resolve,reject)=>{
    let settled=false;
    let cleaned=false;
    let watchdog=null;
    const cleanup=()=>{
      if(cleaned)return;
      cleaned=true;
      clearTimeout(watchdog);
      if(ctrl)Atomics.store(ctrl,CTRL_JOB_SEQ,-1);
      for(const w of workers){
        w.onmessage=null;w.onerror=null;w.onmessageerror=null;
        try{w.terminate();}catch{}
      }
    };
    const settle=(ok,val)=>{
      if(settled)return;
      settled=true;
      cleanup();
      if(ok)resolve(val);else reject(val);
    };
    cancel=()=>settle(false,Error('已取消推演。'));
    watchdog=setTimeout(()=>settle(false,Error('AI 推演超时。')),Math.max(15000,(profile.timeMs||2000)+12000));
    const fail=()=>settle(false,Error('AI 推演线程运行失败。'));
    const finish=(reply,score=null)=>{
      if(['move','timeout','ok'].includes(reply?.status)&&reply?.action){
        settle(true,{action:reply.action,stats:reply.stats,score,targetActor,targetColor,swapped:swapSide,elapsedMs:reply.stats?.elapsedMs??0});
      }else settle(false,Error('AI 推演未得到有效着法。'));
    };
    try{
      if(typeof Worker!=='function'){settle(false,Error('当前环境不支持后台 AI 计算。'));return;}
      const useSmp=level==='hard'&&isV21Rules(record.rules)&&typeof SharedArrayBuffer==='function'&&globalThis.crossOriginIsolated===true;
      if(!useSmp){
        const w=new Worker(new URL('../ai/src/worker-entry.js',import.meta.url),{type:'module',name:'qiline-advisory'});
        workers.push(w);
        w.onerror=fail;w.onmessageerror=fail;
        let posted=false;
        w.onmessage=ev=>{
          if(settled)return;
          const d=ev?.data;
          if(d?.kind==='ready'&&!posted){
            posted=true;
            try{w.postMessage(request);}catch{fail();}
          }else if(d?.kind==='result')finish(d);
        };
        return;
      }
      const hw=typeof navigator!=='undefined'&&Number.isFinite(navigator.hardwareConcurrency)?navigator.hardwareConcurrency:4;
      const threadCount=hw>=20?Math.min(16,Math.floor(hw*0.75)):hw>=8?Math.min(12,Math.floor(hw/2)):Math.max(1,hw-1);
      const ttSlots=1<<20;
      const ttBuf=new SharedArrayBuffer(ttSlots*SHARED_TT_STRIDE*4);
      const ctrlBuf=new SharedArrayBuffer(CTRL_BUFFER_BYTES);
      ctrl=new Int32Array(ctrlBuf);
      const jobSeq=1;
      ctrl[CTRL_THREAD_COUNT]=threadCount;
      Atomics.store(ctrl,CTRL_TT_GEN,1);
      Atomics.store(ctrl,CTRL_MAX_DEPTH,0);
      Atomics.store(ctrl,CTRL_JOB_SEQ,jobSeq);
      const workerUrl=new URL('../ai/src/v21-smp-worker.js',import.meta.url);
      let lastScore=null;
      const readyList=[];
      for(let tid=0;tid<threadCount;tid++){
        const w=new Worker(workerUrl,{type:'module',name:`qiline-adv-${tid}`});
        workers.push(w);
        w.onerror=fail;w.onmessageerror=fail;
        readyList.push(new Promise(res=>{
          w.onmessage=ev=>{
            if(settled)return;
            const d=ev?.data;
            if(d?.kind==='smp-boot'){
              try{w.postMessage({kind:'smp-init',threadId:tid,sharedTTBuf:ttBuf,sharedTTSlots:ttSlots,controlBuf:ctrlBuf,warmupHard:true});}catch{fail();}
            }else if(d?.kind==='smp-ready')res();
            else if(tid===0&&d?.jobSeq===jobSeq){
              if(d.kind==='smp-progress'){
                if(Number.isFinite(d.score))lastScore=d.score;
                onProgress?.({depth:d.depth,totalNodes:d.totalNodes,elapsedMs:d.elapsedMs,score:lastScore,threads:threadCount});
              }else if(d.kind==='smp-done')finish(d.reply,lastScore);
            }
          };
        }));
      }
      Promise.all(readyList).then(()=>{
        if(settled)return;
        for(const w of workers)w.postMessage({kind:'smp-run',jobSeq,request,fullPower:true,ponder:false,keepTT:false});
      }).catch(fail);
    }catch{fail();}
  });
  return {promise,cancel};
}

export async function saveGameRecordToLibrary({id,title,record,outcome,players,searches=[]}){
  if(!record||!Array.isArray(record.actions))throw Error('没有可保存的有效棋谱。');
  const db=await openRecords();
  try{
    const existing=await readAll(db);
    const prev=existing.find(x=>x.id===id);
    const entry={
      id,
      title,
      record,
      status:outcome?'terminal':'unfinished',
      candidateActor:null,
      players:players??{A:{name:'执黑'},B:{name:'执白'}},
      searches,
      outcome:outcome??null,
      winner:outcome?.kind==='win'?outcome.winner:null,
      error:null,
      importedAt:prev?.importedAt??Date.now(),
      updatedAt:Date.now(),
    };
    const merged=prev?(()=>{try{return mergeRecord(prev,entry);}catch{return {...entry,id:`${id}-${Date.now()}`};}})():entry;
    await saveAll(db,[merged]);
    return merged;
  }finally{
    try{db.close();}catch{}
  }
}

export function buildMatchFrameRecord(sourceRecord,cursor){
  const actions=sourceRecord.actions.slice(0,Math.max(0,cursor));
  let m=createMatch(sourceRecord.rules).value;
  for(const a of actions){const r=applyAction(m,a);if(r.ok)m=r.value.match;}
  return exportRecord(m);
}
