import type { Weapon } from '../../../shared/types';
import { evaluateWeaponRange, formatWeaponRange, parseWeaponRange } from '../../../shared/weaponRange';

/**
 * Shared list of weapon-attack buttons (icon + name + damage). The parent wires
 * how each weapon is rolled via `onAttack(index)` so the same rendering serves
 * the quick right-click menu (`variant="menu"`) and the Combat section's
 * roller (`variant="inline"`). Both surfaces pass the attacker's shared
 * `twoHanded` choice so their labels match the intent sent to the server.
 */
export function WeaponButtons({
  weapons,
  onAttack,
  variant = 'inline',
  twoHanded,
  disabled,
  distanceFt,
  onHoverWeapon,
}: {
  weapons: Weapon[];
  onAttack: (index: number) => void;
  variant?: 'menu' | 'inline';
  twoHanded?: boolean;
  disabled?: boolean;
  distanceFt?: number;
  onHoverWeapon?: (index: number | null) => void;
}) {
  const menu = variant === 'menu';
  return (
    <>
      {weapons.map((w, i) => {
        const dmg = twoHanded && w.versatileDamage?.trim() ? w.versatileDamage : w.damage;
        const rangeEval = distanceFt !== undefined ? evaluateWeaponRange(w, distanceFt) : undefined;
        const parsedRange = rangeEval ?? parseWeaponRange(w);
        const rangeHint = formatWeaponRange(parsedRange);
        const rangeTooltip =
          rangeEval?.status === 'long'
            ? `Long range (${Math.round(distanceFt!)} ft vs ${rangeHint}) — attacks at long range have disadvantage`
            : rangeEval?.status === 'out'
              ? `Out of normal/long range (${Math.round(distanceFt!)} ft vs ${rangeHint})`
              : `Range: ${rangeHint}`;
        return (
          <button
            key={i}
            className={`${menu ? 'floating-menu-item weapon-attack-btn' : 'btn tiny attack-row weapon-attack-btn'}${rangeEval?.status === 'out' ? ' is-out-of-range' : rangeEval?.status === 'long' ? ' is-long-range' : ''}`}
            disabled={disabled}
            title={rangeTooltip}
            onMouseEnter={() => onHoverWeapon?.(i)}
            onMouseLeave={() => onHoverWeapon?.(null)}
            onFocus={() => onHoverWeapon?.(i)}
            onBlur={() => onHoverWeapon?.(null)}
            onClick={() => onAttack(i)}
          >
            <span>
              {w.kind === 'ranged' ? '🏹' : '⚔️'} {w.name}
              {menu && w.range && <span className="muted"> ({w.range})</span>}
              {dmg ? menu ? ` (${dmg})` : <span className="muted"> {dmg}</span> : null}
            </span>
            {!menu && rangeEval && rangeEval.status !== 'normal' && (
              <span className={`weapon-range-tag is-${rangeEval.status}`} aria-hidden="true">
                {rangeEval.status === 'long' ? `Long (${rangeEval.normalFt}/${rangeEval.longFt})` : `Out (${rangeHint})`}
              </span>
            )}
          </button>
        );
      })}
    </>
  );
}
