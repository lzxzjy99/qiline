import {create,act,sequence,p} from './helpers.mjs';
/** Reachable, connected black staircase; its five disappears when the remote F8 liberty is filled. */
export function remoteCapture(claimMode='fixed-five') {
 const black=['A1','B1','B2','C2','C3','D3','D4','E4','E6','E7','E8'];
 const final='E5',liberty='F8';
 let m=create({swap3:false,confirmationDelay:12,claimMode});
 const target=new Set([...black,final].map(s=>p(m,s))),boundary=new Set();
 for(const q of target){
  const x=q%9,y=Math.floor(q/9);
  for(const [a,b] of [[x-1,y],[x+1,y],[x,y-1],[x,y+1]])if(a>=0&&a<9&&b>=0&&b<9){
   const n=b*9+a;if(!target.has(n)&&n!==p(m,liberty))boundary.add(n);
  }
 }
 for(let i=0;i<black.length;i++){m=act(m,'place',black[i]);if(i<black.length-1)m=act(m,'pass');}
 let placed=0;for(const q of boundary){if(placed++)m=act(m,'pass');m=act(m,'place',q);}
 m=act(m,'place',final);
 for(let i=0;i<10;i++)m=act(m,'pass');
 return {match:m,capturePoint:p(m,liberty),line:['A1','B2','C3','D4','E5'].map(s=>p(m,s))};
}
export const immediateWin=patch=>sequence(create({swap3:false,confirmationDelay:0,...patch}),['A1','I1','B2','I3','C3','I5','D4','I7']);
export const closedFourThreat=patch=>sequence(create({swap3:false,confirmationDelay:0,...patch}),['I1','A1','I3','B2','I5','C3','I7','D4']);
export const openFourThreat=patch=>sequence(create({swap3:false,confirmationDelay:0,...patch}),['I1','B2','I3','C3','I5','D4','I7','E5']);
