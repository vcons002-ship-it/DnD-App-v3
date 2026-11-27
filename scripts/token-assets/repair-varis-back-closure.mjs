/** Close the open cutout behind Varis' quiver (and hood-collar pinhole) across all runtime tiers. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createDeliveryIO, optimizeDelivery } from '../../server/tools/asset-production/lossless_delivery.mjs';
import { shareGlbTextures, restoreSharedGlb, verifySharedDelivery } from './shared-character-textures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const miniaturesDir = path.join(root, 'client/public/miniatures');
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const srgbToLinear = (byteVal) => {
  const c = Math.max(0, Math.min(1, byteVal / 255));
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

function readJson(relPath) {
  return JSON.parse(readFileSync(path.join(root, relPath), 'utf8'));
}

async function writeJson(relPath, data) {
  const abs = path.join(root, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const text = JSON.stringify(data, null, 2) + '\n';
  await fs.writeFile(abs, text, 'utf8');
  return sha256(Buffer.from(text, 'utf8'));
}

function posKey(v) {
  return `${Math.round(v[0] * 1e4)},${Math.round(v[1] * 1e4)},${Math.round(v[2] * 1e4)}`;
}

function transformPoint(mat, v) {
  return [
    mat[0] * v[0] + mat[4] * v[1] + mat[8] * v[2] + mat[12],
    mat[1] * v[0] + mat[5] * v[1] + mat[9] * v[2] + mat[13],
    mat[2] * v[0] + mat[6] * v[1] + mat[10] * v[2] + mat[14],
  ];
}

function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function normVec(v) {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 1e-12 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, -1];
}

function newellNormal(cycle, coords) {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < cycle.length; i++) {
    const a = coords[cycle[i]];
    const b = coords[cycle[(i + 1) % cycle.length]];
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return normVec([nx, ny, nz]);
}

/**
 * Liepa (2003) 3D minimum-weight polygon triangulation DP for a closed simple
 * cycle whose projections may fold or self-intersect in 2D.
 */
function minWeightTriangulate3D(cycle, coords) {
  const n = cycle.length;
  assert(n >= 3, `Expected polygon with >= 3 vertices, got ${n}`);
  if (n === 3) return [[cycle[0], cycle[1], cycle[2]]];

  const unitN = newellNormal(cycle, coords);
  const dp = Array.from({ length: n }, () => new Float64Array(n));
  const choice = Array.from({ length: n }, () => new Int32Array(n).fill(-1));

  const triCost = (ia, ib, ic) => {
    const pa = coords[cycle[ia]];
    const pb = coords[cycle[ib]];
    const pc = coords[cycle[ic]];
    const cr = cross(sub(pb, pa), sub(pc, pa));
    const len = Math.hypot(cr[0], cr[1], cr[2]);
    const area = 0.5 * len;
    if (len <= 1e-12) return 1e6;
    const align = dot([cr[0] / len, cr[1] / len, cr[2] / len], unitN);
    return area * (1 + 4 * Math.max(0, -align));
  };

  for (let gap = 2; gap < n; gap++) {
    for (let i = 0; i + gap < n; i++) {
      const k = i + gap;
      let best = Infinity;
      let bestJ = -1;
      for (let j = i + 1; j < k; j++) {
        const w = dp[i][j] + dp[j][k] + triCost(i, j, k);
        if (w < best) {
          best = w;
          bestJ = j;
        }
      }
      dp[i][k] = best;
      choice[i][k] = bestJ;
    }
  }

  const tris = [];
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [i, k] = stack.pop();
    if (k - i < 2) continue;
    const j = choice[i][k];
    assert(j > i && j < k, 'Missing DP split vertex');
    tris.push([cycle[i], cycle[j], cycle[k]]);
    stack.push([i, j], [j, k]);
  }
  return tris;
}

function minTriAngle(pa, pb, pc) {
  const ab = sub(pb, pa);
  const ac = sub(pc, pa);
  const bc = sub(pc, pb);
  const lab = Math.hypot(...ab);
  const lac = Math.hypot(...ac);
  const lbc = Math.hypot(...bc);
  if (lab < 1e-12 || lac < 1e-12 || lbc < 1e-12) return 0;
  const clampCos = (v) => Math.max(-1, Math.min(1, v));
  const a1 = Math.acos(clampCos(dot(ab, ac) / (lab * lac)));
  const a2 = Math.acos(clampCos(-dot(ab, bc) / (lab * lbc)));
  const a3 = Math.max(0, Math.PI - a1 - a2);
  return Math.min(a1, a2, a3);
}

function makeXYGrid(triangles, minX, minY, maxX, maxY, cells = 36) {
  const dx = Math.max(1e-4, maxX - minX);
  const dy = Math.max(1e-4, maxY - minY);
  const buckets = Array.from({ length: cells * cells }, () => []);
  const toCellX = (x) => Math.max(0, Math.min(cells - 1, Math.floor(((x - minX) / dx) * cells)));
  const toCellY = (y) => Math.max(0, Math.min(cells - 1, Math.floor(((y - minY) / dy) * cells)));

  for (const tri of triangles) {
    const [a, b, c] = tri;
    const cx0 = toCellX(Math.min(a[0], b[0], c[0]));
    const cx1 = toCellX(Math.max(a[0], b[0], c[0]));
    const cy0 = toCellY(Math.min(a[1], b[1], c[1]));
    const cy1 = toCellY(Math.max(a[1], b[1], c[1]));
    for (let gy = cy0; gy <= cy1; gy++) {
      for (let gx = cx0; gx <= cx1; gx++) {
        buckets[gy * cells + gx].push(tri);
      }
    }
  }

  return (x, y) => {
    if (x < minX || x > maxX || y < minY || y > maxY) return [];
    return buckets[toCellY(y) * cells + toCellX(x)];
  };
}

function sampleTriZAtXY(a, b, c, x, y) {
  const denom = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
  if (Math.abs(denom) < 1e-12) return null;
  const w0 = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / denom;
  const w1 = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / denom;
  const w2 = 1 - w0 - w1;
  if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) return null;
  return w0 * a[2] + w1 * b[2] + w2 * c[2];
}

function buildClosureMeshData(doc, bodyTexRaw, bodyTexInfo) {
  const bodyNode = doc.getRoot().listNodes().find((n) => n.getName() === 'Varis_Preserved_Body');
  assert(bodyNode, 'Varis_Preserved_Body node is missing');
  const bodyMat = bodyNode.getWorldMatrix();
  const bodyPrim = bodyNode.getMesh().listPrimitives()[0];
  const posAcc = bodyPrim.getAttribute('POSITION');
  const normAcc = bodyPrim.getAttribute('NORMAL');
  const uvAcc = bodyPrim.getAttribute('TEXCOORD_0');
  const idxArr = bodyPrim.getIndices().getArray();
  const nBodyTris = idxArr.length / 3;

  // Weld body positions
  const pmap = new Map();
  const pid = new Int32Array(posAcc.getCount());
  const bodyVerts = []; // { coord: [x,y,z], orig: number[] }
  for (let i = 0; i < posAcc.getCount(); i++) {
    const v = transformPoint(bodyMat, posAcc.getElement(i, [0, 0, 0]));
    const k = posKey(v);
    let id = pmap.get(k);
    if (id === undefined) {
      id = bodyVerts.length;
      pmap.set(k, id);
      bodyVerts.push({ coord: v, orig: [] });
    }
    bodyVerts[id].orig.push(i);
    pid[i] = id;
  }

  // Extract largest connected component on Varis_Preserved_Body (ignores detached micro slivers)
  const vTris = Array.from({ length: bodyVerts.length }, () => []);
  for (let t = 0; t < nBodyTris; t++) {
    const a = pid[idxArr[t * 3]];
    const b = pid[idxArr[t * 3 + 1]];
    const c = pid[idxArr[t * 3 + 2]];
    if (a === b || b === c || c === a) continue;
    vTris[a].push(t);
    vTris[b].push(t);
    vTris[c].push(t);
  }
  const seenTri = new Uint8Array(nBodyTris);
  let mainTris = [];
  for (let t = 0; t < nBodyTris; t++) {
    if (seenTri[t]) continue;
    const comp = [];
    const q = [t];
    seenTri[t] = 1;
    while (q.length) {
      const cur = q.pop();
      comp.push(cur);
      for (let k = 0; k < 3; k++) {
        for (const nb of vTris[pid[idxArr[cur * 3 + k]]]) {
          if (!seenTri[nb]) {
            seenTri[nb] = 1;
            q.push(nb);
          }
        }
      }
    }
    if (comp.length > mainTris.length) mainTris = comp;
  }
  assert(mainTris.length > 30000, `Unexpected main body component triangle count: ${mainTris.length}`);

  const coords = bodyVerts.map((v) => v.coord);
  const edgeCount = new Map();
  const dirEdges = [];
  const frontChestTris = [];
  for (const t of mainTris) {
    const a = pid[idxArr[t * 3]];
    const b = pid[idxArr[t * 3 + 1]];
    const c = pid[idxArr[t * 3 + 2]];
    if (a === b || b === c || c === a) continue;
    const pa = coords[a];
    const pb = coords[b];
    const pc = coords[c];
    const cz = (pa[2] + pb[2] + pc[2]) / 3;
    const cx = (pa[0] + pb[0] + pc[0]) / 3;
    const cy = (pa[1] + pb[1] + pc[1]) / 3;
    if (cz > -0.05 && cx >= -0.15 && cx <= 0.4 && cy >= 0.1 && cy <= 0.78) {
      frontChestTris.push([pa, pb, pc]);
    }
    for (const [u, v] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      const k = u < v ? `${u},${v}` : `${v},${u}`;
      edgeCount.set(k, (edgeCount.get(k) || 0) + 1);
      dirEdges.push([u, v, k]);
    }
  }

  const openEdges = dirEdges.filter(([, , k]) => edgeCount.get(k) === 1);
  const isQuiverHole = (p) => p[0] >= -0.08 && p[0] <= 0.35 && p[1] >= 0.15 && p[1] <= 0.74 && p[2] <= -0.12;
  const isHoodPinhole = (p) =>
    p[0] >= -0.06 && p[0] <= 0.0 && p[1] >= 0.745 && p[1] <= 0.775 && p[2] >= -0.175 && p[2] <= -0.13;

  const traceCycles = (edges, label) => {
    const eAdj = new Map();
    for (let i = 0; i < edges.length; i++) {
      // Traverse hole boundary in v -> u so patch winding matches Varis_Preserved_Body outward normals.
      const [u, v] = edges[i];
      if (!eAdj.has(v)) eAdj.set(v, []);
      eAdj.get(v).push({ to: u, ei: i });
    }
    const used = new Uint8Array(edges.length);
    const out = [];
    for (let i = 0; i < edges.length; i++) {
      if (used[i]) continue;
      const cycle = [];
      let cur = edges[i][1];
      const start = cur;
      let guard = 0;
      while (guard++ < 1000) {
        const outs = (eAdj.get(cur) || []).filter((e) => !used[e.ei]);
        if (!outs.length) break;
        let pick = outs[0];
        if (outs.length > 1 && cycle.length > 0) {
          const prev = coords[cycle[cycle.length - 1]];
          const here = coords[cur];
          const d0 = normVec(sub(here, prev));
          let bestDot = -Infinity;
          for (const cand of outs) {
            const d1 = normVec(sub(coords[cand.to], here));
            const dp = dot(d0, d1);
            if (dp > bestDot) {
              bestDot = dp;
              pick = cand;
            }
          }
        }
        used[pick.ei] = 1;
        cycle.push(cur);
        cur = pick.to;
        if (cur === start) break;
      }
      assert.equal(cur, start, `${label} cycle did not close cleanly`);
      assert(cycle.length >= 3, `${label} cycle too short: ${cycle.length}`);
      out.push(cycle);
    }
    return out;
  };

  const quiverCycles = traceCycles(
    openEdges.filter(([u, v]) => isQuiverHole(coords[u]) && isQuiverHole(coords[v])),
    'quiver-cutout',
  );
  const hoodCycles = traceCycles(
    openEdges.filter(([u, v]) => isHoodPinhole(coords[u]) && isHoodPinhole(coords[v])),
    'hood-pinhole',
  );
  const allCycles = [...quiverCycles, ...hoodCycles];
  allCycles.sort((a, b) => b.length - a.length);
  assert(allCycles.length >= 2 && allCycles[0].length >= 150, `Expected main quiver cycle + hood cycle, got ${allCycles.map((c) => c.length)}`);

  // Quiver shell triangles for Z clearance constraints
  const quiverShellNames = new Set([
    'VarisV4_Stitched_Leather_Quiver',
    'VarisV4_Leather_Bottom_Band',
    'VarisV4_Closed_Leather_Bottom',
    'VarisV4_Rim_And_Carry_Band',
    'VarisV4_Rolled_Open_Leather_Rim',
    'VarisV4_Fitted_Leather_Mount_Tab',
    'VarisV4_Leather_Center_Seam',
    'VarisV4_Individual_Waxed_Stitches',
  ]);
  const quiverTris = [];
  for (const node of doc.getRoot().listNodes()) {
    if (!quiverShellNames.has(node.getName())) continue;
    const mat4 = node.getWorldMatrix();
    for (const p of node.getMesh()?.listPrimitives() ?? []) {
      const a = p.getAttribute('POSITION');
      const ix = p.getIndices().getArray();
      const wpts = new Array(a.getCount());
      for (let i = 0; i < a.getCount(); i++) wpts[i] = transformPoint(mat4, a.getElement(i, [0, 0, 0]));
      for (let t = 0; t < ix.length; t += 3) quiverTris.push([wpts[ix[t]], wpts[ix[t + 1]], wpts[ix[t + 2]]]);
    }
  }
  const quiverLookup = makeXYGrid(quiverTris, -0.06, 0.14, 0.38, 0.76);
  const chestLookup = makeXYGrid(frontChestTris, -0.15, 0.1, 0.4, 0.78);

  const quiverFrontMaxZ = (x, y) => {
    let maxZ = -Infinity;
    for (const [ox, oy] of [
      [0, 0],
      [-0.005, 0],
      [0.005, 0],
      [0, -0.005],
      [0, 0.005],
    ]) {
      const px = x + ox;
      const py = y + oy;
      for (const [a, b, c] of quiverLookup(px, py)) {
        const z = sampleTriZAtXY(a, b, c, px, py);
        if (z !== null && z > maxZ) maxZ = z;
      }
    }
    return maxZ;
  };
  const frontChestMinZ = (x, y) => {
    let minZ = Infinity;
    for (const [a, b, c] of chestLookup(x, y)) {
      const z = sampleTriZAtXY(a, b, c, x, y);
      if (z !== null && z < minZ) minZ = z;
    }
    return minZ;
  };

  const sampleBoundaryLinearColor = (bodyVertId) => {
    const bv = bodyVerts[bodyVertId];
    let sr = 0;
    let sg = 0;
    let sb = 0;
    let cnt = 0;
    const w = bodyTexInfo.width;
    const h = bodyTexInfo.height;
    for (const oi of bv.orig) {
      const t = uvAcc.getElement(oi, [0, 0]);
      const px = Math.max(0, Math.min(w - 1, Math.round(t[0] * (w - 1))));
      const py = Math.max(0, Math.min(h - 1, Math.round(t[1] * (h - 1))));
      const off = (py * w + px) * 4;
      sr += bodyTexRaw[off];
      sg += bodyTexRaw[off + 1];
      sb += bodyTexRaw[off + 2];
      cnt++;
    }
    let r = cnt ? sr / cnt : 36;
    let g = cnt ? sg / cnt : 35;
    let b = cnt ? sb / cnt : 24;
    const lum = (r + g + b) / 3;
    // Suppress stray leather/flesh/highlight texels from the old quiver cut edge toward deep olive cloak shadow.
    if (lum > 56 || r - g > 8 || b > r + 4) {
      const blend = lum > 75 || r - g > 14 || b > r + 12 ? 0.94 : 0.8;
      r = r * (1 - blend) + 36 * blend;
      g = g * (1 - blend) + 35 * blend;
      b = b * (1 - blend) + 24 * blend;
    }
    return [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)];
  };

  const sampleBoundaryBodyNormal = (bodyVertId) => {
    const bv = bodyVerts[bodyVertId];
    const sum = [0, 0, 0];
    for (const oi of bv.orig) {
      const n = normAcc.getElement(oi, [0, 0, 0]);
      sum[0] += n[0];
      sum[1] += n[1];
      sum[2] += n[2];
    }
    return normVec(sum);
  };

  const shadowInteriorLinear = [srgbToLinear(34), srgbToLinear(35), srgbToLinear(24)];
  const undir = (u, v) => (u < v ? `${u},${v}` : `${v},${u}`);

  const buildCyclePatch = (cycle, refineMain) => {
    const localIdByBodyId = new Map();
    const verts = [];
    const colors = [];
    const isBoundary = [];
    const bodyNormals = [];
    for (const bId of cycle) {
      localIdByBodyId.set(bId, verts.length);
      verts.push([...coords[bId]]);
      colors.push(sampleBoundaryLinearColor(bId));
      isBoundary.push(true);
      bodyNormals.push(sampleBoundaryBodyNormal(bId));
    }

    const boundaryEdgeKeys = new Set();
    for (let i = 0; i < cycle.length; i++) {
      const a = localIdByBodyId.get(cycle[i]);
      const b = localIdByBodyId.get(cycle[(i + 1) % cycle.length]);
      boundaryEdgeKeys.add(undir(a, b));
    }

    const dpTris = minWeightTriangulate3D(cycle, coords);
    let tris = dpTris.map(([a, b, c]) => [
      localIdByBodyId.get(a),
      localIdByBodyId.get(b),
      localIdByBodyId.get(c),
    ]);
    const unitN = newellNormal(cycle, coords);

    if (refineMain) {
      const targetLen = 0.022;
      const maxArea = 0.65 * targetLen * targetLen;
      for (let pass = 0; pass < 4; pass++) {
        // 1. Split long interior edges only (never boundary edges -> zero T-junctions)
        const edgeTris = new Map();
        for (let ti = 0; ti < tris.length; ti++) {
          const [a, b, c] = tris[ti];
          for (const [u, v] of [
            [a, b],
            [b, c],
            [c, a],
          ]) {
            const k = undir(u, v);
            if (!edgeTris.has(k)) edgeTris.set(k, []);
            edgeTris.get(k).push({ ti, u, v });
          }
        }
        const deadTri = new Uint8Array(tris.length);
        const added = [];
        for (const [k, refs] of edgeTris) {
          if (boundaryEdgeKeys.has(k) || refs.length !== 2) continue;
          const [r0, r1] = refs;
          if (deadTri[r0.ti] || deadTri[r1.ti]) continue;
          const pa = verts[r0.u];
          const pb = verts[r0.v];
          if (Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]) <= targetLen) continue;
          const mid = verts.length;
          verts.push([(pa[0] + pb[0]) * 0.5, (pa[1] + pb[1]) * 0.5, (pa[2] + pb[2]) * 0.5]);
          const ca = colors[r0.u];
          const cb = colors[r0.v];
          colors.push([(ca[0] + cb[0]) * 0.5, (ca[1] + cb[1]) * 0.5, (ca[2] + cb[2]) * 0.5]);
          isBoundary.push(false);
          bodyNormals.push(null);

          for (const r of [r0, r1]) {
            const t = tris[r.ti];
            const opp = t.find((x) => x !== r.u && x !== r.v);
            added.push([r.u, mid, opp], [mid, r.v, opp]);
            deadTri[r.ti] = 1;
          }
        }
        if (added.length) {
          tris = tris.filter((_, i) => !deadTri[i]).concat(added);
        }

        // 2. Centroid-split overly large interior triangles
        const nextTris = [];
        for (const [a, b, c] of tris) {
          const cr = cross(sub(verts[b], verts[a]), sub(verts[c], verts[a]));
          const area = 0.5 * Math.hypot(...cr);
          if (area > maxArea) {
            const cid = verts.length;
            verts.push([
              (verts[a][0] + verts[b][0] + verts[c][0]) / 3,
              (verts[a][1] + verts[b][1] + verts[c][1]) / 3,
              (verts[a][2] + verts[b][2] + verts[c][2]) / 3,
            ]);
            colors.push([
              (colors[a][0] + colors[b][0] + colors[c][0]) / 3,
              (colors[a][1] + colors[b][1] + colors[c][1]) / 3,
              (colors[a][2] + colors[b][2] + colors[c][2]) / 3,
            ]);
            isBoundary.push(false);
            bodyNormals.push(null);
            nextTris.push([a, b, cid], [b, c, cid], [c, a, cid]);
          } else {
            nextTris.push([a, b, c]);
          }
        }
        tris = nextTris;

        // 3. Interior Delaunay edge flips for well-shaped triangles
        for (let flipSweep = 0; flipSweep < 3; flipSweep++) {
          let flipped = false;
          const allEdgeKeys = new Set();
          const eMap = new Map();
          for (let ti = 0; ti < tris.length; ti++) {
            const [a, b, c] = tris[ti];
            for (const [u, v, opp] of [
              [a, b, c],
              [b, c, a],
              [c, a, b],
            ]) {
              const k = undir(u, v);
              allEdgeKeys.add(k);
              if (!eMap.has(k)) eMap.set(k, []);
              eMap.get(k).push({ ti, u, v, opp });
            }
          }
          const touched = new Uint8Array(tris.length);
          for (const [k, refs] of eMap) {
            if (boundaryEdgeKeys.has(k) || refs.length !== 2) continue;
            const [r1, r2] = refs;
            if (touched[r1.ti] || touched[r2.ti] || r1.opp === r2.opp) continue;
            const a = r1.u;
            const b = r1.v;
            const c = r1.opp;
            const d = r2.opp;
            if (r2.u !== b || r2.v !== a) continue;
            const diagKey = undir(c, d);
            if (allEdgeKeys.has(diagKey)) continue;

            const n1New = cross(sub(verts[d], verts[a]), sub(verts[c], verts[a]));
            const n2New = cross(sub(verts[b], verts[d]), sub(verts[c], verts[d]));
            if (Math.hypot(...n1New) < 1e-12 || Math.hypot(...n2New) < 1e-12) continue;
            if (dot(normVec(n1New), unitN) <= 0.15 || dot(normVec(n2New), unitN) <= 0.15) continue;

            const minBefore = Math.min(
              minTriAngle(verts[a], verts[b], verts[c]),
              minTriAngle(verts[b], verts[a], verts[d]),
            );
            const minAfter = Math.min(
              minTriAngle(verts[a], verts[d], verts[c]),
              minTriAngle(verts[d], verts[b], verts[c]),
            );
            if (minAfter > minBefore + 1e-4) {
              tris[r1.ti] = [a, d, c];
              tris[r2.ti] = [d, b, c];
              touched[r1.ti] = 1;
              touched[r2.ti] = 1;
              allEdgeKeys.delete(k);
              allEdgeKeys.add(diagKey);
              flipped = true;
            }
          }
          if (!flipped) break;
        }
      }

      // Initialize interior vertex colors to shadowed olive cloak
      for (let i = 0; i < verts.length; i++) {
        if (!isBoundary[i]) colors[i] = [...shadowInteriorLinear];
      }

      // Build vertex neighbors for Laplacian harmonic fairing
      const nbrs = Array.from({ length: verts.length }, () => new Set());
      for (const [a, b, c] of tris) {
        nbrs[a].add(b);
        nbrs[a].add(c);
        nbrs[b].add(a);
        nbrs[b].add(c);
        nbrs[c].add(a);
        nbrs[c].add(b);
      }

      const clampVertexZ = (v) => {
        const qMaxZ = quiverFrontMaxZ(v[0], v[1]);
        const cMinZ = frontChestMinZ(v[0], v[1]);
        const upperZ = (cMinZ < Infinity ? cMinZ : 0.04) - 0.025;
        if (qMaxZ > -Infinity) {
          v[2] = Math.max(v[2], Math.min(upperZ, qMaxZ + 0.006));
        } else {
          v[2] = Math.min(v[2], upperZ);
        }
      };

      for (let iter = 0; iter < 60; iter++) {
        const nextPos = verts.map((v) => [...v]);
        const nextCol = colors.map((c) => [...c]);
        for (let i = 0; i < verts.length; i++) {
          if (isBoundary[i] || nbrs[i].size === 0) continue;
          let sx = 0;
          let sy = 0;
          let sz = 0;
          let sr = 0;
          let sg = 0;
          let sb = 0;
          for (const nb of nbrs[i]) {
            sx += verts[nb][0];
            sy += verts[nb][1];
            sz += verts[nb][2];
            sr += colors[nb][0];
            sg += colors[nb][1];
            sb += colors[nb][2];
          }
          const k = 1 / nbrs[i].size;
          nextPos[i] = [sx * k, sy * k, sz * k];
          nextCol[i] = [sr * k, sg * k, sb * k];
          clampVertexZ(nextPos[i]);
        }
        for (let i = 0; i < verts.length; i++) {
          if (!isBoundary[i]) {
            verts[i] = nextPos[i];
            colors[i] = nextCol[i];
          }
        }
      }

      for (let iter = 0; iter < 15; iter++) {
        const nextZ = verts.map((v) => v[2]);
        for (let i = 0; i < verts.length; i++) {
          if (isBoundary[i] || nbrs[i].size === 0) continue;
          let sz = 0;
          for (const nb of nbrs[i]) sz += verts[nb][2];
          const zAvg = 0.5 * (verts[i][2] + sz / nbrs[i].size);
          const vTmp = [verts[i][0], verts[i][1], zAvg];
          const qMaxZ = quiverFrontMaxZ(vTmp[0], vTmp[1]);
          const cMinZ = frontChestMinZ(vTmp[0], vTmp[1]);
          const upperZ = (cMinZ < Infinity ? cMinZ : 0.04) - 0.025;
          nextZ[i] =
            qMaxZ > -Infinity
              ? Math.max(zAvg, Math.min(upperZ, qMaxZ + 0.005))
              : Math.min(zAvg, upperZ);
        }
        for (let i = 0; i < verts.length; i++) {
          if (!isBoundary[i]) verts[i][2] = nextZ[i];
        }
      }
    }

    // Verify aggregate winding points outward (-Z for back cycles)
    let signedDot = 0;
    for (const [a, b, c] of tris) {
      const cr = cross(sub(verts[b], verts[a]), sub(verts[c], verts[a]));
      signedDot += dot(cr, unitN);
    }
    assert(signedDot > 0, `Patch winding inverted relative to Newell normal (${signedDot})`);

    // Area-weighted smooth vertex normals
    const accum = verts.map(() => [0, 0, 0]);
    for (const [a, b, c] of tris) {
      const cr = cross(sub(verts[b], verts[a]), sub(verts[c], verts[a]));
      for (const vid of [a, b, c]) {
        accum[vid][0] += cr[0];
        accum[vid][1] += cr[1];
        accum[vid][2] += cr[2];
      }
    }
    const normals = verts.map((_, i) => {
      const pn = normVec(accum[i]);
      if (isBoundary[i] && bodyNormals[i]) {
        const bn = bodyNormals[i];
        return normVec([bn[0] * 0.65 + pn[0] * 0.35, bn[1] * 0.65 + pn[1] * 0.35, bn[2] * 0.65 + pn[2] * 0.35]);
      }
      return pn;
    });

    return { verts, normals, colors, tris, bodyTriPairs: cycle };
  };

  // Merge all cycles into one primitive buffer
  const mergedVerts = [];
  const mergedNormals = [];
  const mergedColors = [];
  const mergedIndices = [];
  for (let ci = 0; ci < allCycles.length; ci++) {
    const patch = buildCyclePatch(allCycles[ci], ci === 0);
    const base = mergedVerts.length;
    mergedVerts.push(...patch.verts);
    mergedNormals.push(...patch.normals);
    mergedColors.push(...patch.colors);
    for (const [a, b, c] of patch.tris) mergedIndices.push(base + a, base + b, base + c);
  }

  // Assert merging patch with main body leaves zero open edges in quiver & hood-pinhole regions
  const mergedPmap = new Map(pmap);
  const mergedCoords = [...coords];
  const getMergedId = (v) => {
    const k = posKey(v);
    let id = mergedPmap.get(k);
    if (id === undefined) {
      id = mergedCoords.length;
      mergedPmap.set(k, id);
      mergedCoords.push(v);
    }
    return id;
  };
  const checkEdgeCount = new Map();
  const addTriEdges = (a, b, c) => {
    for (const [u, v] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      const k = u < v ? `${u},${v}` : `${v},${u}`;
      checkEdgeCount.set(k, (checkEdgeCount.get(k) || 0) + 1);
    }
  };
  for (const t of mainTris) {
    addTriEdges(pid[idxArr[t * 3]], pid[idxArr[t * 3 + 1]], pid[idxArr[t * 3 + 2]]);
  }
  const patchMergedIds = mergedVerts.map((v) => getMergedId(v));
  for (let i = 0; i < mergedIndices.length; i += 3) {
    addTriEdges(
      patchMergedIds[mergedIndices[i]],
      patchMergedIds[mergedIndices[i + 1]],
      patchMergedIds[mergedIndices[i + 2]],
    );
  }
  let residualQuiverOpen = 0;
  let residualHoodOpen = 0;
  for (const [k, cnt] of checkEdgeCount) {
    if (cnt !== 1) continue;
    const [u, v] = k.split(',').map(Number);
    if (isQuiverHole(mergedCoords[u]) && isQuiverHole(mergedCoords[v])) residualQuiverOpen++;
    if (isHoodPinhole(mergedCoords[u]) && isHoodPinhole(mergedCoords[v])) residualHoodOpen++;
  }
  assert.equal(residualQuiverOpen, 0, `Expected 0 residual quiver cutout open edges, got ${residualQuiverOpen}`);
  assert.equal(residualHoodOpen, 0, `Expected 0 residual hood pinhole open edges, got ${residualHoodOpen}`);

  return {
    vertices: mergedVerts.length,
    triangles: mergedIndices.length / 3,
    positions: new Float32Array(mergedVerts.flat()),
    normals: new Float32Array(mergedNormals.flat()),
    colors: new Float32Array(mergedColors.flat()),
    indices:
      mergedVerts.length > 65535
        ? new Uint32Array(mergedIndices)
        : new Uint16Array(mergedIndices),
  };
}

const mainManifest = readJson('client/public/miniatures/manifest.json');
const qualityManifest = readJson('client/public/miniatures/quality-manifest.json');
const battlefieldManifest = readJson('client/public/miniatures/battlefield-manifest.json');

const snapshotNonVaris = (m) => JSON.stringify(m.models.filter((v) => v.id !== 'varis'));
const initialNonVaris = [mainManifest, qualityManifest, battlefieldManifest].map(snapshotNonVaris);

const oldVarisSharedFiles = [
  mainManifest.models.find((m) => m.id === 'varis')?.url,
  ...qualityManifest.models.filter((m) => m.id === 'varis').map((m) => m.url),
  battlefieldManifest.models.find((m) => m.id === 'varis')?.url,
]
  .filter(Boolean)
  .map((u) => path.join(root, 'client/public', u));

const highEntry = mainManifest.models.find((m) => m.id === 'varis');
assert(highEntry, 'Varis missing from manifest.json');
const highDelivery = verifySharedDelivery(highEntry, root);
const restoredBytes = restoreSharedGlb(
  readFileSync(path.join(root, 'client/public', highEntry.url)),
  readJson(highEntry.sharedTextureReceipt),
  (uri) => readFileSync(path.join(miniaturesDir, uri)),
);

const io = await createDeliveryIO();
const doc = await io.readBinary(restoredBytes);
for (const oldNode of doc.getRoot().listNodes().filter((n) => n.getName() === 'Varis_Back_Quiver_Closure')) {
  oldNode.getMesh()?.dispose();
  oldNode.dispose();
}
for (const oldMat of doc.getRoot().listMaterials().filter((m) => m.getName() === 'Varis_Back_Quiver_Closure_Cloth')) {
  oldMat.dispose();
}

const bodyPrim = doc
  .getRoot()
  .listNodes()
  .find((n) => n.getName() === 'Varis_Preserved_Body')
  .getMesh()
  .listPrimitives()[0];
const bodyTex = bodyPrim.getMaterial().getBaseColorTexture();
const { data: bodyTexRaw, info: bodyTexInfo } = await sharp(bodyTex.getImage())
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });

const patch = buildClosureMeshData(doc, bodyTexRaw, bodyTexInfo);
console.log(`Built Varis_Back_Quiver_Closure: ${patch.vertices} vertices, ${patch.triangles} triangles (0 residual open edges).`);

const buffer = doc.getRoot().listBuffers()[0] ?? doc.createBuffer();
const closureMat = doc
  .createMaterial('Varis_Back_Quiver_Closure_Cloth')
  .setBaseColorFactor([1, 1, 1, 1])
  .setMetallicFactor(0)
  .setRoughnessFactor(0.9036020036098448)
  .setDoubleSided(true);

const closurePrim = doc
  .createPrimitive()
  .setMode(4)
  .setMaterial(closureMat)
  .setAttribute('POSITION', doc.createAccessor('varis_closure_pos').setType('VEC3').setArray(patch.positions).setBuffer(buffer))
  .setAttribute('NORMAL', doc.createAccessor('varis_closure_norm').setType('VEC3').setArray(patch.normals).setBuffer(buffer))
  .setAttribute('COLOR_0', doc.createAccessor('varis_closure_col').setType('VEC3').setArray(patch.colors).setBuffer(buffer))
  .setIndices(doc.createAccessor('varis_closure_idx').setType('SCALAR').setArray(patch.indices).setBuffer(buffer));

const closureMesh = doc.createMesh('Varis_Back_Quiver_Closure').addPrimitive(closurePrim);
const closureNode = doc.createNode('Varis_Back_Quiver_Closure').setMesh(closureMesh);
doc.getRoot().listScenes()[0].addChild(closureNode);

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'varis-back-closure-'));
const tempStandaloneFiles = [];
try {
  // Preserve pre-compression source baseline info before delivery compression
  const preOptBytes = Buffer.from(await io.writeBinary(doc));
  const preOptSha = sha256(preOptBytes);
  const opt = await optimizeDelivery(doc, io);
  const totalHighTris = opt.receipt.geometry.reduce((s, p) => s + p.triangles, 0);

  const highStandaloneName = `varis-back-closure-${opt.receipt.sha256.slice(0, 12)}.glb`;
  const highStandalonePath = path.join(miniaturesDir, highStandaloneName);
  await fs.writeFile(highStandalonePath, opt.bytes);
  tempStandaloneFiles.push(highStandalonePath);

  const optReceiptPath = 'assets/miniatures/character-compression/varis.json';
  const optReceipt = {
    ...opt.receipt,
    schemaVersion: 1,
    id: 'varis',
    sourceUrl: highDelivery.url,
    sourceSha256: preOptSha,
    sourceBytes: preOptBytes.length,
    url: `/miniatures/${highStandaloneName}`,
    triangles: totalHighTris,
    verified: { ...opt.receipt.verified, animationDataExact: true },
  };
  const optReceiptSha = await writeJson(optReceiptPath, optReceipt);

  for (const k of ['sharedTextureReceipt', 'sharedTextureReceiptSha256']) delete highEntry[k];
  Object.assign(highEntry, {
    url: `/miniatures/${highStandaloneName}`,
    sha256: opt.receipt.sha256,
    bytes: opt.bytes.length,
    triangles: totalHighTris,
    sourceVersion: 'varis-v5/back-quiver-closure-20261125',
    sourceSha256: preOptSha,
    sourceTriangles: totalHighTris,
    compression: 'EXT_meshopt_compression',
    originalTextures: true,
    sourceImageHashes: optReceipt.textures.map((t) => t.sourceSha256),
    runtimeImageHashes: optReceipt.textures.map((t) => t.sha256),
    deliveryOptimization: 'lossless-textures-and-mesh',
    optimizationReceipt: optReceiptPath,
    optimizationReceiptSha256: optReceiptSha,
  });
  await writeJson('client/public/miniatures/manifest.json', mainManifest);

  const runNode = (script, ...args) =>
    execFileSync(process.execPath, [script, ...args], { cwd: root, stdio: 'inherit' });

  // Rebuild Balanced & Low tiers + sharpen weapons
  const reducedDir = path.join(tmpDir, 'reduced');
  runNode('scripts/token-assets/reduce-characters.mjs', reducedDir, '--characters=varis');

  for (const [profile, label, refineReceiptRel] of [
    ['balanced', 'balanced', 'assets/miniatures/character-reduction/varis-balanced-sharpened-weapons.json'],
    ['low', 'light', 'assets/miniatures/character-reduction/varis-sharpened-weapons.json'],
  ]) {
    const redReceipt = JSON.parse(readFileSync(path.join(reducedDir, `varis-${label}.json`), 'utf8'));
    const redReceiptRel = `assets/miniatures/character-reduction/varis-${label}.json`;
    await writeJson(redReceiptRel, redReceipt);

    const sharpenOut = path.join(tmpDir, `sharpened-${profile}`);
    runNode('scripts/token-assets/sharpen-varis-weapons.mjs', path.join(reducedDir, redReceipt.filename), sharpenOut);
    const refReceipt = JSON.parse(readFileSync(path.join(sharpenOut, 'weapon-refinement.json'), 'utf8'));
    await writeJson(refineReceiptRel, refReceipt);

    const sharpenedAbs = path.join(sharpenOut, refReceipt.filename);
    const standaloneDest = path.join(miniaturesDir, refReceipt.filename);
    await fs.copyFile(sharpenedAbs, standaloneDest);
    tempStandaloneFiles.push(standaloneDest);

    const qIdx = qualityManifest.models.findIndex((m) => m.id === 'varis' && m.profile === profile);
    assert(qIdx >= 0, `Missing varis:${profile} in quality-manifest.json`);
    qualityManifest.models[qIdx] = {
      id: 'varis',
      profile,
      url: `/miniatures/${refReceipt.filename}`,
      sha256: refReceipt.sha256,
      bytes: refReceipt.bytes,
      triangles: refReceipt.triangles,
      sourceUrl: redReceipt.sourceUrl,
      sourceSha256: redReceipt.sourceSha256,
      receipt: redReceiptRel,
      refinementReceipt: refineReceiptRel,
    };
  }
  await writeJson('client/public/miniatures/quality-manifest.json', qualityManifest);

  // Rebuild Battlefield tier
  const bfDir = path.join(tmpDir, 'battlefield');
  runNode('scripts/token-assets/reduce-characters.mjs', bfDir, '--battlefield', '--characters=varis');
  const bfReceipt = JSON.parse(readFileSync(path.join(bfDir, 'varis-battlefield.json'), 'utf8'));
  const bfReceiptRel = 'assets/miniatures/battlefield-lod/varis.json';
  await writeJson(bfReceiptRel, bfReceipt);
  const bfDest = path.join(miniaturesDir, bfReceipt.filename);
  await fs.copyFile(path.join(bfDir, bfReceipt.filename), bfDest);
  tempStandaloneFiles.push(bfDest);

  const bIdx = battlefieldManifest.models.findIndex((m) => m.id === 'varis');
  assert(bIdx >= 0, 'Missing varis in battlefield-manifest.json');
  battlefieldManifest.models[bIdx] = {
    id: 'varis',
    url: `/miniatures/${bfReceipt.filename}`,
    sha256: bfReceipt.sha256,
    bytes: bfReceipt.bytes,
    triangles: bfReceipt.triangles,
    baseCenter: bfReceipt.baseCenter,
    baseDiameter: bfReceipt.baseDiameter,
    receipt: bfReceiptRel,
  };
  await writeJson('client/public/miniatures/battlefield-manifest.json', battlefieldManifest);

  // Re-share existing immutable textures across all 4 rebuilt Varis tiers
  const tierEntries = [
    { tier: 'high', entry: highEntry },
    ...qualityManifest.models.filter((m) => m.id === 'varis').map((entry) => ({ tier: entry.profile, entry })),
    { tier: 'battlefield', entry: battlefieldManifest.models[bIdx] },
  ];
  const newSharedFiles = new Set();
  for (const { tier, entry } of tierEntries) {
    const standaloneUrl = entry.url;
    const standaloneBytes = readFileSync(path.join(root, 'client/public', standaloneUrl));
    assert.equal(sha256(standaloneBytes), entry.sha256);
    const shared = shareGlbTextures(standaloneBytes);
    shared.receipt.sourceUrl = standaloneUrl;
    for (const img of shared.images) {
      const texPath = path.join(miniaturesDir, img.uri);
      if (existsSync(texPath)) {
        assert.equal(sha256(readFileSync(texPath)), img.sha256, `Texture hash mismatch on ${img.uri}`);
      } else {
        await fs.mkdir(path.dirname(texPath), { recursive: true });
        await fs.writeFile(texPath, img.payload);
      }
    }
    const sharedName = `varis-${tier}-shared-${shared.receipt.sha256.slice(0, 12)}.glb`;
    const sharedReceiptRel = `assets/miniatures/shared-textures/varis-${tier}.json`;
    const sharedReceiptSha = await writeJson(sharedReceiptRel, shared.receipt);
    const sharedAbs = path.join(miniaturesDir, sharedName);
    await fs.writeFile(sharedAbs, shared.bytes);
    newSharedFiles.add(path.resolve(sharedAbs));

    Object.assign(entry, {
      url: `/miniatures/${sharedName}`,
      bytes: shared.bytes.length,
      sha256: shared.receipt.sha256,
      sharedTextureReceipt: sharedReceiptRel,
      sharedTextureReceiptSha256: sharedReceiptSha,
    });
    verifySharedDelivery(entry, root);
    console.log(`Installed ${tier}: ${sharedName} (${entry.triangles.toLocaleString()} tris, ${(shared.bytes.length / 1e6).toFixed(2)} MB)`);
  }

  for (const [i, m] of [mainManifest, qualityManifest, battlefieldManifest].entries()) {
    assert.equal(snapshotNonVaris(m), initialNonVaris[i], 'Non-varis manifest entries must remain unchanged');
  }
  await writeJson('client/public/miniatures/manifest.json', mainManifest);
  await writeJson('client/public/miniatures/quality-manifest.json', qualityManifest);
  await writeJson('client/public/miniatures/battlefield-manifest.json', battlefieldManifest);

  // Clean up temporary standalone files and superseded old shared GLBs
  for (const f of tempStandaloneFiles) {
    if (existsSync(f)) unlinkSync(f);
  }
  for (const oldAbs of oldVarisSharedFiles) {
    if (!newSharedFiles.has(path.resolve(oldAbs)) && existsSync(oldAbs)) {
      unlinkSync(oldAbs);
    }
  }
} finally {
  for (const f of tempStandaloneFiles) {
    if (existsSync(f)) {
      try {
        unlinkSync(f);
      } catch {
        // best-effort cleanup
      }
    }
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
}
