// The app's first location/distance-based combat helper. Framework-free so the
// server applies it authoritatively. Computes whether two tokens are "within 5
// ft" of each other on their map — used for the prone-target advantage rule and
// the auto-crit-vs-incapacitated rule.
import type { MapState, Token } from './types.js';

type Scale = Pick<MapState, 'feetPerSquare' | 'gridSizePx'> | null | undefined;
type Tok = Pick<Token, 'x' | 'y' | 'widthFt'> & Partial<Pick<Token, 'miniatureWidthFt'>>;

function effectiveWidthFt(t: Tok): number {
  return t.widthFt > 0 ? Math.max(t.widthFt, t.miniatureWidthFt ?? 0) : 0;
}

/**
 * 5e distance between two tokens in feet, measured on the grid (Chebyshev — a
 * diagonal counts as one square) from CENTER to center, then reduced by the
 * footprint reach of any creature larger than one square (or enlarged miniature
 * base, so standing next to a large figure stays in melee reach). Point queries
 * (`widthFt === 0`) stay center-based.
 */
export function tokenDistanceFt(a: Tok, b: Tok, map: Scale): number {
  const fps = map && map.feetPerSquare > 0 ? map.feetPerSquare : 5;
  const gs = map && map.gridSizePx > 0 ? map.gridSizePx : 50;
  const fpp = fps / gs; // feet per pixel (matches the client's grid scale)
  const chebFt = Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) * fpp;
  // Extra reach for a creature bigger than one square (0 for a normal 5-ft token).
  const extra = Math.max(0, (effectiveWidthFt(a) - fps) / 2) + Math.max(0, (effectiveWidthFt(b) - fps) / 2);
  return Math.max(0, chebFt - extra);
}

/** Whether two tokens are within 5 ft (adjacent / in melee reach). */
export function tokensWithin5ft(a: Tok, b: Tok, map: Scale): boolean {
  return tokenDistanceFt(a, b, map) <= 5 + 1e-6;
}
