import { describe, expect, it } from 'vitest';
import { isOutdated } from '../../../shared/rulesUpdate';
import type { SheetAbility } from '../../../shared/types';
import {
  disambiguateCustomCopyName,
  finalizeCustomSpellCopy,
  restoreAbilityToRulesDefault,
} from './spellEditorHelpers';

describe('restoreAbilityToRulesDefault', () => {
  it('clears custom overrides and restores SRD mechanics while keeping identity, class, and casting ability', () => {
    const homebrewAid: SheetAbility = {
      id: 'aid-1',
      name: 'Aid',
      type: 'spell',
      level: 2,
      source: 'custom',
      executionProfile: 'manual',
      sourceClass: 'cleric',
      prepared: true,
      tags: ['abjuration', 'cleric', 'no-area'],
      description: 'My homebrew heal.',
      roll: {
        kind: 'heal',
        dice: '1d4',
        damageType: 'healing',
        healingBonus: 'none',
        castingAbility: 'INT',
        customEffect: { conditionLabel: 'Homebrew Aid', acBonus: 2 },
      },
      smite: { dice: '2d8', damageType: 'radiant' },
      summon: { name: 'Helper', icon: '✋' },
    };

    const srdAid: Partial<SheetAbility> = {
      name: 'Aid',
      type: 'spell',
      level: 2,
      school: 'Abjuration',
      classes: ['cleric', 'paladin', 'ranger'],
      tags: ['abjuration', 'cleric', 'paladin', 'ranger', 'healing'],
      meta: '1 action · 30 ft · V,S,M',
      description: 'Boost up to three allies max HP and current HP by 5 (+5 per slot above 2nd).',
      source: 'srd',
    };

    const restored = restoreAbilityToRulesDefault(homebrewAid, srdAid, {
      sourceClass: 'cleric',
      prepared: true,
    });

    expect(restored.id).toBe('aid-1');
    expect(restored.source).toBe('srd');
    expect(restored.executionProfile).toBeUndefined();
    expect(restored.sourceClass).toBe('cleric');
    expect(restored.prepared).toBe(true);
    expect(restored.roll).toBeUndefined();
    expect(restored.smite).toBeUndefined();
    expect(restored.summon).toBeUndefined();
    expect(restored.tags).not.toContain('no-area');
    expect(restored.description).toBe(srdAid.description);
    expect(isOutdated(restored, srdAid)).toBe(false);
  });

  it('restores Chromatic Orb roll and derives class castingAbility without triggering outdated badge', () => {
    const hackedOrb: SheetAbility = {
      id: 'orb-1',
      name: 'Chromatic Orb',
      type: 'spell',
      level: 1,
      source: 'custom',
      executionProfile: 'manual',
      sourceClass: 'sorcerer',
      prepared: true,
      description: 'Custom cold orb.',
      roll: {
        kind: 'attack',
        dice: '5d8',
        damageType: 'cold',
        castingAbility: 'INT',
      },
    };

    const srdOrb: Partial<SheetAbility> = {
      name: 'Chromatic Orb',
      type: 'spell',
      level: 1,
      school: 'Evocation',
      meta: '1 action · 90 ft · V,S,M',
      description: 'Make a ranged spell attack dealing 3d8 of a chosen elemental damage type.',
      roll: { kind: 'attack', dice: '3d8', scaleDice: '1d8', baseLevel: 1 },
      source: 'srd',
    };

    const restored = restoreAbilityToRulesDefault(hackedOrb, srdOrb, {
      sourceClass: 'sorcerer',
      prepared: false,
    });

    expect(restored.source).toBe('srd');
    expect(restored.executionProfile).toBeUndefined();
    expect(restored.prepared).toBe(false);
    expect(restored.roll).toEqual({
      kind: 'attack',
      dice: '3d8',
      scaleDice: '1d8',
      baseLevel: 1,
      castingAbility: 'CHA',
    });
    expect(isOutdated(restored, srdOrb)).toBe(false);
  });
});

describe('custom copy helpers', () => {
  it('appends (Custom) and increments numeric suffixes only on collision', () => {
    expect(disambiguateCustomCopyName('Fireball', 'Fireball', ['Fireball', 'Shield'])).toBe(
      'Fireball (Custom)',
    );
    expect(
      disambiguateCustomCopyName('Fireball', 'Fireball', ['Fireball', 'Fireball (Custom)']),
    ).toBe('Fireball (Custom 2)');
    expect(
      disambiguateCustomCopyName('Fireball (Custom)', 'Fireball', ['Fireball', 'Fireball (Custom)']),
    ).toBe('Fireball (Custom 2)');
    expect(disambiguateCustomCopyName('Frostball', 'Fireball', ['Fireball', 'Shield'])).toBe(
      'Frostball',
    );
  });

  it('builds an independent custom/manual copy with a fresh id', () => {
    const draft: SheetAbility = {
      id: 'orig-id',
      name: 'Fireball',
      type: 'spell',
      level: 3,
      source: 'srd',
      description: 'Cold blast.',
      roll: { kind: 'save', dice: '8d6', save: 'DEX', damageType: 'cold' },
    };

    const copy = finalizeCustomSpellCopy(draft, 'Fireball', ['Fireball', 'Fireball (Custom)'], 'copy-123');
    expect(copy.id).toBe('copy-123');
    expect(copy.name).toBe('Fireball (Custom 2)');
    expect(copy.source).toBe('custom');
    expect(copy.executionProfile).toBe('manual');
    expect(draft.id).toBe('orig-id');
  });
});
