import {createRecoveringAI} from './ai-recovery.mjs';

/** Browser and Electron renderer use the same module Worker and pure scheduler. */
export function createBrowserAI(session,onState,limits,canContinue=()=>true){
 if(typeof canContinue!=='function')return {ok:false,error:{code:'INVALID_AI_REQUEST'}};
 let driver;
 const forward=handler=>handler?event=>{
  let allowed=false;try{allowed=canContinue()===true;}catch{}
  if(!allowed){driver?.pause();return;}
  handler(event);
 }:null;
 const created=createRecoveringAI(session,{
  createWorker:()=>{
   const worker=new Worker(new URL('../ai/src/worker-entry.js',import.meta.url),{type:'module',name:'qiline-ai'});
   return {
    get onmessage(){return worker.onmessage;},set onmessage(handler){worker.onmessage=forward(handler);},
    get onerror(){return worker.onerror;},set onerror(handler){worker.onerror=forward(handler);},
    get onmessageerror(){return worker.onmessageerror;},set onmessageerror(handler){worker.onmessageerror=forward(handler);},
    postMessage:message=>worker.postMessage(message),terminate:()=>worker.terminate(),
   };
  },
  now:()=>performance.now(),
  setTimer:(callback,ms)=>setTimeout(callback,ms),
  clearTimer:id=>clearTimeout(id),
  ...(onState?{onState}:{}),
 },limits);
 if(created.ok)driver=created.value;
 return created;
}
