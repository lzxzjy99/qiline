const MUTE_KEY='qiline.muted';
let ctx=null;
function audioCtx(){
  if(ctx)return ctx;
  const AC=typeof window!=='undefined'&&(window.AudioContext||window.webkitAudioContext);
  if(!AC)return null;
  try{ctx=new AC();return ctx;}catch{return null;}
}
export function isMuted(){
  try{return typeof localStorage!=='undefined'&&localStorage.getItem(MUTE_KEY)==='1';}catch{return false;}
}
export function setMuted(muted){
  try{if(typeof localStorage!=='undefined')localStorage.setItem(MUTE_KEY,muted?'1':'0');}catch{}
  return !!muted;
}
export function toggleMuted(){return setMuted(!isMuted());}
export function playSound(kind='stone'){
  if(isMuted())return;
  const ac=audioCtx();if(!ac)return;
  try{
    if(ac.state==='suspended')ac.resume().catch(()=>{});
    const now=ac.currentTime;
    const tone=(freq,dur,type='triangle',gainVal=0.12,delay=0)=>{
      const osc=ac.createOscillator(),g=ac.createGain();
      osc.type=type;osc.frequency.setValueAtTime(freq,now+delay);
      if(kind==='stone')osc.frequency.exponentialRampToValueAtTime(Math.max(120,freq*0.42),now+delay+dur);
      g.gain.setValueAtTime(0.0001,now+delay);
      g.gain.linearRampToValueAtTime(gainVal,now+delay+0.008);
      g.gain.exponentialRampToValueAtTime(0.0001,now+delay+dur);
      osc.connect(g);g.connect(ac.destination);
      osc.start(now+delay);osc.stop(now+delay+dur+0.02);
    };
    if(kind==='stone')tone(460,0.065,'triangle',0.16,0);
    else if(kind==='capture'){tone(580,0.07,'triangle',0.14,0);tone(420,0.09,'sine',0.12,0.055);}
    else if(kind==='claim'){tone(660,0.14,'sine',0.13,0);tone(880,0.18,'sine',0.11,0.08);}
    else if(kind==='win'){tone(523.25,0.12,'triangle',0.12,0);tone(659.25,0.14,'triangle',0.12,0.09);tone(783.99,0.24,'sine',0.14,0.18);}
    else if(kind==='notify'){tone(740,0.1,'sine',0.1,0);tone(987.77,0.14,'sine',0.09,0.07);}
  }catch{}
}
export function notifyTurnArrival(soundKind='notify'){
  playSound(soundKind);
  try{
    if(typeof window!=='undefined'&&typeof window.qilineDesktop?.flashFrame==='function'){
      if(typeof document==='undefined'||document.hidden||!document.hasFocus())window.qilineDesktop.flashFrame();
    }
  }catch{}
}
