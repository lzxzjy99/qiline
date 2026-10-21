import type { Color, Match, PlayerId } from "../../core/src/types.js";
import type { GroupTable } from "../../core/src/geometry.js";
interface Lines {
    readonly potential: number;
    readonly completions: readonly number[];
    readonly pressure: number;
    readonly moves: readonly number[];
    /** Geometric four-making moves; forks have two distinct follow-up completion points. */
    readonly forcing: readonly number[];
    readonly forks: readonly number[];
    readonly claimSafety: number;
    readonly lineStones: ReadonlySet<number>;
}
interface Features {
    readonly groups: GroupTable;
    readonly black: Lines;
    readonly white: Lines;
}
export declare function featuresOf(match: Match): Features;
export declare const otherColor: (color: Color) => Color;
export declare function playerColor(match: Match, actor: PlayerId): Color | null;
export declare function claimPressure(match: Match, color: Color): number;
export declare function colorValue(match: Match, color: Color): number;
/** Search evaluation only; geometric threats never adjudicate legality or a win. */
export declare function strategicValue(match: Match, color: Color): number;
export declare function rescuedStones(before: Match, after: Match, color: Color): number;
/** Every global atari liberty is retained, including remote captures of stones belonging to a five. */
export declare function capturePoints(match: Match, by: Color): readonly number[];
export declare function centerDistance(point: number, n: number): number;
export declare function openingValue(before: Match, after: Match, point: number): number;
export declare function localSupport(match: Match, point: number, color: Color): number;
export {};
