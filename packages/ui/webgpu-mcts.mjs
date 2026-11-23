// Zero-dependency WebGPU GPU MCTS Runtime for Qiline v0.13.0 (Gen-8 v27-pro12 12b x 128ch 28-plane FP16 + qiline_v27_mcts.wasm)
// Automatically benchmarks GPU at startup (>= 1,200 boards/s gate); gracefully returns unavailable on weak/software GPUs.

import { AI_PROTOCOL_VERSION } from "../ai/src/index.js";
import { WebGpuResNet } from "./webgpu-resnet.mjs";

const GPU_CACHE_NAME = "qiline-v27-gpu-v1";
const MIN_BOARDS_PER_SEC = 1200;

let initPromise = null;
let runtime = null; // { gpu, mex, boardsPerSec, batchSize, gpuLabel } | { unavailable: true, reason }

function actionToMoveCode(act) {
  if (!act) return -1;
  if (act.kind === "place" && Number.isInteger(act.point)) return act.point;
  if (act.kind === "pass") return 81;
  if (act.kind === "choose-color") return act.color === "black" ? 82 : 83;
  return -1;
}

function moveCodeToAction(code, actor) {
  if (code >= 0 && code < 81) return { kind: "place", actor, point: code };
  if (code === 81) return { kind: "pass", actor };
  if (code === 82) return { kind: "choose-color", actor, color: "black" };
  if (code === 83) return { kind: "choose-color", actor, color: "white" };
  return null;
}

async function loadBinaryAsset(fileName) {
  // 1. Electron Desktop: read directly via secure allowlisted IPC (preserves CSP connect-src 'none')
  if (typeof window !== "undefined" && typeof window.qilineDesktop?.readEngineAsset === "function") {
    const u8 = await window.qilineDesktop.readEngineAsset(fileName);
    if (!u8 || !u8.byteLength) throw new Error(`IPC readEngineAsset empty: ${fileName}`);
    return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  }
  // 2. Web (Cloudflare Pages / GitHub Pages): lazy-fetch with Cache API persistence
  const url = new URL(`../assets/${fileName}`, import.meta.url).href;
  if (typeof caches !== "undefined" && typeof caches.open === "function") {
    try {
      const cache = await caches.open(GPU_CACHE_NAME);
      const hit = await cache.match(url);
      if (hit && hit.ok) return await hit.arrayBuffer();
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${fileName}`);
      try { await cache.put(url, resp.clone()); } catch {}
      return await resp.arrayBuffer();
    } catch {}
  }
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${fileName}`);
  return await resp.arrayBuffer();
}

function formatGpuLabel(info, boardsPerSec, useF16) {
  const parts = [];
  if (info?.description) parts.push(info.description);
  else if (info?.vendor || info?.architecture) {
    parts.push([info.vendor, info.architecture].filter(Boolean).join(" ").toUpperCase());
  }
  const tag = parts[0] || "WebGPU";
  const prec = useF16 ? " FP16" : "";
  return `${tag}${prec} (${Math.round(boardsPerSec).toLocaleString()} b/s)`;
}

export function getWebGpuMctsStatus() {
  if (!runtime) return { ready: false, pending: !!initPromise, available: false };
  if (runtime.unavailable) return { ready: true, pending: false, available: false, reason: runtime.reason };
  return {
    ready: true,
    pending: false,
    available: true,
    useF16: !!runtime.gpu?.useF16,
    boardsPerSec: runtime.boardsPerSec,
    batchSize: runtime.batchSize,
    gpuLabel: runtime.gpuLabel,
  };
}

export function initWebGpuMcts() {
  if (runtime) return Promise.resolve(runtime);
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      if (typeof navigator === "undefined" || !navigator.gpu) {
        runtime = { unavailable: true, reason: "no-webgpu" };
        return runtime;
      }
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
      if (!adapter) {
        runtime = { unavailable: true, reason: "no-adapter" };
        return runtime;
      }
      const [qgpuAb, mctsWasmAb] = await Promise.all([
        loadBinaryAsset("qiline-v27-pro.qgpu"),
        loadBinaryAsset("qiline_v27_mcts.wasm"),
      ]);
      const gpu = await WebGpuResNet.create(qgpuAb, { powerPreference: "high-performance" });
      // 100ms startup micro-benchmark to gate WebGPU automatically
      const bm = await gpu.benchmark(32, 4);
      if (!Number.isFinite(bm.boardsPerSec) || bm.boardsPerSec < MIN_BOARDS_PER_SEC) {
        gpu.dispose();
        runtime = { unavailable: true, reason: `too-slow:${Math.round(bm.boardsPerSec || 0)}` };
        return runtime;
      }
      const { instance } = await WebAssembly.instantiate(mctsWasmAb, {});
      const mex = instance.exports;
      mex.mcts_init();
      const batchSize = bm.boardsPerSec >= 6000 ? 48 : bm.boardsPerSec >= 2500 ? 32 : 16;
      runtime = {
        unavailable: false,
        gpu,
        mex,
        boardsPerSec: bm.boardsPerSec,
        batchSize,
        gpuLabel: formatGpuLabel(gpu.adapterInfo, bm.boardsPerSec, gpu.useF16),
      };
      return runtime;
    } catch (err) {
      runtime = { unavailable: true, reason: err?.message || "init-failed" };
      return runtime;
    }
  })();
  return initPromise;
}

// Serialized GPU search lock (one active GPU search at a time)
let activeSearchCancel = null;

export function runWebGpuMctsSearch(request, { perfMode = "turbo", onProgress = null } = {}) {
  let cancelled = false;
  const cancel = () => { cancelled = true; };

  const promise = (async () => {
    const rt = await initWebGpuMcts();
    if (rt.unavailable || cancelled) {
      return { ok: false, fallback: !cancelled, cancelled };
    }
    if (activeSearchCancel) {
      try { activeSearchCancel(); } catch {}
    }
    activeSearchCancel = cancel;

    const t0 = performance.now();
    try {
      const { gpu, mex, batchSize, gpuLabel } = rt;
      const record = request?.record;
      const actor = request?.context?.actor;
      const swap3 = record?.rules?.swap3 !== false;
      const actions = Array.isArray(record?.actions) ? record.actions : [];
      const moveCodes = [];
      for (const act of actions) {
        const c = actionToMoveCode(act);
        if (c >= 0) moveCodes.push(c);
      }
      if (moveCodes.length > 512) return { ok: false, fallback: true };

      // Smart Grandmaster time allocation (snappy in turbo, deep 100k+ sims in extreme)
      const reqTime = Number(request?.budget?.timeMs) || 120000;
      const baseMs = perfMode === "extreme" ? 10000 : 3500;
      const targetMs = Math.max(200, Math.min(baseMs, reqTime - 150));

      const mvView = new Int32Array(mex.memory.buffer, mex.mcts_moves_ptr(), Math.max(1, moveCodes.length));
      for (let i = 0; i < moveCodes.length; i++) mvView[i] = moveCodes[i];

      const seed = (Number(request?.seed) >>> 0) || 1;
      let bn = mex.mcts_begin(swap3 ? 1 : 0, moveCodes.length, batchSize, seed);
      if (bn < 0) return { ok: false, fallback: true };

      let lastProg = t0;
      while (bn > 0 && !cancelled) {
        const elapsed = performance.now() - t0;
        if (elapsed >= targetMs) break;

        const boardsU8 = new Uint8Array(mex.memory.buffer, mex.mcts_boards_ptr(), bn * 81);
        const denseF32 = new Float32Array(mex.memory.buffer, mex.mcts_dense_ptr(), bn * 16);
        const lpI8 = new Int8Array(mex.memory.buffer, mex.mcts_lp_ptr(), bn);
        const outVal = new Float32Array(mex.memory.buffer, mex.mcts_val_ptr(), bn);
        const outPol = new Float32Array(mex.memory.buffer, mex.mcts_pol_ptr(), bn * 82);

        await gpu.evalBatch(bn, boardsU8, denseF32, lpI8, outVal, outPol);
        if (cancelled) break;

        bn = mex.mcts_step_batch(bn);
        const now = performance.now();
        if (onProgress && now - lastProg >= 120) {
          lastProg = now;
          const stats = new Float64Array(mex.memory.buffer, mex.mcts_stats_ptr(), 9);
          const el = Math.max(1, now - t0);
          const sims = Math.round(stats[2]);
          onProgress({
            backend: "webgpu",
            gpuLabel,
            totalNodes: sims,
            sims,
            depth: Math.max(1, Math.round(stats[8] || 1)),
            nps: Math.round((sims * 1000) / el),
            elapsedMs: el,
            score: Number.isFinite(stats[1]) ? stats[1] : null,
            bestCode: Math.round(stats[0]),
            batches: Math.round(stats[3]),
            cacheHits: Math.round(stats[4]),
          });
        }
      }

      if (cancelled) {
        return {
          ok: true,
          reply: {
            protocolVersion: AI_PROTOCOL_VERSION,
            kind: "result",
            context: request.context,
            status: "cancelled",
            stats: { elapsedMs: performance.now() - t0, nodes: 0, completedDepth: 0 },
          },
        };
      }

      const bestCode = mex.mcts_finish(1);
      const stats = new Float64Array(mex.memory.buffer, mex.mcts_stats_ptr(), 9);
      const el = Math.max(1, performance.now() - t0);
      const maxNodes = Math.max(1, Number(request?.budget?.maxNodes) || 4000000);
      const maxDepth = Math.max(1, Number(request?.budget?.maxDepth) || 16);
      const sims = Math.max(1, Math.round(stats[2]));
      const depth = Math.max(1, Math.min(maxDepth, Math.round(stats[8] || 1)));
      const action = moveCodeToAction(bestCode, actor);
      if (!action) return { ok: false, fallback: true };

      if (onProgress) {
        onProgress({
          backend: "webgpu",
          gpuLabel,
          totalNodes: sims,
          sims,
          depth,
          nps: Math.round((sims * 1000) / el),
          elapsedMs: el,
          score: Number.isFinite(stats[1]) ? stats[1] : null,
          bestCode,
        });
      }

      return {
        ok: true,
        reply: {
          protocolVersion: AI_PROTOCOL_VERSION,
          kind: "result",
          context: request.context,
          status: "move",
          action,
          stats: {
            elapsedMs: Math.max(0, el),
            nodes: Math.min(sims, maxNodes),
            completedDepth: depth,
          },
        },
      };
    } catch {
      return { ok: false, fallback: true };
    } finally {
      if (activeSearchCancel === cancel) activeSearchCancel = null;
    }
  })();

  return { promise, cancel };
}
