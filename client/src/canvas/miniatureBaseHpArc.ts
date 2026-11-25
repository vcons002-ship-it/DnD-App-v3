import { Box3, Mesh, Object3D, Vector3 } from 'three';
import type { MiniatureDefinition } from '../lib/miniatures';

export const ON_BASE_HP_PLANE_SIZE = 1.06;

/**
 * Measure the top surface height of a miniature's circular pedestal rim
 * in normalized `baseDiameter = 1.0` units above the floor (`y = 0`).
 *
 * Uses pewter pedestal bounds directly when present, and otherwise takes the
 * median highest rim vertex across 24 angular sectors around the outer edge so
 * overhanging capes, staffs, or weapons do not skew the base height.
 */
export function measureBaseRimHeight(
  model: Object3D,
  definition: Pick<MiniatureDefinition, 'baseCenter' | 'baseDiameter'>,
): number {
  const diameter = Math.max(0.001, definition.baseDiameter);
  const [cx, cy, cz] = definition.baseCenter;
  model.updateWorldMatrix(true, true);

  let pewterMaxY = -Infinity;
  const sectors = new Array<number>(24).fill(-Infinity);
  const v = new Vector3();
  const box = new Box3();

  model.traverse((node) => {
    if (!(node instanceof Mesh) || node.name === 'disposition-outline' || node.userData.dynamicFx) return;
    const mats = Array.isArray(node.material) ? node.material : [node.material];
    if (mats.some((m) => m?.userData?.pewterBase)) {
      box.setFromObject(node);
      if (Number.isFinite(box.max.y)) pewterMaxY = Math.max(pewterMaxY, (box.max.y - cy) / diameter);
      return;
    }
    const pos = node.geometry?.getAttribute('position');
    if (!pos) return;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(node.matrixWorld);
      const dx = v.x - cx;
      const dy = v.y - cy;
      const dz = v.z - cz;
      const r = Math.hypot(dx, dz) / diameter;
      const h = dy / diameter;
      if (r >= 0.41 && r <= 0.54 && h >= 0.005 && h <= 0.19) {
        const angle = Math.atan2(dz, dx) + Math.PI;
        const sector = Math.min(23, Math.max(0, Math.floor((angle / (Math.PI * 2)) * 24)));
        if (h > sectors[sector]!) sectors[sector] = h;
      }
    }
  });

  if (Number.isFinite(pewterMaxY) && pewterMaxY > 0.01) {
    return Math.max(0.03, Math.min(0.16, pewterMaxY));
  }
  const populated = sectors.filter((h) => Number.isFinite(h)).sort((a, b) => a - b);
  if (!populated.length) return 0.035;
  const median = populated[Math.floor(populated.length * 0.5)]!;
  return Math.max(0.025, Math.min(0.16, median));
}

/**
 * Paint a framed HP gauge along the camera-facing front edge (`+Z`, bottom of
 * canvas at 90°) on top of the circular token base (`r = 0.50` in normalized
 * baseDiameter units).
 */
export function drawOnBaseHpArc(
  canvas: HTMLCanvasElement,
  hpFrac: number,
  tempHpFrac: number,
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const size = canvas.width;
  const cx = size / 2;
  const cy = size / 2;
  const pxPerUnit = size / ON_BASE_HP_PLANE_SIZE;

  ctx.clearRect(0, 0, size, size);

  const clampedHp = Math.max(0, Math.min(1, hpFrac));
  const hpColor = clampedHp > 0.5 ? '#39c46b' : clampedHp > 0.25 ? '#f5c518' : '#e23b3b';

  // Gauge sits squarely on top of the front circular edge of the pedestal (r ~ 0.405..0.495).
  const arcMidR = 0.45 * pxPerUnit;
  const arcWidth = 0.056 * pxPerUnit;
  const minRad = (18 * Math.PI) / 180;
  const maxRad = (162 * Math.PI) / 180;

  // 1. Dark outer casing separating the HP gauge from the base texture and outer rings.
  ctx.beginPath();
  ctx.arc(cx, cy, arcMidR, minRad, maxRad, false);
  ctx.strokeStyle = 'rgba(5, 7, 12, 0.96)';
  ctx.lineWidth = arcWidth + 0.038 * pxPerUnit;
  ctx.lineCap = 'round';
  ctx.stroke();

  // 2. Crisp metallic rim bezel so the gauge reads unmistakably as an HP bar.
  ctx.beginPath();
  ctx.arc(cx, cy, arcMidR, minRad, maxRad, false);
  ctx.strokeStyle = 'rgba(226, 236, 250, 0.68)';
  ctx.lineWidth = arcWidth + 0.018 * pxPerUnit;
  ctx.lineCap = 'round';
  ctx.stroke();

  // 3. Recessed dark empty trough.
  ctx.beginPath();
  ctx.arc(cx, cy, arcMidR, minRad, maxRad, false);
  ctx.strokeStyle = 'rgba(17, 22, 33, 0.96)';
  ctx.lineWidth = arcWidth;
  ctx.lineCap = 'round';
  ctx.stroke();

  // 4. Vibrant HP fill sweeping left-to-right (162° -> 18°).
  if (clampedHp > 0.001) {
    const startRad = ((162 - 144 * clampedHp) * Math.PI) / 180;
    ctx.beginPath();
    ctx.arc(cx, cy, arcMidR, startRad, maxRad, false);
    ctx.strokeStyle = hpColor;
    ctx.lineWidth = arcWidth - 0.012 * pxPerUnit;
    ctx.lineCap = 'butt';
    ctx.stroke();

    // Subtle top sheen along the filled portion for miniature-grade polish.
    ctx.beginPath();
    ctx.arc(cx, cy, arcMidR - 0.008 * pxPerUnit, startRad, maxRad, false);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.24)';
    ctx.lineWidth = 0.01 * pxPerUnit;
    ctx.lineCap = 'butt';
    ctx.stroke();
  }

  // 5. 50% "bloodied" midpoint tick across center-front (90°).
  const tickInner = arcMidR - arcWidth * 0.56;
  const tickOuter = arcMidR + arcWidth * 0.56;
  ctx.beginPath();
  ctx.moveTo(cx, cy + tickInner);
  ctx.lineTo(cx, cy + tickOuter);
  ctx.strokeStyle = 'rgba(5, 7, 12, 0.88)';
  ctx.lineWidth = 0.013 * pxPerUnit;
  ctx.lineCap = 'butt';
  ctx.stroke();

  // 6. Framed cyan temp-HP sliver hugging the front-left outer bevel lip.
  if (tempHpFrac > 0.001) {
    const tempSweep = Math.min(44, Math.max(14, tempHpFrac * 144));
    const tempStart = ((162 - tempSweep) * Math.PI) / 180;
    const tempR = 0.496 * pxPerUnit;
    ctx.beginPath();
    ctx.arc(cx, cy, tempR, tempStart, maxRad, false);
    ctx.strokeStyle = 'rgba(5, 7, 12, 0.95)';
    ctx.lineWidth = 0.036 * pxPerUnit;
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, tempR, tempStart, maxRad, false);
    ctx.strokeStyle = '#5ce1ff';
    ctx.lineWidth = 0.019 * pxPerUnit;
    ctx.lineCap = 'round';
    ctx.stroke();
  }
}
