import type { MapWall } from './mapWalls.js';
import type { PlayerVision } from './playerVision.js';
import { wallBoundarySegments } from './wallGeometry.js';

export type WallShadowSegment = {
  wallId: string;
  ax: number;
  ay: number;
  bx: number;
  by: number;
  door: boolean;
};

export type VisionSenseMode = 'normal' | 'darkvision' | 'devilsSight' | 'blindsight' | 'truesight';

export type VisionSourceDescriptor = {
  id: string;
  x: number;
  y: number;
  radiusPx: number;
  mode: VisionSenseMode;
  dimColor?: boolean;
};

const segmentCache = new WeakMap<readonly MapWall[], { key: string; segments: WallShadowSegment[] }>();

/**
 * Extract active sight-blocking wall and closed-door boundary segments.
 * Cached by `walls` array reference so GPU vertex buffers only rebuild when map
 * wall geometry or a door's open/closed state changes.
 */
export function extractActiveWallSegments(walls: readonly MapWall[] = []): {
  key: string;
  segments: WallShadowSegment[];
} {
  const cached = segmentCache.get(walls);
  if (cached) return cached;

  const segments: WallShadowSegment[] = [];
  const keyParts: string[] = [];

  for (const w of walls) {
    // Open doors and arches allow sight through their opening
    if (w.door && w.open) continue;
    if (w.arch) continue;
    const bounds = wallBoundarySegments(w);
    for (const seg of bounds) {
      segments.push({
        wallId: w.id,
        ax: seg.a.x,
        ay: seg.a.y,
        bx: seg.b.x,
        by: seg.b.y,
        door: !!w.door,
      });
    }
    keyParts.push(`${w.id}:${w.ax},${w.ay},${w.bx},${w.by}:${w.door ? (w.open ? 1 : 0) : 2}`);
  }

  const entry = { key: keyParts.join('|'), segments };
  segmentCache.set(walls, entry);
  return entry;
}

/**
 * Build a compact 2D triangle vertex buffer (`x, y` pairs, 6 floats per triangle,
 * 2 triangles = 12 floats per occluding segment) extruding shadow volumes away
 * from `origin` out to `extrudeDistancePx`.
 *
 * Used by the GPU 2D shadow/stencil pass (`< 0.2 ms` on integrated GPUs).
 */
export function buildShadowVolumeVertices(
  segments: readonly WallShadowSegment[],
  origin: { x: number; y: number },
  radiusPx: number,
  extrudeDistancePx = Math.max(radiusPx * 4, 8192),
): Float32Array {
  const rSq = radiusPx * radiusPx;
  const active: WallShadowSegment[] = [];

  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const dx = s.bx - s.ax;
    const dy = s.by - s.ay;
    const lenSq = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((origin.x - s.ax) * dx + (origin.y - s.ay) * dy) / lenSq));
    const cx = s.ax + t * dx - origin.x;
    const cy = s.ay + t * dy - origin.y;
    if (cx * cx + cy * cy <= rSq) {
      active.push(s);
    }
  }

  const out = new Float32Array(active.length * 12);
  let offset = 0;

  for (let i = 0; i < active.length; i++) {
    const s = active[i];
    const dax = s.ax - origin.x;
    const day = s.ay - origin.y;
    const la = Math.hypot(dax, day) || 1;
    const farAx = s.ax + (dax / la) * extrudeDistancePx;
    const farAy = s.ay + (day / la) * extrudeDistancePx;

    const dbx = s.bx - origin.x;
    const dby = s.by - origin.y;
    const lb = Math.hypot(dbx, dby) || 1;
    const farBx = s.bx + (dbx / lb) * extrudeDistancePx;
    const farBy = s.by + (dby / lb) * extrudeDistancePx;

    // Triangle 1: A -> B -> FarB
    out[offset++] = s.ax;
    out[offset++] = s.ay;
    out[offset++] = s.bx;
    out[offset++] = s.by;
    out[offset++] = farBx;
    out[offset++] = farBy;

    // Triangle 2: A -> FarB -> FarA
    out[offset++] = s.ax;
    out[offset++] = s.ay;
    out[offset++] = farBx;
    out[offset++] = farBy;
    out[offset++] = farAx;
    out[offset++] = farAy;
  }

  return out;
}

/**
 * Compute a deterministic cache key for a player's or party's vision pass.
 * When `sharedPartyVision` is false (PR #195) or only one PC is owned, single-PC
 * vision reuses the cached stencil pass whenever origin coordinates and wall key match.
 */
export function computeVisionStencilCacheKey(params: {
  vision: PlayerVision;
  sharedPartyVision?: boolean;
  singlePcId?: string | null;
}): string {
  const { key: wallKey } = extractActiveWallSegments(params.vision.walls ?? []);
  const originsKey = (params.vision.origins ?? [])
    .map((o) => `${o.id}@${Math.round(o.x)},${Math.round(o.y)}`)
    .sort()
    .join(';');
  const lightsKey = (params.vision.lights ?? [])
    .map((l) => `${l.id}@${Math.round(l.x)},${Math.round(l.y)}:${Math.round(l.radius)}`)
    .sort()
    .join(';');
  // Single-PC vision shares the same geometric cache key regardless of whether
  // sharedPartyVision is toggled on or off when there is only 1 origin.
  const scope =
    params.vision.origins.length === 1
      ? `single:${params.vision.origins[0].id}`
      : params.sharedPartyVision !== false
        ? 'party'
        : `personal:${params.singlePcId ?? 'multi'}`;
  return `${scope}|r:${params.vision.radius}|h:${params.vision.heavy ? 1 : 0}|o:${originsKey}|l:${lightsKey}|w:${wallKey}`;
}

/**
 * Layer z-index constants guaranteeing that `ManualFog` and map decals (`mapImages`)
 * always composite above local darkvision/lit-color grading across all hardware tiers
 * (preserving PR #196's layer ordering invariants).
 */
export const VIEWPORT_LAYER_Z_INDEX = {
  mapBaseArtwork: 0,
  localDarkvisionGrading: 1,
  mapDecalsAndImages: 2,
  footprintsAndGroundTokens: 3,
  manualFogOverlay: 4,
  miniatureAndTokenLayer: 5,
  tokenHtmlHudOverlay: 6,
  spellTargetingAndHpNumbers: 7,
} as const;
