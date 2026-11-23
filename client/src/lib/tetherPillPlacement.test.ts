import { describe, expect, it } from 'vitest';
import {
  computeTetherPillMetrics,
  computeTetherPillPlacement,
  evalTetherQuadraticBezier,
  TETHER_PILL_MAX_MAP_FONT_FT,
  TETHER_PILL_MAX_SCREEN_FONT_PX,
  TETHER_PILL_MIN_SCREEN_FONT_PX,
  type TetherBezier,
  type TetherObstacleToken,
} from './tetherPillPlacement';

function makeBezierBetween(
  a: { x: number; y: number; widthFt: number },
  b: { x: number; y: number; widthFt: number },
  pxPerFoot: number,
  scale: number,
): TetherBezier {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dist = Math.hypot(dx, dy) || 1;
  const ux = dx / dist;
  const uy = dy / dist;
  const nx = -uy;
  const ny = ux;
  const ar = (a.widthFt * pxPerFoot) / 2;
  const br = (b.widthFt * pxPerFoot) / 2;
  const sx = a.x + ux * Math.min(ar * 1.05, dist * 0.42);
  const sy = a.y + uy * Math.min(ar * 1.05, dist * 0.42);
  const ex = b.x - ux * Math.min(br + 8.5 / scale, dist * 0.42);
  const ey = b.y - uy * Math.min(br + 8.5 / scale, dist * 0.42);
  const spread = Math.min(30 / scale, Math.max(15 / scale, dist * 0.16)) * 0.35;
  return {
    sx,
    sy,
    cx: (sx + ex) / 2 + nx * spread,
    cy: (sy + ey) / 2 + ny * spread,
    ex,
    ey,
  };
}

function pillClearOfObstacles(
  res: { x: number; y: number },
  pillW: number,
  pillH: number,
  pxPerFoot: number,
  obstacles: readonly TetherObstacleToken[],
  tiltDegrees = 0,
  rotationDegrees = 0,
): boolean {
  const tiltRad = (tiltDegrees * Math.PI) / 180;
  const sy = Math.max(0.25, Math.cos(tiltRad));
  const sinTilt = Math.max(0, Math.sin(tiltRad));
  const rotRad = (rotationDegrees * Math.PI) / 180;
  const cosR = Math.cos(rotRad);
  const sinR = Math.sin(rotRad);
  const toUV = (x: number, y: number) => ({
    u: cosR * x - sinR * y,
    v: (sinR * x + cosR * y) * sy,
  });

  const pUV = toUV(res.x, res.y);
  const minU = pUV.u - pillW / 2;
  const maxU = pUV.u + pillW / 2;
  const minV = pUV.v - pillH / 2;
  const maxV = pUV.v + pillH / 2;

  for (const obs of obstacles) {
    const tUV = toUV(obs.x, obs.y);
    const r = (obs.baseWidthFt * pxPerFoot) / 2;
    const cu = Math.max(minU, Math.min(maxU, tUV.u));
    const cv = Math.max(minV, Math.min(maxV, tUV.v));
    if (Math.hypot((cu - tUV.u) / r, (cv - tUV.v) / (r * sy)) < 1) {
      return false;
    }

    const hudHalfW = Math.max(r * 0.78, Math.min(40, Math.max(22, r * 0.75)));
    if (
      Math.min(maxU, tUV.u + hudHalfW) > Math.max(minU, tUV.u - hudHalfW) &&
      Math.min(maxV, tUV.v + (r + 28) * sy) > Math.max(minV, tUV.v)
    ) {
      return false;
    }

    if (obs.is3d && sinTilt > 0.01) {
      const bodyHalfW = r * 0.75;
      if (
        Math.min(maxU, tUV.u + bodyHalfW) > Math.max(minU, tUV.u - bodyHalfW) &&
        Math.min(maxV, tUV.v) > Math.max(minV, tUV.v - 2.35 * r * sinTilt)
      ) {
        return false;
      }
    }
  }
  return true;
}

function minDistanceToBezier(curve: TetherBezier, pt: { x: number; y: number }): number {
  let best = Infinity;
  for (let i = 0; i <= 100; i++) {
    const c = evalTetherQuadraticBezier(curve, i / 100);
    const d = Math.hypot(c.x - pt.x, c.y - pt.y);
    if (d < best) best = d;
  }
  return best;
}

describe('computeTetherPillMetrics', () => {
  const pxPerFoot = 12.8;

  it('clamps screen size between min and max bounds across zoom levels', () => {
    const moderateZoomOut = computeTetherPillMetrics('30 ft', pxPerFoot, 0.7);
    expect(moderateZoomOut.fontSize * 0.7).toBeGreaterThanOrEqual(TETHER_PILL_MIN_SCREEN_FONT_PX - 1e-6);
    expect(moderateZoomOut.fontSize * 0.7).toBeLessThanOrEqual(TETHER_PILL_MAX_SCREEN_FONT_PX + 1e-6);

    const zoomedIn = computeTetherPillMetrics('30 ft', pxPerFoot, 3.0);
    expect(zoomedIn.fontSize * 3.0).toBeLessThanOrEqual(TETHER_PILL_MAX_SCREEN_FONT_PX + 1e-6);
    expect(zoomedIn.fontSize * 3.0).toBeGreaterThanOrEqual(TETHER_PILL_MIN_SCREEN_FONT_PX - 1e-6);
  });

  it('caps map-space size at extreme zoom-out and small grids so it never overwhelms tokens', () => {
    const farZoomOut = computeTetherPillMetrics('85 ft · Long', pxPerFoot, 0.2);
    expect(farZoomOut.fontSize).toBeLessThanOrEqual(pxPerFoot * TETHER_PILL_MAX_MAP_FONT_FT + 1e-6);
    expect(farZoomOut.pillH).toBeLessThan(3 * pxPerFoot);

    const smallGrid = computeTetherPillMetrics('30 ft', 3.2, 0.25);
    expect(smallGrid.fontSize).toBeLessThanOrEqual(3.2 * TETHER_PILL_MAX_MAP_FONT_FT + 1e-6);
    expect(smallGrid.pillH).toBeLessThan(3 * 3.2);
  });
});

describe('computeTetherPillPlacement', () => {
  const pxPerFoot = 12.8; // 64px / 5ft square

  it('keeps the pill on the Bezier midpoint when ranged shot has clear space', () => {
    const a = { id: 'a', x: 0, y: 0, baseWidthFt: 5 };
    const b = { id: 'b', x: 30 * pxPerFoot, y: 0, baseWidthFt: 5 };
    const curve = makeBezierBetween(
      { x: a.x, y: a.y, widthFt: a.baseWidthFt },
      { x: b.x, y: b.y, widthFt: b.baseWidthFt },
      pxPerFoot,
      1,
    );
    const res = computeTetherPillPlacement({
      curve,
      pillW: 52,
      pillH: 19,
      pxPerFoot,
      scale: 1,
      obstacles: [a, b],
    });
    const mid = evalTetherQuadraticBezier(curve, 0.5);
    expect(res.showLeader).toBe(false);
    expect(res.overlaps2dToken).toBe(false);
    expect(res.x).toBeCloseTo(mid.x, 4);
    expect(res.y).toBeCloseTo(mid.y, 4);
    expect(pillClearOfObstacles(res, 52, 19, pxPerFoot, [a, b])).toBe(true);
  });

  it('keeps melee / reach labels on the tether midpoint without detaching or drawing leader lines', () => {
    const scale = 1;
    const pillW = 68;
    const pillH = 19;
    const cases: [{ x: number; y: number }, { x: number; y: number }][] = [
      [{ x: 100, y: 100 }, { x: 100 + 5 * pxPerFoot, y: 100 }], // horizontal 5 ft
      [{ x: 100, y: 100 }, { x: 100, y: 100 + 5 * pxPerFoot }], // vertical 5 ft
      [{ x: 100, y: 100 }, { x: 100 + 5 * pxPerFoot, y: 100 + 5 * pxPerFoot }], // diagonal 5 ft
      [{ x: 100, y: 100 }, { x: 100 + 10 * pxPerFoot, y: 100 }], // 10 ft reach
    ];

    for (const [pa, pb] of cases) {
      const a: TetherObstacleToken = { id: 'a', x: pa.x, y: pa.y, baseWidthFt: 5, is3d: false };
      const b: TetherObstacleToken = { id: 'b', x: pb.x, y: pb.y, baseWidthFt: 5, is3d: false };
      const curve = makeBezierBetween(
        { x: a.x, y: a.y, widthFt: a.baseWidthFt },
        { x: b.x, y: b.y, widthFt: b.baseWidthFt },
        pxPerFoot,
        scale,
      );
      const mid = evalTetherQuadraticBezier(curve, 0.5);
      const res = computeTetherPillPlacement({
        curve,
        pillW,
        pillH,
        pxPerFoot,
        scale,
        obstacles: [a, b],
      });
      expect(res.showLeader).toBe(false);
      expect(res.x).toBeCloseTo(mid.x, 4);
      expect(res.y).toBeCloseTo(mid.y, 4);
      expect(res.anchorX).toBeCloseTo(mid.x, 4);
      expect(res.anchorY).toBeCloseTo(mid.y, 4);
      expect(res.overlaps2dToken).toBe(true);
    }
  });

  it('slides along the curve without a leader line when a bystander stands on the midpoint of a long tether', () => {
    const a: TetherObstacleToken = { id: 'a', x: 0, y: 0, baseWidthFt: 5 };
    const b: TetherObstacleToken = { id: 'b', x: 40 * pxPerFoot, y: 0, baseWidthFt: 5 };
    const curve = makeBezierBetween(
      { x: a.x, y: a.y, widthFt: a.baseWidthFt },
      { x: b.x, y: b.y, widthFt: b.baseWidthFt },
      pxPerFoot,
      1,
    );
    const mid = evalTetherQuadraticBezier(curve, 0.5);
    const midBlocker: TetherObstacleToken = {
      id: 'mid',
      x: mid.x,
      y: mid.y,
      baseWidthFt: 5,
    };

    const res = computeTetherPillPlacement({
      curve,
      pillW: 54,
      pillH: 19,
      pxPerFoot,
      scale: 1,
      obstacles: [a, b, midBlocker],
    });
    expect(res.showLeader).toBe(false);
    expect(res.overlaps2dToken).toBe(false);
    expect(minDistanceToBezier(curve, res)).toBeLessThan(1e-6);
    expect(Math.abs(res.x - mid.x)).toBeGreaterThan(20);
    expect(pillClearOfObstacles(res, 54, 19, pxPerFoot, [a, b, midBlocker])).toBe(true);
  });

  it('flags overlaps2dToken false for 3D-only obstacles in crowded melee and tilted camera views', () => {
    const tiltDegrees = 45;
    const rotationDegrees = 90;
    const a: TetherObstacleToken = { id: 'a', x: 300, y: 300, baseWidthFt: 5, is3d: true };
    const b: TetherObstacleToken = {
      id: 'b',
      x: 300,
      y: 300 + 5 * pxPerFoot,
      baseWidthFt: 10,
      is3d: true,
    };
    const curve = makeBezierBetween(
      { x: a.x, y: a.y, widthFt: a.baseWidthFt },
      { x: b.x, y: b.y, widthFt: b.baseWidthFt },
      pxPerFoot,
      1,
    );
    const mid = evalTetherQuadraticBezier(curve, 0.5);
    const res = computeTetherPillPlacement({
      curve,
      pillW: 60,
      pillH: 19,
      pxPerFoot,
      scale: 1,
      tiltDegrees,
      rotationDegrees,
      obstacles: [a, b],
    });
    expect(res.showLeader).toBe(false);
    expect(res.x).toBeCloseTo(mid.x, 4);
    expect(res.y).toBeCloseTo(mid.y, 4);
    expect(res.overlaps2dToken).toBe(false);
  });
});
