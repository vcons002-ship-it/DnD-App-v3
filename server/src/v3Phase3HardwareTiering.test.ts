import { describe, expect, it } from 'vitest';
import {
  classifyHardwareBenchmark,
  graphicsBudget,
} from '../../shared/graphicsQuality.js';
import { createWebglRecoveryTracker } from '../../shared/webglRecoveryState.js';

describe('Phase 3 — Automatic Hardware Tiering & WebGL Context Recovery', () => {
  it('enforces Tier 1 (Laptop / Battery Saver), Tier 2 (Balanced), and Tier 3 (Ultra) budgets', () => {
    const tier1 = graphicsBudget('low');
    const tier2 = graphicsBudget('balanced');
    const tier3 = graphicsBudget('high');

    expect(tier1).toMatchObject({
      hardwareTier: 'tier1',
      hardwareTierLabel: 'Laptop / Battery Saver',
      frameloop: 'demand',
      activeSceneFps: 30,
      maxMapTextureResolutionPx: 2048,
      maxMeshTriangles: 5000,
      visionPassMode: 'stencil2d',
      tokenRenderMode: 'decimated-or-2d',
      animatedSpellShaders: false,
    });

    expect(tier2).toMatchObject({
      hardwareTier: 'tier2',
      hardwareTierLabel: 'Balanced',
      frameloop: 'demand',
      activeSceneFps: 60,
      maxMapTextureResolutionPx: 4096,
      maxMeshTriangles: 25000,
      visionPassMode: 'dynamic2d',
      tokenRenderMode: 'battlefield-lod',
      animatedSpellShaders: false,
      full3dDicePhysics: true,
    });

    expect(tier3).toMatchObject({
      hardwareTier: 'tier3',
      hardwareTierLabel: 'Ultra',
      frameloop: 'demand',
      activeSceneFps: 60,
      maxMapTextureResolutionPx: 8192,
      maxMeshTriangles: 100000,
      visionPassMode: 'ultra3d',
      tokenRenderMode: 'hero-3d',
      animatedSpellShaders: true,
      full3dDicePhysics: true,
    });
  });

  it('classifies startup hardware benchmark samples across integrated laptops and discrete GPUs', () => {
    expect(
      classifyHardwareBenchmark({
        avgFps: 58,
        p95FrameMs: 18,
        rendererString: 'Intel(R) HD Graphics 520',
      }),
    ).toBe('low');

    expect(
      classifyHardwareBenchmark({
        avgFps: 60,
        p95FrameMs: 16.7,
        batterySaver: true,
      }),
    ).toBe('low');

    expect(
      classifyHardwareBenchmark({
        avgFps: 45,
        p95FrameMs: 24,
        rendererString: 'Apple M1',
      }),
    ).toBe('balanced');

    expect(
      classifyHardwareBenchmark({
        avgFps: 60,
        p95FrameMs: 16.6,
        maxTextureSize: 16384,
        rendererString: 'NVIDIA GeForce RTX 4070',
      }),
    ).toBe('high');
  });

  it('handles WebGL context loss and automatic restoration lifecycle and recommends Tier 1 after repeated losses', () => {
    const events: string[] = [];
    const tracker = createWebglRecoveryTracker({
      onContextLost: (s) => events.push(`lost:${s.lossCount}`),
      onContextRestored: (s) => events.push(`restored:${s.restoreCount}`),
    });

    let prevented = false;
    const lost1 = tracker.handleContextLost(1000, () => {
      prevented = true;
    });
    expect(prevented).toBe(true);
    expect(lost1.status).toBe('lost');
    expect(lost1.recommendedTierOverride).toBeNull();

    const restored1 = tracker.handleContextRestored(1500);
    expect(restored1.status).toBe('restored');
    expect(restored1.restoreCount).toBe(1);

    // Second loss within 2 minutes triggers Tier 1 (low) recommendation
    const lost2 = tracker.handleContextLost(30_000);
    expect(lost2.recommendedTierOverride).toBe('low');
    expect(events).toEqual(['lost:1', 'restored:1', 'lost:2']);
  });
});
