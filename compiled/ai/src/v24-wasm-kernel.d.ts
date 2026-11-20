export interface WasmSearchCallbacks {
    readonly nowMs: () => number;
    readonly pollStatus: (nodes: number, depth: number, score: number, bestCode: number, forceProgress: number) => number;
    readonly ttProbe: (keyLo: number, keyHi: number, b0: number, b1: number, b2: number, w0: number, w1: number, w2: number, activeClaims: number, rem: number, qleft: number, ttSafe: number, ioOut: Float64Array) => number;
    readonly ttStore: (keyLo: number, keyHi: number, b0: number, b1: number, b2: number, w0: number, w1: number, w2: number, activeClaims: number, rem: number, qleft: number, ttSafe: number, val: number, move: number, bnd: number) => void;
}
export interface WasmSearchResult {
    readonly bestCode: number;
    readonly score: number;
    readonly nodes: number;
    readonly completedDepth: number;
    readonly maxVisitedDepth: number;
    readonly cutoffs: number;
    readonly rootCandidates: number;
    readonly stopCode: number;
}
export declare function warmupV24WasmKernel(): boolean;
export declare function runV24WasmSearch(swap3: boolean, moveCodes: readonly number[], nodeBudget: number, timeMs: number, maxDepth: number, seed: number, flags: number, threadId: number, callbacks: WasmSearchCallbacks): WasmSearchResult | null;
