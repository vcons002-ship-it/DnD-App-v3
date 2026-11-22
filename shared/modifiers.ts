// Framework-free helpers for the character "modifier" system: a base ability
// score (kept in Character.stats) plus named adjustments from feats/ASIs (on the
// character) and magic items (on equipped InventoryItems). Effective score =
// base + matching ability modifiers; flat save/skill/attack/AC bonuses layer on
// at roll time. Pure + unit-tested; the server computes the authoritative math.

import type {
  Condition,
  DiceRulesSpec,
  InventoryItem,
  ModTarget,
  SheetModifier,
  SpellCustomEffect,
  Weapon,
  WeaponTrigger,
  WeaponTriggerSpell,
  WeaponTriggerWhen,
} from './types.js';
import type { AbilityKey } from './skills.js';
import { cleanDiceRules } from './diceRules.js';
import { rollDice } from './dice.js';
import { hasteAcBonus, hasMageArmor, shieldAcBonus, shieldOfFaithAcBonus, slowSpellPenalty } from './spellBuffs.js';

const ABILITIES: AbilityKey[] = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'];

/** The minimal character shape these helpers need (so they're easy to test). */
export type ModSource = {
  stats?: Record<string, number>;
  armorClass?: number;
  modifiers?: SheetModifier[];
  items?: InventoryItem[];
  conditions?: readonly Condition[];
};

/** A modifier the math can safely evaluate (old DB rows / imports may hold
 *  anything — a malformed entry must degrade to "ignored", never throw). */
const usable = (m: SheetModifier): boolean =>
  !!m &&
  typeof m === 'object' &&
  !!m.target &&
  typeof m.target === 'object' &&
  typeof m.target.kind === 'string' &&
  Number.isFinite(m.value);

/**
 * Every modifier currently in effect: the character's own permanent modifiers
 * plus those from EQUIPPED items (an item's modifiers do nothing until it's
 * equipped/attuned). An item modifier with a blank `source` falls back to the
 * item's name so the tooltip/log always names where the bonus came from.
 * Malformed entries (bad imports, hand-edited saves) are silently skipped.
 */
export function activeModifiers(c: ModSource): SheetModifier[] {
  const own = Array.isArray(c.modifiers) ? c.modifiers : [];
  const fromItems = (Array.isArray(c.items) ? c.items : [])
    .filter((it) => it?.equipped && Array.isArray(it.modifiers))
    .flatMap((it) =>
      it.modifiers!.map((m) =>
        usable(m) ? { ...m, source: m.source || it.name } : m,
      ),
    );
  return [...own, ...fromItems].filter(usable);
}

export type StatBreakdown = {
  base: number;
  parts: { source: string; value: number; set?: boolean }[];
  total: number;
};

/**
 * Effective ability scores = base + ability-target modifiers, with a per-ability
 * breakdown for the stat-math tooltip. Only abilities the creature actually has
 * a base score for are included (never fabricates scores). A `set` modifier
 * floors the score at its value AFTER bonuses ("your Strength is 19") — it only
 * appears in the breakdown when it actually raised the score.
 */
export function effectiveStats(c: ModSource): {
  scores: Record<string, number>;
  breakdown: Record<string, StatBreakdown>;
} {
  const mods = activeModifiers(c);
  const scores: Record<string, number> = {};
  const breakdown: Record<string, StatBreakdown> = {};
  for (const ab of ABILITIES) {
    const base = c.stats?.[ab];
    if (base === undefined) continue;
    const forAb = mods.filter(
      (m) => m.target.kind === 'ability' && m.target.ability === ab,
    );
    const parts: StatBreakdown['parts'] = forAb
      .filter((m) => !m.set)
      .map((m) => ({ source: m.source, value: m.value }));
    let total = base + parts.reduce((s, p) => s + p.value, 0);
    const floor = forAb
      .filter((m) => m.set)
      .reduce<{ source: string; value: number } | null>(
        (best, m) => (m.value > (best?.value ?? -Infinity) ? m : best),
        null,
      );
    if (floor && floor.value > total) {
      parts.push({ source: floor.source, value: floor.value, set: true });
      total = floor.value;
    }
    scores[ab] = total;
    breakdown[ab] = { base, parts, total };
  }
  return { scores, breakdown };
}

const ARMOR_NAME_RE =
  /\b(?:armor|leather|studded|hide|chain\s*(?:shirt|mail)|elven\s*chain|scale\s*mail|breastplate|half\s*plate|ring\s*mail|splint|plate|padded)\b/i;

/** True if the creature has equipped body armor (shields alone do not count as wearing armor). */
export function isWearingArmor(c: Pick<ModSource, 'items'>): boolean {
  return (c.items ?? []).some(
    (it) =>
      !!it.equipped &&
      !/\bshield\b/i.test(it.name) &&
      (ARMOR_NAME_RE.test(it.name) || /\b(?:light|medium|heavy)\s+armor\b/i.test(it.note ?? '')),
  );
}

/** Effective AC = base (or Mage Armor 13 + DEX) + AC modifiers + live spell buffs. */
export function effectiveAc(c: ModSource): number {
  const dexScore = effectiveStats(c).scores.DEX ?? c.stats?.DEX ?? 10;
  const dexMod = Math.floor((dexScore - 10) / 2);
  let baseAc =
    hasMageArmor(c) && !isWearingArmor(c)
      ? Math.max(c.armorClass ?? 0, 13 + dexMod)
      : (c.armorClass ?? 0);
  const activeConds = (c.conditions ?? []).filter((cond) => !cond.isConcentration);
  for (const cond of activeConds) {
    const fx = cond.combatEffect;
    if (!fx || !Number.isFinite(fx.baseAc)) continue;
    if (fx.baseAcAddsDex && isWearingArmor(c)) continue;
    baseAc = Math.max(baseAc, fx.baseAc! + (fx.baseAcAddsDex ? dexMod : 0));
  }
  const condAcBonus = activeConds.reduce(
    (s, cond) => s + (Number.isFinite(cond.combatEffect?.acBonus) ? cond.combatEffect!.acBonus! : 0),
    0,
  );
  return (
    baseAc +
    activeModifiers(c)
      .filter((m) => m.target.kind === 'ac')
      .reduce((s, m) => s + m.value, 0) +
    hasteAcBonus(c) +
    shieldAcBonus(c) +
    shieldOfFaithAcBonus(c) +
    slowSpellPenalty(c) +
    condAcBonus
  );
}

/** Sum + named parts of the modifiers whose target matches `pred`. */
function extras(
  c: ModSource,
  pred: (t: ModTarget) => boolean,
): { total: number; parts: { source: string; value: number }[] } {
  const parts = activeModifiers(c)
    .filter((m) => pred(m.target))
    .map((m) => ({ source: m.source, value: m.value }));
  return { total: parts.reduce((s, p) => s + p.value, 0), parts };
}

/** Flat bonus to a saving throw for `ability` (matches that save or all-saves). */
export function saveExtra(c: ModSource, ability: string) {
  const ab = ability.trim().toUpperCase();
  const result = extras(c, (t) => t.kind === 'save' && (!t.ability || t.ability === ab));
  if (ab === 'DEX' && slowSpellPenalty(c) !== 0) {
    result.total -= 2;
    result.parts.push({ source: 'Slow', value: -2 });
  }
  for (const cond of c.conditions ?? []) {
    if (cond.isConcentration) continue;
    const bonus = cond.combatEffect?.saveBonus;
    if (Number.isFinite(bonus) && bonus !== 0) {
      result.total += bonus!;
      result.parts.push({ source: cond.combatEffect?.spell || cond.label, value: bonus! });
    }
  }
  return result;
}

/** Flat bonus to a skill check (matches that skill or all-skills). */
export function skillExtra(c: ModSource, skillName: string) {
  const sk = skillName.trim().toLowerCase();
  const result=extras(
    c,
    (t) => t.kind === 'skill' && (!t.skill || t.skill.trim().toLowerCase() === sk),
  );
  if(sk==='stealth'&&(c.conditions??[]).some(v=>v.combatEffect?.stealthBonus===10)){
    result.total+=10;result.parts.push({source:'Pass without Trace',value:10});
  }
  return result;
}

/** Flat bonus to every attack roll. */
export function attackExtra(c: ModSource) {
  const result = extras(c, (t) => t.kind === 'attack');
  for (const cond of c.conditions ?? []) {
    if (cond.isConcentration) continue;
    const bonus = cond.combatEffect?.attackBonus;
    if (Number.isFinite(bonus) && bonus !== 0) {
      result.total += bonus!;
      result.parts.push({ source: cond.combatEffect?.spell || cond.label, value: bonus! });
    }
  }
  return result;
}

/** Flat bonus to initiative (the DEX mod already flows via effectiveStats). */
export function initiativeExtra(c: ModSource) {
  return extras(c, (t) => t.kind === 'initiative');
}

/**
 * Validate untrusted modifier data (AI output, library REST bodies) into clean
 * `SheetModifier`s: unknown kinds/abilities and non-numeric values are dropped,
 * values are clamped to ±30, ids are assigned, `set` only survives on ability
 * targets, and the `slot` (feat/ASI) flag is preserved so the feat cap can count
 * it. Returns [] for anything that isn't an array.
 */
export function sanitizeModifiers(
  raw: unknown,
  newId: () => string = () =>
    `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
): SheetModifier[] {
  if (!Array.isArray(raw)) return [];
  const out: SheetModifier[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const t = (e.target ?? {}) as Record<string, unknown>;
    const kind = String(t.kind ?? '');
    const ability = String(t.ability ?? '').trim().toUpperCase() as AbilityKey;
    const skill = String(t.skill ?? '').trim();
    let target: ModTarget;
    if (kind === 'ability' && ABILITIES.includes(ability)) {
      target = { kind: 'ability', ability };
    } else if (kind === 'save') {
      target = ABILITIES.includes(ability) ? { kind: 'save', ability } : { kind: 'save' };
    } else if (kind === 'skill') {
      target = skill ? { kind: 'skill', skill } : { kind: 'skill' };
    } else if (kind === 'attack' || kind === 'ac' || kind === 'initiative') {
      target = { kind };
    } else {
      continue;
    }
    const value = Math.max(-30, Math.min(30, Math.round(Number(e.value))));
    if (!Number.isFinite(value) || value === 0) continue;
    out.push({
      id: typeof e.id === 'string' && e.id ? e.id : newId(),
      source: String(e.source ?? '').trim(),
      target,
      value,
      ...(e.set && target.kind === 'ability' ? { set: true } : {}),
      ...(e.slot ? { slot: true } : {}),
    });
  }
  return out;
}

/**
 * Validate an untrusted inventory-item list (socket payloads, REST bodies, JSON
 * sheet imports) — nameless/garbled entries are dropped, qty is clamped to a
 * non-negative integer, and nested `modifiers` go through sanitizeModifiers.
 */
export function sanitizeItems(
  raw: unknown,
  newId: () => string = () =>
    `i${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
): InventoryItem[] {
  if (!Array.isArray(raw)) return [];
  const out: InventoryItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const name = String(e.name ?? '').trim();
    if (!name) continue;
    const modifiers = sanitizeModifiers(e.modifiers, newId);
    // An explicit consumable effect ("drinking this heals 2d4+2") feeds the
    // server's own roll math, so only a rollable expression survives.
    const rawUse = e.use as { kind?: unknown; dice?: unknown } | undefined;
    const use =
      rawUse && validDice(rawUse.dice)
        ? { kind: rawUse.kind === 'tempHp' ? ('tempHp' as const) : ('heal' as const), dice: String(rawUse.dice).trim() }
        : undefined;
    out.push({
      id: typeof e.id === 'string' && e.id ? e.id : newId(),
      name,
      qty: Number.isFinite(Number(e.qty)) ? Math.max(0, Math.round(Number(e.qty))) : 1,
      note: typeof e.note === 'string' ? e.note : '',
      ...(modifiers.length ? { modifiers } : {}),
      ...(e.equipped ? { equipped: true } : {}),
      ...(use ? { use } : {}),
    });
  }
  return out;
}

/** A dice string the roller can actually evaluate (empty/garbled → not kept). */
const validDice = (s: unknown): s is string =>
  typeof s === 'string' && s.trim() !== '' && rollDice(s) !== null;

/**
 * Validate an untrusted weapon list (JSON sheet imports, hand-edited saves,
 * socket payloads) before it feeds the server's authoritative roll math: dice
 * expressions must actually parse (so a bad "100d1000" can't reach rollDice),
 * to-hit / magic bonuses are clamped and rounded, the attack ability is checked
 * against the six scores, and strings are length-capped. Nameless entries drop.
 */
const VALID_TRIGGER_WHEN = new Set<WeaponTriggerWhen>([
  'on-hit',
  'on-crit',
  'on-nat-20',
  'on-d20-at-least',
  'on-damage-max',
  'on-damage-match',
  'on-miss',
]);

function sanitizeTriggerEffect(raw: unknown): SpellCustomEffect | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const out: SpellCustomEffect = {};
  if (typeof r.conditionLabel === 'string' && r.conditionLabel.trim()) out.conditionLabel = r.conditionLabel.trim().slice(0, 60);
  if (r.target === 'self' || r.target === 'affected' || r.target === 'ally') out.target = r.target;
  if (r.aura === 'red' || r.aura === 'blue' || r.aura === 'green') out.aura = r.aura;
  if (typeof r.note === 'string' && r.note.trim()) out.note = r.note.trim().slice(0, 120);
  if (Number.isFinite(Number(r.durationRounds)) && Number(r.durationRounds) >= 1) out.durationRounds = Math.min(100, Math.round(Number(r.durationRounds)));
  if (r.untilTargetStart === true) out.untilTargetStart = true;
  if (r.untilCasterEnd === true) out.untilCasterEnd = true;
  if (typeof r.repeatSave === 'string' && ABILITIES.includes(r.repeatSave.trim().toUpperCase() as AbilityKey)) out.repeatSave = r.repeatSave.trim().toUpperCase();
  if (r.repeatPhase === 'start' || r.repeatPhase === 'end') out.repeatPhase = r.repeatPhase;
  if (validDice(r.repeatDamage)) out.repeatDamage = (r.repeatDamage as string).trim();
  if (typeof r.repeatDamageType === 'string' && r.repeatDamageType.trim()) out.repeatDamageType = r.repeatDamageType.trim().slice(0, 30);
  if (r.saveBeforeDamage === true) out.saveBeforeDamage = true;
  if (Number.isFinite(Number(r.acBonus))) out.acBonus = Math.max(-10, Math.min(10, Math.round(Number(r.acBonus))));
  if (r.grantsAdvantageToAttackers === true) out.grantsAdvantageToAttackers = true;
  if (r.nextAttackAdvantage === true) out.nextAttackAdvantage = true;
  if (r.attackDisadvantage === true) out.attackDisadvantage = true;
  if (r.nextAttackDisadvantage === true) out.nextAttackDisadvantage = true;
  if (r.checkDisadvantage === true) out.checkDisadvantage = true;
  if (r.zeroSpeed === true) out.zeroSpeed = true;
  if (r.slow === true) out.slow = true;
  if (r.preventsHealing === true) out.preventsHealing = true;
  if (r.noOpportunityAttacks === true) out.noOpportunityAttacks = true;
  if (r.suppressesInvisibility === true) out.suppressesInvisibility = true;
  return Object.keys(out).length ? out : undefined;
}

function sanitizeWeaponDiceRules(raw: unknown): DiceRulesSpec | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as DiceRulesSpec;
  const patched: DiceRulesSpec = {
    ...r,
    ...(r.exploding
      ? {
          exploding: {
            ...r.exploding,
            bonusDice: validDice(r.exploding.bonusDice) ? r.exploding.bonusDice!.trim() : undefined,
          },
        }
      : {}),
    ...(r.matchingDice
      ? {
          matchingDice: {
            ...r.matchingDice,
            bonusDice: validDice(r.matchingDice.bonusDice) ? r.matchingDice.bonusDice!.trim() : undefined,
            effect: sanitizeTriggerEffect(r.matchingDice.effect),
          },
        }
      : {}),
    ...(validDice(r.extraCritDice) ? { extraCritDice: r.extraCritDice!.trim() } : { extraCritDice: undefined }),
  };
  return cleanDiceRules(patched);
}

export function sanitizeWeapons(raw: unknown): Weapon[] {
  if (!Array.isArray(raw)) return [];
  const out: Weapon[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const name = String(e.name ?? '').trim().slice(0, 80);
    if (!name) continue;
    const w: Weapon = { name, kind: e.kind === 'ranged' ? 'ranged' : 'melee' };
    if (validDice(e.damage)) w.damage = (e.damage as string).trim();
    if (validDice(e.versatileDamage)) w.versatileDamage = (e.versatileDamage as string).trim();
    if (validDice(e.extraDamage)) w.extraDamage = (e.extraDamage as string).trim();
    if (typeof e.damageType === 'string' && e.damageType.trim())
      w.damageType = e.damageType.trim().slice(0, 30);
    if (typeof e.extraDamageType === 'string' && e.extraDamageType.trim())
      w.extraDamageType = e.extraDamageType.trim().slice(0, 30);
    if (typeof e.range === 'string' && e.range.trim()) w.range = e.range.trim().slice(0, 40);
    const ab = Number(e.attackBonus);
    if (Number.isFinite(ab)) w.attackBonus = Math.max(-20, Math.min(20, Math.round(ab)));
    const mb = Number(e.magicBonus);
    if (Number.isFinite(mb) && Math.round(mb) !== 0)
      w.magicBonus = Math.max(-10, Math.min(10, Math.round(mb)));
    const aa = String(e.attackAbility ?? '').trim().toUpperCase();
    if (ABILITIES.includes(aa as AbilityKey)) w.attackAbility = aa as Weapon['attackAbility'];
    if (Array.isArray(e.tags)) {
      const tags = e.tags
        .filter((t): t is string => typeof t === 'string')
        .map((t) => t.trim().toLowerCase().slice(0, 30))
        .filter(Boolean)
        .slice(0, 20);
      if (tags.length) w.tags = tags;
    }
    if (e.diceOnly) w.diceOnly = true;
    // Damage-source properties: they decide whether "nonmagical" / "non-silvered"
    // resistances apply, so only a real `true` is kept.
    if (e.magical === true) w.magical = true;
    if (e.silvered === true) w.silvered = true;
    const ct = Number(e.critThreshold);
    if (Number.isFinite(ct) && Math.round(ct) >= 2 && Math.round(ct) < 20) {
      w.critThreshold = Math.round(ct);
    }
    const diceRules = sanitizeWeaponDiceRules(e.diceRules);
    if (diceRules) w.diceRules = diceRules;
    if (Array.isArray(e.triggers)) {
      const triggers: WeaponTrigger[] = [];
      for (let i = 0; i < e.triggers.length && triggers.length < 12; i++) {
        const rawT = e.triggers[i];
        if (!rawT || typeof rawT !== 'object') continue;
        const tr = rawT as Record<string, unknown>;
        if (!VALID_TRIGGER_WHEN.has(tr.when as WeaponTriggerWhen)) continue;
        const t: WeaponTrigger = {
          id: typeof tr.id === 'string' && tr.id.trim() ? tr.id.trim().slice(0, 60) : `trig-${i}`,
          name: String(tr.name ?? 'Weapon Trigger').trim().slice(0, 80) || 'Weapon Trigger',
          when: tr.when as WeaponTriggerWhen,
        };
        if (tr.enabled === false) t.enabled = false;
        const d20T = Number(tr.d20Threshold);
        if (t.when === 'on-d20-at-least' && Number.isFinite(d20T)) {
          t.d20Threshold = Math.max(2, Math.min(20, Math.round(d20T)));
        }
        if (Array.isArray(tr.targetCreatureTypes)) {
          const types = tr.targetCreatureTypes
            .filter((s): s is string => typeof s === 'string')
            .map((s) => s.trim().toLowerCase().slice(0, 30))
            .filter(Boolean)
            .slice(0, 12);
          if (types.length) t.targetCreatureTypes = types;
        }
        if (validDice(tr.extraDamageDice)) t.extraDamageDice = (tr.extraDamageDice as string).trim();
        if (typeof tr.extraDamageType === 'string' && tr.extraDamageType.trim()) {
          t.extraDamageType = tr.extraDamageType.trim().slice(0, 30);
        }
        if (typeof tr.doubleOnCrit === 'boolean') t.doubleOnCrit = tr.doubleOnCrit;
        if (validDice(tr.healDice)) {
          t.healDice = (tr.healDice as string).trim();
          if (tr.healMode === 'temporary' || tr.healMode === 'hitPoints') t.healMode = tr.healMode;
        }
        const fx = sanitizeTriggerEffect(tr.effect);
        if (fx) t.effect = fx;
        const eSave = String(tr.effectSave ?? '').trim().toUpperCase();
        if (ABILITIES.includes(eSave as AbilityKey)) {
          t.effectSave = eSave as WeaponTrigger['effectSave'];
          const eDc = Number(tr.effectDc);
          if (Number.isFinite(eDc)) t.effectDc = Math.max(1, Math.min(35, Math.round(eDc)));
        }
        if (tr.castSpell && typeof tr.castSpell === 'object') {
          const cs = tr.castSpell as Record<string, unknown>;
          const sName = String(cs.spellName ?? '').trim().slice(0, 80);
          if (sName) {
            const spell: WeaponTriggerSpell = { spellName: sName };
            if (typeof cs.abilityId === 'string' && cs.abilityId.trim()) spell.abilityId = cs.abilityId.trim().slice(0, 80);
            const cl = Number(cs.castLevel);
            if (Number.isFinite(cl)) spell.castLevel = Math.max(0, Math.min(9, Math.round(cl)));
            const dcOv = Number(cs.dcOverride);
            if (Number.isFinite(dcOv)) spell.dcOverride = Math.max(1, Math.min(35, Math.round(dcOv)));
            if (typeof cs.damageType === 'string' && cs.damageType.trim()) spell.damageType = cs.damageType.trim().slice(0, 30);
            if (cs.targetMode === 'target' || cs.targetMode === 'self') spell.targetMode = cs.targetMode;
            if (cs.castMode === 'auto' || cs.castMode === 'prompt') spell.castMode = cs.castMode;
            t.castSpell = spell;
          }
        }
        if (typeof tr.note === 'string' && tr.note.trim()) t.note = tr.note.trim().slice(0, 160);
        if (t.extraDamageDice || t.healDice || t.effect || t.castSpell) triggers.push(t);
      }
      if (triggers.length) w.triggers = triggers;
    }
    out.push(w);
  }
  return out;
}

/** Human label for a modifier target, e.g. "STR", "all saves", "Stealth", "AC". */
export function targetLabel(t: ModTarget): string {
  switch (t.kind) {
    case 'ability':
      return t.ability;
    case 'save':
      return t.ability ? `${t.ability} save` : 'all saves';
    case 'skill':
      return t.skill || 'all skills';
    case 'attack':
      return 'attack rolls';
    case 'ac':
      return 'AC';
    case 'initiative':
      return 'initiative';
  }
}
