import type { Match } from "../../core/src/types.js";
import type { AIResult } from "./types.js";
import type { SearchEnvelope } from "./protocol.js";
import type { SearchOutcome } from "./search.js";
export declare function isV21Profile(match: Match): boolean;
export declare function runV21Search(header: SearchEnvelope, match: Match, now: () => number, cancelled: () => boolean, started: number, initialLastTime?: number): AIResult<SearchOutcome>;
