import type { SheetAbility } from './types.js';
import { abilityKey } from './hitFeatures.js';

export type CombatSpellKey =
  | 'shield of faith'
  | 'mage armor'
  | 'blur'
  | 'see invisibility'
  | 'greater invisibility'
  | 'heroism'
  | 'protection from poison'
  | 'lesser restoration'
  | 'greater restoration'
  | 'spare the dying'
  | 'revivify'
  | 'death ward';

const COMBAT_SPELL_LEVELS: Record<CombatSpellKey, number> = {
  'spare the dying': 0,
  'shield of faith': 1,
  'mage armor': 1,
  heroism: 1,
  blur: 2,
  'see invisibility': 2,
  'protection from poison': 2,
  'lesser restoration': 2,
  revivify: 3,
  'greater invisibility': 4,
  'death ward': 4,
  'greater restoration': 5,
};

export const LESSER_RESTORATION_CONDITIONS = [
  'Blinded',
  'Deafened',
  'Paralyzed',
  'Poisoned',
] as const;

export const GREATER_RESTORATION_CONDITIONS = [
  'Auto (All Active Effects)',
  'Charmed',
  'Petrified',
  'Exhaustion (-1 Level)',
  'HP Maximum Reduction',
  'Curse / Attunement',
  'Ability Score Reduction',
] as const;

export const BLINDNESS_DEAFNESS_CHOICES = ['Blinded', 'Deafened'] as const;

/**
 * Runtime classifier for unchanged SRD/sheet combat buffs & restorations.
 * Custom, manual, or modified roll profiles opt out cleanly.
 */
export function combatSpell(a: Partial<SheetAbility>): CombatSpellKey | undefined {
  if (a.type !== 'spell' || a.source === 'custom' || a.executionProfile === 'manual') return;
  if (!a.name) return;
  const key = abilityKey({ name: a.name }) as CombatSpellKey;
  const expectedLevel = COMBAT_SPELL_LEVELS[key];
  if (expectedLevel === undefined || a.level !== expectedLevel) return;
  const r = a.roll;
  if (r) {
    if (
      r.kind !== 'damage' ||
      r.dice !== '0' ||
      r.scaleDice ||
      r.save ||
      r.dc ||
      r.saveDamage ||
      r.damageBonus ||
      (r.baseLevel !== undefined && r.baseLevel !== expectedLevel)
    ) {
      return;
    }
  }
  return key;
}

export function isSelfCombatSpell(a: Partial<SheetAbility>): boolean {
  if (a.roll?.customEffect?.target === 'self') return true;
  const k = combatSpell(a);
  return k === 'blur' || k === 'see invisibility';
}

export function isAllyTouchOrBuffSpell(a: Partial<SheetAbility>): boolean {
  const ce = a.roll?.customEffect;
  if (ce && (ce.target === 'ally' || (ce.target === undefined && (ce.aura === 'green' || (ce.cureConditions?.length ?? 0) > 0) && a.roll?.kind === 'damage' && (!a.roll.dice || a.roll.dice.trim() === '0')))) {
    return true;
  }
  const k = combatSpell(a);
  return k !== undefined && k !== 'blur' && k !== 'see invisibility';
}

export function spareTheDyingRangeFt(casterLevel: number): number {
  if (casterLevel >= 17) return 120;
  if (casterLevel >= 11) return 60;
  if (casterLevel >= 5) return 30;
  return 15;
}
