import type { Color, Match } from "../../core/src/types.js";
export interface SecuredClaim {
    readonly color: Color;
    readonly dueAt: number;
    readonly opponentPlacements: number;
}
/** Sufficient survival proof under a pass strategy; never changes the core's outcome. */
export declare function securedClaim(match: Match): SecuredClaim | null;
