import { cellOf, collectGroups, neighborsFor } from "../../core/src/geometry.js";
const windowsCache = new Map();
const featureCache = new WeakMap();
function windows(rules) {
    const n = rules.boardSize, key = `${n}/${rules.directions}`;
    let result = windowsCache.get(key);
    if (!result) {
        const list = [];
        const directions = rules.directions === "four" ? [[1, 1], [-1, 1], [1, 0], [0, 1]] : [[1, 1], [-1, 1]];
        for (const [dx, dy] of directions)
            for (let y = 0; y < n; y++)
                for (let x = 0; x < n; x++) {
                    if (x + 4 * dx < 0 || x + 4 * dx >= n || y + 4 * dy >= n)
                        continue;
                    list.push(Array.from({ length: 5 }, (_, k) => (y + k * dy) * n + x + k * dx));
                }
        result = Object.freeze(list.map(points => Object.freeze(points)));
        windowsCache.set(key, result);
    }
    return result;
}
/** Geometric ordering hints only. Only core.applyAction is allowed to declare a win or legality. */
function lines(board, rules, color) {
    const own = cellOf(color), weights = [0, 2, 14, 90, 600, 2400], completions = new Set();
    let potential = 0;
    for (const points of windows(rules)) {
        let count = 0, empty = -1, blocked = false;
        for (const p of points) {
            if (board[p] === -own) {
                blocked = true;
                break;
            }
            if (board[p] === own)
                count++;
            else
                empty = p;
        }
        if (!blocked) {
            potential += weights[count];
            if (count === 4)
                completions.add(empty);
        }
    }
    return { potential, completions: [...completions].sort((a, b) => a - b) };
}
export function featuresOf(match) {
    let found = featureCache.get(match);
    if (!found) {
        found = { groups: collectGroups(match.state.board, match.rules.boardSize),
            black: lines(match.state.board, match.rules, "black"), white: lines(match.state.board, match.rules, "white") };
        featureCache.set(match, found);
    }
    return found;
}
export const otherColor = (color) => color === "black" ? "white" : "black";
export function playerColor(match, actor) {
    const owners = match.state.owners;
    return owners ? (owners.black === actor ? "black" : "white") : null;
}
export function claimPressure(match, color) {
    return match.state.claims.filter(c => c.color === color)
        .reduce((sum, c) => sum + 1800 / Math.max(1, c.dueAt - match.state.ply), 0);
}
export function colorValue(match, color) {
    const f = featuresOf(match), own = cellOf(color), opponent = otherColor(color);
    let material = 0, safety = 0;
    for (const c of match.state.board)
        material += c === own ? 4 : c === -own ? -4 : 0;
    for (const group of f.groups.groups) {
        const value = group.liberties.size === 1 ? -120 * group.stones.length : Math.min(4, group.liberties.size) * 2;
        safety += group.color === own ? value : -value;
    }
    const tempo = match.state.phase.kind === "playing" ? (match.state.phase.toMove === color ? 12 : -12) : 0;
    return f[color].potential - f[opponent].potential + material + safety + tempo
        + claimPressure(match, color) - claimPressure(match, opponent);
}
export function rescuedStones(before, after, color) {
    const own = cellOf(color), next = featuresOf(after).groups;
    let rescued = 0;
    for (const group of featuresOf(before).groups.groups)
        if (group.color === own && group.liberties.size === 1) {
            const survivor = next.at[group.stones[0]];
            if (survivor?.color === own && survivor.liberties.size >= 2)
                rescued += group.stones.length;
        }
    return rescued;
}
/** Every global atari liberty is retained, including remote captures of stones belonging to a five. */
export function capturePoints(match, by) {
    const opponent = -cellOf(by), points = new Set();
    for (const group of featuresOf(match).groups.groups)
        if (group.color === opponent && group.liberties.size === 1)
            points.add(group.liberties.values().next().value);
    return [...points].sort((a, b) => a - b);
}
export function centerDistance(point, n) {
    const mid = (n - 1) / 2;
    return (point % n - mid) ** 2 + (Math.floor(point / n) - mid) ** 2;
}
export function openingValue(before, after, point) {
    const phase = before.state.phase, n = before.rules.boardSize;
    if (phase.kind !== "opening")
        return 0;
    if (phase.placed === 0)
        return -centerDistance(point, n);
    if (phase.placed === 1) {
        const first = before.state.lastPlacement, distance = Math.max(Math.abs(first % n - point % n), Math.abs(Math.floor(first / n) - Math.floor(point / n)));
        return -40 * Math.abs(distance - 2) - centerDistance(point, n);
    }
    // A lays out both colors; B can choose either. Reduce the larger static color advantage.
    return -Math.abs(colorValue(after, "black")) - centerDistance(point, n) * 0.1;
}
export function localSupport(match, point, color) {
    const own = cellOf(color);
    return neighborsFor(match.rules.boardSize)[point].filter(p => match.state.board[p] === own).length;
}
