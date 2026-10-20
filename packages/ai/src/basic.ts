import type { Match } from "../../core/src/types.js";
import type { AIAction, AIResult } from "./types.js";
import type { TacticalAnalysis } from "./tactics.js";
import { analyzeTactics } from "./tactics.js";
import { aiFail, aiOK } from "./protocol.js";

function mix(value:number):number {
  let x=value>>>0;x^=x>>>16;x=Math.imul(x,0x7feb352d);x^=x>>>15;x=Math.imul(x,0x846ca68b);return (x^(x>>>16))>>>0;
}
/** Seed breaks ties only. Both difficulty levels share these basic tactical priorities in P5.2. */
export function pickBasicAction(analysis:TacticalAnalysis,seed:number=0):AIResult<AIAction> {
  if (!Number.isInteger(seed) || seed<0 || seed>0xffffffff) return aiFail("INVALID_AI_REQUEST","seed");
  const first=analysis.candidates[0];if (!first) return aiFail("AI_NO_RESULT");
  let selected=first,bestTie=-1;
  for (let i=0;i<analysis.candidates.length;i++) {
    const candidate=analysis.candidates[i]!;
    if (candidate.tier!==first.tier || candidate.score!==first.score) break;
    const tie=mix(seed^Math.imul(i+1,0x9e3779b1));
    if (tie>bestTie) {selected=candidate;bestTie=tie;}
  }
  return aiOK(selected.action);
}
/** Synchronous tactical baseline; P5.3 adds bounded search and P5.4 runs it off the UI thread. */
export function recommendBasicAction(match:Match,seed:number=0):AIResult<{readonly action:AIAction;readonly analysis:TacticalAnalysis}> {
  if (!Number.isInteger(seed) || seed<0 || seed>0xffffffff) return aiFail("INVALID_AI_REQUEST","seed");
  const analysis=analyzeTactics(match);if (!analysis.ok) return analysis;
  const picked=pickBasicAction(analysis.value,seed);if (!picked.ok) return picked;
  return aiOK(Object.freeze({action:picked.value,analysis:analysis.value}));
}
