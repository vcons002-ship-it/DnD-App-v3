// Spell benefits are derived from live conditions, never written into a saved
// creature's base statistics. Ending a spell therefore removes its benefits
// without undoing equipment bonuses or a DM's subsequent sheet edits.
import type { Condition } from './types.js';
import { rollDice } from './dice.js';
import {activeCommand,commandInstruction} from './commandSpell.js';

export type SpellBuffSource = { conditions?: readonly Condition[]; speed?: string };
const label = (value: string): string => value.trim().toLowerCase();

export function hasHasteLethargy(source: SpellBuffSource): boolean {
  return (source.conditions ?? []).some(c => label(c.label) === 'haste lethargy');
}

/** Existing saved Haste chips remain valid; a second casting never stacks. */
export function activeHasteCondition(source: SpellBuffSource): Condition | undefined {
  if (hasHasteLethargy(source)) return undefined;
  return (source.conditions ?? []).find(c => label(c.label) === 'haste' &&
    (!c.combatEffect || label(c.combatEffect.spell) === 'haste'));
}

export const hasteAcBonus = (source: SpellBuffSource): number => activeHasteCondition(source) ? 2 : 0;

/** Reaction-cast Shield and manual "Shield" buff chips grant +5 AC (never stacks). */
export function activeShieldCondition(source: SpellBuffSource): Condition | undefined {
  return (source.conditions ?? []).find(c => label(c.label) === 'shield' &&
    (!c.combatEffect || label(c.combatEffect.spell) === 'shield'));
}

export const shieldAcBonus = (source: SpellBuffSource): number => activeShieldCondition(source) ? 5 : 0;

function activeCombatCondition(source: SpellBuffSource, spellName: string): Condition | undefined {
  const key = label(spellName);
  return (source.conditions ?? []).find(c => !c.isConcentration &&
    (c.combatEffect
      ? label(c.combatEffect.spell) === key
      : (label(c.label) === key || label(c.label).startsWith(`${key} (`))));
}

export const activeShieldOfFaithCondition = (source: SpellBuffSource): Condition | undefined =>
  activeCombatCondition(source, 'shield of faith');

export const shieldOfFaithAcBonus = (source: SpellBuffSource): number =>
  activeShieldOfFaithCondition(source) ? 2 : 0;

export const slowSpellCondition = (source: SpellBuffSource): Condition | undefined =>
  activeCombatCondition(source, 'slow');

export const slowSpellPenalty = (source: SpellBuffSource): number =>
  slowSpellCondition(source) ? -2 : 0;

export const hasMageArmor = (source: SpellBuffSource): boolean =>
  !!activeCombatCondition(source, 'mage armor');

export const hasBlur = (source: SpellBuffSource): boolean =>
  !!activeCombatCondition(source, 'blur');

export const hasBless = (source: SpellBuffSource): boolean =>
  !!activeCombatCondition(source, 'bless');

export const hasBane = (source: SpellBuffSource): boolean =>
  !!activeCombatCondition(source, 'bane');

/** Roll +1d4 for Bless, -1d4 for Bane, and any custom attack/save bonus dice on active conditions. */
export function rollBlessBaneBonus(
  source: SpellBuffSource,
  kind: 'attack' | 'save' | 'both' = 'both',
): { bonus: number; notes: string[]; bless?: number; bane?: number } {
  const bless = hasBless(source);
  const bane = hasBane(source);
  const notes: string[] = [];
  let bonus = 0;
  let blessVal: number | undefined;
  let baneVal: number | undefined;
  if (bless) {
    blessVal = rollDice('1d4')?.total ?? 0;
    bonus += blessVal;
    notes.push(`Bless +1d4[${blessVal}]`);
  }
  if (bane) {
    baneVal = rollDice('1d4')?.total ?? 0;
    bonus -= baneVal;
    notes.push(`Bane -1d4[${baneVal}]`);
  }
  for (const cond of source.conditions ?? []) {
    if (cond.isConcentration || !cond.combatEffect) continue;
    const rawExpr =
      kind === 'attack'
        ? cond.combatEffect.attackBonusDice
        : kind === 'save'
          ? cond.combatEffect.saveBonusDice
          : (cond.combatEffect.attackBonusDice ?? cond.combatEffect.saveBonusDice);
    const expr = rawExpr?.trim();
    if (!expr) continue;
    const rolled = rollDice(expr);
    if (!rolled) continue;
    bonus += rolled.total;
    const signedExpr = /^[+-]/.test(expr) ? expr : `+${expr}`;
    notes.push(`${cond.combatEffect.spell || cond.label} ${signedExpr}[${rolled.total}]`);
  }
  return {
    bonus,
    notes,
    ...(blessVal !== undefined ? { bless: blessVal } : {}),
    ...(baneVal !== undefined ? { bane: baneVal } : {}),
  };
}

export const isHypnotized = (source:SpellBuffSource):boolean => (source.conditions??[]).some(c=>c.label==='Hypnotic Pattern'&&c.combatEffect?.spell==='Hypnotic Pattern');

function holdPersonCondition(source: SpellBuffSource): Condition | undefined {
  return (source.conditions ?? []).find(c => label(c.label) === 'paralyzed' &&
    ['hold person','hold monster'].includes(label(c.combatEffect?.spell ?? '')) &&
    (c.combatEffect?.castId || c.combatEffect?.concentration));
}

/** Only the newly automated spell conditions enforce action restrictions. Other
 * manual conditions retain the app's existing table-managed action economy. */
export function spellActionBlock(source: SpellBuffSource): string | undefined {
  const command=activeCommand(source);if(command)return `Command: ${command.combatEffect!.commandWord}`;
  if(isHypnotized(source))return 'Hypnotic Pattern';
  if (hasHasteLethargy(source)) return 'Haste lethargy';
  return holdPersonCondition(source) ? `${holdPersonCondition(source)!.combatEffect!.spell} paralysis` : undefined;
}

/** The popup and rejected-action notices share the live recovery timing. */
export function spellActionRecoveryMessage(source: SpellBuffSource, { inCombat = true }: { inCombat?: boolean } = {}): string | undefined {
  if(isHypnotized(source))return 'Recover when you take damage, another creature uses an action to shake you awake, or the spell ends.';
  const lethargy = (source.conditions ?? []).filter(c => label(c.label) === 'haste lethargy');
  const held = !!holdPersonCondition(source);
  const holdName=holdPersonCondition(source)?.combatEffect?.spell??'Hold Person';
  if (lethargy.length) {
    const when = inCombat
      ? lethargy.every(c => c.combatEffect?.lethargyTurnStarted) ? 'at the end of this turn' : 'at the end of your next turn'
      : 'after a brief recovery period (about 6 seconds)';
    return held
      ? `Haste lethargy ends ${when}. ${holdName} also needs a successful Wisdom save at the end of your turn or the spell to end.`
      : `Recover ${when}.`;
  }
  return held ? `Recover on a successful Wisdom save at the end of your turn, or when ${holdName} ends.` : undefined;
}

export function spellActionBlockMessage(source: SpellBuffSource, options: { inCombat?: boolean } = {}): string | undefined {
  const command=activeCommand(source);if(command)return `Command: ${command.combatEffect!.commandWord}. ${commandInstruction(command.combatEffect!.commandWord!)} Attacks and spells are blocked until the end of this turn.`;
  if(isHypnotized(source))return `Hypnotic Pattern has you Charmed and Incapacitated. Movement, attacks, and spells are blocked. ${spellActionRecoveryMessage(source,options)}`;
  const recovery = spellActionRecoveryMessage(source, options);
  if (!recovery) return undefined;
  if (hasHasteLethargy(source)) return `Haste ended. Lethargy blocks movement, attacks, and spells. ${holdPersonCondition(source) ? `${holdPersonCondition(source)!.combatEffect!.spell} also keeps you Paralyzed. ` : ''}${recovery}`;
  return `${holdPersonCondition(source)?.combatEffect?.spell} has you Paralyzed. Movement, attacks, and spells are blocked. ${recovery}`;
}

const ZERO_SPEED = new Set(['grappled', 'restrained', 'paralyzed', 'petrified', 'unconscious', 'haste lethargy']);
export function speedIsZero(source: SpellBuffSource): boolean {
  const command=activeCommand(source);if(command&&(command.combatEffect!.commandResolved||['Halt','Grovel','Drop'].includes(command.combatEffect!.commandWord!)))return true;
  if(isHypnotized(source))return true;
  return (source.conditions ?? []).some(c => ZERO_SPEED.has(label(c.label)) || (!c.isConcentration && !!c.combatEffect?.zeroSpeed));
}

/** Preserve movement modes/notes while doubling each stated speed for Haste, adding bonuses/reductions, and halving for Slow. */
export function effectiveSpeed(source: SpellBuffSource): string {
  if (speedIsZero(source)) return '0 ft.';
  const speed = source.speed ?? '';
  const reduction=Math.max(0,...(source.conditions??[]).map(c=>c.combatEffect?.speedReduction??0));
  const bonus = (source.conditions ?? []).filter(c => !c.isConcentration).reduce((s, c) => s + (c.combatEffect?.speedBonus ?? 0), 0);
  const slowed = !!slowSpellCondition(source) || (source.conditions ?? []).some(c => !c.isConcentration && c.combatEffect?.slow);
  if (!activeHasteCondition(source) && !reduction && !bonus && !slowed) return speed;
  return speed.replace(/(\d+(?:\.\d+)?)\s*(ft\.?|feet)\b/gi,
    (_match, feet: string, unit: string) => {
      const scaled = Math.max(0, Number(feet) * (activeHasteCondition(source) ? 2 : 1) + bonus - reduction);
      return `${slowed ? Math.floor(scaled / 2) : scaled} ${unit}`;
    });
}

/** The walking allowance used by movement hints; unknown speeds stay unknown. */
export function walkingSpeedFeet(source: SpellBuffSource): number | undefined {
  if (speedIsZero(source)) return 0;
  const match = effectiveSpeed(source).match(/^\s*(?:speed\s*:?\s*)?(\d+(?:\.\d+)?)\s*(?:ft\.?|feet)\b/i);
  return match ? Number(match[1]) : undefined;
}
