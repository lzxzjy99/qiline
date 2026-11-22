export declare const NNUE_VERSION = 4;
export declare const NNUE_IN_SPARSE = 1638;
export declare const NNUE_IN_DENSE = 16;
export declare const NNUE_H1 = 192;
export declare const NNUE_H2 = 32;
export declare const NNUE_H3 = 16;
export declare const NNUE_NUM_BUCKETS = 4;
export declare const NNUE_FLAGS = 0;
export declare const NNUE_BLEND_ALPHA = 1;
export declare const NNUE_CLAIM_BLEND_ALPHA = 1;
export declare const NNUE_SCORE_SCALE = 2200;
export declare function decodeBase64(b64: string): Uint8Array;
export interface NnueWeights {
    readonly w1s: Float32Array;
    readonly w1d: Float32Array;
    readonly b1: Float32Array;
    readonly w2: Float32Array;
    readonly b2: Float32Array;
    readonly w2b: Float32Array;
    readonly b2b: Float32Array;
    readonly w3: Float32Array;
    readonly b3: Float32Array;
}
export declare function getNnueWeights(): NnueWeights;
export declare function getNnueBinary(): Uint8Array;
