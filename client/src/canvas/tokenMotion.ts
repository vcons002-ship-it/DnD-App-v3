/** Realistic combat trot/jog pace (~6.8 mph: 5 ft in 0.5 s, 30 ft in 3.0 s). */
export const TOKEN_MOVE_FEET_PER_SECOND = 10;
export const TOKEN_MOVE_MIN_MS = 160;
export const TOKEN_MOVE_MAX_MS = 6000;

/** Presentation only: the server still decides placement and facing. */
export function tokenMoveDuration(distancePx: number, pxPerFoot: number): number {
  const feet = Math.max(0, distancePx) / Math.max(0.0001, pxPerFoot);
  if (!(feet > 0)) return 0;
  return Math.round(
    Math.min(
      TOKEN_MOVE_MAX_MS,
      Math.max(TOKEN_MOVE_MIN_MS, (feet / TOKEN_MOVE_FEET_PER_SECOND) * 1000),
    ),
  );
}

const MOTION_RAMP = 0.08;
const MOTION_EDGE_SPEED = 0.5;
const MOTION_CRUISE_SPEED = 1 / (1 - MOTION_RAMP * (1 - MOTION_EDGE_SPEED));

export function tokenMoveProgress(elapsed: number, duration: number): number {
  if (!(duration > 0)) return 1;
  const u = Math.min(1, Math.max(0, elapsed / duration));
  if (u <= MOTION_RAMP) {
    return MOTION_CRUISE_SPEED * (MOTION_EDGE_SPEED * u + ((1 - MOTION_EDGE_SPEED) / (2 * MOTION_RAMP)) * u * u);
  }
  if (u >= 1 - MOTION_RAMP) {
    const w = 1 - u;
    return 1 - MOTION_CRUISE_SPEED * (MOTION_EDGE_SPEED * w + ((1 - MOTION_EDGE_SPEED) / (2 * MOTION_RAMP)) * w * w);
  }
  return 0.5 + MOTION_CRUISE_SPEED * (u - 0.5);
}

/** Grid movement counts a diagonal as one square, without reach deductions. */
export function moveDistanceFt(dx: number, dy: number, pxPerFoot: number): number {
  return Math.round(Math.max(Math.abs(dx), Math.abs(dy)) / Math.max(.0001, pxPerFoot));
}
