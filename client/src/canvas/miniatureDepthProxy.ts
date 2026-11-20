import { BufferGeometry, Float32BufferAttribute, InstancedMesh, Matrix4, Mesh, Vector3, type Object3D } from 'three';
import { isMiniatureWeaponPart } from './miniatureSilhouetteOutline';

export type DepthProxyGeometries = {
  body: BufferGeometry | null;
  weapon: BufferGeometry | null;
};

type BakePart = { mesh: Mesh; matrix: Matrix4; start: number; count: number };

function bakePositionGeometry(parts: readonly BakePart[]): BufferGeometry | null {
  let totalVertices = 0;
  for (const part of parts) totalVertices += part.count;
  if (!totalVertices) return null;
  const vertices = new Float32Array(totalVertices * 3);
  const vertex = new Vector3();
  let offset = 0;
  for (const { mesh, matrix, start, count } of parts) {
    const index = mesh.geometry.index;
    for (let i = start; i < start + count; i++) {
      mesh.getVertexPosition(index ? index.getX(i) : i, vertex).applyMatrix4(matrix);
      vertices[offset++] = vertex.x;
      vertices[offset++] = vertex.y;
      vertices[offset++] = vertex.z;
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(vertices, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

/** Merge opaque non-outline sub-meshes of a static multi-primitive hero into
 * one body and at most one weapon position-only geometry for depth/silhouette masks. */
export function createMiniatureDepthProxyGeometries(source: Object3D): DepthProxyGeometries {
  source.updateWorldMatrix(true, true);
  const parentInverse = source.parent?.matrixWorld.clone().invert() ?? new Matrix4();
  const bodyParts: BakePart[] = [];
  const weaponParts: BakePart[] = [];
  source.traverseVisible((node) => {
    if (!(node instanceof Mesh) || node.name === 'disposition-outline') return;
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    if (!materials.every((m) => !m.transparent)) return;
    const position = node.geometry.getAttribute('position');
    if (!position) return;
    const range = node.geometry.drawRange;
    const start = range.start;
    const count = Math.max(0, Math.min(range.count, (node.geometry.index?.count ?? position.count) - start));
    if (!count) return;
    const target = isMiniatureWeaponPart(node.name) ? weaponParts : bodyParts;
    const matrix = parentInverse.clone().multiply(node.matrixWorld);
    if (node instanceof InstancedMesh) {
      for (let i = 0; i < node.count; i++) {
        const instance = new Matrix4();
        node.getMatrixAt(i, instance);
        target.push({ mesh: node, matrix: matrix.clone().multiply(instance), start, count });
      }
    } else {
      target.push({ mesh: node, matrix, start, count });
    }
  });
  return {
    body: bakePositionGeometry(bodyParts),
    weapon: bakePositionGeometry(weaponParts),
  };
}
