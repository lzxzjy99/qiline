import type { Match, MatchRecord, PlayerId, RuleConfig } from "../../core/src/types.js";
export type Controller = {
    readonly kind: "human";
} | {
    readonly kind: "ai";
    readonly level: "easy" | "standard";
    readonly seed: number;
};
export type Controllers = Readonly<Record<PlayerId, Controller>>;
export interface TaskToken {
    readonly matchId: string;
    readonly revision: number;
    readonly taskId: string;
    readonly actor: PlayerId;
    readonly kind: "ai" | "hint";
}
export interface ConsentRequest {
    readonly id: string;
    readonly requester: PlayerId;
    readonly kind: "undo" | "cancel-opening" | "enable-hints";
    readonly revision: number;
}
export interface SessionState {
    readonly matchId: string;
    readonly revision: number;
    readonly match: Match;
    readonly controllers: Controllers;
    readonly competitive: boolean;
    readonly paused: boolean;
    readonly closed: boolean;
    readonly hintsEnabled: boolean;
    readonly consent: ConsentRequest | null;
    readonly task: TaskToken | null;
}
export interface SessionOptions {
    readonly matchId: string;
    readonly rules?: RuleConfig;
    readonly controllers?: Controllers;
    readonly competitive?: boolean;
}
export interface SessionSave {
    readonly sessionSchemaVersion: 1;
    readonly record: MatchRecord;
    readonly controllers: Controllers;
    readonly competitive: boolean;
}
