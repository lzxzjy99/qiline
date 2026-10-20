import type { ErrorCode, Result } from "./types.js";
export const ok = <T>(value: T): Result<T> => Object.freeze({ ok: true, value });
export function fail<T = never>(code: ErrorCode, path?: string, cause?: ErrorCode): Result<T> {
  return Object.freeze({ ok: false, error: Object.freeze({ code, messageKey: `errors.${code}`,
    ...(path === undefined ? {} : { path }), ...(cause === undefined ? {} : { cause }) }) });
}
export function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
export function keysAre(value: Record<string, unknown>, fields: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === fields.length && fields.every(key => Object.hasOwn(value, key));
}
/** Only called on freshly-owned acyclic data, never an external match object. */
export function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
