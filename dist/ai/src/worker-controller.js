import { activePlayer, undoLastCommand } from "../../core/src/engine.js";
import { freeze, keysAre, plain } from "../../core/src/result.js";
import { GameSession } from "../../session/src/session.js";
import { AITurn, beginAITurn } from "./turn.js";
import { aiFail, aiOK } from "./protocol.js";
import { playModeOf } from "./save.js";
export const DEFAULT_WORKER_LIMITS = freeze({ startupMs: 3000, graceMs: 250 });
const ready = (raw) => plain(raw) && keysAre(raw, ["protocolVersion", "kind"]) && raw.protocolVersion === 1 && raw.kind === "ready";
/** Owns one fresh Worker per explicit AI command. UI mutations should go through change(). */
export class AIWorkerController {
    #session;
    #host;
    #limits;
    #state;
    #seen;
    #lastNow;
    #enabled = false;
    #closed = false;
    #permanentFault = false;
    #job = null;
    #queued = null;
    #queueGeneration = 0;
    #hold = null;
    #error = null;
    constructor(session, host, limits, now) {
        this.#session = session;
        this.#host = host;
        this.#limits = limits;
        this.#lastNow = now;
        this.#seen = session.state;
        this.#state = Object.freeze({ status: session.state.closed ? "closed" : session.state.paused ? "paused" : "idle", hold: null,
            error: null, requestId: null, matchId: session.state.matchId, revision: session.state.revision });
    }
    static create(session, host, limits = DEFAULT_WORKER_LIMITS) {
        if (!(session instanceof GameSession) || !plain(host) || !Object.keys(host).every(k => ["createWorker", "now", "setTimer", "clearTimer", "onState"].includes(k))
            || [host.createWorker, host.now, host.setTimer, host.clearTimer].some(f => typeof f !== "function")
            || (host.onState !== undefined && typeof host.onState !== "function") || !plain(limits) || !keysAre(limits, ["startupMs", "graceMs"])
            || !Number.isSafeInteger(limits.startupMs) || Number(limits.startupMs) < 1 || Number(limits.startupMs) > 10000
            || !Number.isSafeInteger(limits.graceMs) || Number(limits.graceMs) < 0 || Number(limits.graceMs) > 1000)
            return aiFail("INVALID_AI_REQUEST");
        const mode = playModeOf(session.state);
        if (!mode.ok)
            return mode;
        let now;
        try {
            now = host.now();
        }
        catch {
            return aiFail("AI_WORKER_FAILED");
        }
        if (!Number.isFinite(now) || now < 0)
            return aiFail("AI_WORKER_FAILED");
        return aiOK(new AIWorkerController(session, host, { startupMs: Number(limits.startupMs), graceMs: Number(limits.graceMs) }, now));
    }
    get state() { return this.#state; }
    #now() {
        const now = this.#host.now();
        if (!Number.isFinite(now) || now < this.#lastNow)
            throw Error("invalid monotonic clock");
        this.#lastNow = now;
        return now;
    }
    #set(status) {
        const s = this.#session.state, next = Object.freeze({ status, hold: this.#hold, error: this.#error,
            requestId: this.#job?.turn.request.context.requestId ?? null, matchId: s.matchId, revision: s.revision });
        const old = this.#state;
        if (old.status === next.status && old.hold === next.hold && old.error === next.error && old.requestId === next.requestId
            && old.matchId === next.matchId && old.revision === next.revision)
            return;
        this.#state = next;
        try {
            this.#host.onState?.(next);
        }
        catch { /* Presentation errors do not change game authority. */ }
    }
    #clearQueue() {
        this.#queueGeneration++;
        if (this.#queued !== null) {
            try {
                this.#host.clearTimer(this.#queued);
            }
            catch { }
            this.#queued = null;
        }
    }
    #clearTimer(job, key) {
        if (job.timers.has(key)) {
            const id = job.timers.get(key);
            job.timers.delete(key);
            try {
                this.#host.clearTimer(id);
            }
            catch { }
        }
    }
    #timer(job, key, ms, callback) {
        this.#clearTimer(job, key);
        const id = this.#host.setTimer(() => { job.timers.delete(key); if (this.#job === job)
            callback(); }, ms);
        job.timers.set(key, id);
    }
    #release(job) {
        if (this.#job === job)
            this.#job = null;
        for (const key of [...job.timers.keys()])
            this.#clearTimer(job, key);
        const port = job.port;
        job.port = null;
        if (port) {
            try {
                port.onmessage = null;
                port.onerror = null;
                port.onmessageerror = null;
            }
            catch { }
            try {
                port.terminate();
            }
            catch {
                this.#permanentFault = true;
            }
        }
    }
    #aiTurn() {
        const s = this.#session.state, actor = activePlayer(s.match);
        return !!actor && !s.closed && !s.match.state.outcome && s.controllers[actor].kind === "ai";
    }
    #observe() {
        const current = this.#session.state, previous = this.#seen;
        if (current !== previous) {
            this.#seen = current;
            if (current.matchId !== previous.matchId) {
                this.#hold = null;
                this.#error = null;
            }
            else if (previous.task && !current.task && current.match === previous.match && !current.paused && this.#aiTurn()) {
                this.#hold = "pause";
                this.#session.setPaused(true);
                this.#seen = this.#session.state;
            }
            else if (current.match !== previous.match) {
                const parent = undoLastCommand(previous.match);
                if ((current.match.state.ply < previous.match.state.ply || (parent.ok && parent.value === current.match)) && this.#aiTurn()) {
                    this.#hold = "undo";
                    this.#error = null;
                    this.#session.setPaused(true);
                    this.#seen = this.#session.state;
                }
            }
        }
    }
    #fail(job, reason, error) {
        if (job && this.#job !== job)
            return;
        if (job && !job.turn.isCurrent) {
            this.#release(job);
            this.sync();
            return;
        }
        const result = job ? job.turn.stop(reason) : null;
        this.#error = error ?? (result && !result.ok ? result.error : aiFail("AI_WORKER_FAILED").error);
        if (!job)
            this.#session.setPaused(true);
        if (job)
            this.#release(job);
        this.#clearQueue();
        this.#seen = this.#session.state;
        this.#hold = null;
        this.#set("failed");
    }
    #checkJob(job) {
        if (this.#job !== job || this.#closed)
            return false;
        this.#observe();
        if (!job.turn.isCurrent) {
            this.#release(job);
            this.sync();
            return false;
        }
        try {
            if (this.#now() >= job.deadline) {
                this.#fail(job, job.ready ? "no-result" : "worker-error");
                return false;
            }
        }
        catch {
            this.#fail(job, "worker-error");
            return false;
        }
        return true;
    }
    #watch(job) {
        this.#timer(job, "watch", 50, () => { if (this.#checkJob(job))
            this.#watch(job); });
    }
    #message(job, raw) {
        if (!this.#checkJob(job))
            return;
        if (ready(raw)) {
            if (job.ready)
                return;
            job.ready = true;
            this.#clearTimer(job, "startup");
            try {
                job.deadline = this.#now() + job.turn.request.budget.timeMs + this.#limits.graceMs;
                this.#timer(job, "search", job.turn.request.budget.timeMs + this.#limits.graceMs, () => this.#fail(job, "no-result"));
                this.#set("thinking");
                if (this.#job === job && job.turn.isCurrent)
                    job.port.postMessage(job.turn.request);
                else if (this.#job === job) {
                    this.#release(job);
                    this.sync();
                }
            }
            catch {
                this.#fail(job, "worker-error");
            }
            return;
        }
        if (!job.ready) {
            this.#fail(job, "worker-error");
            return;
        }
        const result = job.turn.accept(raw);
        if (!result.ok && result.error.code === "STALE_AI_TASK" && job.turn.isCurrent)
            return;
        this.#release(job);
        this.#seen = this.#session.state;
        if (!result.ok) {
            this.#error = result.error;
            this.#hold = null;
            this.#set("failed");
            return;
        }
        this.#error = null;
        this.#hold = null;
        this.sync();
    }
    #boot() {
        this.#observe();
        const s = this.#session.state;
        if (this.#closed || !this.#enabled || this.#job || s.paused || s.task || !this.#aiTurn() || this.#error)
            return;
        let start;
        try {
            start = this.#now();
        }
        catch {
            this.#fail(null, "worker-error");
            return;
        }
        const turn = beginAITurn(this.#session);
        if (!turn.ok) {
            this.#error = turn.error;
            this.#set("failed");
            return;
        }
        const job = { turn: turn.value, port: null, timers: new Map(), ready: false, deadline: start + this.#limits.startupMs };
        this.#job = job;
        this.#seen = this.#session.state;
        this.#set("starting");
        if (this.#job !== job)
            return;
        try {
            this.#timer(job, "startup", Math.max(0, job.deadline - this.#now()), () => this.#fail(job, "worker-error"));
            const port = this.#host.createWorker();
            if (!port || typeof port.postMessage !== "function" || typeof port.terminate !== "function")
                throw Error("invalid Worker port");
            job.port = port;
            if (this.#job !== job) {
                this.#release(job);
                return;
            }
            if (!this.#checkJob(job))
                return;
            port.onmessage = event => this.#message(job, event.data);
            port.onerror = () => { if (this.#checkJob(job))
                this.#fail(job, "worker-error"); };
            port.onmessageerror = () => { if (this.#checkJob(job))
                this.#fail(job, "worker-error"); };
            this.#watch(job);
        }
        catch {
            this.#fail(job, "worker-error");
        }
    }
    #queue() {
        if (this.#queued !== null || this.#job || this.#closed)
            return;
        const generation = ++this.#queueGeneration;
        try {
            this.#queued = this.#host.setTimer(() => {
                if (generation !== this.#queueGeneration)
                    return;
                this.#queued = null;
                this.#boot();
            }, 0);
        }
        catch {
            this.#fail(null, "worker-error");
        }
    }
    start() { if (this.#closed)
        return aiFail("CLOSED"); this.#enabled = true; return this.sync(); }
    sync() {
        this.#observe();
        const s = this.#session.state;
        if (this.#job && !this.#job.turn.isCurrent)
            this.#release(this.#job);
        if (this.#closed || s.closed) {
            this.#closed = true;
            this.#clearQueue();
            if (this.#job)
                this.#release(this.#job);
            this.#set("closed");
            return aiOK(this.#state);
        }
        if (this.#permanentFault) {
            this.#clearQueue();
            this.#session.setPaused(true);
            this.#error = aiFail("AI_WORKER_FAILED").error;
            this.#set("failed");
            return aiFail("AI_WORKER_FAILED");
        }
        const mode = playModeOf(s);
        if (!mode.ok) {
            this.#fail(this.#job, "worker-error", mode.error);
            return mode;
        }
        if (s.match.state.outcome) {
            this.#clearQueue();
            if (this.#job)
                this.#release(this.#job);
            this.#hold = null;
            this.#error = null;
            this.#set("idle");
            return aiOK(this.#state);
        }
        if (this.#error) {
            this.#clearQueue();
            this.#set("failed");
            return aiOK(this.#state);
        }
        if (s.paused) {
            this.#clearQueue();
            this.#hold ??= "pause";
            this.#set("paused");
            return aiOK(this.#state);
        }
        this.#hold = null;
        if (this.#job) {
            this.#set(this.#job.ready ? "thinking" : "starting");
            return aiOK(this.#state);
        }
        this.#set("idle");
        const fresh = this.#session.state;
        if (this.#enabled && !fresh.paused && !fresh.task && !this.#error && this.#aiTurn())
            this.#queue();
        else
            this.#clearQueue();
        return aiOK(this.#state);
    }
    /** Pass only an existing Session command here. Failed commands leave the current Worker running. */
    change(command) {
        if (this.#closed)
            return aiFail("CLOSED");
        let result;
        try {
            result = command();
        }
        catch {
            this.#fail(this.#job, "worker-error");
            return aiFail("AI_WORKER_FAILED");
        }
        if (!result.ok)
            return result;
        return this.sync();
    }
    pause() { return this.change(() => this.#session.setPaused(true)); }
    resume() {
        if (this.#closed)
            return aiFail("CLOSED");
        if (this.#session.state.match.state.outcome)
            return aiFail("FINISHED");
        if (this.#permanentFault)
            return aiFail("AI_WORKER_FAILED");
        const result = this.#session.setPaused(false);
        if (!result.ok)
            return result;
        this.#hold = null;
        this.#error = null;
        this.#enabled = true;
        return this.sync();
    }
    retry() { return this.#state.status === "failed" ? this.resume() : aiFail("INVALID_AI_REQUEST"); }
    close() {
        if (this.#closed)
            return;
        this.#closed = true;
        this.#enabled = false;
        this.#clearQueue();
        if (this.#job)
            this.#release(this.#job);
        this.#session.close();
        this.#seen = this.#session.state;
        this.#set("closed");
    }
}
export const createAIWorkerController = (session, host, limits = DEFAULT_WORKER_LIMITS) => AIWorkerController.create(session, host, limits);
