export type TetherObstacleToken = {
  id: string;
  x: number;
  y: number;
  baseWidthFt: number;
  is3d?: boolean;
};

export type TetherBezier = {
  sx: number;
  sy: number;
  cx: number;
  cy: number;
  ex: number;
  ey: number;
};

export type TetherPillPlacementInput = {
  curve: TetherBezier;
  /** Pill width in map-space units (`rawScreenWidth / scale`). */
  pillW: number;
  /** Pill height in map-space units (`rawScreenHeight / scale`). */
  pillH: number;
  pxPerFoot: number;
  scale: number;
  tiltDegrees?: number;
  rotationDegrees?: number;
  obstacles: readonly TetherObstacleToken[];
  prevOffsetUV?: { du: number; dv: number } | null;
};

export const TETHER_PILL_MIN_SCREEN_FONT_PX = 8.5;
export const TETHER_PILL_MAX_SCREEN_FONT_PX = 12.5;
export const TETHER_PILL_IDEAL_MAP_FONT_FT = 1.0;
export const TETHER_PILL_MAX_MAP_FONT_FT = 1.6;
export const TETHER_PILL_COVERED_OPACITY = 0.22;

export type TetherPillMetrics = {
  fontSize: number;
  pillW: number;
  pillH: number;
  strokeWidth: number;
};

/**
 * Bounded pill typography in map coordinates: keeps a readable min/max screen
 * pixel height across normal zoom levels while capping map-space size so
 * zooming far out never blows the pill up across tokens or rooms.
 */
export function computeTetherPillMetrics(
  label: string,
  pxPerFoot: number,
  scale: number,
): TetherPillMetrics {
  const safeScale = Math.max(0.05, scale || 1);
  const safePpf = Math.max(1, pxPerFoot || 10);
  const idealMapFont = safePpf * TETHER_PILL_IDEAL_MAP_FONT_FT;
  const screenClampedFont =
    Math.min(
      TETHER_PILL_MAX_SCREEN_FONT_PX,
      Math.max(TETHER_PILL_MIN_SCREEN_FONT_PX, idealMapFont * safeScale),
    ) / safeScale;
  const fontSize = Math.min(safePpf * TETHER_PILL_MAX_MAP_FONT_FT, screenClampedFont);
  const pillH = fontSize * 1.55;
  const pillW = Math.max(fontSize * 3.0, label.length * fontSize * 0.62 + fontSize * 1.0);
  const strokeWidth = Math.max(0.6 / safeScale, fontSize * 0.095);
  return { fontSize, pillW, pillH, strokeWidth };
}

export type TetherPillPlacementResult = {
  /** Pill center in map coordinates. */
  x: number;
  /** Pill center in map coordinates. */
  y: number;
  /** Curve point in map coordinates (kept equal to pill position; never detaches). */
  anchorX: number;
  anchorY: number;
  showLeader: boolean;
  offsetUV: { du: number; dv: number };
  /** True when placed over a flat 2D token/HUD so Konva can dim it softly. */
  overlaps2dToken: boolean;
};

export function evalTetherQuadraticBezier(
  curve: TetherBezier,
  t: number,
): { x: number; y: number } {
  const inv = 1 - t;
  return {
    x: inv * inv * curve.sx + 2 * inv * t * curve.cx + t * t * curve.ex,
    y: inv * inv * curve.sy + 2 * inv * t * curve.cy + t * t * curve.ey,
  };
}

type UVObstacleEnvelope = {
  tu: number;
  tv: number;
  rx: number;
  ry: number;
  hudMinU: number;
  hudMaxU: number;
  hudMinV: number;
  hudMaxV: number;
  bodyMinU: number;
  bodyMaxU: number;
  bodyMinV: number;
  bodyMaxV: number;
  hasBody: boolean;
  is3d: boolean;
};

function rectOverlapArea(
  ax0: number,
  ay0: number,
  ax1: number,
  ay1: number,
  bx0: number,
  by0: number,
  bx1: number,
  by1: number,
): number {
  const ox = Math.min(ax1, bx1) - Math.max(ax0, bx0);
  if (ox <= 0) return 0;
  const oy = Math.min(ay1, by1) - Math.max(ay0, by0);
  if (oy <= 0) return 0;
  return ox * oy;
}

/**
 * Overlap score between an axis-aligned pill rectangle centered at `(pu, pv)`
 * in the camera-upright `(u, v)` frame and all visible token envelopes
 * (token base ellipse, below-base HP/nameplate HUD, and standing 3D figure).
 */
function measureTotalOverlap(
  pu: number,
  pv: number,
  hw: number,
  hh: number,
  envelopes: readonly UVObstacleEnvelope[],
): number {
  const pMinU = pu - hw;
  const pMaxU = pu + hw;
  const pMinV = pv - hh;
  const pMaxV = pv + hh;
  let total = 0;

  for (let i = 0; i < envelopes.length; i++) {
    const e = envelopes[i];
    const cu = Math.max(pMinU, Math.min(pMaxU, e.tu));
    const cv = Math.max(pMinV, Math.min(pMaxV, e.tv));
    const nd = Math.hypot((cu - e.tu) / e.rx, (cv - e.tv) / e.ry);
    if (nd < 1) {
      total += (1 - nd) * e.rx * e.ry;
    }

    const hudArea = rectOverlapArea(
      pMinU,
      pMinV,
      pMaxU,
      pMaxV,
      e.hudMinU,
      e.hudMinV,
      e.hudMaxU,
      e.hudMaxV,
    );
    if (hudArea > 0) total += hudArea;

    if (e.hasBody) {
      const bodyArea = rectOverlapArea(
        pMinU,
        pMinV,
        pMaxU,
        pMaxV,
        e.bodyMinU,
        e.bodyMinV,
        e.bodyMaxU,
        e.bodyMaxV,
      );
      if (bodyArea > 0) total += bodyArea;
    }
  }
  return total;
}

const SLIDE_TS = [0.38, 0.62, 0.28, 0.72] as const;

/**
 * Place a tether's distance pill directly on the Bezier curve itself. When a
 * long ranged tether crosses a token at the midpoint, slide along open curve
 * spans; otherwise keep it centered on the tether (where depth-masking or
 * overlap dimming handles visual stacking cleanly without a leader line).
 */
export function computeTetherPillPlacement(
  input: TetherPillPlacementInput,
): TetherPillPlacementResult {
  const { curve, pillW, pillH, obstacles, prevOffsetUV } = input;
  const safeScale = Math.max(0.05, input.scale || 1);
  const safePpf = Math.max(1, input.pxPerFoot || 10);
  const tiltRad = ((input.tiltDegrees ?? 0) * Math.PI) / 180;
  const sy = Math.max(0.25, Math.cos(tiltRad));
  const sinTilt = Math.max(0, Math.sin(tiltRad));
  const rotRad = ((input.rotationDegrees ?? 0) * Math.PI) / 180;
  const cosR = Math.cos(rotRad);
  const sinR = Math.sin(rotRad);

  const toUV = (x: number, y: number) => ({
    u: cosR * x - sinR * y,
    v: (sinR * x + cosR * y) * sy,
  });

  const midMap = evalTetherQuadraticBezier(curve, 0.5);
  const midUV = toUV(midMap.x, midMap.y);

  if (!obstacles.length) {
    return {
      x: midMap.x,
      y: midMap.y,
      anchorX: midMap.x,
      anchorY: midMap.y,
      showLeader: false,
      offsetUV: { du: 0, dv: 0 },
      overlaps2dToken: false,
    };
  }

  const hw = pillW / 2;
  const hh = pillH / 2;
  const pad = 5 / safeScale;
  const envelopes: UVObstacleEnvelope[] = new Array(obstacles.length);

  for (let i = 0; i < obstacles.length; i++) {
    const obs = obstacles[i];
    const { u: tu, v: tv } = toUV(obs.x, obs.y);
    const r = Math.max(4 / safeScale, (obs.baseWidthFt * safePpf) / 2);
    const hudHalfW = Math.max(r * 0.78, Math.min(40, Math.max(22, r * 0.75))) + pad;
    const is3d = !!obs.is3d;
    const hasBody = is3d && sinTilt > 0.01;
    const bodyHalfW = r * 0.75 + pad;
    envelopes[i] = {
      tu,
      tv,
      rx: r + pad,
      ry: r * sy + pad,
      hudMinU: tu - hudHalfW,
      hudMaxU: tu + hudHalfW,
      hudMinV: tv,
      hudMaxV: tv + (r + 28) * sy + pad,
      bodyMinU: tu - bodyHalfW,
      bodyMaxU: tu + bodyHalfW,
      bodyMinV: tv - 2.35 * r * sinTilt - pad,
      bodyMaxV: tv,
      hasBody,
      is3d,
    };
  }

  const non3dEnvelopes = envelopes.filter((e) => !e.is3d);
  let chosenMap = midMap;
  let chosenUV = midUV;

  // Slide along the curve only when the midpoint overlaps and open beam span exists.
  const startUV = toUV(curve.sx, curve.sy);
  const endUV = toUV(curve.ex, curve.ey);
  const chordUV = Math.hypot(endUV.u - startUV.u, endUV.v - startUV.v);

  if (
    measureTotalOverlap(midUV.u, midUV.v, hw, hh, envelopes) > 0 &&
    chordUV >= pillW * 1.1
  ) {
    let bestSlide: {
      x: number;
      y: number;
      u: number;
      v: number;
      cost: number;
    } | null = null;
    for (let i = 0; i < SLIDE_TS.length; i++) {
      const t = SLIDE_TS[i];
      const pt = evalTetherQuadraticBezier(curve, t);
      const uv = toUV(pt.x, pt.y);
      if (measureTotalOverlap(uv.u, uv.v, hw, hh, envelopes) === 0) {
        const du = uv.u - midUV.u;
        const dv = uv.v - midUV.v;
        const prevPenalty = prevOffsetUV
          ? 0.2 * Math.hypot(du - prevOffsetUV.du, dv - prevOffsetUV.dv)
          : 0;
        const cost = Math.abs(t - 0.5) * chordUV + prevPenalty;
        if (!bestSlide || cost < bestSlide.cost) {
          bestSlide = { x: pt.x, y: pt.y, u: uv.u, v: uv.v, cost };
        }
      }
    }
    if (bestSlide) {
      chosenMap = { x: bestSlide.x, y: bestSlide.y };
      chosenUV = { u: bestSlide.u, v: bestSlide.v };
    }
  }

  const overlaps2dToken =
    non3dEnvelopes.length > 0 &&
    measureTotalOverlap(chosenUV.u, chosenUV.v, hw, hh, non3dEnvelopes) > 0;

  return {
    x: chosenMap.x,
    y: chosenMap.y,
    anchorX: chosenMap.x,
    anchorY: chosenMap.y,
    showLeader: false,
    offsetUV: { du: chosenUV.u - midUV.u, dv: chosenUV.v - midUV.v },
    overlaps2dToken,
  };
}
