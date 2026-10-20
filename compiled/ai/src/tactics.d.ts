import type { Match, PlayerId } from "../../core/src/types.js";
import type { AIAction, AIResult } from "./types.js";
export interface TacticalSignals {
    readonly captured: number;
    readonly rescued: number;
    readonly selfAtari: number;
    readonly brokenOpponentClaims: number;
    readonly createdOwnClaims: number;
    readonly blockedFour: boolean;
    /** A verified winning reply, not a proof that unlisted replies are safe. */
    readonly opponentWinningReply: AIAction | null;
    readonly opponentLineReplies: number;
}
export type TacticalReason = "win" | "loss" | "draw" | "reply-loses" | "break-claim" | "capture" | "rescue" | "self-atari" | "make-claim" | "block-four" | "avoid-loss" | "opening" | "choose-color" | "wait-for-claim" | "quiet";
export interface TacticalCandidate {
    readonly action: AIAction;
    readonly next: Match;
    /** 5 win; 3 live without a witnessed losing reply; 2 draw; 1 witnessed loss next; 0 loss now. */
    readonly tier: 0 | 1 | 2 | 3 | 5;
    readonly score: number;
    /** Keep all such moves when adding quiet-move pruning in P5.3. P5.2 prunes nothing. */
    readonly critical: boolean;
    readonly reasons: readonly TacticalReason[];
    readonly signals: TacticalSignals;
}
export interface TacticalAnalysis {
    readonly actor: PlayerId;
    readonly candidates: readonly TacticalCandidate[];
    /** All attempted core transitions, including rejected tactical probes; not SearchStats.nodes. */
    readonly simulatedActions: number;
}
export declare function listAIActions(match: Match): AIResult<readonly AIAction[]>;
/** Complete root enumeration plus verified direct tactical replies, with no deep search or time budget yet. */
export declare function analyzeTactics(match: Match): AIResult<TacticalAnalysis>;
