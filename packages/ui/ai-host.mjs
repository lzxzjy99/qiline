import {createRecoveringAI} from './ai-recovery.mjs';

/** Browser and Electron renderer use the same module Worker and pure scheduler. */
export function createBrowserAI(session,onState,limits){
 return createRecoveringAI(session,{
  createWorker:()=>new Worker(new URL('../ai/src/worker-entry.js',import.meta.url),{type:'module',name:'qiline-ai'}),
  now:()=>performance.now(),
  setTimer:(callback,ms)=>setTimeout(callback,ms),
  clearTimer:id=>clearTimeout(id),
  ...(onState?{onState}:{}),
 },limits);
}
