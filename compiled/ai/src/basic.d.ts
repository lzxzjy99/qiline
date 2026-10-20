import type { Match } from "../../core/src/types.js";
import type { AIAction, AIResult } from "./types.js";
import type { TacticalAnalysis } from "./tactics.js";
/** Seed breaks ties only. Both difficulty levels share these basic tactical priorities in P5.2. */
export declare function pickBasicAction(analysis: TacticalAnalysis, seed?: number): AIResult<AIAction>;
/** Synchronous tactical baseline; P5.3 adds bounded search and P5.4 runs it off the UI thread. */
export declare function recommendBasicAction(match: Match, seed?: number): AIResult<{
    readonly action: AIAction;
    readonly analysis: TacticalAnalysis;
}>;
