import { activePlayer, undoLastCommand } from "../../core/src/engine.js";
import { freeze, keysAre, plain } from "../../core/src/result.js";
import type { Result } from "../../core/src/types.js";
import { GameSession } from "../../session/src/session.js";
import type { SessionState } from "../../session/src/types.js";
import { AITurn, beginAITurn } from "./turn.js";
import { aiFail, aiOK } from "./protocol.js";
import { playModeOf } from "./save.js";
import type { AIError, AIResult } from "./types.js";

export interface WorkerPort {
  onmessage:((event:{readonly data:unknown})=>void)|null;
  onerror:((event:unknown)=>void)|null;
  onmessageerror:((event:unknown)=>void)|null;
  postMessage(message:unknown):void;
  terminate():void;
}
export type TimerId=number|object;
export interface WorkerHost {
  readonly createWorker:()=>WorkerPort;
  readonly now:()=>number;
  readonly setTimer:(callback:()=>void,ms:number)=>TimerId;
  readonly clearTimer:(id:TimerId)=>void;
  readonly onState?:(state:WorkerState)=>void;
}
export interface WorkerLimits {readonly startupMs:number;readonly graceMs:number}
export const DEFAULT_WORKER_LIMITS:WorkerLimits=freeze({startupMs:3000,graceMs:250});
export interface WorkerState {
  readonly status:"idle"|"starting"|"thinking"|"paused"|"failed"|"closed";
  readonly hold:"pause"|"undo"|null;
  readonly error:AIError|null;
  readonly requestId:string|null;
  readonly matchId:string;
  readonly revision:number;
}
interface Job {
  readonly turn:AITurn;
  readonly timers:Map<string,TimerId>;
  port:WorkerPort|null;
  ready:boolean;
  deadline:number;
}
const ready=(raw:unknown):boolean=>plain(raw)&&keysAre(raw,["protocolVersion","kind"])&&raw.protocolVersion===1&&raw.kind==="ready";

/** Owns one fresh Worker per explicit AI command. UI mutations should go through change(). */
export class AIWorkerController {
  readonly #session:GameSession;readonly #host:WorkerHost;readonly #limits:WorkerLimits;
  #state:WorkerState;#seen:SessionState;#lastNow:number;
  #enabled=false;#closed=false;#permanentFault=false;
  #job:Job|null=null;#queued:TimerId|null=null;#queueGeneration=0;
  #hold:"pause"|"undo"|null=null;#error:AIError|null=null;
  private constructor(session:GameSession,host:WorkerHost,limits:WorkerLimits,now:number) {
    this.#session=session;this.#host=host;this.#limits=limits;this.#lastNow=now;this.#seen=session.state;
    this.#state=Object.freeze({status:session.state.closed?"closed":session.state.paused?"paused":"idle",hold:null,
      error:null,requestId:null,matchId:session.state.matchId,revision:session.state.revision});
  }
  static create(session:GameSession,host:WorkerHost,limits:unknown=DEFAULT_WORKER_LIMITS):AIResult<AIWorkerController> {
    if (!(session instanceof GameSession)||!plain(host)||!Object.keys(host).every(k=>["createWorker","now","setTimer","clearTimer","onState"].includes(k))
      || [host.createWorker,host.now,host.setTimer,host.clearTimer].some(f=>typeof f!=="function")
      || (host.onState!==undefined&&typeof host.onState!=="function") || !plain(limits)||!keysAre(limits,["startupMs","graceMs"])
      || !Number.isSafeInteger(limits.startupMs)||Number(limits.startupMs)<1||Number(limits.startupMs)>10000
      || !Number.isSafeInteger(limits.graceMs)||Number(limits.graceMs)<0||Number(limits.graceMs)>1000) return aiFail("INVALID_AI_REQUEST");
    const mode=playModeOf(session.state);if(!mode.ok)return mode;
    let now:number;try{now=host.now();}catch{return aiFail("AI_WORKER_FAILED");}
    if(!Number.isFinite(now)||now<0)return aiFail("AI_WORKER_FAILED");
    return aiOK(new AIWorkerController(session,host,{startupMs:Number(limits.startupMs),graceMs:Number(limits.graceMs)},now));
  }
  get state():WorkerState{return this.#state;}
  #now():number {
    const now=this.#host.now();if(!Number.isFinite(now)||now<this.#lastNow)throw Error("invalid monotonic clock");this.#lastNow=now;return now;
  }
  #set(status:WorkerState["status"]):void {
    const s=this.#session.state,next:WorkerState=Object.freeze({status,hold:this.#hold,error:this.#error,
      requestId:this.#job?.turn.request.context.requestId??null,matchId:s.matchId,revision:s.revision});
    const old=this.#state;
    if(old.status===next.status&&old.hold===next.hold&&old.error===next.error&&old.requestId===next.requestId
      &&old.matchId===next.matchId&&old.revision===next.revision)return;
    this.#state=next;try{this.#host.onState?.(next);}catch{/* Presentation errors do not change game authority. */}
  }
  #clearQueue():void {
    this.#queueGeneration++;
    if(this.#queued!==null){try{this.#host.clearTimer(this.#queued);}catch{}this.#queued=null;}
  }
  #clearTimer(job:Job,key:string):void {
    if(job.timers.has(key)){const id=job.timers.get(key)!;job.timers.delete(key);try{this.#host.clearTimer(id);}catch{}}
  }
  #timer(job:Job,key:string,ms:number,callback:()=>void):void {
    this.#clearTimer(job,key);
    const id=this.#host.setTimer(()=>{job.timers.delete(key);if(this.#job===job)callback();},ms);
    job.timers.set(key,id);
  }
  #release(job:Job):void {
    if(this.#job===job)this.#job=null;
    for(const key of [...job.timers.keys()])this.#clearTimer(job,key);
    const port=job.port;job.port=null;
    if(port){
      try{port.onmessage=null;port.onerror=null;port.onmessageerror=null;}catch{}
      try{port.terminate();}catch{this.#permanentFault=true;}
    }
  }
  #aiTurn():boolean {
    const s=this.#session.state,actor=activePlayer(s.match);
    return !!actor&&!s.closed&&!s.match.state.outcome&&s.controllers[actor].kind==="ai";
  }
  #observe():void {
    const current=this.#session.state,previous=this.#seen;
    if(current!==previous){
      this.#seen=current;
      if(current.matchId!==previous.matchId){this.#hold=null;this.#error=null;}
      else if(previous.task&&!current.task&&current.match===previous.match&&!current.paused&&this.#aiTurn()){
        this.#hold="pause";this.#session.setPaused(true);this.#seen=this.#session.state;
      }
      else if(current.match!==previous.match){
        const parent=undoLastCommand(previous.match);
        if((current.match.state.ply<previous.match.state.ply || (parent.ok&&parent.value===current.match))&&this.#aiTurn()){
          this.#hold="undo";this.#error=null;this.#session.setPaused(true);this.#seen=this.#session.state;
        }
      }
    }
  }
  #fail(job:Job|null,reason:"worker-error"|"no-result",error?:AIError):void {
    if(job&&this.#job!==job)return;
    if(job&&!job.turn.isCurrent){this.#release(job);this.sync();return;}
    const result=job?job.turn.stop(reason):null;
    this.#error=error??(result&&!result.ok?result.error:aiFail("AI_WORKER_FAILED").error);
    if(!job)this.#session.setPaused(true);
    if(job)this.#release(job);
    this.#clearQueue();this.#seen=this.#session.state;this.#hold=null;this.#set("failed");
  }
  #checkJob(job:Job):boolean {
    if(this.#job!==job||this.#closed)return false;
    this.#observe();
    if(!job.turn.isCurrent){this.#release(job);this.sync();return false;}
    try{if(this.#now()>=job.deadline){this.#fail(job,job.ready?"no-result":"worker-error");return false;}}
    catch{this.#fail(job,"worker-error");return false;}
    return true;
  }
  #watch(job:Job):void {
    this.#timer(job,"watch",50,()=>{if(this.#checkJob(job))this.#watch(job);});
  }
  #message(job:Job,raw:unknown):void {
    if(!this.#checkJob(job))return;
    if(ready(raw)){
      if(job.ready)return;job.ready=true;this.#clearTimer(job,"startup");
      try{
        job.deadline=this.#now()+job.turn.request.budget.timeMs+this.#limits.graceMs;
        this.#timer(job,"search",job.turn.request.budget.timeMs+this.#limits.graceMs,()=>this.#fail(job,"no-result"));
        this.#set("thinking");
        if(this.#job===job&&job.turn.isCurrent)job.port!.postMessage(job.turn.request);
        else if(this.#job===job){this.#release(job);this.sync();}
      }catch{this.#fail(job,"worker-error");}
      return;
    }
    if(!job.ready){this.#fail(job,"worker-error");return;}
    const result=job.turn.accept(raw);
    if(!result.ok&&result.error.code==="STALE_AI_TASK"&&job.turn.isCurrent)return;
    this.#release(job);this.#seen=this.#session.state;
    if(!result.ok){this.#error=result.error;this.#hold=null;this.#set("failed");return;}
    this.#error=null;this.#hold=null;this.sync();
  }
  #boot():void {
    this.#observe();const s=this.#session.state;
    if(this.#closed||!this.#enabled||this.#job||s.paused||s.task||!this.#aiTurn()||this.#error)return;
    let start:number;try{start=this.#now();}catch{this.#fail(null,"worker-error");return;}
    const turn=beginAITurn(this.#session);if(!turn.ok){this.#error=turn.error;this.#set("failed");return;}
    const job:Job={turn:turn.value,port:null,timers:new Map(),ready:false,deadline:start+this.#limits.startupMs};
    this.#job=job;this.#seen=this.#session.state;this.#set("starting");
    if(this.#job!==job)return;
    try{
      this.#timer(job,"startup",Math.max(0,job.deadline-this.#now()),()=>this.#fail(job,"worker-error"));
      const port=this.#host.createWorker();
      if(!port||typeof port.postMessage!=="function"||typeof port.terminate!=="function")throw Error("invalid Worker port");
      job.port=port;
      if(this.#job!==job){this.#release(job);return;}
      if(!this.#checkJob(job))return;
      port.onmessage=event=>this.#message(job,event.data);
      port.onerror=()=>{if(this.#checkJob(job))this.#fail(job,"worker-error");};
      port.onmessageerror=()=>{if(this.#checkJob(job))this.#fail(job,"worker-error");};
      this.#watch(job);
    }catch{this.#fail(job,"worker-error");}
  }
  #queue():void {
    if(this.#queued!==null||this.#job||this.#closed)return;
    const generation=++this.#queueGeneration;
    try{this.#queued=this.#host.setTimer(()=>{
      if(generation!==this.#queueGeneration)return;this.#queued=null;this.#boot();
    },0);}catch{this.#fail(null,"worker-error");}
  }
  start():AIResult<WorkerState>{if(this.#closed)return aiFail("CLOSED");this.#enabled=true;return this.sync();}
  sync():AIResult<WorkerState> {
    this.#observe();const s=this.#session.state;
    if(this.#job&&!this.#job.turn.isCurrent)this.#release(this.#job);
    if(this.#closed||s.closed){this.#closed=true;this.#clearQueue();if(this.#job)this.#release(this.#job);this.#set("closed");return aiOK(this.#state);}
    if(this.#permanentFault){this.#clearQueue();this.#session.setPaused(true);this.#error=aiFail("AI_WORKER_FAILED").error;this.#set("failed");return aiFail("AI_WORKER_FAILED");}
    const mode=playModeOf(s);if(!mode.ok){this.#fail(this.#job,"worker-error",mode.error);return mode;}
    if(s.match.state.outcome){this.#clearQueue();if(this.#job)this.#release(this.#job);this.#hold=null;this.#error=null;this.#set("idle");return aiOK(this.#state);}
    if(this.#error){this.#clearQueue();this.#set("failed");return aiOK(this.#state);}
    if(s.paused){this.#clearQueue();this.#hold??="pause";this.#set("paused");return aiOK(this.#state);}
    this.#hold=null;
    if(this.#job){this.#set(this.#job.ready?"thinking":"starting");return aiOK(this.#state);}
    this.#set("idle");const fresh=this.#session.state;
    if(this.#enabled&&!fresh.paused&&!fresh.task&&!this.#error&&this.#aiTurn())this.#queue();else this.#clearQueue();
    return aiOK(this.#state);
  }
  /** Pass only an existing Session command here. Failed commands leave the current Worker running. */
  change(command:()=>Result<SessionState>):AIResult<WorkerState> {
    if(this.#closed)return aiFail("CLOSED");
    let result:Result<SessionState>;try{result=command();}catch{this.#fail(this.#job,"worker-error");return aiFail("AI_WORKER_FAILED");}
    if(!result.ok)return result;return this.sync();
  }
  pause():AIResult<WorkerState>{return this.change(()=>this.#session.setPaused(true));}
  resume():AIResult<WorkerState> {
    if(this.#closed)return aiFail("CLOSED");if(this.#session.state.match.state.outcome)return aiFail("FINISHED");
    if(this.#permanentFault)return aiFail("AI_WORKER_FAILED");
    const result=this.#session.setPaused(false);if(!result.ok)return result;
    this.#hold=null;this.#error=null;this.#enabled=true;return this.sync();
  }
  retry():AIResult<WorkerState>{return this.#state.status==="failed"?this.resume():aiFail("INVALID_AI_REQUEST");}
  close():void {
    if(this.#closed)return;this.#closed=true;this.#enabled=false;this.#clearQueue();
    if(this.#job)this.#release(this.#job);this.#session.close();this.#seen=this.#session.state;this.#set("closed");
  }
}
export const createAIWorkerController=(session:GameSession,host:WorkerHost,limits:unknown=DEFAULT_WORKER_LIMITS):AIResult<AIWorkerController>=>AIWorkerController.create(session,host,limits);
