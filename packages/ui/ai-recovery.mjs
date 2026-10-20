import {activePlayer} from '../core/src/index.js';
import {createAIWorkerController} from '../ai/src/index.js';

export const PRODUCT_WORKER_LIMITS=Object.freeze({startupMs:5000,graceMs:1000});
export const DEFAULT_RECOVERY_POLICY=Object.freeze({retryDelays:Object.freeze([250,750])});
const recoverable=new Set(['AI_WORKER_FAILED','AI_NO_RESULT','INVALID_AI_REPLY']);
const fail=code=>({ok:false,error:{code}});

/** Product recovery policy; the underlying task/legality authority stays in P5.4. */
export function createRecoveringAI(session,host,limits=PRODUCT_WORKER_LIMITS,policy=DEFAULT_RECOVERY_POLICY){
  if(!policy||!Array.isArray(policy.retryDelays)||policy.retryDelays.length>2
    ||![...policy.retryDelays].every(ms=>Number.isSafeInteger(ms)&&ms>=0&&ms<=5000))return fail('INVALID_AI_REQUEST');
  const delays=[...policy.retryDelays];
  let raw,state,timer=null,generation=0,attempt=0,closed=false,manualHold=false,automatic=true,depth=0;
  let position=session?.state?.match,matchId=session?.state?.matchId;
  const cancel=()=>{generation++;if(timer!==null){try{host.clearTimer(timer);}catch{}timer=null;}};
  const aiTurn=()=>{
    const s=session.state,actor=activePlayer(s.match);
    return !s.closed&&!s.match.state.outcome&&actor&&s.controllers[actor]?.kind==='ai';
  };
  function publish(next){
    state=Object.freeze({...next,retryAttempt:attempt,retryLimit:delays.length});
    try{host.onState?.(state);}catch{/* Rendering cannot grant task authority. */}
  }
  function reconcile(){
    if(!raw)return;
    const current=session.state;
    if(current.match!==position||current.matchId!==matchId){
      cancel();attempt=0;position=current.match;matchId=current.matchId;
    }
    if(closed||current.closed){cancel();publish({...raw.state,status:'closed'});return;}
    if(manualHold){cancel();publish({...raw.state,status:'paused',hold:'pause',error:null});return;}
    if(raw.state.status!=='failed'||!aiTurn()){
      if(timer!==null)cancel();publish(raw.state);return;
    }
    if(timer!==null){publish({...raw.state,status:'retrying'});return;}
    if(automatic&&recoverable.has(raw.state.error?.code)&&attempt<delays.length){
      const delay=delays[attempt++],version=++generation,failedState=session.state,error=raw.state.error;
      try{
        timer=host.setTimer(()=>{
          if(version!==generation)return;timer=null;
          if(closed||manualHold||!automatic||session.state!==failedState||!aiTurn()
            ||raw.state.status!=='failed'||raw.state.error!==error){
            cancel();automatic=false;manualHold=!session.state.closed&&!session.state.match.state.outcome;
            depth++;if(manualHold)raw.pause();else raw.sync();depth--;reconcile();return;
          }
          depth++;const result=raw.retry();depth--;
          // A refused retry includes an unconfirmed Worker termination. Never loop it.
          if(!result.ok)automatic=false;
          reconcile();
        },delay);
      }catch{automatic=false;timer=null;publish(raw.state);return;}
      publish({...raw.state,status:'retrying'});return;
    }
    publish(raw.state);
  }
  const created=createAIWorkerController(session,{...host,onState:()=>{if(!depth)reconcile();}},limits);
  if(!created.ok)return created;
  raw=created.value;state=Object.freeze({...raw.state,retryAttempt:0,retryLimit:delays.length});
  const resultOf=result=>result.ok?{ok:true,value:state}:result;
  function command(method,args=[]){
    depth++;let result;try{result=raw[method](...args);}finally{depth--;}
    reconcile();return resultOf(result);
  }
  const driver={
    get state(){return state;},
    start(){return command('start');},
    sync(){return command('sync');},
    change(fn){
      const before=session.state.match;
      depth++;let result;try{result=raw.change(fn);}finally{depth--;}
      if(result.ok){
        cancel();manualHold=false;
        if(session.state.match!==before){
          automatic=true;attempt=0;
          if(raw.state.status==='failed'&&!session.state.paused){depth++;raw.resume();depth--;}
        }else if(raw.state.status==='failed')automatic=false;
      }
      reconcile();return resultOf(result);
    },
    pause(){
      cancel();manualHold=true;automatic=false;return command('pause');
    },
    resume(){
      cancel();manualHold=false;automatic=true;attempt=0;return command('resume');
    },
    retry(){
      if(!['failed','retrying'].includes(state.status))return fail('INVALID_AI_REQUEST');
      cancel();manualHold=false;automatic=true;attempt=0;
      depth++;const result=raw.retry();depth--;
      if(!result.ok)automatic=false;reconcile();return resultOf(result);
    },
    close(){
      if(closed)return;closed=true;automatic=false;cancel();depth++;raw.close();depth--;reconcile();
    }
  };
  return {ok:true,value:driver};
}
