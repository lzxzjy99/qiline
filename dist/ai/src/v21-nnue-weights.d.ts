export declare const NNUE_IN_SPARSE = 886;
export declare const NNUE_IN_DENSE = 16;
export declare const NNUE_H1 = 64;
export declare const NNUE_H2 = 16;
export declare const NNUE_BLEND_ALPHA = 0.6499999761581421;
export declare const NNUE_SCORE_SCALE = 2200;
export declare const NNUE_SOURCE_SHA256 = "c1b1eb2bc91c23a2b232cdfc06a2449e690d7def3476a7edc77836d1fe713059";
export interface NnueWeights {
    readonly w1s: Float32Array;
    readonly w1d: Float32Array;
    readonly b1: Float32Array;
    readonly w2: Float32Array;
    readonly b2: Float32Array;
    readonly w3: Float32Array;
    readonly b3: number;
}
export declare function getNnueWeights(): NnueWeights;
