import type { RuleConfig, Result } from "./types.js";
export declare const RULES_VERSION: "2.1.0-r3";
export declare const BOARD_SIZES: readonly [9, 13, 15, 19];
export declare const DELAYS: readonly [0, 2, 4, 6, 8, 10, 12];
export declare const DEFAULT_RULES: RuleConfig;
export declare function validateRules(input: unknown): Result<RuleConfig>;
export declare function configIdOf(rules: RuleConfig): string;
export declare function allRuleConfigurations(): readonly RuleConfig[];
