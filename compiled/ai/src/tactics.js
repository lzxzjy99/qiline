import { activePlayer, applyAction, getLegalActions } from "../../core/src/engine.js";
import { freeze } from "../../core/src/result.js";
import { aiFail, aiOK } from "./protocol.js";
import { capturePoints, centerDistance, colorValue, featuresOf, localSupport, openingValue, otherColor, playerColor, rescuedStones } from "./features.js";
export function listAIActions(match) {
    const actor = activePlayer(match);
    if (!actor) {
        const checked = applyAction(match, { kind: "pass", actor: "A" });
        return checked.ok ? aiFail("INVALID_MATCH") : checked;
    }
    return aiOK(Object.freeze(getLegalActions(match, actor).filter((a) => a.kind !== "resign" && a.kind !== "cancel-opening")));
}
/** Complete root enumeration plus verified direct tactical replies, with no deep search or time budget yet. */
export function analyzeTactics(match) {
    const legal = listAIActions(match);
    if (!legal.ok)
        return legal;
    const actor = activePlayer(match), beforeColor = playerColor(match, actor), before = featuresOf(match);
    let simulatedActions = 0;
    let candidates = [];
    for (const action of legal.value) {
        simulatedActions++;
        const applied = applyAction(match, action);
        if (!applied.ok)
            return applied;
        const next = applied.value.match, outcome = next.state.outcome, color = playerColor(next, actor), f = featuresOf(next);
        const opponent = color ? otherColor(color) : null;
        const captured = applied.value.events.filter(e => e.kind === "captured").reduce((sum, e) => sum + e.points.length, 0);
        const rescued = beforeColor ? rescuedStones(match, next, beforeColor) : 0;
        const group = action.kind === "place" ? f.groups.at[action.point] : undefined;
        const selfAtari = group && group.liberties.size === 1 ? group.stones.length : 0;
        const broken = opponent ? match.state.claims.filter(c => c.color === opponent && !next.state.claims.some(k => k.id === c.id)).length : 0;
        const created = color ? next.state.claims.filter(c => c.color === color && !match.state.claims.some(k => k.id === c.id)).length : 0;
        const blockedFour = opponent ? before[opponent].completions.length > 0 && f[opponent].completions.length < before[opponent].completions.length : false;
        let winningReply = null, lineReplies = 0;
        const nextActor = activePlayer(next);
        if (!outcome && color && opponent && nextActor && nextActor !== actor && next.state.phase.kind === "playing") {
            const probes = new Map();
            for (const point of f[opponent].completions)
                probes.set(point, { kind: "place", actor: nextActor, point });
            if (next.state.claims.length) {
                for (const point of capturePoints(next, opponent))
                    probes.set(point, { kind: "place", actor: nextActor, point });
                probes.set(-1, { kind: "pass", actor: nextActor });
            }
            for (const probe of probes.values()) {
                simulatedActions++;
                const response = applyAction(next, probe);
                if (!response.ok)
                    continue;
                const reply = response.value.match;
                if (reply.state.outcome?.kind === "win" && reply.state.outcome.winner !== actor)
                    winningReply ??= probe;
                // A later enemy claim is not a direct threat if our surviving earlier claim confirms first.
                if (!reply.state.outcome) {
                    const ownDue = Math.min(Infinity, ...reply.state.claims.filter(c => c.color === color).map(c => c.dueAt));
                    if (reply.state.claims.some(c => c.color === opponent && c.dueAt <= ownDue && !next.state.claims.some(k => k.id === c.id)))
                        lineReplies++;
                }
            }
        }
        let tier = winningReply ? 1 : 3;
        if (outcome?.kind === "win")
            tier = outcome.winner === actor ? 5 : 0;
        else if (outcome)
            tier = 2;
        let score = color ? colorValue(next, color) : 0;
        if (match.state.phase.kind === "opening" && action.kind === "place")
            score = openingValue(match, next, action.point);
        else {
            score += captured * 180 + rescued * 250 - selfAtari * 100 + broken * 2200 + created * 1200 - lineReplies * 4000;
            if (action.kind === "place")
                score += localSupport(next, action.point, color ?? "black") * 2 - centerDistance(action.point, match.rules.boardSize) * 0.01;
            if (action.kind === "pass")
                score += color && next.state.claims.some(c => c.color === color) ? 100 : -200;
        }
        if (tier === 5)
            score = action.kind === "pass" ? 1 : 0;
        else if (tier === 2)
            score = 0;
        const reasons = [];
        if (outcome)
            reasons.push(tier === 5 ? "win" : tier === 0 ? "loss" : "draw");
        if (winningReply)
            reasons.push("reply-loses");
        if (broken)
            reasons.push("break-claim");
        if (captured)
            reasons.push("capture");
        if (rescued)
            reasons.push("rescue");
        if (selfAtari)
            reasons.push("self-atari");
        if (created)
            reasons.push("make-claim");
        if (blockedFour)
            reasons.push("block-four");
        if (match.state.phase.kind === "opening")
            reasons.push("opening");
        if (action.kind === "choose-color")
            reasons.push("choose-color");
        if (action.kind === "pass" && color && next.state.claims.some(c => c.color === color))
            reasons.push("wait-for-claim");
        if (!reasons.length)
            reasons.push("quiet");
        const critical = tier === 5 || captured > 0 || rescued > 0 || broken > 0 || created > 0 || blockedFour;
        candidates.push({ action, next, tier, score, critical, reasons, signals: { captured, rescued, selfAtari,
                brokenOpponentClaims: broken, createdOwnClaims: created, blockedFour, opponentWinningReply: winningReply, opponentLineReplies: lineReplies } });
    }
    if (candidates.some(c => c.tier === 0 || c.tier === 1))
        candidates = candidates.map(c => c.tier >= 2
            ? { ...c, critical: true, reasons: [...c.reasons, "avoid-loss"] } : c);
    candidates.sort((a, b) => b.tier - a.tier || b.score - a.score);
    return aiOK(freeze({ actor, candidates, simulatedActions }));
}
