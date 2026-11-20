import type { Match } from "../../core/src/types.js";
import type { AIResult } from "./types.js";
import type { SearchEnvelope } from "./protocol.js";
import type { SearchOutcome } from "./search.js";
export declare const SHARED_TT_STRIDE = 10;
export declare const CTRL_JOB_SEQ = 0;
export declare const CTRL_MAX_DEPTH = 16;
export declare const CTRL_ACTIVE_WORKERS = 32;
export declare const CTRL_TT_GEN = 48;
export declare const CTRL_THREAD_COUNT = 64;
export declare const CTRL_NODES_BASE = 80;
export declare const CTRL_NODES_STRIDE = 16;
export declare const CTRL_BUFFER_BYTES = 2048;
export interface V21ProgressInfo {
    readonly nodes: number;
    readonly totalNodes: number;
    readonly depth: number;
    readonly elapsedMs: number;
    readonly score: number | null;
    readonly bestCode: number;
}
export interface V21RuntimeOptions {
    readonly sharedTT?: Int32Array;
    readonly sharedTTMask?: number;
    readonly control?: Int32Array;
    readonly jobSeq?: number;
    readonly threadId?: number;
    readonly keepTT?: boolean;
    readonly fullPower?: boolean;
    readonly ponder?: boolean;
    readonly onProgress?: (info: V21ProgressInfo) => void;
}
export declare function isV21Profile(match: Match): boolean;
export declare function runV21Search(header: SearchEnvelope, match: Match, now: () => number, cancelled: () => boolean, started: number, initialLastTime?: number, opts?: V21RuntimeOptions): AIResult<SearchOutcome>;
