import { describe, expect, it } from 'vitest';
import {
  TOKEN_MOVE_FEET_PER_SECOND,
  TOKEN_MOVE_MAX_MS,
  TOKEN_MOVE_MIN_MS,
  tokenMoveDuration,
  tokenMoveProgress,
} from '../../client/src/canvas/tokenMotion.js';

describe('tokenMotion', () => {
  it('scales walk duration from feet per second and clamps extremes', () => {
    const pxPerFoot = 10; // 50 px per 5 ft square
    expect(tokenMoveDuration(0, pxPerFoot)).toBe(0);
    expect(tokenMoveDuration(5 * pxPerFoot, pxPerFoot)).toBe(
      Math.round((5 / TOKEN_MOVE_FEET_PER_SECOND) * 1000),
    );
    expect(tokenMoveDuration(15 * pxPerFoot, pxPerFoot)).toBe(500);
    expect(tokenMoveDuration(30 * pxPerFoot, pxPerFoot)).toBe(1000);
    expect(tokenMoveDuration(60 * pxPerFoot, pxPerFoot)).toBe(2000);
    expect(tokenMoveDuration(120 * pxPerFoot, pxPerFoot)).toBe(4000);
    // Tiny nudges keep a brief smooth minimum instead of an instant pop.
    expect(tokenMoveDuration(0.5 * pxPerFoot, pxPerFoot)).toBe(TOKEN_MOVE_MIN_MS);
    // Giant cross-map drags cap so exploration isn't stuck forever.
    expect(tokenMoveDuration(200 * pxPerFoot, pxPerFoot)).toBe(TOKEN_MOVE_MAX_MS);
  });

  it('starts moving promptly without stalling at t=0 and stays monotonic and symmetric', () => {
    expect(tokenMoveProgress(0, 3000)).toBe(0);
    expect(tokenMoveProgress(1500, 3000)).toBeCloseTo(0.5, 10);
    expect(tokenMoveProgress(3000, 3000)).toBe(1);

    // First frame (16 ms) should make real visible progress rather than near-zero cubic stall.
    const smoothstepFirstFrame = (() => {
      const t = 16 / 2500;
      return t * t * (3 - 2 * t);
    })();
    expect(tokenMoveProgress(16, 2500)).toBeGreaterThan(smoothstepFirstFrame * 10);

    let prev = 0;
    for (let i = 1; i <= 100; i++) {
      const u = i / 100;
      const p = tokenMoveProgress(u, 1);
      expect(p).toBeGreaterThan(prev);
      expect(p + tokenMoveProgress(1 - u, 1)).toBeCloseTo(1, 10);
      prev = p;
    }
  });
});
