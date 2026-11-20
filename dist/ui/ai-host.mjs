import {activePlayer,exportRecord} from '../core/src/index.js';
import {AI_PROFILES,AI_PROTOCOL_VERSION} from '../ai/src/index.js';
import {SHARED_TT_STRIDE,CTRL_JOB_SEQ,CTRL_MAX_DEPTH,CTRL_ACTIVE_WORKERS,CTRL_TT_GEN,CTRL_THREAD_COUNT,CTRL_NODES_BASE,CTRL_NODES_STRIDE,CTRL_BUFFER_BYTES} from '../ai/src/v21-engine.js';
import {createRecoveringAI} from './ai-recovery.mjs';

export const PERF_MODES=Object.freeze(['turbo','extreme','standard']);

export function detectHardwareCapabilities(){
  const hw=typeof navigator!=='undefined'&&Number.isFinite(navigator.hardwareConcurrency)?navigator.hardwareConcurrency:4;
  // Optimal physical-core estimate: avoids SMT FPU/cache contention on 8C/16T CPUs while saturating all physical cores.
  const recommendedThreads=hw>=8?Math.min(8,Math.floor(hw/2)):Math.max(1,hw-1);
  const isolated=typeof globalThis.crossOriginIsolated==='boolean'&&globalThis.crossOriginIsolated===true;
  const sabSupported=isolated&&typeof SharedArrayBuffer==='function'&&typeof Atomics==='object';
  const memGB=typeof navigator!=='undefined'&&Number.isFinite(navigator.deviceMemory)?navigator.deviceMemory:8;
  // 4M slots = 160 MB on desktop / >=8GB devices; 1M slots = 40 MB on smaller devices.
  const ttSlots=sabSupported?(memGB>=8||hw>=8?(1<<22):(1<<20)):(1<<18);
  const ttMB=Math.round((ttSlots*SHARED_TT_STRIDE*4)/1048576);
  return Object.freeze({
    logicalCores:hw,
    recommendedThreads:sabSupported?recommendedThreads:1,
    sabSupported,
    ttSlots,
    ttMB,
  });
}

function isV21Rules(rules){
  return !!rules&&rules.boardSize===9&&rules.directions==='diagonal'&&rules.confirmationDelay===4
    &&rules.claimMode==='fixed-five'&&rules.superko==='positional';
}

/**
 * Browser and Electron renderer host with persistent warm multi-core Lazy SMP Worker pool,
 * lock-free SharedArrayBuffer TT (160 MB on desktop), optional Ponder, and graceful single-core fallback.
 */
export function createBrowserAI(session,onState,limits,canContinue=()=>true,options={}){
  if(typeof canContinue!=='function')return {ok:false,error:{code:'INVALID_AI_REQUEST'}};
  const caps=detectHardwareCapabilities();
  let perfMode=PERF_MODES.includes(options?.perfMode)?options.perfMode:'turbo';
  const onTelemetry=typeof options?.onTelemetry==='function'?options.onTelemetry:null;

  let driver;
  let closed=false;
  let jobSeq=0;
  let ttGen=0;
  let activePort=null;
  let pondering=false;
  let ponderSeq=-1;

  // Persistent warm worker pool (lazily initialized on first AI turn)
  let pool=null; // { workers, readyPromises, ttBuf, ttSlots, ttMB, ctrlBuf, ctrl, threadCount }

  function emitTelemetry(patch){
    if(!onTelemetry||closed)return;
    try{
      onTelemetry(Object.freeze({
        perfMode,
        sabSupported:caps.sabSupported,
        logicalCores:caps.logicalCores,
        threads:pool?pool.threadCount:(perfMode==='standard'?1:caps.recommendedThreads),
        ttMB:pool?pool.ttMB:(perfMode==='standard'?14:caps.ttMB),
        pondering,
        ...patch,
      }));
    }catch{}
  }

  function desiredThreads(){
    if(perfMode==='standard'||!caps.sabSupported)return 1;
    return caps.recommendedThreads;
  }

  function destroyPool(){
    pondering=false;ponderSeq=-1;
    if(!pool)return;
    const old=pool;pool=null;
    try{if(old.ctrl)Atomics.store(old.ctrl,CTRL_JOB_SEQ,-1);}catch{}
    for(const w of old.workers){
      try{w.onmessage=null;w.onerror=null;w.onmessageerror=null;w.terminate();}catch{}
    }
  }

  function ensurePool(){
    const wantThreads=desiredThreads();
    if(pool&&pool.threadCount===wantThreads)return pool;
    destroyPool();
    const useSAB=caps.sabSupported&&wantThreads>1;
    let ttBuf=null,ttSlots=0,ttMB=14,ctrlBuf=null,ctrl=null;
    if(useSAB){
      try{
        ttSlots=caps.ttSlots;
        ttBuf=new SharedArrayBuffer(ttSlots*SHARED_TT_STRIDE*4);
        ctrlBuf=new SharedArrayBuffer(CTRL_BUFFER_BYTES);
        ctrl=new Int32Array(ctrlBuf);
        Atomics.store(ctrl,CTRL_JOB_SEQ,-1);
        ttMB=Math.round(ttBuf.byteLength/1048576);
      }catch{
        ttBuf=null;ttSlots=0;ctrlBuf=null;ctrl=null;ttMB=14;
      }
    }
    const threadCount=ttBuf?wantThreads:1;
    const workerUrl=new URL('../ai/src/v21-smp-worker.js',import.meta.url);
    const workers=[];
    const readyPromises=[];
    for(let tid=0;tid<threadCount;tid++){
      const w=new Worker(workerUrl,{type:'module',name:`qiline-ai-${tid}`});
      workers.push(w);
      readyPromises.push(new Promise((resolve,reject)=>{
        const onBoot=ev=>{
          const d=ev?.data;
          if(d&&d.kind==='smp-boot'){
            w.postMessage({kind:'smp-init',threadId:tid,sharedTTBuf:ttBuf,sharedTTSlots:ttSlots,controlBuf:ctrlBuf});
          }else if(d&&d.kind==='smp-ready'){
            w.removeEventListener('message',onBoot);
            w.removeEventListener('error',onErr);
            resolve();
          }
        };
        const onErr=err=>{
          w.removeEventListener('message',onBoot);
          w.removeEventListener('error',onErr);
          reject(err);
        };
        w.addEventListener('message',onBoot);
        w.addEventListener('error',onErr);
      }));
    }
    pool={workers,ready:Promise.all(readyPromises),ttBuf,ttSlots,ttMB,ctrlBuf,ctrl,threadCount};
    return pool;
  }

  function stopWorkersNow(hardResetIfBusy=false){
    pondering=false;ponderSeq=-1;
    if(!pool)return;
    if(pool.ctrl){
      Atomics.store(pool.ctrl,CTRL_JOB_SEQ,-1);
      if(hardResetIfBusy){
        const p=pool;
        setTimeout(()=>{
          if(pool===p&&p.ctrl&&Atomics.load(p.ctrl,CTRL_ACTIVE_WORKERS)>0){
            destroyPool();
          }
        },350);
      }
    }else if(hardResetIfBusy){
      // Single-thread fallback without SAB cannot be interrupted via Atomics: terminate immediately.
      destroyPool();
    }
  }

  function startPonderIfEligible(){
    if(closed||!supportsEventWorker||perfMode!=='extreme'||!caps.sabSupported||activePort)return;
    const st=session?.state;
    if(!st||st.closed||st.paused||st.match.state.outcome)return;
    const actor=activePlayer(st.match);
    if(!actor||st.controllers[actor]?.kind!=='human')return;
    const otherActor=actor==='A'?'B':'A';
    const aiCtrl=st.controllers[otherActor];
    if(!aiCtrl||aiCtrl.kind!=='ai'||aiCtrl.level!=='hard'||!isV21Rules(st.match.rules))return;
    let p;
    try{p=ensurePool();}catch{return;}
    if(!p.ctrl||p.threadCount<2)return;
    const seq=++jobSeq;
    ponderSeq=seq;
    pondering=true;
    const record=exportRecord(st.match);
    const ponderReq={
      protocolVersion:AI_PROTOCOL_VERSION,
      kind:'search',
      context:{requestId:`ponder-${seq}`,matchId:st.matchId,revision:st.revision,taskId:`ponder-${seq}`,actor},
      record,
      level:'hard',
      seed:(st.seed??1)^seq,
      budget:AI_PROFILES.hard,
    };
    p.ready.then(()=>{
      if(closed||!pondering||ponderSeq!==seq||activePort||pool!==p)return;
      p.ctrl[CTRL_THREAD_COUNT]=p.threadCount;
      for(let t=0;t<p.threadCount;t++)p.ctrl[CTRL_NODES_BASE+t*CTRL_NODES_STRIDE]=0;
      Atomics.store(p.ctrl,CTRL_TT_GEN,(++ttGen)&63);
      Atomics.store(p.ctrl,CTRL_MAX_DEPTH,0);
      Atomics.store(p.ctrl,CTRL_JOB_SEQ,seq);
      emitTelemetry({totalNodes:0,depth:0,nps:0,elapsedMs:0,pondering:true});
      for(let tid=0;tid<p.threadCount;tid++){
        p.workers[tid].postMessage({kind:'smp-run',jobSeq:seq,request:ponderReq,fullPower:true,ponder:true,keepTT:true});
      }
    }).catch(()=>{pondering=false;});
  }

  const forward=handler=>handler?event=>{
    let allowed=false;try{allowed=canContinue()===true;}catch{}
    if(!allowed){driver?.pause();return;}
    handler(event);
  }:null;

  const supportsEventWorker=typeof Worker==='function'&&typeof Worker.prototype?.addEventListener==='function';

  function createClassicPort(){
    const worker=new Worker(new URL('../ai/src/worker-entry.js',import.meta.url),{type:'module',name:'qiline-ai'});
    return {
      get onmessage(){return worker.onmessage;},set onmessage(handler){worker.onmessage=forward(handler);},
      get onerror(){return worker.onerror;},set onerror(handler){worker.onerror=forward(handler);},
      get onmessageerror(){return worker.onmessageerror;},set onmessageerror(handler){worker.onmessageerror=forward(handler);},
      postMessage:message=>worker.postMessage(message),terminate:()=>worker.terminate(),
    };
  }

  function createVirtualPort(){
    if(!supportsEventWorker)return createClassicPort();
    stopWorkersNow(false);
    let onmessage=null,onerror=null,onmessageerror=null;
    let terminated=false,finished=false,mySeq=-1;
    const p=ensurePool();
    const port={
      get onmessage(){return onmessage;},set onmessage(h){onmessage=forward(h);},
      get onerror(){return onerror;},set onerror(h){onerror=forward(h);},
      get onmessageerror(){return onmessageerror;},set onmessageerror(h){onmessageerror=forward(h);},
      postMessage(request){
        if(terminated||closed)return;
        stopWorkersNow(false);
        const seq=++jobSeq;
        mySeq=seq;
        const isHardV21=request?.level==='hard'&&isV21Rules(request?.record?.rules);
        const useMulti=isHardV21&&perfMode!=='standard'&&p.threadCount>1&&!!p.ctrl;
        const useFullPower=isHardV21&&perfMode!=='standard';
        const useKeepTT=isHardV21&&perfMode!=='standard';
        const activeThreads=useMulti?p.threadCount:1;

        const dispatch=()=>{
          if(terminated||closed||mySeq!==seq||pool!==p)return;
          if(p.ctrl){
            p.ctrl[CTRL_THREAD_COUNT]=activeThreads;
            for(let t=0;t<p.threadCount;t++)p.ctrl[CTRL_NODES_BASE+t*CTRL_NODES_STRIDE]=0;
            Atomics.store(p.ctrl,CTRL_TT_GEN,(++ttGen)&63);
            Atomics.store(p.ctrl,CTRL_MAX_DEPTH,0);
            Atomics.store(p.ctrl,CTRL_JOB_SEQ,seq);
          }
          emitTelemetry({threads:activeThreads,ttMB:useMulti?p.ttMB:14,totalNodes:0,depth:0,nps:0,elapsedMs:0,pondering:false});
          const mainW=p.workers[0];
          const onMainMsg=ev=>{
            const d=ev?.data;
            if(!d||d.jobSeq!==seq)return;
            if(d.kind==='smp-progress'){
              const nps=d.elapsedMs>20?Math.round(d.totalNodes/(d.elapsedMs/1000)):0;
              emitTelemetry({threads:activeThreads,ttMB:useMulti?p.ttMB:14,totalNodes:d.totalNodes,depth:d.depth,nps,elapsedMs:d.elapsedMs,score:d.score,bestCode:d.bestCode,pondering:false});
              return;
            }
            if(d.kind==='smp-done'){
              mainW.removeEventListener('message',onMainMsg);
              mainW.removeEventListener('error',onMainErr);
              finished=true;
              if(activePort===port)activePort=null;
              if(!terminated&&!closed&&onmessage){
                onmessage({data:d.reply});
              }
            }
          };
          const onMainErr=err=>{
            mainW.removeEventListener('message',onMainMsg);
            mainW.removeEventListener('error',onMainErr);
            if(activePort===port)activePort=null;
            destroyPool();
            if(!terminated&&!closed&&onerror)onerror(err);
          };
          mainW.addEventListener('message',onMainMsg);
          mainW.addEventListener('error',onMainErr);
          for(let tid=0;tid<activeThreads;tid++){
            p.workers[tid].postMessage({kind:'smp-run',jobSeq:seq,request,fullPower:useFullPower,ponder:false,keepTT:useKeepTT});
          }
        };

        p.ready.then(dispatch).catch(err=>{
          destroyPool();
          if(!terminated&&!closed&&onerror)onerror(err);
        });
      },
      terminate(){
        if(terminated)return;
        terminated=true;
        if(activePort===port)activePort=null;
        onmessage=null;onerror=null;onmessageerror=null;
        if(!finished){
          stopWorkersNow(true);
        }else if(p.ctrl&&mySeq>=0){
          Atomics.compareExchange(p.ctrl,CTRL_JOB_SEQ,mySeq,-1);
        }
      },
    };
    activePort=port;
    p.ready.then(()=>{
      if(!terminated&&!closed&&onmessage){
        onmessage({data:{protocolVersion:AI_PROTOCOL_VERSION,kind:'ready'}});
      }
    }).catch(err=>{
      destroyPool();
      if(!terminated&&!closed&&onerror)onerror(err);
    });
    return port;
  }

  const created=createRecoveringAI(session,{
    createWorker:createVirtualPort,
    now:()=>performance.now(),
    setTimer:(callback,ms)=>setTimeout(callback,ms),
    clearTimer:id=>clearTimeout(id),
    onState:next=>{
      if(onState)onState(next);
      if(next.status==='idle')startPonderIfEligible();
      else if(next.status==='paused'||next.status==='closed'||next.status==='failed')stopWorkersNow(false);
    },
  },limits);

  if(!created.ok){destroyPool();return created;}
  const inner=created.value;
  driver={
    get state(){return inner.state;},
    get capabilities(){return caps;},
    get perfMode(){return perfMode;},
    setPerfMode(nextMode){
      if(!PERF_MODES.includes(nextMode)||nextMode===perfMode)return perfMode;
      perfMode=nextMode;
      stopWorkersNow(false);
      if(perfMode!=='extreme')pondering=false;
      emitTelemetry({pondering:false});
      if(inner.state.status==='idle')startPonderIfEligible();
      return perfMode;
    },
    start(){return inner.start();},
    sync(){
      const r=inner.sync();
      if(inner.state.status==='idle')startPonderIfEligible();
      return r;
    },
    change(fn){
      stopWorkersNow(false);
      const r=inner.change(fn);
      if(inner.state.status==='idle')startPonderIfEligible();
      return r;
    },
    pause(){stopWorkersNow(false);return inner.pause();},
    resume(){return inner.resume();},
    retry(){return inner.retry();},
    close(){
      closed=true;
      destroyPool();
      return inner.close();
    },
  };
  return {ok:true,value:driver};
}
