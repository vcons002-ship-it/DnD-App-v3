import { spellCastSummary } from '../../../shared/spellSupport';
import './spell-combat-support.css';

type Spell = Parameters<typeof spellCastSummary>[0];

/** Compact summary of current cast functionality (dice, save/attack/heal, targeting) for the spellbook window. */
export function SpellCombatSupportBadge({ ability }: { ability: Spell }) {
  const summary = spellCastSummary(ability);
  if (!summary) return null;
  return (
    <span
      className={`spell-support-badge ${summary.needsEdit ? 'spell-cast-manual' : 'spell-cast-active'}`}
      data-spell-cast-summary={summary.needsEdit ? 'manual' : 'active'}
      title={`Current cast functionality: ${summary.text}`}
    >
      {summary.text}
    </span>
  );
}
