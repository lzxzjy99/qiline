import { fail, keysAre, ok, plain } from "./result.js";
export const RULES_VERSION = "2.1.0-r3";
export const BOARD_SIZES = Object.freeze([9, 13, 15, 19]);
export const DELAYS = Object.freeze([0, 2, 4, 6, 8, 10, 12]);
export const DEFAULT_RULES = Object.freeze({ rulesVersion: RULES_VERSION, boardSize: 9,
    swap3: true, confirmationDelay: 4, superko: "positional", directions: "diagonal", claimMode: "fixed-five" });
const FIELDS = Object.keys(DEFAULT_RULES);
export function validateRules(input) {
    if (!plain(input))
        return fail("INVALID_RULES");
    if (Object.hasOwn(input, "rulesVersion") && input.rulesVersion !== RULES_VERSION)
        return fail("UNSUPPORTED_VERSION", "rules.rulesVersion");
    if (!keysAre(input, FIELDS) || !BOARD_SIZES.includes(input.boardSize)
        || !DELAYS.includes(input.confirmationDelay) || typeof input.swap3 !== "boolean"
        || !["positional", "off"].includes(input.superko)
        || !["diagonal", "four"].includes(input.directions)
        || !["fixed-five", "color-pressure"].includes(input.claimMode))
        return fail("INVALID_RULES");
    return ok(Object.freeze({ rulesVersion: RULES_VERSION, boardSize: input.boardSize,
        swap3: input.swap3, confirmationDelay: input.confirmationDelay,
        superko: input.superko, directions: input.directions,
        claimMode: input.claimMode }));
}
export function configIdOf(rules) {
    return [rules.rulesVersion, rules.boardSize, rules.confirmationDelay, rules.swap3 ? 1 : 0, rules.directions, rules.superko, rules.claimMode].join("/");
}
export function allRuleConfigurations() {
    const result = [];
    for (const boardSize of BOARD_SIZES)
        for (const confirmationDelay of DELAYS)
            for (const swap3 of [false, true])
                for (const directions of ["diagonal", "four"])
                    for (const superko of ["positional", "off"])
                        for (const claimMode of ["fixed-five", "color-pressure"])
                            result.push(Object.freeze({ rulesVersion: RULES_VERSION, boardSize, confirmationDelay, swap3, directions, superko, claimMode }));
    return Object.freeze(result);
}
//# sourceMappingURL=rules.js.map