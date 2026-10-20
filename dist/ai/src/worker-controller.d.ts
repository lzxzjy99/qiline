import type { Result } from "../../core/src/types.js";
import { GameSession } from "../../session/src/session.js";
import type { SessionState } from "../../session/src/types.js";
import type { AIError, AIResult } from "./types.js";
export interface WorkerPort {
    onmessage: ((event: {
        readonly data: unknown;
    }) => void) | null;
    onerror: ((event: unknown) => void) | null;
    onmessageerror: ((event: unknown) => void) | null;
    postMessage(message: unknown): void;
    terminate(): void;
}
export type TimerId = number | object;
export interface WorkerHost {
    readonly createWorker: () => WorkerPort;
    readonly now: () => number;
    readonly setTimer: (callback: () => void, ms: number) => TimerId;
    readonly clearTimer: (id: TimerId) => void;
    readonly onState?: (state: WorkerState) => void;
}
export interface WorkerLimits {
    readonly startupMs: number;
    readonly graceMs: number;
}
export declare const DEFAULT_WORKER_LIMITS: WorkerLimits;
export interface WorkerState {
    readonly status: "idle" | "starting" | "thinking" | "paused" | "failed" | "closed";
    readonly hold: "pause" | "undo" | null;
    readonly error: AIError | null;
    readonly requestId: string | null;
    readonly matchId: string;
    readonly revision: number;
}
/** Owns one fresh Worker per explicit AI command. UI mutations should go through change(). */
export declare class AIWorkerController {
    #private;
    private constructor();
    static create(session: GameSession, host: WorkerHost, limits?: unknown): AIResult<AIWorkerController>;
    get state(): WorkerState;
    start(): AIResult<WorkerState>;
    sync(): AIResult<WorkerState>;
    /** Pass only an existing Session command here. Failed commands leave the current Worker running. */
    change(command: () => Result<SessionState>): AIResult<WorkerState>;
    pause(): AIResult<WorkerState>;
    resume(): AIResult<WorkerState>;
    retry(): AIResult<WorkerState>;
    close(): void;
}
export declare const createAIWorkerController: (session: GameSession, host: WorkerHost, limits?: unknown) => AIResult<AIWorkerController>;
