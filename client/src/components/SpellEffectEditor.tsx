import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { DAMAGE_TYPES } from '../../../shared/damage';
import { isValidDiceExpression } from '../../../shared/dice';
import { spellAreaFor, type SpellArea } from '../../../shared/spellAreas';

type SpellAreaKind = SpellArea['kind'];
import {
  effectiveSheetAbility,
  hasActiveCustomEffect,
} from '../../../shared/spellExecution';
import { parseActionType, type ActionType } from '../../../shared/spellPrep';
import {
  formatCustomEffectSummary,
  spellCombatSupport,
} from '../../../shared/spellSupport';
import type {
  AbilityRoll,
  SheetAbility,
  SmiteSpec,
  SpellCustomEffect,
} from '../../../shared/types';
import { NumberInput } from './NumberInput';
import { SpellCombatSupportBadge } from './SpellCombatSupport';

type EffectMode =
  | 'attack'
  | 'save'
  | 'damage'
  | 'heal'
  | 'buff'
  | 'smite'
  | 'summon'
  | 'manual';

type Props = {
  ability: SheetAbility;
  isNew?: boolean;
  casterType: 'pc' | 'monster';
  classRoster?: { className: string; level: number }[];
  onSave: (updated: SheetAbility) => void;
  onRemove?: () => void;
  onClose: () => void;
};

const CORE_CLASSES = [
  'artificer',
  'bard',
  'cleric',
  'druid',
  'fighter',
  'monk',
  'paladin',
  'ranger',
  'rogue',
  'sorcerer',
  'warlock',
  'wizard',
] as const;

const SAVE_ABILITIES = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'] as const;

const CONDITION_PRESETS = [
  'Blessed',
  'Baned',
  'Blinded',
  'Charmed',
  'Deafened',
  'Frightened',
  'Grappled',
  'Hasted',
  'Incapacitated',
  'Invisible',
  'Paralyzed',
  'Petrified',
  'Poisoned',
  'Prone',
  'Restrained',
  'Sanctuary',
  'Shielded',
  'Slowed',
  'Stunned',
] as const;

const IMMUNITY_AND_CURE_CONDITIONS = [
  'Blinded',
  'Charmed',
  'Deafened',
  'Frightened',
  'Grappled',
  'Incapacitated',
  'Paralyzed',
  'Petrified',
  'Poisoned',
  'Prone',
  'Restrained',
  'Slowed',
  'Stunned',
  'Unconscious',
] as const;

const AREA_SHAPES: { value: SpellAreaKind; label: string }[] = [
  { value: 'sphere', label: 'Sphere (radius)' },
  { value: 'cylinder', label: 'Cylinder (radius)' },
  { value: 'emanation', label: 'Emanation (radius)' },
  { value: 'cube', label: 'Cube (side)' },
  { value: 'cone', label: 'Cone (length)' },
  { value: 'line', label: 'Line (length × width)' },
];

const SCHOOLS = [
  'Abjuration',
  'Conjuration',
  'Divination',
  'Enchantment',
  'Evocation',
  'Illusion',
  'Necromancy',
  'Transmutation',
  'Class feature',
  'Custom',
] as const;

function stripMetaConcentration(meta: string): string {
  return meta
    .split('·')
    .map((part) => part.replace(/\bconcentration\b(?:\s*,?\s*up to [^·]+)?/gi, '').trim())
    .filter((part) => part.length > 0 && !/^[-,;]+$/.test(part))
    .join(' · ');
}

function initialEffectMode(eff: SheetAbility): EffectMode {
  if (eff.smite) return 'smite';
  if (eff.summon && !eff.roll) return 'summon';
  if (!eff.roll) return 'manual';
  if (eff.roll.kind === 'damage' && (eff.roll.dice ?? '').trim() === '0') {
    return 'buff';
  }
  return eff.roll.kind;
}

function hasCustomEffectDetails(ce: SpellCustomEffect): boolean {
  return Boolean(
    ce.conditionLabel?.trim() ||
      ce.aura ||
      ce.note?.trim() ||
      ce.durationRounds !== undefined ||
      ce.untilTargetStart ||
      ce.untilCasterEnd ||
      ce.repeatSave?.trim() ||
      ce.repeatDamage?.trim() ||
      ce.tempHpPerTurn !== undefined ||
      ce.acBonus !== undefined ||
      ce.baseAc !== undefined ||
      ce.attackBonus !== undefined ||
      ce.saveBonus !== undefined ||
      ce.attackBonusDice?.trim() ||
      ce.saveBonusDice?.trim() ||
      ce.grantsAdvantageToAttackers ||
      ce.nextAttackAdvantage ||
      ce.attackDisadvantage ||
      ce.nextAttackDisadvantage ||
      ce.checkDisadvantage ||
      ce.speedBonus !== undefined ||
      ce.speedReduction !== undefined ||
      ce.slow ||
      ce.zeroSpeed ||
      ce.preventsHealing ||
      ce.noOpportunityAttacks ||
      ce.suppressesInvisibility ||
      ce.resistDamageTypes?.length ||
      ce.immuneConditions?.length ||
      ce.cureConditions?.length,
  );
}

function toggleStringInList(list: string[] | undefined, value: string): string[] {
  const normalized = value.trim();
  const cur = list ?? [];
  const exists = cur.some((item) => item.toLowerCase() === normalized.toLowerCase());
  return exists
    ? cur.filter((item) => item.toLowerCase() !== normalized.toLowerCase())
    : [...cur, normalized];
}

export function SpellEffectEditor({
  ability,
  isNew = false,
  casterType,
  classRoster,
  onSave,
  onRemove,
  onClose,
}: Props) {
  const effectiveInit = useMemo(() => effectiveSheetAbility(ability), [ability]);
  const catalogDefaultArea = useMemo(
    () =>
      ability.type === 'spell'
        ? spellAreaFor({ name: ability.name, type: 'spell', level: ability.level })
        : undefined,
    [ability.level, ability.name, ability.type],
  );

  // Dirty mechanics tracking: unchanged canonical entries stay canonical unless
  // the user modifies a mechanical control or the entry is already manual/custom.
  const [dirtyMechanics, setDirtyMechanics] = useState(
    () => isNew || ability.executionProfile === 'manual' || ability.source === 'custom',
  );
  const [resetToRulesRequested, setResetToRulesRequested] = useState(false);

  // Identity, spellcasting & economy fields
  const [name, setName] = useState(ability.name);
  const [type, setType] = useState<SheetAbility['type']>(ability.type);
  const [level, setLevel] = useState<number>(ability.level ?? 0);
  const [school, setSchool] = useState(ability.school ?? '');
  const [actionType, setActionType] = useState<ActionType | ''>(
    ability.actionType ?? parseActionType(ability.meta) ?? '',
  );
  const [sourceClass, setSourceClass] = useState(ability.sourceClass ?? '');
  const [castingAbility, setCastingAbility] = useState<AbilityRoll['castingAbility'] | ''>(
    effectiveInit.roll?.castingAbility ?? ability.roll?.castingAbility ?? '',
  );
  const [meta, setMeta] = useState(ability.meta ?? '');
  const [tags, setTags] = useState<string[]>(() => effectiveInit.tags ?? ability.tags ?? []);
  const [prepared, setPrepared] = useState(ability.prepared !== false);
  const [description, setDescription] = useState(ability.description ?? '');
  const [upcast, setUpcast] = useState(ability.upcast ?? '');

  // Mode
  const [mode, setMode] = useState<EffectMode>(() => initialEffectMode(effectiveInit));

  // Roll fields
  const initRoll = effectiveInit.roll;
  const [dice, setDice] = useState(() =>
    initRoll?.kind === 'damage' && (initRoll.dice ?? '').trim() === '0'
      ? ''
      : (initRoll?.dice ?? ''),
  );
  const [scaleDice, setScaleDice] = useState(initRoll?.scaleDice ?? '');
  const [baseLevel, setBaseLevel] = useState<number | undefined>(initRoll?.baseLevel);
  const [attackRange, setAttackRange] = useState<'melee' | 'ranged' | ''>(
    initRoll?.attackRange ?? '',
  );
  const [attackBonus, setAttackBonus] = useState<number | undefined>(initRoll?.attackBonus);
  const [damageType, setDamageType] = useState(initRoll?.damageType ?? '');
  const [damageTypeChoices, setDamageTypeChoices] = useState<string[]>(
    initRoll?.damageTypeChoices ?? [],
  );
  const [damageBonus, setDamageBonus] = useState<'spellcasting' | ''>(
    initRoll?.damageBonus ?? '',
  );
  const [saveAbility, setSaveAbility] = useState(initRoll?.save ?? 'DEX');
  const [saveDamage, setSaveDamage] = useState<'none' | 'half'>(initRoll?.saveDamage ?? 'half');
  const [dc, setDc] = useState<number | undefined>(initRoll?.dc);
  const [healingMode, setHealingMode] = useState<'hitPoints' | 'temporary'>(
    initRoll?.healingMode ?? 'hitPoints',
  );
  const [healingBonus, setHealingBonus] = useState<
    'none' | 'spellcasting' | 'fighterLevel' | ''
  >(initRoll?.healingBonus ?? '');
  const [healTarget, setHealTarget] = useState<'self' | 'selected'>(
    initRoll?.healTarget ?? 'selected',
  );
  const [instances, setInstances] = useState<number | undefined>(initRoll?.instances);
  const [scaleInstances, setScaleInstances] = useState<number | undefined>(
    initRoll?.scaleInstances,
  );
  const [instanceScaling, setInstanceScaling] = useState<'cantrip' | ''>(
    initRoll?.instanceScaling ?? '',
  );
  const [targetMode, setTargetMode] = useState<'single' | 'multiple' | ''>(
    initRoll?.targetMode ?? '',
  );
  const [maxTargets, setMaxTargets] = useState<number | undefined>(initRoll?.maxTargets);
  const [scaleTargets, setScaleTargets] = useState<number | undefined>(initRoll?.scaleTargets);

  // Map Area
  const [areaChoice, setAreaChoice] = useState<'default' | 'none' | SpellAreaKind>(() => {
    if (initRoll?.area) return initRoll.area.kind;
    if (ability.tags?.includes('no-area')) return 'none';
    if (catalogDefaultArea) return 'default';
    return 'none';
  });
  const [areaSizeFt, setAreaSizeFt] = useState<number>(
    initRoll?.area?.sizeFt ?? catalogDefaultArea?.sizeFt ?? 20,
  );
  const [areaWidthFt, setAreaWidthFt] = useState<number>(
    initRoll?.area?.widthFt ?? catalogDefaultArea?.widthFt ?? 5,
  );
  const [areaRangeFt, setAreaRangeFt] = useState<number>(
    initRoll?.area?.rangeFt ?? catalogDefaultArea?.rangeFt ?? 60,
  );
  const [areaCount, setAreaCount] = useState<number | undefined>(initRoll?.area?.count);
  const [areaMaxTargets, setAreaMaxTargets] = useState<number | undefined>(
    initRoll?.area?.maxTargets,
  );
  const [areaSelf, setAreaSelf] = useState(!!initRoll?.area?.self);
  const [areaExcludeCaster, setAreaExcludeCaster] = useState(!!initRoll?.area?.excludeCaster);
  const [areaSelective, setAreaSelective] = useState(!!initRoll?.area?.selective);
  const [areaOngoing, setAreaOngoing] = useState(!!initRoll?.area?.ongoing);
  const [areaInitialEffect, setAreaInitialEffect] = useState(
    initRoll?.area?.initialEffect ?? false,
  );

  // Custom Effect Builder
  const [customEffect, setCustomEffect] = useState<SpellCustomEffect>(() => ({
    ...(initRoll?.customEffect ?? {}),
  }));
  const [extraCureInput, setExtraCureInput] = useState(() =>
    (initRoll?.customEffect?.cureConditions ?? [])
      .filter((c) => !IMMUNITY_AND_CURE_CONDITIONS.some((p) => p.toLowerCase() === c.toLowerCase()))
      .join(', '),
  );

  // Smite Builder
  const [smiteDice, setSmiteDice] = useState(effectiveInit.smite?.dice ?? '2d8');
  const [smiteScaleDice, setSmiteScaleDice] = useState(effectiveInit.smite?.scaleDice ?? '1d8');
  const [smiteDamageType, setSmiteDamageType] = useState(
    effectiveInit.smite?.damageType ?? 'radiant',
  );
  const [smiteBonusTypes, setSmiteBonusTypes] = useState(
    effectiveInit.smite?.bonusVs?.creatureTypes.join(', ') ?? '',
  );
  const [smiteBonusDice, setSmiteBonusDice] = useState(effectiveInit.smite?.bonusVs?.dice ?? '');
  const [smiteFreeCounter, setSmiteFreeCounter] = useState(
    effectiveInit.smite?.freeUse?.counter ?? '',
  );
  const [smiteFreeClass, setSmiteFreeClass] = useState(
    effectiveInit.smite?.freeUse?.className ?? 'paladin',
  );
  const [smiteFreeMinLevel, setSmiteFreeMinLevel] = useState<number | undefined>(
    effectiveInit.smite?.freeUse?.minLevel,
  );

  // Summon Builder (also preserved if paired with a roll like Spiritual Weapon)
  const [summonName, setSummonName] = useState(effectiveInit.summon?.name ?? '');
  const [summonIcon, setSummonIcon] = useState(effectiveInit.summon?.icon ?? '✋');
  const [alsoSummon, setAlsoSummon] = useState(
    Boolean(effectiveInit.summon && effectiveInit.roll),
  );

  const [resetBusy, setResetBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const markMech = () => {
    setDirtyMechanics(true);
    setResetToRulesRequested(false);
    setNotice(null);
  };

  const patchCustom = (patch: Partial<SpellCustomEffect>) => {
    markMech();
    setCustomEffect((prev) => {
      const next: SpellCustomEffect = { ...prev, ...patch };
      // If the user configured ongoing mechanics/buffs without a label yet and
      // isn't doing a pure cure-only entry, seed conditionLabel from the spell name.
      if (
        patch.conditionLabel === undefined &&
        !next.conditionLabel?.trim() &&
        hasCustomEffectDetails({ ...next, cureConditions: undefined })
      ) {
        next.conditionLabel = name.trim() || 'Spell Effect';
      }
      return next;
    });
  };

  const isConcentration =
    tags.some((t) => t.trim().toLowerCase() === 'concentration') ||
    /\bconcentration\b/i.test(meta);
  const isRitual =
    tags.some((t) => t.trim().toLowerCase() === 'ritual') || /\britual\b/i.test(meta);

  const toggleConcentration = (checked: boolean) => {
    markMech();
    setTags((prev) => {
      const cleaned = prev.filter((t) => t.trim().toLowerCase() !== 'concentration');
      return checked ? [...cleaned, 'concentration'] : cleaned;
    });
    if (!checked) {
      setMeta((prev) => stripMetaConcentration(prev));
    }
  };

  const toggleRitual = (checked: boolean) => {
    markMech();
    setTags((prev) => {
      const cleaned = prev.filter((t) => t.trim().toLowerCase() !== 'ritual');
      return checked ? [...cleaned, 'ritual'] : cleaned;
    });
  };

  const buildCleanedCustomEffect = (): SpellCustomEffect | undefined => {
    const extraCures = extraCureInput
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!hasCustomEffectDetails(customEffect) && extraCures.length === 0) return undefined;
    const presetCures = (customEffect.cureConditions ?? []).filter((c) =>
      IMMUNITY_AND_CURE_CONDITIONS.some((p) => p.toLowerCase() === c.toLowerCase()),
    );
    const mergedCures = [
      ...presetCures,
      ...extraCures.filter(
        (c) => !presetCures.some((x) => x.toLowerCase() === c.toLowerCase()),
      ),
    ];
    const ce: SpellCustomEffect = {
      ...(customEffect.target && customEffect.target !== 'affected'
        ? { target: customEffect.target }
        : {}),
      ...(customEffect.conditionLabel?.trim()
        ? { conditionLabel: customEffect.conditionLabel.trim() }
        : {}),
      ...(customEffect.aura ? { aura: customEffect.aura } : {}),
      ...(customEffect.note?.trim() ? { note: customEffect.note.trim() } : {}),
      ...(customEffect.durationRounds !== undefined && customEffect.durationRounds >= 1
        ? { durationRounds: customEffect.durationRounds }
        : {}),
      ...(customEffect.untilTargetStart ? { untilTargetStart: true } : {}),
      ...(customEffect.untilCasterEnd ? { untilCasterEnd: true } : {}),
      ...(customEffect.repeatSave ? { repeatSave: customEffect.repeatSave } : {}),
      ...(customEffect.repeatSave || customEffect.repeatDamage?.trim() || customEffect.tempHpPerTurn !== undefined
        ? { repeatPhase: customEffect.repeatPhase ?? 'end' }
        : {}),
      ...(customEffect.repeatDamage?.trim()
        ? { repeatDamage: customEffect.repeatDamage.trim() }
        : {}),
      ...(customEffect.repeatDamageType?.trim()
        ? { repeatDamageType: customEffect.repeatDamageType.trim().toLowerCase() }
        : {}),
      ...(customEffect.saveBeforeDamage ? { saveBeforeDamage: true } : {}),
      ...(customEffect.tempHpPerTurn !== undefined && customEffect.tempHpPerTurn > 0
        ? { tempHpPerTurn: customEffect.tempHpPerTurn }
        : {}),
      ...(customEffect.acBonus !== undefined && customEffect.acBonus !== 0
        ? { acBonus: customEffect.acBonus }
        : {}),
      ...(customEffect.baseAc !== undefined && customEffect.baseAc > 0
        ? { baseAc: customEffect.baseAc }
        : {}),
      ...(customEffect.baseAc !== undefined && customEffect.baseAc > 0 && customEffect.baseAcAddsDex
        ? { baseAcAddsDex: true }
        : {}),
      ...(customEffect.attackBonus !== undefined && customEffect.attackBonus !== 0
        ? { attackBonus: customEffect.attackBonus }
        : {}),
      ...(customEffect.saveBonus !== undefined && customEffect.saveBonus !== 0
        ? { saveBonus: customEffect.saveBonus }
        : {}),
      ...(customEffect.attackBonusDice?.trim()
        ? { attackBonusDice: customEffect.attackBonusDice.trim() }
        : {}),
      ...(customEffect.saveBonusDice?.trim()
        ? { saveBonusDice: customEffect.saveBonusDice.trim() }
        : {}),
      ...(customEffect.grantsAdvantageToAttackers ? { grantsAdvantageToAttackers: true } : {}),
      ...(customEffect.nextAttackAdvantage ? { nextAttackAdvantage: true } : {}),
      ...(customEffect.attackDisadvantage ? { attackDisadvantage: true } : {}),
      ...(customEffect.nextAttackDisadvantage ? { nextAttackDisadvantage: true } : {}),
      ...(customEffect.checkDisadvantage ? { checkDisadvantage: true } : {}),
      ...(customEffect.speedBonus !== undefined && customEffect.speedBonus !== 0
        ? { speedBonus: customEffect.speedBonus }
        : {}),
      ...(customEffect.speedReduction !== undefined && customEffect.speedReduction > 0
        ? { speedReduction: customEffect.speedReduction }
        : {}),
      ...(customEffect.slow ? { slow: true } : {}),
      ...(customEffect.zeroSpeed ? { zeroSpeed: true } : {}),
      ...(customEffect.preventsHealing ? { preventsHealing: true } : {}),
      ...(customEffect.noOpportunityAttacks ? { noOpportunityAttacks: true } : {}),
      ...(customEffect.suppressesInvisibility ? { suppressesInvisibility: true } : {}),
      ...(customEffect.resistDamageTypes?.length
        ? { resistDamageTypes: customEffect.resistDamageTypes }
        : {}),
      ...(customEffect.immuneConditions?.length
        ? { immuneConditions: customEffect.immuneConditions }
        : {}),
      ...(mergedCures.length ? { cureConditions: mergedCures } : {}),
    };
    if (
      hasCustomEffectDetails({ ...ce, cureConditions: undefined }) &&
      !ce.conditionLabel?.trim()
    ) {
      ce.conditionLabel = name.trim() || 'Spell Effect';
    }
    return hasActiveCustomEffect(ce) ? ce : undefined;
  };

  const buildCandidateAbility = (): SheetAbility => {
    const cleanTags = tags.filter((t) => {
      const k = t.trim().toLowerCase();
      return k !== 'no-area' && (areaChoice !== 'none' || k !== 'aoe');
    });
    if (areaChoice === 'none' && catalogDefaultArea) {
      cleanTags.push('no-area');
    }

    const willUseManualProfile =
      !resetToRulesRequested &&
      (dirtyMechanics ||
        ability.executionProfile === 'manual' ||
        ability.source === 'custom' ||
        isNew);

    const baseAbility: SheetAbility = {
      ...ability,
      name: name.trim() || ability.name,
      type,
      ...(type === 'spell' || type === 'stance' ? { level } : { level: undefined }),
      school: school.trim() || undefined,
      actionType: actionType || undefined,
      sourceClass: sourceClass.trim() || undefined,
      meta: meta.trim() || undefined,
      tags: cleanTags.length ? cleanTags : undefined,
      ...(casterType === 'pc' && type === 'spell' && level > 0 ? { prepared } : {}),
      description,
      upcast: upcast.trim() || undefined,
      executionProfile: willUseManualProfile ? 'manual' : undefined,
    };

    if (!willUseManualProfile) {
      return baseAbility;
    }

    if (mode === 'manual') {
      return {
        ...baseAbility,
        roll: undefined,
        smite: undefined,
        summon: undefined,
      };
    }

    if (mode === 'summon') {
      return {
        ...baseAbility,
        roll: undefined,
        smite: undefined,
        summon: {
          name: summonName.trim() || name.trim() || 'Summon',
          icon: summonIcon.trim() || '✋',
        },
      };
    }

    if (mode === 'smite') {
      const bonusTypes = smiteBonusTypes
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      const smiteSpec: SmiteSpec = {
        dice: smiteDice.trim() || '2d8',
        ...(smiteScaleDice.trim() ? { scaleDice: smiteScaleDice.trim() } : {}),
        damageType: smiteDamageType.trim().toLowerCase() || 'radiant',
        ...(bonusTypes.length && smiteBonusDice.trim()
          ? { bonusVs: { creatureTypes: bonusTypes, dice: smiteBonusDice.trim() } }
          : {}),
        ...(smiteFreeCounter.trim()
          ? {
              freeUse: {
                counter: smiteFreeCounter.trim(),
                className: smiteFreeClass.trim().toLowerCase() || 'paladin',
                minLevel: smiteFreeMinLevel ?? 2,
              },
            }
          : {}),
      };
      return {
        ...baseAbility,
        roll: undefined,
        summon: undefined,
        smite: smiteSpec,
      };
    }

    // Roll-backed modes: attack | save | damage | heal | buff
    let area: SpellArea | undefined;
    if (areaChoice !== 'default' && areaChoice !== 'none') {
      area = {
        kind: areaChoice,
        sizeFt: Math.max(5, areaSizeFt || 20),
        rangeFt: Math.max(0, areaRangeFt ?? 0),
        ...(areaChoice === 'line' ? { widthFt: Math.max(5, areaWidthFt || 5) } : {}),
        ...(areaCount && areaCount >= 1 ? { count: areaCount } : {}),
        ...(areaMaxTargets && areaMaxTargets >= 1 ? { maxTargets: areaMaxTargets } : {}),
        ...(areaSelf ? { self: true } : {}),
        ...(areaExcludeCaster ? { excludeCaster: true } : {}),
        ...(areaSelective ? { selective: true } : {}),
        ...(areaOngoing ? { ongoing: true } : {}),
        ...(areaInitialEffect ? { initialEffect: true } : {}),
      };
    }

    const cleanedCustom = buildCleanedCustomEffect();
    const resolvedRollKind: AbilityRoll['kind'] = mode === 'buff' ? 'damage' : mode;
    const roll: AbilityRoll = {
      kind: resolvedRollKind,
      ...(castingAbility ? { castingAbility } : {}),
      ...(baseLevel !== undefined ? { baseLevel } : {}),
      ...(targetMode ? { targetMode } : {}),
      ...(maxTargets !== undefined && maxTargets >= 1 ? { maxTargets } : {}),
      ...(scaleTargets !== undefined && scaleTargets >= 1 ? { scaleTargets } : {}),
      ...(area ? { area } : {}),
      ...(cleanedCustom ? { customEffect: cleanedCustom } : {}),
    };

    if (mode === 'buff') {
      roll.dice = '0';
    } else {
      if (dice.trim()) roll.dice = dice.trim();
      if (scaleDice.trim()) roll.scaleDice = scaleDice.trim();
      if (mode === 'attack') {
        if (attackRange) roll.attackRange = attackRange;
        if (attackBonus !== undefined) roll.attackBonus = attackBonus;
        if (damageBonus) roll.damageBonus = damageBonus;
      }
      if (mode === 'save') {
        roll.save = saveAbility;
        roll.saveDamage = saveDamage;
        if (dc !== undefined) roll.dc = dc;
      }
      if (mode === 'heal') {
        roll.damageType = damageType.trim().toLowerCase() || 'healing';
        if (healingMode !== 'hitPoints') roll.healingMode = healingMode;
        if (healingBonus) roll.healingBonus = healingBonus;
        if (healTarget !== 'selected') roll.healTarget = healTarget;
      } else {
        if (damageType.trim()) roll.damageType = damageType.trim().toLowerCase();
        else if (damageTypeChoices.length) roll.damageTypeChoices = damageTypeChoices;
      }
      if (mode !== 'heal') {
        if (instances !== undefined && instances >= 1) roll.instances = instances;
        if (scaleInstances !== undefined && scaleInstances >= 1) {
          roll.scaleInstances = scaleInstances;
        }
        if (instanceScaling) roll.instanceScaling = instanceScaling;
      }
    }

    return {
      ...baseAbility,
      smite: undefined,
      summon:
        alsoSummon && summonName.trim()
          ? { name: summonName.trim(), icon: summonIcon.trim() || '⚔' }
          : undefined,
      roll,
    };
  };

  const previewAbility = buildCandidateAbility();
  const previewSupport = spellCombatSupport(previewAbility);
  const customEffectSummaryText = previewAbility.roll?.customEffect
    ? formatCustomEffectSummary(previewAbility.roll.customEffect)
    : undefined;

  const validateAndSave = () => {
    setError(null);
    if (!name.trim()) {
      setError('Spell / ability name is required.');
      return;
    }
    const diceChecks: [string, string][] =
      mode === 'smite'
        ? [
            ['Smite dice', smiteDice],
            ['Smite upcast scaling', smiteScaleDice],
            ['Smite bonus vs creature type dice', smiteBonusDice],
          ]
        : mode === 'attack' || mode === 'save' || mode === 'damage' || mode === 'heal'
          ? [
              ['Base dice / amount', dice],
              ['Upcast scaling', scaleDice],
              ['Repeat turn damage', customEffect.repeatDamage ?? ''],
              ['Attack bonus dice', customEffect.attackBonusDice ?? ''],
              ['Save bonus dice', customEffect.saveBonusDice ?? ''],
            ]
          : mode === 'buff'
            ? [
                ['Repeat turn damage', customEffect.repeatDamage ?? ''],
                ['Attack bonus dice', customEffect.attackBonusDice ?? ''],
                ['Save bonus dice', customEffect.saveBonusDice ?? ''],
              ]
            : [];

    for (const [label, expr] of diceChecks) {
      const trimmed = expr.trim();
      if (trimmed && !isValidDiceExpression(trimmed)) {
        setError(`Invalid dice expression for "${label}": "${trimmed}". Examples: 2d6, 1d8+3, -1d4, 5.`);
        return;
      }
    }

    if (mode === 'smite' && !smiteDice.trim()) {
      setError('Smite damage dice are required.');
      return;
    }

    onSave(previewAbility);
  };

  const resetToRulesDefault = async () => {
    const queryName = name.trim();
    if (!queryName) return;
    setResetBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch('/api/spells/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ names: [queryName] }),
      });
      const data = (res.ok ? await res.json() : null) as
        | { resolved?: Record<string, Partial<SheetAbility>> }
        | null;
      const hit = data?.resolved?.[queryName.toLowerCase()];
      if (!hit) {
        setNotice(`No built-in SRD definition found for "${queryName}".`);
        return;
      }
      const restoredRaw: SheetAbility = {
        ...ability,
        ...hit,
        id: ability.id,
        source: hit.source ?? 'srd',
        sourceClass: sourceClass.trim() || ability.sourceClass,
        prepared,
        executionProfile: undefined,
      };
      const eff = effectiveSheetAbility(restoredRaw);
      const r = eff.roll;
      setType(restoredRaw.type);
      setLevel(restoredRaw.level ?? 0);
      setSchool(restoredRaw.school ?? '');
      setActionType(restoredRaw.actionType ?? parseActionType(restoredRaw.meta) ?? '');
      setMeta(restoredRaw.meta ?? '');
      setTags(eff.tags ?? restoredRaw.tags ?? []);
      setDescription(restoredRaw.description ?? '');
      setUpcast(restoredRaw.upcast ?? '');
      setMode(initialEffectMode(eff));
      setDice(r?.kind === 'damage' && (r.dice ?? '').trim() === '0' ? '' : (r?.dice ?? ''));
      setScaleDice(r?.scaleDice ?? '');
      setBaseLevel(r?.baseLevel);
      setAttackRange(r?.attackRange ?? '');
      setAttackBonus(r?.attackBonus);
      setDamageType(r?.damageType ?? '');
      setDamageTypeChoices(r?.damageTypeChoices ?? []);
      setDamageBonus(r?.damageBonus ?? '');
      setSaveAbility(r?.save ?? 'DEX');
      setSaveDamage(r?.saveDamage ?? 'half');
      setDc(r?.dc);
      setHealingMode(r?.healingMode ?? 'hitPoints');
      setHealingBonus(r?.healingBonus ?? '');
      setHealTarget(r?.healTarget ?? 'selected');
      setInstances(r?.instances);
      setScaleInstances(r?.scaleInstances);
      setInstanceScaling(r?.instanceScaling ?? '');
      setTargetMode(r?.targetMode ?? '');
      setMaxTargets(r?.maxTargets);
      setScaleTargets(r?.scaleTargets);
      setCastingAbility(r?.castingAbility ?? '');
      setCustomEffect(r?.customEffect ?? {});
      setExtraCureInput('');
      setSmiteDice(eff.smite?.dice ?? '2d8');
      setSmiteScaleDice(eff.smite?.scaleDice ?? '1d8');
      setSmiteDamageType(eff.smite?.damageType ?? 'radiant');
      setSmiteBonusTypes(eff.smite?.bonusVs?.creatureTypes.join(', ') ?? '');
      setSmiteBonusDice(eff.smite?.bonusVs?.dice ?? '');
      setSmiteFreeCounter(eff.smite?.freeUse?.counter ?? '');
      setSmiteFreeClass(eff.smite?.freeUse?.className ?? 'paladin');
      setSmiteFreeMinLevel(eff.smite?.freeUse?.minLevel);
      setSummonName(eff.summon?.name ?? '');
      setSummonIcon(eff.summon?.icon ?? '✋');
      setAlsoSummon(Boolean(eff.summon && r));
      const catArea =
        restoredRaw.type === 'spell'
          ? spellAreaFor({ name: restoredRaw.name, type: 'spell', level: restoredRaw.level })
          : undefined;
      if (r?.area) {
        setAreaChoice(r.area.kind);
        setAreaSizeFt(r.area.sizeFt);
        setAreaWidthFt(r.area.widthFt ?? 5);
        setAreaRangeFt(r.area.rangeFt);
        setAreaCount(r.area.count);
        setAreaMaxTargets(r.area.maxTargets);
        setAreaSelf(!!r.area.self);
        setAreaExcludeCaster(!!r.area.excludeCaster);
        setAreaSelective(!!r.area.selective);
        setAreaOngoing(!!r.area.ongoing);
        setAreaInitialEffect(!!r.area.initialEffect);
      } else {
        setAreaChoice(catArea ? 'default' : 'none');
      }
      setDirtyMechanics(false);
      setResetToRulesRequested(true);
      setNotice(`Loaded default rules for "${restoredRaw.name}". Click Save to keep them.`);
    } catch {
      setError('Failed to look up default spell rules.');
    } finally {
      setResetBusy(false);
    }
  };

  const classOptions = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const c of classRoster ?? []) {
      const k = c.className.toLowerCase();
      if (!seen.has(k)) {
        seen.add(k);
        out.push(k);
      }
    }
    for (const c of CORE_CLASSES) {
      if (!seen.has(c)) {
        seen.add(c);
        out.push(c);
      }
    }
    return out;
  }, [classRoster]);

  const showRollControls =
    mode === 'attack' ||
    mode === 'save' ||
    mode === 'damage' ||
    mode === 'heal' ||
    mode === 'buff';

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal spell-effect-editor-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Edit spell ${ability.name || 'custom'}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="see-head">
          <h3>{isNew ? '✨ Build Custom Spell / Ability' : `⚙️ Edit: ${name || ability.name}`}</h3>
          <SpellCombatSupportBadge ability={previewAbility} />
          <button className="res-x" title="Close" onClick={onClose} style={{ marginLeft: 'auto' }}>
            ✕
          </button>
        </div>

        <div className="see-body">
          <div className="see-banner">
            <div>
              {dirtyMechanics || ability.executionProfile === 'manual' || ability.source === 'custom' ? (
                <>
                  <strong>Manual effect profile active.</strong> Your custom mechanics, rolls,
                  conditions, and area rules govern casting.
                </>
              ) : (
                <>
                  <strong>Built-in rules automation active ({previewSupport?.label ?? 'Active'}).</strong>{' '}
                  Editing any mechanic switches this entry to manual control.
                </>
              )}
            </div>
            {type === 'spell' && (
              <button
                type="button"
                className="btn tiny"
                disabled={resetBusy || !name.trim()}
                onClick={resetToRulesDefault}
                title="Reload mechanics & text from the SRD rules database"
              >
                {resetBusy ? 'Resetting…' : '↺ Reset to Rules Default'}
              </button>
            )}
          </div>

          {notice && (
            <div className="see-banner" style={{ borderColor: 'var(--green)', color: '#b7f5cf' }}>
              {notice}
            </div>
          )}
          {error && (
            <div
              className="see-banner"
              style={{ borderColor: '#f87171', background: 'rgba(248, 113, 113, 0.12)', color: '#fecaca' }}
            >
              {error}
            </div>
          )}

          {/* Basics & Economy */}
          <section className="see-section">
            <div className="see-section-title">
              <span>Basics &amp; Spell Economy</span>
            </div>
            <div className="see-grid">
              <label className="see-field" style={{ gridColumn: 'span 2' }}>
                Name
                <input
                  value={name}
                  placeholder="Spell or ability name"
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label className="see-field">
                Entry Type
                <select
                  value={type}
                  onChange={(e) => {
                    markMech();
                    setType(e.target.value as SheetAbility['type']);
                  }}
                >
                  <option value="spell">Spell</option>
                  <option value="ability">Ability / Action</option>
                  <option value="stance">Stance</option>
                  <option value="maneuver">Maneuver</option>
                  <option value="mastery">Mastery</option>
                </select>
              </label>
              {(type === 'spell' || type === 'stance') && (
                <label className="see-field">
                  Level (0 = Cantrip)
                  <NumberInput
                    min={0}
                    max={9}
                    emptyFallback={0}
                    value={level}
                    onValueChange={(v) => {
                      markMech();
                      setLevel(v ?? 0);
                    }}
                  />
                </label>
              )}
              <label className="see-field">
                School / Category
                <input
                  list="see-school-list"
                  value={school}
                  placeholder="Evocation, Feature…"
                  onChange={(e) => setSchool(e.target.value)}
                />
                <datalist id="see-school-list">
                  {SCHOOLS.map((s) => (
                    <option key={s} value={s} />
                  ))}
                </datalist>
              </label>
              <label className="see-field">
                Action Cost
                <select
                  value={actionType}
                  onChange={(e) => {
                    markMech();
                    setActionType(e.target.value as ActionType | '');
                  }}
                >
                  <option value="">Auto from meta</option>
                  <option value="action">Action (●)</option>
                  <option value="bonus">Bonus Action (⚡)</option>
                  <option value="reaction">Reaction (↩)</option>
                </select>
              </label>
              {casterType === 'pc' && (
                <label className="see-field">
                  Class
                  <select value={sourceClass} onChange={(e) => setSourceClass(e.target.value)}>
                    <option value="">Auto / General</option>
                    {classOptions.map((c) => (
                      <option key={c} value={c}>
                        {c.charAt(0).toUpperCase() + c.slice(1)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="see-field">
                Casting Ability
                <select
                  value={castingAbility ?? ''}
                  onChange={(e) => {
                    markMech();
                    setCastingAbility(e.target.value as AbilityRoll['castingAbility'] | '');
                  }}
                >
                  <option value="">Auto (from class/stat block)</option>
                  <option value="INT">INT</option>
                  <option value="WIS">WIS</option>
                  <option value="CHA">CHA</option>
                </select>
              </label>
              <label className="see-field" style={{ gridColumn: 'span 2' }}>
                Cast Time · Range · Components (Meta)
                <input
                  value={meta}
                  placeholder="e.g. 1 action · 60 ft · V, S"
                  onChange={(e) => setMeta(e.target.value)}
                />
              </label>
            </div>

            <div className="see-checks">
              <label className="see-check">
                <input
                  type="checkbox"
                  checked={isConcentration}
                  onChange={(e) => toggleConcentration(e.target.checked)}
                />
                Concentration
              </label>
              <label className="see-check">
                <input
                  type="checkbox"
                  checked={isRitual}
                  onChange={(e) => toggleRitual(e.target.checked)}
                />
                Ritual
              </label>
              {casterType === 'pc' && type === 'spell' && level > 0 && (
                <label className="see-check">
                  <input
                    type="checkbox"
                    checked={prepared}
                    onChange={(e) => setPrepared(e.target.checked)}
                  />
                  Prepared
                </label>
              )}
            </div>
          </section>

          {/* Effect Mode */}
          <section className="see-section">
            <div className="see-section-title">
              <span>Effect Mode</span>
            </div>
            <label className="see-field">
              How this resolves when cast / used
              <select
                value={mode}
                onChange={(e) => {
                  markMech();
                  const next = e.target.value as EffectMode;
                  setMode(next);
                  if (next === 'heal' && (!damageType || damageType === 'none')) {
                    setDamageType('healing');
                  }
                }}
              >
                <option value="attack">Attack Roll (Hit/Miss + Damage/Conditions)</option>
                <option value="save">Saving Throw (DC + Damage and/or Conditions)</option>
                <option value="damage">Auto-Hit Damage / Darts</option>
                <option value="heal">Healing / Temporary HP / Cures</option>
                <option value="buff">Buff / Debuff / Condition / Cure (no damage dice)</option>
                <option value="smite">On-Hit Smite (triggers after weapon hit)</option>
                <option value="summon">Summon Companion Token</option>
                <option value="manual">Narrative / Manual Only (no automated roll)</option>
              </select>
            </label>
          </section>

          {/* Attack / Save / Damage / Heal Configuration */}
          {showRollControls && (
            <>
              <section className="see-section">
                <div className="see-section-title">
                  <span>
                    {mode === 'buff'
                      ? 'Casting Scaling Base'
                      : mode === 'heal'
                        ? 'Healing & Scaling'
                        : 'Roll, Damage & Scaling'}
                  </span>
                </div>

                <div className="see-grid">
                  {mode !== 'buff' && (
                    <>
                      <label className="see-field">
                        {mode === 'heal'
                          ? 'Heal Dice / Flat Amount'
                          : 'Damage Dice / Flat (blank = save condition only)'}
                        <input
                          value={dice}
                          placeholder={mode === 'heal' ? 'e.g. 1d8 or 70' : 'e.g. 8d6 or 2d8+4'}
                          onChange={(e) => {
                            markMech();
                            setDice(e.target.value);
                          }}
                        />
                      </label>
                      <label className="see-field">
                        Upcast Scale Dice (per slot/tier)
                        <input
                          value={scaleDice}
                          placeholder="e.g. 1d6 or 5"
                          onChange={(e) => {
                            markMech();
                            setScaleDice(e.target.value);
                          }}
                        />
                      </label>
                    </>
                  )}
                  <label className="see-field">
                    Base Spell Level (0 = cantrip)
                    <NumberInput
                      min={0}
                      max={9}
                      allowEmpty
                      placeholder="auto"
                      value={baseLevel}
                      onValueChange={(v) => {
                        markMech();
                        setBaseLevel(v);
                      }}
                    />
                  </label>

                  {mode === 'attack' && (
                    <>
                      <label className="see-field">
                        Attack Range
                        <select
                          value={attackRange}
                          onChange={(e) => {
                            markMech();
                            setAttackRange(e.target.value as 'melee' | 'ranged' | '');
                          }}
                        >
                          <option value="">Auto (from range/meta)</option>
                          <option value="melee">Melee</option>
                          <option value="ranged">Ranged</option>
                        </select>
                      </label>
                      <label className="see-field">
                        To-Hit Override (blank = derived)
                        <NumberInput
                          allowEmpty
                          allowNegative
                          min={-10}
                          max={40}
                          placeholder="derived"
                          value={attackBonus}
                          onValueChange={(v) => {
                            markMech();
                            setAttackBonus(v);
                          }}
                        />
                      </label>
                      <label className="see-field">
                        Flat Damage Bonus
                        <select
                          value={damageBonus}
                          onChange={(e) => {
                            markMech();
                            setDamageBonus(e.target.value as 'spellcasting' | '');
                          }}
                        >
                          <option value="">None</option>
                          <option value="spellcasting">+ Spellcasting Modifier</option>
                        </select>
                      </label>
                    </>
                  )}

                  {mode === 'save' && (
                    <>
                      <label className="see-field">
                        Save Ability
                        <select
                          value={saveAbility}
                          onChange={(e) => {
                            markMech();
                            setSaveAbility(e.target.value);
                          }}
                        >
                          {SAVE_ABILITIES.map((s) => (
                            <option key={s} value={s}>
                              {s}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="see-field">
                        On Successful Save
                        <select
                          value={saveDamage}
                          onChange={(e) => {
                            markMech();
                            setSaveDamage(e.target.value as 'none' | 'half');
                          }}
                        >
                          <option value="half">Half Damage (no condition)</option>
                          <option value="none">No Damage / No Effect</option>
                        </select>
                      </label>
                      <label className="see-field">
                        DC Override (blank = derived)
                        <NumberInput
                          allowEmpty
                          min={1}
                          max={40}
                          placeholder="derived"
                          value={dc}
                          onValueChange={(v) => {
                            markMech();
                            setDc(v);
                          }}
                        />
                      </label>
                    </>
                  )}

                  {(mode === 'attack' || mode === 'save' || mode === 'damage') && (
                    <label className="see-field">
                      Damage Type
                      <select
                        value={damageType}
                        onChange={(e) => {
                          markMech();
                          setDamageType(e.target.value);
                        }}
                      >
                        <option value="">None / Variable Choices</option>
                        {DAMAGE_TYPES.map((t) => (
                          <option key={t} value={t}>
                            {t.charAt(0).toUpperCase() + t.slice(1)}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}

                  {mode === 'heal' && (
                    <>
                      <label className="see-field">
                        Healing Pool Type
                        <select
                          value={healingMode}
                          onChange={(e) => {
                            markMech();
                            setHealingMode(e.target.value as 'hitPoints' | 'temporary');
                          }}
                        >
                          <option value="hitPoints">Restore Hit Points</option>
                          <option value="temporary">Grant Temporary HP</option>
                        </select>
                      </label>
                      <label className="see-field">
                        Healing Bonus
                        <select
                          value={healingBonus}
                          onChange={(e) => {
                            markMech();
                            setHealingBonus(
                              e.target.value as 'none' | 'spellcasting' | 'fighterLevel' | '',
                            );
                          }}
                        >
                          <option value="">Auto</option>
                          <option value="spellcasting">+ Spellcasting Modifier</option>
                          <option value="none">None (fixed dice)</option>
                          <option value="fighterLevel">+ Fighter Level</option>
                        </select>
                      </label>
                      <label className="see-field">
                        Heal Recipient
                        <select
                          value={healTarget}
                          onChange={(e) => {
                            markMech();
                            setHealTarget(e.target.value as 'self' | 'selected');
                          }}
                        >
                          <option value="selected">Selected Target(s)</option>
                          <option value="self">Caster Only (Self)</option>
                        </select>
                      </label>
                    </>
                  )}
                </div>

                {(mode === 'attack' || mode === 'save' || mode === 'damage') && !damageType && (
                  <div>
                    <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>
                      Variable Damage Choices (lets caster choose element on cast)
                    </div>
                    <div className="see-chips">
                      {DAMAGE_TYPES.map((t) => {
                        const active = damageTypeChoices.includes(t);
                        return (
                          <button
                            key={t}
                            type="button"
                            className={`see-chip ${active ? 'on' : ''}`}
                            onClick={() => {
                              markMech();
                              setDamageTypeChoices((prev) => toggleStringInList(prev, t));
                            }}
                          >
                            {t}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {(mode === 'attack' || mode === 'damage' || mode === 'save') && (
                  <div className="see-grid">
                    <label className="see-field">
                      Instances / Rays / Darts
                      <NumberInput
                        allowEmpty
                        min={1}
                        max={100}
                        placeholder="1"
                        value={instances}
                        onValueChange={(v) => {
                          markMech();
                          setInstances(v);
                        }}
                      />
                    </label>
                    <label className="see-field">
                      Extra Instances / Level
                      <NumberInput
                        allowEmpty
                        min={0}
                        max={20}
                        placeholder="0"
                        value={scaleInstances}
                        onValueChange={(v) => {
                          markMech();
                          setScaleInstances(v);
                        }}
                      />
                    </label>
                    <label className="see-field">
                      Instance Scaling Rule
                      <select
                        value={instanceScaling}
                        onChange={(e) => {
                          markMech();
                          setInstanceScaling(e.target.value as 'cantrip' | '');
                        }}
                      >
                        <option value="">Per Spell Slot Level</option>
                        <option value="cantrip">Cantrip Tiers (Lvl 5/11/17)</option>
                      </select>
                    </label>
                  </div>
                )}
              </section>

              {/* Targeting & Measured Map Area */}
              <section className="see-section">
                <div className="see-section-title">
                  <span>Targeting &amp; Measured Map Area</span>
                </div>
                <div className="see-grid">
                  <label className="see-field">
                    Target Mode
                    <select
                      value={targetMode}
                      onChange={(e) => {
                        markMech();
                        setTargetMode(e.target.value as 'single' | 'multiple' | '');
                      }}
                    >
                      <option value="">Auto</option>
                      <option value="single">Single Target</option>
                      <option value="multiple">Multiple Targets / Area</option>
                    </select>
                  </label>
                  <label className="see-field">
                    Max Targets (picker limit)
                    <NumberInput
                      allowEmpty
                      min={1}
                      max={20}
                      placeholder="unlimited"
                      value={maxTargets}
                      onValueChange={(v) => {
                        markMech();
                        setMaxTargets(v);
                      }}
                    />
                  </label>
                  <label className="see-field">
                    Extra Targets / Slot Level
                    <NumberInput
                      allowEmpty
                      min={0}
                      max={10}
                      placeholder="0"
                      value={scaleTargets}
                      onValueChange={(v) => {
                        markMech();
                        setScaleTargets(v);
                      }}
                    />
                  </label>
                  <label className="see-field">
                    Map Area Template
                    <select
                      value={areaChoice}
                      onChange={(e) => {
                        markMech();
                        setAreaChoice(e.target.value as 'default' | 'none' | SpellAreaKind);
                      }}
                    >
                      {catalogDefaultArea && (
                        <option value="default">
                          Catalog default ({catalogDefaultArea.sizeFt}-ft {catalogDefaultArea.kind})
                        </option>
                      )}
                      <option value="none">None (selected token / picker only)</option>
                      {AREA_SHAPES.map((s) => (
                        <option key={s.value} value={s.value}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                {areaChoice !== 'default' && areaChoice !== 'none' && (
                  <>
                    <div className="see-grid">
                      <label className="see-field">
                        Size / Radius / Length (ft)
                        <NumberInput
                          min={5}
                          max={1000}
                          emptyFallback={20}
                          value={areaSizeFt}
                          onValueChange={(v) => {
                            markMech();
                            setAreaSizeFt(v ?? 20);
                          }}
                        />
                      </label>
                      {areaChoice === 'line' && (
                        <label className="see-field">
                          Line Width (ft)
                          <NumberInput
                            min={5}
                            max={500}
                            emptyFallback={5}
                            value={areaWidthFt}
                            onValueChange={(v) => {
                              markMech();
                              setAreaWidthFt(v ?? 5);
                            }}
                          />
                        </label>
                      )}
                      <label className="see-field">
                        Cast Range (ft, 0 = Self)
                        <NumberInput
                          min={0}
                          max={5000}
                          emptyFallback={60}
                          value={areaRangeFt}
                          onValueChange={(v) => {
                            markMech();
                            setAreaRangeFt(v ?? 0);
                          }}
                        />
                      </label>
                      <label className="see-field">
                        Zone Count (e.g. Meteor)
                        <NumberInput
                          allowEmpty
                          min={1}
                          max={40}
                          placeholder="1"
                          value={areaCount}
                          onValueChange={(v) => {
                            markMech();
                            setAreaCount(v);
                          }}
                        />
                      </label>
                      <label className="see-field">
                        Area Max Affected
                        <NumberInput
                          allowEmpty
                          min={1}
                          max={40}
                          placeholder="unlimited"
                          value={areaMaxTargets}
                          onValueChange={(v) => {
                            markMech();
                            setAreaMaxTargets(v);
                          }}
                        />
                      </label>
                    </div>
                    <div className="see-checks">
                      <label className="see-check">
                        <input
                          type="checkbox"
                          checked={areaSelf}
                          onChange={(e) => {
                            markMech();
                            setAreaSelf(e.target.checked);
                          }}
                        />
                        Origin Self
                      </label>
                      <label className="see-check">
                        <input
                          type="checkbox"
                          checked={areaExcludeCaster}
                          onChange={(e) => {
                            markMech();
                            setAreaExcludeCaster(e.target.checked);
                          }}
                        />
                        Exclude Caster
                      </label>
                      <label className="see-check">
                        <input
                          type="checkbox"
                          checked={areaSelective}
                          onChange={(e) => {
                            markMech();
                            setAreaSelective(e.target.checked);
                          }}
                        />
                        Selective Targets
                      </label>
                      <label className="see-check">
                        <input
                          type="checkbox"
                          checked={areaOngoing}
                          onChange={(e) => {
                            markMech();
                            setAreaOngoing(e.target.checked);
                          }}
                        />
                        Ongoing Map Zone
                      </label>
                      <label className="see-check">
                        <input
                          type="checkbox"
                          checked={areaInitialEffect}
                          onChange={(e) => {
                            markMech();
                            setAreaInitialEffect(e.target.checked);
                          }}
                        />
                        Apply Immediate Roll on Placement
                      </label>
                    </div>
                  </>
                )}
              </section>

              {/* Conditions, Buffs, Debuffs & Ongoing Effects */}
              <section className="see-section">
                <div className="see-section-title">
                  <span>Conditions, Buffs, Debuffs &amp; Cures</span>
                  {customEffectSummaryText && (
                    <span style={{ fontWeight: 400, textTransform: 'none', color: 'var(--text)' }}>
                      {customEffectSummaryText}
                    </span>
                  )}
                </div>

                <div className="see-grid">
                  <label className="see-field">
                    Condition / Buff Label
                    <input
                      value={customEffect.conditionLabel ?? ''}
                      placeholder="e.g. Paralyzed, Blessed, Shielded"
                      onChange={(e) => patchCustom({ conditionLabel: e.target.value })}
                    />
                  </label>
                  <label className="see-field">
                    Apply Effect To
                    <select
                      value={customEffect.target ?? 'affected'}
                      onChange={(e) =>
                        patchCustom({
                          target: e.target.value as SpellCustomEffect['target'],
                        })
                      }
                    >
                      <option value="affected">Affected Target(s) / Failed Save / Hit</option>
                      <option value="self">Caster (Self)</option>
                      <option value="ally">Selected Friendly Target(s)</option>
                    </select>
                  </label>
                  <label className="see-field">
                    Token Ring / Aura
                    <select
                      value={customEffect.aura ?? ''}
                      onChange={(e) =>
                        patchCustom({
                          aura: (e.target.value || undefined) as SpellCustomEffect['aura'],
                        })
                      }
                    >
                      <option value="">Auto</option>
                      <option value="green">Green (Buff)</option>
                      <option value="blue">Blue (Ward / Protection)</option>
                      <option value="red">Red (Debuff / Hazard)</option>
                    </select>
                  </label>
                  <label className="see-field">
                    Chip Note
                    <input
                      value={customEffect.note ?? ''}
                      placeholder="Short note on token condition chip"
                      onChange={(e) => patchCustom({ note: e.target.value })}
                    />
                  </label>
                </div>

                <div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>
                    Quick Condition / Buff Presets
                  </div>
                  <div className="see-chips">
                    {CONDITION_PRESETS.map((preset) => (
                      <button
                        key={preset}
                        type="button"
                        className={`see-chip ${
                          customEffect.conditionLabel?.trim().toLowerCase() ===
                          preset.toLowerCase()
                            ? 'on'
                            : ''
                        }`}
                        onClick={() => patchCustom({ conditionLabel: preset })}
                      >
                        {preset}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="see-grid">
                  <label className="see-field">
                    Duration (Rounds)
                    <NumberInput
                      allowEmpty
                      min={1}
                      max={999}
                      placeholder="indefinite / conc"
                      value={customEffect.durationRounds}
                      onValueChange={(v) => patchCustom({ durationRounds: v })}
                    />
                  </label>
                  <label className="see-field">
                    Repeat Save Ability
                    <select
                      value={customEffect.repeatSave ?? ''}
                      onChange={(e) => patchCustom({ repeatSave: e.target.value || undefined })}
                    >
                      <option value="">None</option>
                      {SAVE_ABILITIES.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="see-field">
                    Repeat / Turn Timing
                    <select
                      value={customEffect.repeatPhase ?? 'end'}
                      onChange={(e) =>
                        patchCustom({ repeatPhase: e.target.value as 'start' | 'end' })
                      }
                    >
                      <option value="end">End of Target&apos;s Turn</option>
                      <option value="start">Start of Target&apos;s Turn</option>
                    </select>
                  </label>
                  <label className="see-field">
                    Ongoing Turn Damage
                    <input
                      value={customEffect.repeatDamage ?? ''}
                      placeholder="e.g. 2d6"
                      onChange={(e) => patchCustom({ repeatDamage: e.target.value })}
                    />
                  </label>
                  <label className="see-field">
                    Ongoing Damage Type
                    <select
                      value={customEffect.repeatDamageType ?? ''}
                      onChange={(e) =>
                        patchCustom({ repeatDamageType: e.target.value || undefined })
                      }
                    >
                      <option value="">None / Same</option>
                      {DAMAGE_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {t.charAt(0).toUpperCase() + t.slice(1)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="see-field">
                    Temp HP Each Turn
                    <NumberInput
                      allowEmpty
                      min={0}
                      max={999}
                      placeholder="0"
                      value={customEffect.tempHpPerTurn}
                      onValueChange={(v) => patchCustom({ tempHpPerTurn: v })}
                    />
                  </label>
                </div>

                <div className="see-checks">
                  <label className="see-check">
                    <input
                      type="checkbox"
                      checked={!!customEffect.untilTargetStart}
                      onChange={(e) => patchCustom({ untilTargetStart: e.target.checked })}
                    />
                    Expires Start of Target&apos;s Turn
                  </label>
                  <label className="see-check">
                    <input
                      type="checkbox"
                      checked={!!customEffect.untilCasterEnd}
                      onChange={(e) => patchCustom({ untilCasterEnd: e.target.checked })}
                    />
                    Expires End of Caster&apos;s Next Turn
                  </label>
                  <label className="see-check">
                    <input
                      type="checkbox"
                      checked={!!customEffect.saveBeforeDamage}
                      onChange={(e) => patchCustom({ saveBeforeDamage: e.target.checked })}
                    />
                    Save Before Taking Turn Damage
                  </label>
                </div>

                <div className="see-grid">
                  <label className="see-field">
                    AC Bonus (+/-)
                    <NumberInput
                      allowEmpty
                      allowNegative
                      min={-20}
                      max={30}
                      placeholder="0"
                      value={customEffect.acBonus}
                      onValueChange={(v) => patchCustom({ acBonus: v })}
                    />
                  </label>
                  <label className="see-field">
                    Base AC Override (e.g. 13)
                    <NumberInput
                      allowEmpty
                      min={1}
                      max={30}
                      placeholder="none"
                      value={customEffect.baseAc}
                      onValueChange={(v) => patchCustom({ baseAc: v })}
                    />
                  </label>
                  <label className="see-field">
                    Attack Flat Bonus (+/-)
                    <NumberInput
                      allowEmpty
                      allowNegative
                      min={-20}
                      max={30}
                      placeholder="0"
                      value={customEffect.attackBonus}
                      onValueChange={(v) => patchCustom({ attackBonus: v })}
                    />
                  </label>
                  <label className="see-field">
                    Save Flat Bonus (+/-)
                    <NumberInput
                      allowEmpty
                      allowNegative
                      min={-20}
                      max={30}
                      placeholder="0"
                      value={customEffect.saveBonus}
                      onValueChange={(v) => patchCustom({ saveBonus: v })}
                    />
                  </label>
                  <label className="see-field">
                    Attack Bonus/Penalty Dice
                    <input
                      value={customEffect.attackBonusDice ?? ''}
                      placeholder="e.g. 1d4 or -1d4"
                      onChange={(e) => patchCustom({ attackBonusDice: e.target.value })}
                    />
                  </label>
                  <label className="see-field">
                    Save Bonus/Penalty Dice
                    <input
                      value={customEffect.saveBonusDice ?? ''}
                      placeholder="e.g. 1d4 or -1d4"
                      onChange={(e) => patchCustom({ saveBonusDice: e.target.value })}
                    />
                  </label>
                  <label className="see-field">
                    Speed Bonus (+ft)
                    <NumberInput
                      allowEmpty
                      allowNegative
                      min={-100}
                      max={200}
                      placeholder="0"
                      value={customEffect.speedBonus}
                      onValueChange={(v) => patchCustom({ speedBonus: v })}
                    />
                  </label>
                  <label className="see-field">
                    Speed Reduction (-ft)
                    <NumberInput
                      allowEmpty
                      min={0}
                      max={200}
                      placeholder="0"
                      value={customEffect.speedReduction}
                      onValueChange={(v) => patchCustom({ speedReduction: v })}
                    />
                  </label>
                </div>

                <div className="see-checks">
                  {customEffect.baseAc !== undefined && customEffect.baseAc > 0 && (
                    <label className="see-check">
                      <input
                        type="checkbox"
                        checked={!!customEffect.baseAcAddsDex}
                        onChange={(e) => patchCustom({ baseAcAddsDex: e.target.checked })}
                      />
                      Base AC adds DEX mod (Mage Armor)
                    </label>
                  )}
                  <label className="see-check">
                    <input
                      type="checkbox"
                      checked={!!customEffect.grantsAdvantageToAttackers}
                      onChange={(e) =>
                        patchCustom({ grantsAdvantageToAttackers: e.target.checked })
                      }
                    />
                    Attackers have Advantage
                  </label>
                  <label className="see-check">
                    <input
                      type="checkbox"
                      checked={!!customEffect.nextAttackAdvantage}
                      onChange={(e) => patchCustom({ nextAttackAdvantage: e.target.checked })}
                    />
                    Next Attack vs Target has Advantage
                  </label>
                  <label className="see-check">
                    <input
                      type="checkbox"
                      checked={!!customEffect.attackDisadvantage}
                      onChange={(e) => patchCustom({ attackDisadvantage: e.target.checked })}
                    />
                    Target&apos;s Attacks have Disadvantage
                  </label>
                  <label className="see-check">
                    <input
                      type="checkbox"
                      checked={!!customEffect.nextAttackDisadvantage}
                      onChange={(e) => patchCustom({ nextAttackDisadvantage: e.target.checked })}
                    />
                    Target&apos;s Next Attack has Disadvantage
                  </label>
                  <label className="see-check">
                    <input
                      type="checkbox"
                      checked={!!customEffect.checkDisadvantage}
                      onChange={(e) => patchCustom({ checkDisadvantage: e.target.checked })}
                    />
                    Ability Checks Disadvantage
                  </label>
                  <label className="see-check">
                    <input
                      type="checkbox"
                      checked={!!customEffect.slow}
                      onChange={(e) => patchCustom({ slow: e.target.checked })}
                    />
                    Slowed (Half speed, -2 AC/DEX saves)
                  </label>
                  <label className="see-check">
                    <input
                      type="checkbox"
                      checked={!!customEffect.zeroSpeed}
                      onChange={(e) => patchCustom({ zeroSpeed: e.target.checked })}
                    />
                    Speed = 0
                  </label>
                  <label className="see-check">
                    <input
                      type="checkbox"
                      checked={!!customEffect.preventsHealing}
                      onChange={(e) => patchCustom({ preventsHealing: e.target.checked })}
                    />
                    Cannot Regain HP
                  </label>
                  <label className="see-check">
                    <input
                      type="checkbox"
                      checked={!!customEffect.noOpportunityAttacks}
                      onChange={(e) => patchCustom({ noOpportunityAttacks: e.target.checked })}
                    />
                    No Opportunity Attacks / Reactions
                  </label>
                  <label className="see-check">
                    <input
                      type="checkbox"
                      checked={!!customEffect.suppressesInvisibility}
                      onChange={(e) => patchCustom({ suppressesInvisibility: e.target.checked })}
                    />
                    Reveals / Suppresses Invisibility
                  </label>
                </div>

                <div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>
                    Grants Damage Resistance
                  </div>
                  <div className="see-chips">
                    {DAMAGE_TYPES.map((t) => {
                      const active = customEffect.resistDamageTypes?.includes(t);
                      return (
                        <button
                          key={t}
                          type="button"
                          className={`see-chip ${active ? 'on' : ''}`}
                          onClick={() =>
                            patchCustom({
                              resistDamageTypes: toggleStringInList(
                                customEffect.resistDamageTypes,
                                t,
                              ),
                            })
                          }
                        >
                          {t}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>
                    Grants Condition Immunity
                  </div>
                  <div className="see-chips">
                    {IMMUNITY_AND_CURE_CONDITIONS.map((c) => {
                      const active = customEffect.immuneConditions?.some(
                        (x) => x.toLowerCase() === c.toLowerCase(),
                      );
                      return (
                        <button
                          key={c}
                          type="button"
                          className={`see-chip ${active ? 'on' : ''}`}
                          onClick={() =>
                            patchCustom({
                              immuneConditions: toggleStringInList(
                                customEffect.immuneConditions,
                                c,
                              ),
                            })
                          }
                        >
                          {c}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>
                    Cures / Removes Conditions on Hit or Heal
                  </div>
                  <div className="see-chips">
                    {IMMUNITY_AND_CURE_CONDITIONS.map((c) => {
                      const active = customEffect.cureConditions?.some(
                        (x) => x.toLowerCase() === c.toLowerCase(),
                      );
                      return (
                        <button
                          key={c}
                          type="button"
                          className={`see-chip ${active ? 'on' : ''}`}
                          onClick={() =>
                            patchCustom({
                              cureConditions: toggleStringInList(customEffect.cureConditions, c),
                            })
                          }
                        >
                          {c}
                        </button>
                      );
                    })}
                  </div>
                  <label className="see-field" style={{ marginTop: 6 }}>
                    Additional Cure Condition Names (comma-separated)
                    <input
                      value={extraCureInput}
                      placeholder="e.g. Hex, Marked, Disease"
                      onChange={(e) => {
                        markMech();
                        setExtraCureInput(e.target.value);
                      }}
                    />
                  </label>
                </div>

                <div className="see-checks">
                  <label className="see-check">
                    <input
                      type="checkbox"
                      checked={alsoSummon}
                      onChange={(e) => {
                        markMech();
                        setAlsoSummon(e.target.checked);
                        if (e.target.checked && !summonName.trim()) {
                          setSummonName(name.trim() || 'Companion');
                        }
                      }}
                    />
                    Also spawn summon token on cast
                  </label>
                </div>
                {alsoSummon && (
                  <div className="see-grid">
                    <label className="see-field">
                      Summon Token Name
                      <input
                        value={summonName}
                        placeholder="e.g. Spiritual Weapon"
                        onChange={(e) => {
                          markMech();
                          setSummonName(e.target.value);
                        }}
                      />
                    </label>
                    <label className="see-field">
                      Summon Token Icon
                      <input
                        value={summonIcon}
                        placeholder="⚔"
                        onChange={(e) => {
                          markMech();
                          setSummonIcon(e.target.value);
                        }}
                      />
                    </label>
                  </div>
                )}
              </section>
            </>
          )}

          {/* Smite Mode */}
          {mode === 'smite' && (
            <section className="see-section">
              <div className="see-section-title">
                <span>On-Hit Smite Configuration</span>
              </div>
              <div className="see-grid">
                <label className="see-field">
                  Base Smite Dice
                  <input
                    value={smiteDice}
                    placeholder="2d8"
                    onChange={(e) => {
                      markMech();
                      setSmiteDice(e.target.value);
                    }}
                  />
                </label>
                <label className="see-field">
                  Upcast Scale Dice (+per slot level)
                  <input
                    value={smiteScaleDice}
                    placeholder="1d8"
                    onChange={(e) => {
                      markMech();
                      setSmiteScaleDice(e.target.value);
                    }}
                  />
                </label>
                <label className="see-field">
                  Damage Type
                  <select
                    value={smiteDamageType}
                    onChange={(e) => {
                      markMech();
                      setSmiteDamageType(e.target.value);
                    }}
                  >
                    {DAMAGE_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t.charAt(0).toUpperCase() + t.slice(1)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="see-field">
                  Bonus vs Creature Types (comma-separated)
                  <input
                    value={smiteBonusTypes}
                    placeholder="e.g. undead, fiend"
                    onChange={(e) => {
                      markMech();
                      setSmiteBonusTypes(e.target.value);
                    }}
                  />
                </label>
                <label className="see-field">
                  Extra Dice vs Matching Creature Types
                  <input
                    value={smiteBonusDice}
                    placeholder="e.g. 1d8"
                    onChange={(e) => {
                      markMech();
                      setSmiteBonusDice(e.target.value);
                    }}
                  />
                </label>
                <label className="see-field">
                  Free Use Counter (optional)
                  <input
                    value={smiteFreeCounter}
                    placeholder="e.g. Divine Smite"
                    onChange={(e) => {
                      markMech();
                      setSmiteFreeCounter(e.target.value);
                    }}
                  />
                </label>
                {smiteFreeCounter.trim() && (
                  <>
                    <label className="see-field">
                      Free Use Class
                      <input
                        value={smiteFreeClass}
                        onChange={(e) => {
                          markMech();
                          setSmiteFreeClass(e.target.value);
                        }}
                      />
                    </label>
                    <label className="see-field">
                      Min Class Level
                      <NumberInput
                        allowEmpty
                        min={1}
                        max={20}
                        placeholder="2"
                        value={smiteFreeMinLevel}
                        onValueChange={(v) => {
                          markMech();
                          setSmiteFreeMinLevel(v);
                        }}
                      />
                    </label>
                  </>
                )}
              </div>
            </section>
          )}

          {/* Summon Mode */}
          {mode === 'summon' && (
            <section className="see-section">
              <div className="see-section-title">
                <span>Summon Token Configuration</span>
              </div>
              <div className="see-grid">
                <label className="see-field">
                  Summoned Companion Name
                  <input
                    value={summonName}
                    placeholder={name.trim() || 'Companion name'}
                    onChange={(e) => {
                      markMech();
                      setSummonName(e.target.value);
                    }}
                  />
                </label>
                <label className="see-field">
                  Summon Icon
                  <input
                    value={summonIcon}
                    placeholder="✋"
                    onChange={(e) => {
                      markMech();
                      setSummonIcon(e.target.value);
                    }}
                  />
                </label>
              </div>
            </section>
          )}

          {/* Description & Upcast Text */}
          <section className="see-section">
            <div className="see-section-title">
              <span>Description &amp; Higher-Level Notes</span>
            </div>
            <label className="see-field">
              Rules Text / Description
              <textarea
                rows={3}
                value={description}
                placeholder="Spell rules or ability summary…"
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
            <label className="see-field">
              At Higher Levels
              <input
                value={upcast}
                placeholder="Optional note when cast with a higher slot…"
                onChange={(e) => setUpcast(e.target.value)}
              />
            </label>
          </section>
        </div>

        <div className="see-footer">
          <div className="see-preview">
            <SpellCombatSupportBadge ability={previewAbility} />
            <span className="muted">
              {previewSupport && previewSupport.automated.length > 0
                ? previewSupport.automated[0]
                : previewSupport?.manual[0] ?? 'Descriptive entry'}
            </span>
          </div>
          <div className="see-actions">
            {!isNew && onRemove && (
              <button
                type="button"
                className="btn tiny"
                style={{ borderColor: '#f87171', color: '#fecaca' }}
                onClick={() => {
                  onRemove();
                  onClose();
                }}
              >
                🗑 Remove
              </button>
            )}
            <div className="see-actions-right">
              <button type="button" className="btn tiny" onClick={onClose}>
                Cancel
              </button>
              <button type="button" className="btn tiny on" onClick={validateAndSave}>
                💾 Save Spell Effects
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
