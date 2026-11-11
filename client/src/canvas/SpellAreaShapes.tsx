import { useEffect, useRef } from 'react';
import type Konva from 'konva';
import { Circle, Group, Line, Rect, Text } from 'react-konva';
import { tokenDistanceFt } from '../../../shared/distance';
import { areaOrigin, areaPolygon, type SpellArea, type SpellAreaPlacement } from '../../../shared/spellAreas';
import { tokenRadiusPx, visionLit, visionShowsAffinity, type PlayerVision } from '../../../shared/playerVision';
import { useLegacyMode } from '../lib/useEnvironmentQuality';
import { useMapAnimation } from '../lib/useMapAnimation';
import { useStore } from '../state/socket';

export type TargetAffinity = 'enemy' | 'neutral' | 'friendly' | 'unknown';

export type AffinityVisibilityOptions = {
  role?: string;
  vision?: PlayerVision | null;
  map?: { gridSizePx: number; feetPerSquare: number } | null;
  affinityIds?: ReadonlySet<string>;
  targetPos?: { x: number; y: number };
  casterPos?: { x: number; y: number };
};

export function isTokenAffinityVisible(
  tok: { id?: string; kind?: string; x?: number; y?: number; widthFt?: number; sharedSightOnly?: boolean; partiallyRevealed?: boolean } | undefined,
  opts?: AffinityVisibilityOptions,
  pos?: { x: number; y: number },
): boolean {
  if (!tok) return true;
  if (tok.sharedSightOnly || tok.partiallyRevealed) return false;
  if (!opts || (opts.role === 'dm' && !opts.vision)) return true;
  if (tok.kind === 'pc') return true;
  if (opts.affinityIds && tok.id && !opts.affinityIds.has(tok.id)) return false;
  const vision = opts.vision;
  if (!vision || vision.daylight) return true;
  const x = pos?.x ?? tok.x ?? 0;
  const y = pos?.y ?? tok.y ?? 0;
  const r = tok.widthFt ? tokenRadiusPx({ widthFt: tok.widthFt }, opts.map) : 0;
  if (!visionShowsAffinity(vision, x, y, r)) return false;
  if (visionLit(vision, x, y)) return true;
  if (r > 0) {
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4;
      if (visionLit(vision, x + Math.cos(a) * r, y + Math.sin(a) * r)) return true;
    }
  }
  return false;
}

export function resolveTargetAffinity(
  monsters: readonly { id: string; disposition: 'enemy' | 'neutral' | 'friendly' }[] | undefined,
  caster: { id?: string; kind?: string; refId?: string; x?: number; y?: number; widthFt?: number; sharedSightOnly?: boolean; partiallyRevealed?: boolean } | undefined,
  target: { id?: string; kind?: string; refId?: string; x?: number; y?: number; widthFt?: number; sharedSightOnly?: boolean; partiallyRevealed?: boolean },
  opts?: AffinityVisibilityOptions,
): TargetAffinity {
  const tokenDisp = (tok: typeof caster, pos?: { x: number; y: number }): TargetAffinity => {
    if (!tok || tok.kind === 'pc') return 'friendly';
    if (!isTokenAffinityVisible(tok, opts, pos)) return 'unknown';
    return (tok.refId ? monsters?.find((m) => m.id === tok.refId)?.disposition : undefined) ?? 'enemy';
  };
  const targetDisp = tokenDisp(target, opts?.targetPos);
  if (targetDisp !== 'friendly') return targetDisp;
  return tokenDisp(caster, opts?.casterPos);
}

export function affinityPalette(aff: TargetAffinity = 'enemy') {
  if (aff === 'unknown') {
    return { glow: '#8e96a4', core: '#c8d0dc', spark: '#eef2f7', bg: '#1a1e26eb', border: '#8e96a4' };
  }
  if (aff === 'friendly') {
    return { glow: '#39c46b', core: '#8cf0ae', spark: '#e8fff0', bg: '#082612eb', border: '#39c46b' };
  }
  if (aff === 'neutral') {
    return { glow: '#f5c518', core: '#ffe678', spark: '#fffbe6', bg: '#2b2206eb', border: '#f5c518' };
  }
  return { glow: '#e23b3b', core: '#ff8a8a', spark: '#ffe6e6', bg: '#2b0909eb', border: '#e23b3b' };
}

export function SpellAreaShapes({
  spec,
  placement,
  caster,
  pxPerFoot,
  targets,
  onRemove,
  scale = 1,
  spellName,
  raised = false,
  previewState,
}: {
  previewState?: 'aiming' | 'resolving';
  raised?: boolean;
  spellName?: string;
  spec: SpellArea;
  placement: SpellAreaPlacement;
  caster: { x: number; y: number };
  pxPerFoot: number;
  targets: {
    x: number;
    y: number;
    widthFt: number;
    baseWidthFt?: number;
    affinity?: TargetAffinity;
    hideRing?: boolean;
  }[];
  onRemove?: () => void;
  scale?: number;
}) {
  const circular = ['sphere', 'cylinder', 'emanation'].includes(spec.kind);
  const spikes = spellName === 'Spike Growth';
  const active = !!previewState;
  const color = spellName === 'Call Lightning' ? '#a7dfff' : '#ffd76a';
  return (
    <Group name="spell-area-shape" id={previewState} listening={!!onRemove} onClick={onRemove} onTap={onRemove}>
      {placement.points.map((_, i) => {
        const o = areaOrigin(spec, placement, caster, pxPerFoot, i);
        const style = {
          fill: active ? '#ffe18818' : spikes ? '#476139' : '#ffe188',
          opacity: active ? 1 : spikes ? (raised ? 0.055 : 0.16) : 0.24,
          stroke: active ? color : spikes ? '#99c079' : '#ffd76a',
          strokeWidth: (active ? 3 : 2) / scale,
        };
        return (
          <Group key={i}>
            {circular ? (
              <Circle x={o.x} y={o.y} radius={spec.sizeFt * pxPerFoot} {...style} />
            ) : (
              <Line closed points={areaPolygon(spec, o, placement.angle, pxPerFoot)} {...style} />
            )}
            {spikes &&
              !raised &&
              Array.from({ length: 90 }, (_, j) => {
                const angle = j * 2.399963;
                const r = Math.sqrt((j + 0.5) / 90) * spec.sizeFt * pxPerFoot * 0.97;
                const x = o.x + Math.cos(angle) * r;
                const y = o.y + Math.sin(angle) * r;
                const s = Math.min(6, pxPerFoot * 0.5);
                return (
                  <Line
                    key={j}
                    points={[x - s, y + s, x, y - s, x + s * 0.45, y + s * 0.4, x + s, y - s * 0.5]}
                    stroke="#a0be79"
                    opacity={0.5}
                    strokeWidth={1.1 / scale}
                  />
                );
              })}
            <Text
              x={o.x + 6 / scale}
              y={o.y - (circular ? spec.sizeFt : spec.kind === 'cube' ? spec.sizeFt / 2 : 0) * pxPerFoot - 20 / scale}
              text={`${spec.sizeFt} ft ${circular ? 'radius' : spec.kind}${spec.count ? ` · ${i + 1}` : ''}`}
              fill="#ffe8a3"
              stroke="#15110b"
              strokeWidth={0.5 / scale}
              fontSize={14 / scale}
            />
          </Group>
        );
      })}
      {targets.map((t, i) =>
        t.hideRing ? null : (
          <Circle
            key={i}
            x={t.x}
            y={t.y}
            radius={((t.baseWidthFt ?? t.widthFt) * pxPerFoot) / 2}
            stroke={t.affinity ? affinityPalette(t.affinity).glow : '#fff5bf'}
            strokeWidth={2 / scale}
          />
        ),
      )}
    </Group>
  );
}

function sampleQuadraticBezier(
  sx: number,
  sy: number,
  cx: number,
  cy: number,
  ex: number,
  ey: number,
  steps = 16,
): number[] {
  const pts: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const inv = 1 - t;
    pts.push(inv * inv * sx + 2 * inv * t * cx + t * t * ex, inv * inv * sy + 2 * inv * t * cy + t * t * ey);
  }
  return pts;
}

function evalQuadraticBezier(
  sx: number,
  sy: number,
  cx: number,
  cy: number,
  ex: number,
  ey: number,
  t: number,
): { x: number; y: number; angleDeg: number } {
  const inv = 1 - t;
  const x = inv * inv * sx + 2 * inv * t * cx + t * t * ex;
  const y = inv * inv * sy + 2 * inv * t * cy + t * t * ey;
  const tx = 2 * inv * (cx - sx) + 2 * t * (ex - cx);
  const ty = 2 * inv * (cy - sy) + 2 * t * (ey - cy);
  return { x, y, angleDeg: (Math.atan2(ty, tx) * 180) / Math.PI };
}

type RayToken = {
  id: string;
  x: number;
  y: number;
  widthFt: number;
  kind?: string;
  refId?: string;
  miniatureWidthFt?: number;
};

export function SpellRayTargetShapes({
  caster,
  targets,
  pxPerFoot,
  rangeFt,
  scale = 1,
  showCount = true,
  affinity,
  getPosition,
  getBaseWidthFt,
  is3dToken,
  midLabel,
  outOfRange,
  mapScale,
  formatMidLabel,
  distinct,
}: {
  caster: { id?: string; x: number; y: number; widthFt: number; kind?: string; refId?: string; miniatureWidthFt?: number };
  targets: {
    token: RayToken;
    count: number;
    tag: string;
    affinity?: TargetAffinity;
  }[];
  pxPerFoot: number;
  rangeFt?: number;
  scale?: number;
  damageType?: string;
  spellName?: string;
  showCount?: boolean;
  affinity?: TargetAffinity;
  getPosition?: (tokenId: string) => { x: number; y: number } | undefined;
  getBaseWidthFt?: (token: RayToken) => number;
  is3dToken?: (tokenId: string) => boolean;
  midLabel?: string;
  outOfRange?: boolean;
  mapScale?: { feetPerSquare: number; gridSizePx: number } | null;
  formatMidLabel?: (distFt: number) => { midLabel: string; outOfRange: boolean };
  distinct?: boolean;
}) {
  const groupRef = useRef<Konva.Group>(null);
  const legacyMode = useLegacyMode();
  const { enabled: mapAnimation } = useMapAnimation();
  const hasDragPreview = useStore((s) => s.tokenDragPreview !== null);
  const reducedMotion = !mapAnimation;

  const latestRef = useRef({
    caster,
    targets,
    pxPerFoot,
    scale,
    getPosition,
    getBaseWidthFt,
    is3dToken,
    affinity,
    midLabel,
    outOfRange,
    mapScale,
    formatMidLabel,
    legacyMode,
    reducedMotion,
    hasDragPreview,
  });
  latestRef.current = {
    caster,
    targets,
    pxPerFoot,
    scale,
    getPosition,
    getBaseWidthFt,
    is3dToken,
    affinity,
    midLabel,
    outOfRange,
    mapScale,
    formatMidLabel,
    legacyMode,
    reducedMotion,
    hasDragPreview,
  };

  const defaultPalette = affinityPalette(affinity ?? targets[0]?.affinity ?? 'enemy');
  const hasPill = Boolean(formatMidLabel && mapScale) || midLabel !== undefined;
  const structureKey = `${targets.map((t) => `${t.token.id}:${t.count}:${t.affinity ?? ''}`).join('|')}|${hasPill}|${showCount}|${Boolean(rangeFt)}|${affinity ?? ''}|${legacyMode}`;
  const syncControllerRef = useRef<{ syncOnce: () => void; ensureActiveLoop: () => void } | null>(null);

  useEffect(() => {
    if (!targets.length) {
      syncControllerRef.current = null;
      return;
    }
    type CachedBeam = {
      k: number;
      count: number;
      glowLine: Konva.Line | null;
      coreLine: Konva.Line | null;
      sparkLine: Konva.Line | null;
      traveler: Konva.Group | null;
      endArrow: Konva.Group | null;
      midPill: Konva.Group | null;
      midPillRect: Konva.Rect | null;
      midPillText: Konva.Text | null;
      sx: number;
      sy: number;
      cx: number;
      cy: number;
      ex: number;
      ey: number;
      lastLabel: string;
      lastOutOfRange: boolean | undefined;
      lastPillScale: number;
    };
    type CachedTarget = {
      targetIdx: number;
      outerRing: Konva.Circle | null;
      targetRing: Konva.Circle | null;
      badge: Konva.Group | null;
      beams: CachedBeam[];
      lastCx: number;
      lastCy: number;
      lastTx: number;
      lastTy: number;
      lastScale: number;
      lastPpf: number;
      lastHideRing: boolean | undefined;
    };

    const root = groupRef.current;
    if (!root) return;
    const rangeCircle = root.findOne<Konva.Circle>('.ray-range-circle') ?? null;
    let lastRangeX = NaN;
    let lastRangeY = NaN;
    const targetGroups = root.find('.ray-target-group') as Konva.Group[];
    const cachedTargets: CachedTarget[] = targetGroups.map((tGroup, i) => {
      const targetIdx = Number(tGroup.getAttr('targetIdx') ?? i);
      const beamGroups = tGroup.find('.ray-beam-group') as Konva.Group[];
      const beams: CachedBeam[] = beamGroups.map((bGroup, b) => {
        const midPill = bGroup.findOne<Konva.Group>('.ray-mid-pill') ?? null;
        return {
          k: Number(bGroup.getAttr('beamIdx') ?? b),
          count: Number(bGroup.getAttr('beamCount') ?? 1),
          glowLine: bGroup.findOne<Konva.Line>('.ray-glow') ?? null,
          coreLine: bGroup.findOne<Konva.Line>('.ray-core') ?? null,
          sparkLine: bGroup.findOne<Konva.Line>('.ray-spark') ?? null,
          traveler: bGroup.findOne<Konva.Group>('.ray-travel-arrow') ?? null,
          endArrow: bGroup.findOne<Konva.Group>('.ray-end-arrow') ?? null,
          midPill,
          midPillRect: midPill?.findOne<Konva.Rect>('.ray-mid-pill-bg') ?? null,
          midPillText: midPill?.findOne<Konva.Text>('.ray-mid-pill-text') ?? null,
          sx: 0,
          sy: 0,
          cx: 0,
          cy: 0,
          ex: 0,
          ey: 0,
          lastLabel: '',
          lastOutOfRange: undefined,
          lastPillScale: NaN,
        };
      });
      return {
        targetIdx,
        outerRing: tGroup.findOne<Konva.Circle>('.ray-outer-ring') ?? null,
        targetRing: tGroup.findOne<Konva.Circle>('.ray-target-ring') ?? null,
        badge: tGroup.findOne<Konva.Group>('.ray-badge') ?? null,
        beams,
        lastCx: NaN,
        lastCy: NaN,
        lastTx: NaN,
        lastTy: NaN,
        lastScale: NaN,
        lastPpf: NaN,
        lastHideRing: undefined,
      };
    });

    const hasLiveOverride = () => {
      const { caster: curCaster, targets: curTargets, getPosition: curGetPos, hasDragPreview: curDrag } = latestRef.current;
      if (curDrag) return true;
      if (curCaster.id && curGetPos?.(curCaster.id)) return true;
      for (let i = 0; i < curTargets.length; i++) {
        if (curGetPos?.(curTargets[i].token.id)) return true;
      }
      return false;
    };

    const applyFrame = (now: number) => {
      const {
        caster: curCaster,
        targets: curTargets,
        pxPerFoot: curPpf,
        scale: curScale,
        getPosition: curGetPos,
        getBaseWidthFt: curGetBaseWidth,
        is3dToken: curIs3d,
        affinity: curAffinity,
        midLabel: curMidLabel,
        outOfRange: curOutOfRange,
        mapScale: curMapScale,
        formatMidLabel: curFormatMidLabel,
        legacyMode: curLegacy,
        reducedMotion: curReduced,
      } = latestRef.current;
      const sec = now / 1000;
      const cPos = (curCaster.id ? curGetPos?.(curCaster.id) : undefined) ?? curCaster;
      const cBaseWidthFt = curCaster.id
        ? (curGetBaseWidth?.({ ...curCaster, id: curCaster.id }) ?? curCaster.widthFt)
        : curCaster.widthFt;
      const cRadius = (cBaseWidthFt * curPpf) / 2;

      if (rangeCircle && (cPos.x !== lastRangeX || cPos.y !== lastRangeY)) {
        lastRangeX = cPos.x;
        lastRangeY = cPos.y;
        rangeCircle.position({ x: cPos.x, y: cPos.y });
      }

      for (let i = 0; i < cachedTargets.length; i++) {
        const entry = cachedTargets[i];
        const item = curTargets[entry.targetIdx];
        if (!item) continue;
        const tPalette = affinityPalette(item.affinity ?? curAffinity ?? 'enemy');
        const tPos = curGetPos?.(item.token.id) ?? item.token;
        const hideRing = !!curIs3d?.(item.token.id);
        const geomChanged =
          cPos.x !== entry.lastCx ||
          cPos.y !== entry.lastCy ||
          tPos.x !== entry.lastTx ||
          tPos.y !== entry.lastTy ||
          curScale !== entry.lastScale ||
          curPpf !== entry.lastPpf ||
          hideRing !== entry.lastHideRing;

        if (geomChanged) {
          entry.lastCx = cPos.x;
          entry.lastCy = cPos.y;
          entry.lastTx = tPos.x;
          entry.lastTy = tPos.y;
          entry.lastScale = curScale;
          entry.lastPpf = curPpf;
          entry.lastHideRing = hideRing;

          const dx = tPos.x - cPos.x;
          const dy = tPos.y - cPos.y;
          const dist = Math.hypot(dx, dy) || 1;
          const ux = dx / dist;
          const uy = dy / dist;
          const nx = -uy;
          const ny = ux;
          const tBaseWidthFt = curGetBaseWidth?.(item.token) ?? item.token.widthFt;
          const targetRadius = (tBaseWidthFt * curPpf) / 2;
          const startOffset = Math.min(cRadius * 1.05, dist * 0.42);
          const endOffset = Math.min(hideRing ? targetRadius * 1.19 : targetRadius + 8.5 / curScale, dist * 0.42);
          const sx = cPos.x + ux * startOffset;
          const sy = cPos.y + uy * startOffset;
          const ex = tPos.x - ux * endOffset;
          const ey = tPos.y - uy * endOffset;
          const spreadStep = Math.min(30 / curScale, Math.max(15 / curScale, dist * 0.16));

          if (entry.outerRing) {
            entry.outerRing.visible(!hideRing);
            entry.outerRing.position({ x: tPos.x, y: tPos.y });
            entry.outerRing.radius(targetRadius + 4 / curScale);
          }
          if (entry.targetRing) {
            entry.targetRing.visible(!hideRing);
            entry.targetRing.position({ x: tPos.x, y: tPos.y });
            entry.targetRing.radius(targetRadius + 8.5 / curScale);
          }
          if (entry.badge) {
            const badgeW = Number(entry.badge.getAttr('badgeW') ?? 46 / curScale);
            const badgeH = Number(entry.badge.getAttr('badgeH') ?? 22 / curScale);
            entry.badge.position({
              x: tPos.x - badgeW / 2,
              y: tPos.y - targetRadius - badgeH - 8 / curScale,
            });
          }

          for (let b = 0; b < entry.beams.length; b++) {
            const beam = entry.beams[b];
            const offset = beam.count === 1 ? spreadStep * 0.35 : (beam.k - (beam.count - 1) / 2) * spreadStep;
            const cx = (sx + ex) / 2 + nx * offset;
            const cy = (sy + ey) / 2 + ny * offset;
            beam.sx = sx;
            beam.sy = sy;
            beam.cx = cx;
            beam.cy = cy;
            beam.ex = ex;
            beam.ey = ey;
            const pts = sampleQuadraticBezier(sx, sy, cx, cy, ex, ey);
            const endAngle = (Math.atan2(ey - cy, ex - cx) * 180) / Math.PI;
            beam.glowLine?.points(pts);
            beam.coreLine?.points(pts);
            beam.sparkLine?.points(pts);
            if (beam.endArrow) {
              beam.endArrow.position({ x: ex, y: ey });
              beam.endArrow.rotation(endAngle);
            }
          }
        }

        if (!curReduced && !curLegacy && entry.targetRing && !hideRing) {
          entry.targetRing.dashOffset(-((sec * 18) / curScale));
        }

        const livePill =
          curFormatMidLabel && curMapScale
            ? curFormatMidLabel(
                tokenDistanceFt(
                  { x: cPos.x, y: cPos.y, widthFt: curCaster.widthFt },
                  { x: tPos.x, y: tPos.y, widthFt: item.token.widthFt },
                  curMapScale,
                ),
              )
            : curMidLabel !== undefined
              ? { midLabel: curMidLabel, outOfRange: !!curOutOfRange }
              : undefined;

        for (let b = 0; b < entry.beams.length; b++) {
          const beam = entry.beams[b];
          const phase = (entry.targetIdx * 0.37 + beam.k * 0.29) % 1;
          const effOut = livePill ? livePill.outOfRange : !!curOutOfRange;

          if (effOut !== beam.lastOutOfRange || curScale !== beam.lastPillScale) {
            beam.glowLine?.opacity(effOut ? 0.14 : 0.22);
            if (beam.coreLine) {
              beam.coreLine.opacity(effOut ? 0.7 : 0.92);
              beam.coreLine.dash(effOut ? [7 / curScale, 8 / curScale] : []);
            }
          }

          if (beam.midPill && livePill) {
            const styleChanged =
              livePill.midLabel !== beam.lastLabel ||
              effOut !== beam.lastOutOfRange ||
              curScale !== beam.lastPillScale;
            const pillW = Math.max(44, livePill.midLabel.length * 7.1 + 14) / curScale;
            const pillH = 19 / curScale;
            if (styleChanged) {
              beam.lastLabel = livePill.midLabel;
              beam.lastOutOfRange = effOut;
              beam.lastPillScale = curScale;
              if (beam.midPillRect) {
                beam.midPillRect.width(pillW);
                beam.midPillRect.height(pillH);
                beam.midPillRect.cornerRadius(pillH / 2);
                beam.midPillRect.strokeWidth(1.2 / curScale);
                beam.midPillRect.stroke(effOut ? '#e07b67' : tPalette.border);
              }
              if (beam.midPillText) {
                beam.midPillText.text(livePill.midLabel);
                beam.midPillText.width(pillW);
                beam.midPillText.height(pillH);
                beam.midPillText.fontSize(11 / curScale);
                beam.midPillText.fill(effOut ? '#ffb3a3' : tPalette.spark);
              }
            }
            if (geomChanged || styleChanged) {
              const midPt = evalQuadraticBezier(beam.sx, beam.sy, beam.cx, beam.cy, beam.ex, beam.ey, 0.5);
              beam.midPill.position({ x: midPt.x - pillW / 2, y: midPt.y - pillH / 2 });
            }
          } else {
            beam.lastOutOfRange = effOut;
            beam.lastPillScale = curScale;
          }

          if (curReduced) {
            beam.traveler?.visible(false);
          } else {
            const dashSpeed = curLegacy ? 56 : 96;
            beam.sparkLine?.dashOffset(-((sec * dashSpeed + phase * 32) / curScale));
            if (beam.traveler) {
              beam.traveler.visible(true);
              const cycle = (sec * (curLegacy ? 0.72 : 0.95) + phase) % 1;
              const t = 0.08 + cycle * 0.84;
              const pos = evalQuadraticBezier(beam.sx, beam.sy, beam.cx, beam.cy, beam.ex, beam.ey, t);
              const fade = cycle < 0.15 ? cycle / 0.15 : cycle > 0.82 ? (1 - cycle) / 0.18 : 1;
              beam.traveler.position({ x: pos.x, y: pos.y });
              beam.traveler.rotation(pos.angleDeg);
              beam.traveler.opacity(Math.max(0, Math.min(1, fade * 0.95)));
            }
          }
        }
      }

      root.getLayer()?.batchDraw();
    };

    let raf = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const clearScheduled = () => {
      if (raf !== 0) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const shouldKeepTicking = () => {
      if (document.hidden) return false;
      return !latestRef.current.reducedMotion || hasLiveOverride();
    };
    // Legacy Mode throttles stationary directional motion to ~20 FPS (50ms) on
    // the isolated spell-area-overlay canvas (skipping 2/3 of VSync callbacks
    // and never touching map/fog/token layers), while waking to 60 FPS during drag.
    const scheduleNext = () => {
      if (!shouldKeepTicking()) return;
      if (latestRef.current.legacyMode && !hasLiveOverride()) {
        if (timer === null && raf === 0) {
          timer = setTimeout(() => {
            timer = null;
            if (shouldKeepTicking()) {
              raf = requestAnimationFrame(tick);
            }
          }, 50);
        }
      } else if (raf === 0) {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        raf = requestAnimationFrame(tick);
      }
    };
    const tick = (now: number) => {
      raf = 0;
      if (!groupRef.current) return;
      applyFrame(now);
      scheduleNext();
    };
    const syncOnce = () => {
      if (!groupRef.current) return;
      clearScheduled();
      applyFrame(performance.now());
      scheduleNext();
    };
    syncControllerRef.current = { syncOnce, ensureActiveLoop: scheduleNext };

    const onVisibility = () => {
      if (document.hidden) {
        clearScheduled();
      } else {
        syncOnce();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    syncOnce();

    const layer = root.getLayer();
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      clearScheduled();
      syncControllerRef.current = null;
      layer?.batchDraw();
    };
  }, [structureKey, legacyMode, reducedMotion, hasDragPreview]);

  useEffect(() => {
    if (reducedMotion || legacyMode) {
      syncControllerRef.current?.syncOnce();
    }
  }, [reducedMotion, legacyMode, caster.x, caster.y, targets, scale, pxPerFoot, midLabel, outOfRange]);

  const cPos = (caster.id ? getPosition?.(caster.id) : undefined) ?? caster;
  const cBaseWidthFt = caster.id ? (getBaseWidthFt?.({ ...caster, id: caster.id }) ?? caster.widthFt) : caster.widthFt;
  const casterRadius = (cBaseWidthFt * pxPerFoot) / 2;
  const arrowLen = 9.5 / scale;
  const arrowWing = 4.6 / scale;
  const travelLen = 7.5 / scale;
  const travelWing = 3.8 / scale;

  return (
    <Group ref={groupRef} name="spell-ray-targets" listening={false}>
      {!!rangeFt && rangeFt > 0 && (
        <Circle
          name="ray-range-circle"
          x={cPos.x}
          y={cPos.y}
          radius={rangeFt * pxPerFoot}
          stroke={defaultPalette.glow}
          opacity={0.32}
          strokeWidth={1.6 / scale}
          dash={[8 / scale, 6 / scale]}
        />
      )}
      {targets.map(({ token, count, tag, affinity: itemAffinity }, targetIdx) => {
        const tPalette = affinityPalette(itemAffinity ?? affinity ?? 'enemy');
        const tPos = getPosition?.(token.id) ?? token;
        const dx = tPos.x - cPos.x;
        const dy = tPos.y - cPos.y;
        const dist = Math.hypot(dx, dy) || 1;
        const ux = dx / dist;
        const uy = dy / dist;
        const nx = -uy;
        const ny = ux;
        const tBaseWidthFt = getBaseWidthFt?.(token) ?? token.widthFt;
        const targetRadius = (tBaseWidthFt * pxPerFoot) / 2;
        const hideRing = !!is3dToken?.(token.id);
        const startOffset = Math.min(casterRadius * 1.05, dist * 0.42);
        const endOffset = Math.min(hideRing ? targetRadius * 1.19 : targetRadius + 8.5 / scale, dist * 0.42);
        const sx = cPos.x + ux * startOffset;
        const sy = cPos.y + uy * startOffset;
        const ex = tPos.x - ux * endOffset;
        const ey = tPos.y - uy * endOffset;
        const spreadStep = Math.min(30 / scale, Math.max(15 / scale, dist * 0.16));
        const badgeText = distinct && count === 1 ? tag : `${tag} ×${count}`;
        const badgeW = Math.max(46, badgeText.length * 8.5 + 14) / scale;
        const badgeH = 22 / scale;
        const bx = tPos.x - badgeW / 2;
        const by = tPos.y - targetRadius - badgeH - 8 / scale;
        const renderPill =
          formatMidLabel && mapScale
            ? formatMidLabel(
                tokenDistanceFt(
                  { x: cPos.x, y: cPos.y, widthFt: caster.widthFt },
                  { x: tPos.x, y: tPos.y, widthFt: token.widthFt },
                  mapScale,
                ),
              )
            : midLabel !== undefined
              ? { midLabel, outOfRange: !!outOfRange }
              : undefined;
        const effOutOfRange = renderPill ? renderPill.outOfRange : !!outOfRange;

        return (
          <Group key={token.id} name="ray-target-group" targetIdx={targetIdx}>
            <Circle
              name="ray-outer-ring"
              visible={!hideRing}
              x={tPos.x}
              y={tPos.y}
              radius={targetRadius + 4 / scale}
              stroke={tPalette.glow}
              strokeWidth={2.6 / scale}
              opacity={0.88}
            />
            <Circle
              name="ray-target-ring"
              visible={!hideRing}
              x={tPos.x}
              y={tPos.y}
              radius={targetRadius + 8.5 / scale}
              stroke={tPalette.core}
              strokeWidth={2 / scale}
              dash={[14 / scale, 6 / scale]}
              opacity={0.85}
            />
            {Array.from({ length: count }, (_, k) => {
              const offset = count === 1 ? spreadStep * 0.35 : (k - (count - 1) / 2) * spreadStep;
              const cx = (sx + ex) / 2 + nx * offset;
              const cy = (sy + ey) / 2 + ny * offset;
              const pts = sampleQuadraticBezier(sx, sy, cx, cy, ex, ey);
              const endAngle = (Math.atan2(ey - cy, ex - cx) * 180) / Math.PI;
              const phase = (targetIdx * 0.37 + k * 0.29) % 1;
              const mid = evalQuadraticBezier(sx, sy, cx, cy, ex, ey, 0.55);

              return (
                <Group key={k} name="ray-beam-group" beamIdx={k} beamCount={count}>
                  {/* Sorcerous-Burst style beam: skip wide outer aura in Legacy Mode for minimal fill-rate */}
                  {!legacyMode && (
                    <Line
                      name="ray-glow"
                      points={pts}
                      stroke={tPalette.glow}
                      strokeWidth={11 / scale}
                      opacity={effOutOfRange ? 0.14 : 0.22}
                      lineCap="round"
                      lineJoin="round"
                    />
                  )}
                  <Line
                    name="ray-core"
                    points={pts}
                    stroke={tPalette.core}
                    strokeWidth={2.5 / scale}
                    opacity={effOutOfRange ? 0.7 : 0.92}
                    dash={effOutOfRange ? [7 / scale, 8 / scale] : []}
                    lineCap="round"
                    lineJoin="round"
                  />
                  <Line
                    name="ray-spark"
                    points={pts}
                    stroke={tPalette.spark}
                    strokeWidth={(legacyMode ? 3.4 : 4.6) / scale}
                    dash={legacyMode ? [9 / scale, 26 / scale] : [5 / scale, 52 / scale]}
                    lineCap="round"
                    lineJoin="round"
                    rayPhase={phase}
                  />
                  {/* Traveling directional arrow chevron gliding along the beam */}
                  <Group
                    name="ray-travel-arrow"
                    visible={!reducedMotion}
                    x={mid.x}
                    y={mid.y}
                    rotation={mid.angleDeg}
                    rayCurve={{ sx, sy, cx, cy, ex, ey, phase }}
                  >
                    {!legacyMode && (
                      <Line
                        points={[-travelLen, -travelWing, 0, 0, -travelLen, travelWing]}
                        stroke={tPalette.glow}
                        strokeWidth={4.2 / scale}
                        opacity={0.55}
                        lineCap="round"
                        lineJoin="round"
                      />
                    )}
                    <Line
                      points={[-travelLen, -travelWing, 0, 0, -travelLen, travelWing]}
                      stroke={tPalette.spark}
                      strokeWidth={2 / scale}
                      lineCap="round"
                      lineJoin="round"
                    />
                  </Group>
                  {/* Terminal burst-arrow marker at the target end of the tether */}
                  <Group name="ray-end-arrow" x={ex} y={ey} rotation={endAngle}>
                    <Line
                      closed
                      points={[0, 0, -arrowLen, -arrowWing, -arrowLen * 0.72, 0, -arrowLen, arrowWing]}
                      fill={tPalette.core}
                      stroke={tPalette.glow}
                      strokeWidth={1.2 / scale}
                      lineJoin="round"
                    />
                  </Group>
                  {renderPill && k === 0 && (() => {
                    const midPt = evalQuadraticBezier(sx, sy, cx, cy, ex, ey, 0.5);
                    const pillW = Math.max(44, renderPill.midLabel.length * 7.1 + 14) / scale;
                    const pillH = 19 / scale;
                    return (
                      <Group
                        name="ray-mid-pill"
                        x={midPt.x - pillW / 2}
                        y={midPt.y - pillH / 2}
                        pillW={pillW}
                        pillH={pillH}
                      >
                        <Rect
                          name="ray-mid-pill-bg"
                          width={pillW}
                          height={pillH}
                          fill="rgba(16, 18, 25, 0.88)"
                          stroke={effOutOfRange ? '#e07b67' : tPalette.border}
                          strokeWidth={1.2 / scale}
                          cornerRadius={pillH / 2}
                        />
                        <Text
                          name="ray-mid-pill-text"
                          width={pillW}
                          height={pillH}
                          align="center"
                          verticalAlign="middle"
                          text={renderPill.midLabel}
                          fill={effOutOfRange ? '#ffb3a3' : tPalette.spark}
                          fontStyle="bold"
                          fontSize={11 / scale}
                        />
                      </Group>
                    );
                  })()}
                </Group>
              );
            })}
            {showCount && (
              <Group name="ray-badge" x={bx} y={by} badgeW={badgeW} badgeH={badgeH}>
                <Rect
                  width={badgeW}
                  height={badgeH}
                  fill={tPalette.bg}
                  stroke={tPalette.border}
                  strokeWidth={1.4 / scale}
                  cornerRadius={badgeH / 2}
                />
                <Text
                  width={badgeW}
                  height={badgeH}
                  align="center"
                  verticalAlign="middle"
                  text={badgeText}
                  fill={tPalette.core}
                  fontStyle="bold"
                  fontSize={12.5 / scale}
                />
              </Group>
            )}
          </Group>
        );
      })}
    </Group>
  );
}
