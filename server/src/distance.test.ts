import { describe, it, expect } from 'vitest';
import {
  DISTANCE_TOLERANCE_FT,
  tokenDistanceFt,
  tokensWithin5ft,
  tokensWithinDistanceFt,
  withinDistanceFt,
} from '../../shared/distance.js';

// A standard map: a 50-px grid cell = 5 ft (0.1 ft/px).
const map = { feetPerSquare: 5, gridSizePx: 50 } as const;
const tok = (x: number, y: number, widthFt = 5) => ({ x, y, widthFt });

describe('tokenDistanceFt / tokensWithin5ft', () => {
  it('orthogonally adjacent tokens are 5 ft apart (within reach)', () => {
    expect(tokenDistanceFt(tok(0, 0), tok(50, 0), map)).toBeCloseTo(5);
    expect(tokensWithin5ft(tok(0, 0), tok(50, 0), map)).toBe(true);
  });

  it('a diagonal counts as one square (5 ft), still within reach', () => {
    expect(tokenDistanceFt(tok(0, 0), tok(50, 50), map)).toBeCloseTo(5);
    expect(tokensWithin5ft(tok(0, 0), tok(50, 50), map)).toBe(true);
  });

  it('one empty square between (10 ft) is NOT within 5 ft', () => {
    expect(tokenDistanceFt(tok(0, 0), tok(100, 0), map)).toBeCloseTo(10);
    expect(tokensWithin5ft(tok(0, 0), tok(100, 0), map)).toBe(false);
  });

  it('a Large creature (10-ft footprint) reaches one square further', () => {
    // Large at origin, target 1.5 cells away → 7.5 ft center, minus 2.5 ft reach = 5.
    expect(tokensWithin5ft(tok(0, 0, 10), tok(75, 0, 5), map)).toBe(true);
  });

  it('overlapping tokens are 0 ft apart', () => {
    expect(tokenDistanceFt(tok(20, 20), tok(20, 20), map)).toBe(0);
  });

  it('measures from enlarged miniatureWidthFt edge when larger than widthFt without shrinking smaller bases', () => {
    const medium = tok(1963.2, 622.6, 5);
    const enlargedDragon = { x: 1924.6, y: 633.7, widthFt: 7.5, miniatureWidthFt: 13.5 };
    const halfGridMap = { feetPerSquare: 5, gridSizePx: 25 } as const;
    expect(tokenDistanceFt(medium, enlargedDragon, halfGridMap)).toBeLessThanOrEqual(5);
    expect(tokensWithin5ft(medium, enlargedDragon, halfGridMap)).toBe(true);

    const smallerMini = { x: 100, y: 0, widthFt: 10, miniatureWidthFt: 4 };
    expect(tokenDistanceFt(tok(0, 0, 5), smallerMini, map)).toBeCloseTo(7.5);
  });

  it('keeps widthFt=0 point queries centered regardless of miniatureWidthFt', () => {
    const pointCaster = { x: 0, y: 0, widthFt: 0, miniatureWidthFt: 13.5 };
    expect(tokenDistanceFt(pointCaster, { x: 100, y: 0, widthFt: 0, miniatureWidthFt: 13.5 }, map)).toBeCloseTo(10);
  });

  it('forgives slightly inexact placements up to DISTANCE_TOLERANCE_FT without accepting far tokens', () => {
    expect(DISTANCE_TOLERANCE_FT).toBe(1.5);
    // 5.3 ft & 5.49 ft display as "5 ft" after rounding, and 6.2-6.5 ft are loose adjacent drops.
    expect(tokensWithin5ft(tok(0, 0), tok(53, 0), map)).toBe(true);
    expect(tokensWithin5ft(tok(0, 0), tok(54.9, 0), map)).toBe(true);
    expect(tokensWithin5ft(tok(0, 0), tok(62, 0), map)).toBe(true);
    expect(tokensWithin5ft(tok(0, 0), tok(65, 0), map)).toBe(true);
    expect(tokensWithin5ft(tok(0, 0), tok(70, 0), map)).toBe(false);
    expect(tokensWithin5ft(tok(0, 0), tok(100, 0), map)).toBe(false);

    // Generic ranged helper behaves identically for 30 ft and 60 ft thresholds.
    expect(withinDistanceFt(31.5, 30)).toBe(true);
    expect(withinDistanceFt(32, 30)).toBe(false);
    expect(tokensWithinDistanceFt(tok(0, 0), tok(612, 0), 60, map)).toBe(true);
    expect(tokensWithinDistanceFt(tok(0, 0), tok(620, 0), 60, map)).toBe(false);
  });
});
