import type { Match } from "../../core/src/types.js";
import type { AIAction } from "./types.js";
export interface OrderedAction {
    readonly action: AIAction;
    readonly critical: boolean;
    readonly order: number;
}
export declare const actionKey: (a: AIAction) => string;
export declare function tieRank(a: AIAction, seed: number): number;
/** Whole-board hints only. Every returned proposal is still checked by the core before use. */
export declare function orderActions(match: Match, seed: number, preferred?: AIAction | null): readonly OrderedAction[];
