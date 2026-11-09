import { Circle, Group, Line, Rect, Text } from 'react-konva';
import { areaOrigin, areaPolygon, type SpellArea, type SpellAreaPlacement } from '../../../shared/spellAreas';

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
  steps = 14,
): number[] {
  const pts: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const inv = 1 - t;
    pts.push(inv * inv * sx + 2 * inv * t * cx + t * t * ex, inv * inv * sy + 2 * inv * t * cy + t * t * ey);
  }
  return pts;
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
  const lowerName = (spellName ?? '').trim().toLowerCase();
  const lowerType = (damageType ?? '').trim().toLowerCase();
  const palette =
    lowerType === 'fire' || lowerName.includes('scorching')
      ? { glow: '#ff6422', core: '#ffe299', bg: '#2b1006eb', border: '#ff8a47' }
      : lowerName.includes('eldritch')
        ? { glow: '#35e0a1', core: '#d4fff0', bg: '#09261ceb', border: '#63f5be' }
        : lowerType === 'force' || lowerName.includes('missile')
          ? { glow: '#9b6bff', core: '#ede0ff', bg: '#1b0e36eb', border: '#b894ff' }
          : { glow: '#5cb8ff', core: '#e3f4ff', bg: '#0c2036eb', border: '#82caff' };

  const casterRadius = (caster.widthFt * pxPerFoot) / 2;

  return (
    <Group name="spell-ray-targets" listening={false}>
      <Circle
        x={caster.x}
        y={caster.y}
        radius={rangeFt * pxPerFoot}
        stroke={palette.glow}
        opacity={0.32}
        strokeWidth={1.6 / scale}
        dash={[8 / scale, 6 / scale]}
      />
      {targets.map(({ token, count, tag }) => {
        const dx = token.x - caster.x;
        const dy = token.y - caster.y;
        const dist = Math.hypot(dx, dy) || 1;
        const ux = dx / dist;
        const uy = dy / dist;
        const nx = -uy;
        const ny = ux;
        const targetRadius = (token.widthFt * pxPerFoot) / 2;
        const startOffset = Math.min(casterRadius * 0.55, dist * 0.22);
        const endOffset = Math.min(targetRadius * 0.65, dist * 0.22);
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
              opacity={0.9}
            />
            <Circle
              x={token.x}
              y={token.y}
              radius={targetRadius + 8 / scale}
              stroke={palette.core}
              strokeWidth={1.2 / scale}
              dash={[6 / scale, 4 / scale]}
              opacity={0.75}
            />
            {Array.from({ length: count }, (_, k) => {
              const offset = count === 1 ? 0 : (k - (count - 1) / 2) * spreadStep;
              const cx = (sx + ex) / 2 + nx * offset;
              const cy = (sy + ey) / 2 + ny * offset;
              const pts = sampleQuadraticBezier(sx, sy, cx, cy, ex, ey);
              return (
                <Group key={k}>
                  <Line
                    points={pts}
                    stroke={palette.glow}
                    strokeWidth={6.5 / scale}
                    opacity={0.48}
                    lineCap="round"
                    lineJoin="round"
                  />
                  <Line
                    points={pts}
                    stroke={palette.core}
                    strokeWidth={2.3 / scale}
                    opacity={0.96}
                    lineCap="round"
                    lineJoin="round"
                  />
                  <Circle
                    x={ex}
                    y={ey}
                    radius={3.6 / scale}
                    fill={palette.core}
                    stroke={palette.glow}
                    strokeWidth={1.4 / scale}
                  />
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
