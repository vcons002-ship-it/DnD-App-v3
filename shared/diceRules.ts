import { advancedSpell } from './advancedSpells.js';
import { combatSpell } from './combatSpells.js';
import { isCommandSpell } from './commandSpell.js';
import { classLevelFor } from './multiclass.js';
import { partySpell } from './partySpells.js';
import { spellAreaFor } from './spellAreas.js';
import {
  effectiveSheetAbility,
  isMultiTargetSpell,
  spellDamageTypeChoices,
} from './spellExecution.js';
import { spellCombatSupport } from './spellSupport.js';
import type {
  AbilityRoll,
  Character,
  DiceRulesSpec,
  ExplodingDiceRule,
  MatchingDiceRule,
  MinFaceDiceRule,
  Monster,
  RerollDiceRule,
  SheetAbility,
  Weapon,
  WeaponTrigger,
} from './types.js';

type AbilityHolder =
  | Pick<Character, 'sheetAbilities' | 'level' | 'className' | 'leveling'>
  | Pick<Monster, 'sheetAbilities' | 'level'>
  | {
      sheetAbilities?: SheetAbility[];
      level?: number;
      className?: string;
      leveling?: Character['leveling'];
    }
  | undefined;

const norm = (s: string | undefined) => (s ?? '').replace(/[\u2018\u2019]/g, "'").trim().toLowerCase();

function barbarianLevelFor(creature: AbilityHolder): number {
  if (!creature) return 0;
  if ('className' in creature || 'leveling' in creature) {
    const lvl = classLevelFor(
      {
        className: 'className' in creature ? creature.className : undefined,
        level: creature.level ?? 0,
        leveling: 'leveling' in creature ? creature.leveling : undefined,
      },
      'barbarian',
    );
    if (lvl > 0) return lvl;
  }
  return creature.level ?? 0;
}

/** Racial Halfling Lucky (rerolls natural 1s on d20s), distinct from the 3/day Lucky feat. */
export function hasHalflingLucky(creature?: { sheetAbilities?: SheetAbility[] }): boolean {
  for (const ab of creature?.sheetAbilities ?? []) {
    const n = norm(ab.name);
    if (n !== 'lucky' && n !== 'halfling lucky') continue;
    const desc = norm(ab.description);
    const tags = (ab.tags ?? []).map((t) => norm(t));
    if (tags.includes('feat') || /\bluck point/.test(desc)) continue;
    if (
      n === 'halfling lucky' ||
      tags.includes('halfling') ||
      /\broll a 1\b/.test(desc) ||
      /\breroll the die and must use the new roll\b/.test(desc) ||
      ab.tags?.includes('d20')
    ) {
      return true;
    }
  }
  return false;
}

/** Critical natural d20 threshold (20 by default, lowered by Improved/Superior Critical or weapon/spell rules). */
export function detectCritThreshold(
  creature?: { sheetAbilities?: SheetAbility[] },
  weapon?: Pick<Weapon, 'critThreshold' | 'diceRules'>,
  roll?: Pick<AbilityRoll, 'diceRules'>,
): number {
  let threshold = 20;
  for (const ab of creature?.sheetAbilities ?? []) {
    const n = norm(ab.name);
    if (/\bsuperior critical\b/.test(n)) threshold = Math.min(threshold, 18);
    else if (/\bimproved critical\b/.test(n)) threshold = Math.min(threshold, 19);
  }
  if (typeof weapon?.critThreshold === 'number' && Number.isFinite(weapon.critThreshold)) {
    threshold = Math.min(threshold, Math.floor(weapon.critThreshold));
  }
  if (typeof weapon?.diceRules?.critThreshold === 'number' && Number.isFinite(weapon.diceRules.critThreshold)) {
    threshold = Math.min(threshold, Math.floor(weapon.diceRules.critThreshold));
  }
  if (typeof roll?.diceRules?.critThreshold === 'number' && Number.isFinite(roll.diceRules.critThreshold)) {
    threshold = Math.min(threshold, Math.floor(roll.diceRules.critThreshold));
  }
  return Math.max(2, Math.min(20, threshold));
}

export function mergeDiceRules(
  base?: DiceRulesSpec,
  extra?: DiceRulesSpec,
): DiceRulesSpec | undefined {
  if (!base && !extra) return undefined;
  const minA = base?.minFace;
  const minB = extra?.minFace;
  let minFace: MinFaceDiceRule | undefined = minA ?? minB;
  if (minA && minB) {
    minFace = minB.value >= minA.value ? minB : minA;
  }
  const critThreshold = [base?.critThreshold, extra?.critThreshold]
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
    .reduce((acc, v) => Math.min(acc, v), 20);
  const extraCritWeaponDice =
    (base?.extraCritWeaponDice ?? 0) + (extra?.extraCritWeaponDice ?? 0) || undefined;
  const merged: DiceRulesSpec = {
    ...(base?.exploding || extra?.exploding
      ? { exploding: extra?.exploding ?? base?.exploding }
      : {}),
    ...(base?.reroll || extra?.reroll
      ? { reroll: extra?.reroll ?? base?.reroll }
      : {}),
    ...(minFace ? { minFace } : {}),
    ...(base?.matchingDice || extra?.matchingDice
      ? { matchingDice: extra?.matchingDice ?? base?.matchingDice }
      : {}),
    ...(critThreshold < 20 ? { critThreshold } : {}),
    ...(extraCritWeaponDice ? { extraCritWeaponDice } : {}),
    ...(base?.extraCritDice || extra?.extraCritDice
      ? { extraCritDice: extra?.extraCritDice ?? base?.extraCritDice }
      : {}),
    ...(base?.extraCritDamageType || extra?.extraCritDamageType
      ? { extraCritDamageType: extra?.extraCritDamageType ?? base?.extraCritDamageType }
      : {}),
    ...(base?.extraCritLabel || extra?.extraCritLabel
      ? { extraCritLabel: extra?.extraCritLabel ?? base?.extraCritLabel }
      : {}),
  };
  return cleanDiceRules(merged);
}

/** Detect weapon-relevant SRD passives (Great Weapon Fighting, Brutal Critical) and merge with weapon.diceRules. */
export function detectWeaponPassiveRules(
  creature: AbilityHolder,
  weapon: Weapon,
  twoHanded?: boolean,
): {
  minFace?: MinFaceDiceRule;
  extraCritWeaponDice: number;
  extraCritLabels: string[];
  mergedRules?: DiceRulesSpec;
} {
  const tags = (weapon.tags ?? []).map((t) => norm(t));
  const qualifiesGwf =
    weapon.kind === 'melee' &&
    (tags.includes('two-handed') || (tags.includes('versatile') && !!twoHanded));

  let passiveMinFace: MinFaceDiceRule | undefined;
  let brutalCount = 0;
  const extraCritLabels: string[] = [];

  for (const ab of creature?.sheetAbilities ?? []) {
    const n = norm(ab.name);
    if (qualifiesGwf && /\bgreat weapon fighting\b/.test(n)) {
      passiveMinFace = { value: 3, label: 'Great Weapon Fighting' };
    }
    if (weapon.kind === 'melee' && /\bbrutal critical\b/.test(n)) {
      const descMatch = /\b(\d+|one|two|three)\s+additional\s+weapon\s+damage/i.exec(ab.description ?? '');
      let count = 1;
      if (descMatch) {
        const w = descMatch[1].toLowerCase();
        count = w === 'three' || w === '3' ? 3 : w === 'two' || w === '2' ? 2 : 1;
      } else {
        const lvl = barbarianLevelFor(creature);
        count = lvl >= 17 ? 3 : lvl >= 13 ? 2 : 1;
      }
      brutalCount += count;
      for (let i = 0; i < count; i++) extraCritLabels.push('Brutal Critical');
    }
  }

  const passiveSpec: DiceRulesSpec | undefined =
    passiveMinFace || brutalCount > 0
      ? {
          ...(passiveMinFace ? { minFace: passiveMinFace } : {}),
          ...(brutalCount > 0 ? { extraCritWeaponDice: brutalCount } : {}),
        }
      : undefined;

  const mergedRules = mergeDiceRules(passiveSpec, weapon.diceRules);
  return {
    minFace: mergedRules?.minFace,
    extraCritWeaponDice: brutalCount + (weapon.diceRules?.extraCritWeaponDice ?? 0),
    extraCritLabels,
    mergedRules,
  };
}

const ELEMENTAL_TYPES = ['acid', 'cold', 'fire', 'lightning', 'thunder'] as const;

/** Detect spell passives (Elemental Adept) matching the spell's resolved damage type. */
export function detectSpellPassiveRules(
  creature: { sheetAbilities?: SheetAbility[] } | undefined,
  damageType?: string,
  roll?: Pick<AbilityRoll, 'diceRules'>,
): {
  mergedRules?: DiceRulesSpec;
  ignoresResistance: boolean;
} {
  const dt = norm(damageType);
  let adeptFloor: MinFaceDiceRule | undefined;
  let ignoresResistance = false;

  if (dt) {
    for (const ab of creature?.sheetAbilities ?? []) {
      const n = norm(ab.name);
      if (!/\belemental adept\b/.test(n)) continue;
      const hay = `${n} ${norm(ab.description)}`;
      const matchesElement =
        hay.includes(dt) && (ELEMENTAL_TYPES as readonly string[]).includes(dt);
      const anyExplicitElement = ELEMENTAL_TYPES.some((t) => new RegExp(`\\b${t}\\b`).test(hay));
      if (matchesElement || (!anyExplicitElement && (ELEMENTAL_TYPES as readonly string[]).includes(dt))) {
        adeptFloor = { value: 2, damageType: dt, label: 'Elemental Adept' };
        ignoresResistance = true;
        break;
      }
    }
  }

  const passiveSpec: DiceRulesSpec | undefined = adeptFloor
    ? { minFace: adeptFloor }
    : undefined;
  return {
    mergedRules: mergeDiceRules(passiveSpec, roll?.diceRules),
    ignoresResistance,
  };
}

/** Expose canonical dice rules for recognizable shipped spells when inspecting or duplicating in the editor. */
export function canonicalDiceRulesForSpell(
  ability: Pick<SheetAbility, 'name' | 'roll'>,
): DiceRulesSpec | undefined {
  if (ability.roll?.diceRules) return ability.roll.diceRules;
  const key = norm(ability.name);
  if (key === 'sorcerous burst') {
    return {
      exploding: {
        on: 'max',
        limit: 'castingMod',
        recursive: true,
        label: 'Sorcerous Burst',
      },
    };
  }
  if (key === 'chromatic orb') {
    return {
      matchingDice: {
        minMatches: 2,
        action: 'leap',
        leapRangeFt: 30,
        maxLeaps: 'slotLevel',
        label: 'Chromatic Orb',
      },
    };
  }
  return undefined;
}

export function resolveRuleCap(
  cap: 'castingMod' | 'proficiency' | number | undefined,
  ctx: { castingMod?: number; proficiency?: number } = {},
  fallback = 10,
): number {
  if (cap === 'castingMod') return Math.max(0, ctx.castingMod ?? 0);
  if (cap === 'proficiency') return Math.max(1, ctx.proficiency ?? 2);
  if (typeof cap === 'number' && Number.isFinite(cap)) return Math.max(0, Math.floor(cap));
  return fallback;
}

export function matchesCreatureTypes(
  targetType: string | undefined,
  filters: string[] | undefined,
): boolean {
  if (!filters || !filters.length) return true;
  const hay = norm(targetType);
  if (!hay) return false;
  return filters.some((f) => {
    const needle = norm(f);
    return needle ? hay.includes(needle) : false;
  });
}

/** Determine whether a spell triggered by a weapon should auto-resolve immediately vs prompt the player/DM. */
export function isSimpleAutoCastSpell(
  ability: SheetAbility,
  castLevel?: number,
  presetDamageType?: string,
): boolean {
  const support = spellCombatSupport(ability);
  if (support?.manualCastOnly) return false;
  if (ability.summon) return false;
  if (isCommandSpell(ability)) return false;
  if (advancedSpell(ability) || partySpell(ability)) return false;
  const cSpell = combatSpell(ability);
  if (cSpell === 'lesser restoration' || cSpell === 'greater restoration') return false;
  if (spellAreaFor(ability, castLevel)) return false;
  if (isMultiTargetSpell(ability, castLevel)) return false;
  const choices = spellDamageTypeChoices(ability, castLevel);
  if (choices.length > 0 && !presetDamageType) return false;
  return Boolean(effectiveSheetAbility(ability, castLevel).roll);
}

function cleanExploding(r?: ExplodingDiceRule): ExplodingDiceRule | undefined {
  if (!r) return undefined;
  return {
    on: r.on === 'max' ? 'max' : Math.max(2, Math.floor(Number(r.on) || 2)),
    ...(r.bonusDice?.trim() ? { bonusDice: r.bonusDice.trim() } : {}),
    ...(r.limit !== undefined && r.limit !== '' as unknown ? { limit: r.limit } : {}),
    ...(r.recursive === false ? { recursive: false } : {}),
    ...(r.label?.trim() ? { label: r.label.trim() } : {}),
  };
}

function cleanReroll(r?: RerollDiceRule): RerollDiceRule | undefined {
  if (!r) return undefined;
  return {
    mode: r.mode === 'full-pool' ? 'full-pool' : 'die-lte',
    ...(r.mode !== 'full-pool'
      ? { maxFace: Math.max(1, Math.min(20, Math.floor(r.maxFace ?? 2))) }
      : {}),
    keep: r.keep === 'new' ? 'new' : 'higher',
    ...(r.maxDice !== undefined ? { maxDice: r.maxDice } : {}),
    ...(r.label?.trim() ? { label: r.label.trim() } : {}),
  };
}

function cleanMinFace(r?: MinFaceDiceRule): MinFaceDiceRule | undefined {
  if (!r || !Number.isFinite(r.value) || r.value < 2) return undefined;
  return {
    value: Math.min(20, Math.floor(r.value)),
    ...(r.damageType?.trim() ? { damageType: norm(r.damageType) } : {}),
    ...(r.label?.trim() ? { label: r.label.trim() } : {}),
  };
}

function cleanMatching(r?: MatchingDiceRule): MatchingDiceRule | undefined {
  if (!r) return undefined;
  return {
    ...(r.minMatches && r.minMatches > 2 ? { minMatches: Math.floor(r.minMatches) } : {}),
    action: r.action,
    ...(r.action === 'leap'
      ? {
          ...(r.leapRangeFt ? { leapRangeFt: Math.max(5, Math.floor(r.leapRangeFt)) } : {}),
          ...(r.maxLeaps !== undefined ? { maxLeaps: r.maxLeaps } : {}),
        }
      : {}),
    ...(r.action === 'bonus-dice' && r.bonusDice?.trim()
      ? {
          bonusDice: r.bonusDice.trim(),
          ...(r.bonusDamageType?.trim() ? { bonusDamageType: norm(r.bonusDamageType) } : {}),
        }
      : {}),
    ...(r.action === 'effect' && r.effect
      ? { effect: r.effect, ...(r.effectSave ? { effectSave: r.effectSave } : {}) }
      : {}),
    ...(r.label?.trim() ? { label: r.label.trim() } : {}),
  };
}

export function cleanDiceRules(rules?: DiceRulesSpec): DiceRulesSpec | undefined {
  if (!rules) return undefined;
  const exploding = cleanExploding(rules.exploding);
  const reroll = cleanReroll(rules.reroll);
  const minFace = cleanMinFace(rules.minFace);
  const matchingDice = cleanMatching(rules.matchingDice);
  const critThreshold =
    typeof rules.critThreshold === 'number' && rules.critThreshold >= 2 && rules.critThreshold < 20
      ? Math.floor(rules.critThreshold)
      : undefined;
  const extraCritWeaponDice =
    typeof rules.extraCritWeaponDice === 'number' && rules.extraCritWeaponDice > 0
      ? Math.min(10, Math.floor(rules.extraCritWeaponDice))
      : undefined;
  const extraCritDice = rules.extraCritDice?.trim() || undefined;
  const extraCritDamageType = extraCritDice && rules.extraCritDamageType?.trim()
    ? norm(rules.extraCritDamageType)
    : undefined;
  const extraCritLabel =
    (extraCritWeaponDice || extraCritDice) && rules.extraCritLabel?.trim()
      ? rules.extraCritLabel.trim()
      : undefined;

  if (
    !exploding &&
    !reroll &&
    !minFace &&
    !matchingDice &&
    !critThreshold &&
    !extraCritWeaponDice &&
    !extraCritDice
  ) {
    return undefined;
  }
  return {
    ...(exploding ? { exploding } : {}),
    ...(reroll ? { reroll } : {}),
    ...(minFace ? { minFace } : {}),
    ...(matchingDice ? { matchingDice } : {}),
    ...(critThreshold ? { critThreshold } : {}),
    ...(extraCritWeaponDice ? { extraCritWeaponDice } : {}),
    ...(extraCritDice ? { extraCritDice } : {}),
    ...(extraCritDamageType ? { extraCritDamageType } : {}),
    ...(extraCritLabel ? { extraCritLabel } : {}),
  };
}

export function hasActiveDiceRules(rules?: DiceRulesSpec): boolean {
  return Boolean(cleanDiceRules(rules));
}

export function formatDiceRulesSummary(rules?: DiceRulesSpec): string[] {
  const c = cleanDiceRules(rules);
  if (!c) return [];
  const chips: string[] = [];
  if (c.critThreshold && c.critThreshold < 20) chips.push(`Crit ${c.critThreshold}\u201320`);
  if (c.exploding) {
    const on = c.exploding.on === 'max' ? 'max face' : `face ${c.exploding.on}`;
    const bonus = c.exploding.bonusDice ? ` +${c.exploding.bonusDice}` : '';
    chips.push(`Explode on ${on}${bonus}`);
  }
  if (c.reroll) {
    if (c.reroll.mode === 'full-pool') {
      chips.push(`Reroll pool (${c.reroll.keep === 'higher' ? 'keep higher' : 'use new'})`);
    } else {
      chips.push(`Reroll \u2264${c.reroll.maxFace ?? 2} (${c.reroll.keep === 'higher' ? 'keep higher' : 'use new'})`);
    }
  }
  if (c.minFace) {
    chips.push(`Min die ${c.minFace.value}${c.minFace.damageType ? ` (${c.minFace.damageType})` : ''}`);
  }
  if (c.matchingDice) {
    if (c.matchingDice.action === 'leap') chips.push('Match: Bounce');
    else if (c.matchingDice.action === 'bonus-dice') chips.push(`Match: +${c.matchingDice.bonusDice || 'bonus'}`);
    else chips.push('Match: Effect');
  }
  if (c.extraCritWeaponDice) chips.push(`Crit +${c.extraCritWeaponDice} weapon die`);
  if (c.extraCritDice) chips.push(`Crit +${c.extraCritDice}${c.extraCritDamageType ? ` ${c.extraCritDamageType}` : ''}`);
  return chips;
}

const WHEN_LABELS: Record<WeaponTrigger['when'], string> = {
  'on-hit': 'On Hit',
  'on-crit': 'On Crit',
  'on-nat-20': 'On Nat 20',
  'on-d20-at-least': 'On d20 \u2265',
  'on-damage-max': 'On Max Die',
  'on-damage-match': 'On Matching Dice',
  'on-miss': 'On Miss',
};

export function formatWeaponTriggersSummary(triggers?: WeaponTrigger[]): string[] {
  return (triggers ?? [])
    .filter((t) => t.enabled !== false)
    .map((t) => {
      const when =
        t.when === 'on-d20-at-least'
          ? `d20 \u2265 ${t.d20Threshold ?? 19}`
          : WHEN_LABELS[t.when];
      const effects: string[] = [];
      if (t.extraDamageDice) effects.push(`+${t.extraDamageDice}${t.extraDamageType ? ` ${t.extraDamageType}` : ''}`);
      if (t.healDice) effects.push(`+${t.healDice} ${t.healMode === 'temporary' ? 'temp HP' : 'HP'}`);
      if (t.effect?.conditionLabel) effects.push(t.effect.conditionLabel);
      if (t.castSpell?.spellName) effects.push(`Cast ${t.castSpell.spellName}`);
      return `${t.name || when}: ${effects.join(', ') || when}`;
    });
}

/** True when an ability grants the Savage Attacker weapon damage reroll mechanic. */
export function isSavageAttackerAbility(
  a: Pick<SheetAbility, 'name' | 'type' | 'stance'>,
): boolean {
  return Boolean(a.stance?.rerollDamageDice) || norm(a.name) === 'savage attacker';
}

/**
 * True when an ability is pure Savage Attacker (no additional stance buffs like Rage
 * damage, Hunter's Mark targeting, or extra crit dice) so it belongs as a clickable
 * button on the damage tray rather than a persistent combat toggle.
 */
export function isStandaloneSavageAttacker(
  a: Pick<SheetAbility, 'name' | 'type' | 'stance'>,
): boolean {
  if (!isSavageAttackerAbility(a)) return false;
  const st = a.stance;
  if (!st) return true;
  return !(
    st.grantsAdvantage ||
    st.bonusDamage ||
    st.bonusDamageAtLevels?.length ||
    st.extraCritDie ||
    st.extraCritDiceCount ||
    st.targeted ||
    st.magicalAttacks ||
    st.onHitSave ||
    st.grantsResistances?.length ||
    st.advOnStrChecks ||
    st.enemiesHaveAdvantage
  );
}
