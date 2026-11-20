// Persistent warm multi-core Lazy SMP worker for Qiline v21 (browser & Electron).
// Keeps V8 JIT warm, NNUE weights decoded, and shares a lock-free SharedArrayBuffer TT across cores.
import { runSearchWithRuntime } from "./search.js";
import { readSearchEnvelope } from "./protocol.js";
import { CTRL_ACTIVE_WORKERS, CTRL_JOB_SEQ, SHARED_TT_STRIDE } from "./v21-engine.js";
import { getNnueWeights } from "./v21-nnue-weights.js";
import { warmupV24WasmKernel } from "./v24-wasm-kernel.js";
const scope = globalThis;
let threadId = 0;
let sharedTT = null;
let sharedTTMask = 0;
let control = null;
// Pre-decode NNUE weights and compile WASM SIMD128 kernel on worker startup so first move has zero latency
try {
    getNnueWeights();
    warmupV24WasmKernel();
}
catch { }
scope.onmessage = event => {
    const msg = event.data;
    if (!msg || typeof msg !== "object" || !("kind" in msg))
        return;
    if (msg.kind === "smp-init") {
        threadId = msg.threadId | 0;
        if (msg.sharedTTBuf && msg.sharedTTSlots > 0 && (msg.sharedTTSlots & (msg.sharedTTSlots - 1)) === 0) {
            sharedTT = new Int32Array(msg.sharedTTBuf, 0, msg.sharedTTSlots * SHARED_TT_STRIDE);
            sharedTTMask = msg.sharedTTSlots - 1;
        }
        else {
            sharedTT = null;
            sharedTTMask = 0;
        }
        control = msg.controlBuf ? new Int32Array(msg.controlBuf) : null;
        scope.postMessage({ kind: "smp-ready", threadId });
        return;
    }
    if (msg.kind === "smp-run") {
        const { jobSeq, request, fullPower, ponder, keepTT } = msg;
        if (control && Atomics.load(control, CTRL_JOB_SEQ) !== jobSeq) {
            scope.postMessage({ kind: "smp-done", threadId, jobSeq, reply: null });
            return;
        }
        if (control)
            Atomics.add(control, CTRL_ACTIVE_WORKERS, 1);
        try {
            const opts = {
                ...(sharedTT ? { sharedTT, sharedTTMask } : {}),
                ...(control ? { control, jobSeq } : {}),
                threadId,
                keepTT,
                fullPower,
                ponder,
                ...(threadId === 0 && !ponder ? {
                    onProgress: (info) => {
                        scope.postMessage({ kind: "smp-progress", jobSeq, ...info });
                    },
                } : {}),
            };
            const result = runSearchWithRuntime(request, {}, opts);
            if (threadId === 0 && !ponder) {
                // Stop all helper workers immediately once main thread finishes
                if (control)
                    Atomics.compareExchange(control, CTRL_JOB_SEQ, jobSeq, -1);
                if (result.ok) {
                    scope.postMessage({ kind: "smp-done", threadId, jobSeq, reply: result.value.reply });
                }
                else {
                    const header = readSearchEnvelope(request);
                    const fallback = header.ok
                        ? { protocolVersion: 1, kind: "result", context: header.value.context, status: "failed", reason: "internal", stats: { elapsedMs: 0, nodes: 0, completedDepth: 0 } }
                        : null;
                    scope.postMessage({ kind: "smp-done", threadId, jobSeq, reply: fallback });
                }
            }
            else {
                scope.postMessage({ kind: "smp-done", threadId, jobSeq, reply: null });
            }
        }
        catch {
            if (threadId === 0 && !ponder) {
                if (control)
                    Atomics.compareExchange(control, CTRL_JOB_SEQ, jobSeq, -1);
                const header = readSearchEnvelope(request);
                const fallback = header.ok
                    ? { protocolVersion: 1, kind: "result", context: header.value.context, status: "failed", reason: "internal", stats: { elapsedMs: 0, nodes: 0, completedDepth: 0 } }
                    : null;
                scope.postMessage({ kind: "smp-done", threadId, jobSeq, reply: fallback });
            }
            else {
                scope.postMessage({ kind: "smp-done", threadId, jobSeq, reply: null });
            }
        }
        finally {
            if (control)
                Atomics.sub(control, CTRL_ACTIVE_WORKERS, 1);
        }
    }
};
scope.onmessageerror = () => {
    throw Error("SMP AI worker message could not be decoded");
};
scope.postMessage({ kind: "smp-boot" });
