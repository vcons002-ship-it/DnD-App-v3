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

export type TetherPillPlacementResult = {
  /** Pill center in map coordinates. */
  x: number;
  /** Pill center in map coordinates. */
  y: number;
  /** Curve point in map coordinates to anchor an optional dashed leader line. */
  anchorX: number;
  anchorY: number;
  showLeader: boolean;
  offsetUV: { du: number; dv: number };
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

const SLIDE_TS = [0.38, 0.62, 0.28, 0.72, 0.2, 0.8] as const;
const RADIAL_DEG_OFFSETS = [0, -28, 28, -55, 55, 180, 152, -152, 125, -125, -90, 90] as const;
const RADIAL_STEP_MULTIPLIERS = [1, 2, 3, 4, 5, 6.5, 8.5, 11, 14.5, 19] as const;

/**
 * Place a tether's midpoint range pill so it never draws on top of visible
 * tokens, their below-base HUDs, or tilted 3D miniatures while remaining anchored
 * as close to the tether midpoint as possible.
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
  const toXY = (u: number, v: number) => ({
    x: cosR * u + (sinR / sy) * v,
    y: -sinR * u + (cosR / sy) * v,
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
    const hasBody = !!obs.is3d && sinTilt > 0.01;
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
    };
  }

  // Tier 1: default curve midpoint has zero token overlap.
  if (measureTotalOverlap(midUV.u, midUV.v, hw, hh, envelopes) === 0) {
    return {
      x: midMap.x,
      y: midMap.y,
      anchorX: midMap.x,
      anchorY: midMap.y,
      showLeader: false,
      offsetUV: { du: 0, dv: 0 },
    };
  }

  // Tier 2: slide along the curve when there is open beam span.
  const startUV = toUV(curve.sx, curve.sy);
  const endUV = toUV(curve.ex, curve.ey);
  const chordU = endUV.u - startUV.u;
  const chordV = endUV.v - startUV.v;
  const chordUV = Math.hypot(chordU, chordV);

  if (chordUV >= pillW * 1.05) {
    let bestSlide: {
      x: number;
      y: number;
      du: number;
      dv: number;
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
          bestSlide = { x: pt.x, y: pt.y, du, dv, cost };
        }
      }
    }
    if (bestSlide) {
      return {
        x: bestSlide.x,
        y: bestSlide.y,
        anchorX: bestSlide.x,
        anchorY: bestSlide.y,
        showLeader: false,
        offsetUV: { du: bestSlide.du, dv: bestSlide.dv },
      };
    }
  }

  // Tier 3: step radially outward around the midpoint in camera-upright space,
  // preferring perpendicular "camera-up" directions and clear margins.
  const chordLen = chordUV || 1;
  const tu = chordU / chordLen;
  const tv = chordV / chordLen;
  const n1 = { u: -tv, v: tu };
  const n2 = { u: tv, v: -tu };
  const upNormal = n1.v <= n2.v ? n1 : n2;
  const baseAngle = Math.atan2(upNormal.v, upNormal.u);

  const dirs: { du: number; dv: number }[] = [];
  for (let i = 0; i < RADIAL_DEG_OFFSETS.length; i++) {
    const a = baseAngle + (RADIAL_DEG_OFFSETS[i] * Math.PI) / 180;
    dirs.push({ du: Math.cos(a), dv: Math.sin(a) });
  }
  dirs.push({ du: 0, dv: -1 }, { du: 0, dv: 1 });

  const stepBase = Math.max(8 / safeScale, safePpf * 0.9);
  let bestClear: { u: number; v: number; cost: number } | null = null;
  let bestFallback: { u: number; v: number; score: number } | null = null;

  const prevMaxBonus = prevOffsetUV ? 0.22 * Math.hypot(prevOffsetUV.du, prevOffsetUV.dv) : 0;
  const minHalf = Math.min(hw, hh);
  for (let sIdx = 0; sIdx < RADIAL_STEP_MULTIPLIERS.length; sIdx++) {
    const step = RADIAL_STEP_MULTIPLIERS[sIdx] * stepBase;
    if (bestClear && step + minHalf - prevMaxBonus > bestClear.cost) break;
    for (let dIdx = 0; dIdx < dirs.length; dIdx++) {
      const dir = dirs[dIdx];
      const dist = Math.abs(dir.du) * hw + Math.abs(dir.dv) * hh + step;
      const candU = midUV.u + dir.du * dist;
      const candV = midUV.v + dir.dv * dist;
      const overlap = measureTotalOverlap(candU, candV, hw, hh, envelopes);
      const du = candU - midUV.u;
      const dv = candV - midUV.v;
      const prevPenalty = prevOffsetUV
        ? 0.22 * Math.hypot(du - prevOffsetUV.du, dv - prevOffsetUV.dv)
        : 0;
      const cost = dist + (candV > midUV.v ? 6 / safeScale : 0) + prevPenalty;

      if (overlap === 0) {
        if (!bestClear || cost < bestClear.cost) {
          bestClear = { u: candU, v: candV, cost };
        }
      } else {
        const score = overlap * 1000 + cost;
        if (!bestFallback || score < bestFallback.score) {
          bestFallback = { u: candU, v: candV, score };
        }
      }
    }
  }

  const chosen = bestClear ?? bestFallback!;
  const chosenMap = toXY(chosen.u, chosen.v);
  const dispUV = Math.hypot(chosen.u - midUV.u, chosen.v - midUV.v);
  return {
    x: chosenMap.x,
    y: chosenMap.y,
    anchorX: midMap.x,
    anchorY: midMap.y,
    showLeader: dispUV > hh * 0.65,
    offsetUV: { du: chosen.u - midUV.u, dv: chosen.v - midUV.v },
  };
}
