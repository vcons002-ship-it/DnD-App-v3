import type { PlayerVision } from '../../../shared/playerVision.js';
import {
  buildShadowVolumeVertices,
  computeVisionStencilCacheKey,
  extractActiveWallSegments,
  type WallShadowSegment,
} from '../../../shared/visionStencilGeometry.js';
import type { BattlefieldView } from './miniatureProjection.js';

export type Gpu2dVisionPassStats = {
  wallKey: string;
  wallUploads: number;
  stencilDraws: number;
  cacheHits: number;
  lastPassMs: number;
};

export type MinimalGlBufferContext = {
  readonly ARRAY_BUFFER: number;
  readonly STATIC_DRAW: number;
  createBuffer(): unknown;
  bindBuffer(target: number, buffer: unknown): void;
  bufferData(target: number, data: Float32Array, usage: number): void;
};

export type Gpu2dVisionPass = {
  /** Upload wall/closed-door segments only when map geometry changes. */
  syncWalls: (walls: PlayerVision['walls']) => boolean;
  /** Execute or reuse the GPU 2D shadow/stencil pass for the current camera and vision state. */
  renderVisionPass: (params: {
    vision: PlayerVision;
    view: BattlefieldView;
    width: number;
    height: number;
    sharedPartyVision?: boolean;
    singlePcId?: string | null;
  }) => {
    cacheHit: boolean;
    cacheKey: string;
    shadowVerticesPerOrigin: Float32Array[];
    stats: Gpu2dVisionPassStats;
  };
  /** Force a full buffer re-upload (e.g. after WebGL context restoration). */
  invalidateGpuResources: () => void;
  getStats: () => Gpu2dVisionPassStats;
};

/**
 * Hardware-scalable 2D wall-segment shadow/stencil pass.
 * - Uploads wall & closed-door segments only when map geometry changes.
 * - Caches single-PC and party stencil outputs so idle frames and redundant
 *   personal/party passes cost 0 ms.
 */
export function createGpu2dVisionPass(
  gl?: MinimalGlBufferContext | null,
): Gpu2dVisionPass {
  let currentWallKey = '';
  let cachedSegments: WallShadowSegment[] = [];
  let lastPassCacheKey = '';
  let lastShadowBuffers: Float32Array[] = [];
  let wallBuffer: unknown = null;

  const stats: Gpu2dVisionPassStats = {
    wallKey: '',
    wallUploads: 0,
    stencilDraws: 0,
    cacheHits: 0,
    lastPassMs: 0,
  };

  const syncWalls = (walls: PlayerVision['walls']): boolean => {
    const extracted = extractActiveWallSegments(walls ?? []);
    if (extracted.key === currentWallKey && cachedSegments.length === extracted.segments.length) {
      return false;
    }
    currentWallKey = extracted.key;
    cachedSegments = extracted.segments;
    stats.wallKey = currentWallKey;
    stats.wallUploads++;
    lastPassCacheKey = '';

    if (gl) {
      if (!wallBuffer) wallBuffer = gl.createBuffer();
      if (wallBuffer) {
        const flat = new Float32Array(cachedSegments.length * 4);
        for (let i = 0; i < cachedSegments.length; i++) {
          const s = cachedSegments[i];
          flat[i * 4] = s.ax;
          flat[i * 4 + 1] = s.ay;
          flat[i * 4 + 2] = s.bx;
          flat[i * 4 + 3] = s.by;
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, wallBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, flat, gl.STATIC_DRAW);
      }
    }
    return true;
  };

  return {
    syncWalls,

    renderVisionPass({ vision, view, width, height, sharedPartyVision, singlePcId }) {
      const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
      syncWalls(vision.walls);

      const baseKey = computeVisionStencilCacheKey({
        vision,
        sharedPartyVision,
        singlePcId,
      });
      const fullKey = `${baseKey}|cam:${view.x.toFixed(1)},${view.y.toFixed(1)},${view.scale.toFixed(3)},${width}x${height}`;

      if (fullKey === lastPassCacheKey) {
        stats.cacheHits++;
        stats.lastPassMs = 0;
        return {
          cacheHit: true,
          cacheKey: baseKey,
          shadowVerticesPerOrigin: lastShadowBuffers,
          stats: { ...stats },
        };
      }

      const radiusPx = Math.max(vision.radius || 0, 600);
      const shadowBuffers: Float32Array[] = [];
      for (const origin of vision.origins ?? []) {
        shadowBuffers.push(buildShadowVolumeVertices(cachedSegments, origin, radiusPx));
      }
      for (const light of vision.lights ?? []) {
        shadowBuffers.push(buildShadowVolumeVertices(cachedSegments, light, light.radius));
      }

      lastPassCacheKey = fullKey;
      lastShadowBuffers = shadowBuffers;
      stats.stencilDraws++;
      const end = typeof performance !== 'undefined' ? performance.now() : Date.now();
      stats.lastPassMs = Math.max(0, end - start);

      return {
        cacheHit: false,
        cacheKey: baseKey,
        shadowVerticesPerOrigin: shadowBuffers,
        stats: { ...stats },
      };
    },

    invalidateGpuResources() {
      currentWallKey = '';
      lastPassCacheKey = '';
      wallBuffer = null;
    },

    getStats() {
      return { ...stats };
    },
  };
}
