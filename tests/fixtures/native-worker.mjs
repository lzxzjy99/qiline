import {parentPort,workerData} from 'node:worker_threads';
if(workerData.mode==='startup-hang')for(;;){}
if(workerData.mode==='hang'){
 parentPort.on('message',()=>{for(;;){}});parentPort.postMessage({protocolVersion:1,kind:'ready'});
}else{
 globalThis.postMessage=message=>parentPort.postMessage(message);
 globalThis.close=()=>parentPort.close();
 globalThis.onmessage=null;
 parentPort.on('message',data=>globalThis.onmessage?.({data}));
 await import('../../dist/ai/src/worker-entry.js');
}
