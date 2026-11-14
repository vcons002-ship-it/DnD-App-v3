import { spellcastingAbilityForClass } from '../../../shared/multiclass';
import { applyRulesUpdate } from '../../../shared/rulesUpdate';
import type { SheetAbility } from '../../../shared/types';

/**
 * Rebuild a sheet ability cleanly onto its SRD rules database entry, clearing
 * stale manual overrides (`executionProfile`, custom `roll`/`smite`/`summon`,
 * `'custom'` source, and custom tags) while preserving sheet identity, class
 * assignment, casting ability, and leveled spell preparation state.
 */
export function restoreAbilityToRulesDefault(
  ability: SheetAbility,
  hit: Partial<SheetAbility>,
  opts: { sourceClass?: string; prepared?: boolean } = {},
): SheetAbility {
  const next = applyRulesUpdate(ability, hit);
  next.name = hit.name ?? ability.name;
  next.source = hit.source ?? 'srd';
  delete next.executionProfile;

  const effectiveSourceClass = opts.sourceClass?.trim() || ability.sourceClass;
  if (effectiveSourceClass) {
    next.sourceClass = effectiveSourceClass;
    if (next.roll) {
      const ca = spellcastingAbilityForClass(effectiveSourceClass) ?? next.roll.castingAbility;
      if (ca) next.roll = { ...next.roll, castingAbility: ca };
    }
  }

  if (
    opts.prepared !== undefined &&
    ((next.type === 'spell' && (next.level ?? 0) > 0) || ability.prepared !== undefined)
  ) {
    next.prepared = opts.prepared;
  }

  return next;
}

/**
 * Choose a non-colliding display name for a saved custom copy. Leaves distinct
 * user-chosen names intact; appends ` (Custom)` (or ` (Custom 2)`, ` (Custom 3)`, …)
 * when the name matches the original entry or an existing sheet entry.
 */
export function disambiguateCustomCopyName(
  candidateName: string,
  originalName: string,
  existingNames: Iterable<string>,
): string {
  const taken = new Set(Array.from(existingNames, (n) => n.trim().toLowerCase()).filter(Boolean));
  const trimmed = candidateName.trim() || originalName.trim() || 'Custom Ability';
  const origLower = originalName.trim().toLowerCase();

  if (trimmed.toLowerCase() !== origLower && !taken.has(trimmed.toLowerCase())) {
    return trimmed;
  }

  const base = trimmed.replace(/\s*\(Custom(?:\s+\d+)?\)$/i, '').trim() || trimmed;
  const firstCandidate = `${base} (Custom)`;
  if (!taken.has(firstCandidate.toLowerCase())) {
    return firstCandidate;
  }

  let n = 2;
  while (taken.has(`${base} (Custom ${n})`.toLowerCase())) {
    n += 1;
  }
  return `${base} (Custom ${n})`;
}

/**
 * Finalize a brand-new standalone custom copy from an edited draft: assigns a
 * fresh id, marks it custom/manual so rules-update checks ignore it, and ensures
 * the name does not collide with the original or other sheet entries.
 */
export function finalizeCustomSpellCopy(
  candidate: SheetAbility,
  originalName: string,
  existingNames: Iterable<string>,
  newId?: string,
): SheetAbility {
  return {
    ...candidate,
    id: newId ?? (crypto.randomUUID?.() ?? String(Date.now())),
    name: disambiguateCustomCopyName(candidate.name, originalName, existingNames),
    source: 'custom',
    executionProfile: 'manual',
  };
}
