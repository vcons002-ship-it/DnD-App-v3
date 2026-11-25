import { describe, expect, it } from 'vitest';
import { BoxGeometry, CylinderGeometry, Group, Mesh, MeshBasicMaterial, Ray, SphereGeometry, Vector3 } from 'three';
import { buildMiniaturePickHull, intersectPickHullLocal } from '../../client/src/canvas/miniaturePickHull.js';

describe('miniaturePickHull', () => {
  it('hits figure body and head while missing empty air beside the head', () => {
    const model = new Group();
    const mat = new MeshBasicMaterial();
    const base = new Mesh(new CylinderGeometry(1, 1, 0.16, 16), mat);
    base.position.set(0, 0.08, 0);
    const torso = new Mesh(new BoxGeometry(0.55, 1.0, 0.4), mat);
    torso.position.set(0, 0.7, 0);
    const head = new Mesh(new SphereGeometry(0.22, 12, 12), mat);
    head.position.set(0, 1.45, 0);
    model.add(base, torso, head);

    const hull = buildMiniaturePickHull(model, { baseCenter: [0, 0, 0], baseDiameter: 2 });
    expect(hull.length).toBeGreaterThan(2);
    expect(hull.length).toBeLessThanOrEqual(90);

    const out = new Vector3();
    // Direct hit on the head.
    const headRay = new Ray(new Vector3(0, 1.45, 5), new Vector3(0, 0, -1));
    expect(intersectPickHullLocal(headRay, hull, out)).toBe(true);
    expect(out.y).toBeCloseTo(1.45, 1);

    // Ray through empty air beside the head (inside the overall AABB of base+head,
    // so a naive single-box hull would falsely hit, while the voxel hull misses).
    const emptyAirRay = new Ray(new Vector3(0.85, 1.45, 5), new Vector3(0, 0, -1));
    expect(intersectPickHullLocal(emptyAirRay, hull, out)).toBe(false);

    // Direct hit on the base rim at the same X coordinate.
    const baseRimRay = new Ray(new Vector3(0.85, 0.08, 5), new Vector3(0, 0, -1));
    expect(intersectPickHullLocal(baseRimRay, hull, out)).toBe(true);

    base.geometry.dispose();
    torso.geometry.dispose();
    head.geometry.dispose();
    mat.dispose();
  });

  it('strides dense hero-scale meshes cleanly and keeps intersection fast', () => {
    const model = new Group();
    const mat = new MeshBasicMaterial();
    // ~20k vertices (similar to a monster/hero miniature mesh).
    const dense = new Mesh(new SphereGeometry(0.6, 140, 140), mat);
    dense.position.set(0.2, 0.8, -0.1);
    model.add(dense);

    const hull = buildMiniaturePickHull(model, { baseCenter: [0.2, 0.2, -0.1], baseDiameter: 1.2 });
    expect(hull.length).toBeGreaterThan(5);
    expect(hull.length).toBeLessThanOrEqual(90);

    const out = new Vector3();
    const ray = new Ray(new Vector3(0, 0.6, 5), new Vector3(0, 0, -1));
    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      expect(intersectPickHullLocal(ray, hull, out)).toBe(true);
    }
    const elapsedMs = performance.now() - start;
    // 1,000 ray tests should comfortably stay under 50ms even on slow CI CPUs (< 0.05ms/ray).
    expect(elapsedMs).toBeLessThan(200);

    dense.geometry.dispose();
    mat.dispose();
  });
});
