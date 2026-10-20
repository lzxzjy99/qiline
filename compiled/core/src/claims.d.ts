import type { Cell, Claim, RuleConfig } from "./types.js";
export declare function presentClaims(board: readonly Cell[], rules: RuleConfig): ReadonlyMap<string, Pick<Claim, "id" | "color" | "points">>;
