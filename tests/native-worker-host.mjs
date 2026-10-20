import {Worker} from 'node:worker_threads';
import {createAIWorkerController} from '../dist/ai/src/index.js';
import {value} from './helpers.mjs';
export function nativeFixture(session,mode='real',limits={startupMs:2000,graceMs:100}){
 const ports=[],timers=new Set(),terminations=[],states=[],waiters=new Set();
 const host={now:()=>performance.now(),
  createWorker:()=>{
   const worker=new Worker(new URL('./fixtures/native-worker.mjs',import.meta.url),{workerData:{mode}});
   const port={onmessage:null,onerror:null,onmessageerror:null,sent:[],messages:[],terminated:0,exited:false,
    postMessage(raw){this.sent.push(structuredClone(raw));worker.postMessage(raw);},
    terminate(){this.terminated++;terminations.push(worker.terminate());},
   };
   worker.on('message',data=>{port.messages.push(data);port.onmessage?.({data});});
   worker.on('error',error=>port.onerror?.(error));worker.on('messageerror',error=>port.onmessageerror?.(error));
   worker.on('exit',()=>{port.exited=true;});ports.push(port);return port;
  },
  setTimer:(callback,ms)=>{const id=setTimeout(()=>{timers.delete(id);callback();},ms);timers.add(id);return id;},
  clearTimer:id=>{clearTimeout(id);timers.delete(id);},
  onState:state=>{states.push(state);for(const waiter of waiters)waiter(state);},
 };
 const driver=value(createAIWorkerController(session,host,limits));
 function until(predicate){return new Promise((resolve,reject)=>{
  const check=state=>{if(predicate(state)){clearTimeout(timeout);waiters.delete(check);resolve(state);}};
  const timeout=setTimeout(()=>{waiters.delete(check);reject(Error('native worker wait timed out'));},5000);
  waiters.add(check);check(driver.state);
 });}
 async function cleanup(){driver.close();for(const id of timers)clearTimeout(id);await Promise.all(terminations);}
 return{driver,ports,timers,states,until,cleanup,terminations};
}
