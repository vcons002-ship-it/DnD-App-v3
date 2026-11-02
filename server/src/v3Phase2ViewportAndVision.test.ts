import { describe, expect, it } from 'vitest';
import {
  buildShadowVolumeVertices,
  computeVisionStencilCacheKey,
  extractActiveWallSegments,
  VIEWPORT_LAYER_Z_INDEX,
} from '../../shared/visionStencilGeometry.js';
import {
  buildTokenHudPills,
  projectTokenHudTransform,
} from '../../shared/tokenHudProjection.js';
import { createDemandFrameScheduler } from '../../client/src/canvas/demandFrameScheduler.js';
import { createGpu2dVisionPass } from '../../client/src/canvas/gpu2dVisionPass.js';
import type { MapWall } from '../../shared/mapWalls.js';
import type { PlayerVision } from '../../shared/playerVision.js';
import type { StateSnapshot } from '../../shared/types.js';

describe('Phase 2 — Unified Single-Pass Viewport & GPU 2D Shadow Visibility', () => {
  it('extracts wall & closed-door shadow segments, skips open doors/arches, and caches by reference', () => {
    const walls: MapWall[] = [
      { id: 'w1', ax: 0, ay: 0, bx: 100, by: 0 },
      { id: 'd-closed', ax: 100, ay: 0, bx: 150, by: 0, door: true, open: false },
      { id: 'd-open', ax: 150, ay: 0, bx: 200, by: 0, door: true, open: true },
      { id: 'arch-1', ax: 200, ay: 0, bx: 250, by: 0, arch: true },
    ];

    const first = extractActiveWallSegments(walls);
    expect(first.segments.map((s) => s.wallId)).toEqual(['w1', 'd-closed']);

    // Reference cache hit
    const second = extractActiveWallSegments(walls);
    expect(second).toBe(first);

    // Extrude 2D shadow volume triangles (12 floats per active segment)
    const verts = buildShadowVolumeVertices(first.segments, { x: 50, y: 50 }, 300, 1000);
    expect(verts.length).toBe(2 * 12);
  });

  it('reuses single-PC vision stencil cache key regardless of sharedPartyVision toggle (PR #195/196)', () => {
    const vision: PlayerVision = {
      rangeFt: 60,
      radius: 300,
      heavy: true,
      origins: [{ id: 'pc-1', x: 100, y: 100 }],
      lights: [{ id: 'torch-1', x: 150, y: 150, radius: 100, height: 6, strength: 1 }],
      walls: [{ id: 'w1', ax: 0, ay: 0, bx: 100, by: 0 }],
    };

    const keyShared = computeVisionStencilCacheKey({ vision, sharedPartyVision: true });
    const keyPersonal = computeVisionStencilCacheKey({
      vision,
      sharedPartyVision: false,
      singlePcId: 'char-1',
    });
    expect(keyShared).toBe(keyPersonal);

    const pass = createGpu2dVisionPass();
    const res1 = pass.renderVisionPass({
      vision,
      view: { x: 0, y: 0, scale: 1 },
      width: 1280,
      height: 720,
      sharedPartyVision: true,
    });
    expect(res1.cacheHit).toBe(false);
    expect(res1.stats.wallUploads).toBe(1);
    expect(res1.stats.stencilDraws).toBe(1);

    // Second render with identical geometry & camera hits cache with 0 wall uploads
    const res2 = pass.renderVisionPass({
      vision,
      view: { x: 0, y: 0, scale: 1 },
      width: 1280,
      height: 720,
      sharedPartyVision: false,
      singlePcId: 'char-1',
    });
    expect(res2.cacheHit).toBe(true);
    expect(res2.stats.wallUploads).toBe(1);
    expect(res2.stats.cacheHits).toBe(1);
  });

  it('enforces ManualFog and decals layer ordering above local darkvision grading (PR #196)', () => {
    expect(VIEWPORT_LAYER_Z_INDEX.mapDecalsAndImages).toBeGreaterThan(
      VIEWPORT_LAYER_Z_INDEX.localDarkvisionGrading,
    );
    expect(VIEWPORT_LAYER_Z_INDEX.manualFogOverlay).toBeGreaterThan(
      VIEWPORT_LAYER_Z_INDEX.localDarkvisionGrading,
    );
    expect(VIEWPORT_LAYER_Z_INDEX.tokenHtmlHudOverlay).toBeGreaterThan(
      VIEWPORT_LAYER_Z_INDEX.miniatureAndTokenLayer,
    );
  });

  it('schedules frames strictly on demand (0 FPS when idle) and settles back to idle automatically', () => {
    const callbacks: ((t: number) => void)[] = [];
    let currentTime = 1000;
    const scheduler = createDemandFrameScheduler(
      (cb) => {
        callbacks.push(cb);
        return callbacks.length;
      },
      () => {},
      () => currentTime,
    );

    let renders = 0;
    scheduler.subscribe(() => {
      renders++;
    });

    expect(scheduler.isIdle()).toBe(true);
    expect(scheduler.getFrameCount()).toBe(0);

    // Waking for camera movement schedules exactly 1 RAF
    scheduler.invalidate('camera');
    expect(scheduler.isIdle()).toBe(false);
    expect(callbacks.length).toBe(1);

    currentTime = 1016;
    callbacks.shift()!(currentTime);

    expect(renders).toBe(1);
    expect(scheduler.getFrameCount()).toBe(1);
    // Settled back to 0 FPS idle
    expect(scheduler.isIdle()).toBe(true);
    expect(callbacks.length).toBe(0);
  });

  it('projects token HUD pills into GPU translate3d transforms', () => {
    const proj = projectTokenHudTransform({
      mapX: 100,
      mapY: 200,
      tokenRadiusPx: 25,
      view: { x: 50, y: 20, scale: 2 },
    });
    expect(proj.screenX).toBe(250);
    expect(proj.screenY).toBe(482);
    expect(proj.transformCss).toBe('translate3d(250px, 482px, 0) translate(-50%, 0)');

    const mockSnapshot = {
      role: 'player',
      activeTurnTokenId: 'tok-1',
      characters: [
        {
          id: 'char-1',
          name: 'Druk',
          curHp: 0,
          maxHp: 44,
          tempHp: 0,
          conditions: [{ id: 'c1', label: 'Unconscious' }],
          deathSaves: { successes: 2, failures: 1 },
        },
      ],
      monsters: [],
      tokens: [
        {
          id: 'tok-1',
          mapId: 'm1',
          kind: 'pc',
          refId: 'char-1',
          x: 100,
          y: 200,
          widthFt: 5,
          shape: 'circle',
          isHidden: false,
          initiative: 15,
          inCombatEffective: true,
          carriedLantern: true,
        },
      ],
    } as unknown as StateSnapshot;

    const pills = buildTokenHudPills({
      snapshot: mockSnapshot,
      view: { x: 50, y: 20, scale: 2 },
      pxPerFoot: 10,
    });
    expect(pills).toHaveLength(1);
    expect(pills[0].deathSaveSuccesses).toBe(2);
    expect(pills[0].deathSaveFailures).toBe(1);
    expect(pills[0].carriedLantern).toBe(true);
    expect(pills[0].isActiveTurn).toBe(true);
  });
});
