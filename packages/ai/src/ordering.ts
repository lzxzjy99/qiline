import type { Color, Match } from "../../core/src/types.js";
import { activePlayer } from "../../core/src/engine.js";
import { cellOf } from "../../core/src/geometry.js";
import { capturePoints, centerDistance, featuresOf, otherColor } from "./features.js";
import type { AIAction } from "./types.js";

export interface OrderedAction {readonly action:AIAction;readonly critical:boolean;readonly order:number}
export const actionKey=(a:AIAction):string=>a.kind==="place"?`p${a.point}`:a.kind==="pass"?"pass":a.color;
export function tieRank(a:AIAction,seed:number):number {
  let x=(seed^(a.kind==="place"?a.point+1:a.kind==="pass"?1000:a.color==="black"?1001:1002))>>>0;
  x=Math.imul(x^(x>>>16),0x7feb352d);x=Math.imul(x^(x>>>15),0x846ca68b);return (x^(x>>>16))>>>0;
}
/** Whole-board hints only. Every returned proposal is still checked by the core before use. */
export function orderActions(match:Match,seed:number,preferred:AIAction|null=null):readonly OrderedAction[] {
  const actor=activePlayer(match);if (!actor) return [];
  const phase=match.state.phase;
  if (phase.kind==="choose") return ["black","white"].map(color=>({action:{kind:"choose-color",actor,color} as AIAction,critical:true,order:0}));
  const color:Color=phase.kind==="playing"?phase.toMove:phase.kind==="opening"&&phase.placed===1?"white":"black";
  const opponent=otherColor(color),f=featuresOf(match),important=new Set<number>(),priorities=new Map<number,number>();
  const mark=(p:number,priority:number)=>{important.add(p);priorities.set(p,Math.max(priority,priorities.get(p)??0));};
  if (phase.kind==="playing") {
    for (const p of f[color].completions) mark(p,1000000);
    for (const p of f[opponent].completions) mark(p,800000);
    for (const p of f[color].forcing) mark(p,20000);
    for (const p of f[opponent].forcing) mark(p,18000);
    for (const p of f[color].forks) mark(p,60000);
    for (const p of f[opponent].forks) mark(p,55000);
    for (const group of f.groups.groups) if (group.liberties.size===1) {
      const point=group.liberties.values().next().value!;
      if (group.color===cellOf(color)) mark(point,300000+group.stones.length*1000);
      else {
        const breaks=match.state.claims.some(c=>c.color===opponent && (c.points.length===0 || c.points.some(p=>group.stones.includes(p))));
        mark(point,(breaks?3000000:200000)+group.stones.length*20000);
      }
    }
    // Approaching a two-liberty line group can break a delayed claim before it matures.
    for(const group of f.groups.groups)if(group.liberties.size===2){
      const groupColor=group.color===1?"black":"white";
      if(group.stones.some(p=>f[groupColor].lineStones.has(p)))
        for(const point of group.liberties)mark(point,groupColor===opponent?90000:80000);
    }
    for (const p of capturePoints(match,color)) important.add(p);
  }
  const list:OrderedAction[]=[];
  for (let point=0;point<match.state.board.length;point++) if (match.state.board[point]===0) {
    let order=-centerDistance(point,match.rules.boardSize)*0.05;
    if (phase.kind==="opening") {
      if (phase.placed===1) {
        const first=match.state.lastPlacement!,n=match.rules.boardSize;
        order-=40*Math.abs(Math.max(Math.abs(first%n-point%n),Math.abs(Math.floor(first/n)-Math.floor(point/n)))-2);
      }
    }else order+=f[color].moves[point]!*1.1+f[opponent].moves[point]!;
    list.push({action:{kind:"place",actor,point},critical:important.has(point),order:order+(priorities.get(point)??0)});
  }
  if (phase.kind==="playing") {
    const confirms=match.state.claims.some(c=>c.color===color && c.dueAt<=match.state.ply+1);
    list.push({action:{kind:"pass",actor},critical:true,order:confirms?4000000:-10000});
  }
  const preferredKey=preferred?actionKey(preferred):null;
  list.sort((a,b)=>Number(actionKey(b.action)===preferredKey)-Number(actionKey(a.action)===preferredKey)
    || b.order-a.order || tieRank(b.action,seed)-tieRank(a.action,seed));
  return list;
}
