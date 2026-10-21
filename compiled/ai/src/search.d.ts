import type { AIAction, AILevel, AIResult, SearchReply } from "./types.js";
export declare const SEARCH_POLICIES: Readonly<Record<AILevel, {
    readonly quietWidth: number;
    readonly rootWidth: number;
}>>;
export interface SearchHost {
    readonly now?: () => number;
    readonly isCancelled?: () => boolean;
}
export type SearchStop = "max-depth" | "terminal-win" | "time" | "nodes" | "cancelled" | "internal";
export interface SearchOutcome {
    readonly reply: SearchReply;
    readonly details: {
        readonly stop: SearchStop;
        readonly quietWidth: number;
        readonly maxVisitedDepth: number;
        readonly cutoffs: number;
        readonly rootCandidates: number;
        readonly score: number | null;
        readonly variation: readonly AIAction[];
    };
}
/** Timed local search. It returns a serialized reply, not an authorization token or a live move. */
export declare function runSearch(raw: unknown, host?: SearchHost): AIResult<SearchOutcome>;
