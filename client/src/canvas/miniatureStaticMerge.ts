import {
  BufferAttribute,
  BufferGeometry,
  Float32BufferAttribute,
  InstancedMesh,
  Matrix3,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  SkinnedMesh,
  Uint16BufferAttribute,
  Uint32BufferAttribute,
  Vector3,
  type Material,
  type Object3D,
  type Texture,
} from 'three';

function textureKey(tex: Texture | null | undefined): string {
  if (!tex) return '';
  return [
    tex.source?.uuid ?? tex.uuid,
    tex.offset.x,
    tex.offset.y,
    tex.repeat.x,
    tex.repeat.y,
    tex.rotation,
    tex.wrapS,
    tex.wrapT,
    tex.colorSpace,
    tex.flipY ? 1 : 0,
    tex.channel,
  ].join(',');
}

/** Build a strict structural+visual equivalence key for static PBR material deduplication. */
export function canonicalMaterialKey(mat: MeshStandardMaterial): string {
  return JSON.stringify([
    mat.color.getHex(),
    mat.roughness,
    mat.metalness,
    mat.emissive.getHex(),
    mat.emissiveIntensity,
    mat.side,
    mat.transparent,
    mat.opacity,
    mat.alphaTest,
    mat.depthWrite,
    mat.vertexColors,
    mat.flatShading,
    mat.wireframe,
    !!mat.userData.pewterBase,
    mat.envMapIntensity,
    mat.normalScale.x,
    mat.normalScale.y,
    mat.aoMapIntensity,
    mat.bumpScale,
    mat.customProgramCacheKey?.() ?? '',
    textureKey(mat.map),
    textureKey(mat.normalMap),
    textureKey(mat.roughnessMap),
    textureKey(mat.metalnessMap),
    textureKey(mat.aoMap),
    textureKey(mat.emissiveMap),
    textureKey(mat.bumpMap),
    textureKey(mat.alphaMap),
  ]);
}

function isDynamicFxOrHidden(node: Object3D, stopAt: Object3D): boolean {
  let cur: Object3D | null = node;
  while (cur) {
    if (!cur.visible || cur.userData.dynamicFx) return true;
    if (cur === stopAt) break;
    cur = cur.parent;
  }
  return false;
}

type MergeCandidate = {
  mesh: Mesh;
  geometry: BufferGeometry;
  material: MeshStandardMaterial;
  attrNames: string[];
};

/** Merge static sub-meshes of a non-animated multi-primitive miniature grouped by
 * canonical MeshStandardMaterial + layers + renderOrder + vertex attribute signature. */
export function mergeStaticHeroMeshes(model: Object3D): { mergedGeometries: BufferGeometry[] } {
  model.updateMatrixWorld(true);
  const modelInverse = model.matrixWorld.clone().invert();
  const mergedGeometries: BufferGeometry[] = [];
  const canonicalMats = new Map<string, MeshStandardMaterial>();
  const droppedMats = new Set<Material>();
  const allMeshes: Mesh[] = [];

  model.traverse((node) => {
    if (!(node instanceof Mesh) || node === model) return;
    if (isDynamicFxOrHidden(node, model)) return;
    if (node.name === 'disposition-outline') return;
    if (node instanceof SkinnedMesh || node instanceof InstancedMesh || (node.morphTargetInfluences?.length ?? 0) > 0) return;
    if (Array.isArray(node.material)) return;
    allMeshes.push(node);
  });

  // Deduplicate identical MeshStandardMaterials first so identical parts share one group.
  const meshCanonicalMat = new Map<Mesh, MeshStandardMaterial>();
  for (const mesh of allMeshes) {
    const mat = mesh.material;
    if (!(mat instanceof MeshStandardMaterial)) continue;
    const key = canonicalMaterialKey(mat);
    const existing = canonicalMats.get(key);
    if (existing) {
      if (existing !== mat) {
        droppedMats.add(mat);
        mesh.material = existing;
      }
      meshCanonicalMat.set(mesh, existing);
    } else {
      canonicalMats.set(key, mat);
      meshCanonicalMat.set(mesh, mat);
    }
  }

  for (const dropped of droppedMats) {
    let referenced = false;
    model.traverse((node) => {
      if (referenced || !(node instanceof Mesh)) return;
      const mats = Array.isArray(node.material) ? node.material : [node.material];
      if (mats.includes(dropped)) referenced = true;
    });
    if (!referenced) dropped.dispose();
  }

  // Group eligible meshes by material + render state + exact attribute set.
  const groups = new Map<string, MergeCandidate[]>();
  for (const mesh of allMeshes) {
    const mat = meshCanonicalMat.get(mesh);
    if (!mat) continue;
    const geom = mesh.geometry;
    const pos = geom.getAttribute('position');
    if (!pos || pos.count === 0) continue;
    const attrNames = Object.keys(geom.attributes).sort();
    const attrSig = attrNames.map((n) => `${n}:${geom.getAttribute(n).itemSize}`).join(',');
    const groupKey = `${mat.uuid}|${mesh.layers.mask}|${mesh.renderOrder}|${attrSig}`;
    let list = groups.get(groupKey);
    if (!list) {
      list = [];
      groups.set(groupKey, list);
    }
    list.push({ mesh, geometry: geom, material: mat, attrNames });
  }

  const posVec = new Vector3();
  const normVec = new Vector3();
  const tanVec = new Vector3();

  for (const items of groups.values()) {
    if (items.length < 2) continue;
    const first = items[0];
    const attrNames = first.attrNames;
    let totalVertices = 0;
    let totalIndices = 0;

    type PreparedItem = {
      mesh: Mesh;
      geometry: BufferGeometry;
      relMatrix: Matrix4;
      normalMatrix: Matrix3;
      flipWinding: boolean;
      vertexCount: number;
      indexStart: number;
      indexCount: number;
    };
    const prepared: PreparedItem[] = [];

    for (const item of items) {
      const geom = item.geometry;
      const pos = geom.getAttribute('position');
      const idxAttr = geom.index;
      const range = geom.drawRange;
      const available = idxAttr ? idxAttr.count : pos.count;
      const start = Math.max(0, Math.min(range.start, available));
      const count = Math.max(0, Math.min(range.count, available - start));
      const triCount = Math.floor(count / 3) * 3;
      if (triCount < 3) continue;
      const relMatrix = modelInverse.clone().multiply(item.mesh.matrixWorld);
      const normalMatrix = new Matrix3().getNormalMatrix(relMatrix);
      const flipWinding = relMatrix.determinant() < 0;
      prepared.push({
        mesh: item.mesh,
        geometry: geom,
        relMatrix,
        normalMatrix,
        flipWinding,
        vertexCount: pos.count,
        indexStart: start,
        indexCount: triCount,
      });
      totalVertices += pos.count;
      totalIndices += triCount;
    }

    if (prepared.length < 2 || totalVertices === 0 || totalIndices === 0) continue;

    const merged = new BufferGeometry();
    for (const name of attrNames) {
      const itemSize = first.geometry.getAttribute(name).itemSize;
      const out = new Float32Array(totalVertices * itemSize);
      let vCursor = 0;

      for (const part of prepared) {
        const attr = part.geometry.getAttribute(name) as BufferAttribute;
        if (name === 'position') {
          for (let i = 0; i < part.vertexCount; i++) {
            posVec.fromBufferAttribute(attr, i).applyMatrix4(part.relMatrix);
            const o = (vCursor + i) * 3;
            out[o] = posVec.x;
            out[o + 1] = posVec.y;
            out[o + 2] = posVec.z;
          }
        } else if (name === 'normal') {
          for (let i = 0; i < part.vertexCount; i++) {
            normVec.fromBufferAttribute(attr, i).applyMatrix3(part.normalMatrix).normalize();
            const o = (vCursor + i) * 3;
            out[o] = normVec.x;
            out[o + 1] = normVec.y;
            out[o + 2] = normVec.z;
          }
        } else if (name === 'tangent' && itemSize === 4) {
          for (let i = 0; i < part.vertexCount; i++) {
            tanVec.set(attr.getX(i), attr.getY(i), attr.getZ(i)).transformDirection(part.relMatrix);
            const o = (vCursor + i) * 4;
            out[o] = tanVec.x;
            out[o + 1] = tanVec.y;
            out[o + 2] = tanVec.z;
            out[o + 3] = part.flipWinding ? -attr.getW(i) : attr.getW(i);
          }
        } else {
          for (let i = 0; i < part.vertexCount; i++) {
            const o = (vCursor + i) * itemSize;
            out[o] = attr.getX(i);
            if (itemSize > 1) out[o + 1] = attr.getY(i);
            if (itemSize > 2) out[o + 2] = attr.getZ(i);
            if (itemSize > 3) out[o + 3] = attr.getW(i);
          }
        }
        vCursor += part.vertexCount;
      }

      merged.setAttribute(name, new Float32BufferAttribute(out, itemSize));
    }

    const indexArray = totalVertices > 65535 ? new Uint32Array(totalIndices) : new Uint16Array(totalIndices);
    let vertexOffset = 0;
    let indexCursor = 0;
    for (const part of prepared) {
      const srcIndex = part.geometry.index;
      for (let i = 0; i < part.indexCount; i += 3) {
        const i0 = vertexOffset + (srcIndex ? srcIndex.getX(part.indexStart + i) : part.indexStart + i);
        const i1 = vertexOffset + (srcIndex ? srcIndex.getX(part.indexStart + i + 1) : part.indexStart + i + 1);
        const i2 = vertexOffset + (srcIndex ? srcIndex.getX(part.indexStart + i + 2) : part.indexStart + i + 2);
        indexArray[indexCursor++] = i0;
        if (part.flipWinding) {
          indexArray[indexCursor++] = i2;
          indexArray[indexCursor++] = i1;
        } else {
          indexArray[indexCursor++] = i1;
          indexArray[indexCursor++] = i2;
        }
      }
      vertexOffset += part.vertexCount;
    }
    merged.setIndex(
      indexArray instanceof Uint32Array ? new Uint32BufferAttribute(indexArray, 1) : new Uint16BufferAttribute(indexArray, 1),
    );
    merged.computeBoundingBox();
    merged.computeBoundingSphere();
    mergedGeometries.push(merged);

    const mergedMesh = new Mesh(merged, first.material);
    mergedMesh.name = `merged-static-${first.material.name || 'part'}`;
    mergedMesh.layers.mask = first.mesh.layers.mask;
    mergedMesh.renderOrder = first.mesh.renderOrder;
    mergedMesh.castShadow = first.mesh.castShadow;
    mergedMesh.receiveShadow = first.mesh.receiveShadow;
    mergedMesh.matrixAutoUpdate = false;
    mergedMesh.updateMatrix();
    model.add(mergedMesh);

    for (const part of prepared) part.mesh.removeFromParent();
  }

  return { mergedGeometries };
}
