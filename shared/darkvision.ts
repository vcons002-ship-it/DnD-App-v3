import type { Condition, CreatureAbility, SheetAbility } from './types.js';

export const DEFAULT_PC_DARKVISION_FT = 60;
export const MAX_DARKVISION_FT = 600;

/** Bound an explicit darkvision distance in feet (0 = none; up to 600 ft).
 *  Null/undefined/blank returns undefined so callers fall back to auto-detection. */
export function sanitizeDarkvisionFt(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(0, Math.min(MAX_DARKVISION_FT, Math.round(n)));
}

/** Standard 5e darkvision radius in feet for a PC species/race name, or undefined
 *  when the race string is empty or unrecognized. */
export function defaultSpeciesDarkvisionFt(race: string | undefined | null): number | undefined {
  const r = (race ?? '').trim().toLowerCase();
  if (!r) return undefined;
  if (
    /\bdrow\b|\bdark\s+elf\b|\bsvirfneblin\b|\bdeep\s+gnome\b|\bduergar\b|\bgr[ae]y\s+dwarf\b/.test(r)
  ) {
    return 120;
  }
  if (/\bdwarf\b/.test(r)) return 120;
  // Match Half-Orc / Half-Elf before generic Orc / Elf.
  if (/\bhalf-?orc\b|\bhalf-?elf\b/.test(r)) return 60;
  if (/\borc\b/.test(r)) return 120;
  if (
    /\b(?:elf|gnome|dragonborn|tiefling|aasimar|tabaxi|goblin|kobold|bugbear|hobgoblin|shifter|owlin|triton|dhampir|hexblood|reborn|genasi|yuan-ti)\b/.test(
      r,
    )
  ) {
    return 60;
  }
  if (
    /\b(?:human|halfling|goliath|kenku|lizardfolk|aarakocra|tortle|firbolg|warforged|changeling|harengon|satyr|centaur|minotaur)\b/.test(
      r,
    )
  ) {
    return 0;
  }
  return undefined;
}

/** Extract passive darkvision distance in feet from racial/creature traits.
 *  Skips prepared/known spells (`type === 'spell'`) and anti-darkvision clauses
 *  (e.g. the *Darkness* spell description). */
export function extractDarkvisionFromTraits(
  abilities: readonly CreatureAbility[] | undefined,
  sheetAbilities?: readonly SheetAbility[],
): number | undefined {
  let best: number | undefined;
  const entries: readonly (CreatureAbility | SheetAbility)[] = [
    ...(abilities ?? []),
    ...(sheetAbilities ?? []).filter((a) => a.type !== 'spell'),
  ];
  for (const entry of entries) {
    const name = entry.name ?? '';
    const meta = 'meta' in entry && typeof entry.meta === 'string' ? entry.meta : '';
    const desc = entry.description ?? '';
    if (name.trim().toLowerCase() === 'darkness') continue;
    const text = [name, meta, desc].filter(Boolean).join(' ');
    if (/\bdarkvision\s+(?:cannot|can't)\b|\b(?:cannot|can't)\s+see\s+through\b/i.test(text)) {
      continue;
    }
    let matched = false;
    for (const m of text.matchAll(/\b(?:superior\s+)?darkvision\b[^.\n;]{0,30}?(\d+)\s*(?:ft\.?|feet)\b/ig)) {
      const dist = sanitizeDarkvisionFt(Number(m[1]));
      if (dist !== undefined) {
        best = best === undefined ? dist : Math.max(best, dist);
        matched = true;
      }
    }
    if (!matched && /\bdarkvision\b/i.test(name)) {
      const source = meta || desc;
      const m = source.match(/(?:within\s+)?(\d+)\s*(?:ft\.?|feet)\b/i);
      const dist = m ? sanitizeDarkvisionFt(Number(m[1])) : undefined;
      if (dist !== undefined) {
        best = best === undefined ? dist : Math.max(best, dist);
      }
    }
  }
  return best;
}

/** Extract active condition darkvision override (e.g. "Darkvision 60 ft" / "Darkvision 150 ft"). */
export function extractDarkvisionFromConditions(
  conditions: readonly Pick<Condition, 'label' | 'isConcentration'>[] | undefined,
): number | undefined {
  let best: number | undefined;
  for (const c of conditions ?? []) {
    if (c.isConcentration) continue;
    const m = c.label.trim().match(/\bdarkvision\b[^0-9]{0,12}(\d+)\s*(?:ft\.?|feet)?\b/i);
    const dist = m ? sanitizeDarkvisionFt(Number(m[1])) : undefined;
    if (dist !== undefined) best = best === undefined ? dist : Math.max(best, dist);
  }
  return best;
}

/** Base passive darkvision in feet: explicit override -> traits -> PC species default -> fallback (60 PC / 0 monster). */
export function resolveBaseDarkvisionFt(creature: {
  kind?: 'pc' | 'monster';
  darkvisionFt?: number | null;
  race?: string | null;
  abilities?: readonly CreatureAbility[];
  sheetAbilities?: readonly SheetAbility[];
}): number {
  const explicit = sanitizeDarkvisionFt(creature.darkvisionFt);
  if (explicit !== undefined) return explicit;
  const fromTraits = extractDarkvisionFromTraits(creature.abilities, creature.sheetAbilities);
  if (fromTraits !== undefined) return fromTraits;
  if (creature.kind !== 'monster') {
    const fromRace = defaultSpeciesDarkvisionFt(creature.race);
    if (fromRace !== undefined) return fromRace;
    return DEFAULT_PC_DARKVISION_FT;
  }
  return 0;
}

/** Effective darkvision in feet including active condition grants (e.g. Darkvision spell). */
export function resolveCreatureDarkvisionFt(creature: {
  kind?: 'pc' | 'monster';
  darkvisionFt?: number | null;
  race?: string | null;
  abilities?: readonly CreatureAbility[];
  sheetAbilities?: readonly SheetAbility[];
  conditions?: readonly Pick<Condition, 'label' | 'isConcentration'>[];
}): number {
  const base = resolveBaseDarkvisionFt(creature);
  const fromCond = extractDarkvisionFromConditions(creature.conditions);
  return fromCond !== undefined ? Math.max(base, fromCond) : base;
}
