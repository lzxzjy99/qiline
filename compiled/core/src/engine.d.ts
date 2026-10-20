import type { Action, GroupInfo, Match, MatchRecord, PlayerId, Result, Transition } from "./types.js";
export declare function createMatch(input?: unknown): Result<Match>;
export declare function validateAction(input: unknown): Result<Action>;
export declare function activePlayer(match: Match): PlayerId | null;
export declare function applyAction(match: Match, input: unknown): Result<Transition>;
export declare function getLegalPlacements(match: Match): readonly number[];
/** Turn choices for actor; defaults to active player. Joint consent is handled by session. */
export declare function getLegalActions(match: Match, actor?: PlayerId | null): readonly Action[];
export declare function inspectGroup(match: Match, p: unknown): Result<GroupInfo | null>;
/** Data primitive only. Live games must use session's consent/competition gate. */
export declare function undoLastCommand(match: Match): Result<Match>;
export declare function exportRecord(match: Match): MatchRecord;
export declare function validateRecord(input: unknown): Result<{
    readonly record: MatchRecord;
    readonly match: Match;
}>;
export declare function replayRecord(input: unknown): Result<Match>;
export declare function parseRecord(text: string): Result<Match>;
