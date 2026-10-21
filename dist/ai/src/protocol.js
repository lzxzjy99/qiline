import { activePlayer, validateAction, validateRecord } from "../../core/src/engine.js";
import { freeze, keysAre, plain } from "../../core/src/result.js";
export const AI_PROTOCOL_VERSION = 1;
/** Initial engineering budgets, not measured playing-strength ratings. */
export const AI_PROFILES = freeze({
    easy: { timeMs: 300, maxNodes: 2500, maxDepth: 2 },
    standard: { timeMs: 1200, maxNodes: 15000, maxDepth: 6 },
});
export const AI_BUDGET_LIMITS = freeze({ timeMs: 10000, maxNodes: 1000000, maxDepth: 12 });
export const aiOK = (value) => Object.freeze({ ok: true, value });
export function aiFail(code, path, cause) {
    return Object.freeze({ ok: false, error: Object.freeze({ code, messageKey: `errors.${code}`,
            ...(path === undefined ? {} : { path }), ...(cause === undefined ? {} : { cause }) }) });
}
const uint = (n, max) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= max;
const positive = (n, max) => uint(n, max) && n > 0;
const id = (s) => typeof s === "string" && s.trim().length > 0 && s.length <= 256;
function contextOf(raw) {
    if (!plain(raw) || !keysAre(raw, ["requestId", "matchId", "revision", "taskId", "actor"])
        || !id(raw.requestId) || !id(raw.matchId) || !id(raw.taskId) || !uint(raw.revision, Number.MAX_SAFE_INTEGER)
        || (raw.actor !== "A" && raw.actor !== "B"))
        return null;
    return freeze({ requestId: raw.requestId, matchId: raw.matchId, revision: raw.revision, taskId: raw.taskId, actor: raw.actor });
}
export function validateSearchBudget(raw) {
    if (!plain(raw) || !keysAre(raw, ["timeMs", "maxNodes", "maxDepth"])
        || !positive(raw.timeMs, AI_BUDGET_LIMITS.timeMs) || !positive(raw.maxNodes, AI_BUDGET_LIMITS.maxNodes)
        || !positive(raw.maxDepth, AI_BUDGET_LIMITS.maxDepth))
        return aiFail("INVALID_AI_BUDGET");
    return aiOK(freeze({ timeMs: raw.timeMs, maxNodes: raw.maxNodes, maxDepth: raw.maxDepth }));
}
/** Header validation without replay; the timed runner validates each record command separately. */
export function readSearchEnvelope(raw) {
    if (!plain(raw))
        return aiFail("INVALID_AI_REQUEST");
    if (raw.protocolVersion !== AI_PROTOCOL_VERSION)
        return aiFail("UNSUPPORTED_AI_PROTOCOL");
    if (!keysAre(raw, ["protocolVersion", "kind", "context", "record", "level", "seed", "budget"])
        || raw.kind !== "search" || (raw.level !== "easy" && raw.level !== "standard") || !uint(raw.seed, 0xffffffff))
        return aiFail("INVALID_AI_REQUEST");
    const context = contextOf(raw.context);
    if (!context)
        return aiFail("INVALID_AI_REQUEST", "context");
    const budget = validateSearchBudget(raw.budget);
    if (!budget.ok)
        return budget;
    return aiOK(Object.freeze({ protocolVersion: AI_PROTOCOL_VERSION, kind: "search", context, record: raw.record,
        level: raw.level, seed: raw.seed, budget: budget.value }));
}
/** Untimed convenience boundary. The production search entry is runSearch, which includes replay in its budget. */
export function prepareSearch(raw) {
    const header = readSearchEnvelope(raw);
    if (!header.ok)
        return header;
    const replay = validateRecord(header.value.record);
    if (!replay.ok)
        return aiFail("INVALID_AI_REQUEST", replay.error.path, replay.error.code);
    const { record, match } = replay.value;
    if (match.state.outcome)
        return aiFail("FINISHED");
    if (activePlayer(match) !== header.value.context.actor)
        return aiFail("WRONG_ACTOR");
    const request = freeze({ ...header.value, record });
    return aiOK(Object.freeze({ request, match }));
}
/** Check a serialized reply against an already validated request. Legality is checked by Session on commit. */
export function validateSearchReply(request, raw) {
    if (!plain(raw))
        return aiFail("INVALID_AI_REPLY");
    const context = contextOf(raw.context);
    // A well-formed old correlation must never pause, cancel or overwrite a newer task.
    if (context && Object.keys(context).some(k => context[k] !== request.context[k]))
        return aiFail("STALE_AI_TASK");
    if (raw.protocolVersion !== AI_PROTOCOL_VERSION)
        return aiFail("UNSUPPORTED_AI_PROTOCOL");
    if (!context || raw.kind !== "result")
        return aiFail("INVALID_AI_REPLY");
    const fields = ["protocolVersion", "kind", "context", "stats", "status"];
    if (raw.status === "move" || raw.status === "timeout")
        fields.push("action");
    else if (raw.status === "failed")
        fields.push("reason");
    else if (raw.status !== "cancelled")
        return aiFail("INVALID_AI_REPLY");
    if (!keysAre(raw, fields))
        return aiFail("INVALID_AI_REPLY");
    const s = raw.stats;
    if (!plain(s) || !keysAre(s, ["elapsedMs", "nodes", "completedDepth"])
        || typeof s.elapsedMs !== "number" || !Number.isFinite(s.elapsedMs) || s.elapsedMs < 0 || s.elapsedMs > Number.MAX_SAFE_INTEGER
        || !uint(s.nodes, request.budget.maxNodes) || !uint(s.completedDepth, request.budget.maxDepth))
        return aiFail("INVALID_AI_REPLY", "stats");
    const common = { protocolVersion: AI_PROTOCOL_VERSION, kind: "result", context,
        stats: { elapsedMs: s.elapsedMs, nodes: s.nodes, completedDepth: s.completedDepth } };
    if (raw.status === "cancelled")
        return aiOK(freeze({ ...common, status: "cancelled" }));
    if (raw.status === "failed") {
        if (raw.reason !== "no-action" && raw.reason !== "internal")
            return aiFail("INVALID_AI_REPLY");
        return aiOK(freeze({ ...common, status: "failed", reason: raw.reason }));
    }
    const a = validateAction(raw.action);
    if (!a.ok)
        return aiFail("INVALID_AI_REPLY", "action", a.error.code);
    if (a.value.kind === "resign" || a.value.kind === "cancel-opening")
        return aiFail("INVALID_AI_REPLY", "action");
    if (a.value.actor !== request.context.actor)
        return aiFail("WRONG_ACTOR", "action.actor");
    return aiOK(freeze({ ...common, status: raw.status, action: a.value }));
}
