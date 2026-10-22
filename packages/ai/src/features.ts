import type { Cell, Color, Match, PlayerId, RuleConfig } from "../../core/src/types.js";
import { cellOf, collectGroups, neighborsFor } from "../../core/src/geometry.js";
import type { GeometricGroup, GroupTable } from "../../core/src/geometry.js";

interface Lines {
  readonly potential:number; readonly completions:readonly number[];
  readonly pressure:number; readonly moves:readonly number[];
  /** Geometric four-making moves; forks have two distinct follow-up completion points. */
  readonly forcing:readonly number[]; readonly forks:readonly number[];
  readonly completed:readonly (readonly number[])[];
  readonly lineStones:ReadonlySet<number>;
}
interface Features { readonly groups:GroupTable; readonly black:Lines; readonly white:Lines }
const windowsCache=new Map<string,readonly (readonly number[])[]>();
const featureCache=new WeakMap<Match,Features>();
export interface LiveLine {
  readonly color:Color; readonly dueAt:number; readonly id:string;
  readonly groups:readonly GeometricGroup[];
}
const liveLineCache=new WeakMap<Match,readonly LiveLine[]>();
function windows(rules:RuleConfig):readonly (readonly number[])[] {
  const n=rules.boardSize,key=`${n}/${rules.directions}`;
  let result=windowsCache.get(key);
  if (!result) {
    const list:number[][]=[];
    const directions=rules.directions==="four"?[[1,1],[-1,1],[1,0],[0,1]]:[[1,1],[-1,1]];
    for (const [dx,dy] of directions as [number,number][]) for (let y=0;y<n;y++) for (let x=0;x<n;x++) {
      if (x+4*dx<0 || x+4*dx>=n || y+4*dy>=n) continue;
      list.push(Array.from({length:5},(_,k)=>(y+k*dy)*n+x+k*dx));
    }
    result=Object.freeze(list.map(points=>Object.freeze(points)));windowsCache.set(key,result);
  }
  return result;
}
/** Geometric ordering hints only. Only core.applyAction is allowed to declare a win or legality. */
function lines(board:readonly Cell[],rules:RuleConfig,color:Color,groups:GroupTable):Lines {
  const own=cellOf(color),weights=[0,2,14,90,600,2400],completions=new Set<number>();let potential=0;
  const threatWeights=[0,2,18,150,1800,6000],moveWeights=[0,2,18,180,2200,16000];
  const moves=Array<number>(board.length).fill(0),replies=new Map<number,Set<number>>();
  const lineStones=new Set<number>();
  let pressure=0;const completed:(readonly number[])[]=[];
  for (const points of windows(rules)) {
    let count=0,empty=-1,blocked=false,liberties=Infinity;const empties:number[]=[];
    for (const p of points) {
      if (board[p]===-own) {blocked=true;break;}
      if (board[p]===own) {count++;liberties=Math.min(liberties,groups.at[p]!.liberties.size);}
      else {empty=p;empties.push(p);}
    }
    if (!blocked) {
      potential+=weights[count]!;
      if (count===4) completions.add(empty);
      // A line carried by a capturable group is much weaker than a safe line.
      const safety=liberties===1?0.08:liberties===2?0.65:1;
      pressure+=threatWeights[count]!*safety;
      for(const point of empties)moves[point]!+=moveWeights[count+1]!*safety;
      if(count===5)completed.push(points);
      if(count>=3)for(const point of points)if(board[point]===own)lineStones.add(point);
      if(count===3 && liberties>1)for(const point of empties){
        let followups=replies.get(point);if(!followups){followups=new Set();replies.set(point,followups);}
        for(const reply of empties)if(reply!==point)followups.add(reply);
      }
    }
  }
  const forcing=[...replies.keys()].sort((a,b)=>a-b),forks=forcing.filter(p=>replies.get(p)!.size>=2);
  // Count distinct reply points, not overlapping windows sharing the same gap.
  pressure+=forks.length*1200;
  for(const point of forks)moves[point]!+=8000;
  return {potential,completions:[...completions].sort((a,b)=>a-b),pressure,moves,forcing,forks,completed,lineStones};
}
export function featuresOf(match:Match):Features {
  let found=featureCache.get(match);
  if (!found) {
    const groups=collectGroups(match.state.board,match.rules.boardSize);
    found={groups,black:lines(match.state.board,match.rules,"black",groups),white:lines(match.state.board,match.rules,"white",groups)};
    featureCache.set(match,found);
  }
  return found;
}
/** Actual surviving fives only. Color-pressure can inherit its clock on any surviving line. */
export function liveLinesOf(match:Match):readonly LiveLine[] {
  let found=liveLineCache.get(match);
  if(!found){
    const f=featuresOf(match),lines:LiveLine[]=[];
    for(const claim of match.state.claims){
      const windows=claim.points.length?[claim.points]:f[claim.color].completed;
      for(const points of windows)lines.push({color:claim.color,dueAt:claim.dueAt,id:claim.id,
        groups:[...new Set(points.map(p=>f.groups.at[p]!))]});
    }
    found=lines;liveLineCache.set(match,found);
  }
  return found;
}
/** Preserve remote liberties and countercaptures during live-five attack/defence. Hints, never legality. */
export function claimTacticalPoints(match:Match):ReadonlyMap<number,number> {
  const priorities=new Map<number,number>();
  if(match.state.phase.kind!=="playing")return priorities;
  const color=match.state.phase.toMove,f=featuresOf(match),adj=neighborsFor(match.rules.boardSize);
  const mark=(point:number,priority:number)=>priorities.set(point,Math.max(priority,priorities.get(point)??0));
  for(const line of liveLinesOf(match)){
    // A group with more liberties than possible attacks before confirmation is already relatively safe.
    const remaining=Math.max(1,line.dueAt-match.state.ply),limit=Math.min(6,Math.ceil(remaining/2)+1);
    for(const group of line.groups){
      const liberties=group.liberties.size;if(liberties>limit)continue;
      const priority=liberties===1?4000000:liberties===2?2200000:1600000-liberties*50000;
      for(const point of group.liberties)mark(point,priority);
      // Saving a line may require taking its surrounding stones rather than extending its last liberty.
      if(line.color===color&&liberties<=2)for(const stone of group.stones)for(const point of adj[stone]!){
        const enemy=f.groups.at[point];
        if(enemy&&enemy.color!==group.color&&enemy.liberties.size<=2)
          for(const liberty of enemy.liberties)mark(liberty,priority);
      }
    }
  }
  return priorities;
}
export const otherColor=(color:Color):Color=>color==="black"?"white":"black";
export function playerColor(match:Match,actor:PlayerId):Color|null {
  const owners=match.state.owners;return owners?(owners.black===actor?"black":"white"):null;
}
export function claimPressure(match:Match,color:Color):number {
  return match.state.claims.filter(c=>c.color===color)
    .reduce((sum,c)=>sum+1800/Math.max(1,c.dueAt-match.state.ply),0);
}
export function colorValue(match:Match,color:Color):number {
  const f=featuresOf(match),own=cellOf(color),opponent=otherColor(color);
  let material=0,safety=0;
  for (const c of match.state.board) material+=c===own?4:c===-own?-4:0;
  for (const group of f.groups.groups) {
    const value=group.liberties.size===1?-120*group.stones.length:Math.min(4,group.liberties.size)*2;
    safety+=group.color===own?value:-value;
  }
  const tempo=match.state.phase.kind==="playing"?(match.state.phase.toMove===color?12:-12):0;
  return f[color].potential-f[opponent].potential+material+safety+tempo
    +claimPressure(match,color)-claimPressure(match,opponent);
}
/** Search evaluation only; geometric threats never adjudicate legality or a win. */
export function strategicValue(match:Match,color:Color):number {
  const f=featuresOf(match),own=cellOf(color),opponent=otherColor(color),n=match.rules.boardSize;
  let score=f[color].pressure-f[opponent].pressure;
  for(let p=0;p<match.state.board.length;p++)if(match.state.board[p]){
    const value=6+3*(1-centerDistance(p,n)/((n-1)**2/2));
    score+=match.state.board[p]===own?value:-value;
  }
  for(const group of f.groups.groups){
    const value=group.liberties.size===1?-350*group.stones.length
      :group.liberties.size===2?-35*group.stones.length:Math.min(6,group.liberties.size)*3;
    score+=group.color===own?value:-value;
  }
  const claims={black:0,white:0};
  for(const line of liveLinesOf(match)){
    const liberties=Math.min(...line.groups.map(g=>g.liberties.size));
    const ownTurn=match.state.phase.kind==="playing"&&match.state.phase.toMove===line.color;
    // Atari is a threat that still needs answering. It is not an already captured five.
    const safety=liberties===1?(ownTurn?0.6:0.15):liberties===2?0.8:liberties===3?0.9:liberties===4?0.96:1;
    const value=90000*safety/Math.max(1,line.dueAt-match.state.ply);
    // One surviving five suffices. Overlapping windows must not outweigh saving the earlier clock.
    claims[line.color]=Math.max(claims[line.color],value);
  }
  score+=claims[color]-claims[opponent];
  if(match.state.phase.kind==="playing"){
    const toMove=match.state.phase.toMove,waiting=otherColor(toMove);
    // A horizon after the opponent creates an open four is not a quiet position.
    // These remain bounded hints: captures, ko and delayed claims still require core search.
    const immediate=match.rules.confirmationDelay===0;
    const initiative=f[toMove].completions.length?(immediate?6000:1800)
      :f[waiting].completions.length>=2?-(immediate?5000:1500):0;
    score+=toMove===color?12+initiative:-12-initiative;
  }
  return score;
}
export function rescuedStones(before:Match,after:Match,color:Color):number {
  const own=cellOf(color),next=featuresOf(after).groups;let rescued=0;
  for (const group of featuresOf(before).groups.groups) if (group.color===own && group.liberties.size===1) {
    const survivor=next.at[group.stones[0]!];
    if (survivor?.color===own && survivor.liberties.size>=2) rescued+=group.stones.length;
  }
  return rescued;
}
/** Every global atari liberty is retained, including remote captures of stones belonging to a five. */
export function capturePoints(match:Match,by:Color):readonly number[] {
  const opponent=-cellOf(by),points=new Set<number>();
  for (const group of featuresOf(match).groups.groups) if (group.color===opponent && group.liberties.size===1)
    points.add(group.liberties.values().next().value!);
  return [...points].sort((a,b)=>a-b);
}
export function centerDistance(point:number,n:number):number {
  const mid=(n-1)/2;return (point%n-mid)**2+(Math.floor(point/n)-mid)**2;
}
export function openingValue(before:Match,after:Match,point:number):number {
  const phase=before.state.phase,n=before.rules.boardSize;
  if (phase.kind!=="opening") return 0;
  if (phase.placed===0) return -centerDistance(point,n);
  if (phase.placed===1) {
    const first=before.state.lastPlacement!,distance=Math.max(Math.abs(first%n-point%n),Math.abs(Math.floor(first/n)-Math.floor(point/n)));
    return -40*Math.abs(distance-2)-centerDistance(point,n);
  }
  // A lays out both colors; B can choose either. Reduce the larger static color advantage.
  return -Math.abs(colorValue(after,"black"))-centerDistance(point,n)*0.1;
}
export function localSupport(match:Match,point:number,color:Color):number {
  const own=cellOf(color);return neighborsFor(match.rules.boardSize)[point]!.filter(p=>match.state.board[p]===own).length;
}
