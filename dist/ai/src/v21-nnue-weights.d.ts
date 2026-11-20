export declare const NNUE_VERSION = 3;
export declare const NNUE_IN_SPARSE = 886;
export declare const NNUE_IN_DENSE = 24;
export declare const NNUE_H1 = 128;
export declare const NNUE_H2 = 16;
export declare const NNUE_NUM_BUCKETS = 4;
export declare const NNUE_BLEND_ALPHA = 0.88;
export declare const NNUE_CLAIM_BLEND_ALPHA = 0.5;
export declare const NNUE_SCORE_SCALE = 2200;
export declare function decodeBase64(b64: string): Uint8Array;
export interface NnueWeights {
    readonly w1s: Float32Array;
    readonly w1d: Float32Array;
    readonly b1: Float32Array;
    readonly w2: Float32Array;
    readonly b2: Float32Array;
    readonly w3: Float32Array;
    readonly b3: Float32Array;
}
export declare function getNnueWeights(): NnueWeights;
export declare function getNnueBinary(): Uint8Array;
