import type { PlayerId } from "../../core/src/types.js";
export interface TreeAdapter<N, M> {
    readonly check: () => void;
    readonly terminal: (node: N) => boolean;
    readonly player: (node: N) => PlayerId | null;
    readonly evaluate: (node: N) => number;
    readonly children: (node: N) => Iterable<{
        readonly move: M;
        readonly node: N;
    }>;
    readonly cutoff: (node: N, move: M, depth: number) => void;
    readonly extend?: (node: N) => boolean;
}
export interface TreeValue<M> {
    readonly value: number;
    readonly variation: readonly M[];
}
/** No negamax sign flipping: the same real player may act on consecutive commands. */
export declare function alphaBeta<N, M>(node: N, depth: number, root: PlayerId, tree: TreeAdapter<N, M>, alpha?: number, beta?: number): TreeValue<M>;
