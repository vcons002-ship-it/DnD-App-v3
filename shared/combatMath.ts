// Derived 5e combat math: proficiency, attack/damage rolls, saves. Pure +
// framework-free so the server resolves authoritatively and it's unit-tested.
import type { DiceRulesSpec, Weapon } from './types.js';
import { abilityMod, proficiencyBonus, signed } from './skills.js';
import { rollDice, rollDicePool, withDiceMetadata, type WeaponTrayDiePlan } from './dice.js';
import { DAMAGE_TYPES } from './damage.js';
import type { Advantage } from './dice.js';
import { resolveRuleCap } from './diceRules.js';

// Single source of truth is the dice module; re-exported so combat callers can
// keep importing `Advantage` from here.
export type { Advantage };

/** A creature reduced to what combat math needs. `level` is PC level or CR. */
export type Combatant = {
  stats: Record<string, number>;
  level: number;
  isMonster: boolean;
};


/**
 * Roll a d20 honoring advantage/disadvantage (and optional Halfling Lucky
 * automatic natural-1 reroll in the same live tray), returning the chosen face
 * plus a display breakdown: `d20[a,b]→adv face` or `d20[a]`.
 */
export function rollD20Detail(
  advantage?: Advantage,
  opts?: { halflingLucky?: boolean; luckyLabel?: string },
): { face: number; detail: string; luckyRerolled?: { from: number; to: number } } {
  if (!opts?.halflingLucky) {
    const rolled = rollDice('1d20', advantage)!;
    const pool = advantage
      ? [...rolled.detail.matchAll(/1d20\[(\d+)\]/g)].map((m) => Number(m[1]))
      : rolled.rolls;
    const a = pool[0];
    if (!advantage) return { face: a, detail: `d20[${a}]` };
    const b = pool[1];
    const face = advantage === 'adv' ? Math.max(a, b) : Math.min(a, b);
    return { face, detail: `d20[${a},${b}]\u2192${advantage} ${face}` };
  }
  const luckyLabel = opts.luckyLabel || 'Halfling Lucky';
  const plannedDice: WeaponTrayDiePlan[] = advantage
    ? [{ sides: 20, set: 0 }, { sides: 20, set: 1 }, { sides: 20, set: 2 }]
    : [{ sides: 20, set: 0 }, { sides: 20, set: 1 }];
  const baseTray = {
    phase: 'initial' as const,
    weaponName: luckyLabel,
    damageExpr: '1d20',
    crit: false,
    plannedDice,
    setCount: advantage ? 2 : 1,
    hasReroll: false,
    hasExtraCrit: false,
    luckyLabel,
  };
  const rolled = withDiceMetadata({ weaponTray: baseTray }, () => rollDice('1d20', advantage)!);
  const pool = advantage
    ? [...rolled.detail.matchAll(/1d20\[(\d+)\]/g)].map((m) => Number(m[1]))
    : rolled.rolls.slice();
  const oneIdx = pool.findIndex((v) => v === 1);
  if (oneIdx < 0) {
    if (!advantage) return { face: pool[0], detail: `d20[${pool[0]}]` };
    const [a, b] = pool;
    const face = advantage === 'adv' ? Math.max(a, b) : Math.min(a, b);
    return { face, detail: `d20[${a},${b}]\u2192${advantage} ${face}` };
  }
  const reroll = withDiceMetadata(
    {
      label: `${luckyLabel} Reroll`,
      weaponTray: { ...baseTray, phase: 'lucky-reroll' as const, luckySourceIndex: oneIdx },
    },
    () => rollDice('1d20')!,
  );
  const newFace = reroll.rolls[0];
  if (!advantage) {
    return {
      face: newFace,
      detail: `d20[1\u2192${newFace} Lucky]`,
      luckyRerolled: { from: 1, to: newFace },
    };
  }
  const updated = pool.slice();
  updated[oneIdx] = newFace;
  const face = advantage === 'adv' ? Math.max(updated[0], updated[1]) : Math.min(updated[0], updated[1]);
  const poolStr = pool.map((v, i) => (i === oneIdx ? `1\u2192${newFace} Lucky` : `${v}`)).join(',');
  return {
    face,
    detail: `d20[${poolStr}]\u2192${advantage} ${face}`,
    luckyRerolled: { from: 1, to: newFace },
  };
}

/** Monster proficiency bonus by challenge rating (CR 0–4 → +2, 5–8 → +3, …). */
export const profBonusForCR = (cr: number): number =>
  Math.max(2, Math.ceil(Math.max(0, cr) / 4) + 1);

export const profBonusFor = (c: Combatant): number =>
  c.isMonster ? profBonusForCR(c.level) : proficiencyBonus(c.level || 1);

const ABILITY_CODES = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'] as const;
type AbilityCode = (typeof ABILITY_CODES)[number];

/**
 * The ability a weapon attacks/damages with. An explicit `attackAbility` override
 * wins (e.g. WIS for Shillelagh, or a custom/magic weapon); otherwise ranged → DEX,
 * a `finesse` melee → the better of STR/DEX, and other melee → STR.
 */
function weaponAbility(c: Combatant, w: Weapon): AbilityCode {
  const override = w.attackAbility?.toUpperCase() as AbilityCode | undefined;
  if (override && ABILITY_CODES.includes(override)) return override;
  if (w.kind === 'ranged') return 'DEX';
  const finesse = (w.tags ?? []).some((t) => t.trim().toLowerCase() === 'finesse');
  if (finesse) return abilityMod(c.stats.DEX) > abilityMod(c.stats.STR) ? 'DEX' : 'STR';
  return 'STR';
}

/** A weapon's to-hit: the tagged value if present, else ability mod + prof. */
export function weaponAttackBonus(c: Combatant, w: Weapon): number {
  if (typeof w.attackBonus === 'number') return w.attackBonus;
  return abilityMod(c.stats[weaponAbility(c, w)]) + profBonusFor(c);
}

/**
 * A weapon's to-hit AS A LABELLED BREAKDOWN for the roll log, e.g.
 * `+3[STR] +2[PROF]` when derived from live stats, or `+5[hit]` when a fixed
 * `attackBonus` overrides it. Mirrors the damage breakdown so the to-hit math is
 * transparent; `bonus` equals what `weaponAttackBonus` returns.
 */
export function weaponAttackBonusDetail(
  c: Combatant,
  w: Weapon,
): { bonus: number; detail: string; parts: { label: string; value: number }[] } {
  if (typeof w.attackBonus === 'number')
    return {
      bonus: w.attackBonus,
      detail: `${signed(w.attackBonus)}[hit]`,
      parts: w.attackBonus ? [{ label: 'hit', value: w.attackBonus }] : [],
    };
  const ability = weaponAbility(c, w);
  const abil = abilityMod(c.stats[ability]);
  const prof = profBonusFor(c);
  return {
    bonus: abil + prof,
    detail: `${signed(abil)}[${ability}] ${signed(prof)}[PROF]`,
    parts: [
      ...(abil ? [{ label: ability, value: abil }] : []),
      { label: 'PROF', value: prof },
    ],
  };
}

/** The ability modifier a weapon uses to attack (STR/DEX per the rules above). */
export function weaponAbilityMod(c: Combatant, w: Weapon): number {
  return abilityMod(c.stats[weaponAbility(c, w)]);
}

/** Split "1d8+3" into its dice expression and flat modifier. */
export function damageParts(expr: string): { dice: string; flat: number } {
  const cleaned = expr.replace(/\s+/g, '');
  let dice = '';
  const diceRe = /([+-]?)(\d*)d(\d+)/gi;
  let m: RegExpExecArray | null;
  while ((m = diceRe.exec(cleaned))) {
    dice += `${m[1] || '+'}${m[2] || '1'}d${m[3]}`;
  }
  let flat = 0;
  const noDice = cleaned.replace(/([+-]?)(\d*)d(\d+)/gi, '');
  const flatRe = /([+-]?\d+)/g;
  while ((m = flatRe.exec(noDice))) flat += parseInt(m[1], 10);
  return { dice: dice.replace(/^\+/, ''), flat };
}

/** Parse the die sizes from an expression such as "2d6+1d4+3" -> [6, 6, 4]. */
export function parseDiceSides(expr: string): number[] {
  const out: number[] = [];
  for (const m of expr.replace(/\s+/g, '').matchAll(/(\d*)d(\d+)/gi)) {
    const count = Number(m[1] || 1), sides = Number(m[2]);
    for (let i = 0; i < count; i++) out.push(sides);
  }
  return out;
}

/** One labelled term in an attack's reveal breakdown (mirrors `RollReveal`'s
 *  `RevealStep`, kept local so `shared/combatMath` needn't import the big types). */
export type AttackStep = {
  label: string;
  value: number;
  faces?: number[];
  diceExpression?: string;
  critical?: boolean;
  source?: string;
  rawFaces?: number[];
  floorLabel?: string;
};

export type RuledDicePoolResult = {
  total: number;
  steps: AttackStep[];
  parts: string[];
  notes: string[];
  /** Kept primary + crit + exploded faces (excluding riders) for downstream match/max checks. */
  keptFaces: number[];
  keptSides: number[];
  damageMaxHit: boolean;
  damageHasMatch: boolean;
  matchingFaces: number[];
  /** Present when custom `extraCritDice` uses a different damage type than the weapon/spell. */
  extraCritTyped?: { total: number; damageType: string; steps: AttackStep[]; parts: string[] };
  /** Present when `matchingDice.action === 'bonus-dice'` fired. */
  matchingBonus?: { total: number; damageType?: string; steps: AttackStep[]; parts: string[]; label: string; faces: number[] };
  usedWeaponTray: boolean;
  usedReroll?: boolean;
  baseTrayInfo?: import('./dice.js').WeaponTrayInfo;
};

function findMatchingValues(faces: number[], minMatches = 2): number[] {
  const counts = new Map<number, number>();
  for (const f of faces) counts.set(f, (counts.get(f) ?? 0) + 1);
  return [...counts].filter(([, c]) => c >= Math.max(2, minMatches)).map(([v]) => v);
}

/**
 * Shared dice-pool executor supporting:
 * - Savage Attacker (`full-pool` reroll) & custom pool rerolls
 * - Individual low-die rerolls (`die-lte`, e.g. Empowered Spell)
 * - Minimum face floors (Great Weapon Fighting `1,2→3`, Elemental Adept `1→2`)
 * - Exploding dice (`exploding`, arbitrary face/size/cap/recursive)
 * - Extra critical weapon dice (Savage Attacks, Brutal Critical, custom crit dice)
 * - Matching-dice bonus dice (`matchingDice.action === 'bonus-dice'`)
 * - Pre-planned downstream rider slots so weapon triggers continue in the SAME continuous tray!
 */
export function rollRuledDamagePool(params: {
  title: string;
  diceExpr: string;
  critExpr?: string;
  crit: boolean;
  damageType?: string;
  diceRules?: DiceRulesSpec;
  rerollDamageDice?: boolean;
  rerollDamageLabel?: string;
  interactiveReroll?: boolean;
  chooseReroll?: (info: { label: string; rollTotal: number; diceSummary: string }) => boolean;
  extraCritWeaponDice?: number;
  extraCritDieLabel?: string;
  extraCritLabels?: string[];
  castingMod?: number;
  proficiency?: number;
  extraPlannedDice?: WeaponTrayDiePlan[];
  fastPathLabel?: string;
}): RuledDicePoolResult {
  const {
    title,
    diceExpr,
    critExpr,
    crit,
    damageType,
    diceRules,
    castingMod,
    proficiency,
    extraPlannedDice,
  } = params;
  const baseSides = diceExpr ? parseDiceSides(diceExpr) : [];
  const effectiveCritExpr = crit ? (critExpr ?? diceExpr) : '';
  const critSides = effectiveCritExpr ? parseDiceSides(effectiveCritExpr) : [];
  const weaponDieSides = baseSides[0] ?? 0;

  const extraWeaponCritCount = crit
    ? Math.max(0, (params.extraCritWeaponDice ?? 0) + (diceRules?.extraCritWeaponDice ?? 0))
    : 0;
  const extraWeaponCritSides = Array(extraWeaponCritCount)
    .fill(weaponDieSides)
    .filter((s) => s > 0);
  const customExtraCritExpr = crit ? diceRules?.extraCritDice?.trim() || '' : '';
  const customExtraCritSides = customExtraCritExpr ? parseDiceSides(customExtraCritExpr) : [];
  const weaponPoolSides = [...baseSides, ...critSides, ...extraWeaponCritSides];
  // Savage Attacker / weapon-pool rules operate across all weapon damage dice
  // (base + critical doubled + Savage Attacks / Brutal Critical weapon dice).
  const allInitialSides = weaponPoolSides;
  const hasExtraCrit = extraWeaponCritSides.length > 0 || customExtraCritSides.length > 0;
  const extraCritLabels: string[] = [
    ...Array.from({ length: extraWeaponCritSides.length }, (_, i) =>
      params.extraCritLabels?.[i] ?? diceRules?.extraCritLabel ?? params.extraCritDieLabel ?? 'Savage Attacks',
    ),
    ...customExtraCritSides.map(() => diceRules?.extraCritLabel || 'Critical Bonus'),
  ];
  const weaponExtraLabels = extraCritLabels.slice(0, extraWeaponCritSides.length);
  const customExtraLabels = extraCritLabels.slice(extraWeaponCritSides.length);
  const primaryExtraLabel =
    weaponExtraLabels.length === 1
      ? weaponExtraLabels[0]
      : [...new Set(extraCritLabels)].join(' & ') || 'Extra Crit Dice';

  const rerollRule =
    diceRules?.reroll ??
    (params.rerollDamageDice && baseSides.length > 0
      ? { mode: 'full-pool' as const, keep: 'higher' as const, label: params.rerollDamageLabel || 'Savage Attacker' }
      : undefined);
  const fullPoolReroll = rerollRule?.mode === 'full-pool' && allInitialSides.length > 0;
  const lowDieReroll = rerollRule?.mode === 'die-lte' && allInitialSides.length > 0;
  const rerollLabel = rerollRule?.label || params.rerollDamageLabel || 'Savage Attacker';

  const minFaceRule =
    diceRules?.minFace &&
    diceRules.minFace.value >= 2 &&
    (!diceRules.minFace.damageType ||
      !damageType ||
      diceRules.minFace.damageType.toLowerCase() === damageType.toLowerCase())
      ? diceRules.minFace
      : undefined;
  const explodingRule = diceRules?.exploding;
  const matchRule = diceRules?.matchingDice;

  const capCtx = { castingMod, proficiency };
  const needsRulesTray = Boolean(
    fullPoolReroll ||
      lowDieReroll ||
      hasExtraCrit ||
      minFaceRule ||
      explodingRule ||
      matchRule?.action === 'bonus-dice' ||
      (extraPlannedDice && extraPlannedDice.length > 0),
  );

  // Fast path: preserve identical single rollDicePool when no special rules or planned riders exist.
  if (!needsRulesTray || !diceExpr) {
    const fastLabel = params.fastPathLabel ?? `${title} — ${crit ? 'Critical Damage' : 'Damage'}`;
    const [r1, r2] = diceExpr
      ? withDiceMetadata({ label: fastLabel }, () =>
          rollDicePool([{ expr: diceExpr }, ...(effectiveCritExpr ? [{ expr: effectiveCritExpr, critical: true }] : [])]),
        )
      : [];
    const steps: AttackStep[] = [];
    const parts: string[] = [];
    let total = 0;
    const rawFaces: number[] = [];
    if (r1) {
      total += r1.total;
      parts.push(`${diceExpr}[${r1.rolls.join(',')}]`);
      steps.push({ label: diceExpr, value: r1.total, faces: r1.rolls });
      rawFaces.push(...r1.rolls);
    }
    if (crit && effectiveCritExpr && r2) {
      total += r2.total;
      parts.push(`+[${r2.rolls.join(',')}][CRIT]`);
      steps.push({ label: 'CRIT', value: r2.total, faces: r2.rolls, diceExpression: effectiveCritExpr });
      rawFaces.push(...r2.rolls);
    }
    const maxHit = rawFaces.some((f, i) => f === (allInitialSides[i] ?? 0) && allInitialSides[i] > 0);
    const matches = findMatchingValues(rawFaces, matchRule?.minMatches ?? 2);
    return {
      total,
      steps,
      parts,
      notes: [],
      keptFaces: rawFaces,
      keptSides: allInitialSides,
      damageMaxHit: maxHit,
      damageHasMatch: matches.length > 0,
      matchingFaces: matches,
      usedWeaponTray: false,
    };
  }

  const uniformInitial = new Set(allInitialSides).size <= 1;
  const setCount = allInitialSides.length;
  const explodeCap = explodingRule ? Math.min(20, resolveRuleCap(explodingRule.limit, capCtx, 6)) : 0;
  const explodeBonusSides = explodingRule
    ? explodingRule.bonusDice
      ? parseDiceSides(explodingRule.bonusDice)
      : [allInitialSides[0] || 6]
    : [];
  const lowRerollCap = lowDieReroll
    ? Math.min(setCount, resolveRuleCap(rerollRule!.maxDice, capCtx, setCount))
    : 0;
  const matchBonusSides =
    matchRule?.action === 'bonus-dice' && matchRule.bonusDice
      ? parseDiceSides(matchRule.bonusDice)
      : [];

  const setPlan = (setIdx: number): WeaponTrayDiePlan[] => [
    ...baseSides.map((sides) => ({ sides, set: setIdx, critical: false })),
    ...critSides.map((sides) => ({ sides, set: setIdx, critical: true })),
    ...extraWeaponCritSides.map((sides) => ({ sides, set: setIdx, critical: false })),
  ];
  const plannedDice: WeaponTrayDiePlan[] = [
    ...setPlan(0),
    ...(fullPoolReroll ? setPlan(1) : []),
    ...(lowDieReroll && uniformInitial
      ? Array.from({ length: lowRerollCap }, () => ({ sides: allInitialSides[0], set: 1 }))
      : []),
    ...(explodingRule && (uniformInitial || !!explodingRule.bonusDice)
      ? Array.from({ length: explodeCap }, () =>
          explodeBonusSides.map((sides) => ({ sides, set: 2 })),
        ).flat()
      : []),
    ...customExtraCritSides.map((sides) => ({ sides, set: 2, critical: true })),
    ...matchBonusSides.map((sides) => ({ sides, set: 2 })),
    ...(extraPlannedDice ?? []),
  ].slice(0, 40);

  const canCombineExtraCritWithInitial =
    customExtraCritSides.length > 0 && !fullPoolReroll && !lowDieReroll && !explodingRule;
  const baseTrayInfo: import('./dice.js').WeaponTrayInfo = {
    phase: 'initial',
    weaponName: title,
    damageExpr: diceExpr,
    crit,
    plannedDice,
    setCount,
    baseCount: baseSides.length,
    extraWeaponCritCount: extraWeaponCritSides.length,
    hasReroll: fullPoolReroll,
    ...(fullPoolReroll && params.interactiveReroll ? { interactiveReroll: true } : {}),
    hasExtraCrit,
    ...(fullPoolReroll || lowDieReroll ? { rerollLabel, rerollMode: rerollRule!.mode, rerollKeep: rerollRule!.keep, rerollMaxFace: rerollRule!.maxFace ?? 2 } : {}),
    ...(hasExtraCrit
      ? {
          extraCritLabel: primaryExtraLabel,
          extraCritSides: extraWeaponCritSides[0] ?? customExtraCritSides[0],
          extraCritDiceSides: extraWeaponCritSides.length ? extraWeaponCritSides : customExtraCritSides,
          extraCritLabels,
        }
      : {}),
    ...(minFaceRule ? { minFace: { value: minFaceRule.value, label: minFaceRule.label || 'Minimum Face' } } : {}),
  };

  const applyFloorFaces = (raw: number[], sides: number[], exprLabel: string, expr?: string, isCrit?: boolean, source?: string): AttackStep => {
    if (!minFaceRule) {
      const val = raw.reduce((s, v) => s + v, 0);
      return {
        label: exprLabel,
        value: val,
        faces: raw,
        ...(expr ? { diceExpression: expr } : {}),
        ...(isCrit ? { critical: true } : {}),
        ...(source ? { source } : {}),
      };
    }
    const eff = raw.map((f, i) => (sides[i] >= minFaceRule.value && f < minFaceRule.value ? minFaceRule.value : f));
    const floored = eff.some((v, i) => v !== raw[i]);
    const val = eff.reduce((s, v) => s + v, 0);
    return {
      label: exprLabel,
      value: val,
      faces: eff,
      ...(expr ? { diceExpression: expr } : {}),
      ...(isCrit ? { critical: true } : {}),
      ...(source ? { source } : {}),
      ...(floored ? { rawFaces: raw, floorLabel: minFaceRule.label || `Min ${minFaceRule.value}` } : {}),
    };
  };

  const formatFaces = (raw: number[], eff: number[]) =>
    eff.map((v, i) => (raw[i] !== v ? `${raw[i]}\u2192${v}` : `${v}`)).join(',');

  const rollSet = (phase: 'initial' | 'savage-reroll', hasNextAfterInitial = false) => {
    const meta = {
      label: `${title} — ${phase === 'savage-reroll' ? `${rerollLabel} Reroll` : crit ? 'Critical Damage' : 'Damage'}`,
      weaponTray: { ...baseTrayInfo, phase, ...(hasNextAfterInitial ? { hasNextWave: true } : {}) },
    };
    const terms: { expr: string; critical?: boolean }[] = [
      { expr: diceExpr },
      ...(effectiveCritExpr ? [{ expr: effectiveCritExpr, critical: true }] : []),
      ...(extraWeaponCritSides.length > 0 ? [{ expr: `${extraWeaponCritSides.length}d${weaponDieSides}`, critical: false }] : []),
    ];
    const rolls = withDiceMetadata(meta, () => rollDicePool(terms));
    const r1 = rolls[0];
    const r2 = effectiveCritExpr ? rolls[1] : undefined;
    const rWeaponExtra = extraWeaponCritSides.length > 0 ? rolls[effectiveCritExpr ? 2 : 1] : undefined;
    const s1 = r1 ? applyFloorFaces(r1.rolls, baseSides, diceExpr, undefined, false) : undefined;
    const s2 = crit && effectiveCritExpr && r2
      ? applyFloorFaces(r2.rolls, critSides, 'CRIT', effectiveCritExpr, true)
      : undefined;
    const sEx =
      rWeaponExtra && extraWeaponCritSides.length > 0
        ? applyFloorFaces(
            rWeaponExtra.rolls,
            extraWeaponCritSides,
            `${extraWeaponCritSides.length}d${weaponDieSides}`,
            `${extraWeaponCritSides.length}d${weaponDieSides}`,
            true,
            weaponExtraLabels[0],
          )
        : undefined;
    const steps: AttackStep[] = [];
    const parts: string[] = [];
    let total = 0;
    const effFaces: number[] = [];
    const rawFaces: number[] = [];
    if (s1 && r1) {
      total += s1.value;
      parts.push(`${diceExpr}[${formatFaces(r1.rolls, s1.faces!)}]`);
      steps.push(s1);
      effFaces.push(...s1.faces!);
      rawFaces.push(...r1.rolls);
    }
    if (s2 && r2) {
      total += s2.value;
      parts.push(`+[${formatFaces(r2.rolls, s2.faces!)}][CRIT]`);
      steps.push(s2);
      effFaces.push(...s2.faces!);
      rawFaces.push(...r2.rolls);
    }
    if (sEx && rWeaponExtra) {
      total += sEx.value;
      const tag = weaponExtraLabels[0] === 'Savage Attacks' ? 'SAVAGE CRIT' : weaponExtraLabels[0].toUpperCase();
      parts.push(`+[${formatFaces(rWeaponExtra.rolls, sEx.faces!)}][${tag}]`);
      steps.push(sEx);
      effFaces.push(...sEx.faces!);
      rawFaces.push(...rWeaponExtra.rolls);
    }
    return { total, steps, parts, effFaces, rawFaces };
  };

  let activeSet: { total: number; steps: AttackStep[]; parts: string[]; effFaces: number[]; rawFaces: number[] };
  const notes: string[] = [];
  const extraSteps: AttackStep[] = [];
  const extraParts: string[] = [];
  let extraCritTyped: RuledDicePoolResult['extraCritTyped'];
  let waveCount = 0;
  let currentTraySidesCount = 0;
  let keptTrayIndices = allInitialSides.map((_, i) => i);
  let usedReroll = false;

  if (canCombineExtraCritWithInitial) {
    const terms: { expr: string; critical?: boolean }[] = [
      { expr: diceExpr },
      ...(effectiveCritExpr ? [{ expr: effectiveCritExpr, critical: true }] : []),
      ...(extraWeaponCritSides.length > 0 ? [{ expr: `${extraWeaponCritSides.length}d${weaponDieSides}`, critical: false }] : []),
      ...(customExtraCritExpr ? [{ expr: customExtraCritExpr, critical: true }] : []),
    ];
    const rolls = withDiceMetadata(
      {
        label: `${title} — Critical Damage`,
        weaponTray: { ...baseTrayInfo, phase: 'initial', ...(extraPlannedDice?.length ? { hasNextWave: true } : {}) },
      },
      () => rollDicePool(terms),
    );
    const r1 = rolls[0];
    const r2 = effectiveCritExpr ? rolls[1] : undefined;
    let idx = effectiveCritExpr ? 2 : 1;
    const rWeaponExtra = extraWeaponCritSides.length > 0 ? rolls[idx++] : undefined;
    const rCustomExtra = customExtraCritExpr ? rolls[idx++] : undefined;

    activeSet = { total: 0, steps: [], parts: [], effFaces: [], rawFaces: [] };
    if (r1) {
      const s1 = applyFloorFaces(r1.rolls, baseSides, diceExpr);
      activeSet.total += s1.value;
      activeSet.parts.push(`${diceExpr}[${formatFaces(r1.rolls, s1.faces!)}]`);
      activeSet.steps.push(s1);
      activeSet.effFaces.push(...s1.faces!);
      activeSet.rawFaces.push(...r1.rolls);
    }
    if (r2 && effectiveCritExpr) {
      const s2 = applyFloorFaces(r2.rolls, critSides, 'CRIT', effectiveCritExpr, true);
      activeSet.total += s2.value;
      activeSet.parts.push(`+[${formatFaces(r2.rolls, s2.faces!)}][CRIT]`);
      activeSet.steps.push(s2);
      activeSet.effFaces.push(...s2.faces!);
      activeSet.rawFaces.push(...r2.rolls);
    }
    if (rWeaponExtra && extraWeaponCritSides.length > 0) {
      const sEx = applyFloorFaces(
        rWeaponExtra.rolls,
        extraWeaponCritSides,
        `${extraWeaponCritSides.length}d${weaponDieSides}`,
        `${extraWeaponCritSides.length}d${weaponDieSides}`,
        true,
        weaponExtraLabels[0],
      );
      activeSet.total += sEx.value;
      const tag = weaponExtraLabels[0] === 'Savage Attacks' ? 'SAVAGE CRIT' : weaponExtraLabels[0].toUpperCase();
      activeSet.parts.push(`+[${formatFaces(rWeaponExtra.rolls, sEx.faces!)}][${tag}]`);
      activeSet.steps.push(sEx);
      activeSet.effFaces.push(...sEx.faces!);
      activeSet.rawFaces.push(...rWeaponExtra.rolls);
    }
    if (rCustomExtra) {
      const customType = diceRules?.extraCritDamageType?.trim().toLowerCase();
      const customLabel = customExtraLabels[0] || diceRules?.extraCritLabel || 'Critical Bonus';
      const sCust: AttackStep = {
        label: customExtraCritExpr,
        value: rCustomExtra.total,
        faces: rCustomExtra.rolls,
        diceExpression: customExtraCritExpr,
        critical: true,
        source: customLabel,
      };
      if (customType && damageType && customType !== damageType.toLowerCase()) {
        extraCritTyped = {
          total: rCustomExtra.total,
          damageType: customType,
          steps: [sCust],
          parts: [`+${customExtraCritExpr}[${rCustomExtra.rolls.join(',')}] (${customType})`],
        };
      } else {
        activeSet.total += rCustomExtra.total;
        activeSet.parts.push(`+[${rCustomExtra.rolls.join(',')}][${customLabel.toUpperCase()}]`);
        activeSet.steps.push(sCust);
      }
      activeSet.effFaces.push(...rCustomExtra.rolls);
      activeSet.rawFaces.push(...rCustomExtra.rolls);
    }
    currentTraySidesCount = setCount + customExtraCritSides.length;
    waveCount = 1;
  } else {
    // Check ahead if a deterministic next wave follows initial (`fullPoolReroll` when auto).
    activeSet = rollSet('initial', fullPoolReroll && !params.interactiveReroll);
    currentTraySidesCount = setCount;
    waveCount = 1;

    if (fullPoolReroll) {
      const diceSummary =
        extraWeaponCritSides.length > 0
          ? `${setCount}d${weaponDieSides} (incl. ${weaponExtraLabels[0]})`
          : crit && effectiveCritExpr
            ? `${diceExpr} + ${effectiveCritExpr} crit`
            : diceExpr;
      const shouldReroll = params.interactiveReroll
        ? Boolean(params.chooseReroll?.({ label: rerollLabel, rollTotal: activeSet.total, diceSummary }))
        : true;
      if (shouldReroll) {
        usedReroll = true;
        const second = rollSet(
          'savage-reroll',
          customExtraCritSides.length > 0 || Boolean(extraPlannedDice?.length),
        );
        const keepNew = rerollRule!.keep === 'new';
        const secondWins = keepNew || second.total > activeSet.total;
        const kept = secondWins ? second : activeSet;
        const dropped = secondWins ? activeSet : second;
        const rerollTag = rerollLabel === 'Savage Attacker' ? 'SAVAGE' : rerollLabel.toUpperCase();
        notes.push(`[${rerollTag} ${kept.total}/${dropped.total}]`);
        activeSet = kept;
        if (secondWins) keptTrayIndices = allInitialSides.map((_, i) => setCount + i);
        currentTraySidesCount += setCount;
        waveCount++;
      }
    } else if (lowDieReroll) {
      const maxFace = rerollRule!.maxFace ?? 2;
      const eligible = activeSet.effFaces
        .map((face, idx) => ({ idx, face, side: allInitialSides[idx] ?? 0 }))
        .filter((d) => d.face <= maxFace)
        .sort((a, b) => a.face - b.face)
        .slice(0, lowRerollCap);
      if (eligible.length > 0) {
        const sourceIndices = eligible.map((d) => d.idx);
        const rerollExpr = eligible.map((d) => `1d${d.side}`);
        const useSameTray = uniformInitial;
        const rerollStart = currentTraySidesCount;
        const rerollMeta = useSameTray
          ? {
              label: `${title} — ${rerollLabel}`,
              weaponTray: {
                ...baseTrayInfo,
                phase: 'die-reroll' as const,
                rerollSourceIndices: sourceIndices,
                rerollLabel,
                rerollMaxFace: maxFace,
                rerollKeep: rerollRule!.keep,
                hasNextWave: hasExtraCrit,
              },
            }
          : {
              label: `${title} — ${rerollLabel}`,
              trayBanner: {
                title: rerollLabel,
                detail: `Rerolling ${eligible.length} ${eligible.length === 1 ? 'die' : 'dice'} \u2264${maxFace}`,
                tone: 'reroll' as const,
              },
              dieRole: 'reroll' as const,
              dieLabel: rerollLabel,
            };
        const replacements = withDiceMetadata(rerollMeta, () =>
          rollDicePool(rerollExpr.map((expr) => ({ expr }))),
        );
        const updatedRaw = activeSet.rawFaces.slice();
        const updatedEff = activeSet.effFaces.slice();
        const changeLog: string[] = [];
        eligible.forEach((d, k) => {
          const newRaw = replacements[k]?.rolls[0] ?? d.face;
          const newEff =
            minFaceRule && d.side >= minFaceRule.value && newRaw < minFaceRule.value
              ? minFaceRule.value
              : newRaw;
          const takeNew = rerollRule!.keep === 'new' || newEff > updatedEff[d.idx];
          if (takeNew) {
            changeLog.push(`${updatedEff[d.idx]}\u2192${newEff}`);
            updatedRaw[d.idx] = newRaw;
            updatedEff[d.idx] = newEff;
            if (useSameTray) keptTrayIndices[d.idx] = rerollStart + k;
          } else {
            changeLog.push(`${updatedEff[d.idx]}\u2192${newEff}(kept ${updatedEff[d.idx]})`);
          }
        });
        notes.push(`[${rerollLabel}: ${changeLog.join(', ')}]`);
        const baseLen = baseSides.length;
        const critEnd = baseLen + critSides.length;
        const baseRaw = updatedRaw.slice(0, baseLen);
        const baseEff = updatedEff.slice(0, baseLen);
        const critRaw = updatedRaw.slice(baseLen, critEnd);
        const critEff = updatedEff.slice(baseLen, critEnd);
        const exRaw = updatedRaw.slice(critEnd);
        const exEff = updatedEff.slice(critEnd);
        const nextSteps: AttackStep[] = [];
        const nextParts: string[] = [];
        let nextTotal = 0;
        const bStep: AttackStep = {
          label: diceExpr,
          value: baseEff.reduce((s, v) => s + v, 0),
          faces: baseEff,
          ...(baseEff.some((v, i) => v !== baseRaw[i]) ? { rawFaces: baseRaw, floorLabel: minFaceRule?.label } : {}),
        };
        nextSteps.push(bStep);
        nextParts.push(`${diceExpr}[${baseEff.join(',')}]`);
        nextTotal += bStep.value;
        if (critLenCheck(critSides, critEff)) {
          const cStep: AttackStep = {
            label: 'CRIT',
            value: critEff.reduce((s, v) => s + v, 0),
            faces: critEff,
            diceExpression: effectiveCritExpr,
            critical: true,
            ...(critEff.some((v, i) => v !== critRaw[i]) ? { rawFaces: critRaw, floorLabel: minFaceRule?.label } : {}),
          };
          nextSteps.push(cStep);
          nextParts.push(`+[${critEff.join(',')}][CRIT]`);
          nextTotal += cStep.value;
        }
        if (critLenCheck(extraWeaponCritSides, exEff)) {
          const exStep: AttackStep = {
            label: `${extraWeaponCritSides.length}d${weaponDieSides}`,
            value: exEff.reduce((s, v) => s + v, 0),
            faces: exEff,
            diceExpression: `${extraWeaponCritSides.length}d${weaponDieSides}`,
            critical: true,
            source: weaponExtraLabels[0],
            ...(exEff.some((v, i) => v !== exRaw[i]) ? { rawFaces: exRaw, floorLabel: minFaceRule?.label } : {}),
          };
          const tag = weaponExtraLabels[0] === 'Savage Attacks' ? 'SAVAGE CRIT' : weaponExtraLabels[0].toUpperCase();
          nextSteps.push(exStep);
          nextParts.push(`+[${exEff.join(',')}][${tag}]`);
          nextTotal += exStep.value;
        }
        activeSet = {
          total: nextTotal,
          steps: nextSteps,
          parts: nextParts,
          effFaces: updatedEff,
          rawFaces: updatedRaw,
        };
        if (useSameTray) currentTraySidesCount += eligible.length;
      }
    }
  }

  // Track kept damage faces & sides (base + crit + extra weapon crit dice).
  let keptFaces = activeSet.effFaces.slice();
  const keptRawFaces = activeSet.rawFaces.slice();
  const keptSides = [
    ...allInitialSides,
    ...(canCombineExtraCritWithInitial ? customExtraCritSides : []),
  ];

  // Exploding dice wave(s)
  if (explodingRule && explodeCap > 0) {
    let usedExplosions = 0;
    let frontierFaces = activeSet.rawFaces.slice(0, allInitialSides.length);
    let frontierSides = allInitialSides.slice();
    // Map each frontier entry to its actual index in the tray
    let frontierTrayIndices = keptTrayIndices.slice();
    for (;;) {
      const remaining = explodeCap - usedExplosions;
      if (remaining <= 0) break;
      const triggers: { trayIdx: number; triggerVal: number; dieSide: number }[] = [];
      frontierFaces.forEach((f, idx) => {
        const want = explodingRule.on === 'max' ? (frontierSides[idx] ?? 0) : explodingRule.on;
        if (want > 0 && f === want && triggers.length < remaining) {
          triggers.push({ trayIdx: frontierTrayIndices[idx], triggerVal: f, dieSide: frontierSides[idx] });
        }
      });
      if (!triggers.length) break;
      const burstExpr = explodingRule.bonusDice?.trim() || `1d${triggers[0].dieSide || 6}`;
      const waveTerms = triggers.map(() => ({ expr: explodingRule.bonusDice?.trim() || `1d${triggers[0].dieSide || 6}` }));
      const waveSides = waveTerms.flatMap((t) => parseDiceSides(t.expr));
      const canUseTray =
        currentTraySidesCount + waveSides.length <= plannedDice.length &&
        waveSides.every((s, k) => plannedDice[currentTraySidesCount + k]?.sides === s);
      const explodeLabel = explodingRule.label || 'Exploding';
      const parentIndices = triggers.flatMap((t) =>
        parseDiceSides(explodingRule.bonusDice?.trim() || `1d${t.dieSide || 6}`).map(() => t.trayIdx),
      );
      const waveRolls = withDiceMetadata(
        canUseTray
          ? {
              label: `${title} — ${explodeLabel}`,
              weaponTray: {
                ...baseTrayInfo,
                phase: 'explode' as const,
                explodeParentIndices: parentIndices,
                explodeLabel,
              },
            }
          : {
              label: `${title} — ${explodeLabel}`,
              trayBanner: {
                title: explodeLabel,
                detail: `Triggered by rolling ${triggers.map((t) => t.triggerVal).join(', ')}`,
                tone: 'explode' as const,
              },
              dieRole: 'exploded' as const,
              dieLabel: explodeLabel,
            },
        () => rollDicePool(waveTerms),
      );
      const waveFaces: number[] = [];
      const waveStepSides: number[] = [];
      let waveTotal = 0;
      waveRolls.forEach((r) => {
        if (!r) return;
        waveTotal += r.total;
        waveFaces.push(...r.rolls);
        waveStepSides.push(...parseDiceSides(r.expr));
      });
      if (!waveFaces.length) break;
      usedExplosions += triggers.length;
      if (canUseTray) {
        const waveStart = currentTraySidesCount;
        frontierTrayIndices = waveFaces.map((_, i) => waveStart + i);
        currentTraySidesCount += waveFaces.length;
      } else {
        frontierTrayIndices = waveFaces.map((_, i) => i);
      }
      activeSet.total += waveTotal;
      activeSet.parts.push(`+[${waveFaces.join(',')}][${explodeLabel.toUpperCase()}]`);
      activeSet.steps.push({
        label: waveTerms.length === 1 ? burstExpr : `${waveFaces.length}d${waveStepSides[0] || 6}`,
        value: waveTotal,
        faces: waveFaces,
        diceExpression: `${waveFaces.length}d${waveStepSides[0] || 6}`,
        source: explodeLabel,
      });
      keptFaces.push(...waveFaces);
      keptRawFaces.push(...waveFaces);
      keptSides.push(...waveStepSides);
      notes.push(`[${explodeLabel} +${waveTotal}]`);
      if (explodingRule.recursive === false) break;
      frontierFaces = waveFaces;
      frontierSides = waveStepSides;
    }
  }

  // Deferred non-weapon extra crit dice (e.g. Vicious Weapon +2d6 when Savage Attacker / reroll / exploding ran first)
  if (!canCombineExtraCritWithInitial && customExtraCritSides.length > 0) {
    const terms: { expr: string; critical?: boolean }[] = [
      { expr: customExtraCritExpr, critical: true },
    ];
    const canUseTray =
      currentTraySidesCount + customExtraCritSides.length <= plannedDice.length &&
      customExtraCritSides.every((s, k) => plannedDice[currentTraySidesCount + k]?.sides === s);
    const custLabel = customExtraLabels[0] || diceRules?.extraCritLabel || 'Critical Bonus';
    const [rCustomExtra] = withDiceMetadata(
      canUseTray
        ? {
            label: `${title} — ${custLabel}`,
            weaponTray: {
              ...baseTrayInfo,
              phase: 'savage-crit' as const,
            },
          }
        : {
            label: `${title} — ${custLabel}`,
            trayBanner: {
              title: custLabel,
              detail: `+${customExtraCritSides.length} extra critical ${customExtraCritSides.length === 1 ? 'die' : 'dice'}`,
              tone: 'savage-crit' as const,
            },
            dieRole: 'savage-crit' as const,
            dieLabel: custLabel,
          },
      () => rollDicePool(terms),
    );
    if (canUseTray) currentTraySidesCount += customExtraCritSides.length;
    if (rCustomExtra) {
      const customType = diceRules?.extraCritDamageType?.trim().toLowerCase();
      const sCust: AttackStep = {
        label: customExtraCritExpr,
        value: rCustomExtra.total,
        faces: rCustomExtra.rolls,
        diceExpression: customExtraCritExpr,
        critical: true,
        source: custLabel,
      };
      if (customType && damageType && customType !== damageType.toLowerCase()) {
        extraCritTyped = {
          total: rCustomExtra.total,
          damageType: customType,
          steps: [sCust],
          parts: [`+${customExtraCritExpr}[${rCustomExtra.rolls.join(',')}] (${customType})`],
        };
      } else {
        activeSet.total += rCustomExtra.total;
        activeSet.parts.push(`+[${rCustomExtra.rolls.join(',')}][${custLabel.toUpperCase()}]`);
        activeSet.steps.push(sCust);
      }
      keptFaces.push(...rCustomExtra.rolls);
      keptRawFaces.push(...rCustomExtra.rolls);
      keptSides.push(...customExtraCritSides);
    }
  }

  const damageMaxHit = keptRawFaces.some((f, i) => (keptSides[i] ?? 0) > 0 && f === keptSides[i]);
  const matchingFaces = findMatchingValues(keptFaces, matchRule?.minMatches ?? 2);
  let matchingBonus: RuledDicePoolResult['matchingBonus'];

  if (matchRule?.action === 'bonus-dice' && matchingFaces.length > 0 && matchRule.bonusDice?.trim()) {
    const bonusExpr = matchRule.bonusDice.trim();
    const bonusSides = parseDiceSides(bonusExpr);
    const label = matchRule.label || 'Matching Dice Bonus';
    const canUseTray =
      bonusSides.length > 0 &&
      currentTraySidesCount + bonusSides.length <= plannedDice.length &&
      bonusSides.every((s, k) => plannedDice[currentTraySidesCount + k]?.sides === s);
    const [rolled] = withDiceMetadata(
      canUseTray
        ? {
            label: `${title} — ${label}`,
            weaponTray: {
              ...baseTrayInfo,
              phase: 'rider' as const,
              riderLabel: label,
              riderDetail: `Matched ${matchingFaces.join(', ')} \u2192 +${bonusExpr}`,
            },
          }
        : {
            label: `${title} — ${label}`,
            trayBanner: {
              title: label,
              detail: `Matched ${matchingFaces.join(', ')} \u2192 +${bonusExpr}`,
              tone: 'rider' as const,
            },
            dieRole: 'rider' as const,
            dieLabel: label,
          },
      () => rollDicePool([{ expr: bonusExpr }]),
    );
    if (rolled) {
      matchingBonus = {
        total: rolled.total,
        damageType: matchRule.bonusDamageType || damageType,
        steps: [{ label: bonusExpr, value: rolled.total, faces: rolled.rolls, diceExpression: bonusExpr, source: label }],
        parts: [`+${bonusExpr}[${rolled.rolls.join(',')}][${label.toUpperCase()}]`],
        label,
        faces: rolled.rolls,
      };
      notes.push(`[${label} +${rolled.total}]`);
    }
  }

  return {
    total: activeSet.total,
    steps: [...activeSet.steps, ...extraSteps],
    parts: [...activeSet.parts, ...extraParts],
    notes,
    keptFaces,
    keptSides,
    damageMaxHit,
    damageHasMatch: matchingFaces.length > 0,
    matchingFaces,
    extraCritTyped,
    matchingBonus,
    usedWeaponTray: true,
    usedReroll,
    baseTrayInfo,
  };
}

function critLenCheck(sides: number[], eff: number[]): boolean {
  return sides.length > 0 && eff.length === sides.length;
}

export type AttackOutcome = {
  face: number;
  bonus: number;
  attackTotal: number;
  crit: boolean;
  fumble: boolean;
  hit: boolean;
  damage: number;
  detail: string;
  /** `detail` WITHOUT the damage tail — the log line for a two-step attack,
   *  where the damage is rolled separately and must not be spoiled here. */
  detailToHit: string;
  /** Structured to-hit bonuses (ability mod, proficiency, maneuver…) for the
   *  reveal animation — the running total counts d20 + these up to attackTotal. */
  toHitSteps: AttackStep[];
  /** Damage dice (each with its faces) — a crit appends a second dice step. */
  damageDiceSteps: AttackStep[];
  /** Flat damage modifiers (ability mod, magic, mastery) after the dice. */
  damageModSteps: AttackStep[];
  /** Post-resolution weapon dice info for conditional triggers (`on-damage-max`, `on-damage-match`, typed extra crit dice). */
  damageFaces?: number[];
  damageMaxHit?: boolean;
  damageHasMatch?: boolean;
  extraCritTyped?: RuledDicePoolResult['extraCritTyped'];
  matchingBonus?: RuledDicePoolResult['matchingBonus'];
  usedWeaponTray?: boolean;
  usedReroll?: boolean;
  baseTrayInfo?: import('./dice.js').WeaponTrayInfo;
};

/** Resolve a weapon attack vs a target AC, including crit (double dice). */
export function rollWeaponAttack(
  attacker: Combatant,
  weapon: Weapon,
  targetAC: number,
  advantage?: Advantage,
  opts?: {
    attackOnly?: boolean;
    fixedAttack?: AttackOutcome;
    twoHanded?: boolean;
    noAbilityMod?: boolean;
    bonusDamage?: number;
    bonusLabel?: string;
    /** Extra added to the attack roll itself (e.g. a Precision maneuver die). */
    attackRollBonus?: number;
    /** Log label for that extra, e.g. "maneuver" or the granting item's name. */
    attackRollBonusLabel?: string;
    /** Force a critical hit on ANY hit (e.g. an attack within 5 ft of a paralyzed
     *  or unconscious target). Does not turn a miss into a hit. */
    forceCrit?: boolean;
    /** Savage Attacker (2024 feat): roll the weapon's damage dice TWICE and keep
     *  the better total. Covers the crit's extra dice (including Savage Attacks / Brutal Critical). */
    rerollDamageDice?: boolean;
    rerollDamageLabel?: string;
    interactiveReroll?: boolean;
    chooseReroll?: (info: { label: string; rollTotal: number; diceSummary: string }) => boolean;
    /** Savage Attacks (Half-Orc racial): on a CRIT only, roll ONE of the weapon's
     *  damage dice one extra time and add it. */
    extraCritDie?: boolean;
    extraCritDieLabel?: string;
    /** Total extra weapon crit dice (combines Savage Attacks + Brutal Critical + weapon.diceRules). */
    extraCritWeaponDice?: number;
    extraCritLabels?: string[];
    critThreshold?: number;
    halflingLucky?: boolean;
    diceRules?: DiceRulesSpec;
    castingMod?: number;
    proficiency?: number;
    extraPlannedDice?: WeaponTrayDiePlan[];
    advantageReasons?: string[];
    advantageState?: 'adv' | 'dis' | 'straight';
  },
): AttackOutcome {
  const { face, detail: d20detail } = opts?.fixedAttack
    ? {
        face: opts.fixedAttack.face,
        detail:
          opts.fixedAttack.detailToHit.match(/d20\[[^\]]+\](?:\u2192(?:adv|dis) \d+)?/)?.[0] ??
          `d20[${opts.fixedAttack.face}]`,
      }
    : withDiceMetadata(
        {
          label: `${weapon.name} — Attack Roll`,
          ...(opts?.advantageReasons?.length
            ? {
                advantageReasons: opts.advantageReasons,
                advantageState: opts.advantageState ?? advantage ?? 'straight',
              }
            : {}),
        },
        () => rollD20Detail(advantage, { halflingLucky: opts?.halflingLucky }),
      );
  const { bonus, detail: bonusDetail, parts: bonusParts } = weaponAttackBonusDetail(attacker, weapon);
  const toHitExtra = opts?.attackRollBonus ?? 0;
  // Structured to-hit breakdown for the reveal animation (d20 + these).
  const toHitSteps: AttackStep[] = [
    ...bonusParts,
    ...(toHitExtra ? [{ label: opts?.attackRollBonusLabel || 'maneuver', value: toHitExtra }] : []),
  ];
  const attackTotal = opts?.fixedAttack?.attackTotal ?? face + bonus + toHitExtra;
  const critThreshold = Math.max(
    2,
    Math.min(20, opts?.critThreshold ?? weapon.critThreshold ?? weapon.diceRules?.critThreshold ?? 20),
  );
  const natCrit = face >= critThreshold;
  const fumble = face === 1;
  const hit = opts?.fixedAttack?.hit ?? (natCrit || (!fumble && attackTotal >= targetAC));
  const crit = opts?.fixedAttack?.crit ?? (hit && (natCrit || !!opts?.forceCrit)); // auto-crit only on a hit

  // Versatile weapons use their two-handed dice when wielded 2H.
  const expr =
    (opts?.twoHanded && weapon.versatileDamage?.trim()) || weapon.damage?.trim() || '1d4';

  let damage = 0;
  let dmgText = '';
  const damageDiceSteps: AttackStep[] = [];
  const damageModSteps: AttackStep[] = [];
  let damageFaces: number[] | undefined;
  let damageMaxHit: boolean | undefined;
  let damageHasMatch: boolean | undefined;
  let extraCritTyped: RuledDicePoolResult['extraCritTyped'];
  let matchingBonus: RuledDicePoolResult['matchingBonus'];
  let usedWeaponTray = false;
  let usedReroll: boolean | undefined;
  let baseTrayInfo: import('./dice.js').WeaponTrayInfo | undefined;

  if (hit && !opts?.attackOnly) {
    const { dice, flat } = damageParts(expr);
    const magic = weapon.magicBonus ?? 0;
    const usesAbilityMod = !attacker.isMonster || !!weapon.diceOnly;
    const addAbilityMod = usesAbilityMod && !opts?.noAbilityMod;
    const abil = addAbilityMod ? weaponAbilityMod(attacker, weapon) : 0;
    const usableFlat = usesAbilityMod ? 0 : flat;
    const bonus2 = opts?.bonusDamage ?? 0; // flat on-hit mastery damage (e.g. GWM), folded in

    const mergedExtraWeaponCrit = (opts?.extraCritDie ? 1 : 0) + (opts?.extraCritWeaponDice ?? 0);
    const combinedExtraLabels = [
      ...(opts?.extraCritDie ? [opts.extraCritDieLabel || 'Savage Attacks'] : []),
      ...(opts?.extraCritLabels ?? []),
    ];

    const rolled = rollRuledDamagePool({
      title: weapon.name,
      diceExpr: dice,
      critExpr: dice,
      crit,
      damageType: weapon.damageType,
      diceRules: opts?.diceRules ?? weapon.diceRules,
      rerollDamageDice: opts?.rerollDamageDice,
      rerollDamageLabel: opts?.rerollDamageLabel,
      interactiveReroll: opts?.interactiveReroll,
      chooseReroll: opts?.chooseReroll,
      extraCritWeaponDice: mergedExtraWeaponCrit,
      extraCritDieLabel: opts?.extraCritDieLabel,
      extraCritLabels: combinedExtraLabels.length ? combinedExtraLabels : undefined,
      castingMod: opts?.castingMod,
      proficiency: opts?.proficiency ?? profBonusFor(attacker),
      extraPlannedDice: opts?.extraPlannedDice,
      fastPathLabel: `${weapon.name} — ${crit ? 'Critical Weapon Damage' : 'Weapon Damage'}`,
    });

    damageFaces = rolled.keptFaces;
    damageMaxHit = rolled.damageMaxHit;
    damageHasMatch = rolled.damageHasMatch;
    extraCritTyped = rolled.extraCritTyped;
    matchingBonus = rolled.matchingBonus;
    usedWeaponTray = rolled.usedWeaponTray;
    usedReroll = rolled.usedReroll;
    baseTrayInfo = rolled.baseTrayInfo;

    let sum = usableFlat + magic + abil + bonus2 + rolled.total;
    const parts: string[] = [...rolled.parts];
    damageDiceSteps.push(...rolled.steps);
    if (usableFlat) parts.push(signed(usableFlat));
    if (abil) parts.push(`${signed(abil)}[${weaponAbility(attacker, weapon)}]`);
    if (magic) parts.push(`${signed(magic)}[MAGIC]`);
    if (bonus2) parts.push(`${signed(bonus2)}[${opts?.bonusLabel || 'BONUS'}]`);
    if (usableFlat) damageModSteps.push({ label: 'flat', value: usableFlat });
    if (abil) damageModSteps.push({ label: weaponAbility(attacker, weapon), value: abil });
    if (magic) damageModSteps.push({ label: 'MAGIC', value: magic });
    if (bonus2) damageModSteps.push({ label: opts?.bonusLabel || 'BONUS', value: bonus2 });
    if (rolled.notes.length) parts.push(...rolled.notes);
    damage = Math.max(1, sum);
    dmgText = parts.join('') || `${damage}`;
  }

  const twoH = opts?.twoHanded && weapon.versatileDamage?.trim() ? ' (2H)' : '';
  const critRangeNote = natCrit && face < 20 ? ` (${critThreshold}\u201320)` : '';
  const result = crit ? `CRIT${critRangeNote}` : fumble ? 'MISS (nat 1)' : hit ? 'HIT' : 'MISS';
  const detailToHit = `${weapon.name}${twoH}: ${d20detail} ${bonusDetail}${toHitExtra ? ` ${signed(toHitExtra)}[${opts?.attackRollBonusLabel || 'maneuver'}]` : ''} = ${attackTotal} vs AC ${targetAC} — ${result}`;
  const detail = detailToHit + (hit ? `, ${damage} dmg (${dmgText})` : '');

  return {
    face,
    bonus,
    attackTotal,
    crit,
    fumble,
    hit,
    damage,
    detail,
    detailToHit,
    toHitSteps,
    damageDiceSteps,
    damageModSteps,
    damageFaces,
    damageMaxHit,
    damageHasMatch,
    extraCritTyped,
    matchingBonus,
    usedWeaponTray,
    ...(usedReroll !== undefined ? { usedReroll } : {}),
    baseTrayInfo,
  };
}

export type SaveOutcome = {
  face: number;
  mod: number;
  total: number;
  pass: boolean;
  /** Whether the proficiency bonus was added (proficient save). */
  proficient: boolean;
  /** Both-dice display breakdown for the d20, e.g. `d20[14,3]→dis 3`. */
  d20Detail: string;
};

/**
 * Roll a saving throw: d20 + ability modifier (+ proficiency bonus when the
 * creature is proficient in that save) vs a DC.
 */
export function rollSavingThrow(
  c: Combatant,
  ability: string,
  dc: number,
  advantage?: Advantage,
  proficient = false,
  rollLabel = `${ability.toUpperCase()} Saving Throw`,
  opts?: { halflingLucky?: boolean },
): SaveOutcome {
  const { face, detail: d20Detail } = withDiceMetadata({label:rollLabel},()=>rollD20Detail(advantage, opts));
  const mod = abilityMod(c.stats[ability.toUpperCase()]) + (proficient ? profBonusFor(c) : 0);
  const total = face + mod;
  return { face, mod, total, pass: total >= dc, proficient, d20Detail };
}

/** Where a hit's damage came from — the properties that can overcome a
 *  conditional resistance or immunity. Spell damage is always `magical`. */
export type DamageSource = { magical?: boolean; silvered?: boolean };

/**
 * One resistance / immunity / vulnerability entry, parsed. `types` are the
 * canonical damage types it covers; the `unless…` flags are the conditions under
 * which it does NOT apply — "nonmagical B/P/S" is beaten by a magical source,
 * "non-silvered" by a silvered one.
 */
export type DamageTrait = { types: string[]; unlessMagical: boolean; unlessSilvered: boolean };

const TRAIT_TYPE_WORDS = DAMAGE_TYPES.map((t) => [t, new RegExp(`\\b${t}\\b`)] as const);

/**
 * Parse a stat-block damage trait. Understands the SRD phrasings — "fire",
 * "nonmagical bludgeoning/piercing/slashing", "nonmagical non-silvered …",
 * "bludgeoning, piercing, and slashing from nonmagical attacks (that aren't
 * silvered)" — by pulling canonical types from a fixed vocabulary and
 * qualifiers from a fixed phrase set, so a partial word never matches ("poison"
 * is not "poisoned"). An entry naming no canonical type (homebrew "sonic") keeps
 * the old exact-match behaviour. Null for an empty entry.
 */
export function parseDamageTrait(entry: string): DamageTrait | null {
  const raw = entry.trim().toLowerCase();
  if (!raw) return null;
  const types = TRAIT_TYPE_WORDS.filter(([, re]) => re.test(raw)).map(([t]) => t);
  const unlessMagical = /\bnon-?magical\b/.test(raw);
  const unlessSilvered =
    /\bnon-?silvered\b|\baren'?t silvered\b|\bare not silvered\b|\bnot made with silvered\b/.test(raw);
  if (types.length === 0)
    return unlessMagical || unlessSilvered ? null : { types: [raw], unlessMagical, unlessSilvered };
  return { types, unlessMagical, unlessSilvered };
}

/** Whether a trait entry applies to this damage type from this source. */
export function traitApplies(entry: string, damageType: string, source: DamageSource = {}): boolean {
  const t = parseDamageTrait(entry);
  if (!t || !t.types.includes(damageType)) return false;
  if (t.unlessMagical && source.magical) return false;
  if (t.unlessSilvered && source.silvered) return false;
  return true;
}

/** Whether a weapon attack is magical: explicitly flagged, or carrying a bonus. */
export function weaponIsMagical(w: Pick<Weapon, 'magical' | 'magicBonus'>): boolean {
  return !!w.magical || (w.magicBonus ?? 0) > 0;
}

/**
 * Damage multiplier for a damage type against a target's traits: 0 if IMMUNE
 * (immunity beats everything), 0.5 if resistant, 2 if vulnerable, 1 otherwise —
 * and 1 if both resistant and vulnerable (5e: they cancel). Each entry is
 * matched against the type AND the source's properties (see `parseDamageTrait`),
 * so a +1 sword gets through "nonmagical B/P/S" resistance and a mundane one
 * doesn't.
 */
export function damageMultiplier(
  damageType: string | undefined,
  resistances: string[],
  weaknesses: string[],
  immunities: string[] = [],
  source: DamageSource = {},
): number {
  const dt = (damageType ?? '').trim().toLowerCase();
  if (!dt) return 1;
  const has = (arr: string[] | undefined) => (arr ?? []).some((e) => traitApplies(e, dt, source));
  if (has(immunities)) return 0;
  const resist = has(resistances);
  const vuln = has(weaknesses);
  if (resist && vuln) return 1;
  if (resist) return 0.5;
  if (vuln) return 2;
  return 1;
}
