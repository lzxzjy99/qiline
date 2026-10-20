import type { Action, ErrorCode, Match, MatchRecord, PlayerId } from "../../core/src/types.js";
import type { Controller } from "../../session/src/types.js";

export type AILevel = Extract<Controller, {kind:"ai"}>["level"];
/** Search may suggest only these commands. Human resignation is a separate UI operation. */
export type AIAction = Extract<Action, {kind:"place"|"choose-color"|"pass"}>;
export interface SearchBudget {
  readonly timeMs:number;
  readonly maxNodes:number;
  readonly maxDepth:number;
}
/** Correlation data only; this is never a Session TaskToken or an authorization handle. */
export interface AIContext {
  readonly requestId:string;
  readonly matchId:string;
  readonly revision:number;
  readonly taskId:string;
  readonly actor:PlayerId;
}
export interface SearchRequest {
  readonly protocolVersion:1;
  readonly kind:"search";
  readonly context:AIContext;
  readonly record:MatchRecord;
  readonly level:AILevel;
  readonly seed:number;
  readonly budget:SearchBudget;
}
export interface PreparedSearch {
  readonly request:SearchRequest;
  /** A branded core match reconstructed by replay, including PSK and all claim clocks. */
  readonly match:Match;
}
export interface SearchStats {
  readonly elapsedMs:number;
  readonly nodes:number;
  readonly completedDepth:number;
}
interface ReplyBase {
  readonly protocolVersion:1;
  readonly kind:"result";
  readonly context:AIContext;
  readonly stats:SearchStats;
}
export type SearchReply =
  | (ReplyBase & {readonly status:"move"|"timeout"; readonly action:AIAction})
  | (ReplyBase & {readonly status:"cancelled"})
  | (ReplyBase & {readonly status:"failed"; readonly reason:"no-action"|"internal"});
export type AIErrorCode = ErrorCode | "UNSUPPORTED_AI_PROTOCOL" | "INVALID_AI_REQUEST"
  | "INVALID_AI_BUDGET" | "INVALID_AI_REPLY" | "STALE_AI_TASK" | "AI_MODE_UNSUPPORTED"
  | "AI_CANCELLED" | "AI_NO_RESULT" | "AI_WORKER_FAILED";
export interface AIError {
  readonly code:AIErrorCode;
  readonly messageKey:string;
  readonly path?:string;
  readonly cause?:ErrorCode;
}
export type AIResult<T> = {readonly ok:true; readonly value:T} | {readonly ok:false; readonly error:AIError};
