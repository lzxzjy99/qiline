import type { Match, PlayerId } from "../../core/src/types.js";
export declare const WIN_VALUE = 1000000000;
/** Terminal outcomes dominate every bounded heuristic, from the root player's perspective. */
export declare function evaluatePosition(match: Match, actor: PlayerId): number;
