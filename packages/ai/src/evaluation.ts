import type { Match, PlayerId } from "../../core/src/types.js";
import { centerDistance, colorValue, playerColor, strategicValue } from "./features.js";
import { securedClaim } from "./claim-proof.js";

export const WIN_VALUE=1000000000;
export const SECURED_LINE_VALUE=WIN_VALUE/2;
/** Hard-only solved tactical horizon, strictly below an actual terminal win. */
export function evaluateHardPosition(match:Match,actor:PlayerId):number {
  const proof=securedClaim(match);
  return proof?(match.state.owners![proof.color]===actor?SECURED_LINE_VALUE:-SECURED_LINE_VALUE):evaluatePosition(match,actor);
}
/** Terminal outcomes dominate every bounded heuristic, from the root player's perspective. */
export function evaluatePosition(match:Match,actor:PlayerId):number {
  const outcome=match.state.outcome;
  if (outcome) return outcome.kind==="win"?(outcome.winner===actor?WIN_VALUE:-WIN_VALUE):0;
  const color=playerColor(match,actor);
  if (color) return Math.max(-1000000,Math.min(1000000,strategicValue(match,color)));
  // B will choose the stronger color; white moves first after choosing. A wants a balanced layout.
  let spread=0;
  for (let p=0;p<match.state.board.length;p++) if (match.state.board[p]) spread+=centerDistance(p,match.rules.boardSize)*2;
  const advantage=Math.abs(colorValue(match,"black")-12)+spread;
  return actor==="A"?-advantage:advantage;
}
