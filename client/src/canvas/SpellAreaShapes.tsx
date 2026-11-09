import { useEffect, useRef } from 'react';
import type Konva from 'konva';
import { Circle, Group, Line, Rect, Text } from 'react-konva';
import { areaOrigin, areaPolygon, type SpellArea, type SpellAreaPlacement } from '../../../shared/spellAreas';
import { useMapAnimation } from '../lib/useMapAnimation';

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
  targets: { x: number; y: number; widthFt: number }[];
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
      {targets.map((t, i) => (
        <Circle key={i} x={t.x} y={t.y} radius={(t.widthFt * pxPerFoot) / 2} stroke="#fff5bf" strokeWidth={2 / scale} />
      ))}
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

export function SpellRayTargetShapes({
  caster,
  targets,
  pxPerFoot,
  rangeFt,
  scale = 1,
  damageType,
  spellName,
}: {
  caster: { x: number; y: number; widthFt: number };
  targets: { token: { id: string; x: number; y: number; widthFt: number }; count: number; tag: string }[];
  pxPerFoot: number;
  rangeFt: number;
  scale?: number;
  damageType?: string;
  spellName?: string;
}) {
  const groupRef = useRef<Konva.Group>(null);
  const { enabled: animateEnabled } = useMapAnimation();

  const lowerName = (spellName ?? '').trim().toLowerCase();
  const lowerType = (damageType ?? '').trim().toLowerCase();
  const palette =
    lowerType === 'fire' || lowerName.includes('scorching')
      ? { glow: '#ff6422', core: '#ffe299', spark: '#fff6d6', bg: '#2b1006eb', border: '#ff8a47' }
      : lowerName.includes('eldritch')
        ? { glow: '#35e0a1', core: '#d4fff0', spark: '#f2fffa', bg: '#09261ceb', border: '#63f5be' }
        : lowerType === 'force' || lowerName.includes('missile')
          ? { glow: '#b335ff', core: '#e8a1ff', spark: '#fff0ff', bg: '#1b0e36eb', border: '#d584ff' }
          : { glow: '#5cb8ff', core: '#e3f4ff', spark: '#ffffff', bg: '#0c2036eb', border: '#82caff' };

  useEffect(() => {
    if (!animateEnabled || !targets.length) return;
    let raf = 0;
    const tick = (now: number) => {
      const root = groupRef.current;
      if (!root) return;
      const sec = now / 1000;
      const sparks = root.find('.ray-spark') as Konva.Line[];
      for (let i = 0; i < sparks.length; i++) {
        const spark = sparks[i];
        const phase = Number(spark.getAttr('rayPhase') ?? 0);
        spark.dashOffset(-((sec * 96 + phase * 32) / scale));
      }
      const rings = root.find('.ray-target-ring') as Konva.Circle[];
      for (let i = 0; i < rings.length; i++) {
        rings[i].dashOffset(-((sec * 18) / scale));
      }
      const travelers = root.find('.ray-travel-arrow') as Konva.Group[];
      for (let i = 0; i < travelers.length; i++) {
        const node = travelers[i];
        const curve = node.getAttr('rayCurve') as
          | { sx: number; sy: number; cx: number; cy: number; ex: number; ey: number; phase: number }
          | undefined;
        if (!curve) continue;
        const cycle = (sec * 0.95 + curve.phase) % 1;
        const t = 0.08 + cycle * 0.84;
        const pos = evalQuadraticBezier(curve.sx, curve.sy, curve.cx, curve.cy, curve.ex, curve.ey, t);
        const fade = cycle < 0.15 ? cycle / 0.15 : cycle > 0.82 ? (1 - cycle) / 0.18 : 1;
        node.position({ x: pos.x, y: pos.y });
        node.rotation(pos.angleDeg);
        node.opacity(Math.max(0, Math.min(1, fade * 0.95)));
      }
      root.getLayer()?.batchDraw();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [animateEnabled, targets, scale, caster.x, caster.y]);

  const casterRadius = (caster.widthFt * pxPerFoot) / 2;
  const arrowLen = 9.5 / scale;
  const arrowWing = 4.6 / scale;
  const travelLen = 7.5 / scale;
  const travelWing = 3.8 / scale;

  return (
    <Group ref={groupRef} name="spell-ray-targets" listening={false}>
      <Circle
        x={caster.x}
        y={caster.y}
        radius={rangeFt * pxPerFoot}
        stroke={palette.glow}
        opacity={0.32}
        strokeWidth={1.6 / scale}
        dash={[8 / scale, 6 / scale]}
      />
      {targets.map(({ token, count, tag }, targetIdx) => {
        const dx = token.x - caster.x;
        const dy = token.y - caster.y;
        const dist = Math.hypot(dx, dy) || 1;
        const ux = dx / dist;
        const uy = dy / dist;
        const nx = -uy;
        const ny = ux;
        const targetRadius = (token.widthFt * pxPerFoot) / 2;
        const startOffset = Math.min(casterRadius * 0.55, dist * 0.22);
        const endOffset = Math.min(targetRadius * 0.68, dist * 0.22);
        const sx = caster.x + ux * startOffset;
        const sy = caster.y + uy * startOffset;
        const ex = token.x - ux * endOffset;
        const ey = token.y - uy * endOffset;
        const spreadStep = Math.min(30 / scale, Math.max(15 / scale, dist * 0.16));
        const badgeText = `${tag} ×${count}`;
        const badgeW = Math.max(46, badgeText.length * 8.5 + 14) / scale;
        const badgeH = 22 / scale;
        const bx = token.x - badgeW / 2;
        const by = token.y - targetRadius - badgeH - 8 / scale;

        return (
          <Group key={token.id}>
            <Circle
              x={token.x}
              y={token.y}
              radius={targetRadius + 4 / scale}
              stroke={palette.glow}
              strokeWidth={2.6 / scale}
              opacity={0.88}
            />
            <Circle
              name="ray-target-ring"
              x={token.x}
              y={token.y}
              radius={targetRadius + 8.5 / scale}
              stroke={palette.core}
              strokeWidth={2 / scale}
              dash={[14 / scale, 6 / scale]}
              opacity={0.85}
            />
            {Array.from({ length: count }, (_, k) => {
              const offset = count === 1 ? 0 : (k - (count - 1) / 2) * spreadStep;
              const cx = (sx + ex) / 2 + nx * offset;
              const cy = (sy + ey) / 2 + ny * offset;
              const pts = sampleQuadraticBezier(sx, sy, cx, cy, ex, ey);
              const endAngle = (Math.atan2(ey - cy, ex - cx) * 180) / Math.PI;
              const phase = (targetIdx * 0.37 + k * 0.29) % 1;
              const mid = evalQuadraticBezier(sx, sy, cx, cy, ex, ey, 0.55);

              return (
                <Group key={k}>
                  {/* Sorcerous-Burst style 3-layer beam: outer aura, inner core, and flowing spark */}
                  <Line
                    points={pts}
                    stroke={palette.glow}
                    strokeWidth={11 / scale}
                    opacity={0.22}
                    lineCap="round"
                    lineJoin="round"
                  />
                  <Line
                    points={pts}
                    stroke={palette.core}
                    strokeWidth={2.5 / scale}
                    opacity={0.92}
                    lineCap="round"
                    lineJoin="round"
                  />
                  <Line
                    name="ray-spark"
                    points={pts}
                    stroke={palette.spark}
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
                      stroke={palette.glow}
                      strokeWidth={4.2 / scale}
                      opacity={0.55}
                      lineCap="round"
                      lineJoin="round"
                    />
                    <Line
                      points={[-travelLen, -travelWing, 0, 0, -travelLen, travelWing]}
                      stroke={palette.spark}
                      strokeWidth={2 / scale}
                      lineCap="round"
                      lineJoin="round"
                    />
                  </Group>
                  {/* Terminal burst-arrow marker at the target end of the tether */}
                  <Group x={ex} y={ey} rotation={endAngle}>
                    <Line
                      closed
                      points={[0, 0, -arrowLen, -arrowWing, -arrowLen * 0.72, 0, -arrowLen, arrowWing]}
                      fill={palette.core}
                      stroke={palette.glow}
                      strokeWidth={1.2 / scale}
                      lineJoin="round"
                    />
                  </Group>
                </Group>
              );
            })}
            <Group x={bx} y={by}>
              <Rect
                width={badgeW}
                height={badgeH}
                fill={palette.bg}
                stroke={palette.border}
                strokeWidth={1.4 / scale}
                cornerRadius={badgeH / 2}
              />
              <Text
                width={badgeW}
                height={badgeH}
                align="center"
                verticalAlign="middle"
                text={badgeText}
                fill={palette.core}
                fontStyle="bold"
                fontSize={12.5 / scale}
              />
            </Group>
          </Group>
        );
      })}
    </Group>
  );
}
