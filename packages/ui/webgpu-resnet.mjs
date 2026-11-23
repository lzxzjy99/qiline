// Zero-dependency WebGPU WGSL Compute Shader Engine for Qiline v27 FusedDualHeadResNet (.qgpu v2)
// Upgrades over v26:
//   1. Supports 28-Plane Tactical X-Ray (version=2, computed 100% on-GPU in WGSL_PACK_PLANES_V27!)
//   2. Generalized ch (96 / 128) & blocks (8 / 10 / 12 / 16) with compile-time specialization
//   3. Auto-detected `shader-f16` Fast Path (FP16 weights in VRAM & shared memory, f32 accumulation)
//      with seamless universal `f32` fallback on GPUs without `shader-f16`!
//   4. Strictly <= 5 storage buffers per shader (100% WebGPU Core Spec compliant on ALL GPUs).

export const QGPU_MAGIC = 0x55504751; // 'QGPU'
const MAX_BATCH = 80;
const BOARD_SQ = 81;

function decodeF16ToF32(u16Arr) {
  const n = u16Arr.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const h = u16Arr[i];
    const s = (h >> 15) & 1;
    const e = (h >> 10) & 0x1f;
    const m = h & 0x3ff;
    let val;
    if (e === 0) val = m === 0 ? 0 : (m / 1024) * 6.103515625e-5;
    else if (e === 31) val = m === 0 ? Infinity : NaN;
    else val = (1 + m / 1024) * Math.pow(2, e - 15);
    out[i] = s ? -val : val;
  }
  return out;
}

function concatF32(arrays) {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Float32Array(total);
  let pos = 0;
  for (const a of arrays) { out.set(a, pos); pos += a.length; }
  return out;
}

// Pack Conv3x3 [Cout, Cin, 9] -> [9 * CinPad, Cout] row-major (either Uint16Array f16 OR Float32Array f32)
function packConv3x3U16(wU16, cout, cin, cinPad) {
  const K = 9 * cinPad;
  const out = new Uint16Array(K * cout);
  for (let oc = 0; oc < cout; oc++) {
    const ocBase = oc * cin * 9;
    for (let ic = 0; ic < cin; ic++) {
      const icBase = ocBase + ic * 9;
      for (let tap = 0; tap < 9; tap++) {
        out[(tap * cinPad + ic) * cout + oc] = wU16[icBase + tap];
      }
    }
  }
  return out;
}

function packConv3x3F32(wF32, cout, cin, cinPad) {
  const K = 9 * cinPad;
  const out = new Float32Array(K * cout);
  for (let oc = 0; oc < cout; oc++) {
    const ocBase = oc * cin * 9;
    for (let ic = 0; ic < cin; ic++) {
      const icBase = ocBase + ic * 9;
      for (let tap = 0; tap < 9; tap++) {
        out[(tap * cinPad + ic) * cout + oc] = wF32[icBase + tap];
      }
    }
  }
  return out;
}

export function parseQgpuBinary(arrayBuffer, useF16 = false) {
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
  if ((version !== 1 && version !== 2) || (inCh !== 18 && inCh !== 28) || denseDim !== 16 || (ch & 31) !== 0 || ch < 64 || ch > 256) {
    throw new Error(`Unsupported .qgpu config: v=${version} in=${inCh} ch=${ch} b=${blocks} d=${denseDim}`);
  }
  const stemInPad = (inCh + 3) & ~3; // 18->20, 28->28
  const u16All = new Uint16Array(arrayBuffer, 32, totalFloats);
  let off = 0;
  const takeU16 = (n) => { const s = u16All.subarray(off, off + n); off += n; return s; };
  const takeF32 = (n) => decodeF16ToF32(takeU16(n));
  const takeConv = (cout, cin, cinPad) =>
    useF16 ? packConv3x3U16(takeU16(cout * cin * 9), cout, cin, cinPad)
           : packConv3x3F32(takeF32(cout * cin * 9), cout, cin, cinPad);

  const stemW = takeConv(ch, inCh, stemInPad);
  const stemB = takeF32(ch);

  const blkWeights = [];
  const seMid = ch >> 1;
  for (let i = 0; i < blocks; i++) {
    const c1W = takeConv(ch, ch, ch);
    const c1B = takeF32(ch);
    const c2W = takeConv(ch, ch, ch);
    const c2B = takeF32(ch);
    const se1W = takeF32(seMid * (ch * 2));
    const se1B = takeF32(seMid);
    const se2W = takeF32((ch * 2) * seMid);
    const se2B = takeF32(ch * 2);
    const sePacked = concatF32([se1W, se1B, se2W, se2B]);
    blkWeights.push({ c1W, c1B, c2W, c2B, sePacked });
  }

  const vConvW = takeF32(32 * ch);
  const vConvB = takeF32(32);
  const gCatDim = ch * 2 + denseDim;
  const vFc0In = 32 * BOARD_SQ + gCatDim; // multiple of 4 (2592 + 2*ch + 16)
  const vFc0W = useF16 ? new Uint16Array(takeU16(256 * vFc0In)) : takeF32(256 * vFc0In);
  const vFc0B = takeF32(256);
  const vFc2W = takeF32(256);
  const vFc2B = takeF32(1);
  const vFcSmall = concatF32([vFc0B, vFc2W, vFc2B]);

  const pConv1W = takeF32(32 * ch);
  const pConv1B = takeF32(32);
  const pGfcW = takeF32(32 * gCatDim);
  const pGfcB = takeF32(32);
  const pOutW = takeF32(32);
  const pOutB = takeF32(1);
  const pPassW = takeF32(gCatDim);
  const pPassB = takeF32(1);
  const head1Packed = concatF32([
    vConvW, vConvB, pConv1W, pConv1B, pGfcW, pGfcB, pOutW, pOutB, pPassW, pPassB,
  ]);

  if (off !== totalFloats) {
    throw new Error(`qgpu weight cursor mismatch: consumed ${off} != ${totalFloats}`);
  }

  return {
    version, inCh, stemInPad, ch, blocks, denseDim, gCatDim, vFc0In, useF16,
    stemW, stemB, blkWeights, head1Packed, vFc0W, vFcSmall,
  };
}

// ============================================================================
// WGSL Shader Generators (Generalized ch, 28-plane Tactical X-Ray, f16/f32!)
// ============================================================================

function makePackPlanesWgsl(inCh, stemInPad) {
  if (inCh === 18) {
    return /* wgsl */ `
struct PackParams { batch: u32, _p1: u32, _p2: u32, _p3: u32 };
@group(0) @binding(0) var<uniform> params: PackParams;
@group(0) @binding(1) var<storage, read> boardsU32: array<u32>;
@group(0) @binding(2) var<storage, read> dense16: array<f32>;
@group(0) @binding(3) var<storage, read> lastPts: array<i32>;
@group(0) @binding(4) var<storage, read_write> outPlanes: array<f32>;

@compute @workgroup_size(81, 1, 1)
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let b = wid.x;
  let sq = lid.x;
  if (b >= params.batch) { return; }
  let flatByte = b * 81u + sq;
  let cell = (boardsU32[flatByte >> 2u] >> ((flatByte & 3u) * 8u)) & 255u;
  let dOff = b * 16u;
  let oOff = (b * 81u + sq) * ${stemInPad}u;
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
}`;
  }

  // Exact 28-plane Tactical X-Ray on-GPU builder (100% bit-for-bit identical to PyTorch make_planes_v27!)
  return /* wgsl */ `
struct PackParams { batch: u32, _p1: u32, _p2: u32, _p3: u32 };
@group(0) @binding(0) var<uniform> params: PackParams;
@group(0) @binding(1) var<storage, read> boardsU32: array<u32>;
@group(0) @binding(2) var<storage, read> dense16: array<f32>;
@group(0) @binding(3) var<storage, read> lastPts: array<i32>;
@group(0) @binding(4) var<storage, read_write> outPlanes: array<f32>;

var<workgroup> smBoard: array<u32, 81>;

@compute @workgroup_size(81, 1, 1)
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let b = wid.x;
  let sq = lid.x;
  if (b >= params.batch) { return; }

  let flatByte = b * 81u + sq;
  let cell = (boardsU32[flatByte >> 2u] >> ((flatByte & 3u) * 8u)) & 255u;
  smBoard[sq] = cell;
  workgroupBarrier();

  let ri = i32(sq / 9u);
  let ci = i32(sq % 9u);
  let isEmp = (cell == 0u);
  let isOwn = (cell >= 1u && cell <= 3u);
  let isEn  = (cell >= 4u && cell <= 6u);

  var ownComp4 = false;
  var enComp4  = false;
  var ownTh3   = false;
  var enTh3    = false;
  var ownCl5   = false;
  var enCl5    = false;
  var ownO2    = false;
  var enO2     = false;

  // Main diagonal windows (dr=+1, dc=+1) containing (ri, ci)
  for (var s: i32 = -4; s <= 0; s = s + 1) {
    let r0 = ri + s;
    let c0 = ci + s;
    if (r0 >= 0 && r0 <= 4 && c0 >= 0 && c0 <= 4) {
      var oc: u32 = 0u;
      var ec: u32 = 0u;
      for (var k: i32 = 0; k < 5; k = k + 1) {
        let v = smBoard[u32((r0 + k) * 9 + (c0 + k))];
        if (v >= 1u && v <= 3u) { oc = oc + 1u; }
        else if (v >= 4u && v <= 6u) { ec = ec + 1u; }
      }
      if (ec == 0u) {
        if (oc == 4u) { ownComp4 = true; }
        else if (oc == 3u) { ownTh3 = true; }
        else if (oc == 5u) { ownCl5 = true; }
        else if (oc == 2u) { ownO2 = true; }
      } else if (oc == 0u) {
        if (ec == 4u) { enComp4 = true; }
        else if (ec == 3u) { enTh3 = true; }
        else if (ec == 5u) { enCl5 = true; }
        else if (ec == 2u) { enO2 = true; }
      }
    }
  }

  // Anti-diagonal windows (dr=+1, dc=-1) containing (ri, ci)
  for (var s: i32 = -4; s <= 0; s = s + 1) {
    let r0 = ri + s;
    let c0 = ci - s;
    if (r0 >= 0 && r0 <= 4 && c0 >= 4 && c0 <= 8) {
      var oc: u32 = 0u;
      var ec: u32 = 0u;
      for (var k: i32 = 0; k < 5; k = k + 1) {
        let v = smBoard[u32((r0 + k) * 9 + (c0 - k))];
        if (v >= 1u && v <= 3u) { oc = oc + 1u; }
        else if (v >= 4u && v <= 6u) { ec = ec + 1u; }
      }
      if (ec == 0u) {
        if (oc == 4u) { ownComp4 = true; }
        else if (oc == 3u) { ownTh3 = true; }
        else if (oc == 5u) { ownCl5 = true; }
        else if (oc == 2u) { ownO2 = true; }
      } else if (oc == 0u) {
        if (ec == 4u) { enComp4 = true; }
        else if (ec == 3u) { enTh3 = true; }
        else if (ec == 5u) { enCl5 = true; }
        else if (ec == 2u) { enO2 = true; }
      }
    }
  }

  // Orthogonal atari capture/rescue squares
  var capSq = false;
  var resSq = false;
  if (isEmp) {
    if (ri > 0) { let v = smBoard[sq - 9u]; if (v == 4u) { capSq = true; } if (v == 1u) { resSq = true; } }
    if (ri < 8) { let v = smBoard[sq + 9u]; if (v == 4u) { capSq = true; } if (v == 1u) { resSq = true; } }
    if (ci > 0) { let v = smBoard[sq - 1u]; if (v == 4u) { capSq = true; } if (v == 1u) { resSq = true; } }
    if (ci < 8) { let v = smBoard[sq + 1u]; if (v == 4u) { capSq = true; } if (v == 1u) { resSq = true; } }
  }

  let dOff = b * 16u;
  let oOff = (b * 81u + sq) * 28u;
  outPlanes[oOff + 0u] = select(0.0, 1.0, isEmp);
  outPlanes[oOff + 1u] = select(0.0, 1.0, cell == 1u);
  outPlanes[oOff + 2u] = select(0.0, 1.0, cell == 2u);
  outPlanes[oOff + 3u] = select(0.0, 1.0, cell == 3u);
  outPlanes[oOff + 4u] = select(0.0, 1.0, cell == 4u);
  outPlanes[oOff + 5u] = select(0.0, 1.0, cell == 5u);
  outPlanes[oOff + 6u] = select(0.0, 1.0, cell == 6u);
  outPlanes[oOff + 7u] = select(0.0, 1.0, isOwn);
  outPlanes[oOff + 8u] = select(0.0, 1.0, isEn);
  outPlanes[oOff + 9u]  = dense16[dOff + 0u];
  outPlanes[oOff + 10u] = dense16[dOff + 1u];
  outPlanes[oOff + 11u] = dense16[dOff + 2u];
  outPlanes[oOff + 12u] = dense16[dOff + 3u];
  outPlanes[oOff + 13u] = dense16[dOff + 4u];
  outPlanes[oOff + 14u] = dense16[dOff + 9u];
  outPlanes[oOff + 15u] = dense16[dOff + 10u];
  let lp = lastPts[b];
  outPlanes[oOff + 16u] = select(0.0, 1.0, lp >= 0 && u32(lp) == sq);
  let rf = f32(ri) - 4.0;
  let cf = f32(ci) - 4.0;
  outPlanes[oOff + 17u] = 1.0 - (rf * rf + cf * cf) / 32.0;
  outPlanes[oOff + 18u] = select(0.0, 1.0, isEmp && ownComp4);
  outPlanes[oOff + 19u] = select(0.0, 1.0, isEmp && enComp4);
  outPlanes[oOff + 20u] = select(0.0, 1.0, isEmp && ownTh3);
  outPlanes[oOff + 21u] = select(0.0, 1.0, isEmp && enTh3);
  outPlanes[oOff + 22u] = select(0.0, 1.0, isOwn && ownCl5);
  outPlanes[oOff + 23u] = select(0.0, 1.0, isEn  && enCl5);
  outPlanes[oOff + 24u] = select(0.0, 1.0, capSq);
  outPlanes[oOff + 25u] = select(0.0, 1.0, resSq);
  outPlanes[oOff + 26u] = select(0.0, 1.0, isEmp && ownO2);
  outPlanes[oOff + 27u] = select(0.0, 1.0, isEmp && enO2);
}`;
}

function makeConv3x3Wgsl(useF16) {
  const hdr = useF16 ? "enable f16;\n" : "";
  const wType = useF16 ? "vec4<f16>" : "vec4<f32>";
  const wZero = useF16 ? "vec4<f16>(0.0h)" : "vec4<f32>(0.0)";
  const toF32 = useF16 ? "vec4<f32>(smB[k * 8u + tx])" : "smB[k * 8u + tx]";
  return /* wgsl */ `${hdr}
struct ConvParams { batch: u32, inCh: u32, outCh: u32, applySilu: u32 };
@group(0) @binding(0) var<uniform> cp: ConvParams;
@group(0) @binding(1) var<storage, read> inp: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> weight: array<${wType}>;
@group(0) @binding(3) var<storage, read> bias: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> outp: array<vec4<f32>>;

var<workgroup> smA: array<f32, 256>;
var<workgroup> smB: array<${wType}, 64>;

fn silu4(v: vec4<f32>) -> vec4<f32> { return v / (vec4<f32>(1.0) + exp(-v)); }

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let tx = lid.x;
  let ty = lid.y;
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

  let loadPix = tid >> 1u;
  let loadK4  = tid & 1u;
  let gPix = tileM + loadPix;
  let validPix = gPix < totalM;
  let pb = gPix / 81u;
  let psq = gPix - pb * 81u;
  let pr = i32(psq / 9u);
  let pc = i32(psq % 9u);

  let loadBK = tid >> 3u;
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
      if (inBounds && ic4 < inCh4) { aVal = inp[srcPixBase + ic4]; }
      let aOff = loadPix * 8u + loadK4 * 4u;
      smA[aOff + 0u] = aVal.x;
      smA[aOff + 1u] = aVal.y;
      smA[aOff + 2u] = aVal.z;
      smA[aOff + 3u] = aVal.w;

      let icScalar = ks * 8u + loadBK;
      var bVal = ${wZero};
      if (validBN4 && icScalar < cp.inCh) {
        bVal = weight[(tapKBase + icScalar) * outCh4 + loadBN4];
      }
      smB[loadBK * 8u + (tid & 7u)] = bVal;
      workgroupBarrier();

      let p0Off = (ty * 4u + 0u) * 8u;
      let p1Off = (ty * 4u + 1u) * 8u;
      let p2Off = (ty * 4u + 2u) * 8u;
      let p3Off = (ty * 4u + 3u) * 8u;
      for (var k: u32 = 0u; k < 8u; k = k + 1u) {
        let bv = ${toF32};
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
    acc0 = acc0 + bVec; acc1 = acc1 + bVec; acc2 = acc2 + bVec; acc3 = acc3 + bVec;
    if (cp.applySilu != 0u) {
      acc0 = silu4(acc0); acc1 = silu4(acc1); acc2 = silu4(acc2); acc3 = silu4(acc3);
    }
    let m0 = tileM + ty * 4u;
    if (m0 + 0u < totalM) { outp[(m0 + 0u) * outCh4 + outN4] = acc0; }
    if (m0 + 1u < totalM) { outp[(m0 + 1u) * outCh4 + outN4] = acc1; }
    if (m0 + 2u < totalM) { outp[(m0 + 2u) * outCh4 + outN4] = acc2; }
    if (m0 + 3u < totalM) { outp[(m0 + 3u) * outCh4 + outN4] = acc3; }
  }
}`;
}

function makeGPoolSeResWgsl(ch) {
  const ch2 = ch * 2;
  const mid = ch >> 1;
  const offSe1B = mid * ch2;
  const offSe2W = offSe1B + mid;
  const offSe2B = offSe2W + ch2 * mid;
  return /* wgsl */ `
struct SeParams { batch: u32, ch: u32, _p2: u32, _p3: u32 };
@group(0) @binding(0) var<uniform> sp: SeParams;
@group(0) @binding(1) var<storage, read_write> xBuf: array<f32>;
@group(0) @binding(2) var<storage, read> hBuf: array<f32>;
@group(0) @binding(3) var<storage, read> seW: array<f32>;

var<workgroup> smG: array<f32, ${ch2}>;
var<workgroup> smMid: array<f32, ${mid}>;

fn silu(v: f32) -> f32 { return v / (1.0 + exp(-v)); }
fn sigmoid(v: f32) -> f32 { return 1.0 / (1.0 + exp(-v)); }

@compute @workgroup_size(${ch}, 1, 1)
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let b = wid.x;
  let c = lid.x;
  if (b >= sp.batch) { return; }

  let base = b * ${81 * ch}u;
  var sum: f32 = 0.0;
  var mx: f32 = -1e30;
  for (var sq: u32 = 0u; sq < 81u; sq = sq + 1u) {
    let v = hBuf[base + sq * ${ch}u + c];
    sum = sum + v;
    mx = max(mx, v);
  }
  smG[c] = sum * (1.0 / 81.0);
  smG[${ch}u + c] = mx;
  workgroupBarrier();

  if (c < ${mid}u) {
    var acc = seW[${offSe1B}u + c];
    let wOff = c * ${ch2}u;
    for (var i: u32 = 0u; i < ${ch2}u; i = i + 1u) {
      acc = fma(seW[wOff + i], smG[i], acc);
    }
    smMid[c] = silu(acc);
  }
  workgroupBarrier();

  var scAcc = seW[${offSe2B}u + c];
  var biAcc = seW[${offSe2B + ch}u + c];
  let wScOff = ${offSe2W}u + c * ${mid}u;
  let wBiOff = ${offSe2W}u + (${ch}u + c) * ${mid}u;
  for (var i: u32 = 0u; i < ${mid}u; i = i + 1u) {
    let m = smMid[i];
    scAcc = fma(seW[wScOff + i], m, scAcc);
    biAcc = fma(seW[wBiOff + i], m, biAcc);
  }
  let scale = sigmoid(scAcc);
  let bias = biAcc;

  for (var sq: u32 = 0u; sq < 81u; sq = sq + 1u) {
    let idx = base + sq * ${ch}u + c;
    xBuf[idx] = silu(xBuf[idx] + hBuf[idx] * scale + bias);
  }
}`;
}

function makeHead1Wgsl(ch) {
  const ch2 = ch * 2;
  const gCat = ch2 + 16;
  const vFc0In = 32 * 81 + gCat;
  const offVConvB = 32 * ch;
  const offPConv1W = offVConvB + 32;
  const offPConv1B = offPConv1W + 32 * ch;
  const offPGfcW = offPConv1B + 32;
  const offPGfcB = offPGfcW + 32 * gCat;
  const offPOutW = offPGfcB + 32;
  const offPOutB = offPOutW + 32;
  const offPPassW = offPOutB + 1;
  const offPPassB = offPPassW + gCat;
  return /* wgsl */ `
struct HeadParams { batch: u32, _p1: u32, _p2: u32, _p3: u32 };
@group(0) @binding(0) var<uniform> hp: HeadParams;
@group(0) @binding(1) var<storage, read> xBuf: array<f32>;
@group(0) @binding(2) var<storage, read> dense16: array<f32>;
@group(0) @binding(3) var<storage, read> hw: array<f32>;
@group(0) @binding(4) var<storage, read_write> vFeatOut: array<f32>;
@group(0) @binding(5) var<storage, read_write> polOut: array<f32>;

var<workgroup> smGCat: array<f32, ${gCat}>;
var<workgroup> smPG: array<f32, 32>;

fn silu(v: f32) -> f32 { return v / (1.0 + exp(-v)); }

@compute @workgroup_size(${ch}, 1, 1)
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let b = wid.x;
  let tid = lid.x;
  if (b >= hp.batch) { return; }

  let xBase = b * ${81 * ch}u;
  var sum: f32 = 0.0;
  var mx: f32 = -1e30;
  for (var sq: u32 = 0u; sq < 81u; sq = sq + 1u) {
    let v = xBuf[xBase + sq * ${ch}u + tid];
    sum = sum + v;
    mx = max(mx, v);
  }
  smGCat[tid] = sum * (1.0 / 81.0);
  smGCat[${ch}u + tid] = mx;
  if (tid < 16u) { smGCat[${ch2}u + tid] = dense16[b * 16u + tid]; }
  workgroupBarrier();

  let vfBase = b * ${vFc0In}u;
  vFeatOut[vfBase + 2592u + tid] = smGCat[tid];
  vFeatOut[vfBase + 2592u + ${ch}u + tid] = smGCat[${ch}u + tid];
  if (tid < 16u) { vFeatOut[vfBase + 2592u + ${ch2}u + tid] = smGCat[${ch2}u + tid]; }

  if (tid < 32u) {
    var acc = hw[${offPGfcB}u + tid];
    let wOff = ${offPGfcW}u + tid * ${gCat}u;
    for (var i: u32 = 0u; i < ${gCat}u; i = i + 1u) { acc = fma(hw[wOff + i], smGCat[i], acc); }
    smPG[tid] = acc;
  } else if (tid == 32u) {
    var acc = hw[${offPPassB}u];
    for (var i: u32 = 0u; i < ${gCat}u; i = i + 1u) { acc = fma(hw[${offPPassW}u + i], smGCat[i], acc); }
    polOut[b * 82u + 81u] = acc;
  }
  workgroupBarrier();

  if (tid < 81u) {
    let sq = tid;
    let sqBase = xBase + sq * ${ch}u;
    var polAcc = hw[${offPOutB}u];
    for (var oc: u32 = 0u; oc < 32u; oc = oc + 1u) {
      var p1 = hw[${offPConv1B}u + oc];
      var v1 = hw[${offVConvB}u + oc];
      let pwOff = ${offPConv1W}u + oc * ${ch}u;
      let vwOff = oc * ${ch}u;
      for (var ic: u32 = 0u; ic < ${ch}u; ic = ic + 1u) {
        let xv = xBuf[sqBase + ic];
        p1 = fma(hw[pwOff + ic], xv, p1);
        v1 = fma(hw[vwOff + ic], xv, v1);
      }
      vFeatOut[vfBase + oc * 81u + sq] = silu(v1);
      let ph = silu(p1) + smPG[oc];
      polAcc = fma(hw[${offPOutW}u + oc], silu(ph), polAcc);
    }
    polOut[b * 82u + sq] = polAcc;
  }
}`;
}

function makeHead2Wgsl(vFc0In, useF16) {
  const vec4Len = vFc0In >> 2;
  const hdr = useF16 ? "enable f16;\n" : "";
  const wType = useF16 ? "vec4<f16>" : "vec4<f32>";
  const wRead = useF16 ? "vec4<f32>(vFc0W[wBase + i])" : "vFc0W[wBase + i]";
  return /* wgsl */ `${hdr}
struct ValParams { batch: u32, _p1: u32, _p2: u32, _p3: u32 };
@group(0) @binding(0) var<uniform> vp: ValParams;
@group(0) @binding(1) var<storage, read> vFeat: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> vFc0W: array<${wType}>;
@group(0) @binding(3) var<storage, read> vFcSmall: array<f32>;
@group(0) @binding(4) var<storage, read_write> valProbOut: array<f32>;

var<workgroup> smRed: array<f32, 256>;
fn silu(v: f32) -> f32 { return v / (1.0 + exp(-v)); }

@compute @workgroup_size(256, 1, 1)
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let b = wid.x;
  let k = lid.x;
  if (b >= vp.batch) { return; }

  let fBase = b * ${vec4Len}u;
  let wBase = k * ${vec4Len}u;
  var acc4 = vec4<f32>(0.0);
  for (var i: u32 = 0u; i < ${vec4Len}u; i = i + 1u) {
    acc4 = fma(${wRead}, vFeat[fBase + i], acc4);
  }
  let h = silu(acc4.x + acc4.y + acc4.z + acc4.w + vFcSmall[k]);
  smRed[k] = h * vFcSmall[256u + k];
  workgroupBarrier();

  for (var stride: u32 = 128u; stride > 0u; stride = stride >> 1u) {
    if (k < stride) { smRed[k] = smRed[k] + smRed[k + stride]; }
    workgroupBarrier();
  }
  if (k == 0u) {
    let logit = smRed[0] + vFcSmall[512u];
    valProbOut[b] = 1.0 / (1.0 + exp(-logit));
  }
}`;
}

export class WebGpuResNet {
  constructor(device, adapterInfo, parsed) {
    this.device = device;
    this.adapterInfo = adapterInfo;
    this.inCh = parsed.inCh;
    this.stemInPad = parsed.stemInPad;
    this.ch = parsed.ch;
    this.blocks = parsed.blocks;
    this.useF16 = parsed.useF16;
    this.disposed = false;
    this.deviceLost = false;
    this.gpuErrors = [];
    device.addEventListener("uncapturederror", (ev) => {
      const m = ev.error ? ev.error.message : String(ev);
      if (this.gpuErrors.length < 8) this.gpuErrors.push(m);
    });
    if (device.lost && typeof device.lost.then === "function") {
      device.lost.then(() => { this.deviceLost = true; }).catch(() => { this.deviceLost = true; });
    }
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
    const wantF16 = opts.forceF32 ? false : !!adapter.features?.has?.("shader-f16");
    const device = await adapter.requestDevice(wantF16 ? { requiredFeatures: ["shader-f16"] } : undefined);
    const parsed = parseQgpuBinary(qgpuArrayBuffer, wantF16);
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
    const buf = this.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    if (u32Vals) this.device.queue.writeBuffer(buf, 0, new Uint32Array(u32Vals));
    return buf;
  }

  _buildResources(p) {
    const dev = this.device;
    const S_RW = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;

    this.pipePack = dev.createComputePipeline({
      layout: "auto",
      compute: { module: dev.createShaderModule({ code: makePackPlanesWgsl(p.inCh, p.stemInPad) }), entryPoint: "main" },
    });
    this.pipeConv = dev.createComputePipeline({
      layout: "auto",
      compute: { module: dev.createShaderModule({ code: makeConv3x3Wgsl(p.useF16) }), entryPoint: "main" },
    });
    this.pipeSe = dev.createComputePipeline({
      layout: "auto",
      compute: { module: dev.createShaderModule({ code: makeGPoolSeResWgsl(p.ch) }), entryPoint: "main" },
    });
    this.pipeHead1 = dev.createComputePipeline({
      layout: "auto",
      compute: { module: dev.createShaderModule({ code: makeHead1Wgsl(p.ch) }), entryPoint: "main" },
    });
    this.pipeHead2 = dev.createComputePipeline({
      layout: "auto",
      compute: { module: dev.createShaderModule({ code: makeHead2Wgsl(p.vFc0In, p.useF16) }), entryPoint: "main" },
    });

    const boardsBytes = ((MAX_BATCH * BOARD_SQ + 3) & ~3);
    this.bufBoards = dev.createBuffer({ size: boardsBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.bufDense = dev.createBuffer({ size: MAX_BATCH * 16 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.bufLastPts = dev.createBuffer({ size: MAX_BATCH * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.bufPlanes = dev.createBuffer({ size: MAX_BATCH * BOARD_SQ * p.stemInPad * 4, usage: GPUBufferUsage.STORAGE });
    this.bufActA = dev.createBuffer({ size: MAX_BATCH * BOARD_SQ * p.ch * 4, usage: GPUBufferUsage.STORAGE });
    this.bufActB = dev.createBuffer({ size: MAX_BATCH * BOARD_SQ * p.ch * 4, usage: GPUBufferUsage.STORAGE });
    this.bufActC = dev.createBuffer({ size: MAX_BATCH * BOARD_SQ * p.ch * 4, usage: GPUBufferUsage.STORAGE });
    this.bufVFeat = dev.createBuffer({ size: MAX_BATCH * p.vFc0In * 4, usage: GPUBufferUsage.STORAGE });
    this.bufValOut = dev.createBuffer({ size: MAX_BATCH * 4, usage: S_RW });
    this.bufPolOut = dev.createBuffer({ size: MAX_BATCH * 82 * 4, usage: S_RW });
    this.bufReadVal = dev.createBuffer({ size: MAX_BATCH * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    this.bufReadPol = dev.createBuffer({ size: MAX_BATCH * 82 * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });

    this.uPack = this._createUniform([1, 0, 0, 0]);
    this.uStem = this._createUniform([1, p.stemInPad, p.ch, 1]);
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
    if (this.disposed || this.deviceLost) throw new Error("WebGpuResNet unavailable");
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
      u[1] = this.stemInPad; u[2] = this.ch; u[3] = 1;
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

    const wgN = this.ch >> 5;
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
    for (let i = 0; i < iters; i++) await this.evalBatch(batchSize, b, d, lp);
    const dtMs = Math.max(0.1, performance.now() - t0);
    const msPerBatch = dtMs / iters;
    return { batchSize, iters, msPerBatch, boardsPerSec: (batchSize * 1000) / msPerBatch, useF16: this.useF16 };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const buf of this._ownedBufs) { try { buf.destroy(); } catch {} }
    this._ownedBufs = [];
    try { this.device.destroy(); } catch {}
  }
}
