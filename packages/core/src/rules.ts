import type { BoardSize, ConfirmationDelay, RuleConfig, Result } from "./types.js";
import { fail, keysAre, ok, plain } from "./result.js";
export const RULES_VERSION = "2.1.0-r3" as const;
export const BOARD_SIZES = Object.freeze([9,13,15,19] as const);
export const DELAYS = Object.freeze([0,2,4,6,8,10,12] as const);
export const DEFAULT_RULES: RuleConfig = Object.freeze({ rulesVersion: RULES_VERSION, boardSize: 9,
  swap3: true, confirmationDelay: 4, superko: "positional", directions: "diagonal", claimMode: "fixed-five" });
const FIELDS = Object.keys(DEFAULT_RULES);
export function validateRules(input: unknown): Result<RuleConfig> {
  if (!plain(input)) return fail("INVALID_RULES");
  if (Object.hasOwn(input,"rulesVersion") && input.rulesVersion !== RULES_VERSION) return fail("UNSUPPORTED_VERSION","rules.rulesVersion");
  if (!keysAre(input,FIELDS) || !BOARD_SIZES.includes(input.boardSize as BoardSize)
    || !DELAYS.includes(input.confirmationDelay as ConfirmationDelay) || typeof input.swap3 !== "boolean"
    || !["positional","off"].includes(input.superko as string)
    || !["diagonal","four"].includes(input.directions as string)
    || !["fixed-five","color-pressure"].includes(input.claimMode as string)) return fail("INVALID_RULES");
  return ok(Object.freeze({ rulesVersion: RULES_VERSION, boardSize: input.boardSize as BoardSize,
    swap3: input.swap3, confirmationDelay: input.confirmationDelay as ConfirmationDelay,
    superko: input.superko as RuleConfig["superko"], directions: input.directions as RuleConfig["directions"],
    claimMode: input.claimMode as RuleConfig["claimMode"] }));
}
export function configIdOf(rules: RuleConfig): string {
  return [rules.rulesVersion,rules.boardSize,rules.confirmationDelay,rules.swap3?1:0,rules.directions,rules.superko,rules.claimMode].join("/");
}
export function allRuleConfigurations(): readonly RuleConfig[] {
  const result: RuleConfig[] = [];
  for (const boardSize of BOARD_SIZES) for (const confirmationDelay of DELAYS) for (const swap3 of [false,true])
    for (const directions of ["diagonal","four"] as const) for (const superko of ["positional","off"] as const)
      for (const claimMode of ["fixed-five","color-pressure"] as const)
        result.push(Object.freeze({ rulesVersion:RULES_VERSION,boardSize,confirmationDelay,swap3,directions,superko,claimMode }));
  return Object.freeze(result);
}
