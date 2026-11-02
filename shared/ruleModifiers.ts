import type { Condition, CreatureAbility, SheetAbility } from './types.js';
import type { VisionSenseMode } from './visionStencilGeometry.js';

export type CoverGrade = 'none' | 'half' | 'three-quarters' | 'total';

export type IlluminationLevel = 'bright' | 'dim' | 'darkness' | 'magical-darkness';

export type IlluminationContext = {
  attackerLight?: IlluminationLevel;
  targetLight?: IlluminationLevel;
  attackerSenses?: readonly VisionSenseMode[];
  targetSenses?: readonly VisionSenseMode[];
};

export type RuleModifierCategory =
  | 'condition'
  | 'stance'
  | 'cover'
  | 'illumination'
  | 'mastery'
  | 'classFeature';

export type RuleEvaluationInput = {
  attackerConditions: readonly Condition[];
  targetConditions: readonly Condition[];
  attackerAbilities?: readonly CreatureAbility[];
  targetAbilities?: readonly CreatureAbility[];
  attackerSheetAbilities?: readonly SheetAbility[];
  targetSheetAbilities?: readonly SheetAbility[];
  within5ft: boolean;
  distanceFt?: number;
  weaponKind?: 'melee' | 'ranged';
  targetTokenId?: string;
  cover?: CoverGrade;
  illumination?: IlluminationContext;
  allyAdjacentToTarget?: boolean;
};

export type RuleModifierEffect = {
  id: string;
  label: string;
  category: RuleModifierCategory;
  grantAdvantage?: string;
  imposeDisadvantage?: string;
  acBonus?: number;
  dexSaveBonus?: number;
  autoCrit?: string;
  blockTarget?: string;
};

export type RuleModifier = {
  id: string;
  category: RuleModifierCategory;
  description: string;
  evaluate: (ctx: RuleEvaluationInput) => RuleModifierEffect | null;
};

const COVER_BONUSES: Record<CoverGrade, { ac: number; dexSave: number; label: string }> = {
  none: { ac: 0, dexSave: 0, label: 'No cover' },
  half: { ac: 2, dexSave: 2, label: 'Half cover (+2 AC)' },
  'three-quarters': { ac: 5, dexSave: 5, label: 'Three-quarters cover (+5 AC)' },
  total: { ac: 0, dexSave: 0, label: 'Total cover (untargetable)' },
};

function canSeeInLight(
  light: IlluminationLevel | undefined,
  senses: readonly VisionSenseMode[] = [],
): boolean {
  if (!light || light === 'bright' || light === 'dim') return true;
  const set = new Set(senses);
  if (set.has('truesight') || set.has('blindsight') || set.has('devilsSight')) return true;
  if (light === 'darkness' && set.has('darkvision')) return true;
  return false;
}

const BUILTIN_MODIFIERS: RuleModifier[] = [
  {
    id: 'cover-grade',
    category: 'cover',
    description: '5e Half (+2), Three-Quarters (+5), and Total Cover rules.',
    evaluate(ctx) {
      const grade = ctx.cover ?? 'none';
      if (grade === 'none') return null;
      const spec = COVER_BONUSES[grade];
      return {
        id: `cover:${grade}`,
        label: spec.label,
        category: 'cover',
        acBonus: spec.ac,
        dexSaveBonus: spec.dexSave,
        ...(grade === 'total' ? { blockTarget: 'Target has total cover' } : {}),
      };
    },
  },
  {
    id: 'illumination-unseen-target',
    category: 'illumination',
    description: 'Attacking a target in darkness without appropriate darkvision/truesight imposes disadvantage.',
    evaluate(ctx) {
      if (!ctx.illumination?.targetLight) return null;
      const canSeeTarget = canSeeInLight(
        ctx.illumination.targetLight,
        ctx.illumination.attackerSenses,
      );
      if (canSeeTarget) return null;
      return {
        id: 'illumination:unseen-target',
        label: 'Unseen target (darkness)',
        category: 'illumination',
        imposeDisadvantage: 'unseen target (darkness)',
      };
    },
  },
  {
    id: 'illumination-unseen-attacker',
    category: 'illumination',
    description: 'Attacking from darkness when the target cannot see the attacker grants advantage.',
    evaluate(ctx) {
      if (!ctx.illumination?.attackerLight) return null;
      const targetSeesAttacker = canSeeInLight(
        ctx.illumination.attackerLight,
        ctx.illumination.targetSenses,
      );
      if (targetSeesAttacker) return null;
      return {
        id: 'illumination:unseen-attacker',
        label: 'Unseen attacker (darkness)',
        category: 'illumination',
        grantAdvantage: 'unseen attacker (darkness)',
      };
    },
  },
  {
    id: 'feature-pack-tactics',
    category: 'classFeature',
    description: 'Pack Tactics grants advantage when an incapacitated-free ally is within 5 ft of the target.',
    evaluate(ctx) {
      if (!ctx.allyAdjacentToTarget) return null;
      const hasPackTactics = (ctx.attackerAbilities ?? []).some((a) =>
        /pack tactics/i.test(a.name),
      );
      if (!hasPackTactics) return null;
      return {
        id: 'classFeature:pack-tactics',
        label: 'Pack Tactics',
        category: 'classFeature',
        grantAdvantage: 'Pack Tactics',
      };
    },
  },
];

const customModifierRegistry = new Map<string, RuleModifier>();

export function registerRuleModifier(modifier: RuleModifier): () => void {
  customModifierRegistry.set(modifier.id, modifier);
  return () => {
    customModifierRegistry.delete(modifier.id);
  };
}

export function listRuleModifiers(): RuleModifier[] {
  return [...BUILTIN_MODIFIERS, ...customModifierRegistry.values()];
}

export type DeclarativeRuleEvaluation = {
  effects: RuleModifierEffect[];
  featureAdv: string[];
  featureDis: string[];
  acBonus: number;
  dexSaveBonus: number;
  blockedReason: string | null;
};

/**
 * Evaluate all registered declarative `RuleModifier` rules for an attack context.
 */
export function evaluateDeclarativeRuleModifiers(
  input: RuleEvaluationInput,
  extraModifiers: readonly RuleModifier[] = [],
): DeclarativeRuleEvaluation {
  const modifiers = [...listRuleModifiers(), ...extraModifiers];
  const effects: RuleModifierEffect[] = [];
  const featureAdv: string[] = [];
  const featureDis: string[] = [];
  let acBonus = 0;
  let dexSaveBonus = 0;
  let blockedReason: string | null = null;

  for (const mod of modifiers) {
    const effect = mod.evaluate(input);
    if (!effect) continue;
    effects.push(effect);
    if (effect.grantAdvantage) featureAdv.push(effect.grantAdvantage);
    if (effect.imposeDisadvantage) featureDis.push(effect.imposeDisadvantage);
    if (effect.acBonus) acBonus += effect.acBonus;
    if (effect.dexSaveBonus) dexSaveBonus += effect.dexSaveBonus;
    if (effect.blockTarget && !blockedReason) blockedReason = effect.blockTarget;
  }

  return {
    effects,
    featureAdv,
    featureDis,
    acBonus,
    dexSaveBonus,
    blockedReason,
  };
}
