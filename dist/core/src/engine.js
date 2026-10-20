import { fail, freeze, keysAre, ok, plain } from "./result.js";
import { configIdOf, DEFAULT_RULES, RULES_VERSION, validateRules } from "./rules.js";
import { collectGroups, other, positionKey, simulatePlacement, validPoint } from "./geometry.js";
import { presentClaims } from "./claims.js";
const STORE = new WeakMap();
const groupsCache = new WeakMap();
// Bounded memoization: parent snapshots do not retain a full Set at every ply.
const historyCache = new Map();
const COLORS = ["black", "white"];
function compareLine(a, b) {
    if (a.color !== b.color)
        return a.color === "white" ? -1 : 1;
    for (let i = 0; i < Math.min(a.points.length, b.points.length); i++) {
        const difference = a.points[i] - b.points[i];
        if (difference)
            return difference;
    }
    return a.points.length - b.points.length;
}
function internals(match) {
    return typeof match === "object" && match !== null ? STORE.get(match) : undefined;
}
function table(board, n) {
    let g = groupsCache.get(board);
    if (!g) {
        g = collectGroups(board, n);
        groupsCache.set(board, g);
    }
    return g;
}
function historySet(head) {
    let found = historyCache.get(head);
    if (!found) {
        const set = new Set();
        let p = head;
        while (p) {
            set.add(p.key);
            p = p.previous;
        }
        found = set;
        historyCache.set(head, found);
        if (historyCache.size > 32)
            historyCache.delete(historyCache.keys().next().value);
    }
    return found;
}
function commands(head) {
    const result = [];
    for (let p = head; p; p = p.previous)
        result.push(p.action);
    return Object.freeze(result.reverse());
}
function positions(head) {
    const result = [];
    for (let p = head; p; p = p.previous)
        result.push(p.key);
    return Object.freeze(result.reverse());
}
function publish(rules, draft, data) {
    const state = freeze(draft);
    const match = Object.freeze({ rules, configId: configIdOf(rules), state,
        get accepted() { return commands(data.actions); }, get positions() { return positions(data.positions); } });
    STORE.set(match, data);
    return match;
}
function clone(state) {
    return { board: state.board.slice(), moveLabels: state.moveLabels.slice(), phase: state.phase, owners: state.owners,
        ply: state.ply, placements: state.placements, captures: { ...state.captures }, claims: state.claims.slice(),
        passStreak: state.passStreak, lastPlacement: state.lastPlacement, lastCaptured: state.lastCaptured.slice(), outcome: state.outcome };
}
export function createMatch(input = DEFAULT_RULES) {
    const r = validateRules(input);
    if (!r.ok)
        return r;
    const rules = r.value, board = Array(rules.boardSize ** 2).fill(0);
    return ok(publish(rules, { board, moveLabels: Array(board.length).fill(0),
        phase: rules.swap3 ? { kind: "opening", placed: 0 } : { kind: "playing", toMove: "black" },
        owners: rules.swap3 ? null : { black: "A", white: "B" }, ply: 0, placements: 0, captures: { black: 0, white: 0 },
        claims: [], passStreak: 0, lastPlacement: null, lastCaptured: [], outcome: null }, { parent: null, actions: null, positions: Object.freeze({ key: positionKey(board), previous: null, length: 1 }) }));
}
export function validateAction(input) {
    if (!plain(input) || (input.actor !== "A" && input.actor !== "B"))
        return fail("INVALID_ACTION");
    const actor = input.actor;
    switch (input.kind) {
        case "place":
            if (!keysAre(input, ["kind", "actor", "point"]))
                return fail("INVALID_ACTION");
            if (typeof input.point !== "number" || !Number.isInteger(input.point))
                return fail("OUT_OF_BOUNDS");
            return ok(Object.freeze({ kind: "place", actor, point: input.point }));
        case "choose-color":
            if (!keysAre(input, ["kind", "actor", "color"]))
                return fail("INVALID_ACTION");
            if (input.color !== "black" && input.color !== "white")
                return fail("INVALID_COLOR");
            return ok(Object.freeze({ kind: "choose-color", actor, color: input.color }));
        case "pass":
        case "resign":
            return keysAre(input, ["kind", "actor"]) ? ok(Object.freeze({ kind: input.kind, actor })) : fail("INVALID_ACTION");
        case "cancel-opening":
            if (!keysAre(input, ["kind", "actor", "approvedBy"]))
                return fail("INVALID_ACTION");
            if (!Array.isArray(input.approvedBy) || input.approvedBy.length !== 2
                || !input.approvedBy.includes("A") || !input.approvedBy.includes("B"))
                return fail("CONSENT_REQUIRED");
            return ok(freeze({ kind: "cancel-opening", actor, approvedBy: ["A", "B"] }));
        default: return fail("INVALID_ACTION");
    }
}
function setPhase(d, phase, events) { d.phase = phase; events.push({ kind: "phase-changed", phase }); }
function end(d, outcome, events) {
    d.outcome = outcome;
    setPhase(d, { kind: "finished" }, events);
    events.push({ kind: "ended", outcome });
}
function settle(d, rules, events) {
    const present = presentClaims(d.board, rules), keep = [];
    for (const claim of d.claims) {
        if (present.has(claim.id))
            keep.push(claim);
        else
            events.push({ kind: "claim-cancelled", claim, ply: d.ply });
    }
    d.claims = keep;
    const mature = keep.filter(c => c.dueAt <= d.ply).sort((a, b) => a.formedAt - b.formedAt || compareLine(a, b));
    if (mature.length) {
        const color = mature[0].color;
        end(d, { kind: "win", color, winner: d.owners[color], reason: "line" }, events);
        return;
    }
    const existing = new Set(keep.map(c => c.id));
    for (const entry of [...present.values()].sort(compareLine)) {
        const id = entry.id;
        if (existing.has(id))
            continue;
        const claim = { ...present.get(id), formedAt: d.ply, dueAt: d.ply + rules.confirmationDelay };
        d.claims.push(claim);
        events.push({ kind: "claim-started", claim });
        if (rules.confirmationDelay === 0) {
            end(d, { kind: "win", color: claim.color, winner: d.owners[claim.color], reason: "line" }, events);
            return;
        }
    }
    d.claims.sort((a, b) => a.formedAt - b.formedAt || compareLine(a, b));
    if (d.passStreak === 2 && d.claims.length === 0)
        end(d, { kind: "draw", reason: "two-passes" }, events);
}
function placement(board, p, color, rules, history, opening) {
    const r = simulatePlacement(board, p, color, rules.boardSize, table(board, rules.boardSize));
    if (!r.ok)
        return r;
    if (opening && r.value.captured.length)
        return fail("OPENING_CAPTURE");
    if (rules.superko === "positional" && historySet(history).has(positionKey(r.value.board)))
        return fail("REPETITION");
    return r;
}
function hasPlacement(d, rules, history) {
    if (d.phase.kind !== "playing")
        return false;
    for (let p = 0; p < d.board.length; p++)
        if (d.board[p] === 0 && placement(d.board, p, d.phase.toMove, rules, history, false).ok)
            return true;
    return false;
}
function pass(d, rules, events, automatic) {
    if (d.phase.kind !== "playing")
        throw new Error("pass outside play");
    const color = d.phase.toMove;
    d.ply++;
    d.passStreak = Math.min(2, d.passStreak + 1);
    events.push({ kind: "passed", color, automatic, ply: d.ply });
    settle(d, rules, events);
    if (!d.outcome)
        setPhase(d, { kind: "playing", toMove: other(color) }, events);
}
function normalize(d, rules, history, events) {
    let count = 0;
    while (d.phase.kind === "playing" && !hasPlacement(d, rules, history)) {
        pass(d, rules, events, true);
        count++;
        // A code invariant, never a hidden draw/loss or a game turn cap.
        if (count > rules.confirmationDelay + 2)
            throw new Error("automatic pass invariant violated");
    }
}
export function activePlayer(match) {
    if (!internals(match))
        return null;
    const s = match.state;
    return s.phase.kind === "opening" ? "A" : s.phase.kind === "choose" ? "B" : s.phase.kind === "playing" ? s.owners[s.phase.toMove] : null;
}
export function applyAction(match, input) {
    const data = internals(match);
    if (!data)
        return fail("INVALID_MATCH");
    if (match.state.outcome)
        return fail("FINISHED");
    const parsed = validateAction(input);
    if (!parsed.ok)
        return parsed;
    const action = parsed.value, d = clone(match.state), events = [], rules = match.rules;
    let history = data.positions;
    if (action.kind === "cancel-opening") {
        if (d.phase.kind !== "opening" && d.phase.kind !== "choose")
            return fail("WRONG_PHASE");
        end(d, { kind: "cancelled", reason: "opening-cancel" }, events);
    }
    else if (action.kind === "resign") {
        if (d.phase.kind !== "playing")
            return fail("WRONG_PHASE");
        const own = d.owners.black === action.actor ? "black" : "white", color = other(own);
        end(d, { kind: "win", color, winner: d.owners[color], reason: "resign" }, events);
    }
    else if (d.phase.kind === "choose") {
        if (action.kind !== "choose-color")
            return fail("WRONG_PHASE");
        if (action.actor !== "B")
            return fail("WRONG_ACTOR");
        d.owners = action.color === "black" ? { black: "B", white: "A" } : { black: "A", white: "B" };
        events.push({ kind: "color-chosen", owners: d.owners });
        setPhase(d, { kind: "playing", toMove: "white" }, events);
        normalize(d, rules, history, events);
    }
    else {
        if (action.kind === "choose-color" || (d.phase.kind === "opening" && action.kind !== "place"))
            return fail("WRONG_PHASE");
        if (action.actor !== activePlayer(match))
            return fail("WRONG_ACTOR");
        if (action.kind === "pass")
            pass(d, rules, events, false);
        else if (action.kind === "place") {
            const opening = d.phase.kind === "opening";
            const color = opening ? (d.phase.kind === "opening" && d.phase.placed === 1 ? "white" : "black")
                : d.phase.toMove;
            const r = placement(d.board, action.point, color, rules, history, opening);
            if (!r.ok)
                return r;
            d.board = r.value.board;
            d.ply++;
            d.placements++;
            d.passStreak = 0;
            d.captures[color] += r.value.captured.length;
            for (const p of r.value.captured)
                d.moveLabels[p] = 0;
            d.moveLabels[action.point] = d.placements;
            d.lastPlacement = action.point;
            d.lastCaptured = r.value.captured;
            history = Object.freeze({ key: positionKey(d.board), previous: history, length: history.length + 1 });
            events.push({ kind: "placed", color, point: action.point, label: d.placements, ply: d.ply });
            if (r.value.captured.length)
                events.push({ kind: "captured", by: color, points: r.value.captured });
            if (d.phase.kind === "opening") {
                setPhase(d, d.phase.placed === 2 ? { kind: "choose" } : { kind: "opening", placed: (d.phase.placed + 1) }, events);
            }
            else {
                settle(d, rules, events);
                if (!d.outcome)
                    setPhase(d, { kind: "playing", toMove: other(color) }, events);
            }
        }
        normalize(d, rules, history, events);
    }
    const next = publish(rules, d, { parent: match, positions: history, actions: Object.freeze({ action, previous: data.actions }) });
    return ok(Object.freeze({ match: next, events: freeze(events) }));
}
export function getLegalPlacements(match) {
    const data = internals(match);
    if (!data)
        return Object.freeze([]);
    const { state: s, rules } = match;
    if (s.phase.kind !== "playing" && s.phase.kind !== "opening")
        return Object.freeze([]);
    const opening = s.phase.kind === "opening";
    const color = s.phase.kind === "playing" ? s.phase.toMove : s.phase.placed === 1 ? "white" : "black";
    const result = [];
    for (let p = 0; p < s.board.length; p++)
        if (s.board[p] === 0 && placement(s.board, p, color, rules, data.positions, opening).ok)
            result.push(p);
    return Object.freeze(result);
}
/** Turn choices for actor; defaults to active player. Joint consent is handled by session. */
export function getLegalActions(match, actor = activePlayer(match)) {
    if (!internals(match) || actor === null || (actor !== "A" && actor !== "B") || match.state.outcome)
        return Object.freeze([]);
    const result = [], phase = match.state.phase;
    if (actor === activePlayer(match)) {
        if (phase.kind === "choose")
            for (const color of COLORS)
                result.push({ kind: "choose-color", actor, color });
        else {
            for (const point of getLegalPlacements(match))
                result.push({ kind: "place", actor, point });
            if (phase.kind === "playing")
                result.push({ kind: "pass", actor });
        }
    }
    if (phase.kind === "playing")
        result.push({ kind: "resign", actor });
    return freeze(result);
}
export function inspectGroup(match, p) {
    if (!internals(match))
        return fail("INVALID_MATCH");
    if (!validPoint(p, match.rules.boardSize))
        return fail("OUT_OF_BOUNDS");
    const g = table(match.state.board, match.rules.boardSize).at[p];
    return ok(g ? freeze({ color: g.color === 1 ? "black" : "white", stones: g.stones.slice(), liberties: [...g.liberties].sort((a, b) => a - b) }) : null);
}
/** Data primitive only. Live games must use session's consent/competition gate. */
export function undoLastCommand(match) {
    const data = internals(match);
    if (!data)
        return fail("INVALID_MATCH");
    if (match.state.outcome)
        return fail("FINISHED");
    return data.parent ? ok(data.parent) : fail("NO_UNDO");
}
export function exportRecord(match) {
    if (!internals(match))
        throw new TypeError("exportRecord requires a core-created Match");
    return freeze({ schemaVersion: 1, rulesVersion: RULES_VERSION, rules: match.rules, actions: match.accepted });
}
export function validateRecord(input) {
    if (!plain(input))
        return fail("INVALID_RECORD");
    if ((Object.hasOwn(input, "schemaVersion") && input.schemaVersion !== 1)
        || (Object.hasOwn(input, "rulesVersion") && input.rulesVersion !== RULES_VERSION))
        return fail("UNSUPPORTED_VERSION");
    if (!keysAre(input, ["schemaVersion", "rulesVersion", "rules", "actions"]) || !Array.isArray(input.actions))
        return fail("INVALID_RECORD");
    const start = createMatch(input.rules);
    if (!start.ok)
        return fail(start.error.code === "UNSUPPORTED_VERSION" ? "UNSUPPORTED_VERSION" : "INVALID_RECORD", "rules", start.error.code);
    let match = start.value;
    for (let i = 0; i < input.actions.length; i++) {
        const r = applyAction(match, input.actions[i]);
        if (!r.ok)
            return fail("INVALID_RECORD", `actions[${i}]`, r.error.code);
        match = r.value.match;
    }
    return ok(Object.freeze({ record: exportRecord(match), match }));
}
export function replayRecord(input) {
    const r = validateRecord(input);
    return r.ok ? ok(r.value.match) : r;
}
export function parseRecord(text) {
    let input;
    try {
        input = JSON.parse(text);
    }
    catch {
        return fail("INVALID_RECORD");
    }
    return replayRecord(input);
}
//# sourceMappingURL=engine.js.map