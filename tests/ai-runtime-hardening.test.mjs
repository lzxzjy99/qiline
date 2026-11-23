import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {EventEmitter} from 'node:events';
import vm from 'node:vm';
import {createBrowserAI} from '../dist/ui/ai-host.mjs';
import {runAdvisorySearch} from '../dist/features/board-ai.mjs';
import {initWebGpuMcts,runWebGpuMctsSearch,resetWebGpuMctsForTest} from '../dist/ui/webgpu-mcts.mjs';
import {WebGpuResNet} from '../dist/ui/webgpu-resnet.mjs';
import {CTRL_BUFFER_BYTES,CTRL_JOB_SEQ,CTRL_ACTIVE_WORKERS,CTRL_NODES_BASE,CTRL_NODES_STRIDE} from '../dist/ai/src/v21-engine.js';
import {practice} from './ai-helpers.mjs';

const flush=async()=>{for(let i=0;i<24;i++)await Promise.resolve();};
const tick=async(ms=0)=>{await new Promise(r=>setTimeout(r,ms));await flush();};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
async function promptly(promise){
  let timer;
  try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Promise did not settle promptly')),800);})]);}
  finally{clearTimeout(timer);}
}
function globals(t,values){
  for(const [key,value] of Object.entries(values)){
    const old=Object.getOwnPropertyDescriptor(globalThis,key);
    Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
    t.after(()=>{if(old)Object.defineProperty(globalThis,key,old);else delete globalThis[key];});
  }
}
class WorkerMock extends EventTarget{
  static all=[];
  constructor(url,options){
    super();this.url=String(url);this.name=options?.name;this.sent=[];this.terminated=0;
    WorkerMock.all.push(this);
    queueMicrotask(()=>this.emit('message',{kind:this.url.includes('smp-worker')?'smp-boot':'ready'}));
  }
  emit(type,data){const event=new Event(type);event.data=data;this.dispatchEvent(event);this['on'+type]?.(event);}
  postMessage(message){
    this.sent.push(message);
    if(message.kind==='smp-init'){
      this.ctrl=message.controlBuf?new Int32Array(message.controlBuf):null;
      queueMicrotask(()=>this.emit('message',{kind:'smp-ready'}));
    }
    if(message.kind==='smp-run'&&this.ctrl)Atomics.add(this.ctrl,CTRL_ACTIVE_WORKERS,1);
  }
  terminate(){this.terminated++;}
}
function browser(t,patch={}){
  WorkerMock.all=[];
  globals(t,{Worker:WorkerMock,navigator:{hardwareConcurrency:4,deviceMemory:4},window:undefined,crossOriginIsolated:true,...patch});
}
function host(t,options={}){
  const session=practice('A',{},'hard');
  const result=createBrowserAI(session,null,undefined,()=>true,options);
  assert.equal(result.ok,true);
  const driver=result.value;
  t.after(()=>driver.close());
  return {driver,session};
}
function reply(worker,action={kind:'place',actor:'A',point:40}){
  const run=worker.sent.findLast(m=>m.kind==='smp-run');
  assert.ok(run);
  worker.emit('message',{kind:'smp-done',jobSeq:run.jobSeq,reply:{protocolVersion:1,kind:'result',context:run.request.context,status:'move',action,stats:{elapsedMs:1,nodes:1,completedDepth:1}}});
}

test('engine import leaves the pure-TS TT unallocated; control buffer supports 32 threads',()=>{
  const script=`const before=process.memoryUsage().arrayBuffers;await import('./dist/ai/src/v21-engine.js');console.log(process.memoryUsage().arrayBuffers-before);`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:new URL('../',import.meta.url),encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);
  const bytes=Number(child.stdout.trim());
  assert.ok(bytes<2*1048576,`import allocated ${bytes} bytes`);
  assert.ok((CTRL_NODES_BASE+32*CTRL_NODES_STRIDE)*4<=CTRL_BUFFER_BYTES);
});

test('performance mode changes and rejected/throwing changes preserve an active AITurn',async t=>{
  browser(t);
  const {driver,session}=host(t);
  driver.start();await tick();
  assert.equal(driver.state.status,'thinking');
  const workers=[...WorkerMock.all],ctrl=workers[0].ctrl;
  assert.ok(workers.length>0);
  const seq=Atomics.load(ctrl,CTRL_JOB_SEQ);
  driver.setPerfMode('standard');
  assert.equal(Atomics.load(ctrl,CTRL_JOB_SEQ),seq);
  const failed=driver.change(()=>({ok:false,error:{code:'INVALID_ACTION'}}));
  assert.equal(failed.ok,false);
  assert.equal(Atomics.load(ctrl,CTRL_JOB_SEQ),seq);
  assert.equal(driver.state.status,'thinking');
  assert.ok(workers.every(w=>w.terminated===0));
  reply(workers[0]);await tick();
  assert.equal(session.state.match.state.ply,1);
  assert.equal(driver.state.status,'idle');
});

test('pause and resume inside 350ms cannot destroy the resumed SMP pool',async t=>{
  browser(t);t.mock.timers.enable({apis:['setTimeout']});
  const {driver}=host(t);
  driver.start();t.mock.timers.tick(0);await flush();
  const workers=[...WorkerMock.all],ctrl=workers[0].ctrl;
  assert.ok(workers.length>0);
  driver.pause();driver.resume();t.mock.timers.tick(0);await flush();
  const run=workers[0].sent.findLast(m=>m.kind==='smp-run');
  assert.equal(Atomics.load(ctrl,CTRL_JOB_SEQ),run.jobSeq);
  t.mock.timers.tick(351);await flush();
  assert.equal(WorkerMock.all.length,workers.length);
  assert.ok(workers.every(w=>w.terminated===0));
  assert.equal(driver.state.status,'thinking');
  reply(workers[0]);await flush();
  assert.equal(driver.state.status,'idle');
});

test('an abandoned busy SMP pool is still destroyed after its grace period',async t=>{
  browser(t);t.mock.timers.enable({apis:['setTimeout']});
  const {driver}=host(t);driver.start();t.mock.timers.tick(0);await flush();
  const workers=[...WorkerMock.all];
  assert.ok(workers.length>0);
  driver.pause();
  t.mock.timers.tick(351);
  assert.ok(workers.every(w=>w.terminated===1));
});

test('standard mode skips probes; switching modes starts probes and close suppresses late telemetry',async t=>{
  let nativeCalls=0,gpuCalls=0;const info=deferred(),adapter=deferred();
  browser(t,{navigator:{hardwareConcurrency:4,gpu:{requestAdapter(){gpuCalls++;return adapter.promise;}}},window:{qilineDesktop:{nativeEngine:{getInfo(){nativeCalls++;return info.promise;}}}}});
  const telemetry=[];
  const {driver}=host(t,{perfMode:'standard',onTelemetry:x=>telemetry.push(x)});
  await flush();assert.equal(nativeCalls,0);assert.equal(gpuCalls,0);
  driver.setPerfMode('turbo');assert.equal(nativeCalls,1);assert.equal(gpuCalls,1);
  driver.close();const count=telemetry.length;
  info.resolve({available:true});adapter.resolve(null);await flush();
  assert.equal(telemetry.length,count);resetWebGpuMctsForTest();
});

test('older Native completion cannot unsubscribe progress for a resumed search',async t=>{
  const searches=[],subscriptions=[];let stops=0;
  browser(t,{window:{qilineDesktop:{nativeEngine:{
    getInfo:async()=>({available:true,physicalCores:2}),
    stop(){stops++;},
    onProgress(fn){const sub={fn,off:0};subscriptions.push(sub);return ()=>{sub.off++;};},
    search(){const d=deferred();searches.push(d);return d.promise;},
  }}}});
  const {driver,session}=host(t);driver.start();await tick();
  assert.equal(searches.length,1);
  driver.setPerfMode('extreme');assert.equal(stops,0);
  driver.pause();driver.resume();await tick();
  assert.equal(searches.length,2);assert.equal(subscriptions[0].off,1);
  searches[0].resolve({ok:false,cancelled:true});await flush();
  assert.equal(subscriptions[0].off,1);assert.equal(subscriptions[1].off,0);
  searches[1].resolve({ok:true,bestMove:40,nodes:10,elapsedMs:1,completedDepth:1});await tick();
  assert.equal(subscriptions[1].off,1);assert.equal(session.state.match.state.ply,1);
});

test('hung asset fetch aborts and subsequent GPU searches immediately fall back',async t=>{
  const signals=[];
  browser(t,{navigator:{gpu:{requestAdapter:async()=>({})}},caches:undefined,fetch:(_url,opts)=>{signals.push(opts.signal);return new Promise(()=>{});}});
  resetWebGpuMctsForTest();t.after(resetWebGpuMctsForTest);
  const rt=await promptly(initWebGpuMcts({timeoutMs:20}));
  assert.equal(rt.unavailable,true);assert.match(rt.reason,/timed out/);
  assert.equal(signals.length,2);assert.ok(signals.every(s=>s.aborted));
  const result=await promptly(runWebGpuMctsSearch({}).promise);
  assert.equal(result.fallback,true);
});

test('cancellation settles immediately during hung init and releases the search queue',async t=>{
  browser(t,{navigator:{gpu:{requestAdapter:()=>new Promise(()=>{})}}});
  resetWebGpuMctsForTest();t.after(resetWebGpuMctsForTest);
  const init=initWebGpuMcts({timeoutMs:25});
  const job=runWebGpuMctsSearch({});await flush();job.cancel();
  assert.deepEqual(await promptly(job.promise),{ok:false,fallback:false,cancelled:true});
  await promptly(init);
  assert.equal((await promptly(runWebGpuMctsSearch({}).promise)).fallback,true);
});

test('IPC and Cache API hangs have deadlines',async t=>{
  for(const kind of ['ipc','cache'])await t.test(kind,async t=>{
    browser(t,{navigator:{gpu:{requestAdapter:async()=>({})}},
      window:kind==='ipc'?{qilineDesktop:{readEngineAsset:()=>new Promise(()=>{})}}:undefined,
      caches:kind==='cache'?{delete:async()=>{},open:()=>new Promise(()=>{})}:undefined});
    resetWebGpuMctsForTest();t.after(resetWebGpuMctsForTest);
    const rt=await promptly(initWebGpuMcts({timeoutMs:15}));
    assert.equal(rt.unavailable,true);assert.match(rt.reason,/timed out/);
    assert.equal((await promptly(runWebGpuMctsSearch({}).promise)).fallback,true);
  });
});

test('GPU init disposes partial resources on benchmark failure, timeout and WASM failure',async t=>{
  for(const kind of ['benchmark-error','benchmark-timeout','wasm-error','wasm-timeout','create-timeout'])await t.test(kind,async t=>{
    browser(t,{navigator:{gpu:{requestAdapter:async()=>({})}},window:{qilineDesktop:{readEngineAsset:async()=>new Uint8Array(8)}}});
    resetWebGpuMctsForTest();t.after(resetWebGpuMctsForTest);
    let disposed=0;const late=deferred();
    const gpu={dispose(){disposed++;},benchmark(){
      if(kind==='benchmark-error')throw Error('benchmark failed');
      if(kind==='benchmark-timeout')return new Promise(()=>{});
      return Promise.resolve({boardsPerSec:2000});
    }};
    t.mock.method(WebGpuResNet,'create',()=>kind==='create-timeout'?late.promise:Promise.resolve(gpu));
    t.mock.method(WebAssembly,'instantiate',()=>{
      if(kind==='wasm-timeout')return new Promise(()=>{});
      throw Error('instantiate failed');
    });
    const rt=await promptly(initWebGpuMcts({timeoutMs:15}));
    assert.equal(rt.unavailable,true);
    if(kind==='create-timeout'){late.resolve(gpu);await flush();}
    assert.equal(disposed,1);
  });
});

test('WebGpuResNet.create destroys devices when parse, resource build or cancellation fails',async t=>{
  for(const kind of ['parse','build','cancel'])await t.test(kind,async t=>{
    let destroyed=0;
    const device={destroy(){destroyed++;},addEventListener(){},createComputePipeline(){throw Error('resource build failed');},createShaderModule(){return {};}};
    const adapter={requestDevice:async()=>device};
    browser(t,{navigator:{gpu:{requestAdapter:async()=>adapter}}});
    let bytes=new ArrayBuffer(8);
    if(kind==='build'){
      // Use the real shipped model to exercise a constructor failure after parsing.
      const model=await readFile(new URL('../apps/web/assets/qiline-v27-pro.qgpu',import.meta.url));
      bytes=model.buffer.slice(model.byteOffset,model.byteOffset+model.byteLength);
      globals(t,{GPUBufferUsage:{STORAGE:1,COPY_DST:2,COPY_SRC:4}});
    }
    await assert.rejects(WebGpuResNet.create(bytes,{signal:{aborted:kind==='cancel'}}));
    assert.equal(destroyed,1);
  });
});

test('advisory cancellation rejects promptly and terminates every worker exactly once',async t=>{
  for(const level of ['standard','hard'])await t.test(level,async t=>{
    browser(t);const job=runAdvisorySearch({match:practice().state.match,level});
    await flush();const rejected=assert.rejects(job.promise,/已取消推演/);
    job.cancel();job.cancel();await promptly(rejected);
    assert.ok(WorkerMock.all.length>0);assert.ok(WorkerMock.all.every(w=>w.terminated===1));
    const ctrl=WorkerMock.all[0].ctrl;if(ctrl)assert.equal(Atomics.load(ctrl,CTRL_JOB_SEQ),-1);
  });
});

test('advisory boot and runtime errors/messageerrors terminate all SMP and single workers',async t=>{
  for(const level of ['standard','hard'])for(const phase of ['boot','runtime'])for(const event of ['error','messageerror'])await t.test(`${level} ${phase} ${event}`,async t=>{
    browser(t);const job=runAdvisorySearch({match:practice().state.match,level});
    if(phase==='runtime')await flush();
    const rejected=assert.rejects(job.promise,/线程运行失败/);
    WorkerMock.all.at(-1).emit(event);await promptly(rejected);
    assert.ok(WorkerMock.all.every(w=>w.terminated===1));job.cancel();
    assert.ok(WorkerMock.all.every(w=>w.terminated===1));
  });
});

test('advisory watchdog also settles boot hangs and success cleans up all workers',async t=>{
  browser(t);t.mock.timers.enable({apis:['setTimeout']});
  const job=runAdvisorySearch({match:practice().state.match});
  const rejected=assert.rejects(job.promise,/超时/);t.mock.timers.tick(200000);await rejected;
  assert.equal(WorkerMock.all[0].terminated,1);
  const next=runAdvisorySearch({match:practice().state.match,level:'hard'});await flush();
  reply(WorkerMock.all[1]);const result=await next.promise;assert.equal(result.action.point,40);
  next.cancel();assert.ok(WorkerMock.all.every(w=>w.terminated===1));
});

async function sidecarFixture(){
  const source=await readFile(new URL('../apps/desktop/main.cjs',import.meta.url),'utf8');
  const procs=[],lines=[],timers=new Set();
  const context=vm.createContext({
    console,process:{resourcesPath:'/resources'},path:{join:(...x)=>x.join('/'),dirname:()=>'/app',resolve:(...x)=>x.join('/')},
    app:{getPath:()=>'/app',getAppPath:()=>'/app'},fs:{existsSync:()=>true},
    setTimeout(fn,ms){const timer={fn,ms};timers.add(timer);return timer;},clearTimeout(timer){timers.delete(timer);},
    spawn(){
      const proc=new EventEmitter();proc.killed=false;proc.stdin=new EventEmitter();
      proc.stdin.writable=true;proc.stdin.destroyed=false;proc.writes=[];
      proc.stdin.write=(text,cb)=>{proc.writes.push({text,cb});};proc.kill=()=>{proc.killed=true;};
      procs.push(proc);return proc;
    },
    readline:{createInterface(){const rl=new EventEmitter();rl.close=()=>{};lines.push(rl);return rl;}},
  });
  const block=source.slice(source.indexOf('const ALLOWED_ENGINE_ASSETS'),source.indexOf('function readWindowState'));
  vm.runInContext(block+`;globalThis.api={ensureNativeSidecar,shutdownNativeSidecar,safeWriteSidecar,failPendingForGen,
    get gen(){return nativeGen;},get proc(){return nativeProc;},get info(){return nativeInfo;},get boot(){return nativeBootPromise;},pending:nativePending};`,context);
  return {api:context.api,procs,lines,timers};
}

test('sidecar stdin errors settle their generation and stale exit/stdin/lines preserve the new process',async()=>{
  const {api,procs,lines}=await sidecarFixture();
  const boot=api.ensureNativeSidecar();const gen=api.gen;
  lines[0].emit('line',JSON.stringify({type:'ready'}));lines[0].emit('line',JSON.stringify({type:'loaded',ok:true}));
  assert.equal((await boot).available,true);
  const first=deferred();api.pending.set(1,{gen,resolve:first.resolve});
  procs[0].stdin.emit('error',Error('EPIPE'));
  assert.equal((await first.promise).error,'stdin-error');assert.equal(api.proc,null);assert.equal(api.info,null);assert.equal(api.boot,null);
  const nextBoot=api.ensureNativeSidecar(),nextGen=api.gen,next=deferred();
  api.pending.set(2,{gen:nextGen,resolve:next.resolve});
  procs[0].emit('exit');procs[0].emit('error',Error('old failure'));procs[0].stdin.emit('error',Error('old EPIPE'));
  lines[0].emit('line',JSON.stringify({type:'result',id:2}));
  assert.equal(api.proc,procs[1]);assert.ok(api.boot);assert.equal(api.pending.size,1);
  lines[1].emit('line',JSON.stringify({type:'loaded',ok:true}));assert.equal((await nextBoot).available,true);
  lines[1].emit('line',JSON.stringify({type:'result',id:2,bestMove:40}));assert.equal((await next.promise).bestMove,40);
  api.shutdownNativeSidecar();assert.equal(api.info,null);
});

test('sidecar boot EPIPE, thrown writes and asynchronous write callbacks cannot escape',async()=>{
  const {api,procs}=await sidecarFixture();const boot=api.ensureNativeSidecar();
  procs[0].stdin.emit('error',Error('EPIPE'));assert.equal((await boot).available,false);
  let failures=0;const fail=()=>{failures++;};
  api.safeWriteSidecar(null,api.gen,'x',fail);
  const proc=procs[0];proc.stdin.write=()=>{throw Error('closed');};api.safeWriteSidecar(proc,api.gen,'x',fail);
  proc.stdin.write=(_text,cb)=>cb(Error('EPIPE'));api.safeWriteSidecar(proc,api.gen,'x',fail);
  proc.stdin.destroyed=true;api.safeWriteSidecar(proc,api.gen,'x',fail);
  assert.equal(failures,4);
});
