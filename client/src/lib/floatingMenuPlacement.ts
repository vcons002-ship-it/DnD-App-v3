export type ScreenRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export type DesktopMenuPlacementInput = {
  anchorX: number;
  anchorY: number;
  menuWidth: number;
  menuHeight: number;
  targetRect: ScreenRect | null;
  attackerRect: ScreenRect | null;
  otherTokenRects?: readonly ScreenRect[];
  viewport: {
    vw: number;
    vh: number;
    safeTop: number;
    margin?: number;
  };
};

export function inflateRect(r: ScreenRect, pad: number): ScreenRect {
  return {
    left: r.left - pad,
    top: r.top - pad,
    right: r.right + pad,
    bottom: r.bottom + pad,
  };
}

export function rectOverlapArea(a: ScreenRect, b: ScreenRect): number {
  const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  if (ox <= 0) return 0;
  const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  if (oy <= 0) return 0;
  return ox * oy;
}

/** Check whether the segment from (ax, ay) to (bx, by) intersects rectangle `r`. */
export function segmentIntersectsRect(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  r: ScreenRect,
): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  let t0 = 0;
  let t1 = 1;
  const checks: [number, number][] = [
    [-dx, ax - r.left],
    [dx, r.right - ax],
    [-dy, ay - r.top],
    [dy, r.bottom - ay],
  ];
  for (const [p, q] of checks) {
    if (Math.abs(p) < 1e-8) {
      if (q < 0) return false;
    } else {
      const t = q / p;
      if (p < 0) {
        if (t > t1) return false;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return false;
        if (t < t1) t1 = t;
      }
    }
  }
  return t0 <= t1;
}

const rectCenterX = (r: ScreenRect) => (r.left + r.right) * 0.5;
const rectCenterY = (r: ScreenRect) => (r.top + r.bottom) * 0.5;

function clampCandidate(
  left: number,
  top: number,
  menuWidth: number,
  menuHeight: number,
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
): ScreenRect {
  const cx = Math.max(minX, Math.min(left, maxX));
  const cy = Math.max(minY, Math.min(top, maxY));
  return { left: cx, top: cy, right: cx + menuWidth, bottom: cy + menuHeight };
}

/**
 * Place the desktop floating action menu outside the screen bounding boxes of
 * both the right-clicked target token and the active attacking token, while
 * keeping it inside the safe viewport and near the target token when possible.
 */
export function computeDesktopFloatingMenuPosition(
  input: DesktopMenuPlacementInput,
): { left: number; top: number } {
  const {
    anchorX,
    anchorY,
    menuWidth,
    menuHeight,
    targetRect,
    attackerRect,
    otherTokenRects = [],
    viewport,
  } = input;
  const margin = viewport.margin ?? 8;
  const minX = margin;
  const maxX = Math.max(minX, viewport.vw - menuWidth - margin);
  const minY = Math.max(margin, viewport.safeTop);
  const maxY = Math.max(minY, viewport.vh - menuHeight - margin);
  const gap = 14;

  const fallbackTarget: ScreenRect = {
    left: anchorX - 24,
    top: anchorY - 24,
    right: anchorX + 24,
    bottom: anchorY + 24,
  };
  const t = targetRect ?? fallbackTarget;
  const unionBox: ScreenRect | null = attackerRect
    ? {
        left: Math.min(t.left, attackerRect.left),
        top: Math.min(t.top, attackerRect.top),
        right: Math.max(t.right, attackerRect.right),
        bottom: Math.max(t.bottom, attackerRect.bottom),
      }
    : null;

  const xs = [
    t.right + gap,
    t.left - gap - menuWidth,
    t.left,
    rectCenterX(t) - menuWidth * 0.5,
    t.right - menuWidth,
    minX,
    maxX,
  ];
  const ys = [
    t.top,
    rectCenterY(t) - menuHeight * 0.5,
    t.bottom - menuHeight,
    t.top - gap - menuHeight,
    t.bottom + gap,
    minY,
    maxY,
  ];

  if (attackerRect) {
    xs.push(attackerRect.left - gap - menuWidth, attackerRect.right + gap);
    ys.push(attackerRect.top - gap - menuHeight, attackerRect.bottom + gap);
  }
  if (unionBox) {
    xs.push(
      unionBox.right + gap,
      unionBox.left - gap - menuWidth,
      unionBox.left,
      rectCenterX(unionBox) - menuWidth * 0.5,
      unionBox.right - menuWidth,
    );
    ys.push(
      unionBox.top,
      rectCenterY(unionBox) - menuHeight * 0.5,
      unionBox.bottom - menuHeight,
      unionBox.top - gap - menuHeight,
      unionBox.bottom + gap,
    );
  }

  const seen = new Set<string>();
  const candidates: ScreenRect[] = [];
  const push = (left: number, top: number) => {
    const r = clampCandidate(left, top, menuWidth, menuHeight, minX, maxX, minY, maxY);
    const key = `${Math.round(r.left)}:${Math.round(r.top)}`;
    if (!seen.has(key)) {
      seen.add(key);
      candidates.push(r);
    }
  };

  for (const x of xs) {
    for (const y of ys) {
      push(x, y);
    }
  }
  // Coarse viewport grid fallback ensures clear space is found even at extreme zoom.
  for (let gx = 0; gx <= 4; gx++) {
    for (let gy = 0; gy <= 3; gy++) {
      push(minX + ((maxX - minX) * gx) / 4, minY + ((maxY - minY) * gy) / 3);
    }
  }

  const targetPadded = targetRect ? inflateRect(targetRect, 10) : null;
  const attackerPadded = attackerRect ? inflateRect(attackerRect, 10) : null;
  const otherPadded = otherTokenRects.map((r) => inflateRect(r, 4));
  const tCx = rectCenterX(t);
  const tCy = rectCenterY(t);
  const aCx = attackerRect ? rectCenterX(attackerRect) : 0;
  const aCy = attackerRect ? rectCenterY(attackerRect) : 0;

  let best = candidates[0];
  let bestCost = Infinity;

  for (const m of candidates) {
    const targetHard = targetRect ? rectOverlapArea(m, targetRect) : 0;
    const attackerHard = attackerRect ? rectOverlapArea(m, attackerRect) : 0;
    const targetPad = targetPadded ? rectOverlapArea(m, targetPadded) : 0;
    const attackerPad = attackerPadded ? rectOverlapArea(m, attackerPadded) : 0;
    const tetherCross =
      targetRect && attackerRect && segmentIntersectsRect(aCx, aCy, tCx, tCy, m) ? 1 : 0;
    let otherOverlap = 0;
    for (let i = 0; i < otherPadded.length; i++) {
      otherOverlap += rectOverlapArea(m, otherPadded[i]);
    }
    const dist = Math.hypot(rectCenterX(m) - tCx, rectCenterY(m) - tCy);
    const cost =
      (targetHard + attackerHard) * 1_000_000 +
      (targetPad + attackerPad) * 10_000 +
      tetherCross * 50_000 +
      otherOverlap * 25 +
      dist * 2;
    if (cost < bestCost) {
      bestCost = cost;
      best = m;
    }
  }

  return { left: Math.round(best.left), top: Math.round(best.top) };
}
