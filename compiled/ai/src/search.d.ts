import type { AIAction, AILevel, AIResult, SearchReply } from "./types.js";
import type { V21RuntimeOptions } from "./v21-engine.js";
export declare const SEARCH_POLICIES: Readonly<Record<AILevel, {
    readonly quietWidth: number;
    readonly rootWidth: number;
}>>;
export interface SearchHost {
    readonly now?: () => number;
    readonly isCancelled?: () => boolean;
}
export type SearchStop = "max-depth" | "terminal-win" | "secured-line" | "time" | "nodes" | "cancelled" | "internal";
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
/** Extended runtime entry allowing persistent/shared TT & multi-core SMP without changing the protocol contract. */
export declare function runSearchWithRuntime(raw: unknown, host?: SearchHost, v21Opts?: V21RuntimeOptions): AIResult<SearchOutcome>;
