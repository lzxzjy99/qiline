import { activePlayer, applyAction, validateRecord } from "../../core/src/engine.js";
import { freeze, keysAre, plain } from "../../core/src/result.js";
import { AI_PROTOCOL_VERSION, aiFail, aiOK, readSearchEnvelope } from "./protocol.js";
import { alphaBeta } from "./tree.js";
import { evaluatePosition, WIN_VALUE } from "./evaluation.js";
import { actionKey, orderActions, tieRank } from "./ordering.js";
import { featuresOf, otherColor, playerColor, rescuedStones } from "./features.js";
export const SEARCH_POLICIES = freeze({
    easy: { quietWidth: 6, rootWidth: 12 }, standard: { quietWidth: 12, rootWidth: 24 },
    hard: { quietWidth: 12, rootWidth: 24 },
});
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
    // Request-local identity cache: distinct ko histories/claim clocks never share entries.
    transitions = new WeakMap();
    cachedTransitions = 0;
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
        // Revisited probes still spend a node; memoization saves computation, not budget checks.
        this.nodes++;
        this.maxVisitedDepth = Math.max(this.maxVisitedDepth, depth);
        const key = actionKey(action), cached = this.transitions.get(match)?.get(key);
        if (cached)
            return cached;
        const result = applyAction(match, action);
        if (this.cachedTransitions < 2048) {
            let entries = this.transitions.get(match);
            if (!entries) {
                entries = new Map();
                this.transitions.set(match, entries);
            }
            entries.set(key, result);
            this.cachedTransitions++;
        }
        return result;
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
/** Only an actually legal, core-confirmed winning reply proves a direct tactical loss. */
function losingReply(match, justMoved, control, depth) {
    if (match.state.outcome || match.state.phase.kind !== "playing")
        return false;
    const actor = activePlayer(match);
    if (!actor || actor === justMoved)
        return false;
    const color = match.state.phase.toMove;
    const probes = match.rules.confirmationDelay === 0
        ? featuresOf(match)[color].completions.map(point => ({ kind: "place", actor, point })) : [];
    if (match.state.claims.some(c => c.color === color && c.dueAt <= match.state.ply + 1))
        probes.push({ kind: "pass", actor });
    for (const action of probes) {
        const result = control.simulate(match, action, depth);
        if (result.ok && result.value.match.state.outcome?.kind === "win" && result.value.match.state.outcome.winner === actor)
            return true;
    }
    return false;
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
        const orders = new WeakMap();
        const history = new Map(), killers = new Map();
        const historyKey = (match, action) => `${action.actor}/${match.state.phase.kind}/${playerColor(match, action.actor)}/${actionKey(action)}`;
        const proposalsFor = (match, preferred, pathDepth, quietWidth) => {
            let proposals = orders.get(match);
            if (!proposals) {
                proposals = orderActions(match, header.seed);
                orders.set(match, proposals);
            }
            if (header.level === "hard") {
                const key = preferred ? actionKey(preferred) : null, killer = killers.get(pathDepth) ?? [];
                const score = (p) => p.order + (history.get(historyKey(match, p.action)) ?? 0) + (killer.includes(historyKey(match, p.action)) ? 8000 : 0);
                let quiet = 0;
                const selected = proposals.filter(p => p.critical || actionKey(p.action) === key || quiet++ < quietWidth);
                return selected.map(p => ({ p, preferred: actionKey(p.action) === key, score: score(p), tie: tieRank(p.action, header.seed) }))
                    .sort((a, b) => Number(b.preferred) - Number(a.preferred) || Number(b.p.critical) - Number(a.p.critical) || b.score - a.score || b.tie - a.tie).map(x => x.p);
            }
            if (!preferred)
                return proposals;
            const key = actionKey(preferred);
            return [...proposals.filter(p => actionKey(p.action) === key), ...proposals.filter(p => actionKey(p.action) !== key)];
        };
        let values = new Map();
        let quietRoots = 0;
        for (const proposal of ordered) {
            control.check();
            if (!proposal.critical && quietRoots >= SEARCH_POLICIES[header.level].rootWidth)
                continue;
            const result = control.simulate(match, proposal.action, 1);
            if (!result.ok)
                continue;
            if (!proposal.critical)
                quietRoots++;
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
            const candidates = sorted.filter(r => r.critical || quiet++ < width), safe = [];
            for (const root of candidates) {
                if (losingReply(root.next, actor, control, 2))
                    cutoffs++;
                else
                    safe.push(root);
            }
            const selected = safe.length ? safe : candidates;
            const tree = {
                check: () => control.check(), terminal: n => !!n.match.state.outcome, player: n => activePlayer(n.match),
                evaluate: n => { control.check(); return evaluatePosition(n.match, actor); }, cutoff: (node, move, remaining) => {
                    cutoffs++;
                    if (header.level === "hard") {
                        const key = historyKey(node.match, move);
                        history.set(key, Math.min(4000, (history.get(key) ?? 0) + remaining * remaining * 20));
                        killers.set(node.pathDepth, [key, ...(killers.get(node.pathDepth) ?? []).filter(k => k !== key)].slice(0, 2));
                    }
                },
                extend: node => {
                    if (header.level !== "hard" || node.pathDepth >= Math.min(header.budget.maxDepth, depth + 2)
                        || node.match.state.phase.kind !== "playing")
                        return false;
                    control.check();
                    const f = featuresOf(node.match);
                    return (node.match.rules.confirmationDelay === 0 && (f.black.completions.length > 0 || f.white.completions.length > 0))
                        || node.match.state.claims.some(c => c.dueAt <= node.match.state.ply + 2);
                },
                children: function* (node) {
                    control.check();
                    const pref = node.onPV ? preferred[node.pathDepth] ?? null : null;
                    const quietWidth = header.level === "easy" ? width : Math.max(4, width - node.pathDepth * 2);
                    const proposals = proposalsFor(node.match, pref, node.pathDepth, quietWidth);
                    control.check();
                    let quietLegal = 0;
                    const moving = activePlayer(node.match);
                    let forcing = null;
                    if (header.level === "hard" && node.pathDepth >= depth) {
                        const f = featuresOf(node.match);
                        forcing = new Set([...f.black.completions, ...f.white.completions]);
                        for (const group of f.groups.groups)
                            if (group.liberties.size === 1
                                || group.liberties.size === 2 && group.stones.some(p => f[group.color === 1 ? 'black' : 'white'].lineStones.has(p)))
                                for (const point of group.liberties)
                                    forcing.add(point);
                    }
                    let losingChild = null, any = false;
                    for (const proposal of proposals) {
                        if (forcing && proposal.action.kind === 'place' && !forcing.has(proposal.action.point))
                            continue;
                        control.check();
                        if (!proposal.critical && quietLegal >= quietWidth)
                            continue;
                        const result = control.simulate(node.match, proposal.action, node.pathDepth + 1);
                        if (!result.ok)
                            continue;
                        if (!proposal.critical)
                            quietLegal++;
                        const child = { move: proposal.action, node: { match: result.value.match, pathDepth: node.pathDepth + 1,
                                onPV: node.onPV && !!pref && actionKey(proposal.action) === actionKey(pref) } };
                        if (node.pathDepth + 2 <= depth && losingReply(child.node.match, moving, control, node.pathDepth + 2)) {
                            losingChild ??= child;
                            cutoffs++;
                            continue;
                        }
                        any = true;
                        yield child;
                        const outcome = child.node.match.state.outcome;
                        if (outcome?.kind === "win" && outcome.winner === moving)
                            return;
                    }
                    // If all searched moves lose, retain a legal branch instead of inventing a pass or score.
                    if (!any && losingChild)
                        yield losingChild;
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
