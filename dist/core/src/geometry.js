import { fail, ok } from "./result.js";
export const cellOf = (color) => color === "black" ? 1 : -1;
export const colorOf = (cell) => cell === 1 ? "black" : "white";
export const other = (color) => color === "black" ? "white" : "black";
export const validPoint = (p, n) => typeof p === "number" && Number.isInteger(p) && p >= 0 && p < n * n;
const adjacency = new Map();
export function neighborsFor(n) {
    let result = adjacency.get(n);
    if (!result) {
        result = Object.freeze(Array.from({ length: n * n }, (_, p) => Object.freeze([
            ...(p % n > 0 ? [p - 1] : []), ...(p % n < n - 1 ? [p + 1] : []), ...(p >= n ? [p - n] : []), ...(p < n * (n - 1) ? [p + n] : [])
        ])));
        adjacency.set(n, result);
    }
    return result;
}
export function collectGroups(board, n) {
    const at = Array(board.length), groups = [];
    const adj = neighborsFor(n);
    for (let p = 0; p < board.length; p++) {
        const color = board[p];
        if (!color || at[p])
            continue;
        const stones = [], liberties = new Set(), seen = new Set([p]), stack = [p];
        while (stack.length) {
            const q = stack.pop();
            stones.push(q);
            for (const r of adj[q]) {
                if (board[r] === 0)
                    liberties.add(r);
                else if (board[r] === color && !seen.has(r)) {
                    seen.add(r);
                    stack.push(r);
                }
            }
        }
        stones.sort((a, b) => a - b);
        const group = { color, stones, liberties };
        groups.push(group);
        for (const q of stones)
            at[q] = group;
    }
    return { at, groups };
}
export function geometryPossible(board, p, color, n, table) {
    if (!validPoint(p, n) || board[p] !== 0)
        return false;
    const adj = neighborsFor(n)[p], own = cellOf(color);
    return adj.some(q => board[q] === 0 || (board[q] === own && table.at[q].liberties.size > 1)
        || (board[q] === -own && table.at[q].liberties.size === 1 && table.at[q].liberties.has(p)));
}
/** Low-level geometry, not a match loader. Requires a valid board with no dead groups. */
export function simulatePlacement(board, p, color, n, table = collectGroups(board, n)) {
    if (!validPoint(p, n))
        return fail("OUT_OF_BOUNDS");
    if (board[p] !== 0)
        return fail("OCCUPIED");
    if (!geometryPossible(board, p, color, n, table))
        return fail("SUICIDE");
    const next = board.slice(), own = cellOf(color), captured = new Set();
    next[p] = own;
    for (const q of neighborsFor(n)[p]) {
        const g = table.at[q];
        if (g && g.color === -own && g.liberties.size === 1 && g.liberties.has(p))
            for (const stone of g.stones)
                captured.add(stone);
    }
    for (const q of captured)
        next[q] = 0;
    return ok({ board: next, captured: [...captured].sort((a, b) => a - b) });
}
export const positionKey = (board) => board.map(c => c === -1 ? "2" : String(c)).join("");
export function parsePoint(text, n) {
    if (typeof text !== "string" || !/^[A-S][1-9][0-9]?$/.test(text))
        return fail("OUT_OF_BOUNDS");
    const x = text.charCodeAt(0) - 65, y = Number(text.slice(1)) - 1, p = y * n + x;
    return x < n && y < n && validPoint(p, n) ? ok(p) : fail("OUT_OF_BOUNDS");
}
export function formatPoint(p, n) { return String.fromCharCode(65 + p % n) + (Math.floor(p / n) + 1); }
//# sourceMappingURL=geometry.js.map