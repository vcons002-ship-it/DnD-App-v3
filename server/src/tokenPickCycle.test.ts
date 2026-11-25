import { describe, it, expect } from 'vitest';
import {
  nextCycledTokenId,
  orderedCycleTokenIds,
  resolveStackClick,
} from '../../client/src/lib/tokenPickCycle.js';

describe('tokenPickCycle', () => {
  it('cycles forward and backward through a stack with wrap-around', () => {
    const stack = ['front', 'mid', 'back'];
    expect(nextCycledTokenId(stack, null)).toBe('front');
    expect(nextCycledTokenId(stack, 'front')).toBe('mid');
    expect(nextCycledTokenId(stack, 'mid')).toBe('back');
    expect(nextCycledTokenId(stack, 'back')).toBe('front');
    expect(nextCycledTokenId(stack, 'front', true)).toBe('back');
    expect(nextCycledTokenId(stack, 'back', true)).toBe('mid');
    expect(nextCycledTokenId(stack, 'other')).toBe('front');
  });

  it('picks frontmost on first click and cycles behind on repeated click at the same spot', () => {
    const stack = ['druk', 'dp2', 'orc'];
    const first = resolveStackClick({
      stack,
      currentSelectedIds: [],
      clientX: 400,
      clientY: 300,
      previousClick: null,
    });
    expect(first.tokenId).toBe('druk');

    const second = resolveStackClick({
      stack,
      currentSelectedIds: ['druk'],
      clientX: 402,
      clientY: 301,
      previousClick: first.nextClick,
    });
    expect(second.tokenId).toBe('dp2');

    const third = resolveStackClick({
      stack,
      currentSelectedIds: ['dp2'],
      clientX: 401,
      clientY: 300,
      previousClick: second.nextClick,
    });
    expect(third.tokenId).toBe('orc');

    // Moving cursor away resets to frontmost pick.
    const moved = resolveStackClick({
      stack,
      currentSelectedIds: ['orc'],
      clientX: 440,
      clientY: 300,
      previousClick: third.nextClick,
    });
    expect(moved.tokenId).toBe('druk');
  });

  it('orders global Tab cycling by initiative order first, preferring living creatures', () => {
    const ids = orderedCycleTokenIds([
      { id: 'chest', x: 0, y: 0, isObject: true },
      { id: 'dead-gob', x: 10, y: 10, isDead: true },
      { id: 'varis', x: 100, y: 200, initiativeRank: 4 },
      { id: 'orc', x: 100, y: 100, initiativeRank: 1 },
      { id: 'unrolled', x: 50, y: 50 },
    ]);
    expect(ids).toEqual(['orc', 'varis', 'unrolled']);
  });
});
