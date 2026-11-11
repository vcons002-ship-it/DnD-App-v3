import type { Weapon } from './types.js';

export type ParsedWeaponRange = {
  normalFt: number;
  longFt?: number;
  reach: boolean;
  thrown: boolean;
};

export type WeaponRangeStatus = 'normal' | 'long' | 'out';

export type WeaponRangeEvaluation = ParsedWeaponRange & {
  distanceFt: number;
  status: WeaponRangeStatus;
  disadvantage: boolean;
  /** Compact range spec, e.g. "5 ft", "10 ft reach", "20/60 ft", "80/320 ft". */
  rangeText: string;
  /** Short pill text for canvas/UI, e.g. "25 ft", "95 ft · Long", "40 ft · Out". */
  pillText: string;
};

type CatalogRange = { normalFt: number; longFt?: number; reach?: boolean; thrown?: boolean };

const WEAPON_RANGE_BY_NAME: Record<string, CatalogRange> = {
  // Reach melee weapons
  glaive: { normalFt: 10, reach: true },
  halberd: { normalFt: 10, reach: true },
  lance: { normalFt: 10, reach: true },
  pike: { normalFt: 10, reach: true },
  whip: { normalFt: 10, reach: true },
  // Thrown weapons
  dagger: { normalFt: 20, longFt: 60, thrown: true },
  handaxe: { normalFt: 20, longFt: 60, thrown: true },
  'light hammer': { normalFt: 20, longFt: 60, thrown: true },
  spear: { normalFt: 20, longFt: 60, thrown: true },
  trident: { normalFt: 20, longFt: 60, thrown: true },
  dart: { normalFt: 20, longFt: 60, thrown: true },
  javelin: { normalFt: 30, longFt: 120, thrown: true },
  net: { normalFt: 5, longFt: 15, thrown: true },
  // Ranged weapons
  'light crossbow': { normalFt: 80, longFt: 320 },
  shortbow: { normalFt: 80, longFt: 320 },
  sling: { normalFt: 30, longFt: 120 },
  blowgun: { normalFt: 25, longFt: 100 },
  'hand crossbow': { normalFt: 30, longFt: 120 },
  'heavy crossbow': { normalFt: 100, longFt: 400 },
  longbow: { normalFt: 150, longFt: 600 },
  musket: { normalFt: 40, longFt: 120 },
  pistol: { normalFt: 30, longFt: 90 },
};

function findCatalogRange(name: string, tags: string[]): CatalogRange | undefined {
  const lowerName = name.trim().toLowerCase();
  if (WEAPON_RANGE_BY_NAME[lowerName]) return WEAPON_RANGE_BY_NAME[lowerName];
  for (const tag of tags) {
    const t = tag.trim().toLowerCase();
    if (WEAPON_RANGE_BY_NAME[t]) return WEAPON_RANGE_BY_NAME[t];
  }
  // Match base weapon name inside magic weapon titles like "+1 Longbow" or "Returning Javelin".
  for (const [key, spec] of Object.entries(WEAPON_RANGE_BY_NAME)) {
    const re = new RegExp(`\\b${key.replace(/\s+/g, '\\s+')}\\b`, 'i');
    if (re.test(lowerName)) return spec;
  }
  return undefined;
}

/** Parse normal/long range, reach, and thrown flags from a Weapon entry. */
export function parseWeaponRange(
  weapon: Pick<Weapon, 'name' | 'kind' | 'range' | 'tags'>,
): ParsedWeaponRange {
  const tags = weapon.tags ?? [];
  const lowerTags = tags.map((t) => t.trim().toLowerCase());
  const rawRange = (weapon.range ?? '').trim();
  const combined = `${rawRange} ${lowerTags.join(' ')}`.toLowerCase();

  let reach = /\breach\b/i.test(combined);
  let thrown = /\bthrown\b/i.test(combined);

  // Check for "normal/long" pattern first (e.g. "80/320 ft", "Range 20/60", "20 / 60").
  const slashMatch = rawRange.match(/(\d+)\s*\/\s*(\d+)/) ?? combined.match(/(\d+)\s*\/\s*(\d+)/);
  if (slashMatch) {
    const normalFt = Math.max(5, Number(slashMatch[1]));
    const longFt = Math.max(normalFt, Number(slashMatch[2]));
    const catalog = findCatalogRange(weapon.name, tags);
    if (catalog?.reach) reach = true;
    if (catalog?.thrown || weapon.kind === 'melee') thrown = thrown || weapon.kind === 'melee';
    return { normalFt, longFt, reach, thrown };
  }

  // Check for explicit single distance in weapon.range (e.g. "10 ft", "reach 15 ft", "5 ft").
  const singleMatch = rawRange.match(/(\d+)\s*(?:ft\.?|feet)?/i);
  if (singleMatch) {
    const dist = Math.max(5, Number(singleMatch[1]));
    const catalog = findCatalogRange(weapon.name, tags);
    // If weapon only says "5 ft" on a Dagger/Javelin, still honor thrown range from tags/catalog!
    if (weapon.kind === 'melee' && dist <= 10 && (thrown || catalog?.thrown) && catalog?.longFt) {
      return {
        normalFt: Math.max(dist, catalog.normalFt),
        longFt: catalog.longFt,
        reach: reach || dist > 5 || !!catalog.reach,
        thrown: true,
      };
    }
    return {
      normalFt: dist,
      reach: reach || (weapon.kind === 'melee' && dist > 5),
      thrown,
    };
  }

  const catalog = findCatalogRange(weapon.name, tags);
  if (catalog) {
    return {
      normalFt: catalog.normalFt,
      ...(catalog.longFt ? { longFt: catalog.longFt } : {}),
      reach: reach || !!catalog.reach,
      thrown: thrown || !!catalog.thrown,
    };
  }

  if (weapon.kind === 'ranged') {
    return { normalFt: 80, longFt: 320, reach: false, thrown };
  }
  if (thrown) {
    return { normalFt: 20, longFt: 60, reach, thrown: true };
  }
  return { normalFt: reach ? 10 : 5, reach, thrown: false };
}

export function formatWeaponRange(parsed: ParsedWeaponRange): string {
  if (parsed.longFt && parsed.longFt > parsed.normalFt) {
    return `${parsed.normalFt}/${parsed.longFt} ft${parsed.thrown ? ' thrown' : ''}`;
  }
  return `${parsed.normalFt} ft${parsed.reach ? ' reach' : ''}`;
}

/** Evaluate a target distance in feet against a weapon's reach or normal/long range. */
export function evaluateWeaponRange(
  weapon: Pick<Weapon, 'name' | 'kind' | 'range' | 'tags'>,
  distanceFt: number,
): WeaponRangeEvaluation {
  const parsed = parseWeaponRange(weapon);
  const roundedDist = Math.max(0, Math.round(distanceFt));
  const eps = 0.05;
  let status: WeaponRangeStatus;
  if (distanceFt <= parsed.normalFt + eps) {
    status = 'normal';
  } else if (parsed.longFt !== undefined && distanceFt <= parsed.longFt + eps) {
    status = 'long';
  } else {
    status = 'out';
  }
  const rangeText = formatWeaponRange(parsed);
  const pillText =
    status === 'long'
      ? `${roundedDist} ft · Long`
      : status === 'out'
        ? `${roundedDist} ft · Out`
        : `${roundedDist} ft`;
  return {
    ...parsed,
    distanceFt,
    status,
    disadvantage: status === 'long',
    rangeText,
    pillText,
  };
}

/** Compute midpoint tether pill text and out-of-range state for a given live distance. */
export function formatTetherRangePill(
  distanceFt: number,
  opts?: {
    hoveredWeapon?: Pick<Weapon, 'name' | 'kind' | 'range' | 'tags'>;
    weaponsOnlyList?: readonly Pick<Weapon, 'name' | 'kind' | 'range' | 'tags'>[];
  },
): { midLabel: string; outOfRange: boolean } {
  const rounded = `${Math.max(0, Math.round(distanceFt))} ft`;
  if (opts?.hoveredWeapon) {
    const ev = evaluateWeaponRange(opts.hoveredWeapon, distanceFt);
    return { midLabel: ev.pillText, outOfRange: ev.status === 'out' };
  }
  if (opts?.weaponsOnlyList && opts.weaponsOnlyList.length > 0) {
    const evals = opts.weaponsOnlyList.map((w) => evaluateWeaponRange(w, distanceFt));
    if (evals.every((e) => e.status === 'out')) {
      return { midLabel: `${rounded} · Out`, outOfRange: true };
    }
    if (evals.every((e) => e.status !== 'normal') && evals.some((e) => e.status === 'long')) {
      return { midLabel: `${rounded} · Long`, outOfRange: false };
    }
  }
  return { midLabel: rounded, outOfRange: false };
}
