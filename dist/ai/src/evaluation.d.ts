import type { Match, PlayerId } from "../../core/src/types.js";
export declare const WIN_VALUE = 1000000000;
export declare const SECURED_LINE_VALUE: number;
/** Hard-only solved tactical horizon, strictly below an actual terminal win. */
export declare function evaluateHardPosition(match: Match, actor: PlayerId): number;
/** Terminal outcomes dominate every bounded heuristic, from the root player's perspective. */
export declare function evaluatePosition(match: Match, actor: PlayerId): number;
