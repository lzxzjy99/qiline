import type { Color, Match, PlayerId } from "../../core/src/types.js";
import type { GroupTable } from "../../core/src/geometry.js";
interface Lines {
    readonly potential: number;
    readonly completions: readonly number[];
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
export declare function rescuedStones(before: Match, after: Match, color: Color): number;
/** Every global atari liberty is retained, including remote captures of stones belonging to a five. */
export declare function capturePoints(match: Match, by: Color): readonly number[];
export declare function centerDistance(point: number, n: number): number;
export declare function openingValue(before: Match, after: Match, point: number): number;
export declare function localSupport(match: Match, point: number, color: Color): number;
export {};
