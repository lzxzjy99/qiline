import { runSearch } from "./search.js";
import { readSearchEnvelope } from "./protocol.js";
const scope = globalThis;
let used = false;
scope.onmessage = event => {
    if (used)
        return;
    used = true;
    try {
        const result = runSearch(event.data);
        if (result.ok)
            scope.postMessage(result.value.reply);
        else {
            const header = readSearchEnvelope(event.data);
            if (!header.ok)
                throw Error("Invalid AI worker request");
            scope.postMessage({ protocolVersion: 1, kind: "result", context: header.value.context, status: "failed", reason: "internal",
                stats: { elapsedMs: 0, nodes: 0, completedDepth: 0 } });
        }
    }
    finally {
        scope.close();
    }
};
scope.onmessageerror = () => { throw Error("AI worker message could not be decoded"); };
scope.postMessage({ protocolVersion: 1, kind: "ready" });
