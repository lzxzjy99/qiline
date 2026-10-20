import type { PlayerId, Result } from "../../core/src/types.js";
import type { SessionSave, SessionState, TaskToken } from "./types.js";
/** No DOM, timers, storage or AI search. Hosts supply unique ids and schedule work. */
export declare class GameSession {
    #private;
    private constructor();
    static create(input: unknown): Result<GameSession>;
    static restore(matchId: unknown, input: unknown): Result<GameSession>;
    get state(): SessionState;
    submit(actor: PlayerId, input: unknown): Result<SessionState>;
    requestUndo(actor: PlayerId): Result<SessionState>;
    requestCancelOpening(actor: PlayerId): Result<SessionState>;
    requestHints(actor: PlayerId): Result<SessionState>;
    respondToConsent(actor: PlayerId, id: string, accept: boolean): Result<SessionState>;
    disableHints(actor: PlayerId): Result<SessionState>;
    setPaused(paused: boolean): Result<SessionState>;
    beginTask(kind: TaskToken["kind"], actor: PlayerId, taskId: string): Result<TaskToken>;
    isTaskCurrent(input: unknown): input is TaskToken;
    commitAIResult(token: unknown, input: unknown): Result<SessionState>;
    completeHint(token: unknown): Result<SessionState>;
    cancelTask(): Result<SessionState>;
    newGame(matchId: string, rules?: unknown): Result<SessionState>;
    exportSave(): SessionSave;
    loadSave(matchId: string, input: unknown): Result<SessionState>;
    close(): void;
}
export declare const createSession: (input: unknown) => Result<GameSession>;
/** Startup restoration: no live human game is discarded. Old task handles are not restored. */
export declare const restoreSession: (matchId: unknown, input: unknown) => Result<GameSession>;
