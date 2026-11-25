import { Box3, Mesh, Object3D, Ray, Vector3 } from 'three';

const Y_SLICES = 10;
const XZ_GRID = 3;

export interface PickHullBaseMetrics {
  baseCenter: readonly [number, number, number];
  baseDiameter: number;
}

/**
 * Build a compact list of tight local-space AABB sub-boxes (centered around
 * `definition.baseCenter` in `root` space) by binning the model's mesh vertices
 * into a 10×3×3 voxel grid.
 *
 * Computed once per model URL on load (~1ms) so 3D ray picking during hover and
 * click tests ~25-45 tiny boxes in < 0.01ms instead of brute-forcing 20k-120k
 * mesh triangles on the main thread.
 */
export function buildMiniaturePickHull(
  model: Object3D,
  definition: PickHullBaseMetrics,
): Box3[] {
  const [cx, cy, cz] = definition.baseCenter;
  model.updateWorldMatrix(true, true);

  const overall = new Box3();
  const v = new Vector3();
  const meshes: Mesh[] = [];
  model.traverse((node) => {
    if (!(node instanceof Mesh) || node.name === 'disposition-outline' || node.userData.dynamicFx) return;
    const pos = node.geometry?.getAttribute('position');
    if (!pos || pos.count === 0) return;
    meshes.push(node);
    const step = pos.count > 12000 ? Math.ceil(pos.count / 6000) : 1;
    for (let i = 0; i < pos.count; i += step) {
      v.fromBufferAttribute(pos, i).applyMatrix4(node.matrixWorld);
      v.set(v.x - cx, v.y - cy, v.z - cz);
      overall.expandByPoint(v);
    }
  });

  if (overall.isEmpty()) {
    const r = Math.max(0.01, definition.baseDiameter * 0.5);
    return [new Box3(new Vector3(-r, 0, -r), new Vector3(r, r * 2, r))];
  }

  const size = overall.getSize(new Vector3());
  const minX = overall.min.x;
  const minY = overall.min.y;
  const minZ = overall.min.z;
  const invX = size.x > 1e-5 ? XZ_GRID / size.x : 0;
  const invY = size.y > 1e-5 ? Y_SLICES / size.y : 0;
  const invZ = size.z > 1e-5 ? XZ_GRID / size.z : 0;

  const cells = new Map<number, Box3>();
  for (const node of meshes) {
    const pos = node.geometry.getAttribute('position');
    const step = pos.count > 12000 ? Math.ceil(pos.count / 6000) : 1;
    for (let i = 0; i < pos.count; i += step) {
      v.fromBufferAttribute(pos, i).applyMatrix4(node.matrixWorld);
      v.set(v.x - cx, v.y - cy, v.z - cz);
      const ix = Math.min(XZ_GRID - 1, Math.max(0, Math.floor((v.x - minX) * invX)));
      const iy = Math.min(Y_SLICES - 1, Math.max(0, Math.floor((v.y - minY) * invY)));
      const iz = Math.min(XZ_GRID - 1, Math.max(0, Math.floor((v.z - minZ) * invZ)));
      const key = (iy * XZ_GRID + iz) * XZ_GRID + ix;
      let cell = cells.get(key);
      if (!cell) {
        cell = new Box3();
        cells.set(key, cell);
      }
      cell.expandByPoint(v);
    }
  }

  // Slight padding (1.5% of baseDiameter) seals micro-seams between adjacent voxel boxes.
  const pad = Math.max(0.002, definition.baseDiameter * 0.015);
  const hull: Box3[] = [];
  for (const box of cells.values()) {
    box.expandByScalar(pad);
    hull.push(box);
  }
  return hull.length ? hull : [overall];
}

const scratchHit = new Vector3();

/**
 * Intersect a local-space ray against a cached pick hull, returning the closest
 * squared distance along the local ray (or `Infinity` if missed).
 */
export function intersectPickHullLocal(
  localRay: Ray,
  hull: readonly Box3[],
  outPoint: Vector3,
): boolean {
  let bestDistSq = Infinity;
  let hitAny = false;
  for (let i = 0; i < hull.length; i++) {
    const hit = localRay.intersectBox(hull[i]!, scratchHit);
    if (!hit) continue;
    const dSq = localRay.origin.distanceToSquared(hit);
    if (dSq < bestDistSq) {
      bestDistSq = dSq;
      outPoint.copy(hit);
      hitAny = true;
    }
  }
  return hitAny;
}
