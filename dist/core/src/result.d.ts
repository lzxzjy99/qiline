import type { ErrorCode, Result } from "./types.js";
export declare const ok: <T>(value: T) => Result<T>;
export declare function fail<T = never>(code: ErrorCode, path?: string, cause?: ErrorCode): Result<T>;
export declare function plain(value: unknown): value is Record<string, unknown>;
export declare function keysAre(value: Record<string, unknown>, fields: readonly string[]): boolean;
/** Only called on freshly-owned acyclic data, never an external match object. */
export declare function freeze<T>(value: T): T;
