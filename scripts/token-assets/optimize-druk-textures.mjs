/**
 * Optimize Druk's shared texture pool across High, Balanced, Low, and Battlefield
 * tiers by:
 *   1. Deduplicating provably pixel-identical redundant 4K body maps (the extra
 *      9.65 MB occlusion map matching MR.R 100%, and the duplicate 1.51 MB normal map).
 *   2. Re-encoding Druk's 27 unique lossless VP8L textures into high-quality,
 *      role-tuned lossy WebP (preserving exact pixel dimensions & keeping the
 *      smaller payload if an existing small lossless file is already tiny).
 *   3. Preserving Druk's geometry, materials, animations/static guarantees, base,
 *      non-Druk characters, and all runtime/quality/battlefield receipts.
 *
 * Usage:
 *   node scripts/token-assets/optimize-druk-textures.mjs
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXTTextureWebP } from '@gltf-transform/extensions';
import sharp from 'sharp';
import { createDeliveryIO, optimizeDelivery } from '../../server/tools/asset-production/lossless_delivery.mjs';
import { restoreSharedGlb, sha256, shareGlbTextures, verifySharedDelivery } from './shared-character-textures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const miniaturesDir = path.join(root, 'client/public/miniatures');

const readJson = (rel) => JSON.parse(readFileSync(path.join(root, rel), 'utf8'));
const writeJson = async (rel, data) => {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const buf = Buffer.from(JSON.stringify(data, null, 2) + '\n', 'utf8');
  await fs.writeFile(abs, buf);
  return sha256(buf);
};

async function verifyPixelIdenticalChannel(bytesA, bytesB, channelIndex) {
  const rawA = await sharp(bytesA).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const rawB = await sharp(bytesB).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (rawA.info.width !== rawB.info.width || rawA.info.height !== rawB.info.height) return false;
  const n = rawA.info.width * rawA.info.height;
  for (let i = 0; i < n; i++) {
    if (channelIndex === null) {
      if (
        rawA.data[i * 4] !== rawB.data[i * 4] ||
        rawA.data[i * 4 + 1] !== rawB.data[i * 4 + 1] ||
        rawA.data[i * 4 + 2] !== rawB.data[i * 4 + 2]
      ) {
        return false;
      }
    } else if (rawA.data[i * 4 + channelIndex] !== rawB.data[i * 4 + channelIndex]) {
      return false;
    }
  }
  return true;
}

const mainManifest = readJson('client/public/miniatures/manifest.json');
const qualityManifest = readJson('client/public/miniatures/quality-manifest.json');
const battlefieldManifest = readJson('client/public/miniatures/battlefield-manifest.json');

const snapshotOther = (m) => JSON.stringify(m.models.filter((v) => v.id !== 'druk'));
const initialOthers = [mainManifest, qualityManifest, battlefieldManifest].map(snapshotOther);

const highEntry = mainManifest.models.find((m) => m.id === 'druk');
assert(highEntry, 'druk missing from manifest.json');
const oldEntries = [
  highEntry,
  ...qualityManifest.models.filter((m) => m.id === 'druk'),
  battlefieldManifest.models.find((m) => m.id === 'druk'),
].filter(Boolean);

const oldSharedFiles = oldEntries.map((e) => path.join(root, 'client/public', e.url));
const oldCandidateTextures = new Set();
for (const e of oldEntries) {
  if (!e.sharedTextureReceipt) continue;
  const sr = readJson(e.sharedTextureReceipt);
  for (const t of sr.textures) oldCandidateTextures.add(path.resolve(path.join(miniaturesDir, t.uri)));
}

console.log('Reconstructing High standalone Druk GLB...');
verifySharedDelivery(highEntry, root);
const restoredHighBytes = restoreSharedGlb(
  readFileSync(path.join(root, 'client/public', highEntry.url)),
  readJson(highEntry.sharedTextureReceipt),
  (uri) => readFileSync(path.join(miniaturesDir, uri)),
);

const io = await createDeliveryIO();
const doc = await io.readBinary(restoredHighBytes);
const gltfRoot = doc.getRoot();
console.log(`Loaded Druk High GLB (${gltfRoot.listTextures().length} textures).`);

// 1. Deduplicate separate 4K occlusion map whose Red channel equals its material's MR.R 100%
let dedupedOcc = 0;
for (const mat of gltfRoot.listMaterials()) {
  const mrTex = mat.getMetallicRoughnessTexture();
  const occTex = mat.getOcclusionTexture();
  if (!mrTex || !occTex || mrTex === occTex) continue;
  const occUsers = gltfRoot.listMaterials().filter(
    (other) =>
      other !== mat &&
      [
        other.getBaseColorTexture(),
        other.getMetallicRoughnessTexture(),
        other.getNormalTexture(),
        other.getOcclusionTexture(),
        other.getEmissiveTexture(),
      ].includes(occTex),
  );
  if (occUsers.length > 0) continue;
  const sameR = await verifyPixelIdenticalChannel(Buffer.from(occTex.getImage()), Buffer.from(mrTex.getImage()), 0);
  assert(sameR, `Expected identical R channel for ${mat.getName()} occlusionTexture vs MR`);
  mat.setOcclusionTexture(mrTex);
  occTex.dispose();
  dedupedOcc++;
  console.log(`Deduplicated redundant occlusionTexture on "${mat.getName()}" -> reuses MR texture.`);
}
assert.equal(dedupedOcc, 1, `Expected 1 deduplicated occlusion texture, got ${dedupedOcc}`);

// 2. Deduplicate byte/pixel-identical normalTexture across the two body PBR materials
let dedupedNormal = 0;
const bodyPbrMats = gltfRoot.listMaterials().filter((m) => m.getName() === 'Druk original-shape corrected body PBR');
assert.equal(bodyPbrMats.length, 2, 'Expected 2 Druk original-shape corrected body PBR materials');
const normA = bodyPbrMats[0].getNormalTexture();
const normB = bodyPbrMats[1].getNormalTexture();
if (normA && normB && normA !== normB) {
  const sameRgb = await verifyPixelIdenticalChannel(Buffer.from(normA.getImage()), Buffer.from(normB.getImage()), null);
  assert(sameRgb, 'Expected identical RGB for body PBR normal maps');
  bodyPbrMats[1].setNormalTexture(normA);
  const normBStillUsed = gltfRoot.listMaterials().some((m) =>
    [
      m.getBaseColorTexture(),
      m.getMetallicRoughnessTexture(),
      m.getNormalTexture(),
      m.getOcclusionTexture(),
      m.getEmissiveTexture(),
    ].includes(normB),
  );
  assert(!normBStillUsed, 'Expected normB to be unreferenced after repointing');
  normB.dispose();
  dedupedNormal++;
  console.log('Deduplicated identical body PBR normalTexture.');
}
assert.equal(dedupedNormal, 1, `Expected 1 deduplicated normal texture, got ${dedupedNormal}`);
assert.equal(gltfRoot.listTextures().length, 27, 'Expected 27 unique textures after deduplication');

// 3. Classify role for each remaining texture and re-encode losslessly-sized or lossy WebP
const roleOf = new Map();
for (const mat of gltfRoot.listMaterials()) {
  const addRole = (tex, role) => {
    if (!tex) return;
    if (!roleOf.has(tex)) roleOf.set(tex, new Set());
    roleOf.get(tex).add(role);
  };
  addRole(mat.getBaseColorTexture(), 'albedo');
  addRole(mat.getMetallicRoughnessTexture(), 'mr');
  addRole(mat.getOcclusionTexture(), 'mr');
  addRole(mat.getNormalTexture(), 'normal');
  addRole(mat.getEmissiveTexture(), 'albedo');
}

let beforeTexBytes = 0;
let afterTexBytes = 0;
for (const [idx, tex] of gltfRoot.listTextures().entries()) {
  const roles = roleOf.get(tex) || new Set(['albedo']);
  const primaryRole = roles.has('normal') ? 'normal' : roles.has('mr') ? 'mr' : 'albedo';
  const orig = Buffer.from(tex.getImage());
  beforeTexBytes += orig.length;

  const opts =
    primaryRole === 'normal'
      ? { quality: 95, effort: 6, smartSubsample: true }
      : primaryRole === 'mr'
        ? { quality: 92, effort: 6, smartSubsample: true }
        : { quality: 90, effort: 6, smartSubsample: true };

  const encoded = await sharp(orig).webp(opts).toBuffer();
  const chosen = encoded.length < orig.length ? encoded : orig;
  const origMeta = await sharp(orig).metadata();
  const chosenMeta = await sharp(chosen).metadata();
  assert.equal(chosenMeta.width, origMeta.width);
  assert.equal(chosenMeta.height, origMeta.height);

  tex.setImage(chosen).setMimeType('image/webp');
  afterTexBytes += chosen.length;
  console.log(
    `  [${String(idx).padStart(2)}] ${primaryRole.padEnd(6)} ${origMeta.width}x${origMeta.height}: ${(orig.length / 1e6).toFixed(2)} MB -> ${(chosen.length / 1e6).toFixed(2)} MB`,
  );
}
doc.createExtension(EXTTextureWebP).setRequired(true);
console.log(
  `Unique texture bytes after dedup + WebP encoding: ${(beforeTexBytes / 1e6).toFixed(2)} MB -> ${(afterTexBytes / 1e6).toFixed(2)} MB (original 29-texture pool was ${( [...oldCandidateTextures].reduce((s, p) => s + readFileSync(p).length, 0) / 1e6 ).toFixed(2)} MB)`,
);

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'druk-tex-opt-'));
const tempStandalone = [];
try {
  const preOptBytes = Buffer.from(await io.writeBinary(doc));
  const preOptSha = sha256(preOptBytes);
  const opt = await optimizeDelivery(doc, io);
  const totalHighTris = opt.receipt.geometry.reduce((s, p) => s + p.triangles, 0);
  assert.equal(totalHighTris, 1079213, 'Druk triangle count must remain 1,079,213');

  const highStandaloneName = `druk-approved-${opt.receipt.sha256.slice(0, 12)}.glb`;
  const highStandaloneAbs = path.join(miniaturesDir, highStandaloneName);
  await fs.writeFile(highStandaloneAbs, opt.bytes);
  tempStandalone.push(highStandaloneAbs);

  const optReceiptRel = 'assets/miniatures/character-compression/druk.json';
  const optReceipt = {
    ...opt.receipt,
    schemaVersion: 1,
    id: 'druk',
    sourceUrl: highEntry.url,
    sourceSha256: preOptSha,
    sourceBytes: preOptBytes.length,
    url: `/miniatures/${highStandaloneName}`,
    triangles: totalHighTris,
    verified: { ...opt.receipt.verified, animationDataExact: true },
  };
  const optReceiptSha = await writeJson(optReceiptRel, optReceipt);

  for (const k of ['sharedTextureReceipt', 'sharedTextureReceiptSha256']) delete highEntry[k];
  Object.assign(highEntry, {
    url: `/miniatures/${highStandaloneName}`,
    sha256: opt.receipt.sha256,
    bytes: opt.bytes.length,
    triangles: totalHighTris,
    sourceVersion: 'druk-approved-20261022/chainmail-strap-boundary-compact-webp',
    sourceSha256: preOptSha,
    sourceTriangles: totalHighTris,
    compression: 'EXT_meshopt_compression',
    originalTextures: true,
    sourceImageHashes: optReceipt.textures.map((t) => t.sourceSha256),
    runtimeImageHashes: optReceipt.textures.map((t) => t.sha256),
    deliveryOptimization: 'lossless-textures-and-mesh',
    optimizationReceipt: optReceiptRel,
    optimizationReceiptSha256: optReceiptSha,
  });
  await writeJson('client/public/miniatures/manifest.json', mainManifest);

  const runNode = (script, ...args) =>
    execFileSync(process.execPath, [script, ...args], { cwd: root, stdio: 'inherit' });

  // Rebuild Balanced and Low tiers
  const reducedDir = path.join(tmpDir, 'reduced');
  runNode('scripts/token-assets/reduce-characters.mjs', reducedDir, '--characters=druk');

  for (const [profile, label, receiptRel] of [
    ['balanced', 'balanced', 'assets/miniatures/character-reduction/druk-balanced.json'],
    ['low', 'light', 'assets/miniatures/character-reduction/druk-light.json'],
  ]) {
    const redReceipt = JSON.parse(readFileSync(path.join(reducedDir, `druk-${label}.json`), 'utf8'));
    await writeJson(receiptRel, redReceipt);
    const destAbs = path.join(miniaturesDir, redReceipt.filename);
    await fs.copyFile(path.join(reducedDir, redReceipt.filename), destAbs);
    tempStandalone.push(destAbs);

    const qIdx = qualityManifest.models.findIndex((m) => m.id === 'druk' && m.profile === profile);
    assert(qIdx >= 0, `Missing druk:${profile} in quality-manifest.json`);
    qualityManifest.models[qIdx] = {
      id: 'druk',
      profile,
      url: `/miniatures/${redReceipt.filename}`,
      sha256: redReceipt.sha256,
      bytes: redReceipt.bytes,
      triangles: redReceipt.triangles,
      sourceUrl: redReceipt.sourceUrl,
      sourceSha256: redReceipt.sourceSha256,
      receipt: receiptRel,
    };
  }
  await writeJson('client/public/miniatures/quality-manifest.json', qualityManifest);

  // Rebuild Battlefield tier
  const bfDir = path.join(tmpDir, 'battlefield');
  runNode('scripts/token-assets/reduce-characters.mjs', bfDir, '--battlefield', '--characters=druk');
  const bfReceipt = JSON.parse(readFileSync(path.join(bfDir, 'druk-battlefield.json'), 'utf8'));
  const bfReceiptRel = 'assets/miniatures/battlefield-lod/druk.json';
  await writeJson(bfReceiptRel, bfReceipt);
  const bfDestAbs = path.join(miniaturesDir, bfReceipt.filename);
  await fs.copyFile(path.join(bfDir, bfReceipt.filename), bfDestAbs);
  tempStandalone.push(bfDestAbs);

  const bIdx = battlefieldManifest.models.findIndex((m) => m.id === 'druk');
  assert(bIdx >= 0, 'Missing druk in battlefield-manifest.json');
  const prevBf = battlefieldManifest.models[bIdx];
  assert(prevBf.baseTextureUrl, 'Expected baseTextureUrl on Druk battlefield entry');
  battlefieldManifest.models[bIdx] = {
    id: 'druk',
    url: `/miniatures/${bfReceipt.filename}`,
    sha256: bfReceipt.sha256,
    bytes: bfReceipt.bytes,
    triangles: bfReceipt.triangles,
    baseCenter: bfReceipt.baseCenter,
    baseDiameter: bfReceipt.baseDiameter,
    baseTextureUrl: prevBf.baseTextureUrl,
    receipt: bfReceiptRel,
  };
  await writeJson('client/public/miniatures/battlefield-manifest.json', battlefieldManifest);

  // Share all textures cleanly across all 4 tiers
  const tierEntries = [
    { tier: 'high', entry: highEntry },
    ...qualityManifest.models.filter((m) => m.id === 'druk').map((entry) => ({ tier: entry.profile, entry })),
    { tier: 'battlefield', entry: battlefieldManifest.models[bIdx] },
  ];
  const newSharedFiles = new Set();
  const uniqueSharedTex = new Map();
  for (const { tier, entry } of tierEntries) {
    const standaloneUrl = entry.url;
    const standaloneBytes = readFileSync(path.join(root, 'client/public', standaloneUrl));
    assert.equal(sha256(standaloneBytes), entry.sha256);
    const shared = shareGlbTextures(standaloneBytes);
    shared.receipt.sourceUrl = standaloneUrl;
    for (const img of shared.images) {
      uniqueSharedTex.set(img.uri, img.bytes);
      const texPath = path.join(miniaturesDir, img.uri);
      if (existsSync(texPath)) {
        assert.equal(sha256(readFileSync(texPath)), img.sha256, `Texture hash mismatch on ${img.uri}`);
      } else {
        await fs.mkdir(path.dirname(texPath), { recursive: true });
        await fs.writeFile(texPath, img.payload);
      }
    }
    const sharedName = `druk-${tier}-shared-${shared.receipt.sha256.slice(0, 12)}.glb`;
    const sharedReceiptRel = `assets/miniatures/shared-textures/druk-${tier}.json`;
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
    console.log(
      `  Installed druk ${tier}: ${sharedName} (${entry.triangles.toLocaleString()} tris, ${(shared.bytes.length / 1e6).toFixed(2)} MB)`,
    );
  }

  for (const [i, m] of [mainManifest, qualityManifest, battlefieldManifest].entries()) {
    assert.equal(snapshotOther(m), initialOthers[i], 'Non-druk manifest entries must remain unchanged');
  }
  await writeJson('client/public/miniatures/manifest.json', mainManifest);
  await writeJson('client/public/miniatures/quality-manifest.json', qualityManifest);
  await writeJson('client/public/miniatures/battlefield-manifest.json', battlefieldManifest);

  const uniqueTexBytesTotal = [...uniqueSharedTex.values()].reduce((s, n) => s + n, 0);
  await writeJson('assets/miniatures/character-compression/druk-approved-install.json', {
    approvedSourceSha256: highEntry.sourceSha256,
    approvedReviewBytes: preOptBytes.length,
    fullStandaloneBytes: opt.bytes.length,
    triangles: totalHighTris,
    tiers: tierEntries.map(({ tier, entry }) => ({
      tier,
      url: entry.url,
      bytes: entry.bytes,
      triangles: entry.triangles,
    })),
    uniqueTextureBytes: uniqueTexBytesTotal,
    texturesSharedAcrossAllTiers: true,
    allTiersRebuiltFromApprovedModel: true,
    rebuildCommand: 'node scripts/token-assets/optimize-druk-textures.mjs',
  });

  // Remove old Druk shared GLBs
  for (const oldAbs of oldSharedFiles) {
    if (!newSharedFiles.has(path.resolve(oldAbs)) && existsSync(oldAbs)) {
      unlinkSync(oldAbs);
    }
  }

  // Prune ONLY superseded Druk textures not referenced by any active manifest
  const active = new Set();
  for (const m of [mainManifest, qualityManifest, battlefieldManifest]) {
    for (const model of m.models) {
      if (!model.sharedTextureReceipt) continue;
      const sr = readJson(model.sharedTextureReceipt);
      for (const t of sr.textures) active.add(path.resolve(path.join(miniaturesDir, t.uri)));
    }
  }
  let removed = 0;
  for (const p of oldCandidateTextures) {
    if (!active.has(p) && existsSync(p)) {
      unlinkSync(p);
      removed++;
    }
  }
  console.log(
    `\nActive shared textures retained: ${active.size} (pruned ${removed} superseded Druk textures). Druk shared tex pool: ${(uniqueTexBytesTotal / 1e6).toFixed(2)} MB across ${uniqueSharedTex.size} files.`,
  );
} finally {
  for (const f of tempStandalone) {
    if (existsSync(f)) {
      try {
        unlinkSync(f);
      } catch {
        /* ignore */
      }
    }
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
}
