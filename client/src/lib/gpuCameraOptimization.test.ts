import { describe, expect, it } from 'vitest';
import {
  BoxGeometry,
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshStandardMaterial,
  Vector3,
} from 'three';
import { clampMapTextureDimensions } from '../canvas/mapTileTextures.js';
import { canonicalMaterialKey, mergeStaticHeroMeshes } from '../canvas/miniatureStaticMerge.js';

describe('clampMapTextureDimensions', () => {
  it('keeps dimensions unchanged when within the limit', () => {
    expect(clampMapTextureDimensions(2048, 1536, 4096)).toEqual({ width: 2048, height: 1536, scaled: false });
    expect(clampMapTextureDimensions(2048, 2048, 2048)).toEqual({ width: 2048, height: 2048, scaled: false });
  });

  it('scales proportionally when exceeding GPU or tier limit while enforcing the 256 minimum floor', () => {
    expect(clampMapTextureDimensions(6000, 3000, 2048)).toEqual({ width: 2048, height: 1024, scaled: true });
    expect(clampMapTextureDimensions(1024, 512, 128)).toEqual({ width: 256, height: 128, scaled: true });
  });
});

describe('mergeStaticHeroMeshes', () => {
  it('deduplicates value-identical materials and merges compatible static meshes', () => {
    const model = new Group();
    const matA = new MeshStandardMaterial({ color: 0x336699, roughness: 0.7, metalness: 0.1 });
    const matB = new MeshStandardMaterial({ color: 0x336699, roughness: 0.7, metalness: 0.1 });
    const matDifferent = new MeshStandardMaterial({ color: 0x336699, roughness: 0.25, metalness: 0.8 });

    expect(canonicalMaterialKey(matA)).toBe(canonicalMaterialKey(matB));
    expect(canonicalMaterialKey(matA)).not.toBe(canonicalMaterialKey(matDifferent));

    const meshA = new Mesh(new BoxGeometry(1, 1, 1), matA);
    meshA.position.set(2, 0, 0);
    const meshB = new Mesh(new BoxGeometry(1, 1, 1), matB);
    meshB.position.set(-2, 0, 0);
    const meshOther = new Mesh(new BoxGeometry(1, 1, 1), matDifferent);

    const fxGroup = new Group();
    fxGroup.userData.dynamicFx = true;
    const fxMesh = new Mesh(new BoxGeometry(0.5, 0.5, 0.5), matA);
    fxGroup.add(fxMesh);

    const hiddenMesh = new Mesh(new BoxGeometry(1, 1, 1), matA);
    hiddenMesh.visible = false;

    model.add(meshA, meshB, meshOther, fxGroup, hiddenMesh);

    const { mergedGeometries } = mergeStaticHeroMeshes(model);
    expect(mergedGeometries).toHaveLength(1);
    expect(meshA.parent).toBeNull();
    expect(meshB.parent).toBeNull();
    expect(meshOther.parent).toBe(model);
    expect(fxMesh.parent).toBe(fxGroup);
    expect(hiddenMesh.parent).toBe(model);

    const visibleMeshes: Mesh[] = [];
    model.traverse((n) => {
      if (n instanceof Mesh && n.visible && !n.userData.dynamicFx && !n.parent?.userData.dynamicFx) visibleMeshes.push(n);
    });
    expect(visibleMeshes).toHaveLength(2);

    mergedGeometries.forEach((g) => g.dispose());
    matA.dispose();
    matB.dispose();
    matDifferent.dispose();
    meshA.geometry.dispose();
    meshB.geometry.dispose();
    meshOther.geometry.dispose();
    fxMesh.geometry.dispose();
    hiddenMesh.geometry.dispose();
  });

  it('keeps distinct attribute signatures separate and flips winding for mirrored transforms', () => {
    const model = new Group();
    const mat = new MeshStandardMaterial({ color: 0xffffff });

    const makeTri = (withUv: boolean) => {
      const g = new BufferGeometry();
      g.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
      g.setAttribute('normal', new Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
      if (withUv) g.setAttribute('uv', new Float32BufferAttribute([0, 0, 1, 0, 0, 1], 2));
      g.setIndex([0, 1, 2]);
      return g;
    };

    const g1 = makeTri(true);
    const g2 = makeTri(true);
    const gNoUv = makeTri(false);

    const m1 = new Mesh(g1, mat);
    const m2 = new Mesh(g2, mat);
    m2.scale.set(-1, 1, 1); // Mirror on X => negative determinant.
    const mNoUv = new Mesh(gNoUv, mat);

    model.add(m1, m2, mNoUv);
    const { mergedGeometries } = mergeStaticHeroMeshes(model);

    expect(mergedGeometries).toHaveLength(1);
    expect(mNoUv.parent).toBe(model);

    const merged = mergedGeometries[0];
    const pos = merged.getAttribute('position');
    const idx = merged.index!;
    // Check both triangles' geometric cross-product points along +Z despite mirrored m2.
    for (let t = 0; t < idx.count; t += 3) {
      const a = new Vector3().fromBufferAttribute(pos, idx.getX(t));
      const b = new Vector3().fromBufferAttribute(pos, idx.getX(t + 1));
      const c = new Vector3().fromBufferAttribute(pos, idx.getX(t + 2));
      const geoNormal = new Vector3().subVectors(b, a).cross(new Vector3().subVectors(c, a)).normalize();
      expect(geoNormal.z).toBeGreaterThan(0.99);
    }

    mergedGeometries.forEach((g) => g.dispose());
    mat.dispose();
    g1.dispose();
    g2.dispose();
    gNoUv.dispose();
  });
});
