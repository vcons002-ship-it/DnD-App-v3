import { describe, expect, it } from 'vitest';
import {
  abbreviateCrowdName,
  computeTokenCrowdLayout,
  type CrowdTokenInput,
} from '../../client/src/lib/tokenCrowdLayout.js';

function makeToken(overrides: Partial<CrowdTokenInput> & { id: string; x: number; y: number }): CrowdTokenInput {
  return {
    radius: 20,
    name: 'Goblin Archer',
    kind: 'monster',
    hpFrac: 1,
    hasInitiative: true,
    isDead: false,
    isObject: false,
    selected: false,
    hovered: false,
    activeTurn: false,
    targeted: false,
    ...overrides,
  };
}

describe('tokenCrowdLayout', () => {
  it('keeps well-spaced tokens unclustered and preserves cached 2D HUD by default', () => {
    const tokens = [
      makeToken({ id: 'a', x: 100, y: 100, name: 'Druk', kind: 'pc' }),
      makeToken({ id: 'b', x: 350, y: 100, name: 'Goblin', kind: 'monster' }),
    ];
    const map = computeTokenCrowdLayout(tokens, {
      viewRotation: 0,
      labelDensity: 'smart',
      hpDisplay: 'arc',
      showHpNumbers: true,
      peekAll: false,
    });
    const a = map.get('a')!;
    const b = map.get('b')!;
    expect(a.inCrowd).toBe(false);
    expect(b.inCrowd).toBe(false);
    expect(a.placement).toBe('below');
    expect(a.yNudge).toBe(0);
    expect(a.hudOpacity).toBe(1);
    expect(a.showExactHp).toBe(true);
    expect(a.useLiveHud).toBe(false);
  });

  it('detects melee crowds and flips the upper token label above when blocked south', () => {
    const tokens = [
      makeToken({ id: 'north', x: 100, y: 100, name: 'Dwarf Paladin 1' }),
      makeToken({ id: 'south', x: 102, y: 144, name: 'Goblin 1' }),
    ];
    const map = computeTokenCrowdLayout(tokens, {
      viewRotation: 0,
      labelDensity: 'smart',
      hpDisplay: 'arc',
      showHpNumbers: true,
      peekAll: false,
    });
    expect(map.get('north')!.inCrowd).toBe(true);
    expect(map.get('south')!.inCrowd).toBe(true);
    expect(map.get('north')!.placement).toBe('above');
    expect(map.get('south')!.placement).toBe('below');
  });

  it('flips crowd labels in camera-upright coordinates when the battlefield is rotated 90° or 180°', () => {
    // At 180° rotation, north/south are inverted on screen, so the token at y=144 is now on top!
    const tokens = [
      makeToken({ id: 'a', x: 100, y: 100 }),
      makeToken({ id: 'b', x: 100, y: 144 }),
    ];
    const rot180 = computeTokenCrowdLayout(tokens, {
      viewRotation: 180,
      labelDensity: 'smart',
      hpDisplay: 'arc',
      showHpNumbers: true,
      peekAll: false,
    });
    expect(rot180.get('b')!.placement).toBe('above');
    expect(rot180.get('a')!.placement).toBe('below');

    // At 90° rotation, screen-south is +X in world space:
    // sy = dx * sin(90°) + dy * cos(90°) = dx, so token at x=100 has neighbor at x=144 directly south.
    const horiz = [
      makeToken({ id: 'left', x: 100, y: 100 }),
      makeToken({ id: 'right', x: 144, y: 100 }),
    ];
    const rot90 = computeTokenCrowdLayout(horiz, {
      viewRotation: 90,
      labelDensity: 'smart',
      hpDisplay: 'arc',
      showHpNumbers: true,
      peekAll: false,
    });
    expect(rot90.get('left')!.placement).toBe('above');
    expect(rot90.get('right')!.placement).toBe('below');
  });

  it('spotlights hovered/selected/active-turn/targeted tokens and dims overlapping melee neighbors', () => {
    const tokens = [
      makeToken({ id: 'focus', x: 100, y: 100, hovered: true, name: 'Revenant Captain 1' }),
      makeToken({ id: 'peer', x: 140, y: 102, name: 'Revenant Captain 2' }),
      makeToken({ id: 'far', x: 420, y: 100, name: 'Varis', kind: 'pc' }),
    ];
    const smart = computeTokenCrowdLayout(tokens, {
      viewRotation: 0,
      labelDensity: 'smart',
      hpDisplay: 'arc',
      showHpNumbers: true,
      peekAll: false,
    });
    expect(smart.get('focus')!.hudOpacity).toBe(1);
    expect(smart.get('focus')!.showExactHp).toBe(true);
    expect(smart.get('focus')!.shortName).toBeUndefined();
    expect(smart.get('peer')!.dimmed).toBe(true);
    expect(smart.get('peer')!.hudOpacity).toBeCloseTo(0.28, 2);
    expect(smart.get('peer')!.showExactHp).toBe(false);
    expect(smart.get('peer')!.shortName).toBeDefined();
    expect(smart.get('far')!.dimmed).toBe(false);
    expect(smart.get('far')!.hudOpacity).toBe(1);
  });

  it('separates colliding side-by-side labels with yNudge while keeping focused tokens anchored', () => {
    const tokens = [
      makeToken({ id: 'a', x: 100, y: 100, selected: true, name: 'Hobgoblin Guard 1' }),
      makeToken({ id: 'b', x: 132, y: 100, name: 'Hobgoblin Guard 2' }),
    ];
    const map = computeTokenCrowdLayout(tokens, {
      viewRotation: 0,
      labelDensity: 'full',
      hpDisplay: 'arc',
      showHpNumbers: true,
      peekAll: false,
    });
    expect(map.get('a')!.yNudge).toBe(0);
    expect(map.get('b')!.yNudge).toBeGreaterThan(0);
  });

  it('hides unfocused names in minimal mode and reveals everything during Alt peekAll', () => {
    const tokens = [
      makeToken({ id: 'a', x: 100, y: 100, activeTurn: true }),
      makeToken({ id: 'b', x: 140, y: 100 }),
    ];
    const minimal = computeTokenCrowdLayout(tokens, {
      viewRotation: 0,
      labelDensity: 'minimal',
      hpDisplay: 'arc',
      showHpNumbers: true,
      peekAll: false,
    });
    expect(minimal.get('a')!.showName).toBe(true);
    expect(minimal.get('a')!.showExactHp).toBe(true);
    expect(minimal.get('b')!.showName).toBe(false);
    expect(minimal.get('b')!.showHp).toBe(true);
    expect(minimal.get('b')!.showExactHp).toBe(false);

    const peek = computeTokenCrowdLayout(tokens, {
      viewRotation: 0,
      labelDensity: 'minimal',
      hpDisplay: 'arc',
      showHpNumbers: true,
      peekAll: true,
    });
    expect(peek.get('b')!.showName).toBe(true);
    expect(peek.get('b')!.showExactHp).toBe(true);
    expect(peek.get('b')!.hudOpacity).toBe(1);
    expect(peek.get('b')!.shortName).toBeUndefined();
  });

  it('abbreviates duplicate numbered monster names cleanly without ellipses in melee clusters', () => {
    expect(abbreviateCrowdName('Dwarf Paladin 2', false, 3, false)).toBe('DP 2');
    expect(abbreviateCrowdName('Dwarf Paladin 2', true, 3, false)).toBe('DP');
    expect(abbreviateCrowdName('Goblin 3', false, 3, false)).toBe('Gob 3');
    expect(abbreviateCrowdName('Ancient Red Dragon', false, 1, true)).toBe('Ancient Red D');
    expect(abbreviateCrowdName('Goblin', true, 1, false)).toBeUndefined();
  });
});
