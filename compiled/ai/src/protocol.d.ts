import type { ErrorCode } from "../../core/src/types.js";
import type { AIError, AIErrorCode, AILevel, AIResult, PreparedSearch, SearchBudget, SearchReply, SearchRequest } from "./types.js";
export declare const AI_PROTOCOL_VERSION = 1;
/** Initial engineering budgets, not measured playing-strength ratings. */
export declare const AI_PROFILES: Readonly<Record<AILevel, SearchBudget>>;
export declare const AI_BUDGET_LIMITS: SearchBudget;
export declare const aiOK: <T>(value: T) => AIResult<T>;
export declare function aiFail(code: AIErrorCode, path?: string, cause?: ErrorCode): {
    readonly ok: false;
    readonly error: AIError;
};
export declare function validateSearchBudget(raw: unknown): AIResult<SearchBudget>;
/** Worker entry boundary: validate and replay the full record before searching. */
export declare function prepareSearch(raw: unknown): AIResult<PreparedSearch>;
/** Check a serialized reply against an already validated request. Legality is checked by Session on commit. */
export declare function validateSearchReply(request: SearchRequest, raw: unknown): AIResult<SearchReply>;
