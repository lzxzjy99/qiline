import { applyAction } from "../../core/src/engine.js";
import { freeze } from "../../core/src/result.js";
import { AI_PROTOCOL_VERSION, aiOK } from "./protocol.js";
import { getNnueWeights, NNUE_BLEND_ALPHA, NNUE_CLAIM_BLEND_ALPHA, NNUE_H1, NNUE_H2, NNUE_IN_DENSE, NNUE_SCORE_SCALE, } from "./v21-nnue-weights.js";
const MASK27 = 0x7ffffff; // 27 bits = 3 rows of 9
const NOT_LEFT_27 = 0b111111110_111111110_111111110;
const NOT_RIGHT_27 = 0b011111111_011111111_011111111;
function popcnt27(x) {
    x = x - ((x >>> 1) & 0x55555555);
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    return (Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24) & 31;
}
function ctz27(x) {
    return 31 - Math.clz32(x & -x);
}
function imix32(x) {
    x ^= x >>> 16;
    x = Math.imul(x, 0x7feb352d);
    x ^= x >>> 15;
    x = Math.imul(x, 0x846ca68b);
    return (x ^ (x >>> 16)) | 0;
}
// Precomputed 9x9 geometry & 50 diagonal 5-windows (matching Rules.cs bit-for-bit)
const ADJ = [];
const ADJ_M0 = new Int32Array(81);
const ADJ_M1 = new Int32Array(81);
const ADJ_M2 = new Int32Array(81);
const PT_WORD = new Int32Array(81);
const PT_BIT = new Int32Array(81);
const ZOB_LO = new Int32Array(162);
const ZOB_HI = new Int32Array(162);
const WIN_PTS = [];
const PT_WINS = Array.from({ length: 81 }, () => []);
const WIN_M0 = new Int32Array(50);
const WIN_M1 = new Int32Array(50);
const WIN_M2 = new Int32Array(50);
const EMPTY_BIRTH = new Int16Array(50).fill(-1);
(function initGeometry() {
    for (let p = 0; p < 81; p++) {
        PT_WORD[p] = (p / 27) | 0;
        PT_BIT[p] = 1 << (p % 27);
    }
    for (let p = 0; p < 81; p++) {
        const a = [];
        if (p % 9 > 0)
            a.push(p - 1);
        if (p % 9 < 8)
            a.push(p + 1);
        if (p >= 9)
            a.push(p - 9);
        if (p < 72)
            a.push(p + 9);
        ADJ.push(a);
        let am0 = 0, am1 = 0, am2 = 0;
        for (let i = 0; i < a.length; i++) {
            const q = a[i];
            const wd = PT_WORD[q], bt = PT_BIT[q];
            if (wd === 0)
                am0 |= bt;
            else if (wd === 1)
                am1 |= bt;
            else
                am2 |= bt;
        }
        ADJ_M0[p] = am0;
        ADJ_M1[p] = am1;
        ADJ_M2[p] = am2;
        ZOB_LO[p * 2] = imix32(p * 4 + 1);
        ZOB_HI[p * 2] = imix32(p * 4 + 2 ^ 0x9e3779b9);
        ZOB_LO[p * 2 + 1] = imix32(p * 4 + 3);
        ZOB_HI[p * 2 + 1] = imix32(p * 4 + 4 ^ 0x9e3779b9);
    }
    let at = 0;
    for (let d = 0; d < 2; d++) {
        for (let y = 0; y < 5; y++) {
            const xs = d === 0 ? 0 : 4;
            const xe = d === 0 ? 5 : 9;
            for (let x = xs; x < xe; x++) {
                const w = [];
                let m0 = 0, m1 = 0, m2 = 0;
                const step = d === 0 ? 1 : -1;
                for (let k = 0; k < 5; k++) {
                    const p = (y + k) * 9 + x + k * step;
                    w.push(p);
                    PT_WINS[p].push(at);
                    const wd = PT_WORD[p], bt = PT_BIT[p];
                    if (wd === 0)
                        m0 |= bt;
                    else if (wd === 1)
                        m1 |= bt;
                    else
                        m2 |= bt;
                }
                WIN_PTS.push(w);
                WIN_M0[at] = m0;
                WIN_M1[at] = m1;
                WIN_M2[at] = m2;
                at++;
            }
        }
    }
})();
function emptyState(swap3) {
    return {
        b0: 0, b1: 0, b2: 0, w0: 0, w1: 0, w2: 0,
        phase: swap3 ? 0 : 2,
        opened: 0,
        side: 1,
        ownerBlack: swap3 ? -1 : 0,
        ply: 0,
        passes: 0,
        capB: 0,
        capW: 0,
        outcome: 0,
        winnerColor: 0,
        lastPoint: -1,
        claimCount: 0,
        birth: EMPTY_BIRTH,
        history: { b0: 0, b1: 0, b2: 0, w0: 0, w1: 0, w2: 0, hLo: 0, hHi: 0, prev: null },
        hLo: 0,
        hHi: 0,
    };
}
function cloneState(s) {
    let nb;
    if (s.claimCount === 0) {
        nb = EMPTY_BIRTH;
    }
    else {
        nb = new Int16Array(50);
        nb.set(s.birth);
    }
    return {
        b0: s.b0, b1: s.b1, b2: s.b2, w0: s.w0, w1: s.w1, w2: s.w2,
        phase: s.phase, opened: s.opened, side: s.side, ownerBlack: s.ownerBlack,
        ply: s.ply, passes: s.passes, capB: s.capB, capW: s.capW,
        outcome: s.outcome, winnerColor: s.winnerColor, lastPoint: s.lastPoint,
        claimCount: s.claimCount, birth: nb, history: s.history, hLo: s.hLo, hHi: s.hHi,
    };
}
function stateActor(s) {
    return s.phase === 0 ? 0 : s.phase === 1 ? 1 : (s.side === 1 ? s.ownerBlack : 1 - s.ownerBlack);
}
function stateOwner(s, color) {
    return color === 1 ? s.ownerBlack : 1 - s.ownerBlack;
}
function stateTerminalValueA(s) {
    return s.outcome === 2 ? 0 : stateOwner(s, s.winnerColor) === 0 ? 1 : -1;
}
// Reusable scratch for group flood-fill & liberties (single-threaded JS)
let g0 = 0, g1 = 0, g2 = 0;
let lb0 = 0, lb1 = 0, lb2 = 0;
function floodGroup(s0, s1, s2, p) {
    const wd = PT_WORD[p], bt = PT_BIT[p];
    let c0 = wd === 0 ? bt : 0;
    let c1 = wd === 1 ? bt : 0;
    let c2 = wd === 2 ? bt : 0;
    while (true) {
        const n0 = (((c0 & NOT_RIGHT_27) << 1) | ((c0 & NOT_LEFT_27) >>> 1) | ((c0 << 9) & MASK27) | (c0 >>> 9) | ((c1 & 0x1ff) << 18)) & s0;
        const n1 = (((c1 & NOT_RIGHT_27) << 1) | ((c1 & NOT_LEFT_27) >>> 1) | ((c1 << 9) & MASK27) | (c1 >>> 9) | (c0 >>> 18) | ((c2 & 0x1ff) << 18)) & s1;
        const n2 = (((c2 & NOT_RIGHT_27) << 1) | ((c2 & NOT_LEFT_27) >>> 1) | ((c2 << 9) & MASK27) | (c2 >>> 9) | (c1 >>> 18)) & s2;
        const u0 = c0 | n0, u1 = c1 | n1, u2 = c2 | n2;
        if (u0 === c0 && u1 === c1 && u2 === c2)
            break;
        c0 = u0;
        c1 = u1;
        c2 = u2;
    }
    g0 = c0;
    g1 = c1;
    g2 = c2;
}
function groupLiberties(c0, c1, c2, occ0, occ1, occ2) {
    lb0 = ((((c0 & NOT_RIGHT_27) << 1) | ((c0 & NOT_LEFT_27) >>> 1) | ((c0 << 9) & MASK27) | (c0 >>> 9) | ((c1 & 0x1ff) << 18)) & MASK27) & ~occ0;
    lb1 = ((((c1 & NOT_RIGHT_27) << 1) | ((c1 & NOT_LEFT_27) >>> 1) | ((c1 << 9) & MASK27) | (c1 >>> 9) | (c0 >>> 18) | ((c2 & 0x1ff) << 18)) & MASK27) & ~occ1;
    lb2 = ((((c2 & NOT_RIGHT_27) << 1) | ((c2 & NOT_LEFT_27) >>> 1) | ((c2 << 9) & MASK27) | (c2 >>> 9) | (c1 >>> 18)) & MASK27) & ~occ2;
}
function hasPt(w0, w1, w2, p) {
    const wd = PT_WORD[p], bt = PT_BIT[p];
    return ((wd === 0 ? w0 : wd === 1 ? w1 : w2) & bt) !== 0;
}
let tb0 = 0, tb1 = 0, tb2 = 0, tw0 = 0, tw1 = 0, tw2 = 0, tCaps = 0, tHLo = 0, tHHi = 0;
function tryBoard(s, point, color, opening) {
    if (point < 0 || point >= 81)
        return false;
    if (hasPt(s.b0 | s.w0, s.b1 | s.w1, s.b2 | s.w2, point))
        return false;
    let b0 = s.b0, b1 = s.b1, b2 = s.b2;
    let w0 = s.w0, w1 = s.w1, w2 = s.w2;
    let hLo = s.hLo, hHi = s.hHi;
    const wd = PT_WORD[point], bt = PT_BIT[point];
    if (color === 1) {
        if (wd === 0)
            b0 |= bt;
        else if (wd === 1)
            b1 |= bt;
        else
            b2 |= bt;
        hLo ^= ZOB_LO[point * 2];
        hHi ^= ZOB_HI[point * 2];
    }
    else {
        if (wd === 0)
            w0 |= bt;
        else if (wd === 1)
            w1 |= bt;
        else
            w2 |= bt;
        hLo ^= ZOB_LO[point * 2 + 1];
        hHi ^= ZOB_HI[point * 2 + 1];
    }
    let caps = 0;
    const adj = ADJ[point];
    const enOff = color === 1 ? 1 : 0;
    for (let i = 0; i < adj.length; i++) {
        const q = adj[i];
        const en0 = color === 1 ? w0 : b0, en1 = color === 1 ? w1 : b1, en2 = color === 1 ? w2 : b2;
        if (!hasPt(en0, en1, en2, q))
            continue;
        floodGroup(en0, en1, en2, q);
        groupLiberties(g0, g1, g2, b0 | w0, b1 | w1, b2 | w2);
        if ((lb0 | lb1 | lb2) === 0) {
            if (opening)
                return false;
            caps += popcnt27(g0) + popcnt27(g1) + popcnt27(g2);
            if (color === 1) {
                w0 &= ~g0;
                w1 &= ~g1;
                w2 &= ~g2;
            }
            else {
                b0 &= ~g0;
                b1 &= ~g1;
                b2 &= ~g2;
            }
            let x = g0;
            while (x) {
                const p = ctz27(x);
                x &= x - 1;
                hLo ^= ZOB_LO[p * 2 + enOff];
                hHi ^= ZOB_HI[p * 2 + enOff];
            }
            x = g1;
            while (x) {
                const p = 27 + ctz27(x);
                x &= x - 1;
                hLo ^= ZOB_LO[p * 2 + enOff];
                hHi ^= ZOB_HI[p * 2 + enOff];
            }
            x = g2;
            while (x) {
                const p = 54 + ctz27(x);
                x &= x - 1;
                hLo ^= ZOB_LO[p * 2 + enOff];
                hHi ^= ZOB_HI[p * 2 + enOff];
            }
        }
    }
    if (color === 1)
        floodGroup(b0, b1, b2, point);
    else
        floodGroup(w0, w1, w2, point);
    groupLiberties(g0, g1, g2, b0 | w0, b1 | w1, b2 | w2);
    if ((lb0 | lb1 | lb2) === 0)
        return false;
    for (let h = s.history; h !== null; h = h.prev) {
        if (h.hLo === hLo && h.hHi === hHi && h.b0 === b0 && h.b1 === b1 && h.b2 === b2 && h.w0 === w0 && h.w1 === w1 && h.w2 === w2)
            return false;
    }
    tb0 = b0;
    tb1 = b1;
    tb2 = b2;
    tw0 = w0;
    tw1 = w1;
    tw2 = w2;
    tCaps = caps;
    tHLo = hLo;
    tHHi = hHi;
    return true;
}
function canPlace(s, point) {
    if (point < 0 || point >= 81)
        return false;
    const occ0 = s.b0 | s.w0, occ1 = s.b1 | s.w1, occ2 = s.b2 | s.w2;
    if (hasPt(occ0, occ1, occ2, point))
        return false;
    const color = s.phase === 0 ? (s.opened === 1 ? -1 : 1) : s.side;
    const am0 = ADJ_M0[point], am1 = ADJ_M1[point], am2 = ADJ_M2[point];
    // Fast path: if at least one orthogonal neighbor is empty and NO adjacent enemy stone exists,
    // placing cannot capture and cannot suicide.
    const hasEmptyAdj = ((am0 & ~occ0) | (am1 & ~occ1) | (am2 & ~occ2)) !== 0;
    if (hasEmptyAdj) {
        const en0 = color === 1 ? s.w0 : s.b0, en1 = color === 1 ? s.w1 : s.b1, en2 = color === 1 ? s.w2 : s.b2;
        if (((am0 & en0) | (am1 & en1) | (am2 & en2)) === 0) {
            if (s.capB === 0 && s.capW === 0)
                return true;
            const wd = PT_WORD[point], bt = PT_BIT[point];
            let b0 = s.b0, b1 = s.b1, b2 = s.b2, w0 = s.w0, w1 = s.w1, w2 = s.w2;
            let hLo = s.hLo, hHi = s.hHi;
            if (color === 1) {
                if (wd === 0)
                    b0 |= bt;
                else if (wd === 1)
                    b1 |= bt;
                else
                    b2 |= bt;
                hLo ^= ZOB_LO[point * 2];
                hHi ^= ZOB_HI[point * 2];
            }
            else {
                if (wd === 0)
                    w0 |= bt;
                else if (wd === 1)
                    w1 |= bt;
                else
                    w2 |= bt;
                hLo ^= ZOB_LO[point * 2 + 1];
                hHi ^= ZOB_HI[point * 2 + 1];
            }
            for (let h = s.history; h !== null; h = h.prev) {
                if (h.hLo === hLo && h.hHi === hHi && h.b0 === b0 && h.b1 === b1 && h.b2 === b2 && h.w0 === w0 && h.w1 === w1 && h.w2 === w2)
                    return false;
            }
            return true;
        }
    }
    return tryBoard(s, point, color, s.phase === 0);
}
function legalCodes(s) {
    if (s.phase === 3)
        return [];
    if (s.phase === 1)
        return [82, 83];
    const out = [];
    for (let p = 0; p < 81; p++)
        if (canPlace(s, p))
            out.push(p);
    if (s.phase === 2)
        out.push(81);
    return out;
}
function hasPlacement(s) {
    for (let p = 0; p < 81; p++)
        if (canPlace(s, p))
            return true;
    return false;
}
function windowColor(s, i) {
    const m0 = WIN_M0[i], m1 = WIN_M1[i], m2 = WIN_M2[i];
    if ((s.b0 & m0) === m0 && (s.b1 & m1) === m1 && (s.b2 & m2) === m2)
        return 1;
    if ((s.w0 & m0) === m0 && (s.w1 & m1) === m1 && (s.w2 & m2) === m2)
        return -1;
    return 0;
}
function settleState(s, placedPoint) {
    if (s.claimCount === 0 && placedPoint >= 0) {
        const wins = PT_WINS[placedPoint];
        let born = 0;
        for (let k = 0; k < wins.length; k++) {
            const i = wins[k];
            if (windowColor(s, i) !== 0) {
                if (born === 0) {
                    const nb = new Int16Array(50);
                    nb.fill(-1);
                    s.birth = nb;
                }
                s.birth[i] = s.ply;
                born++;
            }
        }
        s.claimCount = born;
        return;
    }
    if (s.claimCount === 0) {
        if (s.passes >= 2) {
            s.phase = 3;
            s.outcome = 2;
        }
        return;
    }
    let earliest = 1e9, winner = 0, active = 0;
    for (let i = 0; i < 50; i++) {
        const c = windowColor(s, i);
        if (c === 0) {
            if (s.birth[i] >= 0)
                s.birth[i] = -1;
        }
        else {
            if (s.birth[i] < 0)
                s.birth[i] = s.ply;
            active++;
            if (s.ply >= s.birth[i] + 4 && s.birth[i] < earliest) {
                earliest = s.birth[i];
                winner = c;
            }
        }
    }
    s.claimCount = active;
    if (active === 0)
        s.birth = EMPTY_BIRTH;
    if (winner !== 0) {
        s.phase = 3;
        s.outcome = 1;
        s.winnerColor = winner;
        return;
    }
    if (s.passes >= 2 && active === 0) {
        s.phase = 3;
        s.outcome = 2;
    }
}
function applyPass(s) {
    s.ply++;
    s.passes = s.passes < 2 ? s.passes + 1 : 2;
    settleState(s, -1);
    if (s.phase !== 3)
        s.side = -s.side;
}
function applyCode(source, code) {
    const s = cloneState(source);
    s.lastPoint = -1;
    if (s.phase === 1) {
        s.ownerBlack = code === 82 ? 1 : 0;
        s.phase = 2;
        s.side = -1;
    }
    else if (code === 81 && s.phase === 2) {
        applyPass(s);
    }
    else {
        const color = s.phase === 0 ? (s.opened === 1 ? -1 : 1) : s.side;
        if (!tryBoard(s, code, color, s.phase === 0))
            throw Error("ILLEGAL_PLACEMENT");
        s.b0 = tb0;
        s.b1 = tb1;
        s.b2 = tb2;
        s.w0 = tw0;
        s.w1 = tw1;
        s.w2 = tw2;
        s.hLo = tHLo;
        s.hHi = tHHi;
        s.history = { b0: tb0, b1: tb1, b2: tb2, w0: tw0, w1: tw1, w2: tw2, hLo: tHLo, hHi: tHHi, prev: s.history };
        s.lastPoint = code;
        if (color === 1)
            s.capB += tCaps;
        else
            s.capW += tCaps;
        s.ply++;
        s.passes = 0;
        if (s.phase === 0) {
            s.opened++;
            if (s.opened === 3)
                s.phase = 1;
            return s;
        }
        settleState(s, code);
        if (s.phase !== 3)
            s.side = -s.side;
    }
    let count = 0;
    while (s.phase === 2 && !hasPlacement(s)) {
        applyPass(s);
        if (++count > 6)
            throw Error("Forced-pass normalization exceeded bound");
    }
    return s;
}
function provenWin(s, color) {
    if (s.phase === 3)
        return s.outcome === 1 && s.winnerColor === color;
    if (s.claimCount === 0)
        return false;
    const occ0 = s.b0 | s.w0, occ1 = s.b1 | s.w1, occ2 = s.b2 | s.w2;
    const o0 = color === 1 ? s.b0 : s.w0, o1 = color === 1 ? s.b1 : s.w1, o2 = color === 1 ? s.b2 : s.w2;
    for (let i = 0; i < 50; i++) {
        if (s.birth[i] < 0 || windowColor(s, i) !== color)
            continue;
        const due = s.birth[i] + 4;
        if (due <= s.ply)
            continue;
        let earlier = false;
        for (let j = 0; j < 50; j++) {
            if (s.birth[j] >= 0 && windowColor(s, j) === -color && s.birth[j] + 4 <= due) {
                earlier = true;
                break;
            }
        }
        if (earlier)
            continue;
        const turns = ((due - s.ply) + (s.side !== color ? 1 : 0)) >> 1;
        let secure = true;
        const pts = WIN_PTS[i];
        for (let k = 0; k < 5; k++) {
            floodGroup(o0, o1, o2, pts[k]);
            groupLiberties(g0, g1, g2, occ0, occ1, occ2);
            if (popcnt27(lb0) + popcnt27(lb1) + popcnt27(lb2) <= turns) {
                secure = false;
                break;
            }
        }
        if (secure)
            return true;
    }
    return false;
}
// ============================================================
// View & NNUE Evaluation (matches v21 Hybrid.cs + Nnue.cs)
// ============================================================
const THREAT = [0, 2, 18, 150, 1800, 6000];
const WEIGHTS = [0, 2, 14, 90, 600, 2400];
const MOVE_W = [0, 2, 18, 180, 2200, 16000];
// Scratch buffers for View construction (zero GC in inner loops)
const vGL0 = new Int32Array(81);
const vGL1 = new Int32Array(81);
const vGL2 = new Int32Array(81);
const vPLCache = new Uint8Array(162);
const vTwoG0_0 = new Int32Array(24), vTwoG0_1 = new Int32Array(24), vTwoG0_2 = new Int32Array(24);
const vTwoL0_0 = new Int32Array(24), vTwoL0_1 = new Int32Array(24), vTwoL0_2 = new Int32Array(24);
const vTwoG1_0 = new Int32Array(24), vTwoG1_1 = new Int32Array(24), vTwoG1_2 = new Int32Array(24);
const vTwoL1_0 = new Int32Array(24), vTwoL1_1 = new Int32Array(24), vTwoL1_2 = new Int32Array(24);
const vFollow0 = new Int32Array(81), vFollow1 = new Int32Array(81), vFollow2 = new Int32Array(81);
const vTwoDir = new Uint8Array(81);
function computePlaceLibs(occ0, occ1, occ2, o0, o1, o2, e0, e1, e2, libs, p) {
    let n0 = 0, n1 = 0, n2 = 0;
    const adj = ADJ[p];
    for (let i = 0; i < adj.length; i++) {
        const q = adj[i];
        if (!hasPt(occ0, occ1, occ2, q)) {
            const wd = PT_WORD[q], bt = PT_BIT[q];
            if (wd === 0)
                n0 |= bt;
            else if (wd === 1)
                n1 |= bt;
            else
                n2 |= bt;
        }
        else if (hasPt(o0, o1, o2, q)) {
            n0 |= vGL0[q];
            n1 |= vGL1[q];
            n2 |= vGL2[q];
        }
        else if (hasPt(e0, e1, e2, q) && libs[q] === 1) {
            return 4;
        }
    }
    const wd = PT_WORD[p], bt = PT_BIT[p];
    if (wd === 0)
        n0 &= ~bt;
    else if (wd === 1)
        n1 &= ~bt;
    else
        n2 &= ~bt;
    return popcnt27(n0) + popcnt27(n1) + popcnt27(n2);
}
function getPL(occ0, occ1, occ2, s, libs, col, pt) {
    const key = col * 81 + pt;
    const cached = vPLCache[key];
    if (cached !== 0)
        return cached - 1;
    const val = col === 0
        ? computePlaceLibs(occ0, occ1, occ2, s.b0, s.b1, s.b2, s.w0, s.w1, s.w2, libs, pt)
        : computePlaceLibs(occ0, occ1, occ2, s.w0, s.w1, s.w2, s.b0, s.b1, s.b2, libs, pt);
    vPLCache[key] = val + 1;
    return val;
}
const leafLibs = new Uint8Array(81);
function buildView(s, leafOnly) {
    let libs;
    if (leafOnly) {
        leafLibs.fill(0);
        libs = leafLibs;
    }
    else {
        libs = new Uint8Array(81);
    }
    const moves0 = leafOnly ? null : new Float64Array(81);
    const moves1 = leafOnly ? null : new Float64Array(81);
    const critical = leafOnly ? null : new Uint8Array(81);
    const forcing = leafOnly ? null : new Uint8Array(81);
    const priority = leafOnly ? null : new Float64Array(81);
    const mark = (p, val) => {
        critical[p] = 1;
        if (val > priority[p])
            priority[p] = val;
    };
    let live0_0 = 0, live0_1 = 0, live0_2 = 0, live1_0 = 0, live1_1 = 0, live1_2 = 0;
    let rel0_0 = 0, rel0_1 = 0, rel0_2 = 0, rel1_0 = 0, rel1_1 = 0, rel1_2 = 0;
    let sb0_0 = 0, sb0_1 = 0, sb0_2 = 0, sb1_0 = 0, sb1_1 = 0, sb1_2 = 0;
    let at0_0 = 0, at0_1 = 0, at0_2 = 0, at1_0 = 0, at1_1 = 0, at1_2 = 0;
    let exp0 = false, exp1 = false;
    const hasClaims = s.claimCount > 0;
    for (let w = 0; w < 50; w++) {
        const m0 = WIN_M0[w], m1 = WIN_M1[w], m2 = WIN_M2[w];
        if (hasClaims && s.birth[w] >= 0) {
            const col = windowColor(s, w);
            if (col === 1) {
                live0_0 |= m0;
                live0_1 |= m1;
                live0_2 |= m2;
                if (s.birth[w] + 4 <= s.ply + 1)
                    exp0 = true;
            }
            else if (col === -1) {
                live1_0 |= m0;
                live1_1 |= m1;
                live1_2 |= m2;
                if (s.birth[w] + 4 <= s.ply + 1)
                    exp1 = true;
            }
        }
        const bm0 = s.b0 & m0, bm1 = s.b1 & m1, bm2 = s.b2 & m2;
        const wm0 = s.w0 & m0, wm1 = s.w1 & m1, wm2 = s.w2 & m2;
        const bc = popcnt27(bm0) + popcnt27(bm1) + popcnt27(bm2);
        const wc = popcnt27(wm0) + popcnt27(wm1) + popcnt27(wm2);
        if (wc === 0 && bc >= 1) {
            rel0_0 |= bm0;
            rel0_1 |= bm1;
            rel0_2 |= bm2;
        }
        else if (bc === 1 && wc >= 2) {
            rel0_0 |= bm0;
            rel0_1 |= bm1;
            rel0_2 |= bm2;
            sb0_0 |= bm0;
            sb0_1 |= bm1;
            sb0_2 |= bm2;
        }
        else if (bc === 2 && wc >= 3) {
            sb0_0 |= bm0;
            sb0_1 |= bm1;
            sb0_2 |= bm2;
        }
        if (bc === 0 && wc >= 1) {
            rel1_0 |= wm0;
            rel1_1 |= wm1;
            rel1_2 |= wm2;
        }
        else if (wc === 1 && bc >= 2) {
            rel1_0 |= wm0;
            rel1_1 |= wm1;
            rel1_2 |= wm2;
            sb1_0 |= wm0;
            sb1_1 |= wm1;
            sb1_2 |= wm2;
        }
        else if (wc === 2 && bc >= 3) {
            sb1_0 |= wm0;
            sb1_1 |= wm1;
            sb1_2 |= wm2;
        }
    }
    rel0_0 |= live0_0;
    rel0_1 |= live0_1;
    rel0_2 |= live0_2;
    rel1_0 |= live1_0;
    rel1_1 |= live1_1;
    rel1_2 |= live1_2;
    const occ0 = s.b0 | s.w0, occ1 = s.b1 | s.w1, occ2 = s.b2 | s.w2;
    let safety0 = 0, safety1 = 0, oldSafety0 = 0, oldSafety1 = 0;
    let twoN0 = 0, twoN1 = 0;
    for (let c = 0; c < 2; c++) {
        const o0 = c === 0 ? s.b0 : s.w0, o1 = c === 0 ? s.b1 : s.w1, o2 = c === 0 ? s.b2 : s.w2;
        const rM0 = c === 0 ? rel0_0 : rel1_0, rM1 = c === 0 ? rel0_1 : rel1_1, rM2 = c === 0 ? rel0_2 : rel1_2;
        const lM0 = c === 0 ? live0_0 : live1_0, lM1 = c === 0 ? live0_1 : live1_1, lM2 = c === 0 ? live0_2 : live1_2;
        let rem0 = o0, rem1 = o1, rem2 = o2;
        while ((rem0 | rem1 | rem2) !== 0) {
            const fp = rem0 !== 0 ? ctz27(rem0) : rem1 !== 0 ? 27 + ctz27(rem1) : 54 + ctz27(rem2);
            floodGroup(o0, o1, o2, fp);
            groupLiberties(g0, g1, g2, occ0, occ1, occ2);
            const n = popcnt27(lb0) + popcnt27(lb1) + popcnt27(lb2);
            const k = popcnt27(g0) + popcnt27(g1) + popcnt27(g2);
            const rel = k > 1 || ((g0 & rM0) | (g1 & rM1) | (g2 & rM2)) !== 0;
            const ds = n === 1 ? (rel ? -350 * k : -35 * k) : n === 2 ? -35 * k : Math.min(6, n) * 3;
            const dos = n === 1 ? -120 * k : Math.min(4, n) * 2;
            if (c === 0) {
                safety0 += ds;
                oldSafety0 += dos;
            }
            else {
                safety1 += ds;
                oldSafety1 += dos;
            }
            let x = g0;
            while (x) {
                const p = ctz27(x);
                x &= x - 1;
                libs[p] = n;
                vGL0[p] = lb0;
                vGL1[p] = lb1;
                vGL2[p] = lb2;
            }
            x = g1;
            while (x) {
                const p = 27 + ctz27(x);
                x &= x - 1;
                libs[p] = n;
                vGL0[p] = lb0;
                vGL1[p] = lb1;
                vGL2[p] = lb2;
            }
            x = g2;
            while (x) {
                const p = 54 + ctz27(x);
                x &= x - 1;
                libs[p] = n;
                vGL0[p] = lb0;
                vGL1[p] = lb1;
                vGL2[p] = lb2;
            }
            if (n === 1) {
                if (c === 0) {
                    at0_0 |= g0;
                    at0_1 |= g1;
                    at0_2 |= g2;
                }
                else {
                    at1_0 |= g0;
                    at1_1 |= g1;
                    at1_2 |= g2;
                }
                if (!leafOnly) {
                    const lp = lb0 !== 0 ? ctz27(lb0) : lb1 !== 0 ? 27 + ctz27(lb1) : 54 + ctz27(lb2);
                    if (rel) {
                        const inLive = ((g0 & lM0) | (g1 & lM1) | (g2 & lM2)) !== 0;
                        mark(lp, s.side === (c === 0 ? 1 : -1) ? 300000 + k * 1000 : (inLive ? 3000000 : 200000) + k * 20000);
                        forcing[lp] = 1;
                    }
                    else {
                        const tm = c === 0 ? moves0 : moves1;
                        tm[lp] = tm[lp] + 200;
                    }
                }
            }
            else if (n === 2) {
                if (c === 0 && twoN0 < 24) {
                    vTwoG0_0[twoN0] = g0;
                    vTwoG0_1[twoN0] = g1;
                    vTwoG0_2[twoN0] = g2;
                    vTwoL0_0[twoN0] = lb0;
                    vTwoL0_1[twoN0] = lb1;
                    vTwoL0_2[twoN0] = lb2;
                    twoN0++;
                }
                else if (c === 1 && twoN1 < 24) {
                    vTwoG1_0[twoN1] = g0;
                    vTwoG1_1[twoN1] = g1;
                    vTwoG1_2[twoN1] = g2;
                    vTwoL1_0[twoN1] = lb0;
                    vTwoL1_1[twoN1] = lb1;
                    vTwoL1_2[twoN1] = lb2;
                    twoN1++;
                }
            }
            rem0 &= ~g0;
            rem1 &= ~g1;
            rem2 &= ~g2;
        }
    }
    vPLCache.fill(0);
    for (let c = 0; c < 2; c++) {
        const cnt = c === 0 ? twoN0 : twoN1;
        const gs0 = c === 0 ? vTwoG0_0 : vTwoG1_0, gs1 = c === 0 ? vTwoG0_1 : vTwoG1_1, gs2 = c === 0 ? vTwoG0_2 : vTwoG1_2;
        const ls0 = c === 0 ? vTwoL0_0 : vTwoL1_0, ls1 = c === 0 ? vTwoL0_1 : vTwoL1_1, ls2 = c === 0 ? vTwoL0_2 : vTwoL1_2;
        const sM0 = c === 0 ? sb0_0 : sb1_0, sM1 = c === 0 ? sb0_1 : sb1_1, sM2 = c === 0 ? sb0_2 : sb1_2;
        const rM0 = c === 0 ? rel0_0 : rel1_0, rM1 = c === 0 ? rel0_1 : rel1_1, rM2 = c === 0 ? rel0_2 : rel1_2;
        const ownM = c === 0 ? moves0 : moves1, enM = c === 0 ? moves1 : moves0;
        for (let idx = 0; idx < cnt; idx++) {
            const a0 = gs0[idx], a1 = gs1[idx], a2 = gs2[idx];
            let t0 = ls0[idx], t1 = ls1[idx], t2 = ls2[idx];
            const k = popcnt27(a0) + popcnt27(a1) + popcnt27(a2);
            const blocks = ((a0 & sM0) | (a1 & sM1) | (a2 & sM2)) !== 0;
            if (!(k >= 2 || blocks || ((a0 & rM0) | (a1 & rM1) | (a2 & rM2)) !== 0))
                continue;
            let l1;
            if (t0 !== 0) {
                l1 = ctz27(t0);
                t0 &= t0 - 1;
            }
            else if (t1 !== 0) {
                l1 = 27 + ctz27(t1);
                t1 &= t1 - 1;
            }
            else {
                l1 = 54 + ctz27(t2);
                t2 &= t2 - 1;
            }
            const l2 = t0 !== 0 ? ctz27(t0) : t1 !== 0 ? 27 + ctz27(t1) : 54 + ctz27(t2);
            const p1 = getPL(occ0, occ1, occ2, s, libs, c, l1);
            const p2 = getPL(occ0, occ1, occ2, s, libs, c, l2);
            if (p1 <= 2 && p2 <= 2) {
                if (c === 0)
                    safety0 -= 85 * k;
                else
                    safety1 -= 85 * k;
                if (!leafOnly) {
                    if (blocks || k >= 2) {
                        const pri = 85000 + k * 5000;
                        mark(l1, pri);
                        mark(l2, pri);
                    }
                    ownM[l1] = ownM[l1] + 500 * k;
                    ownM[l2] = ownM[l2] + 500 * k;
                    enM[l1] = enM[l1] + 700 * k;
                    enM[l2] = enM[l2] + 700 * k;
                }
            }
            else if (p1 <= 2 || p2 <= 2) {
                const vital = p1 <= 2 ? l2 : l1, other = p1 <= 2 ? l1 : l2;
                if (c === 0)
                    safety0 -= 45 * k;
                else
                    safety1 -= 45 * k;
                if (!leafOnly) {
                    if (blocks || k >= 2) {
                        const vpri = (s.side === (c === 0 ? 1 : -1) ? 110000 : 120000) + k * 5000;
                        mark(vital, vpri);
                    }
                    ownM[vital] = ownM[vital] + 900 * k;
                    enM[vital] = enM[vital] + 1000 * k;
                    ownM[other] = ownM[other] + 450 * k;
                    enM[other] = enM[other] + 550 * k;
                }
            }
            else if (!leafOnly && (k >= 2 || blocks)) {
                ownM[l1] = ownM[l1] + 500 * k;
                ownM[l2] = ownM[l2] + 500 * k;
                enM[l1] = enM[l1] + 600 * k;
                enM[l2] = enM[l2] + 600 * k;
            }
        }
    }
    let pressure0 = 0, pressure1 = 0, potential0 = 0, potential1 = 0;
    let claims0 = 0, claims1 = 0;
    let claimMinRem0 = 100, claimMinRem1 = 100, claimMinLib0 = 100, claimMinLib1 = 100;
    let comp0 = 0, comp1 = 0, hComp0 = 0, hComp1 = 0;
    let d2_0 = 0, d2_1 = 0, pk0 = 0, pk1 = 0;
    let cm0_0 = 0, cm0_1 = 0, cm0_2 = 0, cm1_0 = 0, cm1_1 = 0, cm1_2 = 0;
    let unsettled = false;
    for (let c = 0; c < 2; c++) {
        const o0 = c === 0 ? s.b0 : s.w0, o1 = c === 0 ? s.b1 : s.w1, o2 = c === 0 ? s.b2 : s.w2;
        const e0 = c === 0 ? s.w0 : s.b0, e1 = c === 0 ? s.w1 : s.b1, e2 = c === 0 ? s.w2 : s.b2;
        const ea0 = c === 0 ? at1_0 : at0_0, ea1 = c === 0 ? at1_1 : at0_1, ea2 = c === 0 ? at1_2 : at0_2;
        const ownM = c === 0 ? moves0 : moves1, enM = c === 0 ? moves1 : moves0;
        const isTurn = s.side === (c === 0 ? 1 : -1);
        vFollow0.fill(0);
        vFollow1.fill(0);
        vFollow2.fill(0);
        vTwoDir.fill(0);
        let cp0 = 0, cp1 = 0, cp2 = 0, hc0 = 0, hc1 = 0, hc2 = 0;
        let press = 0, pot = 0, clm = 0, d2 = 0, pkt = 0;
        let cMinRem = 100, cMinLib = 100;
        for (let w = 0; w < 50; w++) {
            const m0 = WIN_M0[w], m1 = WIN_M1[w], m2 = WIN_M2[w];
            const bl0 = e0 & m0, bl1 = e1 & m1, bl2 = e2 & m2;
            const st0 = o0 & m0, st1 = o1 & m1, st2 = o2 & m2;
            const count = popcnt27(st0) + popcnt27(st1) + popcnt27(st2);
            const pts = WIN_PTS[w];
            if ((bl0 | bl1 | bl2) !== 0) {
                if (count >= 2 && (bl0 & ea0) === bl0 && (bl1 & ea1) === bl1 && (bl2 & ea2) === bl2) {
                    let minB = 100;
                    for (let k = 0; k < 5; k++)
                        if (hasPt(st0, st1, st2, pts[k])) {
                            const l = libs[pts[k]];
                            if (l < minB)
                                minB = l;
                        }
                    if (minB > 1) {
                        const safeB = minB === 2 ? 0.65 : 1;
                        press += 0.55 * THREAT[count] * safeB;
                        if (!leafOnly) {
                            for (let k = 0; k < 5; k++) {
                                const bp = pts[k];
                                if (!hasPt(bl0, bl1, bl2, bp))
                                    continue;
                                const gl0 = vGL0[bp], gl1 = vGL1[bp], gl2 = vGL2[bp];
                                const lp = gl0 !== 0 ? ctz27(gl0) : gl1 !== 0 ? 27 + ctz27(gl1) : 54 + ctz27(gl2);
                                ownM[lp] = ownM[lp] + MOVE_W[count + 1] * safeB;
                                if (count >= 3) {
                                    mark(lp, isTurn ? 250000 : 220000);
                                    forcing[lp] = 1;
                                }
                            }
                        }
                    }
                }
                continue;
            }
            let minL = 100;
            for (let k = 0; k < 5; k++)
                if (hasPt(st0, st1, st2, pts[k])) {
                    const l = libs[pts[k]];
                    if (l < minL)
                        minL = l;
                }
            const safe = minL === 1 ? 0.08 : minL === 2 ? 0.65 : 1;
            const em0 = m0 & ~o0, em1 = m1 & ~o1, em2 = m2 & ~o2;
            pot += WEIGHTS[count];
            press += THREAT[count] * safe;
            if (count === 2 && minL >= 2) {
                const dirBit = w < 25 ? 1 : 2;
                for (let k = 0; k < 5; k++)
                    if (hasPt(em0, em1, em2, pts[k]))
                        vTwoDir[pts[k]] = vTwoDir[pts[k]] | dirBit;
            }
            if (count === 4) {
                cp0 |= em0;
                cp1 |= em1;
                cp2 |= em2;
                const ep = em0 !== 0 ? ctz27(em0) : em1 !== 0 ? 27 + ctz27(em1) : 54 + ctz27(em2);
                if (minL >= 2 && getPL(occ0, occ1, occ2, s, libs, c, ep) >= 2) {
                    hc0 |= em0;
                    hc1 |= em1;
                    hc2 |= em2;
                }
                if (!leafOnly)
                    forcing[ep] = 1;
            }
            let pkM0 = 0, pkM1 = 0, pkM2 = 0;
            for (let k = 0; k < 5; k++) {
                const p = pts[k];
                if (!hasPt(em0, em1, em2, p))
                    continue;
                if (!leafOnly) {
                    ownM[p] = ownM[p] + MOVE_W[count + 1] * safe;
                    if (count === 4)
                        mark(p, isTurn ? 1000000 : 800000);
                    if (count === 3 && minL > 1) {
                        mark(p, isTurn ? 20000 : 18000);
                        if (getPL(occ0, occ1, occ2, s, libs, 1 - c, p) === 2) {
                            const adj = ADJ[p];
                            for (let j = 0; j < adj.length; j++) {
                                const q = adj[j];
                                if (!hasPt(occ0, occ1, occ2, q) && getPL(occ0, occ1, occ2, s, libs, c, q) >= 2) {
                                    ownM[q] = ownM[q] + 800 * safe;
                                    enM[q] = enM[q] + 600 * safe;
                                }
                            }
                        }
                    }
                }
                if (count === 3 && minL > 1) {
                    const wd = PT_WORD[p], bt = PT_BIT[p];
                    vFollow0[p] = vFollow0[p] | (wd === 0 ? (em0 & ~bt) : em0);
                    vFollow1[p] = vFollow1[p] | (wd === 1 ? (em1 & ~bt) : em1);
                    vFollow2[p] = vFollow2[p] | (wd === 2 ? (em2 & ~bt) : em2);
                }
                if (count >= 1 && count < 4 && minL > 1 && getPL(occ0, occ1, occ2, s, libs, c, p) >= 2 && getPL(occ0, occ1, occ2, s, libs, 1 - c, p) <= 1) {
                    const wd = PT_WORD[p], bt = PT_BIT[p];
                    if (wd === 0)
                        pkM0 |= bt;
                    else if (wd === 1)
                        pkM1 |= bt;
                    else
                        pkM2 |= bt;
                }
            }
            if (count >= 1 && count < 4 && minL > 1 && (pkM0 | pkM1 | pkM2) !== 0) {
                const bk0 = em0 & ~pkM0, bk1 = em1 & ~pkM1, bk2 = em2 & ~pkM2;
                const bcount = popcnt27(bk0) + popcnt27(bk1) + popcnt27(bk2);
                if (bcount === 0 && count >= 2) {
                    press += THREAT[4] * safe;
                    pkt += 2;
                    if (!leafOnly) {
                        for (let k = 0; k < 5; k++) {
                            const p = pts[k];
                            if (!hasPt(em0, em1, em2, p))
                                continue;
                            ownM[p] = ownM[p] + MOVE_W[4] * safe;
                            mark(p, isTurn ? 80000 : 70000);
                        }
                    }
                }
                else if (bcount === 1 && count >= 2) {
                    press += 600 * safe;
                    pkt += 1;
                    const q = bk0 !== 0 ? ctz27(bk0) : bk1 !== 0 ? 27 + ctz27(bk1) : 54 + ctz27(bk2);
                    if (!leafOnly) {
                        ownM[q] = ownM[q] + MOVE_W[4] * safe;
                        enM[q] = enM[q] + MOVE_W[4] * safe;
                        if (count >= 3)
                            mark(q, isTurn ? 50000 : 45000);
                    }
                }
                else if (bcount === 2) {
                    if (count < 3)
                        press += THREAT[3] * safe;
                    for (let k = 0; k < 5; k++) {
                        const q = pts[k];
                        if (!hasPt(bk0, bk1, bk2, q))
                            continue;
                        if (!leafOnly && count < 3)
                            ownM[q] = ownM[q] + MOVE_W[4] * safe;
                        const wd = PT_WORD[q], bt = PT_BIT[q];
                        vFollow0[q] = vFollow0[q] | (wd === 0 ? (bk0 & ~bt) : bk0);
                        vFollow1[q] = vFollow1[q] | (wd === 1 ? (bk1 & ~bt) : bk1);
                        vFollow2[q] = vFollow2[q] | (wd === 2 ? (bk2 & ~bt) : bk2);
                    }
                }
            }
            if (count === 5 && s.birth[w] >= 0) {
                const rem = Math.max(1, s.birth[w] + 4 - s.ply);
                if (rem < cMinRem) {
                    cMinRem = rem;
                    cMinLib = minL;
                }
                else if (rem === cMinRem && minL > cMinLib)
                    cMinLib = minL;
                if (s.birth[w] + 4 <= s.ply + 2 || minL <= 2)
                    unsettled = true;
                const secure = minL === 1 ? (isTurn ? 0.6 : 0.15) : minL === 2 ? 0.8 : minL === 3 ? 0.9 : minL === 4 ? 0.96 : 1;
                const cv = 90000 * secure / rem;
                if (cv > clm)
                    clm = cv;
                if (!leafOnly) {
                    const limit = Math.min(6, ((Math.max(1, s.birth[w] + 4 - s.ply) + 1) >> 1) + 1);
                    for (let k = 0; k < 5; k++) {
                        const p = pts[k];
                        const nl = libs[p];
                        if (nl > limit)
                            continue;
                        const pri = nl === 1 ? 4000000 : nl === 2 ? 2200000 : 1600000 - nl * 50000;
                        let x = vGL0[p];
                        while (x) {
                            const q = ctz27(x);
                            x &= x - 1;
                            mark(q, pri);
                            forcing[q] = 1;
                        }
                        x = vGL1[p];
                        while (x) {
                            const q = 27 + ctz27(x);
                            x &= x - 1;
                            mark(q, pri);
                            forcing[q] = 1;
                        }
                        x = vGL2[p];
                        while (x) {
                            const q = 54 + ctz27(x);
                            x &= x - 1;
                            mark(q, pri);
                            forcing[q] = 1;
                        }
                        if (isTurn && nl <= 2) {
                            floodGroup(o0, o1, o2, p);
                            const sur0 = ((((g0 & NOT_RIGHT_27) << 1) | ((g0 & NOT_LEFT_27) >>> 1) | ((g0 << 9) & MASK27) | (g0 >>> 9) | ((g1 & 0x1ff) << 18)) & MASK27) & e0;
                            const sur1 = ((((g1 & NOT_RIGHT_27) << 1) | ((g1 & NOT_LEFT_27) >>> 1) | ((g1 << 9) & MASK27) | (g1 >>> 9) | (g0 >>> 18) | ((g2 & 0x1ff) << 18)) & MASK27) & e1;
                            const sur2 = ((((g2 & NOT_RIGHT_27) << 1) | ((g2 & NOT_LEFT_27) >>> 1) | ((g2 << 9) & MASK27) | (g2 >>> 9) | (g1 >>> 18)) & MASK27) & e2;
                            const markSur = (mask, base) => {
                                let z = mask;
                                while (z) {
                                    const sp = base + ctz27(z);
                                    z &= z - 1;
                                    if (libs[sp] <= 2) {
                                        let y = vGL0[sp];
                                        while (y) {
                                            const q = ctz27(y);
                                            y &= y - 1;
                                            mark(q, pri);
                                            forcing[q] = 1;
                                        }
                                        y = vGL1[sp];
                                        while (y) {
                                            const q = 27 + ctz27(y);
                                            y &= y - 1;
                                            mark(q, pri);
                                            forcing[q] = 1;
                                        }
                                        y = vGL2[sp];
                                        while (y) {
                                            const q = 54 + ctz27(y);
                                            y &= y - 1;
                                            mark(q, pri);
                                            forcing[q] = 1;
                                        }
                                    }
                                }
                            };
                            markSur(sur0, 0);
                            markSur(sur1, 27);
                            markSur(sur2, 54);
                        }
                    }
                }
            }
            if (!leafOnly && count >= 3 && minL <= 2) {
                for (let k = 0; k < 5; k++) {
                    const p = pts[k];
                    if (!hasPt(st0, st1, st2, p) || libs[p] !== 2)
                        continue;
                    const pri = isTurn ? 80000 : 90000;
                    let x = vGL0[p];
                    while (x) {
                        const q = ctz27(x);
                        x &= x - 1;
                        mark(q, pri);
                        forcing[q] = 1;
                    }
                    x = vGL1[p];
                    while (x) {
                        const q = 27 + ctz27(x);
                        x &= x - 1;
                        mark(q, pri);
                        forcing[q] = 1;
                    }
                    x = vGL2[p];
                    while (x) {
                        const q = 54 + ctz27(x);
                        x &= x - 1;
                        mark(q, pri);
                        forcing[q] = 1;
                    }
                }
            }
        }
        for (let p = 0; p < 81; p++) {
            if (vTwoDir[p] === 3) {
                d2++;
                press += 220;
                if (!leafOnly) {
                    ownM[p] = ownM[p] + 1600;
                    enM[p] = enM[p] + 1200;
                }
            }
            if (popcnt27(vFollow0[p]) + popcnt27(vFollow1[p]) + popcnt27(vFollow2[p]) >= 2) {
                press += 1200;
                if (!leafOnly) {
                    ownM[p] = ownM[p] + 8000;
                    mark(p, isTurn ? 60000 : 55000);
                }
            }
        }
        if (c === 0) {
            pressure0 = press;
            potential0 = pot;
            claims0 = clm;
            claimMinRem0 = cMinRem;
            claimMinLib0 = cMinLib;
            d2_0 = d2;
            pk0 = pkt;
            cm0_0 = cp0;
            cm0_1 = cp1;
            cm0_2 = cp2;
            comp0 = popcnt27(cp0) + popcnt27(cp1) + popcnt27(cp2);
            hComp0 = popcnt27(hc0) + popcnt27(hc1) + popcnt27(hc2);
        }
        else {
            pressure1 = press;
            potential1 = pot;
            claims1 = clm;
            claimMinRem1 = cMinRem;
            claimMinLib1 = cMinLib;
            d2_1 = d2;
            pk1 = pkt;
            cm1_0 = cp0;
            cm1_1 = cp1;
            cm1_2 = cp2;
            comp1 = popcnt27(cp0) + popcnt27(cp1) + popcnt27(cp2);
            hComp1 = popcnt27(hc0) + popcnt27(hc1) + popcnt27(hc2);
        }
    }
    if ((s.side === 1 ? hComp0 : hComp1) > 0)
        unsettled = true;
    let material = 0, stone = 0, spread = 0;
    const accum = (mask, base, sign) => {
        let x = mask;
        while (x) {
            const p = base + ctz27(x);
            x &= x - 1;
            const dx = (p % 9) - 4, dy = ((p / 9) | 0) - 4, d = dx * dx + dy * dy;
            material += 4 * sign;
            stone += sign * (6 + 3 * (1 - d / 32));
            spread += d * 2;
        }
    };
    accum(s.b0, 0, 1);
    accum(s.b1, 27, 1);
    accum(s.b2, 54, 1);
    accum(s.w0, 0, -1);
    accum(s.w1, 27, -1);
    accum(s.w2, 54, -1);
    return {
        pressure0, pressure1, potential0, potential1, safety0, safety1, oldSafety0, oldSafety1,
        claims0, claims1, claimMinRem0, claimMinRem1, claimMinLib0, claimMinLib1,
        comp0, comp1, hComp0, hComp1, d2_0, d2_1, pk0, pk1,
        cm0_0, cm0_1, cm0_2, cm1_0, cm1_1, cm1_2, exp0, exp1, unsettled,
        material, spread, stone, libs, moves0, moves1, critical, forcing, priority, leafOnly,
    };
}
// Static NNUE scratch accumulators (zero GC per leaf!)
const nnAcc = new Float32Array(NNUE_H1);
const nnH2 = new Float32Array(NNUE_H2);
const nnDense = new Float32Array(NNUE_IN_DENSE);
function clampF(x, lo, hi) {
    return x < lo ? lo : x > hi ? hi : x;
}
function evalNnueLogit(s, v, W) {
    const w1s = W.w1s, w1d = W.w1d, w2 = W.w2, w3 = W.w3;
    nnAcc.set(W.b1);
    const isB = s.side === 1;
    const o0 = isB ? s.b0 : s.w0, o1 = isB ? s.b1 : s.w1, o2 = isB ? s.b2 : s.w2;
    const e0 = isB ? s.w0 : s.b0, e1 = isB ? s.w1 : s.b1, e2 = isB ? s.w2 : s.b2;
    const libs = v.libs;
    const addAcc64 = (wArr, off) => {
        for (let j = 0; j < 64; j += 4) {
            nnAcc[j] = nnAcc[j] + wArr[off + j];
            nnAcc[j + 1] = nnAcc[j + 1] + wArr[off + j + 1];
            nnAcc[j + 2] = nnAcc[j + 2] + wArr[off + j + 2];
            nnAcc[j + 3] = nnAcc[j + 3] + wArr[off + j + 3];
        }
    };
    const addStones = (mask, base, enemyOff) => {
        let x = mask;
        while (x) {
            const p = base + ctz27(x);
            x &= x - 1;
            const lb = libs[p];
            const off = (p * 6 + enemyOff + (lb === 1 ? 0 : lb === 2 ? 1 : 2)) * NNUE_H1;
            addAcc64(w1s, off);
        }
    };
    addStones(o0, 0, 0);
    addStones(o1, 27, 0);
    addStones(o2, 54, 0);
    addStones(e0, 0, 3);
    addStones(e1, 27, 3);
    addStones(e2, 54, 3);
    for (let w = 0; w < 50; w++) {
        const m0 = WIN_M0[w], m1 = WIN_M1[w], m2 = WIN_M2[w];
        const om0 = o0 & m0, om1 = o1 & m1, om2 = o2 & m2;
        const em0 = e0 & m0, em1 = e1 & m1, em2 = e2 & m2;
        if ((em0 | em1 | em2) === 0) {
            const c = popcnt27(om0) + popcnt27(om1) + popcnt27(om2);
            if (c >= 2)
                addAcc64(w1s, (486 + w * 8 + (c - 2)) * NNUE_H1);
        }
        else if ((om0 | om1 | om2) === 0) {
            const c = popcnt27(em0) + popcnt27(em1) + popcnt27(em2);
            if (c >= 2)
                addAcc64(w1s, (486 + w * 8 + 4 + (c - 2)) * NNUE_H1);
        }
    }
    const pOwn = isB ? v.pressure0 : v.pressure1, pEn = isB ? v.pressure1 : v.pressure0;
    const sOwn = isB ? v.safety0 : v.safety1, sEn = isB ? v.safety1 : v.safety0;
    const capDiff = isB ? (s.capW - s.capB) : (s.capB - s.capW);
    nnDense[0] = clampF((pOwn - pEn) / 2000, -5, 5);
    nnDense[1] = clampF((sOwn - sEn) / 1000, -5, 5);
    nnDense[2] = clampF((v.stone * s.side) / 100, -5, 5);
    nnDense[3] = clampF(capDiff / 10, -5, 5);
    nnDense[4] = clampF(isB ? v.hComp0 : v.hComp1, 0, 3);
    nnDense[5] = clampF(isB ? v.hComp1 : v.hComp0, 0, 3);
    nnDense[6] = clampF(isB ? v.comp0 : v.comp1, 0, 3);
    nnDense[7] = clampF(isB ? v.comp1 : v.comp0, 0, 3);
    nnDense[8] = clampF(pOwn / 2000, 0, 5);
    nnDense[9] = clampF(pEn / 2000, 0, 5);
    nnDense[10] = clampF(sOwn / 1000, -5, 5);
    nnDense[11] = clampF(sEn / 1000, -5, 5);
    nnDense[12] = clampF((isB ? v.d2_0 : v.d2_1) / 4, 0, 3);
    nnDense[13] = clampF((isB ? v.d2_1 : v.d2_0) / 4, 0, 3);
    nnDense[14] = clampF((isB ? v.pk0 : v.pk1) / 4, 0, 3);
    nnDense[15] = clampF((isB ? v.pk1 : v.pk0) / 4, 0, 3);
    const cRemOwn = isB ? v.claimMinRem0 : v.claimMinRem1;
    const cRemEn = isB ? v.claimMinRem1 : v.claimMinRem0;
    const cLibOwn = isB ? v.claimMinLib0 : v.claimMinLib1;
    const cLibEn = isB ? v.claimMinLib1 : v.claimMinLib0;
    const stoneCount = popcnt27(s.b0) + popcnt27(s.b1) + popcnt27(s.b2) + popcnt27(s.w0) + popcnt27(s.w1) + popcnt27(s.w2);
    nnDense[16] = cRemOwn < 100 ? (1 / Math.max(1, cRemOwn)) : 0;
    nnDense[17] = cRemEn < 100 ? (1 / Math.max(1, cRemEn)) : 0;
    nnDense[18] = cRemOwn < 100 ? clampF(cLibOwn / 4, 0, 1) : 0;
    nnDense[19] = cRemEn < 100 ? clampF(cLibEn / 4, 0, 1) : 0;
    nnDense[20] = clampF((isB ? v.claims0 : v.claims1) / 90000, 0, 2);
    nnDense[21] = clampF((isB ? v.claims1 : v.claims0) / 90000, 0, 2);
    nnDense[22] = clampF(s.ply / 60, 0, 2);
    nnDense[23] = clampF(stoneCount / 60, 0, 2);
    for (let d = 0; d < NNUE_IN_DENSE; d++) {
        const dv = nnDense[d];
        if (dv === 0)
            continue;
        const off = d * NNUE_H1;
        for (let j = 0; j < 64; j += 4) {
            nnAcc[j] = nnAcc[j] + dv * w1d[off + j];
            nnAcc[j + 1] = nnAcc[j + 1] + dv * w1d[off + j + 1];
            nnAcc[j + 2] = nnAcc[j + 2] + dv * w1d[off + j + 2];
            nnAcc[j + 3] = nnAcc[j + 3] + dv * w1d[off + j + 3];
        }
    }
    nnH2.set(W.b2);
    for (let i = 0; i < NNUE_H1; i++) {
        let a1 = nnAcc[i];
        if (a1 <= 0)
            continue;
        if (a1 > 1)
            a1 = 1;
        a1 = a1 * a1; // SCReLU (v22 Gen-3)
        const off = i * NNUE_H2;
        for (let j = 0; j < 16; j += 4) {
            nnH2[j] = nnH2[j] + a1 * w2[off + j];
            nnH2[j + 1] = nnH2[j + 1] + a1 * w2[off + j + 1];
            nnH2[j + 2] = nnH2[j + 2] + a1 * w2[off + j + 2];
            nnH2[j + 3] = nnH2[j + 3] + a1 * w2[off + j + 3];
        }
    }
    let out = W.b3;
    for (let j = 0; j < NNUE_H2; j++) {
        let a2 = nnH2[j];
        if (a2 <= 0)
            continue;
        if (a2 > 1)
            a2 = 1;
        a2 = a2 * a2; // SCReLU (v22 Gen-3)
        out += a2 * w3[j];
    }
    return out;
}
function heuristicValueA(s, v, W) {
    if (s.phase === 3)
        return stateTerminalValueA(s) * 1000000000;
    if (s.phase < 2) {
        const advantage = v.potential0 - v.potential1 + v.material + v.oldSafety0 - v.oldSafety1;
        return -Math.abs(advantage - 12) - v.spread;
    }
    const captures = (s.capW - s.capB) * 40;
    const baseScore = v.pressure0 - v.pressure1 + v.stone + captures + v.safety0 - v.safety1;
    const isB = s.side === 1;
    const hOwn = isB ? v.hComp0 : v.hComp1, cOwn = isB ? v.comp0 : v.comp1;
    const hEn = isB ? v.hComp1 : v.hComp0, cEn = isB ? v.comp1 : v.comp0;
    const initiative = hOwn > 0 ? 6000 : cOwn > 0 ? 1800 : hEn >= 2 ? -5000 : cEn >= 2 ? -1500 : 0;
    const claimDiff = v.claims0 - v.claims1;
    let score = baseScore + claimDiff + s.side * (12 + initiative);
    const nnueBlack = s.side * evalNnueLogit(s, v, W) * NNUE_SCORE_SCALE;
    if (v.claims0 === 0 && v.claims1 === 0) {
        score = (1 - NNUE_BLEND_ALPHA) * score + NNUE_BLEND_ALPHA * (nnueBlack + s.side * (12 + initiative));
    }
    else {
        score = (1 - NNUE_CLAIM_BLEND_ALPHA) * score + NNUE_CLAIM_BLEND_ALPHA * (nnueBlack + claimDiff + s.side * (12 + initiative));
    }
    return (s.ownerBlack === 0 ? 1 : -1) * Math.max(-1000000, Math.min(1000000, score));
}
// ============================================================
// Static 262,144-entry Typed-Array Zobrist TT (zero GC!)
// ============================================================
const TT_SIZE = 262144;
const TT_MASK = TT_SIZE - 1;
const ttKeyLo = new Int32Array(TT_SIZE);
const ttKeyHi = new Int32Array(TT_SIZE);
const ttB0 = new Int32Array(TT_SIZE), ttB1 = new Int32Array(TT_SIZE), ttB2 = new Int32Array(TT_SIZE);
const ttW0 = new Int32Array(TT_SIZE), ttW1 = new Int32Array(TT_SIZE), ttW2 = new Int32Array(TT_SIZE);
const ttVal = new Float64Array(TT_SIZE);
const ttMove = new Int8Array(TT_SIZE);
const ttDepth = new Int8Array(TT_SIZE);
const ttBound = new Int8Array(TT_SIZE);
const ttQLeft = new Int8Array(TT_SIZE);
const ttClaims = new Uint8Array(TT_SIZE);
const ttGen = new Uint32Array(TT_SIZE);
let globalTTGen = 0;
let skLo = 0, skHi = 0, skClaims = 0;
function computeStateKey(s, rootCapTag) {
    const meta = (s.phase & 3) | ((s.opened & 3) << 2) | ((s.side === 1 ? 1 : 0) << 4)
        | (((s.ownerBlack + 1) & 3) << 5) | ((s.passes & 3) << 7) | ((s.capB & 127) << 9) | ((s.capW & 127) << 16);
    let lo = s.hLo ^ imix32(meta) ^ rootCapTag;
    let hi = s.hHi ^ imix32(meta ^ 0x517cc1b7) ^ imix32(rootCapTag ^ 0x9e3779b9);
    let claims = 0;
    if (s.claimCount > 0) {
        for (let w = 0; w < 50; w++) {
            if (s.birth[w] >= 0) {
                claims++;
                const cm = (w << 8) | ((s.ply - s.birth[w]) & 255) | 0x10000;
                lo ^= imix32(cm);
                hi ^= imix32(cm ^ 0x27d4eb2d);
            }
        }
    }
    skLo = lo;
    skHi = hi;
    skClaims = claims;
}
class LimitStop {
    reason;
    constructor(reason) {
        this.reason = reason;
    }
}
function makeNode(s) {
    let proven = false, value = 0;
    if (s.phase === 3) {
        proven = true;
        value = stateTerminalValueA(s);
    }
    else if (s.phase === 2) {
        const color = provenWin(s, 1) ? 1 : provenWin(s, -1) ? -1 : 0;
        if (color !== 0) {
            proven = true;
            value = stateOwner(s, color) === 0 ? 1 : -1;
        }
    }
    return { state: s, proven, value, solvedMove: -1, quickChecked: false };
}
function tieRankCode(code, seed) {
    let x = (seed ^ (code + 1)) >>> 0;
    x = Math.imul(x ^ (x >>> 16), 0x7feb352d) >>> 0;
    x = Math.imul(x ^ (x >>> 15), 0x846ca68b) >>> 0;
    return (x ^ (x >>> 16)) >>> 0;
}
function codeToAction(code, actor) {
    if (code === 81)
        return { kind: "pass", actor };
    if (code === 82)
        return { kind: "choose-color", actor, color: "black" };
    if (code === 83)
        return { kind: "choose-color", actor, color: "white" };
    return { kind: "place", actor, point: code };
}
function actionToCode(a) {
    return a.kind === "place" ? a.point : a.kind === "pass" ? 81 : a.color === "black" ? 82 : 83;
}
export const SHARED_TT_STRIDE = 10;
// Cache-line isolated (64-byte = 16 Int32 stride) SharedArrayBuffer control slots to prevent false sharing
export const CTRL_JOB_SEQ = 0;
export const CTRL_MAX_DEPTH = 16;
export const CTRL_ACTIVE_WORKERS = 32;
export const CTRL_TT_GEN = 48;
export const CTRL_THREAD_COUNT = 64;
export const CTRL_NODES_BASE = 80;
export const CTRL_NODES_STRIDE = 16;
export const CTRL_BUFFER_BYTES = 2048; // 512 Int32s: up to 26 cache-line-isolated threads
export function isV21Profile(match) {
    const r = match.rules;
    return r.boardSize === 9 && r.directions === "diagonal" && r.confirmationDelay === 4
        && r.claimMode === "fixed-five" && r.superko === "positional";
}
export function runV21Search(header, match, now, cancelled, started, initialLastTime = started, opts) {
    const budget = header.budget;
    const actor = header.context.actor;
    const threadId = opts?.threadId ?? 0;
    const isHelper = threadId > 0;
    const isPonder = opts?.ponder === true;
    const fullPower = opts?.fullPower === true || isHelper || isPonder;
    const sharedTT = opts?.sharedTT ?? null;
    const sharedMask = opts?.sharedTTMask ?? 0;
    const ctrl = opts?.control ?? null;
    const jobSeq = opts?.jobSeq ?? 0;
    const keepTT = opts?.keepTT === true;
    const onProgress = opts?.onProgress;
    const seed = isHelper ? ((header.seed >>> 0) ^ Math.imul(threadId + 1, 0x9e3779b9)) >>> 0 : (header.seed >>> 0);
    const W = getNnueWeights();
    const tieRanks = new Uint32Array(84);
    for (let c = 0; c < 84; c++)
        tieRanks[c] = tieRankCode(c, seed);
    let lastTime = initialLastTime;
    const elapsed = () => {
        const t = now();
        if (!Number.isFinite(t) || t < lastTime)
            throw Error("clock must be monotonic");
        lastTime = t;
        return Math.min(Number.MAX_SAFE_INTEGER, t - started);
    };
    let nodes = 1;
    let lastProgressMs = 0;
    let checkTick = 0;
    let maxVisitedDepth = 0;
    let completedDepth = 0;
    let cutoffs = 0;
    let rootCandidates = 0;
    let bestCode = -1;
    let bestScore = null;
    const hardNodeCap = fullPower ? 1000000000 : budget.maxNodes;
    let maxAllowedNodes = hardNodeCap;
    const softEndMs = isPonder ? 3600000 : budget.timeMs - Math.min(2500, Math.max(0, budget.timeMs * 0.05));
    let curTimeLimit = isPonder ? 3600000 : budget.timeMs;
    const myNodeSlot = CTRL_NODES_BASE + threadId * CTRL_NODES_STRIDE;
    const publishNodes = () => {
        if (ctrl && myNodeSlot < ctrl.length)
            ctrl[myNodeSlot] = nodes;
    };
    const sumAllNodes = () => {
        if (!ctrl)
            return nodes;
        const tc = Math.max(1, Math.min(24, ctrl[CTRL_THREAD_COUNT] || 1));
        let tot = 0;
        for (let t = 0; t < tc; t++)
            tot += ctrl[CTRL_NODES_BASE + t * CTRL_NODES_STRIDE];
        return Math.max(nodes, tot);
    };
    const checkBudget = () => {
        if (opts) {
            if (nodes >= maxAllowedNodes)
                throw new LimitStop("nodes");
            if ((++checkTick & 511) !== 0)
                return;
            if (ctrl && Atomics.load(ctrl, CTRL_JOB_SEQ) !== jobSeq)
                throw new LimitStop("cancelled");
            publishNodes();
            if (cancelled())
                throw new LimitStop("cancelled");
            const el = elapsed();
            if (el >= curTimeLimit)
                throw new LimitStop("time");
            if (onProgress && !isHelper && el - lastProgressMs >= 250) {
                lastProgressMs = el;
                const maxD = ctrl ? Math.max(completedDepth, ctrl[CTRL_MAX_DEPTH]) : completedDepth;
                onProgress({ nodes, totalNodes: sumAllNodes(), depth: maxD, elapsedMs: el, score: bestScore, bestCode });
            }
            return;
        }
        if (cancelled())
            throw new LimitStop("cancelled");
        if (elapsed() >= curTimeLimit)
            throw new LimitStop("time");
        if (nodes >= maxAllowedNodes)
            throw new LimitStop("nodes");
    };
    const applyBudgeted = (s, code, depth) => {
        checkBudget();
        if (depth > budget.maxDepth)
            throw new LimitStop("depth");
        nodes++;
        if (depth > maxVisitedDepth)
            maxVisitedDepth = depth;
        return applyCode(s, code);
    };
    const finish = (stop) => {
        const stillOwner = !ctrl || Atomics.load(ctrl, CTRL_JOB_SEQ) === jobSeq;
        if (stillOwner)
            publishNodes();
        let el = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, lastTime - started));
        try {
            el = elapsed();
            if (cancelled() || !stillOwner)
                stop = "cancelled";
            else if (!isPonder && el >= budget.timeMs && stop !== "internal" && stop !== "cancelled")
                stop = "time";
        }
        catch {
            stop = "internal";
        }
        if (onProgress && !isHelper && stillOwner) {
            const maxD = ctrl ? Math.max(completedDepth, ctrl[CTRL_MAX_DEPTH]) : completedDepth;
            onProgress({ nodes, totalNodes: sumAllNodes(), depth: maxD, elapsedMs: el, score: bestScore, bestCode });
        }
        const common = {
            protocolVersion: AI_PROTOCOL_VERSION,
            kind: "result",
            context: header.context,
            stats: { elapsedMs: el, nodes: Math.min(nodes, budget.maxNodes), completedDepth: Math.min(completedDepth, budget.maxDepth) },
        };
        let bestAction = bestCode >= 0 ? codeToAction(bestCode, actor) : null;
        let immediateOutcome = null;
        if (bestAction) {
            const checked = applyAction(match, bestAction);
            if (!checked.ok)
                bestAction = null;
            else
                immediateOutcome = checked.value.match.state.outcome;
        }
        let reply;
        if (stop === "cancelled")
            reply = { ...common, status: "cancelled" };
        else if (stop === "internal")
            reply = { ...common, status: "failed", reason: "internal" };
        else if (bestAction)
            reply = { ...common, status: stop === "time" || stop === "nodes" ? "timeout" : "move", action: bestAction };
        else
            reply = { ...common, status: "failed", reason: "no-action" };
        const variation = bestAction && budget.maxDepth >= 1 ? [bestAction] : [];
        let rootScore = bestScore === null ? null : (actor === "A" ? bestScore : -bestScore);
        if (immediateOutcome?.kind === "win") {
            rootScore = immediateOutcome.winner === actor ? 1000000000 : -1000000000;
        }
        else if (rootScore !== null && Math.abs(rootScore) >= 1000000000) {
            rootScore = rootScore > 0 ? 500000000 : -500000000;
        }
        return aiOK(freeze({
            reply,
            details: {
                stop, quietWidth: 12, maxVisitedDepth: Math.min(maxVisitedDepth, budget.maxDepth),
                cutoffs, rootCandidates, score: rootScore, variation,
            },
        }));
    };
    // Reconstruct bitboard State from validated Match
    let rootState = emptyState(match.rules.swap3);
    try {
        for (const act of match.accepted) {
            if (act.kind === "place" || act.kind === "pass" || act.kind === "choose-color") {
                rootState = applyCode(rootState, actionToCode(act));
            }
        }
    }
    catch {
        return finish("internal");
    }
    const rootLegal = legalCodes(rootState);
    if (rootLegal.length === 0)
        return finish("nodes");
    bestCode = rootLegal[0];
    rootCandidates = rootLegal.length;
    // Tactics helpers
    const formations = (s, color, holes) => {
        const o0 = color === 1 ? s.b0 : s.w0, o1 = color === 1 ? s.b1 : s.w1, o2 = color === 1 ? s.b2 : s.w2;
        const e0 = color === 1 ? s.w0 : s.b0, e1 = color === 1 ? s.w1 : s.b1, e2 = color === 1 ? s.w2 : s.b2;
        const occ0 = o0 | e0, occ1 = o1 | e1, occ2 = o2 | e2;
        const sel = new Uint8Array(81);
        const need = 5 - holes;
        for (let i = 0; i < 50; i++) {
            const m0 = WIN_M0[i], m1 = WIN_M1[i], m2 = WIN_M2[i];
            if (((e0 & m0) | (e1 & m1) | (e2 & m2)) !== 0)
                continue;
            if (popcnt27(o0 & m0) + popcnt27(o1 & m1) + popcnt27(o2 & m2) !== need)
                continue;
            const pts = WIN_PTS[i];
            for (let k = 0; k < 5; k++)
                if (!hasPt(occ0, occ1, occ2, pts[k]))
                    sel[pts[k]] = 1;
        }
        const out = [];
        for (let p = 0; p < 81; p++)
            if (sel[p])
                out.push(p);
        return out;
    };
    const atariCaptures = (s, targetColor) => {
        const o0 = targetColor === 1 ? s.b0 : s.w0, o1 = targetColor === 1 ? s.b1 : s.w1, o2 = targetColor === 1 ? s.b2 : s.w2;
        const occ0 = s.b0 | s.w0, occ1 = s.b1 | s.w1, occ2 = s.b2 | s.w2;
        const sel = new Uint8Array(81);
        let rem0 = o0, rem1 = o1, rem2 = o2;
        while ((rem0 | rem1 | rem2) !== 0) {
            const fp = rem0 !== 0 ? ctz27(rem0) : rem1 !== 0 ? 27 + ctz27(rem1) : 54 + ctz27(rem2);
            floodGroup(o0, o1, o2, fp);
            groupLiberties(g0, g1, g2, occ0, occ1, occ2);
            if (popcnt27(lb0) + popcnt27(lb1) + popcnt27(lb2) === 1) {
                const lp = lb0 !== 0 ? ctz27(lb0) : lb1 !== 0 ? 27 + ctz27(lb1) : 54 + ctz27(lb2);
                sel[lp] = 1;
            }
            rem0 &= ~g0;
            rem1 &= ~g1;
            rem2 &= ~g2;
        }
        const out = [];
        for (let p = 0; p < 81; p++)
            if (sel[p])
                out.push(p);
        return out;
    };
    const existingClaim = (s, color) => {
        for (let i = 0; i < 50; i++)
            if (s.birth[i] >= 0 && windowColor(s, i) === color)
                return true;
        return false;
    };
    const analyzeRoot = (s, depth) => {
        const codes = legalCodes(s);
        if (s.phase !== 2)
            return { allowed: codes, win: false, allLost: false };
        const own = s.side, enemy = -own;
        if (provenWin(s, own)) {
            const passState = applyBudgeted(s, 81, depth + 1);
            if (provenWin(passState, own))
                return { allowed: [81], win: true, allLost: false };
        }
        const unrefuted = [];
        for (const code of codes) {
            const after = applyBudgeted(s, code, depth + 1);
            if (provenWin(after, own))
                return { allowed: [code], win: true, allLost: false };
            if (provenWin(after, enemy))
                continue;
            let loss = false;
            if (after.phase === 2 && after.side === enemy && depth + 2 <= budget.maxDepth) {
                const replies = existingClaim(after, enemy) ? legalCodes(after) : formations(after, enemy, 1);
                for (const reply of replies) {
                    if (reply < 81 && !canPlace(after, reply))
                        continue;
                    const child = applyBudgeted(after, reply, depth + 2);
                    if (provenWin(child, enemy)) {
                        loss = true;
                        break;
                    }
                }
            }
            if (!loss)
                unrefuted.push(code);
        }
        return { allowed: unrefuted.length > 0 ? unrefuted : codes, win: false, allLost: unrefuted.length === 0 };
    };
    const refuteAt = (s, code, depth, ceiling) => {
        if (s.phase !== 2 || depth + 4 > budget.maxDepth || nodes >= ceiling)
            return false;
        const own = s.side, enemy = -own;
        const after = applyBudgeted(s, code, depth + 1);
        if (provenWin(after, enemy))
            return true;
        if (provenWin(after, own) || after.phase !== 2 || after.side !== enemy)
            return false;
        const four = formations(after, enemy, 1);
        const three = formations(after, enemy, 2);
        const captures = atariCaptures(after, own);
        const all = legalCodes(after);
        const allSet = new Set(all);
        const hasDirect = existingClaim(after, enemy) || four.length > 0;
        const groups = hasDirect ? [four, captures, three, all] : [four, three, captures];
        const seen = new Set();
        const replies = [];
        for (const grp of groups)
            for (const p of grp)
                if (!seen.has(p) && allSet.has(p)) {
                    seen.add(p);
                    replies.push(p);
                }
        for (const reply of replies) {
            if (nodes >= ceiling)
                return false;
            const child = applyBudgeted(after, reply, depth + 2);
            if (provenWin(child, enemy))
                return true;
            if (child.phase !== 2 || child.side !== own)
                continue;
            if (!existingClaim(child, enemy) && formations(child, enemy, 1).length === 0)
                continue;
            const legalCount = legalCodes(child).length;
            const origMax = maxAllowedNodes;
            maxAllowedNodes = Math.min(origMax, ceiling);
            let analysis = null;
            try {
                analysis = analyzeRoot(child, depth + 2);
            }
            catch (e) {
                if (e instanceof LimitStop && e.reason === "nodes")
                    return false;
                throw e;
            }
            finally {
                maxAllowedNodes = origMax;
            }
            if (analysis.allLost)
                return true;
            if (!analysis.win && analysis.allowed.length > 0 && analysis.allowed.length <= 4 && analysis.allowed.length < legalCount && depth + 6 <= budget.maxDepth) {
                let allForcedLose = true;
                for (const def of analysis.allowed) {
                    const prevM = maxAllowedNodes;
                    maxAllowedNodes = Math.min(prevM, ceiling);
                    let refDef = false;
                    try {
                        refDef = refuteAt(child, def, depth + 2, ceiling);
                    }
                    catch (e) {
                        if (e instanceof LimitStop && e.reason === "nodes")
                            return false;
                        throw e;
                    }
                    finally {
                        maxAllowedNodes = prevM;
                    }
                    if (!refDef) {
                        allForcedLose = false;
                        break;
                    }
                }
                if (allForcedLose)
                    return true;
            }
        }
        return false;
    };
    let stopReason = "max-depth";
    try {
        if (budget.maxNodes <= 2 || budget.maxDepth <= 0) {
            // Minimal budget fallback: immediately pick best static root move within node limit
            checkBudget();
            if (budget.maxDepth >= 1 && nodes < budget.maxNodes) {
                const rv = buildView(rootState, false);
                let topCode = rootLegal[0], topRank = -Infinity;
                const color = rootState.phase === 0 ? (rootState.opened === 1 ? 1 : 0) : rootState.side === 1 ? 0 : 1;
                for (const p of rootLegal) {
                    let rk = 0;
                    if (p < 81) {
                        const dx = (p % 9) - 4, dy = ((p / 9) | 0) - 4;
                        rk = -(dx * dx + dy * dy) * 0.05;
                        if (rootState.phase === 2)
                            rk += 1.1 * (color === 0 ? rv.moves0[p] : rv.moves1[p]) + (color === 0 ? rv.moves1[p] : rv.moves0[p]) + rv.priority[p];
                    }
                    else if (p === 81)
                        rk = (color === 0 ? rv.exp0 : rv.exp1) ? 4000000 : -10000;
                    if (rk > topRank || (rk === topRank && tieRankCode(p, seed) > tieRankCode(topCode, seed))) {
                        topRank = rk;
                        topCode = p;
                    }
                }
                bestCode = topCode;
                applyBudgeted(rootState, bestCode, 1);
                completedDepth = 1;
            }
            return finish("nodes");
        }
        // 1. Root tactical analysis (only when budget is enough to cover legal moves)
        let allowed = rootLegal;
        let allLost = false;
        if (budget.maxNodes > rootLegal.length * 4) {
            const ana = analyzeRoot(rootState, 0);
            allowed = ana.allowed;
            allLost = ana.allLost;
            bestCode = allowed[0];
            rootCandidates = allowed.length;
            if (ana.win) {
                completedDepth = 1;
                bestScore = rootState.phase === 2 && stateActor(rootState) === 0 ? 1000000000 : -1000000000;
                const afterWin = applyCode(rootState, bestCode);
                return finish(afterWin.phase === 3 && afterWin.outcome === 1 ? "terminal-win" : "secured-line");
            }
        }
        // 2. Hybrid Iterative-Deepening Alpha-Beta with Local or Shared Lock-Free Zobrist TT + Root PVS + Aspiration + LMR + NNUE
        const rootCapTag = imix32(((rootState.capB & 0xff) << 8) | (rootState.capW & 0xff) | 0x31410000);
        let gen;
        if (sharedTT && ctrl) {
            gen = Atomics.load(ctrl, CTRL_TT_GEN) & 63;
        }
        else {
            const curGen = ++globalTTGen;
            if (curGen === 0) {
                ttGen.fill(0);
                globalTTGen = 1;
            }
            gen = globalTTGen;
        }
        const rootNode = makeNode(rootState);
        const rootActor = stateActor(rootState);
        const maximizeRoot = rootActor === 0;
        const childrenCache = new WeakMap();
        let cachedChildStates = 0;
        const preferred = new WeakMap();
        const history = [new Int32Array(84), new Int32Array(84)];
        const countermove = [new Int8Array(84).fill(-1), new Int8Array(84).fill(-1)];
        const killer0 = new Int8Array(32).fill(-1);
        const killer1 = new Int8Array(32).fill(-1);
        let pathBounds = new WeakMap();
        let fullWidth = false;
        let rootScores = new Map();
        let lastScore = 0;
        const getChild = (parent, code, depth) => {
            checkBudget();
            if (depth > budget.maxDepth)
                throw new LimitStop("depth");
            let list = childrenCache.get(parent.state);
            if (list && list[code]) {
                nodes++;
                if (depth > maxVisitedDepth)
                    maxVisitedDepth = depth;
                return list[code];
            }
            const nextState = applyBudgeted(parent.state, code, depth);
            const child = makeNode(nextState);
            if (!list && cachedChildStates < 16384) {
                list = new Array(84);
                childrenCache.set(parent.state, list);
                cachedChildStates++;
            }
            if (list)
                list[code] = child;
            return child;
        };
        const sortByKey = (arr, len, scores, crit, passCrit, firstMove) => {
            for (let i = 1; i < len; i++) {
                const cur = arr[i], cs = scores[cur], ct = tieRanks[cur], cf = cur === firstMove;
                const cc = crit !== null && (cur > 81 || (cur === 81 ? passCrit : crit[cur] !== 0));
                let j = i - 1;
                while (j >= 0) {
                    const prev = arr[j];
                    let better = false;
                    if (cf && prev !== firstMove)
                        better = true;
                    else if (prev !== firstMove) {
                        const pc = crit !== null && (prev > 81 || (prev === 81 ? passCrit : crit[prev] !== 0));
                        if (cc !== pc)
                            better = cc;
                        else {
                            const ps = scores[prev];
                            if (cs > ps || (cs === ps && ct > tieRanks[prev]))
                                better = true;
                        }
                    }
                    if (!better)
                        break;
                    arr[j + 1] = prev;
                    j--;
                }
                arr[j + 1] = cur;
            }
        };
        const ranksBuf = new Float64Array(84);
        const sortBuf = new Float64Array(84);
        const keepBuf = new Uint8Array(84);
        const orderMoves = (node, v, codes, atRoot, depth, ttM) => {
            const s = node.state;
            const color = s.phase === 0 ? (s.opened === 1 ? 1 : 0) : s.side === 1 ? 0 : 1;
            const prev = ttM >= 0 ? ttM : (preferred.get(s) ?? -1);
            const n = codes.length;
            const ownM = color === 0 ? v.moves0 : v.moves1;
            const enM = color === 0 ? v.moves1 : v.moves0;
            const exp = color === 0 ? v.exp0 : v.exp1;
            for (let i = 0; i < n; i++) {
                const p = codes[i];
                let rk = 0;
                if (p < 81) {
                    const dx = (p % 9) - 4, dy = ((p / 9) | 0) - 4;
                    rk = -(dx * dx + dy * dy) * 0.05;
                    if (s.phase === 0 && s.opened === 1) {
                        const f = s.lastPoint;
                        rk -= 40 * Math.abs(Math.max(Math.abs((f % 9) - (p % 9)), Math.abs(((f / 9) | 0) - ((p / 9) | 0))) - 2);
                    }
                    else if (s.phase === 2) {
                        rk += 1.1 * ownM[p] + enM[p] + v.priority[p];
                    }
                }
                else if (p === 81) {
                    rk = exp ? 4000000 : -10000;
                }
                ranksBuf[p] = rk;
            }
            // v22s2 tight symmetric quiet width: balanced depth scaling for both players
            const width = fullWidth ? 81 : (s.phase === 0 && s.opened === 2) ? 81 : atRoot ? 24 : Math.max(4, 11 - depth);
            let order = codes.slice();
            let m = n;
            if (!fullWidth && n > width) {
                sortByKey(order, n, ranksBuf, null, false, -1);
                keepBuf.fill(0);
                let qcnt = 0, lastQuiet = -1;
                for (let i = 0; i < n; i++) {
                    const p = order[i];
                    if (p >= 81 || (s.phase === 2 && v.critical[p] !== 0))
                        keepBuf[p] = 1;
                    else if (qcnt < width) {
                        keepBuf[p] = 1;
                        qcnt++;
                        lastQuiet = p;
                    }
                }
                if (prev >= 0 && prev < 81 && keepBuf[prev] === 0 && lastQuiet >= 0) {
                    keepBuf[lastQuiet] = 0;
                    keepBuf[prev] = 1;
                }
                m = 0;
                for (let i = 0; i < n; i++)
                    if (keepBuf[order[i]] !== 0)
                        order[m++] = order[i];
                if (m < n)
                    order.length = m;
            }
            const k0 = killer0[depth], k1 = killer1[depth], act = stateActor(s);
            const cm = (s.lastPoint >= 0 && s.lastPoint < 84) ? countermove[act][s.lastPoint] : -1;
            const hist = history[act];
            for (let i = 0; i < m; i++) {
                const p = order[i];
                sortBuf[p] = ranksBuf[p] + hist[p] + (p === k0 || p === k1 ? 8000 : p === cm ? 6000 : 0);
            }
            sortByKey(order, m, sortBuf, s.phase === 2 ? v.critical : null, s.phase === 2 && exp, prev);
            return order;
        };
        const visit = (node, remaining, depth, alpha, beta, qleft, extLeft) => {
            checkBudget();
            if (node.proven)
                return node.value * 1000000000;
            const origAlpha = alpha, origBeta = beta;
            const s = node.state;
            computeStateKey(s, rootCapTag);
            const keyLo = skLo, keyHi = skHi, activeClaims = skClaims;
            let ttM = -1;
            // v22s2 captt: allow TT cutoffs across capture subtrees (capB/capW + board verified in key)
            const ttSafe = !fullWidth && activeClaims === 0 && s.phase === 2;
            const ttIdx = sharedTT ? (keyLo & sharedMask) : (keyLo & TT_MASK);
            if (sharedTT) {
                const base = ttIdx * SHARED_TT_STRIDE;
                const s0 = sharedTT[base], s1 = sharedTT[base + 1], s2 = sharedTT[base + 2];
                const s3 = sharedTT[base + 3], s4 = sharedTT[base + 4], s5 = sharedTT[base + 5];
                const s6 = sharedTT[base + 6], s7 = sharedTT[base + 7], s8 = sharedTT[base + 8], s9 = sharedTT[base + 9];
                if ((s9 ^ s0 ^ s1 ^ s2 ^ s3 ^ s4 ^ s5 ^ s6 ^ s7 ^ s8) === keyLo && s6 === keyHi
                    && s0 === s.b0 && s1 === s.b1 && s2 === s.b2 && s3 === s.w0 && s4 === s.w1 && s5 === s.w2
                    && (((s8 >>> 20) & 0x3f) === activeClaims)) {
                    const mv = s8 & 0xff;
                    ttM = mv === 255 ? -1 : mv;
                    const eDepth = (s8 >>> 8) & 0x3f;
                    const eBnd = ((s8 >>> 14) & 0x7) - 2;
                    const eQLeft = (s8 >>> 17) & 0x7;
                    if (ttSafe && eBnd >= -1 && (eDepth > remaining || (eDepth === remaining && eQLeft >= qleft))) {
                        const val = s7;
                        if (eBnd === 0)
                            return val;
                        if (eBnd === 1)
                            alpha = Math.max(alpha, val);
                        else if (eBnd === -1)
                            beta = Math.min(beta, val);
                        if (alpha >= beta) {
                            cutoffs++;
                            return val;
                        }
                    }
                }
            }
            else {
                const genMatch = keepTT || ttGen[ttIdx] === gen;
                if (genMatch && ttKeyLo[ttIdx] === keyLo && ttKeyHi[ttIdx] === keyHi && ttClaims[ttIdx] === activeClaims
                    && ttB0[ttIdx] === s.b0 && ttB1[ttIdx] === s.b1 && ttB2[ttIdx] === s.b2
                    && ttW0[ttIdx] === s.w0 && ttW1[ttIdx] === s.w1 && ttW2[ttIdx] === s.w2) {
                    ttM = ttMove[ttIdx];
                    if (ttSafe && (ttDepth[ttIdx] > remaining || (ttDepth[ttIdx] === remaining && ttQLeft[ttIdx] >= qleft))) {
                        const bnd = ttBound[ttIdx], val = ttVal[ttIdx];
                        if (bnd === 0)
                            return val;
                        if (bnd === 1)
                            alpha = Math.max(alpha, val);
                        else if (bnd === -1)
                            beta = Math.min(beta, val);
                        if (alpha >= beta) {
                            cutoffs++;
                            return val;
                        }
                    }
                }
            }
            const pathKey = remaining * 3 + qleft;
            if (!ttSafe) {
                const entries = pathBounds.get(s);
                const cached = entries?.get(pathKey);
                if (cached) {
                    if (cached.kind === 0)
                        return cached.value;
                    if (cached.kind === 1)
                        alpha = Math.max(alpha, cached.value);
                    else
                        beta = Math.min(beta, cached.value);
                    if (alpha >= beta) {
                        cutoffs++;
                        return cached.value;
                    }
                }
            }
            const qsearch = remaining === 0;
            const termLeaf = qsearch && (fullWidth || qleft === 0 || depth >= budget.maxDepth);
            let view = buildView(s, termLeaf);
            const isB = s.side === 1;
            if (!node.quickChecked && s.phase === 2 && depth < budget.maxDepth && (!qsearch || !fullWidth)) {
                const wanted = stateActor(s) === 0 ? 1 : -1;
                const c0 = isB ? view.cm0_0 : view.cm1_0, c1 = isB ? view.cm0_1 : view.cm1_1, c2 = isB ? view.cm0_2 : view.cm1_2;
                if ((c0 | c1 | c2) !== 0) {
                    const probeMask = (mask, base) => {
                        let x = mask;
                        while (x) {
                            const p = base + ctz27(x);
                            x &= x - 1;
                            if (!canPlace(s, p))
                                continue;
                            const after = getChild(node, p, depth + 1);
                            if (after.proven && after.value === wanted) {
                                node.proven = true;
                                node.value = wanted;
                                node.solvedMove = p;
                                return wanted * 1000000000;
                            }
                        }
                        return null;
                    };
                    const r0 = probeMask(c0, 0);
                    if (r0 !== null)
                        return r0;
                    const r1 = probeMask(c1, 27);
                    if (r1 !== null)
                        return r1;
                    const r2 = probeMask(c2, 54);
                    if (r2 !== null)
                        return r2;
                }
                if (isB ? view.exp0 : view.exp1) {
                    const after = getChild(node, 81, depth + 1);
                    if (after.proven && after.value === wanted) {
                        node.proven = true;
                        node.value = wanted;
                        node.solvedMove = 81;
                        return wanted * 1000000000;
                    }
                }
                node.quickChecked = true;
            }
            const wantQ = !fullWidth && qleft > 0 && depth < budget.maxDepth && view.unsettled;
            if (qsearch && !wantQ)
                return heuristicValueA(s, view, W);
            if (view.leafOnly)
                view = buildView(s, false);
            // v22s2 IIR: internal iterative reduction when no TT move is known
            if (!fullWidth && !qsearch && remaining >= 4 && ttM < 0 && !view.unsettled)
                remaining--;
            let ext = 0;
            if (!fullWidth && !qsearch && extLeft > 0 && depth + remaining < budget.maxDepth && s.phase === 2) {
                if ((isB ? view.hComp1 : view.hComp0) === 1 && (isB ? view.comp0 : view.comp1) === 0)
                    ext = 1;
                else if (s.claimCount > 0 && remaining >= 2)
                    ext = 1;
            }
            let codes = orderMoves(node, view, legalCodes(s), false, depth, ttM);
            if (qsearch) {
                const forcing = [];
                for (let i = 0; i < codes.length; i++) {
                    const p = codes[i];
                    if (p >= 81 || view.forcing[p] !== 0)
                        forcing.push(p);
                }
                codes = forcing;
            }
            const maximize = stateActor(s) === 0;
            let value = maximize ? -Infinity : Infinity;
            let chosen = -1;
            let moveIndex = 0;
            for (let i = 0; i < codes.length; i++) {
                const p = codes[i];
                const child = getChild(node, p, depth + 1);
                moveIndex++;
                const next = remaining > 0 ? remaining - 1 + ext : 0;
                const ql = qsearch ? qleft - 1 : qleft;
                const nextExt = extLeft - ext;
                const isKiller = p === killer0[depth] || p === killer1[depth];
                const reduced = !fullWidth && !qsearch && ext === 0 && remaining >= 3 && moveIndex >= 4 && chosen >= 0
                    && p < 81 && p !== ttM && !isKiller && view.critical[p] === 0 && !view.unsettled
                    && s.phase === 2 && child.state.phase === 2 && !child.proven
                    && s.capB === child.state.capB && s.capW === child.state.capW;
                let v = 0;
                let done = false;
                if (reduced) {
                    const red = 1 + (remaining >= 6 && moveIndex >= 9 ? 1 : 0) + (remaining >= 9 && moveIndex >= 16 ? 1 : 0);
                    if (Number.isFinite(maximize ? alpha : beta)) {
                        v = maximize
                            ? visit(child, Math.max(0, next - red), depth + 1, alpha, Math.min(beta, alpha + 0.000001), ql, nextExt)
                            : visit(child, Math.max(0, next - red), depth + 1, Math.max(alpha, beta - 0.000001), beta, ql, nextExt);
                    }
                    else {
                        v = visit(child, Math.max(0, next - red), depth + 1, alpha, beta, ql, nextExt);
                    }
                    if (maximize ? v <= alpha : v >= beta)
                        done = true;
                }
                if (!done) {
                    if (chosen >= 0 && Number.isFinite(maximize ? alpha : beta)) {
                        v = maximize
                            ? visit(child, next, depth + 1, alpha, Math.min(beta, alpha + 0.000001), ql, nextExt)
                            : visit(child, next, depth + 1, Math.max(alpha, beta - 0.000001), beta, ql, nextExt);
                        if (v > alpha && v < beta)
                            v = visit(child, next, depth + 1, alpha, beta, ql, nextExt);
                    }
                    else {
                        v = visit(child, next, depth + 1, alpha, beta, ql, nextExt);
                    }
                }
                if (chosen < 0 || (maximize ? v > value : v < value)) {
                    chosen = p;
                    value = v;
                }
                if (maximize)
                    alpha = Math.max(alpha, value);
                else
                    beta = Math.min(beta, value);
                if (alpha >= beta) {
                    cutoffs++;
                    const act = stateActor(s);
                    const hArr = history[act];
                    const b = Math.min(2400, 20 * (remaining + 1) * (remaining + 1));
                    const curH = hArr[p];
                    hArr[p] = Math.min(8000, curH + b - (((curH * b) / 8000) | 0));
                    if (s.lastPoint >= 0 && s.lastPoint < 84)
                        countermove[act][s.lastPoint] = p;
                    if (killer0[depth] !== p) {
                        killer1[depth] = killer0[depth];
                        killer0[depth] = p;
                    }
                    break;
                }
            }
            if (chosen >= 0 && !qsearch)
                preferred.set(s, chosen);
            const finalVal = chosen >= 0 ? value : heuristicValueA(s, view, W);
            const storeBnd = finalVal <= origAlpha ? -1 : finalVal >= origBeta ? 1 : 0;
            if (sharedTT) {
                if (remaining >= 1) {
                    const base = ttIdx * SHARED_TT_STRIDE;
                    const oldMeta = sharedTT[base + 8];
                    const oldGen = (oldMeta >>> 26) & 0x3f;
                    const oldDepth = (oldMeta >>> 8) & 0x3f;
                    const oldBnd = ((oldMeta >>> 14) & 0x7) - 2;
                    if (ttSafe) {
                        if (oldGen !== gen || sharedTT[base + 6] !== keyHi || remaining >= oldDepth || (storeBnd === 0 && oldBnd !== 0)) {
                            const mv = (chosen >= 0 ? chosen : ttM) & 0xff;
                            const valInt = finalVal >= 1000000000 ? 1000000000 : finalVal <= -1000000000 ? -1000000000 : (Math.round(finalVal) | 0);
                            const meta = mv | ((remaining & 0x3f) << 8) | (((storeBnd + 2) & 0x7) << 14) | ((qleft & 0x7) << 17) | ((activeClaims & 0x3f) << 20) | ((gen & 0x3f) << 26);
                            sharedTT[base] = s.b0;
                            sharedTT[base + 1] = s.b1;
                            sharedTT[base + 2] = s.b2;
                            sharedTT[base + 3] = s.w0;
                            sharedTT[base + 4] = s.w1;
                            sharedTT[base + 5] = s.w2;
                            sharedTT[base + 6] = keyHi;
                            sharedTT[base + 7] = valInt;
                            sharedTT[base + 8] = meta;
                            sharedTT[base + 9] = keyLo ^ s.b0 ^ s.b1 ^ s.b2 ^ s.w0 ^ s.w1 ^ s.w2 ^ keyHi ^ valInt ^ meta;
                        }
                    }
                    else {
                        if (chosen >= 0 && !qsearch && (oldGen !== gen || sharedTT[base + 6] !== keyHi || remaining >= oldDepth)) {
                            const meta = (chosen & 0xff) | ((remaining & 0x3f) << 8) | (0 << 14) | ((qleft & 0x7) << 17) | ((activeClaims & 0x3f) << 20) | ((gen & 0x3f) << 26);
                            sharedTT[base] = s.b0;
                            sharedTT[base + 1] = s.b1;
                            sharedTT[base + 2] = s.b2;
                            sharedTT[base + 3] = s.w0;
                            sharedTT[base + 4] = s.w1;
                            sharedTT[base + 5] = s.w2;
                            sharedTT[base + 6] = keyHi;
                            sharedTT[base + 7] = 0;
                            sharedTT[base + 8] = meta;
                            sharedTT[base + 9] = keyLo ^ s.b0 ^ s.b1 ^ s.b2 ^ s.w0 ^ s.w1 ^ s.w2 ^ keyHi ^ meta;
                        }
                        let entries = pathBounds.get(s);
                        if (!entries) {
                            entries = new Map();
                            pathBounds.set(s, entries);
                        }
                        entries.set(pathKey, { value: finalVal, kind: storeBnd });
                    }
                }
                else if (!ttSafe) {
                    let entries = pathBounds.get(s);
                    if (!entries) {
                        entries = new Map();
                        pathBounds.set(s, entries);
                    }
                    entries.set(pathKey, { value: finalVal, kind: storeBnd });
                }
            }
            else if (ttSafe) {
                if (ttGen[ttIdx] !== gen || ttKeyLo[ttIdx] !== keyLo || ttKeyHi[ttIdx] !== keyHi || remaining >= ttDepth[ttIdx] || (storeBnd === 0 && ttBound[ttIdx] !== 0)) {
                    ttGen[ttIdx] = gen;
                    ttKeyLo[ttIdx] = keyLo;
                    ttKeyHi[ttIdx] = keyHi;
                    ttB0[ttIdx] = s.b0;
                    ttB1[ttIdx] = s.b1;
                    ttB2[ttIdx] = s.b2;
                    ttW0[ttIdx] = s.w0;
                    ttW1[ttIdx] = s.w1;
                    ttW2[ttIdx] = s.w2;
                    ttVal[ttIdx] = finalVal;
                    ttMove[ttIdx] = chosen >= 0 ? chosen : ttM;
                    ttDepth[ttIdx] = remaining;
                    ttBound[ttIdx] = storeBnd;
                    ttQLeft[ttIdx] = qleft;
                    ttClaims[ttIdx] = activeClaims;
                }
            }
            else {
                if (chosen >= 0 && !qsearch && (ttGen[ttIdx] !== gen || ttKeyLo[ttIdx] !== keyLo || ttKeyHi[ttIdx] !== keyHi || remaining >= ttDepth[ttIdx])) {
                    ttGen[ttIdx] = gen;
                    ttKeyLo[ttIdx] = keyLo;
                    ttKeyHi[ttIdx] = keyHi;
                    ttB0[ttIdx] = s.b0;
                    ttB1[ttIdx] = s.b1;
                    ttB2[ttIdx] = s.b2;
                    ttW0[ttIdx] = s.w0;
                    ttW1[ttIdx] = s.w1;
                    ttW2[ttIdx] = s.w2;
                    ttMove[ttIdx] = chosen;
                    ttDepth[ttIdx] = remaining;
                    ttBound[ttIdx] = -2;
                    ttClaims[ttIdx] = activeClaims;
                }
                let entries = pathBounds.get(s);
                if (!entries) {
                    entries = new Map();
                    pathBounds.set(s, entries);
                }
                entries.set(pathKey, { value: finalVal, kind: storeBnd });
            }
            return finalVal;
        };
        // Reserve small node margin for root guard (matching v21 Worker.cs)
        const guardReserve = fullPower ? 0 : Math.min(12000, Math.max(0, ((budget.maxNodes - nodes) / 10) | 0));
        maxAllowedNodes = fullPower ? hardNodeCap : Math.min(budget.maxNodes, Math.max(nodes + 1, budget.maxNodes - guardReserve));
        curTimeLimit = Math.max(1, softEndMs);
        const rootView = buildView(rootState, false);
        const initOrdered = orderMoves(rootNode, rootView, allowed, true, 0, -1);
        bestCode = initOrdered[0];
        try {
            const startDepth = isHelper ? Math.min(budget.maxDepth, 1 + (threadId % 3)) : 1;
            for (let depth = startDepth; depth <= budget.maxDepth; depth++) {
                pathBounds = new WeakMap();
                const rootList = orderMoves(rootNode, rootView, fullWidth ? legalCodes(rootState) : allowed, true, 0, bestCode);
                if (depth >= 2 && rootScores.size > 0) {
                    rootList.sort((a, b) => {
                        if (a === bestCode)
                            return b === bestCode ? 0 : -1;
                        if (b === bestCode)
                            return 1;
                        const ha = rootScores.has(a), hb = rootScores.has(b);
                        if (ha && hb) {
                            const va = rootScores.get(a), vb = rootScores.get(b);
                            const cmp = maximizeRoot ? vb - va : va - vb;
                            if (cmp !== 0)
                                return cmp;
                        }
                        else if (ha !== hb)
                            return ha ? -1 : 1;
                        return tieRanks[b] - tieRanks[a];
                    });
                }
                let delta = isHelper ? 180 + (threadId % 4) * 70 : 220, alpha = -Infinity, beta = Infinity;
                if (!fullWidth && depth >= 4 && Math.abs(lastScore) < 500000) {
                    alpha = lastScore - delta;
                    beta = lastScore + delta;
                }
                let nextScores = new Map();
                let best = -1, value = maximizeRoot ? -Infinity : Infinity;
                while (true) {
                    nextScores = new Map();
                    best = -1;
                    value = maximizeRoot ? -Infinity : Infinity;
                    let curAlpha = alpha, curBeta = beta;
                    for (let i = 0; i < rootList.length; i++) {
                        const p = rootList[i];
                        const child = getChild(rootNode, p, 1);
                        let v;
                        if (i > 0 && Number.isFinite(maximizeRoot ? curAlpha : curBeta)) {
                            v = maximizeRoot
                                ? visit(child, depth - 1, 1, curAlpha, Math.min(curBeta, curAlpha + 0.000001), 2, 2)
                                : visit(child, depth - 1, 1, Math.max(curAlpha, curBeta - 0.000001), curBeta, 2, 2);
                            if (v > curAlpha && v < curBeta)
                                v = visit(child, depth - 1, 1, curAlpha, curBeta, 2, 2);
                        }
                        else {
                            v = visit(child, depth - 1, 1, curAlpha, curBeta, 2, 2);
                        }
                        nextScores.set(p, v);
                        if (best < 0 || (maximizeRoot ? v > value : v < value)) {
                            best = p;
                            value = v;
                        }
                        if (maximizeRoot)
                            curAlpha = Math.max(curAlpha, value);
                        else
                            curBeta = Math.min(curBeta, value);
                        if (curAlpha >= curBeta)
                            break;
                    }
                    if (Number.isFinite(alpha) && value <= alpha) {
                        if (!maximizeRoot && best >= 0 && rootList[0] !== best) {
                            const pos = rootList.indexOf(best);
                            if (pos > 0) {
                                for (let j = pos; j > 0; j--)
                                    rootList[j] = rootList[j - 1];
                                rootList[0] = best;
                            }
                        }
                        alpha = delta >= 3000 ? -Infinity : alpha - delta;
                        delta *= 4;
                        continue;
                    }
                    if (Number.isFinite(beta) && value >= beta) {
                        if (maximizeRoot && best >= 0 && rootList[0] !== best) {
                            const pos = rootList.indexOf(best);
                            if (pos > 0) {
                                for (let j = pos; j > 0; j--)
                                    rootList[j] = rootList[j - 1];
                                rootList[0] = best;
                            }
                        }
                        beta = delta >= 3000 ? Infinity : beta + delta;
                        delta *= 4;
                        continue;
                    }
                    break;
                }
                if (best >= 0) {
                    rootScores = nextScores;
                    bestCode = best;
                    lastScore = value;
                    bestScore = value;
                    completedDepth = depth;
                    preferred.set(rootState, best);
                    if (ctrl) {
                        const prevD = Atomics.load(ctrl, CTRL_MAX_DEPTH);
                        if (depth > prevD)
                            Atomics.store(ctrl, CTRL_MAX_DEPTH, depth);
                    }
                    if (onProgress && !isHelper) {
                        const el = elapsed();
                        lastProgressMs = el;
                        publishNodes();
                        onProgress({ nodes, totalNodes: sumAllNodes(), depth, elapsedMs: el, score: bestScore, bestCode });
                    }
                }
                if (Math.abs(value) >= 1000000000) {
                    if (fullWidth) {
                        stopReason = value * (maximizeRoot ? 1 : -1) > 0 ? "secured-line" : "max-depth";
                        break;
                    }
                    fullWidth = true;
                    depth = Math.min(depth, 4) - 1;
                }
            }
        }
        catch (e) {
            if (e instanceof LimitStop)
                stopReason = e.reason === "depth" ? "max-depth" : e.reason;
            else
                throw e;
        }
        finally {
            maxAllowedNodes = hardNodeCap;
            curTimeLimit = isPonder ? 3600000 : budget.timeMs;
        }
        // 3. Root tactical refutation guard (4-6 ply forced-reply check, main search thread only)
        if (!isHelper && !isPonder && rootState.phase === 2 && !allLost && budget.maxDepth >= 4 && nodes < hardNodeCap && elapsed() < budget.timeMs - 50) {
            const choices = allowed.slice().sort((a, b) => {
                if (a === bestCode)
                    return b === bestCode ? 0 : -1;
                if (b === bestCode)
                    return 1;
                const va = rootScores.get(a) ?? 0, vb = rootScores.get(b) ?? 0;
                const cmp = maximizeRoot ? vb - va : va - vb;
                return cmp !== 0 ? cmp : tieRanks[b] - tieRanks[a];
            });
            const original = bestCode;
            let refutedCount = 0;
            try {
                for (const cand of choices) {
                    bestCode = cand;
                    const localLimit = Math.min(6000, hardNodeCap - nodes);
                    if (localLimit <= 0)
                        break;
                    const ceiling = nodes + localLimit;
                    const prevM = maxAllowedNodes;
                    maxAllowedNodes = Math.min(prevM, ceiling);
                    let lost = false;
                    try {
                        lost = refuteAt(rootState, cand, 0, ceiling);
                    }
                    catch (e) {
                        if (e instanceof LimitStop && e.reason === "nodes")
                            lost = false;
                        else
                            throw e;
                    }
                    finally {
                        maxAllowedNodes = prevM;
                    }
                    if (!lost)
                        break;
                    refutedCount++;
                }
            }
            catch (e) {
                if (e instanceof LimitStop) {
                    if (e.reason === "cancelled")
                        return finish("cancelled");
                }
                else
                    throw e;
            }
            if (refutedCount === choices.length)
                bestCode = original;
        }
        return finish(stopReason);
    }
    catch (e) {
        if (e instanceof LimitStop) {
            return finish(e.reason === "depth" ? "max-depth" : e.reason);
        }
        return finish("internal");
    }
}
