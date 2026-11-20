import { describe, expect, it } from 'vitest';
import {
  computeTetherPillPlacement,
  evalTetherQuadraticBezier,
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
    expect(res.x).toBeCloseTo(mid.x, 4);
    expect(res.y).toBeCloseTo(mid.y, 4);
    expect(pillClearOfObstacles(res, 52, 19, pxPerFoot, [a, b])).toBe(true);
  });

  it('pushes wide melee / reach distance labels clear of adjacent tokens in horizontal, vertical, and diagonal setups', () => {
    const scale = 1;
    const pillW = 92; // e.g. "5 ft · Disadv"
    const pillH = 19;
    const cases: [{ x: number; y: number }, { x: number; y: number }][] = [
      [{ x: 100, y: 100 }, { x: 100 + 5 * pxPerFoot, y: 100 }], // horizontal 5 ft
      [{ x: 100, y: 100 }, { x: 100, y: 100 + 5 * pxPerFoot }], // vertical 5 ft
      [{ x: 100, y: 100 }, { x: 100 + 5 * pxPerFoot, y: 100 + 5 * pxPerFoot }], // diagonal 5 ft
      [{ x: 100, y: 100 }, { x: 100 + 10 * pxPerFoot, y: 100 }], // 10 ft reach
    ];

    for (const [pa, pb] of cases) {
      const a: TetherObstacleToken = { id: 'a', x: pa.x, y: pa.y, baseWidthFt: 5 };
      const b: TetherObstacleToken = { id: 'b', x: pb.x, y: pb.y, baseWidthFt: 5 };
      const curve = makeBezierBetween(
        { x: a.x, y: a.y, widthFt: a.baseWidthFt },
        { x: b.x, y: b.y, widthFt: b.baseWidthFt },
        pxPerFoot,
        scale,
      );
      const res = computeTetherPillPlacement({
        curve,
        pillW,
        pillH,
        pxPerFoot,
        scale,
        obstacles: [a, b],
      });
      expect(res.showLeader).toBe(true);
      expect(pillClearOfObstacles(res, pillW, pillH, pxPerFoot, [a, b])).toBe(true);
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
    expect(Math.abs(res.x - mid.x)).toBeGreaterThan(20);
    expect(pillClearOfObstacles(res, 54, 19, pxPerFoot, [a, b, midBlocker])).toBe(true);
  });

  it('finds an unobstructed diagonal/opposite pocket in a crowded melee scrum', () => {
    const a: TetherObstacleToken = { id: 'a', x: 200, y: 200, baseWidthFt: 5 };
    const b: TetherObstacleToken = { id: 'b', x: 200 + 5 * pxPerFoot, y: 200, baseWidthFt: 5 };
    // Block directly above the seam between a and b so the pill must find an open pocket
    const topBlocker: TetherObstacleToken = {
      id: 'c',
      x: 200 + 2.5 * pxPerFoot,
      y: 200 - 5 * pxPerFoot,
      baseWidthFt: 5,
    };
    const rightFlank: TetherObstacleToken = {
      id: 'd',
      x: 200 + 5 * pxPerFoot,
      y: 200 - 5 * pxPerFoot,
      baseWidthFt: 5,
    };
    const obstacles = [a, b, topBlocker, rightFlank];
    const curve = makeBezierBetween(
      { x: a.x, y: a.y, widthFt: a.baseWidthFt },
      { x: b.x, y: b.y, widthFt: b.baseWidthFt },
      pxPerFoot,
      1,
    );

    const pillW = 68;
    const pillH = 19;
    const res = computeTetherPillPlacement({
      curve,
      pillW,
      pillH,
      pxPerFoot,
      scale: 1,
      obstacles,
    });
    expect(res.showLeader).toBe(true);
    expect(pillClearOfObstacles(res, pillW, pillH, pxPerFoot, obstacles)).toBe(true);
  });

  it('clears standing 3D miniature silhouettes under tilted and rotated camera projection', () => {
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
    const pillW = 76;
    const pillH = 19;
    const res = computeTetherPillPlacement({
      curve,
      pillW,
      pillH,
      pxPerFoot,
      scale: 1,
      tiltDegrees,
      rotationDegrees,
      obstacles: [a, b],
    });
    expect(res.showLeader).toBe(true);
    expect(
      pillClearOfObstacles(res, pillW, pillH, pxPerFoot, [a, b], tiltDegrees, rotationDegrees),
    ).toBe(true);
  });
});
