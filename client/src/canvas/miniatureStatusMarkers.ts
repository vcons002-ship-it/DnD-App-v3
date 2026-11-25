import type { RingBand } from '../lib/tokenRings';

export const TURN_COMPASS_PLANE_SIZE = 2.0;
export const TURN_SPOTLIGHT_PLANE_SIZE = 2.6;

const CARDINAL_ANGLES = [0, Math.PI * 0.5, Math.PI, Math.PI * 1.5];

/**
 * Paint a rich warm golden stage-spotlight pool (intended for AdditiveBlending)
 * beneath the active-turn token so the floor genuinely looks illuminated.
 */
export function drawTurnSpotlight(canvas: HTMLCanvasElement, outerRadius: number): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const size = canvas.width;
  const cx = size / 2;
  const cy = size / 2;
  const pxPerUnit = size / TURN_SPOTLIGHT_PLANE_SIZE;

  ctx.clearRect(0, 0, size, size);

  const maxGlowR = Math.min(size * 0.49, (outerRadius + 0.44) * pxPerUnit);
  const grad = ctx.createRadialGradient(cx, cy, 0.25 * pxPerUnit, cx, cy, maxGlowR);
  grad.addColorStop(0, 'rgba(255, 224, 90, 0.62)');
  grad.addColorStop(0.42, 'rgba(255, 206, 48, 0.46)');
  grad.addColorStop(0.7, 'rgba(255, 184, 24, 0.22)');
  grad.addColorStop(0.9, 'rgba(255, 168, 12, 0.06)');
  grad.addColorStop(1, 'rgba(255, 168, 12, 0)');

  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy, maxGlowR, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * Paint a tall, unmistakable golden spotlight cone texture used briefly (~1.65s)
 * when a creature's turn starts so players immediately spot who is acting, even
 * in an overlapping melee crowd, before fading completely away.
 */
export function drawTurnBeamTexture(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  // Bright luminous falloff from floor (y = h) fading smoothly up into the air (y = 0).
  const vGrad = ctx.createLinearGradient(0, 0, 0, h);
  vGrad.addColorStop(0, 'rgba(255, 242, 168, 0)');
  vGrad.addColorStop(0.22, 'rgba(255, 232, 122, 0.22)');
  vGrad.addColorStop(0.6, 'rgba(255, 218, 74, 0.46)');
  vGrad.addColorStop(0.92, 'rgba(255, 224, 96, 0.74)');
  vGrad.addColorStop(1, 'rgba(255, 224, 96, 0.08)');

  ctx.fillStyle = vGrad;
  ctx.fillRect(0, 0, w, h);

  // Crisp luminous vertical light shafts for an unmistakable stage-spotlight callout.
  const rays = 8;
  for (let i = 0; i < rays; i++) {
    const x = ((i + 0.5) / rays) * w;
    const rayW = w / (rays * 2.1);
    const rGrad = ctx.createLinearGradient(x - rayW, 0, x + rayW, 0);
    rGrad.addColorStop(0, 'rgba(255, 248, 198, 0)');
    rGrad.addColorStop(0.5, 'rgba(255, 248, 198, 0.34)');
    rGrad.addColorStop(1, 'rgba(255, 248, 198, 0)');

    ctx.save();
    ctx.globalCompositeOperation = 'source-atop';
    ctx.fillStyle = rGrad;
    ctx.fillRect(x - rayW, 0, rayW * 2, h);
    ctx.restore();
  }
}

/**
 * Paint the Active Turn golden outer ring with subtle cardinal compass pips
 * (N/S/E/W) encircling the inner condition rings.
 */
export function drawTurnCompassRing(canvas: HTMLCanvasElement, band: RingBand): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const size = canvas.width;
  const cx = size / 2;
  const cy = size / 2;
  const pxPerUnit = size / TURN_COMPASS_PLANE_SIZE;

  ctx.clearRect(0, 0, size, size);

  const midR = ((band.inner + band.outer) / 2) * pxPerUnit;
  const thickness = Math.max(5, (band.outer - band.inner) * pxPerUnit);
  const pointerBaseR = (band.outer - 0.012) * pxPerUnit;
  const pointerTipR = (band.outer + 0.056) * pxPerUnit;
  const pointerHalfAngle = (5.0 * Math.PI) / 180;

  // 1. Subtle warm dark backing for crisp contrast on bright terrain.
  ctx.beginPath();
  ctx.arc(cx, cy, midR, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(26, 17, 2, 0.72)';
  ctx.lineWidth = thickness + 0.018 * pxPerUnit;
  ctx.stroke();

  // 2. Main radiant gold ring.
  ctx.beginPath();
  ctx.arc(cx, cy, midR, 0, Math.PI * 2);
  ctx.strokeStyle = '#ffd21a';
  ctx.lineWidth = thickness;
  ctx.stroke();

  // 3. Crisp bright gold inner highlight thread.
  ctx.beginPath();
  ctx.arc(cx, cy, midR, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255, 248, 198, 0.72)';
  ctx.lineWidth = thickness * 0.28;
  ctx.stroke();

  // 4. Four cardinal compass pointers (0°, 90°, 180°, 270°).
  for (const a of CARDINAL_ANGLES) {
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a - pointerHalfAngle * 1.2) * (pointerBaseR - 2), cy + Math.sin(a - pointerHalfAngle * 1.2) * (pointerBaseR - 2));
    ctx.lineTo(cx + Math.cos(a) * (pointerTipR + 0.01 * pxPerUnit), cy + Math.sin(a) * (pointerTipR + 0.01 * pxPerUnit));
    ctx.lineTo(cx + Math.cos(a + pointerHalfAngle * 1.2) * (pointerBaseR - 2), cy + Math.sin(a + pointerHalfAngle * 1.2) * (pointerBaseR - 2));
    ctx.closePath();
    ctx.fillStyle = 'rgba(26, 17, 2, 0.78)';
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a - pointerHalfAngle) * pointerBaseR, cy + Math.sin(a - pointerHalfAngle) * pointerBaseR);
    ctx.lineTo(cx + Math.cos(a) * pointerTipR, cy + Math.sin(a) * pointerTipR);
    ctx.lineTo(cx + Math.cos(a + pointerHalfAngle) * pointerBaseR, cy + Math.sin(a + pointerHalfAngle) * pointerBaseR);
    ctx.closePath();
    ctx.fillStyle = '#ffe259';
    ctx.fill();
  }
}
