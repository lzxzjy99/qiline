import { GameSession } from "../../session/src/session.js";
import type { SessionState } from "../../session/src/types.js";
import type { AIResult, SearchRequest } from "./types.js";
export declare class AITurn {
    #private;
    private constructor();
    static begin(session: GameSession, options?: unknown): AIResult<AITurn>;
    /** Only this structured-clone-safe payload goes to a future Worker. The original token stays private. */
    get request(): SearchRequest;
    get isCurrent(): boolean;
    accept(raw: unknown): AIResult<SessionState>;
    /** Host reports cancellation/crash/hard timeout here. Actual Worker termination belongs to P5.4. */
    stop(reason?: "cancelled" | "worker-error" | "no-result"): AIResult<SessionState>;
}
export declare const beginAITurn: (session: GameSession, options?: unknown) => AIResult<AITurn>;
