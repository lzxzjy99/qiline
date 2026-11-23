import type { Match } from "../../core/src/types.js";
import type { AIResult } from "./types.js";
import type { SearchEnvelope } from "./protocol.js";
import type { SearchOutcome } from "./search.js";
/**
 * Ultra-low-latency, ultra-low-memory (~1.44 MB RAM) Lite NNUE search for Easy & Standard modes
 * on 9x9 default rules. Returns null to fall back cleanly on edge budgets (e.g. maxNodes <= 2).
 */
export declare function runV27LiteSearch(header: SearchEnvelope, match: Match, now: () => number, cancelled: () => boolean, started: number, lastTime: number): AIResult<SearchOutcome> | null;
