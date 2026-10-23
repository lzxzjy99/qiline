import type { Color, Match } from "../../core/src/types.js";
import { liveLinesOf } from "./features.js";

export interface SecuredClaim {readonly color:Color;readonly dueAt:number;readonly opponentPlacements:number}
const cache=new WeakMap<Match,SecuredClaim|null>();
/** Sufficient survival proof under a pass strategy; never changes the core's outcome. */
export function securedClaim(match:Match):SecuredClaim|null {
  const cached=cache.get(match);if(cached!==undefined)return cached;
  let proof:SecuredClaim|null=null;
  if(!match.state.outcome&&match.state.phase.kind==="playing")for(const line of liveLinesOf(match)){
    const remaining=line.dueAt-match.state.ply;
    // Conservatively reject every earlier/tied enemy clock, even if that line is capturable.
    if(remaining<=0||match.state.claims.some(c=>c.color!==line.color&&c.dueAt<=line.dueAt))continue;
    const opponentPlacements=Math.floor((remaining+Number(match.state.phase.toMove!==line.color))/2);
    // A pass never fills a friendly liberty; each enemy placement can fill at most one.
    if(line.groups.every(group=>group.liberties.size>opponentPlacements)){
      proof=Object.freeze({color:line.color,dueAt:line.dueAt,opponentPlacements});break;
    }
  }
  cache.set(match,proof);return proof;
}
