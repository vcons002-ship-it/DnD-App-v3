import { useEffect, useRef } from 'react';
import type Konva from 'konva';
import { Circle, Group, Line, Rect, Text } from 'react-konva';
import { areaOrigin, areaPolygon, type SpellArea, type SpellAreaPlacement } from '../../../shared/spellAreas';
import { tokenRadiusPx, visionLit, visionShowsAffinity, type PlayerVision } from '../../../shared/playerVision';

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
  distinct?: boolean;
}) {
  const groupRef = useRef<Konva.Group>(null);
  const latestRef = useRef({ caster, targets, pxPerFoot, scale, getPosition, getBaseWidthFt, is3dToken });
  latestRef.current = { caster, targets, pxPerFoot, scale, getPosition, getBaseWidthFt, is3dToken };

  const defaultPalette = affinityPalette(affinity ?? targets[0]?.affinity ?? 'enemy');

  useEffect(() => {
    if (!targets.length) return;
    let raf = 0;
    const tick = (now: number) => {
      const root = groupRef.current;
      if (!root) return;
      const {
        caster: curCaster,
        targets: curTargets,
        pxPerFoot: curPpf,
        scale: curScale,
        getPosition: curGetPos,
        getBaseWidthFt: curGetBaseWidth,
        is3dToken: curIs3d,
      } = latestRef.current;
      const sec = now / 1000;
      const cPos = (curCaster.id ? curGetPos?.(curCaster.id) : undefined) ?? curCaster;
      const cBaseWidthFt = curCaster.id
        ? (curGetBaseWidth?.({ ...curCaster, id: curCaster.id }) ?? curCaster.widthFt)
        : curCaster.widthFt;
      const cRadius = (cBaseWidthFt * curPpf) / 2;

      const rangeCircle = root.findOne<Konva.Circle>('.ray-range-circle');
      if (rangeCircle) {
        rangeCircle.position({ x: cPos.x, y: cPos.y });
      }

      const targetGroups = root.find('.ray-target-group') as Konva.Group[];
      for (let i = 0; i < targetGroups.length; i++) {
        const tGroup = targetGroups[i];
        const targetIdx = Number(tGroup.getAttr('targetIdx') ?? i);
        const item = curTargets[targetIdx];
        if (!item) continue;
        const tPos = curGetPos?.(item.token.id) ?? item.token;
        const dx = tPos.x - cPos.x;
        const dy = tPos.y - cPos.y;
        const dist = Math.hypot(dx, dy) || 1;
        const ux = dx / dist;
        const uy = dy / dist;
        const nx = -uy;
        const ny = ux;
        const tBaseWidthFt = curGetBaseWidth?.(item.token) ?? item.token.widthFt;
        const targetRadius = (tBaseWidthFt * curPpf) / 2;
        const hideRing = !!curIs3d?.(item.token.id);
        const startOffset = Math.min(cRadius * 1.05, dist * 0.42);
        const endOffset = Math.min(hideRing ? targetRadius * 1.19 : targetRadius + 8.5 / curScale, dist * 0.42);
        const sx = cPos.x + ux * startOffset;
        const sy = cPos.y + uy * startOffset;
        const ex = tPos.x - ux * endOffset;
        const ey = tPos.y - uy * endOffset;
        const spreadStep = Math.min(30 / curScale, Math.max(15 / curScale, dist * 0.16));

        const outerRing = tGroup.findOne<Konva.Circle>('.ray-outer-ring');
        if (outerRing) {
          outerRing.visible(!hideRing);
          outerRing.position({ x: tPos.x, y: tPos.y });
          outerRing.radius(targetRadius + 4 / curScale);
        }

        const targetRing = tGroup.findOne<Konva.Circle>('.ray-target-ring');
        if (targetRing) {
          targetRing.visible(!hideRing);
          targetRing.position({ x: tPos.x, y: tPos.y });
          targetRing.radius(targetRadius + 8.5 / curScale);
          targetRing.dashOffset(-((sec * 18) / curScale));
        }

        const badge = tGroup.findOne<Konva.Group>('.ray-badge');
        if (badge) {
          const badgeW = Number(badge.getAttr('badgeW') ?? 46 / curScale);
          const badgeH = Number(badge.getAttr('badgeH') ?? 22 / curScale);
          badge.position({
            x: tPos.x - badgeW / 2,
            y: tPos.y - targetRadius - badgeH - 8 / curScale,
          });
        }

        const beamGroups = tGroup.find('.ray-beam-group') as Konva.Group[];
        for (let b = 0; b < beamGroups.length; b++) {
          const bGroup = beamGroups[b];
          const k = Number(bGroup.getAttr('beamIdx') ?? b);
          const count = Number(bGroup.getAttr('beamCount') ?? item.count);
          const offset = count === 1 ? spreadStep * 0.35 : (k - (count - 1) / 2) * spreadStep;
          const cx = (sx + ex) / 2 + nx * offset;
          const cy = (sy + ey) / 2 + ny * offset;
          const pts = sampleQuadraticBezier(sx, sy, cx, cy, ex, ey);
          const endAngle = (Math.atan2(ey - cy, ex - cx) * 180) / Math.PI;
          const phase = (targetIdx * 0.37 + k * 0.29) % 1;

          const glowLine = bGroup.findOne<Konva.Line>('.ray-glow');
          if (glowLine) glowLine.points(pts);

          const coreLine = bGroup.findOne<Konva.Line>('.ray-core');
          if (coreLine) coreLine.points(pts);

          const sparkLine = bGroup.findOne<Konva.Line>('.ray-spark');
          if (sparkLine) {
            sparkLine.points(pts);
            sparkLine.dashOffset(-((sec * 96 + phase * 32) / curScale));
          }

          const traveler = bGroup.findOne<Konva.Group>('.ray-travel-arrow');
          if (traveler) {
            const cycle = (sec * 0.95 + phase) % 1;
            const t = 0.08 + cycle * 0.84;
            const pos = evalQuadraticBezier(sx, sy, cx, cy, ex, ey, t);
            const fade = cycle < 0.15 ? cycle / 0.15 : cycle > 0.82 ? (1 - cycle) / 0.18 : 1;
            traveler.position({ x: pos.x, y: pos.y });
            traveler.rotation(pos.angleDeg);
            traveler.opacity(Math.max(0, Math.min(1, fade * 0.95)));
          }

          const endArrow = bGroup.findOne<Konva.Group>('.ray-end-arrow');
          if (endArrow) {
            endArrow.position({ x: ex, y: ey });
            endArrow.rotation(endAngle);
          }

          const midPill = bGroup.findOne<Konva.Group>('.ray-mid-pill');
          if (midPill) {
            const midPt = evalQuadraticBezier(sx, sy, cx, cy, ex, ey, 0.5);
            const pillW = Number(midPill.getAttr('pillW') ?? 54 / curScale);
            const pillH = Number(midPill.getAttr('pillH') ?? 19 / curScale);
            midPill.position({ x: midPt.x - pillW / 2, y: midPt.y - pillH / 2 });
          }
        }
      }

      root.getLayer()?.batchDraw();
      raf = requestAnimationFrame(tick);
    };
    const layer = groupRef.current?.getLayer();
    layer?.batchDraw();
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      layer?.batchDraw();
    };
  }, [targets.length]);

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
                  {/* Sorcerous-Burst style 3-layer beam: outer aura, inner core, and flowing spark */}
                  <Line
                    name="ray-glow"
                    points={pts}
                    stroke={tPalette.glow}
                    strokeWidth={11 / scale}
                    opacity={outOfRange ? 0.14 : 0.22}
                    lineCap="round"
                    lineJoin="round"
                  />
                  <Line
                    name="ray-core"
                    points={pts}
                    stroke={tPalette.core}
                    strokeWidth={2.5 / scale}
                    opacity={outOfRange ? 0.7 : 0.92}
                    dash={outOfRange ? [7 / scale, 8 / scale] : undefined}
                    lineCap="round"
                    lineJoin="round"
                  />
                  <Line
                    name="ray-spark"
                    points={pts}
                    stroke={tPalette.spark}
                    strokeWidth={4.6 / scale}
                    dash={[5 / scale, 52 / scale]}
                    lineCap="round"
                    lineJoin="round"
                    rayPhase={phase}
                  />
                  {/* Traveling directional arrow chevron gliding along the beam */}
                  <Group
                    name="ray-travel-arrow"
                    x={mid.x}
                    y={mid.y}
                    rotation={mid.angleDeg}
                    rayCurve={{ sx, sy, cx, cy, ex, ey, phase }}
                  >
                    <Line
                      points={[-travelLen, -travelWing, 0, 0, -travelLen, travelWing]}
                      stroke={tPalette.glow}
                      strokeWidth={4.2 / scale}
                      opacity={0.55}
                      lineCap="round"
                      lineJoin="round"
                    />
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
                  {midLabel && k === 0 && (() => {
                    const midPt = evalQuadraticBezier(sx, sy, cx, cy, ex, ey, 0.5);
                    const pillW = Math.max(44, midLabel.length * 7.1 + 14) / scale;
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
                          width={pillW}
                          height={pillH}
                          fill="rgba(16, 18, 25, 0.88)"
                          stroke={outOfRange ? '#e07b67' : tPalette.border}
                          strokeWidth={1.2 / scale}
                          cornerRadius={pillH / 2}
                        />
                        <Text
                          width={pillW}
                          height={pillH}
                          align="center"
                          verticalAlign="middle"
                          text={midLabel}
                          fill={outOfRange ? '#ffb3a3' : tPalette.spark}
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
