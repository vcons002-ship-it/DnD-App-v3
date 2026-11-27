/**
 * Druk-style Hunyuan 2.1 4K PBR body retexturing pipeline for Varis & Vanec.
 *
 * Reproduces the exact workflow used on Druk's torso:
 *   1. Extract isolated world-space body nodes cleanly (zero decimation).
 *   2. Render 4 equally framed 1024x1024 orthographic RGBA reference views
 *      (or aligned concept-art refs for Varis A/B comparison).
 *   3. Run Hunyuan 2.1 multi-view PBR on isolated worker (:42006) at 768px / 6 views / 4K atlas.
 *   4. Match painted triangle corners back to exact source corners via cKDTree
 *      (< 2e-6 error) and restore original positions & smooth shading normals.
 *   5. Pack 4K WebP albedo + glTF metallicRoughness back onto target nodes only
 *      (leaving heads, hands, weapons, quiver/back-closure, staff, crown, FX, and
 *      animations untouched), then optionally install across all 4 quality tiers.
 *
 * Usage:
 *   node scripts/token-assets/druk-style-body-pbr.mjs --characters=varis --varis-refs=rendered --trial-only
 *   node scripts/token-assets/druk-style-body-pbr.mjs --characters=varis --varis-refs=concept --trial-only
 *   node scripts/token-assets/druk-style-body-pbr.mjs --characters=vanec --trial-only
 *   node scripts/token-assets/druk-style-body-pbr.mjs --install-from=varis=<dir>,vanec=<dir>
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document, PropertyType } from '@gltf-transform/core';
import { EXTMeshoptCompression, EXTTextureWebP } from '@gltf-transform/extensions';
import { copyToDocument, prune, reorder, unpartition, weld } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { Matrix3, Matrix4, Vector3 } from 'three';
import { createDeliveryIO, geometryFingerprint, optimizeDelivery, texturePixels } from '../../server/tools/asset-production/lossless_delivery.mjs';
import { restoreSharedGlb, sha256, shareGlbTextures, verifySharedDelivery } from './shared-character-textures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const miniaturesDir = path.join(root, 'client/public/miniatures');
const threeDir = path.join(root, 'node_modules/three');
const mapScript = path.join(root, 'scripts/token-assets/map_body_corners.py');
const HUNYUAN_PYTHON = 'C:\\pinokio\\api\\Hunyuan3D-2.1-WinPortable\\runtime\\Hunyuan3D2_WinPortable\\python_standalone\\python.exe';
const DEFAULT_TRIAL_ROOT = 'C:/Users/vcons/.gemini/antigravity/brain/8af145fc-b14a-4506-b206-d3da1518c47b/scratch/hunyuan-trials';
const DEFAULT_WORKER_URL = 'http://127.0.0.1:42006';

const CHAR_CONFIG = {
  varis: {
    targetNodes: [
      'Varis_Preserved_Body',
      'VarisV5_Right_Original_Bracer_Clip',
      'VarisV5_Left_Original_Bracer_Clip',
    ],
    faceBudget: 120000,
    tierName: (t) => `varis-${t}-shared`,
    standalonePrefix: 'varis-hunyuan-body',
    optReceiptRel: 'assets/miniatures/character-compression/varis.json',
    redBalancedRel: 'assets/miniatures/character-reduction/varis-balanced.json',
    redLowRel: 'assets/miniatures/character-reduction/varis-light.json',
    bfReceiptRel: 'assets/miniatures/battlefield-lod/varis.json',
    sharedReceiptRel: (t) => `assets/miniatures/shared-textures/varis-${t}.json`,
    sourceVersion: 'varis-v5/hunyuan-body-pbr-20261126',
    sharpenWeapons: true,
    conceptRefs: {
      front: 'assets/miniatures/references/varis/body-front.png',
      back: 'assets/miniatures/references/varis/body-back.png',
      // API left/right match Three.js orthographic cameras at -X/+X (see Druk provenance)
      left: 'assets/miniatures/references/varis/body-right.png',
      right: 'assets/miniatures/references/varis/body-left.png',
    },
  },
  vanec: {
    targetNodes: [
      'Vanec_Preserved_Body',
      'Vanec_Robe_Local_Repair_rear_hem_slit',
      'Vanec_Robe_Local_Repair_side_pinhole',
      'Vanec_Robe_Local_Repair_rear_lower_slit',
    ],
    faceBudget: 350000,
    tierName: (t) => `vanec-tail-root-${t}-shared`,
    standalonePrefix: 'vanec-tail-root-hunyuan-body',
    optReceiptRel: 'assets/miniatures/character-compression/vanec-tail-root-20261022.json',
    redBalancedRel: 'assets/miniatures/character-reduction/vanec-tail-root-balanced-20261022.json',
    redLowRel: 'assets/miniatures/character-reduction/vanec-tail-root-low-20261022.json',
    bfReceiptRel: 'assets/miniatures/battlefield-lod/vanec-tail-root-20261022.json',
    sharedReceiptRel: (t) => `assets/miniatures/shared-textures/vanec-tail-root-${t}-20261022.json`,
    sourceVersion: 'vanec-v4/tail-root-hunyuan-body-pbr-20261126',
    sharpenWeapons: false,
  },
};

const readJson = (rel) => JSON.parse(readFileSync(path.join(root, rel), 'utf8'));
const writeJson = async (rel, data) => {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const text = JSON.stringify(data, null, 2) + '\n';
  await fs.writeFile(abs, text, 'utf8');
  return sha256(Buffer.from(text, 'utf8'));
};

function parseArgs(argv) {
  const opts = {
    characters: ['varis', 'vanec'],
    varisRefs: 'rendered',
    refsOnly: false,
    trialOnly: false,
    repackFrom: new Map(),
    installFrom: new Map(),
    trialRoot: DEFAULT_TRIAL_ROOT,
    workerUrl: DEFAULT_WORKER_URL,
  };
  const parsePairMap = (raw, targetMap, flagName) => {
    for (const pair of raw.split(',').filter(Boolean)) {
      const eq = pair.indexOf('=');
      assert(eq > 0, `Invalid ${flagName} entry: ${pair}`);
      targetMap.set(pair.slice(0, eq), path.resolve(pair.slice(eq + 1)));
    }
  };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--characters=')) {
      opts.characters = arg.slice('--characters='.length).split(',').filter(Boolean);
    } else if (arg.startsWith('--varis-refs=')) {
      opts.varisRefs = arg.slice('--varis-refs='.length);
    } else if (arg === '--refs-only') {
      opts.refsOnly = true;
    } else if (arg === '--trial-only') {
      opts.trialOnly = true;
    } else if (arg.startsWith('--assemble-from=')) {
      if (!opts.assembleFrom) opts.assembleFrom = new Map();
      parsePairMap(arg.slice('--assemble-from='.length), opts.assembleFrom, '--assemble-from');
    } else if (arg.startsWith('--repack-from=')) {
      parsePairMap(arg.slice('--repack-from='.length), opts.repackFrom, '--repack-from');
    } else if (arg.startsWith('--install-from=')) {
      parsePairMap(arg.slice('--install-from='.length), opts.installFrom, '--install-from');
    } else if (arg.startsWith('--trial-root=')) {
      opts.trialRoot = path.resolve(arg.slice('--trial-root='.length));
    } else if (arg.startsWith('--worker-url=')) {
      opts.workerUrl = arg.slice('--worker-url='.length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  assert(opts.varisRefs === 'rendered' || opts.varisRefs === 'concept', `Invalid --varis-refs=${opts.varisRefs}`);
  return opts;
}

function accessorMeta(accessor) {
  if (!accessor) return null;
  const arr = accessor.getArray();
  return {
    type: accessor.getType(),
    componentType: accessor.getComponentType(),
    normalized: accessor.getNormalized(),
    count: accessor.getCount(),
    sha256: crypto.createHash('sha256').update(Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength)).digest('hex'),
  };
}

function animationFingerprint(doc) {
  return doc.getRoot().listAnimations().map((anim) => ({
    name: anim.getName(),
    channels: anim.listChannels().map((ch) => {
      const s = ch.getSampler();
      return {
        node: ch.getTargetNode()?.getName() ?? null,
        path: ch.getTargetPath(),
        interpolation: s.getInterpolation(),
        input: accessorMeta(s.getInput()),
        output: accessorMeta(s.getOutput()),
      };
    }),
  }));
}

async function compressHighWithOptionalAnimations(doc, io) {
  if (doc.getRoot().listAnimations().length === 0) {
    return optimizeDelivery(doc, io);
  }
  const sourceBytes = Buffer.from(await io.writeBinary(doc));
  const beforeJSON = (await io.writeJSON(doc)).json;
  const geomBefore = geometryFingerprint(doc);
  const animBefore = animationFingerprint(doc);

  const textures = [];
  for (const [index, tex] of doc.getRoot().listTextures().entries()) {
    const original = Buffer.from(tex.getImage());
    const mime = tex.getMimeType();
    const meta = await sharp(original).metadata();
    const rgba = await texturePixels(original);
    let selected = original;
    let selectedMime = mime;
    let method = 'preserved';

    if (mime === 'image/png' && !meta.icc && meta.depth === 'uchar') {
      for (const candidate of [
        {
          method: 'lossless PNG',
          mime: 'image/png',
          bytes: await sharp(original).png({ compressionLevel: 9, adaptiveFiltering: true, effort: 10 }).toBuffer(),
        },
        {
          method: 'lossless WebP',
          mime: 'image/webp',
          bytes: await sharp(original).webp({ lossless: true, effort: 6 }).toBuffer(),
        },
      ]) {
        if (candidate.bytes.length >= selected.length) continue;
        if (JSON.stringify(await texturePixels(candidate.bytes)) !== JSON.stringify(rgba)) continue;
        selected = candidate.bytes;
        selectedMime = candidate.mime;
        method = candidate.method;
      }
    }
    tex.setImage(selected).setMimeType(selectedMime);
    textures.push({
      index,
      sourceBytes: original.length,
      sourceSha256: sha256(original),
      sourceMime: mime,
      bytes: selected.length,
      sha256: sha256(selected),
      mime: selectedMime,
      method,
      decodedRgba: rgba,
    });
  }

  if (textures.some((t) => t.mime === 'image/webp')) {
    doc.createExtension(EXTTextureWebP).setRequired(true);
  }
  doc.createExtension(EXTMeshoptCompression)
    .setRequired(true)
    .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });

  await doc.transform(
    weld({ overwrite: true }),
    reorder({ encoder: MeshoptEncoder, target: 'size' }),
    prune({ propertyTypes: [PropertyType.ACCESSOR], keepAttributes: true, keepIndices: true }),
  );

  const compressed = Buffer.from(await io.writeBinary(doc));
  const check = await io.readBinary(compressed);
  assert.deepEqual(geometryFingerprint(check), geomBefore, 'Triangle-corner attributes changed during delivery compression');
  assert.deepEqual(animationFingerprint(check), animBefore, 'Animation channels changed during delivery compression');
  const afterJSON = (await io.writeJSON(check)).json;
  for (const field of ['materials', 'nodes', 'scenes', 'scene', 'skins', 'cameras']) {
    assert.deepEqual(afterJSON[field], beforeJSON[field], `${field} changed during delivery compression`);
  }
  assert.equal(check.getRoot().listTextures().length, textures.length);
  for (const [i, tex] of check.getRoot().listTextures().entries()) {
    assert.equal(sha256(tex.getImage()), textures[i].sha256);
    assert.deepEqual(await texturePixels(tex.getImage()), textures[i].decodedRgba);
  }
  const gltf = JSON.parse(compressed.toString('utf8', 20, 20 + compressed.readUInt32LE(12)));
  for (const view of gltf.bufferViews ?? []) {
    const ext = view.extensions?.EXT_meshopt_compression;
    assert(!ext?.filter || ext.filter === 'NONE', 'Lossy attribute filter detected');
  }

  return {
    bytes: compressed,
    receipt: {
      policy: 'lossless-delivery-v1',
      applied: true,
      sourceBytes: sourceBytes.length,
      bytes: compressed.length,
      bytesSaved: sourceBytes.length - compressed.length,
      savingPercent: 100 * (1 - compressed.length / sourceBytes.length),
      sha256: sha256(compressed),
      textures,
      geometry: geometryFingerprint(check),
      verified: {
        triangleCornerAttributesExact: true,
        decodedTexturePixelsExact: true,
        sceneAndMaterialsExact: true,
        animationDataExact: true,
        noQuantization: true,
        noSimplification: true,
        noTextureResizing: true,
      },
    },
  };
}

const VANEC_TAIL_MASK_PATH = 'C:/Users/vcons/DnD-App-v2/assets/miniatures/runtime-provenance/vanec-tail-skin-20261022/root-coverage-02/tail-paint-mask.png';

function clampOrWrapTexCoord(c, size) {
  const u = (c >= -1e-4 && c <= 1 + 1e-4) ? Math.min(1, Math.max(0, c)) : ((c % 1) + 1) % 1;
  return u * (size - 1);
}

function sampleRawRgba(data, width, height, u, v) {
  const px = Math.max(0, Math.min(width - 1, Math.round(clampOrWrapTexCoord(u, width))));
  const py = Math.max(0, Math.min(height - 1, Math.round(clampOrWrapTexCoord(v, height))));
  const o = (py * width + px) * 4;
  return [data[o], data[o + 1], data[o + 2], data[o + 3]];
}

/**
 * Rasterize only preserved UV triangles onto a binary mask, dilate 12px via BFS
 * gutter propagation from exact mask texels, and encode a compact WebP copy.
 */
async function buildMaskedPreservedTexture(origRgba, width, height, uvTris, outWebpPath) {
  const nPixels = width * height;
  const mask = new Uint8Array(nPixels);
  const eps = -1e-4;

  for (let i = 0; i < uvTris.length; i += 6) {
    const x0 = clampOrWrapTexCoord(uvTris[i], width);
    const y0 = clampOrWrapTexCoord(uvTris[i + 1], height);
    const x1 = clampOrWrapTexCoord(uvTris[i + 2], width);
    const y1 = clampOrWrapTexCoord(uvTris[i + 3], height);
    const x2 = clampOrWrapTexCoord(uvTris[i + 4], width);
    const y2 = clampOrWrapTexCoord(uvTris[i + 5], height);

    const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)) - 1);
    const maxX = Math.min(width - 1, Math.ceil(Math.max(x0, x1, x2)) + 1);
    const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)) - 1);
    const maxY = Math.min(height - 1, Math.ceil(Math.max(y0, y1, y2)) + 1);

    const area = (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0);
    if (Math.abs(area) < 1e-6) {
      for (const [vx, vy] of [[x0, y0], [x1, y1], [x2, y2]]) {
        mask[Math.round(vy) * width + Math.round(vx)] = 1;
      }
      continue;
    }
    const sign = area > 0 ? 1 : -1;
    const invAbsArea = 1 / Math.abs(area);
    for (let y = minY; y <= maxY; y++) {
      const py = y + 0.5;
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5;
        const w0 = sign * ((x1 - x0) * (py - y0) - (y1 - y0) * (px - x0)) * invAbsArea;
        const w1 = sign * ((x2 - x1) * (py - y1) - (y2 - y1) * (px - x1)) * invAbsArea;
        const w2 = sign * ((x0 - x2) * (py - y2) - (y0 - y2) * (px - x2)) * invAbsArea;
        if (w0 >= eps && w1 >= eps && w2 >= eps) {
          mask[y * width + x] = 1;
        }
      }
    }
  }

  // BFS 12px gutter expansion carrying nearest original mask texel color for mipmap seams
  const srcIdx = new Int32Array(nPixels).fill(-1);
  const dist = new Uint8Array(nPixels).fill(255);
  const queue = new Int32Array(nPixels);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < nPixels; i++) {
    if (mask[i]) {
      srcIdx[i] = i;
      dist[i] = 0;
      queue[tail++] = i;
    }
  }
  while (head < tail) {
    const p = queue[head++];
    const d = dist[p];
    if (d >= 12) continue;
    const x = p % width;
    const y = (p - x) / width;
    const src = srcIdx[p];
    for (let dy = -1; dy <= 1; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= height) continue;
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        if (nx < 0 || nx >= width) continue;
        const np = ny * width + nx;
        if (dist[np] > d + 1) {
          dist[np] = d + 1;
          srcIdx[np] = src;
          queue[tail++] = np;
        }
      }
    }
  }

  const outRgb = Buffer.alloc(nPixels * 3);
  for (let i = 0; i < nPixels; i++) {
    const o = i * 3;
    const s = srcIdx[i];
    if (s >= 0) {
      const so = s * 4;
      outRgb[o] = origRgba[so];
      outRgb[o + 1] = origRgba[so + 1];
      outRgb[o + 2] = origRgba[so + 2];
    } else {
      outRgb[o] = 0x26;
      outRgb[o + 1] = 0x24;
      outRgb[o + 2] = 0x22;
    }
  }
  const webpBuf = await sharp(outRgb, { raw: { width, height, channels: 3 } })
    .webp({ quality: 96, effort: 6, smartSubsample: false })
    .toBuffer();
  await fs.writeFile(outWebpPath, webpBuf);
  return webpBuf.length;
}

/**
 * Extract isolated world-space painted body triangles into `body-only.glb`,
 * separate preserved base (and Vanec tail) triangles into `work/preserved-*`,
 * and dump exact Float32/Uint32 buffers for cKDTree restoration.
 */
async function extractTargetBody(doc, cfg, charId, io, workDir) {
  await fs.mkdir(workDir, { recursive: true });
  const rootNodes = doc.getRoot().listNodes();
  const posList = [];
  const normList = [];
  const idxList = [];
  const parts = [];
  const roles = [];
  const paintedPrimSplits = new Map();
  let vOffset = 0;

  let vanecTailMask = null;
  if (charId === 'vanec') {
    assert(existsSync(VANEC_TAIL_MASK_PATH), `Missing Vanec tail mask: ${VANEC_TAIL_MASK_PATH}`);
    vanecTailMask = await sharp(VANEC_TAIL_MASK_PATH).grayscale().raw().toBuffer({ resolveWithObject: true });
  }

  const m4 = new Matrix4();
  const nMat = new Matrix3();
  const v3 = new Vector3();

  for (const [nodeIdx, nodeName] of cfg.targetNodes.entries()) {
    const node = rootNodes.find((n) => n.getName() === nodeName);
    assert(node, `Missing target node: ${nodeName}`);
    const mesh = node.getMesh();
    assert(mesh, `Node has no mesh: ${nodeName}`);
    const worldArr = node.getWorldMatrix();
    const localArr = node.getMatrix();
    m4.fromArray(worldArr);
    nMat.getNormalMatrix(m4);
    const detNeg = m4.determinant() < 0;

    const isPrimary = nodeIdx === 0;
    const start = vOffset;
    let paintedTrisCount = 0;

    if (!isPrimary) {
      for (const prim of mesh.listPrimitives()) {
        const pos = prim.getAttribute('POSITION');
        const nrm = prim.getAttribute('NORMAL');
        const idx = prim.getIndices();
        assert(pos && nrm && idx, `Node ${nodeName} missing POSITION/NORMAL/indices`);
        const nv = pos.getCount();
        const pArr = new Float32Array(nv * 3);
        const nArr = new Float32Array(nv * 3);
        for (let i = 0; i < nv; i++) {
          v3.set(pos.getArray()[i * 3], pos.getArray()[i * 3 + 1], pos.getArray()[i * 3 + 2]).applyMatrix4(m4);
          pArr[i * 3] = v3.x; pArr[i * 3 + 1] = v3.y; pArr[i * 3 + 2] = v3.z;
          v3.set(nrm.getArray()[i * 3], nrm.getArray()[i * 3 + 1], nrm.getArray()[i * 3 + 2]).applyMatrix3(nMat).normalize();
          nArr[i * 3] = v3.x; nArr[i * 3 + 1] = v3.y; nArr[i * 3 + 2] = v3.z;
        }
        const srcIdx = idx.getArray();
        const outIdx = new Uint32Array(srcIdx.length);
        for (let t = 0; t < srcIdx.length; t += 3) {
          outIdx[t] = vOffset + srcIdx[t];
          outIdx[t + 1] = vOffset + srcIdx[detNeg ? t + 2 : t + 1];
          outIdx[t + 2] = vOffset + srcIdx[detNeg ? t + 1 : t + 2];
        }
        posList.push(pArr);
        normList.push(nArr);
        idxList.push(outIdx);
        vOffset += nv;
        paintedTrisCount += srcIdx.length / 3;
      }
      parts.push({ name: nodeName, matrix: Array.from(localArr), worldMatrix: Array.from(worldArr), triangles: paintedTrisCount });
      roles.push({ name: nodeName, start, end: vOffset, triangles: paintedTrisCount });
      continue;
    }

    const prims = mesh.listPrimitives();
    assert.equal(prims.length, 1, `Expected 1 primitive on primary body node ${nodeName}, got ${prims.length}`);
    const prim = prims[0];
    const pos = prim.getAttribute('POSITION');
    const nrm = prim.getAttribute('NORMAL');
    const uvAttr = prim.getAttribute('TEXCOORD_0');
    const idx = prim.getIndices();
    assert(pos && nrm && uvAttr && idx, `Node ${nodeName} missing POSITION/NORMAL/TEXCOORD_0/indices`);
    const origMat = prim.getMaterial();
    const origTex = origMat?.getBaseColorTexture();
    assert(origTex, `Node ${nodeName} missing original baseColorTexture`);
    const { data: origRgba, info: origInfo } = await sharp(Buffer.from(origTex.getImage()))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const nv = pos.getCount();
    const localPos = pos.getArray();
    const localNrm = nrm.getArray();
    const localUv = uvAttr.getArray();
    const srcIdx = idx.getArray();
    const worldPos = new Float32Array(nv * 3);
    const worldNrm = new Float32Array(nv * 3);
    for (let i = 0; i < nv; i++) {
      v3.set(localPos[i * 3], localPos[i * 3 + 1], localPos[i * 3 + 2]).applyMatrix4(m4);
      worldPos[i * 3] = v3.x; worldPos[i * 3 + 1] = v3.y; worldPos[i * 3 + 2] = v3.z;
      v3.set(localNrm[i * 3], localNrm[i * 3 + 1], localNrm[i * 3 + 2]).applyMatrix3(nMat).normalize();
      worldNrm[i * 3] = v3.x; worldNrm[i * 3 + 1] = v3.y; worldNrm[i * 3 + 2] = v3.z;
    }

    let varisBoots = null;
    if (charId === 'varis') {
      // Measure ankle footprints above the central mossy mound (y in [-0.64, -0.56]) and in front of trailing cape (z > -0.15)
      const rb = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
      const lb = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
      for (let i = 0; i < nv; i++) {
        const x = worldPos[i * 3];
        const y = worldPos[i * 3 + 1];
        const z = worldPos[i * 3 + 2];
        if (y >= -0.64 && y <= -0.56 && z > -0.15) {
          const b = x < 0.08 ? rb : lb;
          if (x < b.minX) b.minX = x;
          if (x > b.maxX) b.maxX = x;
          if (z < b.minZ) b.minZ = z;
          if (z > b.maxZ) b.maxZ = z;
        }
      }
      rb.minX -= 0.07; rb.maxX += 0.05; rb.minZ -= 0.05; rb.maxZ += 0.16;
      lb.minX -= 0.06; lb.maxX += 0.07; lb.minZ -= 0.05; lb.maxZ += 0.18;
      varisBoots = [rb, lb];
    }

    const paintOrigTris = [];
    const presOrigTris = [];
    for (let t = 0; t < srcIdx.length; t += 3) {
      const a = srcIdx[t];
      const b = srcIdx[t + 1];
      const c = srcIdx[t + 2];
      const ay = worldPos[a * 3 + 1];
      const by = worldPos[b * 3 + 1];
      const cy = worldPos[c * 3 + 1];
      const maxY = Math.max(ay, by, cy);
      let preserve = false;

      if (charId === 'vanec') {
        if (maxY < -0.835) {
          preserve = true;
        } else {
          let tailHits = 0;
          const tw = vanecTailMask.info.width;
          const th = vanecTailMask.info.height;
          for (const vi of [a, b, c]) {
            const px = Math.max(0, Math.min(tw - 1, Math.round(clampOrWrapTexCoord(localUv[vi * 2], tw))));
            const py = Math.max(0, Math.min(th - 1, Math.round(clampOrWrapTexCoord(localUv[vi * 2 + 1], th))));
            if (vanecTailMask.data[py * tw + px] > 128) tailHits++;
          }
          if (tailHits >= 2) preserve = true;
        }
      } else {
        const cx = (worldPos[a * 3] + worldPos[b * 3] + worldPos[c * 3]) / 3;
        const centY = (ay + by + cy) / 3;
        const cz = (worldPos[a * 3 + 2] + worldPos[b * 3 + 2] + worldPos[c * 3 + 2]) / 3;
        const inBootPad = varisBoots.some(
          (box) => cx >= box.minX && cx <= box.maxX && cz >= box.minZ && cz <= box.maxZ,
        );
        if (maxY < -0.805) {
          preserve = true;
        } else if ((maxY < -0.695 || (centY < -0.675 && cz > -0.24)) && !inBootPad) {
          preserve = true;
        } else if (maxY < -0.775) {
          const cu = (localUv[a * 2] + localUv[b * 2] + localUv[c * 2]) / 3;
          const cv = (localUv[a * 2 + 1] + localUv[b * 2 + 1] + localUv[c * 2 + 1]) / 3;
          const [r, g, bl] = sampleRawRgba(origRgba, origInfo.width, origInfo.height, cu, cv);
          const isWarmBrownLeather = r > g * 1.15 && r > bl * 1.25 && r < 150;
          if (!isWarmBrownLeather) {
            preserve = true;
          }
        }
      }

      if (preserve) {
        presOrigTris.push(a, b, c);
      } else {
        paintOrigTris.push(a, b, c);
      }
    }

    // Compact painted vertices/indices in world order (and keep remap for bodyDoc copyNode)
    const paintVertMap = new Int32Array(nv).fill(-1);
    const paintOrigVerts = [];
    const paintCopyLocalIdx = new Uint32Array(paintOrigTris.length);
    const paintWorldIdx = new Uint32Array(paintOrigTris.length);
    for (let k = 0; k < paintOrigTris.length; k++) {
      const ov = paintOrigTris[k];
      let cv = paintVertMap[ov];
      if (cv < 0) {
        cv = paintOrigVerts.length;
        paintVertMap[ov] = cv;
        paintOrigVerts.push(ov);
      }
      paintCopyLocalIdx[k] = ov;
      paintWorldIdx[k] = vOffset + cv;
    }
    if (detNeg) {
      for (let t = 0; t < paintWorldIdx.length; t += 3) {
        const tmp = paintWorldIdx[t + 1];
        paintWorldIdx[t + 1] = paintWorldIdx[t + 2];
        paintWorldIdx[t + 2] = tmp;
      }
    }
    const nPaintV = paintOrigVerts.length;
    const pArr = new Float32Array(nPaintV * 3);
    const nArr = new Float32Array(nPaintV * 3);
    for (let i = 0; i < nPaintV; i++) {
      const ov = paintOrigVerts[i];
      pArr[i * 3] = worldPos[ov * 3]; pArr[i * 3 + 1] = worldPos[ov * 3 + 1]; pArr[i * 3 + 2] = worldPos[ov * 3 + 2];
      nArr[i * 3] = worldNrm[ov * 3]; nArr[i * 3 + 1] = worldNrm[ov * 3 + 1]; nArr[i * 3 + 2] = worldNrm[ov * 3 + 2];
    }
    posList.push(pArr);
    normList.push(nArr);
    idxList.push(paintWorldIdx);
    vOffset += nPaintV;
    paintedTrisCount = paintOrigTris.length / 3;
    paintedPrimSplits.set(node, paintCopyLocalIdx);

    // Compact preserved base/tail vertices & triangles in exact original LOCAL frame + UVs
    const presVertMap = new Int32Array(nv).fill(-1);
    const presOrigVerts = [];
    const presLocalIdx = new Uint32Array(presOrigTris.length);
    const presUvTris = new Float32Array(presOrigTris.length * 2);
    for (let k = 0; k < presOrigTris.length; k++) {
      const ov = presOrigTris[k];
      let cv = presVertMap[ov];
      if (cv < 0) {
        cv = presOrigVerts.length;
        presVertMap[ov] = cv;
        presOrigVerts.push(ov);
      }
      presLocalIdx[k] = cv;
      presUvTris[k * 2] = localUv[ov * 2];
      presUvTris[k * 2 + 1] = localUv[ov * 2 + 1];
    }
    const nPresV = presOrigVerts.length;
    const presPos = new Float32Array(nPresV * 3);
    const presNrm = new Float32Array(nPresV * 3);
    const presUv = new Float32Array(nPresV * 2);
    for (let i = 0; i < nPresV; i++) {
      const ov = presOrigVerts[i];
      presPos[i * 3] = localPos[ov * 3]; presPos[i * 3 + 1] = localPos[ov * 3 + 1]; presPos[i * 3 + 2] = localPos[ov * 3 + 2];
      presNrm[i * 3] = localNrm[ov * 3]; presNrm[i * 3 + 1] = localNrm[ov * 3 + 1]; presNrm[i * 3 + 2] = localNrm[ov * 3 + 2];
      presUv[i * 2] = localUv[ov * 2]; presUv[i * 2 + 1] = localUv[ov * 2 + 1];
    }
    const presBaseBytes = await buildMaskedPreservedTexture(
      origRgba,
      origInfo.width,
      origInfo.height,
      presUvTris,
      path.join(workDir, 'preserved-base.webp'),
    );
    await fs.writeFile(path.join(workDir, 'preserved-pos.f32'), Buffer.from(presPos.buffer));
    await fs.writeFile(path.join(workDir, 'preserved-normal.f32'), Buffer.from(presNrm.buffer));
    await fs.writeFile(path.join(workDir, 'preserved-uv.f32'), Buffer.from(presUv.buffer));
    await fs.writeFile(path.join(workDir, 'preserved-index.u32'), Buffer.from(presLocalIdx.buffer));
    await fs.writeFile(
      path.join(workDir, 'preserved-parts.json'),
      JSON.stringify(
        {
          targetNode: nodeName,
          matrix: Array.from(localArr),
          verts: nPresV,
          tris: presOrigTris.length / 3,
          roughnessFactor: origMat.getRoughnessFactor() ?? 0.9036020036098448,
          doubleSided: origMat.getDoubleSided(),
          preservedBaseWebpBytes: presBaseBytes,
        },
        null,
        2,
      ),
    );
    console.log(
      `  Split ${nodeName}: ${paintedTrisCount.toLocaleString()} painted tris, ` +
      `${(presOrigTris.length / 3).toLocaleString()} preserved tris (preserved-base.webp=${(presBaseBytes / 1e6).toFixed(2)} MB)`,
    );

    parts.push({ name: nodeName, matrix: Array.from(localArr), worldMatrix: Array.from(worldArr), triangles: paintedTrisCount });
    roles.push({ name: nodeName, start, end: vOffset, triangles: paintedTrisCount });
  }

  // Copy isolated target nodes into bodyDoc in world space with preserved triangles removed
  const bodyDoc = new Document();
  const bodyScene = bodyDoc.createScene();
  const bodySrcNodes = cfg.targetNodes.map((n) => rootNodes.find((rn) => rn.getName() === n));
  const nodeMap = copyToDocument(bodyDoc, doc, bodySrcNodes);
  for (const srcNode of bodySrcNodes) {
    const copyNode = nodeMap.get(srcNode);
    const srcWorld = new Matrix4().fromArray(srcNode.getWorldMatrix());
    const nrmMat = new Matrix3().getNormalMatrix(srcWorld);
    const detNeg = srcWorld.determinant() < 0;
    const pVec = new Vector3();

    copyNode.setMatrix([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const splitIdx = paintedPrimSplits.get(srcNode);
    for (const prim of copyNode.getMesh().listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      const nrm = prim.getAttribute('NORMAL');
      const pArr = pos.getArray().slice();
      const nArr = nrm.getArray().slice();
      for (let i = 0; i < pos.getCount(); i++) {
        pVec.set(pArr[i * 3], pArr[i * 3 + 1], pArr[i * 3 + 2]).applyMatrix4(srcWorld);
        pArr[i * 3] = pVec.x; pArr[i * 3 + 1] = pVec.y; pArr[i * 3 + 2] = pVec.z;
        pVec.set(nArr[i * 3], nArr[i * 3 + 1], nArr[i * 3 + 2]).applyMatrix3(nrmMat).normalize();
        nArr[i * 3] = pVec.x; nArr[i * 3 + 1] = pVec.y; nArr[i * 3 + 2] = pVec.z;
      }
      pos.setArray(pArr);
      nrm.setArray(nArr);
      if (splitIdx) {
        const idx = prim.getIndices();
        const iArr = splitIdx.slice();
        if (detNeg) {
          for (let t = 0; t < iArr.length; t += 3) {
            const tmp = iArr[t + 1]; iArr[t + 1] = iArr[t + 2]; iArr[t + 2] = tmp;
          }
        }
        idx.setArray(iArr);
      } else if (detNeg) {
        const idx = prim.getIndices();
        const iArr = idx.getArray().slice();
        for (let t = 0; t < iArr.length; t += 3) {
          const tmp = iArr[t + 1]; iArr[t + 1] = iArr[t + 2]; iArr[t + 2] = tmp;
        }
        idx.setArray(iArr);
      }
    }
    bodyScene.addChild(copyNode);
  }

  for (const ext of bodyDoc.getRoot().listExtensionsUsed()) {
    if (ext.extensionName === 'EXT_meshopt_compression') ext.dispose();
  }
  await bodyDoc.transform(prune(), unpartition());
  const bodyOnlyPath = path.join(workDir, 'body-only.glb');
  await fs.writeFile(bodyOnlyPath, await io.writeBinary(bodyDoc));

  const concatF32 = (arrays) => {
    const out = new Float32Array(arrays.reduce((s, a) => s + a.length, 0));
    let o = 0;
    for (const a of arrays) { out.set(a, o); o += a.length; }
    return out;
  };
  const concatU32 = (arrays) => {
    const out = new Uint32Array(arrays.reduce((s, a) => s + a.length, 0));
    let o = 0;
    for (const a of arrays) { out.set(a, o); o += a.length; }
    return out;
  };

  const sourcePos = concatF32(posList);
  const sourceNorm = concatF32(normList);
  const sourceIdx = concatU32(idxList);
  await fs.writeFile(path.join(workDir, 'source-pos.f32'), Buffer.from(sourcePos.buffer));
  await fs.writeFile(path.join(workDir, 'source-normal.f32'), Buffer.from(sourceNorm.buffer));
  await fs.writeFile(path.join(workDir, 'source-index.u32'), Buffer.from(sourceIdx.buffer));
  await fs.writeFile(path.join(workDir, 'source-parts.json'), JSON.stringify({ selected: parts }, null, 2));
  await fs.writeFile(path.join(workDir, 'source-roles.json'), JSON.stringify(roles, null, 2));

  const totalTris = sourceIdx.length / 3;
  console.log(`  Extracted isolated body-only.glb (${vOffset} verts, ${totalTris} tris across ${parts.length} node(s))`);
  return { bodyOnlyPath, totalTris, parts, roles };
}

/**
 * Render 4 orthographic 1024x1024 RGBA reference views with runtime-matched
 * metalness=0 handling and shadow-free studio lighting.
 */
async function renderOrthoReferences(bodyOnlyPath, refsDir, options = {}) {
  const { sharpenRefs = false, cameraLock = null } = options;
  await fs.mkdir(refsDir, { recursive: true });
  const bodyBytes = await fs.readFile(bodyOnlyPath);

  const refHtml = `<!doctype html>
<html>
<head><meta charset="utf-8"><style>body{margin:0;background:transparent;overflow:hidden}</style></head>
<body>
<script type="importmap">
{
  "imports": {
    "three": "/three/build/three.module.js",
    "three/addons/": "/three/examples/jsm/"
  }
}
</script>
<script type="module">
import * as T from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

await MeshoptDecoder.ready;

const renderer = new T.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
renderer.setSize(1024, 1024);
renderer.setPixelRatio(1);
renderer.outputColorSpace = T.SRGBColorSpace;
renderer.toneMapping = T.ACESFilmicToneMapping;
renderer.setClearColor(0, 0);
document.body.appendChild(renderer.domElement);

const scene = new T.Scene();
const pmrem = new T.PMREMGenerator(renderer);
const env = pmrem.fromScene(new RoomEnvironment(), 0.04);
scene.environment = env.texture;
scene.environmentIntensity = 0.25;
scene.add(new T.HemisphereLight(0xffffff, 0xe8e2dc, 1.85));
const key = new T.DirectionalLight(0xffffff, 1.1);
key.position.set(-3, 4, 5);
scene.add(key);
const fillFront = new T.DirectionalLight(0xffffff, 0.7);
fillFront.position.set(3, 2, 4);
scene.add(fillFront);
const backLight = new T.DirectionalLight(0xffffff, 1.0);
backLight.position.set(2, 3, -5);
scene.add(backLight);

const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);
const bodyGltf = await loader.loadAsync('/body-only.glb');
const body = bodyGltf.scene;
body.traverse((obj) => {
  if (!obj.isMesh) return;
  const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
  mats.forEach((m) => {
    if (!m) return;
    const srcIdx = bodyGltf.parser?.associations?.get(m)?.materials;
    const pbr = srcIdx === undefined ? undefined : bodyGltf.parser?.json?.materials?.[srcIdx]?.pbrMetallicRoughness;
    if (m.isMeshStandardMaterial && pbr && pbr.metallicFactor === undefined && !pbr.metallicRoughnessTexture) {
      m.metalness = 0;
      m.roughness = Math.max(m.roughness, 0.90);
    }
  });
});
scene.add(body);

const box = new T.Box3().setFromObject(body);
const lock = ${JSON.stringify(cameraLock)};
const center = lock ? new T.Vector3(...lock.center) : box.getCenter(new T.Vector3());
const size = box.getSize(new T.Vector3());
const scale = lock ? lock.scale : Math.max(size.y, size.x, size.z) * 1.18;
const camera = new T.OrthographicCamera(-scale / 2, scale / 2, scale / 2, -scale / 2, 0.01, 100);

window.renderBody = (view) => {
  const dir = { front: [0, 0, 1], back: [0, 0, -1], left: [-1, 0, 0], right: [1, 0, 0] }[view];
  camera.position.copy(center).add(new T.Vector3(...dir).multiplyScalar(Math.max(5, scale * 2)));
  camera.lookAt(center);
  renderer.render(scene, camera);
  return { view, center: center.toArray(), scale, bounds: { min: box.min.toArray(), max: box.max.toArray() } };
};
window.renderBody('front');
window.ready = true;
</script>
</body>
</html>`;

  const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.wasm': 'application/wasm',
    '.glb': 'model/gltf-binary',
  };

  const server = http.createServer((req, res) => {
    const reqPath = decodeURIComponent((req.url || '/').split('?')[0]);
    if (reqPath === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(refHtml);
      return;
    }
    if (reqPath === '/body-only.glb') {
      res.writeHead(200, { 'Content-Type': 'model/gltf-binary' });
      res.end(bodyBytes);
      return;
    }
    if (reqPath.startsWith('/three/')) {
      const target = path.join(threeDir, reqPath.slice('/three/'.length));
      if (!existsSync(target)) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': mimeTypes[path.extname(target)] || 'application/octet-stream' });
      res.end(readFileSync(target));
      return;
    }
    res.writeHead(404);
    res.end('Not found');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const views = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
    page.on('pageerror', (err) => console.error('[refscene pageerror]', err));
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForFunction(() => window.ready);
    for (const view of ['front', 'back', 'left', 'right']) {
      views.push(await page.evaluate((v) => window.renderBody(v), view));
      const outPath = path.join(refsDir, `${view}.png`);
      const pngBuf = await page.screenshot({ omitBackground: true });
      if (sharpenRefs) {
        const { data: rgba, info } = await sharp(pngBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        const nPx = info.width * info.height;
        const rgb = Buffer.alloc(nPx * 3);
        const alpha = Buffer.alloc(nPx);
        for (let i = 0; i < nPx; i++) {
          rgb[i * 3] = rgba[i * 4];
          rgb[i * 3 + 1] = rgba[i * 4 + 1];
          rgb[i * 3 + 2] = rgba[i * 4 + 2];
          alpha[i] = rgba[i * 4 + 3];
        }
        const sharpRgb = await sharp(rgb, { raw: { width: info.width, height: info.height, channels: 3 } })
          .sharpen({ sigma: 1.1, m1: 0.9, m2: 1.8 })
          .raw()
          .toBuffer();
        const combined = Buffer.alloc(rgba.length);
        for (let i = 0; i < nPx; i++) {
          combined[i * 4] = sharpRgb[i * 3];
          combined[i * 4 + 1] = sharpRgb[i * 3 + 1];
          combined[i * 4 + 2] = sharpRgb[i * 3 + 2];
          combined[i * 4 + 3] = alpha[i];
        }
        await sharp(combined, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toFile(outPath);
      } else {
        await fs.writeFile(outPath, pngBuf);
      }
    }
  } finally {
    await browser.close();
    server.close();
  }
  await fs.writeFile(path.join(refsDir, 'references.json'), JSON.stringify(views, null, 2));
  return {
    paths: ['front', 'back', 'left', 'right'].map((v) => path.join(refsDir, `${v}.png`)),
    cameraLock: { center: views[0].center, scale: views[0].scale },
  };
}

function dilateBinaryMask(mask, width, height, radius) {
  const nPixels = width * height;
  const dist = new Uint8Array(nPixels).fill(255);
  const queue = new Int32Array(nPixels);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < nPixels; i++) {
    if (mask[i]) {
      dist[i] = 0;
      queue[tail++] = i;
    }
  }
  while (head < tail) {
    const p = queue[head++];
    const d = dist[p];
    if (d >= radius) continue;
    const x = p % width;
    const y = (p - x) / width;
    for (let dy = -1; dy <= 1; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= height) continue;
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        if (nx < 0 || nx >= width) continue;
        const np = ny * width + nx;
        if (dist[np] > d + 1) {
          dist[np] = d + 1;
          queue[tail++] = np;
        }
      }
    }
  }
  const out = new Uint8Array(nPixels);
  for (let i = 0; i < nPixels; i++) {
    if (dist[i] <= radius) out[i] = 1;
  }
  return out;
}

function fillInteriorHoles(mask, width, height) {
  const nPixels = width * height;
  const exterior = new Uint8Array(nPixels);
  const queue = new Int32Array(nPixels);
  let head = 0;
  let tail = 0;
  const push = (idx) => {
    if (!mask[idx] && !exterior[idx]) {
      exterior[idx] = 1;
      queue[tail++] = idx;
    }
  };
  for (let x = 0; x < width; x++) {
    push(x);
    push((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    push(y * width);
    push(y * width + (width - 1));
  }
  while (head < tail) {
    const p = queue[head++];
    const x = p % width;
    const y = (p - x) / width;
    if (x > 0) push(p - 1);
    if (x + 1 < width) push(p + 1);
    if (y > 0) push(p - width);
    if (y + 1 < height) push(p + width);
  }
  const filled = mask.slice();
  for (let i = 0; i < nPixels; i++) {
    if (!exterior[i]) filled[i] = 1;
  }
  return filled;
}

/**
 * Prepare standalone clean concept-art refs directly from `body-{front,back,left,right}.png`:
 * border flood-fill studio background removal, clean head/pedestal/blade cropping,
 * seamless green-cape texture cloning over the 2D quiver, and uniform 1.18 framing onto 1024x1024.
 */
async function prepareAlignedConceptRefs(conceptRefsMap, refsDir) {
  await fs.mkdir(refsDir, { recursive: true });

  const floodRemoveWhiteBg = (rgba, w, h) => {
    const nPx = w * h;
    const extBg = new Uint8Array(nPx);
    const queue = new Int32Array(nPx);
    let head = 0;
    let tail = 0;
    const isSeedBg = (i) => {
      const o = i * 4;
      return rgba[o + 3] < 32 || (rgba[o] > 242 && rgba[o + 1] > 242 && rgba[o + 2] > 242);
    };
    const push = (i) => {
      if (!extBg[i] && isSeedBg(i)) {
        extBg[i] = 1;
        queue[tail++] = i;
      }
    };
    for (let x = 0; x < w; x++) {
      push(x);
      push((h - 1) * w + x);
    }
    for (let y = 0; y < h; y++) {
      push(y * w);
      push(y * w + (w - 1));
    }
    while (head < tail) {
      const p = queue[head++];
      const x = p % w;
      const y = (p - x) / w;
      if (x > 0) push(p - 1);
      if (x + 1 < w) push(p + 1);
      if (y > 0) push(p - w);
      if (y + 1 < h) push(p + w);
    }
    // 1px anti-aliased bright fringe adjacent to exterior background
    const remove = extBg.slice();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (remove[i]) continue;
        const o = i * 4;
        if (rgba[o] > 235 && rgba[o + 1] > 235 && rgba[o + 2] > 235) {
          const adjExt =
            (x > 0 && extBg[i - 1]) ||
            (x + 1 < w && extBg[i + 1]) ||
            (y > 0 && extBg[i - w]) ||
            (y + 1 < h && extBg[i + w]);
          if (adjExt) remove[i] = 1;
        }
      }
    }
    for (let i = 0; i < nPx; i++) {
      if (remove[i]) {
        const o = i * 4;
        rgba[o] = 0; rgba[o + 1] = 0; rgba[o + 2] = 0; rgba[o + 3] = 0;
      }
    }
  };

  const zeroPx = (rgba, o) => {
    rgba[o] = 0; rgba[o + 1] = 0; rgba[o + 2] = 0; rgba[o + 3] = 0;
  };

  const headBandX = {
    front: [485, 655],
    back: [450, 670],
    left: [460, 650],
    right: [500, 700],
  };

  const croppedViews = new Map();
  for (const view of ['front', 'back', 'left', 'right']) {
    const srcAbs = path.join(root, conceptRefsMap[view]);
    const { data, info } = await sharp(srcAbs).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const w = info.width;
    const h = info.height;
    floodRemoveWhiteBg(data, w, h);

    const topCutY = view === 'left' || view === 'right' ? 215 : view === 'front' ? 212 : 192;
    const maxBottomY = view === 'front' || view === 'back' ? 1102 : 1106;
    const [hxMin, hxMax] = headBandX[view];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        if (data[o + 3] === 0) continue;
        const r = data[o], g = data[o + 1], b = data[o + 2];
        if (y > maxBottomY || y < topCutY) {
          zeroPx(data, o);
          continue;
        }
        // Clear center mound & mossy rocks between/outside boots without biting leather speculars
        if ((view === 'front' || view === 'back') && y > 1018 && x > 450 && x < 695) {
          zeroPx(data, o);
          continue;
        }
        if (y > 1078 && g > r * 0.94 && r - b < 35) {
          zeroPx(data, o);
          continue;
        }
        if ((view === 'left' || view === 'right') && y > 1055 && (x < 485 || x > 715)) {
          zeroPx(data, o);
          continue;
        }
        // Remove warm chin/beard/hair overhang near top of hood without eating dark hood wool
        if (y <= 242 && x >= hxMin && x <= hxMax && r > 95 && r > g * 1.12) {
          zeroPx(data, o);
          continue;
        }
        // Remove protruding warm brown arrows/quiver behind hood strictly outside hood wool
        if (view === 'front' && y < 268 && x > 685 && r > g * 1.12) {
          zeroPx(data, o);
          continue;
        }
        if (view === 'back' && y < 252 && x < 480 && r > g * 1.12) {
          zeroPx(data, o);
          continue;
        }
        if (view === 'left' && y < 440 && x < 490 && r > g * 1.10) {
          zeroPx(data, o);
          continue;
        }
        if (view === 'right' && y < 485 && x > 710 && r > g * 1.10) {
          zeroPx(data, o);
          continue;
        }
        // Crop ONLY extended sword/dagger blades outside hands while preserving gloves, armor & cloak hem
        if (view === 'front' && ((x < 320 && y < 580) || (x > 875 && y >= 540 && y <= 760))) {
          zeroPx(data, o);
          continue;
        }
        if (view === 'back' && ((x < 285 && y < 740) || (x > 820 && y < 620))) {
          zeroPx(data, o);
          continue;
        }
        if (view === 'left' && x > 735 && y < 720) {
          zeroPx(data, o);
          continue;
        }
        if (view === 'right' && x < 420 && y >= 380 && y <= 710) {
          zeroPx(data, o);
        }
      }
    }

    // Seamless green-cloak texture clone + soft spatial blend over 2D quiver on back.png
    if (view === 'back') {
      const qRaw = new Uint8Array(w * h);
      for (let y = 248; y <= 555; y++) {
        for (let x = 420; x <= 600; x++) {
          const idx = y * w + x;
          const o = idx * 4;
          const r = data[o], g = data[o + 1], b = data[o + 2], a = data[o + 3];
          if (a < 32) continue;
          const isWarmBrown = r > g * 1.10 && r > b * 1.24;
          const isDeepShadow = r < 58 && g < 58 && b < 58;
          if (isWarmBrown || isDeepShadow) qRaw[idx] = 1;
        }
      }
      const qMask = dilateBinaryMask(qRaw, w, h, 8);

      const featherDist = new Uint16Array(w * h).fill(65535);
      const fq = new Int32Array(w * h);
      let fHead = 0, fTail = 0;
      for (let i = 0; i < w * h; i++) {
        if (!qMask[i]) {
          featherDist[i] = 0;
          fq[fTail++] = i;
        }
      }
      while (fHead < fTail) {
        const p = fq[fHead++];
        const d = featherDist[p];
        if (d >= 12) continue;
        const px = p % w;
        const py = (p - px) / w;
        for (const [dxN, dyN] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const nx = px + dxN, ny = py + dyN;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          const np = ny * w + nx;
          if (featherDist[np] > d + 1) {
            featherDist[np] = d + 1;
            fq[fTail++] = np;
          }
        }
      }

      // Compute clean green pixels outside qMask and sample local average + mirrored green cloak fold
      const isCleanGreen = (idx) => {
        if (qMask[idx]) return false;
        const o = idx * 4;
        return data[o + 3] > 200 && data[o + 1] > 55 && data[o + 1] >= data[o] * 0.98;
      };
      const cleanGreenSrc = new Int32Array(w * h).fill(-1);
      const cleanGreenDist = new Uint16Array(w * h).fill(65535);
      const cq = new Int32Array(w * h);
      let cHead = 0, cTail = 0;
      for (let i = 0; i < w * h; i++) {
        if (isCleanGreen(i)) {
          cleanGreenDist[i] = 0;
          cleanGreenSrc[i] = i;
          cq[cTail++] = i;
        }
      }
      while (cHead < cTail) {
        const p = cq[cHead++];
        const d = cleanGreenDist[p];
        if (d >= 180) continue;
        const px = p % w;
        const py = (p - px) / w;
        for (const [dxN, dyN] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const nx = px + dxN, ny = py + dyN;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          const np = ny * w + nx;
          if (cleanGreenDist[np] > d + 1) {
            cleanGreenDist[np] = d + 1;
            cleanGreenSrc[np] = cleanGreenSrc[p];
            cq[cTail++] = np;
          }
        }
      }

      // Build smoothed green base over the clean green pixels so inpaint has zero block seams
      const cloned = Buffer.from(data);
      for (let y = 195; y <= 570; y++) {
        for (let x = 385; x <= 620; x++) {
          const idx = y * w + x;
          if (!qMask[idx]) continue;
          const o = idx * 4;
          if (data[o + 3] < 16) continue;
          // Sample 4 symmetric clean green sources: right offset, vertically below quiver, left neighbor, nearest green
          const cands = [
            y * w + Math.min(w - 1, x + 175),
            y * w + Math.min(w - 1, Math.max(0, 2 * 595 - x)),
            Math.min(h - 1, y + 120) * w + x,
            cleanGreenSrc[idx],
          ];
          let sr = 0, sg = 0, sb = 0, sw = 0;
          const weights = [0.45, 0.30, 0.15, 0.10];
          for (let k = 0; k < cands.length; k++) {
            const ci = cands[k];
            const picked = isCleanGreen(ci) ? ci : cleanGreenSrc[idx];
            if (picked < 0) continue;
            const po = picked * 4;
            sr += data[po] * weights[k];
            sg += data[po + 1] * weights[k];
            sb += data[po + 2] * weights[k];
            sw += weights[k];
          }
          if (sw <= 0) continue;
          const wBlend = Math.min(1, featherDist[idx] / 7);
          const invW = 1 - wBlend;
          cloned[o] = Math.round(data[o] * invW + (sr / sw) * wBlend);
          cloned[o + 1] = Math.round(data[o + 1] * invW + (sg / sw) * wBlend);
          cloned[o + 2] = Math.round(data[o + 2] * invW + (sb / sw) * wBlend);
          cloned[o + 3] = 255;
        }
      }
      cloned.copy(data);
    }

    let minX = w, maxX = -1, minY = h, maxY = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (data[(y * w + x) * 4 + 3] > 16) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    croppedViews.set(view, { data, w, h, minX, maxX, minY, maxY, cropW: maxX - minX + 1, cropH: maxY - minY + 1 });
  }

  const hCrop = croppedViews.get('front').cropH;
  const scale = (1024 / 1.18) / hCrop;
  const outPaths = [];

  for (const view of ['front', 'back', 'left', 'right']) {
    const v = croppedViews.get(view);
    const targetW = Math.min(1024, Math.max(1, Math.round(v.cropW * scale)));
    const targetH = Math.min(1024, Math.max(1, Math.round(v.cropH * scale)));
    const resized = await sharp(v.data, { raw: { width: v.w, height: v.h, channels: 4 } })
      .extract({ left: v.minX, top: v.minY, width: v.cropW, height: v.cropH })
      .resize(targetW, targetH, { kernel: 'lanczos3' })
      .png()
      .toBuffer();

    const left = Math.round((1024 - targetW) / 2);
    const top = Math.round((1024 - targetH) / 2);
    const outAbs = path.join(refsDir, `${view}.png`);
    await sharp({
      create: { width: 1024, height: 1024, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([{ input: resized, left, top }])
      .png()
      .toFile(outAbs);
    outPaths.push(outAbs);
  }
  return outPaths;
}

/**
 * Dump `model.glb` vertex positions & triangle indices, verify exact cKDTree corner matching (<2e-6),
 * calibrate PBR roughness/metallic, pack compact WebP textures, and restore both painted and preserved primitives.
 */
async function restoreExactGeometryAndPackWebP(charId, paintDir, workDir, io) {
  const paintGlb = path.join(paintDir, 'model.glb');
  assert(existsSync(paintGlb), `Missing Hunyuan output GLB: ${paintGlb}`);
  const paintDoc = await io.read(paintGlb);

  const pPos = [];
  const pIdx = [];
  let pOff = 0;
  for (const mesh of paintDoc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      const idx = prim.getIndices();
      assert(pos && idx, 'Painted primitive missing POSITION or indices');
      for (const v of pos.getArray()) pPos.push(v);
      for (const i of idx.getArray()) pIdx.push(pOff + i);
      pOff += pos.getCount();
    }
  }
  await fs.writeFile(path.join(workDir, 'paint-pos.f32'), Buffer.from(new Float32Array(pPos).buffer));
  await fs.writeFile(path.join(workDir, 'paint-index.u32'), Buffer.from(new Uint32Array(pIdx).buffer));

  // Match every triangle corner in paint/model.glb back to exact source vertex indices (< 2e-6)
  execFileSync(HUNYUAN_PYTHON, [mapScript, workDir], { stdio: 'inherit' });

  const readTyped = (filePath, Typed) => {
    const b = readFileSync(filePath);
    return new Typed(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  };
  const srcPos = readTyped(path.join(workDir, 'source-pos.f32'), Float32Array);
  const srcNorm = readTyped(path.join(workDir, 'source-normal.f32'), Float32Array);
  const corners = readTyped(path.join(workDir, 'source-corners.u32'), Uint32Array);
  const roles = JSON.parse(readFileSync(path.join(workDir, 'source-roles.json'), 'utf8'));
  const parts = JSON.parse(readFileSync(path.join(workDir, 'source-parts.json'), 'utf8')).selected;
  const presMetaPath = path.join(workDir, 'preserved-parts.json');
  const presMeta = existsSync(presMetaPath) ? JSON.parse(readFileSync(presMetaPath, 'utf8')) : null;

  const transforms = new Map(
    parts.map((p) => {
      const worldMat = new Matrix4().fromArray(p.worldMatrix);
      const invWorld = worldMat.clone().invert();
      const invNorm = new Matrix3().setFromMatrix4(worldMat).transpose();
      return [p.name, { matrix: p.matrix, invWorld, invNorm }];
    }),
  );

  // Calibrate Hunyuan 2.1 metallic/roughness per material type & pack 4K WebP albedo + glTF metallicRoughness
  const albedoSrc = path.join(paintDir, 'textured.jpg');
  const roughSrc = path.join(paintDir, 'textured_roughness.jpg');
  const metalSrc = path.join(paintDir, 'textured_metallic.jpg');
  assert(existsSync(albedoSrc) && existsSync(roughSrc) && existsSync(metalSrc), `Missing Hunyuan 4K PBR outputs in ${paintDir}`);

  const { data: albedoRaw, info: aInfo } = await sharp(albedoSrc).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { data: roughRaw, info: rInfo } = await sharp(roughSrc).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { data: metalRaw, info: mInfo } = await sharp(metalSrc).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(aInfo.width, rInfo.width);
  assert.equal(aInfo.height, rInfo.height);
  assert.equal(rInfo.width, mInfo.width);
  assert.equal(rInfo.height, mInfo.height);

  const mrRgb = Buffer.alloc(rInfo.width * rInfo.height * 3);
  for (let i = 0, n = rInfo.width * rInfo.height; i < n; i++) {
    const o4 = i * 4;
    const ar = albedoRaw[o4];
    const ag = albedoRaw[o4 + 1];
    const ab = albedoRaw[o4 + 2];
    const rIn = roughRaw[o4];
    const mIn = metalRaw[o4];

    let roughOut;
    let metalOut;
    if (charId === 'varis') {
      roughOut = Math.round(196 + (rIn / 255) * 54);
      metalOut = Math.round(Math.min(mIn, 180) * 0.25);
    } else {
      const isGold = ar > 120 && ag > 75 && ar > ab * 1.6;
      if (isGold) {
        roughOut = Math.round(115 + (rIn / 255) * 90);
        metalOut = Math.round(Math.min(220, Math.max(mIn, 90) * 0.65));
      } else {
        roughOut = Math.round(196 + (rIn / 255) * 54);
        metalOut = Math.round(Math.min(mIn, 120) * 0.15);
      }
    }
    mrRgb[i * 3] = 255;
    mrRgb[i * 3 + 1] = roughOut;
    mrRgb[i * 3 + 2] = metalOut;
  }

  let albedoWebp = await sharp(albedoSrc).webp({ quality: 92, effort: 6, smartSubsample: true }).toBuffer();
  let mrWebp = await sharp(mrRgb, { raw: { width: rInfo.width, height: rInfo.height, channels: 3 } })
    .webp({ quality: 90, effort: 6, smartSubsample: false })
    .toBuffer();

  // If 4K MR makes combined body maps large, keep 4K albedo at q=90 and use crisp 2K MR
  if (albedoWebp.length + mrWebp.length > 6_000_000) {
    albedoWebp = await sharp(albedoSrc).webp({ quality: 90, effort: 6, smartSubsample: true }).toBuffer();
    const mr2k = await sharp(mrRgb, { raw: { width: rInfo.width, height: rInfo.height, channels: 3 } })
      .resize(2048, 2048, { kernel: 'lanczos3' })
      .webp({ quality: 90, effort: 6, smartSubsample: false })
      .toBuffer();
    if (albedoWebp.length + mr2k.length < albedoWebp.length + mrWebp.length) {
      mrWebp = mr2k;
    }
  }
  console.log(
    `  Encoded calibrated Hunyuan PBR WebP: albedo=${(albedoWebp.length / 1e6).toFixed(2)} MB (4K), ` +
    `metallicRoughness=${(mrWebp.length / 1e6).toFixed(2)} MB`,
  );

  // Split restored triangles back to their original node groups & local coordinate frames
  const outDoc = new Document();
  const outScene = outDoc.createScene();
  const buffer = outDoc.createBuffer();
  outDoc.createExtension(EXTTextureWebP).setRequired(true);

  const albedoTex = outDoc.createTexture('Hunyuan_Body_Albedo').setMimeType('image/webp').setImage(albedoWebp);
  const mrTex = outDoc.createTexture('Hunyuan_Body_MR').setMimeType('image/webp').setImage(mrWebp);
  const bodyMat = outDoc
    .createMaterial('Hunyuan_Body_PBR')
    .setBaseColorFactor([1, 1, 1, 1])
    .setBaseColorTexture(albedoTex)
    .setMetallicFactor(1.0)
    .setRoughnessFactor(1.0)
    .setMetallicRoughnessTexture(mrTex);

  let presMat = null;
  if (presMeta && presMeta.tris > 0) {
    const presTex = outDoc
      .createTexture('Preserved_Base_Albedo')
      .setMimeType('image/webp')
      .setImage(readFileSync(path.join(workDir, 'preserved-base.webp')));
    presMat = outDoc
      .createMaterial('Preserved_Original_Regions')
      .setBaseColorFactor([1, 1, 1, 1])
      .setBaseColorTexture(presTex)
      .setMetallicFactor(0.0)
      .setRoughnessFactor(presMeta.roughnessFactor ?? 0.9036020036098448)
      .setDoubleSided(Boolean(presMeta.doubleSided));
  }

  const perRole = new Map();
  let cursor = 0;
  const pv = new Vector3();
  const nv = new Vector3();

  for (const mesh of paintDoc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const idxArr = prim.getIndices().getArray();
      const uv = prim.getAttribute('TEXCOORD_0');
      assert(uv, 'Painted primitive missing TEXCOORD_0');
      for (let i = 0; i < idxArr.length; i += 3) {
        const ids = [corners[cursor], corners[cursor + 1], corners[cursor + 2]];
        cursor += 3;
        const role = roles.find((r) => ids[0] >= r.start && ids[0] < r.end);
        assert(role, `No role found for vertex ${ids[0]}`);
        assert(ids.every((id) => id >= role.start && id < role.end), `Triangle crossed node boundary for ${role.name}`);
        let bucket = perRole.get(role.name);
        if (!bucket) {
          bucket = { role: role.name, pos: [], normal: [], uv: [], idx: [] };
          perRole.set(role.name, bucket);
        }
        const tr = transforms.get(role.name);
        for (let k = 0; k < 3; k++) {
          const id = ids[k];
          pv.set(srcPos[id * 3], srcPos[id * 3 + 1], srcPos[id * 3 + 2]).applyMatrix4(tr.invWorld);
          nv.set(srcNorm[id * 3], srcNorm[id * 3 + 1], srcNorm[id * 3 + 2]).applyMatrix3(tr.invNorm).normalize();
          const uvPair = uv.getElement(idxArr[i + k], []);
          bucket.pos.push(pv.x, pv.y, pv.z);
          bucket.normal.push(nv.x, nv.y, nv.z);
          bucket.uv.push(uvPair[0], uvPair[1]);
          bucket.idx.push(bucket.idx.length);
        }
      }
    }
  }
  assert.equal(cursor, corners.length, 'Corner cursor mismatch after splitting restored body');

  for (const role of roles) {
    const b = perRole.get(role.name);
    assert(b && b.idx.length / 3 === role.triangles, `Triangle count mismatch on restored node ${role.name}`);
    const mesh = outDoc.createMesh(role.name);
    const prim = outDoc
      .createPrimitive()
      .setMode(4)
      .setMaterial(bodyMat)
      .setAttribute('POSITION', outDoc.createAccessor().setBuffer(buffer).setType('VEC3').setArray(new Float32Array(b.pos)))
      .setAttribute('NORMAL', outDoc.createAccessor().setBuffer(buffer).setType('VEC3').setArray(new Float32Array(b.normal)))
      .setAttribute('TEXCOORD_0', outDoc.createAccessor().setBuffer(buffer).setType('VEC2').setArray(new Float32Array(b.uv)))
      .setIndices(outDoc.createAccessor().setBuffer(buffer).setType('SCALAR').setArray(new Uint32Array(b.idx)));
    mesh.addPrimitive(prim);

    if (presMeta && presMeta.tris > 0 && role.name === presMeta.targetNode) {
      const presPrim = outDoc
        .createPrimitive()
        .setMode(4)
        .setMaterial(presMat)
        .setAttribute('POSITION', outDoc.createAccessor().setBuffer(buffer).setType('VEC3').setArray(readTyped(path.join(workDir, 'preserved-pos.f32'), Float32Array)))
        .setAttribute('NORMAL', outDoc.createAccessor().setBuffer(buffer).setType('VEC3').setArray(readTyped(path.join(workDir, 'preserved-normal.f32'), Float32Array)))
        .setAttribute('TEXCOORD_0', outDoc.createAccessor().setBuffer(buffer).setType('VEC2').setArray(readTyped(path.join(workDir, 'preserved-uv.f32'), Float32Array)))
        .setIndices(outDoc.createAccessor().setBuffer(buffer).setType('SCALAR').setArray(readTyped(path.join(workDir, 'preserved-index.u32'), Uint32Array)));
      mesh.addPrimitive(presPrim);
    }

    const node = outDoc.createNode(role.name).setMesh(mesh);
    node.setMatrix(transforms.get(role.name).matrix);
    outScene.addChild(node);
  }

  await outDoc.transform(weld({ overwrite: true }), prune({ keepAttributes: true, keepIndices: true }), unpartition());
  const restoredPartsPath = path.join(workDir, 'model-restored-parts.glb');
  await fs.writeFile(restoredPartsPath, await io.writeBinary(outDoc));
  console.log(`  Restored exact positions & shading normals -> ${restoredPartsPath}`);
  return restoredPartsPath;
}

/**
 * Swap ONLY `cfg.targetNodes` geometry/materials in `fullDoc` from `restoredPartsDoc`,
 * leaving all other nodes (heads, hands, weapons, quiver/closure, staff, crown, FX, anims) untouched.
 */
async function graftRestoredBodyIntoFullCharacter(fullDoc, restoredPartsDoc, cfg, io) {
  const beforeAnims = animationFingerprint(fullDoc);
  const fullNodes = fullDoc.getRoot().listNodes();
  const protectedSnapshots = new Map();
  const targetNodeSet = new Set(cfg.targetNodes);
  const meshTriCount = (m) => m.listPrimitives().reduce((s, p) => s + (p.getIndices()?.getCount() ?? 0) / 3, 0);

  for (const node of fullNodes) {
    if (targetNodeSet.has(node.getName())) continue;
    const m = node.getMesh();
    if (!m) continue;
    protectedSnapshots.set(
      node.getName(),
      m.listPrimitives().map((p) => ({
        tris: p.getIndices()?.getCount() / 3 ?? 0,
        attrs: p.listSemantics().sort().map((s) => accessorMeta(p.getAttribute(s))),
        matName: p.getMaterial()?.getName() ?? null,
      })),
    );
  }

  // Transplant all unique materials used on restored body nodes (painted + preserved base/tail)
  const restoredNodes = restoredPartsDoc.getRoot().listNodes();
  const uniqueMats = [];
  for (const rn of restoredNodes) {
    const rm = rn.getMesh();
    if (!rm) continue;
    for (const rp of rm.listPrimitives()) {
      const m = rp.getMaterial();
      if (m && !uniqueMats.includes(m)) uniqueMats.push(m);
    }
  }
  const matMap = copyToDocument(fullDoc, restoredPartsDoc, uniqueMats);
  fullDoc.createExtension(EXTTextureWebP).setRequired(true);

  const buf = fullDoc.getRoot().listBuffers()[0] ?? fullDoc.createBuffer();
  for (const nodeName of cfg.targetNodes) {
    const fullNode = fullNodes.find((n) => n.getName() === nodeName);
    const restNode = restoredNodes.find((n) => n.getName() === nodeName);
    assert(fullNode && restNode, `Missing node ${nodeName} during assembly`);
    const oldMesh = fullNode.getMesh();
    const expectedTris = meshTriCount(oldMesh);
    const restoredTris = meshTriCount(restNode.getMesh());
    assert.equal(restoredTris, expectedTris, `Triangle count mismatch on ${nodeName}: ${restoredTris} != ${expectedTris}`);

    const newMesh = fullDoc.createMesh(oldMesh.getName() || nodeName);
    for (const rPrim of restNode.getMesh().listPrimitives()) {
      const fPrim = fullDoc.createPrimitive().setMode(4).setMaterial(matMap.get(rPrim.getMaterial()));
      for (const sym of rPrim.listSemantics()) {
        const srcA = rPrim.getAttribute(sym);
        fPrim.setAttribute(
          sym,
          fullDoc.createAccessor().setBuffer(buf).setType(srcA.getType()).setArray(srcA.getArray().slice()),
        );
      }
      const rIdx = rPrim.getIndices();
      fPrim.setIndices(
        fullDoc.createAccessor().setBuffer(buf).setType('SCALAR').setArray(rIdx.getArray().slice()),
      );
      newMesh.addPrimitive(fPrim);
    }
    fullNode.setMesh(newMesh);
    oldMesh.dispose();
  }

  // Keep attributes (e.g. extra TEXCOORDs) and indices on all protected nodes intact;
  // only remove unreferenced body meshes, materials, and swapped-out body textures.
  await fullDoc.transform(
    prune({
      propertyTypes: [PropertyType.TEXTURE, PropertyType.MATERIAL, PropertyType.MESH],
      keepAttributes: true,
      keepIndices: true,
    }),
  );

  // Verify every protected node stayed byte-identical
  for (const node of fullDoc.getRoot().listNodes()) {
    if (targetNodeSet.has(node.getName())) continue;
    const m = node.getMesh();
    if (!m) continue;
    const after = m.listPrimitives().map((p) => ({
      tris: p.getIndices()?.getCount() / 3 ?? 0,
      attrs: p.listSemantics().sort().map((s) => accessorMeta(p.getAttribute(s))),
      matName: p.getMaterial()?.getName() ?? null,
    }));
    assert.deepEqual(after, protectedSnapshots.get(node.getName()), `Protected node modified: ${node.getName()}`);
  }
  assert.deepEqual(animationFingerprint(fullDoc), beforeAnims, 'Animations changed during assembly');

  // Verify WebGL-ready reload
  const check = await io.readBinary(await io.writeBinary(fullDoc));
  return check;
}

function postJsonLong(urlStr, payload, timeoutMs = 1_800_000) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const req = http.request(
      {
        hostname: u.hostname,
        port: Number(u.port || 80),
        path: u.pathname + u.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`POST ${urlStr} timed out after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function runPaintTrial(charId, opts, io) {
  const cfg = CHAR_CONFIG[charId];
  assert(cfg, `Unsupported character: ${charId}`);
  const variantTag = charId === 'varis' ? `${charId}-${opts.varisRefs}` : `${charId}-rendered`;
  const trialDir = path.join(opts.trialRoot, variantTag);
  const workDir = path.join(trialDir, 'work');
  const refsDir = path.join(trialDir, 'refs');
  const paintDir = path.join(trialDir, 'paint');

  console.log(`\n================ Hunyuan 2.1 Trial: ${variantTag} ================`);
  const mainManifest = readJson('client/public/miniatures/manifest.json');
  const highEntry = mainManifest.models.find((m) => m.id === charId);
  assert(highEntry, `${charId} missing from manifest.json`);
  const restoredSourceBytes = restoreSharedGlb(
    readFileSync(path.join(root, 'client/public', highEntry.url)),
    readJson(highEntry.sharedTextureReceipt),
    (uri) => readFileSync(path.join(miniaturesDir, uri)),
  );
  const fullDoc = await io.readBinary(restoredSourceBytes);

  await fs.rm(trialDir, { recursive: true, force: true });
  const { bodyOnlyPath, totalTris } = await extractTargetBody(fullDoc, cfg, charId, io, workDir);

  let refPaths;
  if (charId === 'varis' && opts.varisRefs === 'concept') {
    refPaths = await prepareAlignedConceptRefs(cfg.conceptRefs, refsDir);
  } else {
    const rendered = await renderOrthoReferences(bodyOnlyPath, refsDir, { sharpenRefs: true });
    refPaths = rendered.paths;
  }
  console.log(`  Prepared 4 orthographic 1024x1024 RGBA refs -> ${refsDir}`);

  if (opts.refsOnly) {
    console.log(`  [--refs-only] Stopping before Hunyuan GPU run for ${variantTag}`);
    return { variantTag, trialDir, workDir, refsDir, refsOnly: true };
  }

  console.log(`  Submitting Hunyuan 2.1 /trial to ${opts.workerUrl} (faces=${cfg.faceBudget}, 768px, 6 views, 4K atlas)...`);
  const resp = await postJsonLong(`${opts.workerUrl}/trial`, {
    mesh_path: path.resolve(bodyOnlyPath),
    reference_paths: refPaths.map((p) => path.resolve(p)),
    output_dir: path.resolve(paintDir),
    faces: cfg.faceBudget,
    resolution: 768,
    views: 6,
    atlas: 4096,
  });
  const receiptText = resp.text;
  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`Hunyuan /trial failed (${resp.status}): ${receiptText}`);
  }
  const paintReceipt = JSON.parse(receiptText);
  assert.equal(paintReceipt.encodedReferenceCount, 4, `Expected 4 encoded refs, got ${paintReceipt.encodedReferenceCount}`);
  assert.equal(paintReceipt.actualOutputViewCount, 6, `Expected 6 output views, got ${paintReceipt.actualOutputViewCount}`);
  assert.equal(paintReceipt.nativeTriangles, totalTris);
  assert.equal(paintReceipt.triangles, totalTris);
  console.log(`  Hunyuan 2.1 paint succeeded in ${paintReceipt.seconds}s (peak CUDA ${paintReceipt.peakTorchAllocatedMiB} MiB)`);

  const restoredPartsPath = await restoreExactGeometryAndPackWebP(charId, paintDir, workDir, io);
  const restoredPartsDoc = await io.read(restoredPartsPath);
  const assembledDoc = await graftRestoredBodyIntoFullCharacter(fullDoc, restoredPartsDoc, cfg, io);
  const previewGlb = path.join(opts.trialRoot, `${variantTag}-preview.glb`);
  await fs.writeFile(previewGlb, await io.writeBinary(assembledDoc));
  console.log(`  Saved preview GLB -> ${previewGlb}`);
  return { variantTag, trialDir, workDir, paintDir, restoredPartsPath, previewGlb };
}

async function installCharacterFromTrial(charId, trialDir, io, oldCandidateTextures) {
  const cfg = CHAR_CONFIG[charId];
  assert(cfg, `Unsupported character: ${charId}`);
  const workDir = path.join(trialDir, 'work');
  const restoredPartsPath = path.join(workDir, 'model-restored-parts.glb');
  assert(existsSync(restoredPartsPath), `Missing model-restored-parts.glb in ${workDir}`);

  console.log(`\n================ Installing ${charId.toUpperCase()} from ${trialDir} ================`);
  const mainManifest = readJson('client/public/miniatures/manifest.json');
  const qualityManifest = readJson('client/public/miniatures/quality-manifest.json');
  const battlefieldManifest = readJson('client/public/miniatures/battlefield-manifest.json');

  const snapshotOther = (m) => JSON.stringify(m.models.filter((v) => v.id !== charId));
  const initialOthers = [mainManifest, qualityManifest, battlefieldManifest].map(snapshotOther);

  const highEntry = mainManifest.models.find((m) => m.id === charId);
  assert(highEntry, `${charId} missing from manifest.json`);

  const oldEntries = [
    highEntry,
    ...qualityManifest.models.filter((m) => m.id === charId),
    battlefieldManifest.models.find((m) => m.id === charId),
  ].filter(Boolean);

  const oldSharedFiles = oldEntries.map((e) => path.join(root, 'client/public', e.url));
  for (const e of oldEntries) {
    if (!e.sharedTextureReceipt) continue;
    const sr = readJson(e.sharedTextureReceipt);
    for (const t of sr.textures) oldCandidateTextures.add(path.resolve(path.join(miniaturesDir, t.uri)));
  }

  verifySharedDelivery(highEntry, root);
  const restoredSourceBytes = restoreSharedGlb(
    readFileSync(path.join(root, 'client/public', highEntry.url)),
    readJson(highEntry.sharedTextureReceipt),
    (uri) => readFileSync(path.join(miniaturesDir, uri)),
  );
  const fullDoc = await io.readBinary(restoredSourceBytes);
  const restoredPartsDoc = await io.read(restoredPartsPath);
  const assembledDoc = await graftRestoredBodyIntoFullCharacter(fullDoc, restoredPartsDoc, cfg, io);

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `${charId}-hunyuan-install-`));
  const tempStandalone = [];
  try {
    const preOptBytes = Buffer.from(await io.writeBinary(assembledDoc));
    const preOptSha = sha256(preOptBytes);
    const opt = await compressHighWithOptionalAnimations(assembledDoc, io);
    const totalHighTris = opt.receipt.geometry.reduce((s, p) => s + p.triangles, 0);

    const highStandaloneName = `${cfg.standalonePrefix}-${opt.receipt.sha256.slice(0, 12)}.glb`;
    const highStandaloneAbs = path.join(miniaturesDir, highStandaloneName);
    await fs.writeFile(highStandaloneAbs, opt.bytes);
    tempStandalone.push(highStandaloneAbs);

    const optReceipt = {
      ...opt.receipt,
      schemaVersion: 1,
      id: charId,
      sourceUrl: highEntry.url,
      sourceSha256: preOptSha,
      sourceBytes: preOptBytes.length,
      url: `/miniatures/${highStandaloneName}`,
      triangles: totalHighTris,
      verified: { ...opt.receipt.verified, animationDataExact: true },
    };
    const optReceiptSha = await writeJson(cfg.optReceiptRel, optReceipt);

    for (const k of ['sharedTextureReceipt', 'sharedTextureReceiptSha256']) delete highEntry[k];
    Object.assign(highEntry, {
      url: `/miniatures/${highStandaloneName}`,
      sha256: opt.receipt.sha256,
      bytes: opt.bytes.length,
      triangles: totalHighTris,
      sourceVersion: cfg.sourceVersion,
      sourceSha256: preOptSha,
      sourceTriangles: totalHighTris,
      compression: 'EXT_meshopt_compression',
      originalTextures: true,
      sourceImageHashes: optReceipt.textures.map((t) => t.sourceSha256),
      runtimeImageHashes: optReceipt.textures.map((t) => t.sha256),
      deliveryOptimization: 'lossless-textures-and-mesh',
      optimizationReceipt: cfg.optReceiptRel,
      optimizationReceiptSha256: optReceiptSha,
    });
    await writeJson('client/public/miniatures/manifest.json', mainManifest);

    const runNode = (script, ...args) =>
      execFileSync(process.execPath, [script, ...args], { cwd: root, stdio: 'inherit' });

    // Rebuild Balanced & Low tiers
    const reducedDir = path.join(tmpDir, 'reduced');
    runNode('scripts/token-assets/reduce-characters.mjs', reducedDir, `--characters=${charId}`);

    for (const [profile, label, receiptRel] of [
      ['balanced', 'balanced', cfg.redBalancedRel],
      ['low', 'light', cfg.redLowRel],
    ]) {
      const redReceipt = JSON.parse(readFileSync(path.join(reducedDir, `${charId}-${label}.json`), 'utf8'));
      await writeJson(receiptRel, redReceipt);

      let finalUrlName = redReceipt.filename;
      let finalSha = redReceipt.sha256;
      let finalBytesLen = redReceipt.bytes;
      let finalTris = redReceipt.triangles;
      let extraFields = {};

      if (cfg.sharpenWeapons) {
        const sharpenOut = path.join(tmpDir, `sharpened-${profile}`);
        runNode('scripts/token-assets/sharpen-varis-weapons.mjs', path.join(reducedDir, redReceipt.filename), sharpenOut);
        const refReceipt = JSON.parse(readFileSync(path.join(sharpenOut, 'weapon-refinement.json'), 'utf8'));
        const refReceiptRel = profile === 'balanced'
          ? 'assets/miniatures/character-reduction/varis-balanced-sharpened-weapons.json'
          : 'assets/miniatures/character-reduction/varis-sharpened-weapons.json';
        await writeJson(refReceiptRel, refReceipt);
        finalUrlName = refReceipt.filename;
        finalSha = refReceipt.sha256;
        finalBytesLen = refReceipt.bytes;
        finalTris = refReceipt.triangles;
        extraFields = { refinementReceipt: refReceiptRel };
        await fs.copyFile(path.join(sharpenOut, refReceipt.filename), path.join(miniaturesDir, refReceipt.filename));
      } else {
        await fs.copyFile(path.join(reducedDir, redReceipt.filename), path.join(miniaturesDir, redReceipt.filename));
      }
      tempStandalone.push(path.join(miniaturesDir, finalUrlName));

      const qIdx = qualityManifest.models.findIndex((m) => m.id === charId && m.profile === profile);
      assert(qIdx >= 0, `Missing ${charId}:${profile} in quality-manifest.json`);
      qualityManifest.models[qIdx] = {
        id: charId,
        profile,
        url: `/miniatures/${finalUrlName}`,
        sha256: finalSha,
        bytes: finalBytesLen,
        triangles: finalTris,
        sourceUrl: redReceipt.sourceUrl,
        sourceSha256: redReceipt.sourceSha256,
        receipt: receiptRel,
        ...extraFields,
      };
    }
    await writeJson('client/public/miniatures/quality-manifest.json', qualityManifest);

    // Rebuild Battlefield tier
    const bfDir = path.join(tmpDir, 'battlefield');
    runNode('scripts/token-assets/reduce-characters.mjs', bfDir, '--battlefield', `--characters=${charId}`);
    const bfReceipt = JSON.parse(readFileSync(path.join(bfDir, `${charId}-battlefield.json`), 'utf8'));
    await writeJson(cfg.bfReceiptRel, bfReceipt);
    const bfDest = path.join(miniaturesDir, bfReceipt.filename);
    await fs.copyFile(path.join(bfDir, bfReceipt.filename), bfDest);
    tempStandalone.push(bfDest);

    const bIdx = battlefieldManifest.models.findIndex((m) => m.id === charId);
    assert(bIdx >= 0, `Missing ${charId} in battlefield-manifest.json`);
    const existingBf = battlefieldManifest.models[bIdx];
    battlefieldManifest.models[bIdx] = {
      id: charId,
      url: `/miniatures/${bfReceipt.filename}`,
      sha256: bfReceipt.sha256,
      bytes: bfReceipt.bytes,
      triangles: bfReceipt.triangles,
      baseCenter: bfReceipt.baseCenter,
      baseDiameter: bfReceipt.baseDiameter,
      ...(existingBf.fxUrl ? { fxUrl: existingBf.fxUrl } : {}),
      receipt: cfg.bfReceiptRel,
    };
    await writeJson('client/public/miniatures/battlefield-manifest.json', battlefieldManifest);

    // Share all textures cleanly across the 4 rebuilt tiers
    const tierEntries = [
      { tier: 'high', entry: highEntry },
      ...qualityManifest.models.filter((m) => m.id === charId).map((entry) => ({ tier: entry.profile, entry })),
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
      const sharedName = `${cfg.tierName(tier)}-${shared.receipt.sha256.slice(0, 12)}.glb`;
      const sharedReceiptRel = cfg.sharedReceiptRel(tier);
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
      console.log(`  Installed ${charId} ${tier}: ${sharedName} (${entry.triangles.toLocaleString()} tris, ${(shared.bytes.length / 1e6).toFixed(2)} MB)`);
    }

    for (const [i, m] of [mainManifest, qualityManifest, battlefieldManifest].entries()) {
      assert.equal(snapshotOther(m), initialOthers[i], `Non-${charId} manifest entries must remain unchanged`);
    }
    await writeJson('client/public/miniatures/manifest.json', mainManifest);
    await writeJson('client/public/miniatures/quality-manifest.json', qualityManifest);
    await writeJson('client/public/miniatures/battlefield-manifest.json', battlefieldManifest);

    for (const oldAbs of oldSharedFiles) {
      if (!newSharedFiles.has(path.resolve(oldAbs)) && existsSync(oldAbs)) unlinkSync(oldAbs);
    }
  } finally {
    for (const f of tempStandalone) {
      if (existsSync(f)) try { unlinkSync(f); } catch { /* ignore */ }
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function pruneOrphanTextures(candidatePaths) {
  const active = new Set();
  for (const manifestRel of ['client/public/miniatures/manifest.json', 'client/public/miniatures/quality-manifest.json', 'client/public/miniatures/battlefield-manifest.json']) {
    const manifest = readJson(manifestRel);
    for (const m of manifest.models) {
      if (!m.sharedTextureReceipt) continue;
      const sr = readJson(m.sharedTextureReceipt);
      for (const t of sr.textures) active.add(path.resolve(path.join(miniaturesDir, t.uri)));
    }
  }
  let removed = 0;
  for (const p of candidatePaths) {
    if (!active.has(p) && existsSync(p)) {
      unlinkSync(p);
      removed++;
    }
  }
  console.log(`Active shared textures retained: ${active.size} (pruned ${removed} superseded files).`);
}

const opts = parseArgs(process.argv);
const io = await createDeliveryIO();

async function assemblePreviewFromTrial(charId, trialDir, opts, io) {
  const cfg = CHAR_CONFIG[charId];
  assert(cfg, `Unsupported character: ${charId}`);
  const restoredPartsPath = path.join(trialDir, 'work/model-restored-parts.glb');
  assert(existsSync(restoredPartsPath), `Missing ${restoredPartsPath}`);
  const mainManifest = readJson('client/public/miniatures/manifest.json');
  const highEntry = mainManifest.models.find((m) => m.id === charId);
  assert(highEntry, `${charId} missing from manifest.json`);
  const restoredSourceBytes = restoreSharedGlb(
    readFileSync(path.join(root, 'client/public', highEntry.url)),
    readJson(highEntry.sharedTextureReceipt),
    (uri) => readFileSync(path.join(miniaturesDir, uri)),
  );
  const fullDoc = await io.readBinary(restoredSourceBytes);
  const restoredPartsDoc = await io.read(restoredPartsPath);
  const assembledDoc = await graftRestoredBodyIntoFullCharacter(fullDoc, restoredPartsDoc, cfg, io);
  const tag = path.basename(trialDir);
  const previewGlb = path.join(opts.trialRoot, `${tag}-preview.glb`);
  await fs.writeFile(previewGlb, await io.writeBinary(assembledDoc));
  console.log(`  Assembled preview GLB -> ${previewGlb}`);
  return previewGlb;
}

if (opts.repackFrom && opts.repackFrom.size > 0) {
  for (const [charId, trialDir] of opts.repackFrom.entries()) {
    await restoreExactGeometryAndPackWebP(charId, path.join(trialDir, 'paint'), path.join(trialDir, 'work'), io);
    await assemblePreviewFromTrial(charId, trialDir, opts, io);
  }
} else if (opts.assembleFrom && opts.assembleFrom.size > 0) {
  for (const [charId, trialDir] of opts.assembleFrom.entries()) {
    await assemblePreviewFromTrial(charId, trialDir, opts, io);
  }
} else if (opts.installFrom.size > 0) {
  const oldCandidateTextures = new Set();
  for (const [charId, trialDir] of opts.installFrom.entries()) {
    await installCharacterFromTrial(charId, trialDir, io, oldCandidateTextures);
  }
  await pruneOrphanTextures(oldCandidateTextures);
} else {
  const results = [];
  for (const charId of opts.characters) {
    results.push(await runPaintTrial(charId, opts, io));
  }
  if (!opts.refsOnly && !opts.trialOnly) {
    const oldCandidateTextures = new Set();
    for (const r of results) {
      const charId = r.variantTag.startsWith('varis') ? 'varis' : 'vanec';
      await installCharacterFromTrial(charId, r.trialDir, io, oldCandidateTextures);
    }
    await pruneOrphanTextures(oldCandidateTextures);
  }
}
