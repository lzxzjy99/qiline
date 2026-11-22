export interface WasmSearchCallbacks {
    nowMs: () => number;
    pollStatus: (nodes: number, depth: number, score: number, bestCode: number, forceProgress: number) => number;
    ttProbe: (kl: number, kh: number, b0: number, b1: number, b2: number, w0: number, w1: number, w2: number, ac: number, rem: number, ql: number, ts: number, outIo: Float64Array) => number;
    ttStore: (kl: number, kh: number, b0: number, b1: number, b2: number, w0: number, w1: number, w2: number, ac: number, rem: number, ql: number, ts: number, val: number, mv: number, bnd: number) => void;
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
