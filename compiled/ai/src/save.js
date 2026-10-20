import { plain } from "../../core/src/result.js";
import { restoreSession } from "../../session/src/session.js";
import { aiFail, aiOK } from "./protocol.js";
/** First-release human-facing modes; AI-v-AI benchmarks can get a separate host later. */
export function playModeOf(state) {
    const count = Object.values(state.controllers).filter(c => c.kind === "ai").length;
    if (count === 0)
        return aiOK("pvp");
    return count === 1 && !state.competitive ? aiOK("practice") : aiFail("AI_MODE_UNSUPPORTED");
}
/** Accept the existing SessionSave v1 or raw MatchRecord. Web player metadata stays in the UI adapter. */
export function restorePlayableSession(matchId, input) {
    let raw = input;
    if (typeof raw === "string") {
        try {
            raw = JSON.parse(raw);
        }
        catch {
            return aiFail("INVALID_RECORD");
        }
    }
    if (plain(raw) && Object.hasOwn(raw, "schemaVersion"))
        raw = { sessionSchemaVersion: 1, record: raw,
            controllers: { A: { kind: "human" }, B: { kind: "human" } }, competitive: false };
    const restored = restoreSession(matchId, raw);
    if (!restored.ok)
        return restored;
    const mode = playModeOf(restored.value.state);
    if (!mode.ok)
        return mode;
    return aiOK(Object.freeze({ session: restored.value, mode: mode.value }));
}
