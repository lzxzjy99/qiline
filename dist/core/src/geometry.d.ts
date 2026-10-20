import type { Cell, Color, Point, Result } from "./types.js";
export declare const cellOf: (color: Color) => 1 | -1;
export declare const colorOf: (cell: 1 | -1) => Color;
export declare const other: (color: Color) => Color;
export declare const validPoint: (p: unknown, n: number) => p is number;
export declare function neighborsFor(n: number): readonly (readonly number[])[];
export interface GeometricGroup {
    readonly stones: readonly number[];
    readonly liberties: ReadonlySet<number>;
    readonly color: 1 | -1;
}
export interface GroupTable {
    readonly at: readonly (GeometricGroup | undefined)[];
    readonly groups: readonly GeometricGroup[];
}
export declare function collectGroups(board: readonly Cell[], n: number): GroupTable;
export declare function geometryPossible(board: readonly Cell[], p: Point, color: Color, n: number, table: GroupTable): boolean;
export interface Placement {
    readonly board: Cell[];
    readonly captured: number[];
}
/** Low-level geometry, not a match loader. Requires a valid board with no dead groups. */
export declare function simulatePlacement(board: readonly Cell[], p: unknown, color: Color, n: number, table?: GroupTable): Result<Placement>;
export declare const positionKey: (board: readonly Cell[]) => string;
export declare function parsePoint(text: unknown, n: number): Result<Point>;
export declare function formatPoint(p: Point, n: number): string;
