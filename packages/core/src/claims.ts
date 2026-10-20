import type { Cell, Claim, RuleConfig } from "./types.js";
import { colorOf } from "./geometry.js";
const windows = new Map<string,readonly (readonly number[])[]>();
function allWindows(n: number,four: boolean): readonly (readonly number[])[] {
  const key=`${n}/${four}`;let found=windows.get(key);
  if (!found) {
    const list: (readonly number[])[]=[];
    for (const [dy,dx] of [[1,1],[1,-1],...(four?[[0,1],[1,0]]:[])] as [number,number][]) {
      for (let y=0;y<n;y++) for (let x=0;x<n;x++) {
        if (x+4*dx<0 || x+4*dx>=n || y+4*dy>=n) continue;
        list.push(Object.freeze(Array.from({length:5},(_,k)=>(y+k*dy)*n+x+k*dx)));
      }
    }
    found=Object.freeze(list);windows.set(key,found);
  }
  return found;
}
export function presentClaims(board: readonly Cell[],rules: RuleConfig): ReadonlyMap<string,Pick<Claim,"id"|"color"|"points">> {
  const result=new Map<string,Pick<Claim,"id"|"color"|"points">>();
  for (const points of allWindows(rules.boardSize,rules.directions==="four")) {
    const c=board[points[0]!]!;
    if (c===0 || !points.every(p=>board[p]===c)) continue;
    const color=colorOf(c), fixed=rules.claimMode==="fixed-five";
    const id=fixed?`${color}:${points.join(".")}`:color;
    result.set(id,{id,color,points:fixed?points:Object.freeze([])});
  }
  return result;
}
