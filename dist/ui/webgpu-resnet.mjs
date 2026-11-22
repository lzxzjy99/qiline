// Zero-dependency WebGPU WGSL Compute Shader Engine for Qiline v26 FusedDualHeadResNet (.qgpu)
// Works in Electron Desktop (Chromium Dawn DX12/Vulkan/Metal) & Chrome/Edge/Safari WebGPU!
// Strictly <= 5 storage buffers per shader (100% WebGPU default limits compliant on ALL GPUs).

export const QGPU_MAGIC = 0x55504751; // 'QGPU'
const MAX_BATCH = 80;
const BOARD_SQ = 81;
const STEM_IN_PAD = 20; // 18 planes padded to multiple of 4 for vec4 tiled GEMM

// Fast IEEE-754 Float16 -> Float32 decoder (matches PyTorch <f2 exactly)
function decodeF16ToF32(u16Arr) {
  const n = u16Arr.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const h = u16Arr[i];
    const s = (h >> 15) & 1;
    const e = (h >> 10) & 0x1f;
    const m = h & 0x3ff;
    let val;
    if (e === 0) {
      val = m === 0 ? 0 : (m / 1024) * 6.103515625e-5; // 2^-14
    } else if (e === 31) {
      val = m === 0 ? Infinity : NaN;
    } else {
      val = (1 + m / 1024) * Math.pow(2, e - 15);
    }
    out[i] = s ? -val : val;
  }
  return out;
}

function concatF32(arrays) {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Float32Array(total);
  let pos = 0;
  for (const a of arrays) {
    out.set(a, pos);
    pos += a.length;
  }
  return out;
}

// Parse .qgpu binary and pack Conv3x3 weights into [K=9*inPad, N=outCh] row-major f32 for coalesced tiled GEMM
export function parseQgpuBinary(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  if (arrayBuffer.byteLength < 32) throw new Error("qgpu buffer too small");
  const magic = dv.getUint32(0, true);
  if (magic !== QGPU_MAGIC) throw new Error(`Invalid .qgpu magic: 0x${magic.toString(16)}`);
  const version = dv.getInt32(4, true);
  const inCh = dv.getInt32(8, true);
  const ch = dv.getInt32(12, true);
  const blocks = dv.getInt32(16, true);
  const denseDim = dv.getInt32(20, true);
  const totalFloats = dv.getInt32(24, true);
  if (version !== 1 || inCh !== 18 || denseDim !== 16 || ch !== 96) {
    throw new Error(`Unsupported .qgpu config: v=${version} in=${inCh} ch=${ch} b=${blocks} d=${denseDim}`);
  }
  const u16 = new Uint16Array(arrayBuffer, 32, totalFloats);
  const all = decodeF16ToF32(u16);
  let off = 0;
  const take = (n) => {
    const sub = all.subarray(off, off + n);
    off += n;
    return sub;
  };

  // Convert PyTorch Conv2d weight [Cout, Cin, 3, 3] -> GEMM weight [9 * CinPad, Cout]
  const packConv3x3 = (wRaw, cout, cin, cinPad) => {
    const K = 9 * cinPad;
    const out = new Float32Array(K * cout);
    for (let oc = 0; oc < cout; oc++) {
      const ocBase = oc * cin * 9;
      for (let ic = 0; ic < cin; ic++) {
        const icBase = ocBase + ic * 9;
        for (let tap = 0; tap < 9; tap++) {
          const k = tap * cinPad + ic;
          out[k * cout + oc] = wRaw[icBase + tap];
        }
      }
    }
    return out;
  };

  const stemW = packConv3x3(take(ch * inCh * 9), ch, inCh, STEM_IN_PAD);
  const stemB = new Float32Array(take(ch));

  const blkWeights = [];
  const seMid = ch >> 1; // 48
  for (let i = 0; i < blocks; i++) {
    const c1W = packConv3x3(take(ch * ch * 9), ch, ch, ch);
    const c1B = new Float32Array(take(ch));
    const c2W = packConv3x3(take(ch * ch * 9), ch, ch, ch);
    const c2B = new Float32Array(take(ch));
    const se1W = take(seMid * (ch * 2)); // 9216
    const se1B = take(seMid);            // 48
    const se2W = take((ch * 2) * seMid); // 9216
    const se2B = take(ch * 2);           // 192
    const sePacked = concatF32([se1W, se1B, se2W, se2B]); // 18672 floats
    blkWeights.push({ c1W, c1B, c2W, c2B, sePacked });
  }

  // Value & Policy heads (exact export_qgpu.py order)
  const vConvW = take(32 * ch);        // 3072 (off 0)
  const vConvB = take(32);             // 32   (off 3072)
  const gCatDim = ch * 2 + denseDim;   // 208
  const vFc0In = 32 * BOARD_SQ + gCatDim; // 2800
  const vFc0W = new Float32Array(take(256 * vFc0In));
  const vFc0B = take(256);             // 256
  const vFc2W = take(256);             // 256
  const vFc2B = take(1);               // 1
  const vFcSmall = concatF32([vFc0B, vFc2W, vFc2B]); // 513 floats

  const pConv1W = take(32 * ch);       // 3072 (off 3104)
  const pConv1B = take(32);            // 32   (off 6176)
  const pGfcW = take(32 * gCatDim);    // 6656 (off 6208)
  const pGfcB = take(32);              // 32   (off 12864)
  const pOutW = take(32);              // 32   (off 12896)
  const pOutB = take(1);               // 1    (off 12928)
  const pPassW = take(gCatDim);        // 208  (off 12929)
  const pPassB = take(1);              // 1    (off 13137)
  // Total head1Packed = 13138 floats
  const head1Packed = concatF32([
    vConvW, vConvB, pConv1W, pConv1B, pGfcW, pGfcB, pOutW, pOutB, pPassW, pPassB,
  ]);

  if (off !== totalFloats) {
    throw new Error(`qgpu weight cursor mismatch: consumed ${off} != ${totalFloats}`);
  }

  return {
    ch, blocks, denseDim, gCatDim, vFc0In,
    stemW, stemB, blkWeights,
    head1Packed, vFc0W, vFcSmall,
  };
}

// ============================================================================
// WGSL Compute Shaders (Universal WebGPU f32, max 5 storage buffers per stage!)
// ============================================================================

const WGSL_PACK_PLANES = /* wgsl */ `
struct PackParams {
  batch: u32,
  _p1: u32,
  _p2: u32,
  _p3: u32,
};
@group(0) @binding(0) var<uniform> params: PackParams;
@group(0) @binding(1) var<storage, read> boardsU32: array<u32>;
@group(0) @binding(2) var<storage, read> dense16: array<f32>;
@group(0) @binding(3) var<storage, read> lastPts: array<i32>;
@group(0) @binding(4) var<storage, read_write> outPlanes: array<f32>;

@compute @workgroup_size(81, 1, 1)
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let b = wid.x;
  let sq = lid.x;
  if (b >= params.batch || sq >= 81u) { return; }

  let flatByte = b * 81u + sq;
  let word = boardsU32[flatByte >> 2u];
  let shift = (flatByte & 3u) * 8u;
  let cell = (word >> shift) & 255u;

  let dOff = b * 16u;
  let oOff = (b * 81u + sq) * 20u;

  outPlanes[oOff + 0u] = select(0.0, 1.0, cell == 0u);
  outPlanes[oOff + 1u] = select(0.0, 1.0, cell == 1u);
  outPlanes[oOff + 2u] = select(0.0, 1.0, cell == 2u);
  outPlanes[oOff + 3u] = select(0.0, 1.0, cell == 3u);
  outPlanes[oOff + 4u] = select(0.0, 1.0, cell == 4u);
  outPlanes[oOff + 5u] = select(0.0, 1.0, cell == 5u);
  outPlanes[oOff + 6u] = select(0.0, 1.0, cell == 6u);
  outPlanes[oOff + 7u] = select(0.0, 1.0, cell >= 1u && cell <= 3u);
  outPlanes[oOff + 8u] = select(0.0, 1.0, cell >= 4u && cell <= 6u);
  outPlanes[oOff + 9u]  = dense16[dOff + 0u];
  outPlanes[oOff + 10u] = dense16[dOff + 1u];
  outPlanes[oOff + 11u] = dense16[dOff + 2u];
  outPlanes[oOff + 12u] = dense16[dOff + 3u];
  outPlanes[oOff + 13u] = dense16[dOff + 4u];
  outPlanes[oOff + 14u] = dense16[dOff + 9u];
  outPlanes[oOff + 15u] = dense16[dOff + 10u];
  let lp = lastPts[b];
  outPlanes[oOff + 16u] = select(0.0, 1.0, lp >= 0 && u32(lp) == sq);
  let r = f32(sq / 9u) - 4.0;
  let c = f32(sq % 9u) - 4.0;
  outPlanes[oOff + 17u] = 1.0 - (r * r + c * c) / 32.0;
  outPlanes[oOff + 18u] = 0.0;
  outPlanes[oOff + 19u] = 0.0;
}
`;

// Shared-Memory Tiled Implicit-GEMM Conv3x3 (padding=1, NHWC) — 4 storage buffers
// Workgroup (8, 8) = 64 threads -> computes 32 output pixels (M) x 32 output channels (N)
const WGSL_CONV3X3_TILED = /* wgsl */ `
struct ConvParams {
  batch: u32,
  inCh: u32,
  outCh: u32,
  applySilu: u32,
};
@group(0) @binding(0) var<uniform> cp: ConvParams;
@group(0) @binding(1) var<storage, read> inp: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> weight: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> bias: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> outp: array<vec4<f32>>;

var<workgroup> smA: array<f32, 256>;       // 32 pixels x 8 K
var<workgroup> smB: array<vec4<f32>, 64>;  // 8 K x 8 vec4 (32 N)

fn silu4(v: vec4<f32>) -> vec4<f32> {
  return v / (vec4<f32>(1.0) + exp(-v));
}

@compute @workgroup_size(8, 8, 1)
fn main(
  @builtin(workgroup_id) wid: vec3<u32>,
  @builtin(local_invocation_id) lid: vec3<u32>
) {
  let tx = lid.x; // 0..7 -> N vec4 col
  let ty = lid.y; // 0..7 -> M group of 4 pixels
  let tid = ty * 8u + tx;

  let tileN4 = wid.x * 8u;
  let tileM = wid.y * 32u;
  let totalM = cp.batch * 81u;
  let inCh4 = cp.inCh >> 2u;
  let outCh4 = cp.outCh >> 2u;

  var acc0 = vec4<f32>(0.0);
  var acc1 = vec4<f32>(0.0);
  var acc2 = vec4<f32>(0.0);
  var acc3 = vec4<f32>(0.0);

  let loadPix = tid >> 1u; // 0..31
  let loadK4  = tid & 1u;  // 0..1
  let gPix = tileM + loadPix;
  let validPix = gPix < totalM;
  let pb = gPix / 81u;
  let psq = gPix - pb * 81u;
  let pr = i32(psq / 9u);
  let pc = i32(psq % 9u);

  let loadBK = tid >> 3u; // 0..7
  let loadBN4 = tileN4 + (tid & 7u);
  let validBN4 = loadBN4 < outCh4;

  let kStepsPerTap = (inCh4 + 1u) >> 1u;

  for (var tap: u32 = 0u; tap < 9u; tap = tap + 1u) {
    let dr = i32(tap / 3u) - 1;
    let dc = i32(tap % 3u) - 1;
    let nr = pr + dr;
    let nc = pc + dc;
    let inBounds = validPix && nr >= 0 && nr < 9 && nc >= 0 && nc < 9;
    let srcPixBase = (pb * 81u + u32(nr * 9 + nc)) * inCh4;
    let tapKBase = tap * cp.inCh;

    for (var ks: u32 = 0u; ks < kStepsPerTap; ks = ks + 1u) {
      let ic4 = ks * 2u + loadK4;
      var aVal = vec4<f32>(0.0);
      if (inBounds && ic4 < inCh4) {
        aVal = inp[srcPixBase + ic4];
      }
      let aOff = loadPix * 8u + loadK4 * 4u;
      smA[aOff + 0u] = aVal.x;
      smA[aOff + 1u] = aVal.y;
      smA[aOff + 2u] = aVal.z;
      smA[aOff + 3u] = aVal.w;

      let icScalar = ks * 8u + loadBK;
      var bVal = vec4<f32>(0.0);
      if (validBN4 && icScalar < cp.inCh) {
        let kRow = tapKBase + icScalar;
        bVal = weight[kRow * outCh4 + loadBN4];
      }
      smB[loadBK * 8u + (tid & 7u)] = bVal;

      workgroupBarrier();

      let p0Off = (ty * 4u + 0u) * 8u;
      let p1Off = (ty * 4u + 1u) * 8u;
      let p2Off = (ty * 4u + 2u) * 8u;
      let p3Off = (ty * 4u + 3u) * 8u;

      for (var k: u32 = 0u; k < 8u; k = k + 1u) {
        let bv = smB[k * 8u + tx];
        acc0 = fma(vec4<f32>(smA[p0Off + k]), bv, acc0);
        acc1 = fma(vec4<f32>(smA[p1Off + k]), bv, acc1);
        acc2 = fma(vec4<f32>(smA[p2Off + k]), bv, acc2);
        acc3 = fma(vec4<f32>(smA[p3Off + k]), bv, acc3);
      }

      workgroupBarrier();
    }
  }

  let outN4 = tileN4 + tx;
  if (outN4 < outCh4) {
    let bVec = bias[outN4];
    acc0 = acc0 + bVec;
    acc1 = acc1 + bVec;
    acc2 = acc2 + bVec;
    acc3 = acc3 + bVec;
    if (cp.applySilu != 0u) {
      acc0 = silu4(acc0);
      acc1 = silu4(acc1);
      acc2 = silu4(acc2);
      acc3 = silu4(acc3);
    }
    let m0 = tileM + ty * 4u;
    if (m0 + 0u < totalM) { outp[(m0 + 0u) * outCh4 + outN4] = acc0; }
    if (m0 + 1u < totalM) { outp[(m0 + 1u) * outCh4 + outN4] = acc1; }
    if (m0 + 2u < totalM) { outp[(m0 + 2u) * outCh4 + outN4] = acc2; }
    if (m0 + 3u < totalM) { outp[(m0 + 3u) * outCh4 + outN4] = acc3; }
  }
}
`;

// Fused Global-Pooling + SE1 + SE2 + Residual Add + SiLU — ONLY 3 storage buffers!
// sePacked layout (18672 floats): se1W[0..9215], se1B[9216..9263], se2W[9264..18479], se2B[18480..18671]
const WGSL_GPOOL_SE_RES = /* wgsl */ `
struct SeParams {
  batch: u32,
  ch: u32,
  _p2: u32,
  _p3: u32,
};
@group(0) @binding(0) var<uniform> sp: SeParams;
@group(0) @binding(1) var<storage, read_write> xBuf: array<f32>;
@group(0) @binding(2) var<storage, read> hBuf: array<f32>;
@group(0) @binding(3) var<storage, read> seW: array<f32>;

const OFF_SE1_W: u32 = 0u;
const OFF_SE1_B: u32 = 9216u;
const OFF_SE2_W: u32 = 9264u;
const OFF_SE2_B: u32 = 18480u;

var<workgroup> smG: array<f32, 192>;
var<workgroup> smMid: array<f32, 48>;

fn silu(v: f32) -> f32 { return v / (1.0 + exp(-v)); }
fn sigmoid(v: f32) -> f32 { return 1.0 / (1.0 + exp(-v)); }

@compute @workgroup_size(96, 1, 1)
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let b = wid.x;
  let c = lid.x;
  if (b >= sp.batch) { return; }

  let base = b * 81u * 96u;
  var sum: f32 = 0.0;
  var mx: f32 = -1e30;
  for (var sq: u32 = 0u; sq < 81u; sq = sq + 1u) {
    let v = hBuf[base + sq * 96u + c];
    sum = sum + v;
    mx = max(mx, v);
  }
  smG[c] = sum * (1.0 / 81.0);
  smG[96u + c] = mx;
  workgroupBarrier();

  if (c < 48u) {
    var acc = seW[OFF_SE1_B + c];
    let wOff = OFF_SE1_W + c * 192u;
    for (var i: u32 = 0u; i < 192u; i = i + 1u) {
      acc = fma(seW[wOff + i], smG[i], acc);
    }
    smMid[c] = silu(acc);
  }
  workgroupBarrier();

  var scAcc = seW[OFF_SE2_B + c];
  var biAcc = seW[OFF_SE2_B + 96u + c];
  let wScOff = OFF_SE2_W + c * 48u;
  let wBiOff = OFF_SE2_W + (96u + c) * 48u;
  for (var i: u32 = 0u; i < 48u; i = i + 1u) {
    let m = smMid[i];
    scAcc = fma(seW[wScOff + i], m, scAcc);
    biAcc = fma(seW[wBiOff + i], m, biAcc);
  }
  let scale = sigmoid(scAcc);
  let bias = biAcc;

  for (var sq: u32 = 0u; sq < 81u; sq = sq + 1u) {
    let idx = base + sq * 96u + c;
    let v = xBuf[idx] + hBuf[idx] * scale + bias;
    xBuf[idx] = silu(v);
  }
}
`;

// Head Stage 1 — ONLY 5 storage buffers!
// head1Packed layout:
//   vConvW:  0 (3072)   vConvB:  3072 (32)
//   pConv1W: 3104 (3072) pConv1B: 6176 (32)
//   pGfcW:   6208 (6656) pGfcB:   12864 (32)
//   pOutW:   12896 (32)  pOutB:   12928 (1)
//   pPassW:  12929 (208) pPassB:  13137 (1)
const WGSL_HEAD_POLICY_AND_VSP = /* wgsl */ `
struct HeadParams {
  batch: u32,
  _p1: u32,
  _p2: u32,
  _p3: u32,
};
@group(0) @binding(0) var<uniform> hp: HeadParams;
@group(0) @binding(1) var<storage, read> xBuf: array<f32>;
@group(0) @binding(2) var<storage, read> dense16: array<f32>;
@group(0) @binding(3) var<storage, read> hw: array<f32>;
@group(0) @binding(4) var<storage, read_write> vFeatOut: array<f32>;
@group(0) @binding(5) var<storage, read_write> polOut: array<f32>;

const OFF_VCONV_W: u32  = 0u;
const OFF_VCONV_B: u32  = 3072u;
const OFF_PCONV1_W: u32 = 3104u;
const OFF_PCONV1_B: u32 = 6176u;
const OFF_PGFC_W: u32   = 6208u;
const OFF_PGFC_B: u32   = 12864u;
const OFF_POUT_W: u32   = 12896u;
const OFF_POUT_B: u32   = 12928u;
const OFF_PPASS_W: u32  = 12929u;
const OFF_PPASS_B: u32  = 13137u;

var<workgroup> smGCat: array<f32, 208>;
var<workgroup> smPG: array<f32, 32>;

fn silu(v: f32) -> f32 { return v / (1.0 + exp(-v)); }

@compute @workgroup_size(96, 1, 1)
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let b = wid.x;
  let tid = lid.x;
  if (b >= hp.batch) { return; }

  let xBase = b * 81u * 96u;
  var sum: f32 = 0.0;
  var mx: f32 = -1e30;
  for (var sq: u32 = 0u; sq < 81u; sq = sq + 1u) {
    let v = xBuf[xBase + sq * 96u + tid];
    sum = sum + v;
    mx = max(mx, v);
  }
  smGCat[tid] = sum * (1.0 / 81.0);
  smGCat[96u + tid] = mx;
  if (tid < 16u) {
    smGCat[192u + tid] = dense16[b * 16u + tid];
  }
  workgroupBarrier();

  let vfBase = b * 2800u;
  vFeatOut[vfBase + 2592u + tid] = smGCat[tid];
  vFeatOut[vfBase + 2592u + 96u + tid] = smGCat[96u + tid];
  if (tid < 16u) {
    vFeatOut[vfBase + 2592u + 192u + tid] = smGCat[192u + tid];
  }

  if (tid < 32u) {
    var acc = hw[OFF_PGFC_B + tid];
    let wOff = OFF_PGFC_W + tid * 208u;
    for (var i: u32 = 0u; i < 208u; i = i + 1u) {
      acc = fma(hw[wOff + i], smGCat[i], acc);
    }
    smPG[tid] = acc;
  } else if (tid == 32u) {
    var acc = hw[OFF_PPASS_B];
    for (var i: u32 = 0u; i < 208u; i = i + 1u) {
      acc = fma(hw[OFF_PPASS_W + i], smGCat[i], acc);
    }
    polOut[b * 82u + 81u] = acc;
  }
  workgroupBarrier();

  if (tid < 81u) {
    let sq = tid;
    let sqBase = xBase + sq * 96u;
    var polAcc = hw[OFF_POUT_B];
    for (var oc: u32 = 0u; oc < 32u; oc = oc + 1u) {
      var p1 = hw[OFF_PCONV1_B + oc];
      var v1 = hw[OFF_VCONV_B + oc];
      let pwOff = OFF_PCONV1_W + oc * 96u;
      let vwOff = OFF_VCONV_W + oc * 96u;
      for (var ic: u32 = 0u; ic < 96u; ic = ic + 1u) {
        let xv = xBuf[sqBase + ic];
        p1 = fma(hw[pwOff + ic], xv, p1);
        v1 = fma(hw[vwOff + ic], xv, v1);
      }
      vFeatOut[vfBase + oc * 81u + sq] = silu(v1);
      let ph = silu(p1) + smPG[oc];
      polAcc = fma(hw[OFF_POUT_W + oc], silu(ph), polAcc);
    }
    polOut[b * 82u + sq] = polAcc;
  }
}
`;

// Head Stage 2 — ONLY 4 storage buffers!
// vFcSmall layout: vFc0B[0..255], vFc2W[256..511], vFc2B[512]
const WGSL_HEAD_VALUE_FC = /* wgsl */ `
struct ValParams {
  batch: u32,
  _p1: u32,
  _p2: u32,
  _p3: u32,
};
@group(0) @binding(0) var<uniform> vp: ValParams;
@group(0) @binding(1) var<storage, read> vFeat: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> vFc0W: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> vFcSmall: array<f32>;
@group(0) @binding(4) var<storage, read_write> valProbOut: array<f32>;

var<workgroup> smRed: array<f32, 256>;

fn silu(v: f32) -> f32 { return v / (1.0 + exp(-v)); }

@compute @workgroup_size(256, 1, 1)
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let b = wid.x;
  let k = lid.x;
  if (b >= vp.batch) { return; }

  let fBase = b * 700u;
  let wBase = k * 700u;
  var acc4 = vec4<f32>(0.0);
  for (var i: u32 = 0u; i < 700u; i = i + 1u) {
    acc4 = fma(vFc0W[wBase + i], vFeat[fBase + i], acc4);
  }
  let h = silu(acc4.x + acc4.y + acc4.z + acc4.w + vFcSmall[k]);
  smRed[k] = h * vFcSmall[256u + k];
  workgroupBarrier();

  for (var stride: u32 = 128u; stride > 0u; stride = stride >> 1u) {
    if (k < stride) {
      smRed[k] = smRed[k] + smRed[k + stride];
    }
    workgroupBarrier();
  }
  if (k == 0u) {
    let logit = smRed[0] + vFcSmall[512u];
    valProbOut[b] = 1.0 / (1.0 + exp(-logit));
  }
}
`;

export class WebGpuResNet {
  constructor(device, adapterInfo, parsed) {
    this.device = device;
    this.adapterInfo = adapterInfo;
    this.ch = parsed.ch;
    this.blocks = parsed.blocks;
    this.disposed = false;
    this.gpuErrors = [];
    device.addEventListener("uncapturederror", (ev) => {
      const m = ev.error ? ev.error.message : String(ev);
      if (this.gpuErrors.length < 8) this.gpuErrors.push(m);
    });
    this._buildResources(parsed);
  }

  static async create(qgpuArrayBuffer, opts = {}) {
    if (typeof navigator === "undefined" || !navigator.gpu) {
      throw new Error("WebGPU not supported");
    }
    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: opts.powerPreference || "high-performance",
    });
    if (!adapter) throw new Error("No WebGPU adapter available");
    const ai = adapter.info || {};
    const adapterInfo = {
      vendor: ai.vendor || "",
      architecture: ai.architecture || "",
      device: ai.device || "",
      description: ai.description || "",
    };
    const device = await adapter.requestDevice();
    const parsed = parseQgpuBinary(qgpuArrayBuffer);
    return new WebGpuResNet(device, adapterInfo, parsed);
  }

  _createStaticBuf(typedArr) {
    const byteLen = (typedArr.byteLength + 3) & ~3;
    const buf = this.device.createBuffer({
      size: Math.max(16, byteLen),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Uint8Array(buf.getMappedRange()).set(
      new Uint8Array(typedArr.buffer, typedArr.byteOffset, typedArr.byteLength)
    );
    buf.unmap();
    return buf;
  }

  _createUniform(u32Vals) {
    const buf = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    if (u32Vals) this.device.queue.writeBuffer(buf, 0, new Uint32Array(u32Vals));
    return buf;
  }

  _buildResources(p) {
    const dev = this.device;
    const S_RW = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;

    this.pipePack = dev.createComputePipeline({
      layout: "auto",
      compute: { module: dev.createShaderModule({ code: WGSL_PACK_PLANES }), entryPoint: "main" },
    });
    this.pipeConv = dev.createComputePipeline({
      layout: "auto",
      compute: { module: dev.createShaderModule({ code: WGSL_CONV3X3_TILED }), entryPoint: "main" },
    });
    this.pipeSe = dev.createComputePipeline({
      layout: "auto",
      compute: { module: dev.createShaderModule({ code: WGSL_GPOOL_SE_RES }), entryPoint: "main" },
    });
    this.pipeHead1 = dev.createComputePipeline({
      layout: "auto",
      compute: { module: dev.createShaderModule({ code: WGSL_HEAD_POLICY_AND_VSP }), entryPoint: "main" },
    });
    this.pipeHead2 = dev.createComputePipeline({
      layout: "auto",
      compute: { module: dev.createShaderModule({ code: WGSL_HEAD_VALUE_FC }), entryPoint: "main" },
    });

    const boardsBytes = ((MAX_BATCH * BOARD_SQ + 3) & ~3);
    this.bufBoards = dev.createBuffer({ size: boardsBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.bufDense = dev.createBuffer({ size: MAX_BATCH * 16 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.bufLastPts = dev.createBuffer({ size: MAX_BATCH * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.bufPlanes = dev.createBuffer({ size: MAX_BATCH * BOARD_SQ * STEM_IN_PAD * 4, usage: GPUBufferUsage.STORAGE });
    this.bufActA = dev.createBuffer({ size: MAX_BATCH * BOARD_SQ * p.ch * 4, usage: GPUBufferUsage.STORAGE });
    this.bufActB = dev.createBuffer({ size: MAX_BATCH * BOARD_SQ * p.ch * 4, usage: GPUBufferUsage.STORAGE });
    this.bufActC = dev.createBuffer({ size: MAX_BATCH * BOARD_SQ * p.ch * 4, usage: GPUBufferUsage.STORAGE });
    this.bufVFeat = dev.createBuffer({ size: MAX_BATCH * p.vFc0In * 4, usage: GPUBufferUsage.STORAGE });
    this.bufValOut = dev.createBuffer({ size: MAX_BATCH * 4, usage: S_RW });
    this.bufPolOut = dev.createBuffer({ size: MAX_BATCH * 82 * 4, usage: S_RW });
    this.bufReadVal = dev.createBuffer({ size: MAX_BATCH * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    this.bufReadPol = dev.createBuffer({ size: MAX_BATCH * 82 * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });

    this.uPack = this._createUniform([1, 0, 0, 0]);
    this.uStem = this._createUniform([1, STEM_IN_PAD, p.ch, 1]);
    this.uConvSilu = this._createUniform([1, p.ch, p.ch, 1]);
    this.uConvLin = this._createUniform([1, p.ch, p.ch, 0]);
    this.uSe = this._createUniform([1, p.ch, 0, 0]);
    this.uHead = this._createUniform([1, 0, 0, 0]);

    const stemW = this._createStaticBuf(p.stemW);
    const stemB = this._createStaticBuf(p.stemB);
    this._ownedBufs = [
      this.bufBoards, this.bufDense, this.bufLastPts, this.bufPlanes,
      this.bufActA, this.bufActB, this.bufActC, this.bufVFeat,
      this.bufValOut, this.bufPolOut, this.bufReadVal, this.bufReadPol,
      this.uPack, this.uStem, this.uConvSilu, this.uConvLin, this.uSe, this.uHead,
      stemW, stemB,
    ];

    this.bgPack = dev.createBindGroup({
      layout: this.pipePack.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uPack } },
        { binding: 1, resource: { buffer: this.bufBoards } },
        { binding: 2, resource: { buffer: this.bufDense } },
        { binding: 3, resource: { buffer: this.bufLastPts } },
        { binding: 4, resource: { buffer: this.bufPlanes } },
      ],
    });

    this.bgStem = dev.createBindGroup({
      layout: this.pipeConv.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uStem } },
        { binding: 1, resource: { buffer: this.bufPlanes } },
        { binding: 2, resource: { buffer: stemW } },
        { binding: 3, resource: { buffer: stemB } },
        { binding: 4, resource: { buffer: this.bufActA } },
      ],
    });

    this.bgBlocks = [];
    for (let i = 0; i < p.blocks; i++) {
      const bw = p.blkWeights[i];
      const c1W = this._createStaticBuf(bw.c1W);
      const c1B = this._createStaticBuf(bw.c1B);
      const c2W = this._createStaticBuf(bw.c2W);
      const c2B = this._createStaticBuf(bw.c2B);
      const seW = this._createStaticBuf(bw.sePacked);
      this._ownedBufs.push(c1W, c1B, c2W, c2B, seW);

      const bgC1 = dev.createBindGroup({
        layout: this.pipeConv.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.uConvSilu } },
          { binding: 1, resource: { buffer: this.bufActA } },
          { binding: 2, resource: { buffer: c1W } },
          { binding: 3, resource: { buffer: c1B } },
          { binding: 4, resource: { buffer: this.bufActB } },
        ],
      });
      const bgC2 = dev.createBindGroup({
        layout: this.pipeConv.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.uConvLin } },
          { binding: 1, resource: { buffer: this.bufActB } },
          { binding: 2, resource: { buffer: c2W } },
          { binding: 3, resource: { buffer: c2B } },
          { binding: 4, resource: { buffer: this.bufActC } },
        ],
      });
      const bgSe = dev.createBindGroup({
        layout: this.pipeSe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.uSe } },
          { binding: 1, resource: { buffer: this.bufActA } },
          { binding: 2, resource: { buffer: this.bufActC } },
          { binding: 3, resource: { buffer: seW } },
        ],
      });
      this.bgBlocks.push({ bgC1, bgC2, bgSe });
    }

    const head1W = this._createStaticBuf(p.head1Packed);
    const vFc0W = this._createStaticBuf(p.vFc0W);
    const vFcSmall = this._createStaticBuf(p.vFcSmall);
    this._ownedBufs.push(head1W, vFc0W, vFcSmall);

    this.bgHead1 = dev.createBindGroup({
      layout: this.pipeHead1.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uHead } },
        { binding: 1, resource: { buffer: this.bufActA } },
        { binding: 2, resource: { buffer: this.bufDense } },
        { binding: 3, resource: { buffer: head1W } },
        { binding: 4, resource: { buffer: this.bufVFeat } },
        { binding: 5, resource: { buffer: this.bufPolOut } },
      ],
    });

    this.bgHead2 = dev.createBindGroup({
      layout: this.pipeHead2.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uHead } },
        { binding: 1, resource: { buffer: this.bufVFeat } },
        { binding: 2, resource: { buffer: vFc0W } },
        { binding: 3, resource: { buffer: vFcSmall } },
        { binding: 4, resource: { buffer: this.bufValOut } },
      ],
    });

    this._boardsPad = new Uint8Array((MAX_BATCH * BOARD_SQ + 3) & ~3);
    this._lpI32 = new Int32Array(MAX_BATCH);
    this._u4 = new Uint32Array(4);
    this._lastBatch = -1;
  }

  async evalBatch(bn, boardsU8, dense16F32, lastPtsI8, outVal = null, outPol = null) {
    if (this.disposed) throw new Error("WebGpuResNet disposed");
    if (bn <= 0 || bn > MAX_BATCH) throw new Error(`Invalid batch size ${bn}`);
    const dev = this.device;

    const bLen = bn * BOARD_SQ;
    const bPadLen = (bLen + 3) & ~3;
    this._boardsPad.set(boardsU8.subarray(0, bLen), 0);
    for (let i = 0; i < bn; i++) this._lpI32[i] = lastPtsI8[i];

    dev.queue.writeBuffer(this.bufBoards, 0, this._boardsPad.buffer, 0, bPadLen);
    dev.queue.writeBuffer(this.bufDense, 0, dense16F32.buffer, dense16F32.byteOffset, bn * 16 * 4);
    dev.queue.writeBuffer(this.bufLastPts, 0, this._lpI32.buffer, 0, bn * 4);

    if (bn !== this._lastBatch) {
      this._lastBatch = bn;
      const u = this._u4;
      u[0] = bn; u[1] = 0; u[2] = 0; u[3] = 0;
      dev.queue.writeBuffer(this.uPack, 0, u);
      dev.queue.writeBuffer(this.uHead, 0, u);
      u[1] = this.ch;
      dev.queue.writeBuffer(this.uSe, 0, u);
      u[1] = STEM_IN_PAD; u[2] = this.ch; u[3] = 1;
      dev.queue.writeBuffer(this.uStem, 0, u);
      u[1] = this.ch; u[2] = this.ch; u[3] = 1;
      dev.queue.writeBuffer(this.uConvSilu, 0, u);
      u[3] = 0;
      dev.queue.writeBuffer(this.uConvLin, 0, u);
    }

    const enc = dev.createCommandEncoder();
    const pass = enc.beginComputePass();

    pass.setPipeline(this.pipePack);
    pass.setBindGroup(0, this.bgPack);
    pass.dispatchWorkgroups(bn, 1, 1);

    const wgN = this.ch >> 5; // 96 / 32 = 3
    const wgM = Math.ceil((bn * BOARD_SQ) / 32);

    pass.setPipeline(this.pipeConv);
    pass.setBindGroup(0, this.bgStem);
    pass.dispatchWorkgroups(wgN, wgM, 1);

    for (let i = 0; i < this.blocks; i++) {
      const blk = this.bgBlocks[i];
      pass.setPipeline(this.pipeConv);
      pass.setBindGroup(0, blk.bgC1);
      pass.dispatchWorkgroups(wgN, wgM, 1);

      pass.setBindGroup(0, blk.bgC2);
      pass.dispatchWorkgroups(wgN, wgM, 1);

      pass.setPipeline(this.pipeSe);
      pass.setBindGroup(0, blk.bgSe);
      pass.dispatchWorkgroups(bn, 1, 1);
    }

    pass.setPipeline(this.pipeHead1);
    pass.setBindGroup(0, this.bgHead1);
    pass.dispatchWorkgroups(bn, 1, 1);

    pass.setPipeline(this.pipeHead2);
    pass.setBindGroup(0, this.bgHead2);
    pass.dispatchWorkgroups(bn, 1, 1);

    pass.end();

    const valBytes = bn * 4;
    const polBytes = bn * 82 * 4;
    enc.copyBufferToBuffer(this.bufValOut, 0, this.bufReadVal, 0, valBytes);
    enc.copyBufferToBuffer(this.bufPolOut, 0, this.bufReadPol, 0, polBytes);
    dev.queue.submit([enc.finish()]);

    await Promise.all([
      this.bufReadVal.mapAsync(GPUMapMode.READ, 0, valBytes),
      this.bufReadPol.mapAsync(GPUMapMode.READ, 0, polBytes),
    ]);

    if (this.gpuErrors.length > 0) {
      this.bufReadVal.unmap();
      this.bufReadPol.unmap();
      throw new Error("WebGPU errors:\n" + this.gpuErrors.join("\n---\n"));
    }

    const vView = new Float32Array(this.bufReadVal.getMappedRange(0, valBytes));
    const pView = new Float32Array(this.bufReadPol.getMappedRange(0, polBytes));
    const resVal = outVal || new Float32Array(bn);
    const resPol = outPol || new Float32Array(bn * 82);
    resVal.set(vView, 0);
    resPol.set(pView, 0);

    this.bufReadVal.unmap();
    this.bufReadPol.unmap();
    return { valProb: resVal, polLogits: resPol };
  }

  async benchmark(batchSize = 32, iters = 6) {
    const b = new Uint8Array(batchSize * BOARD_SQ);
    const d = new Float32Array(batchSize * 16);
    const lp = new Int8Array(batchSize).fill(-1);
    await this.evalBatch(batchSize, b, d, lp);
    await this.evalBatch(batchSize, b, d, lp);
    const t0 = performance.now();
    for (let i = 0; i < iters; i++) {
      await this.evalBatch(batchSize, b, d, lp);
    }
    const dtMs = Math.max(0.1, performance.now() - t0);
    const msPerBatch = dtMs / iters;
    const boardsPerSec = (batchSize * 1000) / msPerBatch;
    return { batchSize, iters, msPerBatch, boardsPerSec };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const buf of this._ownedBufs) {
      try { buf.destroy(); } catch {}
    }
    this._ownedBufs = [];
    try { this.device.destroy(); } catch {}
  }
}
