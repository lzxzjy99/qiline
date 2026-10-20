import { activePlayer, applyAction, validateRecord } from "../../core/src/engine.js";
import { freeze, keysAre, plain } from "../../core/src/result.js";
import { AI_PROTOCOL_VERSION, aiFail, aiOK, readSearchEnvelope } from "./protocol.js";
import { alphaBeta } from "./tree.js";
import { evaluatePosition, WIN_VALUE } from "./evaluation.js";
import { actionKey, orderActions, tieRank } from "./ordering.js";
import { featuresOf, otherColor, playerColor, rescuedStones } from "./features.js";
export const SEARCH_POLICIES = freeze({ easy: { quietWidth: 6 }, standard: { quietWidth: 12 } });
class Stopped {
    reason;
    constructor(reason) {
        this.reason = reason;
    }
}
class Control {
    budget;
    now;
    cancelled;
    start;
    last;
    nodes = 0;
    maxVisitedDepth = 0;
    constructor(budget, now, cancelled, started) {
        this.budget = budget;
        this.now = now;
        this.cancelled = cancelled;
        this.start = started;
        this.last = this.start;
        if (!Number.isFinite(this.start) || this.start < 0)
            throw Error("invalid clock");
    }
    time() {
        const now = this.now();
        if (!Number.isFinite(now) || now < this.last)
            throw Error("clock must be monotonic");
        this.last = now;
        return Math.min(Number.MAX_SAFE_INTEGER, now - this.start);
    }
    check() { if (this.cancelled())
        throw new Stopped("cancelled"); if (this.time() >= this.budget.timeMs)
        throw new Stopped("time"); }
    simulate(match, action, depth) {
        this.check();
        if (this.nodes >= this.budget.maxNodes)
            throw new Stopped("nodes");
        this.nodes++;
        this.maxVisitedDepth = Math.max(this.maxVisitedDepth, depth);
        return applyAction(match, action);
    }
}
const defaultNow = () => globalThis.performance.now();
/** Replays every explicit command under the clock, without changing any core rule or restoring a raw board. */
function hydrate(header, control) {
    control.check();
    const raw = header.record;
    if (!plain(raw) || !keysAre(raw, ["schemaVersion", "rulesVersion", "rules", "actions"]) || !Array.isArray(raw.actions))
        return aiFail("INVALID_AI_REQUEST", "record");
    const start = validateRecord({ ...raw, actions: [] });
    if (!start.ok)
        return aiFail("INVALID_AI_REQUEST", start.error.path, start.error.code);
    let match = start.value.match;
    for (let i = 0; i < raw.actions.length; i++) {
        control.check();
        const next = applyAction(match, raw.actions[i]);
        if (!next.ok)
            return aiFail("INVALID_AI_REQUEST", `actions[${i}]`, next.error.code);
        match = next.value.match;
    }
    control.check();
    if (match.state.outcome)
        return aiFail("FINISHED");
    if (activePlayer(match) !== header.context.actor)
        return aiFail("WRONG_ACTOR");
    return aiOK(match);
}
function isCritical(before, after, action, transition, hinted) {
    if (hinted || action.kind !== "place" || after.state.outcome)
        return true;
    if (transition.events.some(e => e.kind === "captured" || e.kind === "claim-started" || e.kind === "claim-cancelled"))
        return true;
    const color = playerColor(before, action.actor);
    if (!color)
        return false;
    return rescuedStones(before, after, color) > 0 || featuresOf(after)[otherColor(color)].completions.length < featuresOf(before)[otherColor(color)].completions.length;
}
/** Timed local search. It returns a serialized reply, not an authorization token or a live move. */
export function runSearch(raw, host = {}) {
    if (!plain(host) || !Object.keys(host).every(k => k === "now" || k === "isCancelled")
        || (host.now !== undefined && typeof host.now !== "function") || (host.isCancelled !== undefined && typeof host.isCancelled !== "function"))
        return aiFail("INVALID_AI_REQUEST", "host");
    const now = host.now === undefined ? defaultNow : host.now;
    const cancelled = host.isCancelled === undefined ? () => false : host.isCancelled;
    let started;
    try {
        started = now();
    }
    catch {
        return aiFail("AI_WORKER_FAILED");
    }
    const parsed = readSearchEnvelope(raw);
    if (!parsed.ok)
        return parsed;
    const header = parsed.value;
    let control;
    try {
        control = new Control(header.budget, now, cancelled, started);
    }
    catch {
        return aiFail("AI_WORKER_FAILED");
    }
    const width = SEARCH_POLICIES[header.level].quietWidth, actor = header.context.actor;
    let best = null, bestScore = null, variation = [], completedDepth = 0, cutoffs = 0, rootCount = 0;
    function finish(stop) {
        let elapsed = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, control.last - control.start));
        try {
            elapsed = control.time();
            if (control.cancelled())
                stop = "cancelled";
            else if (elapsed >= header.budget.timeMs && stop !== "internal" && stop !== "cancelled")
                stop = "time";
        }
        catch {
            stop = "internal";
        }
        const common = { protocolVersion: AI_PROTOCOL_VERSION, kind: "result", context: header.context,
            stats: { elapsedMs: elapsed, nodes: control.nodes, completedDepth } };
        let reply;
        if (stop === "cancelled")
            reply = { ...common, status: "cancelled" };
        else if (stop === "internal")
            reply = { ...common, status: "failed", reason: "internal" };
        else if (best)
            reply = { ...common, status: stop === "time" || stop === "nodes" ? "timeout" : "move", action: best };
        else
            reply = { ...common, status: "failed", reason: "no-action" };
        return aiOK(freeze({ reply, details: { stop, quietWidth: width, maxVisitedDepth: control.maxVisitedDepth, cutoffs,
                rootCandidates: rootCount, score: bestScore, variation } }));
    }
    try {
        const restored = hydrate(header, control);
        if (!restored.ok)
            return restored;
        const match = restored.value;
        control.nodes = 1;
        control.check();
        const ordered = orderActions(match, header.seed);
        control.check();
        const roots = [];
        let values = new Map();
        for (const proposal of ordered) {
            const result = control.simulate(match, proposal.action, 1);
            if (!result.ok)
                continue;
            const next = result.value.match;
            rootCount++;
            // Retain a known-legal root even if the next clock check interrupts its evaluation.
            if (!best) {
                best = proposal.action;
                variation = [best];
            }
            if (next.state.outcome?.kind === "win" && next.state.outcome.winner === actor) {
                best = proposal.action;
                bestScore = WIN_VALUE;
                variation = [best];
                completedDepth = 1;
                return finish("terminal-win");
            }
            control.check();
            const value = evaluatePosition(next, actor);
            control.check();
            const critical = isCritical(match, next, proposal.action, result.value, proposal.critical);
            roots.push({ action: proposal.action, next, critical, order: proposal.order });
            values.set(actionKey(proposal.action), value);
            if (bestScore === null || value > bestScore || (value === bestScore && tieRank(proposal.action, header.seed) > tieRank(best, header.seed))) {
                best = proposal.action;
                bestScore = value;
                variation = [best];
            }
        }
        if (!roots.length)
            return finish("nodes");
        completedDepth = 1;
        for (let depth = 2; depth <= header.budget.maxDepth; depth++) {
            control.check();
            const preferred = variation, previousValues = values;
            const sorted = roots.slice().sort((a, b) => (previousValues.get(actionKey(b.action)) ?? -Infinity) - (previousValues.get(actionKey(a.action)) ?? -Infinity)
                || b.order - a.order || tieRank(b.action, header.seed) - tieRank(a.action, header.seed));
            let quiet = 0;
            const selected = sorted.filter(r => r.critical || quiet++ < width);
            const tree = {
                check: () => control.check(), terminal: n => !!n.match.state.outcome, player: n => activePlayer(n.match),
                evaluate: n => { control.check(); return evaluatePosition(n.match, actor); }, cutoff: () => { cutoffs++; },
                children: function* (node) {
                    control.check();
                    const pref = node.onPV ? preferred[node.pathDepth] ?? null : null;
                    const proposals = orderActions(node.match, header.seed, pref);
                    control.check();
                    let quietLegal = 0;
                    for (const proposal of proposals) {
                        control.check();
                        if (!proposal.critical && quietLegal >= width)
                            continue;
                        const result = control.simulate(node.match, proposal.action, node.pathDepth + 1);
                        if (!result.ok)
                            continue;
                        if (!proposal.critical)
                            quietLegal++;
                        yield { move: proposal.action, node: { match: result.value.match, pathDepth: node.pathDepth + 1,
                                onPV: node.onPV && !!pref && actionKey(proposal.action) === actionKey(pref) } };
                    }
                },
            };
            let iterationBest = null, iterationValue = -Infinity, iterationPV = [];
            const nextValues = new Map();
            for (const root of selected) {
                control.check();
                const result = alphaBeta({ match: root.next, pathDepth: 1, onPV: !!preferred[0] && actionKey(root.action) === actionKey(preferred[0]) }, depth - 1, actor, tree, iterationValue, Infinity);
                nextValues.set(actionKey(root.action), result.value);
                // Fail-low values are bounds, so equal bounds never replace the exact first best.
                if (iterationBest === null || result.value > iterationValue) {
                    iterationBest = root.action;
                    iterationValue = result.value;
                    iterationPV = [root.action, ...result.variation];
                }
                if (iterationValue === WIN_VALUE)
                    break;
            }
            if (iterationBest) {
                best = iterationBest;
                bestScore = iterationValue;
                variation = iterationPV;
                completedDepth = depth;
                values = nextValues;
            }
        }
        return finish("max-depth");
    }
    catch (e) {
        return finish(e instanceof Stopped ? e.reason : "internal");
    }
}
