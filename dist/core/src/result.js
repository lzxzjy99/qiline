export const ok = (value) => Object.freeze({ ok: true, value });
export function fail(code, path, cause) {
    return Object.freeze({ ok: false, error: Object.freeze({ code, messageKey: `errors.${code}`,
            ...(path === undefined ? {} : { path }), ...(cause === undefined ? {} : { cause }) }) });
}
export function plain(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
export function keysAre(value, fields) {
    const keys = Object.keys(value);
    return keys.length === fields.length && fields.every(key => Object.hasOwn(value, key));
}
/** Only called on freshly-owned acyclic data, never an external match object. */
export function freeze(value) {
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
        for (const child of Object.values(value))
            freeze(child);
        Object.freeze(value);
    }
    return value;
}
//# sourceMappingURL=result.js.map