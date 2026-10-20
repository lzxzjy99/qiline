import { activePlayer, exportRecord } from "../../core/src/engine.js";
import { freeze, plain } from "../../core/src/result.js";
import { GameSession } from "../../session/src/session.js";
import { AI_PROFILES, AI_PROTOCOL_VERSION, aiFail, aiOK, validateSearchBudget, validateSearchReply } from "./protocol.js";
import { playModeOf } from "./save.js";
// Distinct even when a newly restored Session happens to reuse every serialized token field.
let requestSequence = 0;
export class AITurn {
    #session;
    #token;
    #request;
    #settled = false;
    constructor(session, token, request) {
        this.#session = session;
        this.#token = token;
        this.#request = request;
    }
    static begin(session, options = {}) {
        if (!(session instanceof GameSession) || !plain(options)
            || !Object.keys(options).every(k => k === "budget"))
            return aiFail("INVALID_AI_REQUEST");
        const mode = playModeOf(session.state);
        if (!mode.ok)
            return mode;
        if (mode.value !== "practice")
            return aiFail("AI_MODE_UNSUPPORTED");
        const s = session.state, actor = activePlayer(s.match);
        if (!actor)
            return aiFail("FINISHED");
        const controller = s.controllers[actor];
        if (controller.kind !== "ai")
            return aiFail("WRONG_ACTOR");
        const budget = validateSearchBudget(Object.hasOwn(options, "budget") ? options.budget : AI_PROFILES[controller.level]);
        if (!budget.ok)
            return budget;
        if (s.matchId.length > 256 || requestSequence >= Number.MAX_SAFE_INTEGER || s.revision > Number.MAX_SAFE_INTEGER - 2)
            return aiFail("INVALID_AI_REQUEST");
        const requestId = `qiline-ai-${++requestSequence}`;
        const token = session.beginTask("ai", actor, requestId);
        if (!token.ok)
            return token;
        const context = { requestId, matchId: token.value.matchId, revision: token.value.revision, taskId: token.value.taskId, actor };
        const request = freeze({ protocolVersion: AI_PROTOCOL_VERSION, kind: "search", context,
            record: exportRecord(s.match), level: controller.level, seed: controller.seed, budget: budget.value });
        return aiOK(new AITurn(session, token.value, request));
    }
    /** Only this structured-clone-safe payload goes to a future Worker. The original token stays private. */
    get request() { return this.#request; }
    get isCurrent() { return !this.#settled && this.#session.isTaskCurrent(this.#token); }
    #pause(error) {
        this.#settled = true;
        this.#session.setPaused(true); // This also clears the current task without accepting any game command.
        return Object.freeze({ ok: false, error });
    }
    accept(raw) {
        if (!this.isCurrent)
            return aiFail("STALE_AI_TASK");
        const reply = validateSearchReply(this.#request, raw);
        if (!reply.ok)
            return reply.error.code === "STALE_AI_TASK" ? reply : this.#pause(reply.error);
        if (reply.value.status === "cancelled")
            return this.stop("cancelled");
        if (reply.value.status === "failed")
            return this.stop(reply.value.reason === "no-action" ? "no-result" : "worker-error");
        const committed = this.#session.commitAIResult(this.#token, reply.value.action);
        if (!committed.ok)
            return this.#pause(committed.error);
        this.#settled = true;
        return committed;
    }
    /** Host reports cancellation/crash/hard timeout here. Actual Worker termination belongs to P5.4. */
    stop(reason = "cancelled") {
        if (!this.isCurrent)
            return aiFail("STALE_AI_TASK");
        const failure = aiFail(reason === "cancelled" ? "AI_CANCELLED" : reason === "no-result" ? "AI_NO_RESULT" : "AI_WORKER_FAILED");
        return this.#pause(failure.error);
    }
}
export const beginAITurn = (session, options = {}) => AITurn.begin(session, options);
