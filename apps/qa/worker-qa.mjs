import {DEFAULT_RULES,createMatch,applyAction,activePlayer,exportRecord,parsePoint} from './core/src/index.js';
import {restoreSession} from './session/src/index.js';
import {createAIWorkerController} from './ai/src/index.js';
import {createBrowserAI} from './ui/ai-host.mjs';

const value=result=>{if(!result.ok)throw Error(result.error.code);return result.value;};
const check=(condition,message)=>{if(!condition)throw Error(message);};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const state=document.querySelector('#state'),results=document.querySelector('#results'),button=document.querySelector('#run');
let pulses=0,busyPulses=0,busy=false;
setInterval(()=>{pulses++;if(busy)busyPulses++;document.querySelector('#pulse').textContent=`主线程心跳：${pulses}；无限循环搜索期间心跳：${busyPulses}`;},20);
const until=async predicate=>{const end=performance.now()+7000;while(!predicate()){if(performance.now()>end)throw Error('等待超时');await delay(10);}};
function fixture(){
 let match=value(createMatch({...DEFAULT_RULES,swap3:false,confirmationDelay:0}));
 for(const coord of ['I1','A1','I3','B2','I5','C3','I7','D4']){
  match=value(applyAction(match,{kind:'place',actor:activePlayer(match),point:value(parsePoint(coord,9))})).match;
 }
 return value(restoreSession('browser-qa',{sessionSchemaVersion:1,record:exportRecord(match),controllers:{A:{kind:'ai',level:'easy',seed:37},B:{kind:'human'}},competitive:false}));
}
const show=s=>{state.textContent=`状态：${s.status}；等待原因：${s.hold??'无'}；错误：${s.error?.code??'无'}`;};

button.addEventListener('click',async()=>{
 button.disabled=true;results.textContent='运行中……';const lines=[];let passed=0;
 const run=async(name,body)=>{await body();passed++;lines.push(`通过 ${passed}：${name}`);results.textContent=lines.join('\n');};
 try{
  await run('实际模块 Worker 重放棋谱并选择 E5，主线程重验后只提交一次',async()=>{
   const s=fixture(),driver=value(createBrowserAI(s,show));
   try{value(driver.start());await until(()=>s.state.match.state.ply===9||driver.state.status==='failed');check(s.state.match.state.lastPlacement===40,'没有在 E5 防守');check(driver.state.status==='idle'&&!s.state.task,'任务没有清理');await delay(80);check(s.state.match.state.ply===9,'重复提交');}
   finally{driver.close();}
  });
  await run('搜索时暂停，原任务失效，继续后新任务正常提交',async()=>{
   const s=fixture();let driver,paused=false;
   driver=value(createBrowserAI(s,next=>{show(next);if(next.status==='thinking'&&!paused){paused=true;value(driver.pause());}}));
   try{value(driver.start());await until(()=>paused);await delay(100);check(s.state.match.state.ply===8&&s.state.paused&&!s.state.task,'暂停后旧任务仍生效');value(driver.resume());await until(()=>s.state.match.state.ply===9||driver.state.status==='failed');check(s.state.match.state.lastPlacement===40,'恢复失败');}
   finally{driver.close();}
  });
  await run('悔棋退回 AI 回合后等待继续，继续后重新计算',async()=>{
   const s=fixture(),driver=value(createBrowserAI(s,show));
   try{value(driver.start());await until(()=>s.state.match.state.ply===9||driver.state.status==='failed');check(s.state.match.state.ply===9,'首次搜索失败');value(driver.change(()=>s.requestUndo('B')));check(driver.state.hold==='undo'&&s.state.paused,'悔棋没有等待');await delay(100);check(s.state.match.state.ply===8,'悔棋后自动重下');value(driver.resume());await until(()=>s.state.match.state.ply===9||driver.state.status==='failed');check(s.state.match.state.ply===9,'继续后没有走棋');}
   finally{driver.close();}
  });
  await run('无限循环线程被硬超时终止，页面持续响应，手动重试成功',async()=>{
   const s=fixture(),ports=[],timers=new Set();let attempts=0;
   const host={
    createWorker:()=>{
     const port=new Worker(new URL(++attempts===1?'./hang-worker.js':'./ai/src/worker-entry.js',import.meta.url),{type:'module'});
     const end=port.terminate.bind(port);port.terminated=0;port.terminate=()=>{port.terminated++;end();};ports.push(port);return port;
    },
    now:()=>performance.now(),setTimer:(callback,ms)=>{const id=setTimeout(()=>{timers.delete(id);callback();},ms);timers.add(id);return id;},
    clearTimer:id=>{timers.delete(id);clearTimeout(id);},onState:next=>{show(next);busy=attempts===1&&next.status==='thinking';},
   };
   const driver=value(createAIWorkerController(s,host,{startupMs:3000,graceMs:250}));
   try{
    value(driver.start());await until(()=>driver.state.status==='failed');
    check(driver.state.error.code==='AI_NO_RESULT','硬超时错误不正确');check(s.state.match.state.ply===8&&!s.state.task&&s.state.paused,'硬超时改变了棋局');
    check(ports[0].terminated===1&&timers.size===0,'旧线程或定时器未清理');check(busyPulses>=5,'主线程心跳没有持续');
    value(driver.retry());await until(()=>s.state.match.state.ply===9||driver.state.status==='failed');check(s.state.match.state.lastPlacement===40,'重试失败');
    check(ports.length===2&&ports.every(port=>port.terminated===1)&&timers.size===0,'重试后的线程没有结束');
    lines.push(`无限循环搜索期间主线程心跳 ${busyPulses} 次；两个线程均 terminate 一次，剩余调度定时器 0。`);
   }finally{busy=false;driver.close();}
  });
  results.textContent=lines.join('\n')+`\n浏览器验收完成：${passed}/4 通过。`;state.textContent='全部通过，全部调度器已关闭。';
 }catch(error){results.textContent=lines.join('\n')+`\n失败：${error.message}`;state.textContent='验收失败';}
 finally{busy=false;button.disabled=false;}
});
