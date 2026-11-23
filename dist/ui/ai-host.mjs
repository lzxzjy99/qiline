import {activePlayer,applyAction,exportRecord} from '../core/src/index.js';
import {AI_PROFILES,AI_PROTOCOL_VERSION} from '../ai/src/index.js';
import {SHARED_TT_STRIDE,CTRL_JOB_SEQ,CTRL_MAX_DEPTH,CTRL_ACTIVE_WORKERS,CTRL_TT_GEN,CTRL_THREAD_COUNT,CTRL_NODES_BASE,CTRL_NODES_STRIDE,CTRL_BUFFER_BYTES} from '../ai/src/v21-engine.js';
import {createRecoveringAI} from './ai-recovery.mjs';
import {initWebGpuMcts,getWebGpuMctsStatus,runWebGpuMctsSearch} from './webgpu-mcts.mjs';

export const PERF_MODES=Object.freeze(['turbo','extreme','standard']);

function actionToMoveCode(act){
  if(!act)return -1;
  if(act.kind==='place'&&Number.isInteger(act.point))return act.point;
  if(act.kind==='pass')return 81;
  if(act.kind==='choose-color')return act.color==='black'?82:83;
  return -1;
}

function moveCodeToAction(code,actor){
  if(code>=0&&code<81)return {kind:'place',actor,point:code};
  if(code===81)return {kind:'pass',actor};
  if(code===82)return {kind:'choose-color',actor,color:'black'};
  if(code===83)return {kind:'choose-color',actor,color:'white'};
  return null;
}

export function detectHardwareCapabilities(){
  const hw=typeof navigator!=='undefined'&&Number.isFinite(navigator.hardwareConcurrency)?navigator.hardwareConcurrency:4;
  // Uncapped multi-core scaling: saturates physical cores in turbo, unlocks all logical threads in extreme!
  const turboThreads=hw>=20?Math.min(16,Math.floor(hw*0.75)):hw>=8?Math.min(12,Math.floor(hw/2)):Math.max(1,hw-1);
  const extremeThreads=Math.min(32,Math.max(1,hw));
  const isolated=typeof globalThis.crossOriginIsolated==='boolean'&&globalThis.crossOriginIsolated===true;
  const sabSupported=isolated&&typeof SharedArrayBuffer==='function'&&typeof Atomics==='object';
  const webgpuSupported=typeof navigator!=='undefined'&&!!navigator.gpu;
  const nativeDesktop=typeof window!=='undefined'&&!!window.qilineDesktop?.nativeEngine;
  const memGB=typeof navigator!=='undefined'&&Number.isFinite(navigator.deviceMemory)?navigator.deviceMemory:8;
  // 4M slots = 160 MB on desktop / >=8GB devices; 1M slots = 40 MB on smaller devices.
  const ttSlots=sabSupported?(memGB>=8||hw>=8?(1<<22):(1<<20)):(1<<18);
  const ttMB=Math.round((ttSlots*SHARED_TT_STRIDE*4)/1048576);
  return Object.freeze({
    logicalCores:hw,
    recommendedThreads:sabSupported?turboThreads:1,
    turboThreads,
    extremeThreads,
    sabSupported,
    webgpuSupported,
    nativeDesktop,
    ttSlots,
    ttMB,
  });
}

function isV21Rules(rules){
  return !!rules&&rules.boardSize===9&&rules.directions==='diagonal'&&rules.confirmationDelay===4
    &&rules.claimMode==='fixed-five'&&rules.superko==='positional';
}

/**
 * Multi-Device 4-Tier Adaptive AI Host for Qiline v0.13.0 (Gen-8 · v27):
 *   Easy/Std : v27 Lite Ultra-Low-Resource WASM (125KB NNUE-Lite, ~1.44MB RAM, ~1-4ms/move, 0% GPU, zero SAB/Sidecar!)
 *   Tier 1/2 : WebGPU v27-pro12 (12b x 128ch, 28-plane FP16) Batched MCTS + Tactical Guard (auto-gated >= 1,200 b/s)
 *   Tier 1B  : Electron Desktop Native AVX2 Multi-Thread Sidecar (qiline-engine.exe + Gen-8 NNUE v5, 256MB lock-free TT)
 *   Tier 3   : Multi-Worker v27 WASM SIMD128 Lazy SMP (uncapped cores + 160MB SAB TT + Ponder)
 *   Tier 4   : Single-Core v27 WASM SIMD128 (Gen-8 NNUE v5 + 38KB Policy, works everywhere incl. mobile/GitHub Pages)
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

  // Lazy probes for WebGPU & Desktop Native Sidecar: ONLY started for Hard 9x9 sessions so Easy/Standard use 0% GPU & 0 Sidecar RAM!
  let hardProbesStarted=false;
  let gpuReadyInfo=getWebGpuMctsStatus();
  let nativeInfo=null;
  let activeGpuCancel=null;
  let activeNativeSearch=false;
  let activeNativeOffProgress=null;

  // Dedicated single ultra-light worker for Easy / Standard (~1.44 MB WASM, no SAB, no Hard NNUE decode)
  let litePool=null;
  let liteBusy=false;

  // Persistent warm Hard WASM worker pool (lazily initialized only when Hard CPU WASM tier is needed)
  let pool=null;

  function sessionNeedsHardAI(){
    const st=session?.state;
    if(!st||!isV21Rules(st.match?.rules))return false;
    const c=st.controllers;
    return (c?.A?.kind==='ai'&&c.A.level==='hard')||(c?.B?.kind==='ai'&&c.B.level==='hard');
  }

  function ensureHardProbes(){
    if(hardProbesStarted||closed)return;
    hardProbesStarted=true;
    if(caps.webgpuSupported){
      initWebGpuMcts().then(()=>{
        gpuReadyInfo=getWebGpuMctsStatus();
        emitTelemetry({});
      }).catch(()=>{});
    }
    if(caps.nativeDesktop){
      window.qilineDesktop.nativeEngine.getInfo().then(info=>{
        nativeInfo=info&&info.available?info:{available:false};
        emitTelemetry({});
      }).catch(()=>{nativeInfo={available:false};});
    }
  }

  function activeBackendId(){
    if(!sessionNeedsHardAI()){
      return isV21Rules(session?.state?.match?.rules)?'lite-wasm':'wasm-1t';
    }
    if(perfMode==='standard')return 'wasm-1t';
    if(gpuReadyInfo?.available)return 'webgpu';
    if(nativeInfo?.available)return 'native';
    if(caps.sabSupported&&desiredWasmThreads()>1)return 'wasm-smp';
    return 'wasm-1t';
  }

  function desiredNativeThreads(){
    if(!nativeInfo?.available)return caps.turboThreads;
    if(perfMode==='extreme')return Math.max(1,Math.min(32,nativeInfo.logicalCores||caps.extremeThreads));
    return Math.max(1,Math.min(32,nativeInfo.physicalCores||nativeInfo.perfCores||caps.turboThreads));
  }

  function desiredWasmThreads(){
    if(perfMode==='standard'||!caps.sabSupported)return 1;
    return perfMode==='extreme'?caps.extremeThreads:caps.turboThreads;
  }

  function emitTelemetry(patch){
    if(!onTelemetry||closed)return;
    const backend=patch?.backend||activeBackendId();
    const defaultThreads=backend==='lite-wasm'||backend==='webgpu'?1:backend==='native'?desiredNativeThreads():(pool?pool.threadCount:desiredWasmThreads());
    const defaultTtMB=backend==='lite-wasm'?1:backend==='webgpu'?64:backend==='native'?256:(pool?pool.ttMB:(perfMode==='standard'?14:caps.ttMB));
    try{
      onTelemetry(Object.freeze({
        perfMode,
        backend,
        gpuLabel:gpuReadyInfo?.gpuLabel||null,
        gpuAvailable:!!gpuReadyInfo?.available,
        nativeAvailable:!!nativeInfo?.available,
        nativeInfo,
        sabSupported:caps.sabSupported,
        logicalCores:nativeInfo?.logicalCores||caps.logicalCores,
        threads:defaultThreads,
        ttMB:defaultTtMB,
        pondering,
        ...patch,
      }));
    }catch{}
  }

  // Only start GPU / Native probes on boot when this session actually uses Hard 9x9 AI!
  if(sessionNeedsHardAI()){
    ensureHardProbes();
  }

  function destroyLitePool(){
    liteBusy=false;
    if(!litePool)return;
    const old=litePool;litePool=null;
    try{old.worker.onmessage=null;old.worker.onerror=null;old.worker.onmessageerror=null;old.worker.terminate();}catch{}
  }

  function ensureLitePool(){
    if(litePool)return litePool;
    const workerUrl=new URL('../ai/src/v21-smp-worker.js',import.meta.url);
    const worker=new Worker(workerUrl,{type:'module',name:'qiline-ai-lite'});
    const onFatal=()=>{if(litePool&&litePool.worker===worker)destroyLitePool();};
    worker.addEventListener('error',onFatal);
    const ready=new Promise((resolve,reject)=>{
      const onBoot=ev=>{
        const d=ev?.data;
        if(d&&d.kind==='smp-boot'){
          worker.postMessage({kind:'smp-init',threadId:0,sharedTTBuf:null,sharedTTSlots:0,controlBuf:null,warmupHard:false});
        }else if(d&&d.kind==='smp-ready'){
          worker.removeEventListener('message',onBoot);
          worker.removeEventListener('error',onErr);
          resolve();
        }
      };
      const onErr=err=>{
        worker.removeEventListener('message',onBoot);
        worker.removeEventListener('error',onErr);
        onFatal();
        reject(err);
      };
      worker.addEventListener('message',onBoot);
      worker.addEventListener('error',onErr);
    });
    litePool={worker,ready};
    return litePool;
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
    const wantThreads=desiredWasmThreads();
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
      w.addEventListener('error',()=>{if(pool&&pool.workers.includes(w))destroyPool();});
      readyPromises.push(new Promise((resolve,reject)=>{
        const onBoot=ev=>{
          const d=ev?.data;
          if(d&&d.kind==='smp-boot'){
            w.postMessage({kind:'smp-init',threadId:tid,sharedTTBuf:ttBuf,sharedTTSlots:ttSlots,controlBuf:ctrlBuf,warmupHard:true});
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
    if(activeGpuCancel){
      const fn=activeGpuCancel;activeGpuCancel=null;
      try{fn();}catch{}
    }
    if(activeNativeSearch){
      activeNativeSearch=false;
      if(activeNativeOffProgress){try{activeNativeOffProgress();}catch{} activeNativeOffProgress=null;}
      try{window.qilineDesktop?.nativeEngine?.stop();}catch{}
    }
    if(hardResetIfBusy&&liteBusy){
      destroyLitePool();
    }
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
      destroyPool();
    }
  }

  function startPonderIfEligible(){
    // Only CPU WASM SMP needs background ponder (WebGPU MCTS & Native Sidecar are instant on demand)
    if(closed||!supportsEventWorker||perfMode!=='extreme'||!caps.sabSupported||activePort)return;
    if(gpuReadyInfo?.available||nativeInfo?.available)return;
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
      emitTelemetry({backend:'wasm-smp',totalNodes:0,depth:0,nps:0,elapsedMs:0,pondering:true});
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

    function dispatchWasm(request,seq){
      if(terminated||closed||mySeq!==seq)return;
      const p=ensurePool();
      const isHardV21=request?.level==='hard'&&isV21Rules(request?.record?.rules);
      const useMulti=isHardV21&&perfMode!=='standard'&&p.threadCount>1&&!!p.ctrl;
      const useFullPower=isHardV21&&perfMode!=='standard';
      const useKeepTT=isHardV21&&perfMode!=='standard';
      const activeThreads=useMulti?p.threadCount:1;
      const backendTag=useMulti?'wasm-smp':'wasm-1t';

      p.ready.then(()=>{
        if(terminated||closed||mySeq!==seq||pool!==p)return;
        if(p.ctrl){
          p.ctrl[CTRL_THREAD_COUNT]=activeThreads;
          for(let t=0;t<p.threadCount;t++)p.ctrl[CTRL_NODES_BASE+t*CTRL_NODES_STRIDE]=0;
          Atomics.store(p.ctrl,CTRL_TT_GEN,(++ttGen)&63);
          Atomics.store(p.ctrl,CTRL_MAX_DEPTH,0);
          Atomics.store(p.ctrl,CTRL_JOB_SEQ,seq);
        }
        emitTelemetry({backend:backendTag,threads:activeThreads,ttMB:useMulti?p.ttMB:14,totalNodes:0,depth:0,nps:0,elapsedMs:0,pondering:false});
        const mainW=p.workers[0];
        const onMainMsg=ev=>{
          const d=ev?.data;
          if(!d||d.jobSeq!==seq)return;
          if(d.kind==='smp-progress'){
            const nps=d.elapsedMs>20?Math.round(d.totalNodes/(d.elapsedMs/1000)):0;
            emitTelemetry({backend:backendTag,threads:activeThreads,ttMB:useMulti?p.ttMB:14,totalNodes:d.totalNodes,depth:d.depth,nps,elapsedMs:d.elapsedMs,score:d.score,bestCode:d.bestCode,pondering:false});
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
      }).catch(err=>{
        destroyPool();
        if(!terminated&&!closed&&onerror)onerror(err);
      });
    }

    function replyActionLegalForSession(reply,request){
      if(!reply||!['move','timeout'].includes(reply.status)||!reply.action)return true;
      const curMatch=session?.state?.match;
      const reqLen=request?.record?.actions?.length;
      if(!curMatch||!Number.isInteger(reqLen)||curMatch.accepted.length!==reqLen)return true;
      return applyAction(curMatch,reply.action).ok;
    }

    async function dispatchNative(request,seq){
      if(!caps.nativeDesktop||terminated||closed||mySeq!==seq)return false;
      try{
        if(!nativeInfo)nativeInfo=await window.qilineDesktop.nativeEngine.getInfo();
        if(!nativeInfo?.available||terminated||closed||mySeq!==seq)return false;

        const record=request?.record;
        const actor=request?.context?.actor;
        const swap3=record?.rules?.swap3!==false;
        const moves=[];
        for(const act of (record?.actions||[])){
          const c=actionToMoveCode(act);
          if(c>=0)moves.push(c);
        }
        const threads=desiredNativeThreads();
        const ttMb=256;
        const reqTime=Number(request?.budget?.timeMs)||120000;
        const targetMs=Math.max(300,Math.min(perfMode==='extreme'?15000:5000,reqTime-150));

        activeNativeSearch=true;
        emitTelemetry({backend:'native',threads,ttMB:ttMb,totalNodes:0,depth:0,nps:0,elapsedMs:0,pondering:false});
        activeNativeOffProgress=window.qilineDesktop.nativeEngine.onProgress(msg=>{
          if(terminated||closed||mySeq!==seq)return;
          emitTelemetry({
            backend:'native',
            threads:msg.threads||threads,
            ttMB:msg.ttMb||ttMb,
            totalNodes:msg.nodes||0,
            depth:msg.depth||0,
            nps:msg.nps||0,
            elapsedMs:msg.elapsedMs||0,
            score:Number.isFinite(msg.score)?msg.score:null,
            bestCode:msg.bestMove,
            pondering:false,
          });
        });

        const res=await window.qilineDesktop.nativeEngine.search({
          swap3,
          moves,
          timeMs:targetMs,
          nodeBudget:200000000,
          maxDepth:Math.min(20,Number(request?.budget?.maxDepth)||16),
          threads,
          ttMb,
          seed:(Number(request?.seed)>>>0)||1,
          randomize:false,
          clearTt:false,
        });

        activeNativeSearch=false;
        if(activeNativeOffProgress){try{activeNativeOffProgress();}catch{} activeNativeOffProgress=null;}
        if(terminated||closed||mySeq!==seq)return true;
        if(!res?.ok)return false;

        const action=moveCodeToAction(res.bestMove,actor);
        if(!action)return false;
        const maxNodes=Math.max(1,Number(request?.budget?.maxNodes)||4000000);
        const maxDepth=Math.max(1,Number(request?.budget?.maxDepth)||16);
        const reply={
          protocolVersion:AI_PROTOCOL_VERSION,
          kind:'result',
          context:request.context,
          status:'move',
          action,
          stats:{
            elapsedMs:Math.max(0,Number(res.elapsedMs)||0),
            nodes:Math.max(1,Math.min(Math.round(res.nodes||1),maxNodes)),
            completedDepth:Math.max(1,Math.min(Math.round(res.completedDepth||1),maxDepth)),
          },
        };
        if(!replyActionLegalForSession(reply,request))return false;
        emitTelemetry({
          backend:'native',
          threads:res.threads||threads,
          ttMB:res.ttMb||ttMb,
          totalNodes:res.nodes||0,
          depth:res.completedDepth||0,
          nps:res.nps||0,
          elapsedMs:res.elapsedMs||0,
          score:Number.isFinite(res.score)?res.score:null,
          bestCode:res.bestMove,
          pondering:false,
        });
        finished=true;
        if(activePort===port)activePort=null;
        if(onmessage)onmessage({data:reply});
        return true;
      }catch{
        activeNativeSearch=false;
        if(activeNativeOffProgress){try{activeNativeOffProgress();}catch{} activeNativeOffProgress=null;}
        return false;
      }
    }

    function dispatchLite(request,seq){
      if(terminated||closed||mySeq!==seq)return;
      const lp=ensureLitePool();
      const isLiteV27=(request?.level==='easy'||request?.level==='standard')&&isV21Rules(request?.record?.rules);
      const backendTag=isLiteV27?'lite-wasm':'wasm-1t';
      lp.ready.then(()=>{
        if(terminated||closed||mySeq!==seq||litePool!==lp)return;
        liteBusy=true;
        const w=lp.worker;
        const onMsg=ev=>{
          const d=ev?.data;
          if(!d||d.jobSeq!==seq)return;
          if(d.kind==='smp-done'){
            w.removeEventListener('message',onMsg);
            w.removeEventListener('error',onErr);
            liteBusy=false;
            finished=true;
            if(activePort===port)activePort=null;
            if(isLiteV27&&d.reply?.stats){
              emitTelemetry({
                backend:backendTag,
                threads:1,
                ttMB:1,
                totalNodes:d.reply.stats.nodes||0,
                depth:d.reply.stats.completedDepth||0,
                nps:d.reply.stats.elapsedMs>0?Math.round((d.reply.stats.nodes||0)*1000/d.reply.stats.elapsedMs):0,
                elapsedMs:d.reply.stats.elapsedMs||0,
                pondering:false,
              });
            }
            if(!terminated&&!closed&&onmessage){
              onmessage({data:d.reply});
            }
          }
        };
        const onErr=err=>{
          w.removeEventListener('message',onMsg);
          w.removeEventListener('error',onErr);
          liteBusy=false;
          if(activePort===port)activePort=null;
          destroyLitePool();
          if(!terminated&&!closed&&onerror)onerror(err);
        };
        w.addEventListener('message',onMsg);
        w.addEventListener('error',onErr);
        w.postMessage({kind:'smp-run',jobSeq:seq,request,fullPower:false,ponder:false,keepTT:false});
      }).catch(err=>{
        liteBusy=false;
        destroyLitePool();
        if(!terminated&&!closed&&onerror)onerror(err);
      });
    }

    async function dispatchBestTier(request,seq){
      const isHardV21=request?.level==='hard'&&isV21Rules(request?.record?.rules);
      if(!isHardV21){
        // Easy / Standard / non-9x9: single ultra-light worker (~1.44 MB RAM, 0% GPU, zero SAB/Sidecar!)
        dispatchLite(request,seq);
        return;
      }
      ensureHardProbes();
      if(perfMode!=='standard'){
        // Tier 1 / Tier 2: WebGPU GPU MCTS (auto-gated >= 1,200 boards/s!)
        if(caps.webgpuSupported&&!(gpuReadyInfo?.ready&&!gpuReadyInfo?.available)){
          emitTelemetry({backend:'webgpu',threads:1,ttMB:64,totalNodes:0,depth:0,nps:0,elapsedMs:0,pondering:false});
          const job=runWebGpuMctsSearch(request,{
            perfMode,
            onProgress:prog=>{
              if(terminated||closed||mySeq!==seq)return;
              gpuReadyInfo=getWebGpuMctsStatus();
              emitTelemetry({...prog,backend:'webgpu',threads:1,ttMB:64,pondering:false});
            },
          });
          activeGpuCancel=job.cancel;
          const out=await job.promise;
          if(activeGpuCancel===job.cancel)activeGpuCancel=null;
          gpuReadyInfo=getWebGpuMctsStatus();
          if(terminated||closed||mySeq!==seq)return;
          if(out.ok&&out.reply&&replyActionLegalForSession(out.reply,request)){
            finished=true;
            if(activePort===port)activePort=null;
            if(onmessage)onmessage({data:out.reply});
            return;
          }
          // Fall through cleanly if GPU was unavailable, below 1,200 boards/s, or action failed legality!
        }

        // Tier 1B: Desktop Native AVX2 Multi-Thread Sidecar (qiline-engine.exe)
        if(caps.nativeDesktop){
          const handled=await dispatchNative(request,seq);
          if(handled||terminated||closed||mySeq!==seq)return;
        }
      }

      // Tier 3 (WASM Multi-Core SMP) & Tier 4 (WASM Single-Core)
      dispatchWasm(request,seq);
    }

    const port={
      get onmessage(){return onmessage;},set onmessage(h){onmessage=forward(h);},
      get onerror(){return onerror;},set onerror(h){onerror=forward(h);},
      get onmessageerror(){return onmessageerror;},set onmessageerror(h){onmessageerror=forward(h);},
      postMessage(request){
        if(terminated||closed)return;
        stopWorkersNow(false);
        const seq=++jobSeq;
        mySeq=seq;
        dispatchBestTier(request,seq).catch(err=>{
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
        }else if(pool?.ctrl&&mySeq>=0){
          Atomics.compareExchange(pool.ctrl,CTRL_JOB_SEQ,mySeq,-1);
        }
      },
    };
    activePort=port;
    // If current turn isn't Hard 9x9, wait for cold Lite Worker boot before emitting 'ready' so startupMs (5s)
    // covers initial JS/WASM compile instead of eating Easy's 300ms search timeout!
    if(!sessionNeedsHardAI()){
      ensureLitePool().ready.then(()=>{
        if(!terminated&&!closed&&onmessage){
          onmessage({data:{protocolVersion:AI_PROTOCOL_VERSION,kind:'ready'}});
        }
      }).catch(err=>{
        destroyLitePool();
        if(!terminated&&!closed&&onerror)onerror(err);
      });
    }else{
      Promise.resolve().then(()=>{
        if(!terminated&&!closed&&onmessage){
          onmessage({data:{protocolVersion:AI_PROTOCOL_VERSION,kind:'ready'}});
        }
      });
    }
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

  if(!created.ok){destroyLitePool();destroyPool();return created;}
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
      stopWorkersNow(false);
      destroyLitePool();
      destroyPool();
      return inner.close();
    },
  };
  return {ok:true,value:driver};
}
