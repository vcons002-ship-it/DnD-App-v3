import { describe, expect, it } from 'vitest';
import {
  computeDesktopFloatingMenuPosition,
  inflateRect,
  rectOverlapArea,
  segmentIntersectsRect,
  type ScreenRect,
} from './floatingMenuPlacement.js';

const rect = (left: number, top: number, right: number, bottom: number): ScreenRect => ({
  left,
  top,
  right,
  bottom,
});

const menuRect = (pos: { left: number; top: number }, w: number, h: number): ScreenRect => ({
  left: pos.left,
  top: pos.top,
  right: pos.left + w,
  bottom: pos.top + h,
});

describe('computeDesktopFloatingMenuPosition', () => {
  const viewport = { vw: 1600, vh: 960, safeTop: 54, margin: 8 };

  it('places the menu cleanly beside the target token without overlapping its rect', () => {
    const target = rect(700, 400, 820, 540);
    const pos = computeDesktopFloatingMenuPosition({
      anchorX: 760,
      anchorY: 460,
      menuWidth: 260,
      menuHeight: 360,
      targetRect: target,
      attackerRect: null,
      viewport,
    });
    const m = menuRect(pos, 260, 360);
    expect(rectOverlapArea(m, inflateRect(target, 10))).toBe(0);
    expect(m.left).toBeGreaterThanOrEqual(viewport.margin);
    expect(m.top).toBeGreaterThanOrEqual(viewport.safeTop);
    expect(m.right).toBeLessThanOrEqual(viewport.vw - viewport.margin);
    expect(m.bottom).toBeLessThanOrEqual(viewport.vh - viewport.margin);
  });

  it('avoids both adjacent melee attacker and target tokens', () => {
    // Attacker directly to the right of the target (typical melee adjacency).
    const target = rect(640, 420, 740, 540);
    const attacker = rect(748, 420, 848, 540);
    const pos = computeDesktopFloatingMenuPosition({
      anchorX: 690,
      anchorY: 470,
      menuWidth: 260,
      menuHeight: 380,
      targetRect: target,
      attackerRect: attacker,
      viewport,
    });
    const m = menuRect(pos, 260, 380);
    expect(rectOverlapArea(m, target)).toBe(0);
    expect(rectOverlapArea(m, attacker)).toBe(0);
  });

  it('clears the full screen bounds of a large zoomed-in miniature', () => {
    const dragon = rect(900, 260, 1260, 660);
    const pos = computeDesktopFloatingMenuPosition({
      anchorX: 1080,
      anchorY: 450,
      menuWidth: 280,
      menuHeight: 400,
      targetRect: dragon,
      attackerRect: rect(580, 420, 680, 540),
      viewport,
    });
    const m = menuRect(pos, 280, 400);
    expect(rectOverlapArea(m, dragon)).toBe(0);
  });

  it('avoids crossing the attacker-to-target tether or nearby tokens when open space exists', () => {
    const attacker = rect(500, 440, 580, 540);
    const target = rect(900, 440, 980, 540);
    const blockerRight = rect(990, 420, 1180, 620);
    const pos = computeDesktopFloatingMenuPosition({
      anchorX: 940,
      anchorY: 480,
      menuWidth: 260,
      menuHeight: 340,
      targetRect: target,
      attackerRect: attacker,
      otherTokenRects: [blockerRight],
      viewport,
    });
    const m = menuRect(pos, 260, 340);
    expect(rectOverlapArea(m, target)).toBe(0);
    expect(rectOverlapArea(m, attacker)).toBe(0);
    expect(rectOverlapArea(m, blockerRight)).toBe(0);
    expect(segmentIntersectsRect(540, 490, 940, 490, m)).toBe(false);
  });

  it('stays clamped inside safe viewport margins near corners', () => {
    const cornerTarget = rect(1480, 20, 1590, 110);
    const pos = computeDesktopFloatingMenuPosition({
      anchorX: 1540,
      anchorY: 60,
      menuWidth: 280,
      menuHeight: 420,
      targetRect: cornerTarget,
      attackerRect: null,
      viewport,
    });
    const m = menuRect(pos, 280, 420);
    expect(rectOverlapArea(m, cornerTarget)).toBe(0);
    expect(m.left).toBeGreaterThanOrEqual(viewport.margin);
    expect(m.top).toBeGreaterThanOrEqual(viewport.safeTop);
    expect(m.right).toBeLessThanOrEqual(viewport.vw - viewport.margin);
    expect(m.bottom).toBeLessThanOrEqual(viewport.vh - viewport.margin);
  });
});
