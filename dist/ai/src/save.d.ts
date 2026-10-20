import type { GameSession } from "../../session/src/session.js";
import type { SessionState } from "../../session/src/types.js";
import type { AIResult } from "./types.js";
export type PlayMode = "pvp" | "practice";
/** First-release human-facing modes; AI-v-AI benchmarks can get a separate host later. */
export declare function playModeOf(state: SessionState): AIResult<PlayMode>;
/** Accept the existing SessionSave v1 or raw MatchRecord. Web player metadata stays in the UI adapter. */
export declare function restorePlayableSession(matchId: string, input: unknown): AIResult<{
    session: GameSession;
    mode: PlayMode;
}>;
