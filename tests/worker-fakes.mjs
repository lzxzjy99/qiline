import {createAIWorkerController} from '../dist/ai/src/index.js';
import {practice} from './ai-helpers.mjs';
import {value} from './helpers.mjs';
export class FakeWorker {
 onmessage=null;onerror=null;onmessageerror=null;sent=[];terminated=0;
 postMessage(raw){this.sent.push(structuredClone(raw));}
 terminate(){this.terminated++;}
 ready(){this.onmessage?.({data:{protocolVersion:1,kind:'ready'}});}
 emit(raw){this.onmessage?.({data:raw});}
 result(action,patch={}){return {protocolVersion:1,kind:'result',context:this.sent[0].context,status:'move',action,
  stats:{elapsedMs:1,nodes:1,completedDepth:0},...patch};}
}
export class VirtualHost {
 time=0;next=0;timers=new Map();workers=[];states=[];factory=null;observer=null;
 host={
  now:()=>this.time,
  setTimer:(callback,ms)=>{const id=++this.next;this.timers.set(id,{callback,due:this.time+ms});return id;},
  clearTimer:id=>this.timers.delete(id),
  createWorker:()=>{const worker=this.factory?this.factory():new FakeWorker();this.workers.push(worker);return worker;},
  onState:state=>{this.states.push(state);this.observer?.(state);},
 };
 tick(ms=0){
  const target=this.time+ms;let count=0;
  for(;;){const next=[...this.timers].filter(([,v])=>v.due<=target).sort((a,b)=>a[1].due-b[1].due||a[0]-b[0])[0];
   if(!next)break;if(++count>10000)throw Error('timer loop');this.time=next[1].due;this.timers.delete(next[0]);next[1].callback();
  }this.time=target;
 }
}
export function workerFixture(session=practice(),limits={startupMs:100,graceMs:10}){
 const clock=new VirtualHost(),driver=value(createAIWorkerController(session,clock.host,limits));
 const start=()=>{value(driver.start());clock.tick();return clock.workers.at(-1);};
 return {session,clock,driver,start};
}
