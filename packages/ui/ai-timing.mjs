/** Presentation-only time, scoped to one explicit AI command and never saved. */
export function createAIThinkingClock(now=()=>performance.now()){
 let position=null,matchId=null,current=null,last=null,lastNow=0;
 const time=()=>{
  const next=now();if(Number.isFinite(next))lastNow=Math.max(lastNow,next);
  return lastNow;
 };
 const elapsed=at=>current?current.elapsed+(current.since===null?0:at-current.since):null;
 return {
  reset(){position=null;matchId=null;current=null;last=null;},
  sync({match,matchId:id,aiActor,status}){
   const at=time();
   if(current){current.elapsed=elapsed(at);current.since=null;}
   if(id!==matchId){current=null;last=null;}
   else if(position&&match!==position){
    const before=position.accepted.length,after=match.accepted.length;
    const aiCommand=after===before+1&&match.accepted.at(-1)?.actor===aiActor;
    if(current&&aiCommand)last=current.elapsed;
    if(after<=before)last=null; // A rewind invalidates the old move's displayed time.
    current=null;
   }
   position=match;matchId=id;
   if(!match.state.outcome&&['starting','thinking','retrying'].includes(status)){
    current??={elapsed:0,since:null};
    if(status==='thinking')current.since=at;
   }
  },
  get snapshot(){return {elapsedMs:elapsed(time()),lastElapsedMs:last,running:current?.since!=null};},
 };
}

export function formatThinkingTime(ms){
 const tenths=Math.floor(Math.max(0,ms)/100),minutes=Math.floor(tenths/600);
 const seconds=((tenths%600)/10).toFixed(1);
 return minutes?`${minutes} 分 ${seconds} 秒`:`${seconds} 秒`;
}
