export type TokenLabelDensity = 'smart' | 'full' | 'minimal';
export type TokenHpDisplay = 'arc' | 'bar';

export type CrowdTokenInput = {
  id: string;
  x: number;
  y: number;
  radius: number;
  name: string;
  kind: 'pc' | 'monster';
  revealTag?: string;
  hpFrac: number | null;
  hasInitiative: boolean;
  isDead: boolean;
  isObject: boolean;
  selected: boolean;
  hovered: boolean;
  activeTurn: boolean;
  targeted: boolean;
};

export type CrowdLayoutOptions = {
  viewRotation: number;
  tilted?: boolean;
  labelDensity: TokenLabelDensity;
  hpDisplay: TokenHpDisplay;
  showHpNumbers: boolean;
  peekAll: boolean;
};

export type TokenCrowdLayout = {
  inCrowd: boolean;
  focused: boolean;
  dimmed: boolean;
  hudOpacity: number;
  placement: 'below' | 'above';
  yNudge: number;
  shortName?: string;
  showName: boolean;
  showHp: boolean;
  showExactHp: boolean;
  showInitiative: boolean;
  compactBar: boolean;
  useLiveHud: boolean;
};

export const DEFAULT_CROWD_LAYOUT: TokenCrowdLayout = {
  inCrowd: false,
  focused: false,
  dimmed: false,
  hudOpacity: 1,
  placement: 'below',
  yNudge: 0,
  shortName: undefined,
  showName: true,
  showHp: true,
  showExactHp: false,
  showInitiative: true,
  compactBar: false,
  useLiveHud: false,
};

function stripTrailingNumber(name: string): { base: string; suffix: string } {
  const clean = name.replace(/\s+/g, ' ').trim();
  const match = clean.match(/^(.*?)\s+(#?\d+)$/);
  if (match && match[1].trim()) {
    return { base: match[1].trim(), suffix: match[2] };
  }
  return { base: clean, suffix: '' };
}

export function abbreviateCrowdName(
  name: string,
  hasRevealTag: boolean,
  sameBaseCount: number,
  denseCluster: boolean,
): string | undefined {
  const { base, suffix } = stripTrailingNumber(name);
  if (!base) return undefined;
  const words = base.split(' ').filter(Boolean);
  if (suffix) {
    if (sameBaseCount >= 2) {
      if (words.length >= 2) {
        const initials = words.map((w) => w[0].toUpperCase()).join('');
        return hasRevealTag ? initials : `${initials} ${suffix}`;
      }
      if (base.length > 5) return hasRevealTag ? base.slice(0, 5) : `${base.slice(0, 3)} ${suffix}`;
      if (hasRevealTag) return base;
    }
    if (base.length > 14) {
      if (words.length >= 2) {
        const lead = words[0].length <= 9 ? words[0] : words[0].slice(0, 8);
        return hasRevealTag ? `${lead} ${words[1][0].toUpperCase()}` : `${lead} ${words[1][0].toUpperCase()} ${suffix}`;
      }
      return hasRevealTag ? base.slice(0, 10) : `${base.slice(0, 9)} ${suffix}`;
    }
    return hasRevealTag ? base : undefined;
  }
  if (hasRevealTag && (sameBaseCount >= 2 || base.length > 13)) {
    if (words.length >= 2) {
      if (denseCluster && sameBaseCount >= 2 && words[0].length <= 9) return words[0];
      const lead = words[0].length <= 9 ? words[0] : words[0].slice(0, 8);
      return `${lead} ${words[1][0].toUpperCase()}`;
    }
    if (base.length > 13) return base.slice(0, 11);
  }
  if (!hasRevealTag && base.length > 15) {
    if (denseCluster) return base.slice(0, 13).trimEnd();
    if (words.length >= 2) {
      const lead = words[0].length <= 9 ? words[0] : words[0].slice(0, 8);
      return `${lead} ${words[1][0].toUpperCase()}`;
    }
    return base.slice(0, 13);
  }
  return undefined;
}

/**
 * Compute per-token melee crowd decluttering:
 * - Detects tokens standing in adjacent melee range (~1.65× combined radii).
 * - Spotlights hovered / selected / targeted / active-turn tokens and dims colliding crowd neighbors.
 * - Flips upper-row labels above their base when a neighbor sits directly south in camera-upright space.
 * - Nudges any remaining overlapping label rects vertically so text never stacks directly on top of text.
 * - Shortens repeated monster names in melee clusters while keeping full names on focus or Alt-peek.
 */
export function computeTokenCrowdLayout(
  tokens: readonly CrowdTokenInput[],
  opts: CrowdLayoutOptions,
): Map<string, TokenCrowdLayout> {
  const result = new Map<string, TokenCrowdLayout>();
  const { viewRotation, tilted = false, labelDensity, hpDisplay, showHpNumbers, peekAll } = opts;
  const rad = (viewRotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  const living = tokens.filter((t) => !t.isDead && !t.isObject);
  const neighborsById = new Map<string, CrowdTokenInput[]>();
  for (const t of living) neighborsById.set(t.id, []);

  for (let i = 0; i < living.length; i++) {
    const a = living[i];
    for (let j = i + 1; j < living.length; j++) {
      const b = living[j];
      const threshold = (a.radius + b.radius) * 1.65;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      if (dx * dx + dy * dy <= threshold * threshold) {
        neighborsById.get(a.id)!.push(b);
        neighborsById.get(b.id)!.push(a);
      }
    }
  }

  // Group melee-connected tokens into clusters so spotlight dimming & duplicate-name
  // shortening apply consistently across the whole scrum.
  const clusterOf = new Map<string, CrowdTokenInput[]>();
  const visited = new Set<string>();
  for (const t of living) {
    if (visited.has(t.id)) continue;
    const queue = [t];
    const cluster: CrowdTokenInput[] = [];
    visited.add(t.id);
    while (queue.length) {
      const cur = queue.pop()!;
      cluster.push(cur);
      for (const n of neighborsById.get(cur.id) ?? []) {
        if (!visited.has(n.id)) {
          visited.add(n.id);
          queue.push(n);
        }
      }
    }
    for (const member of cluster) clusterOf.set(member.id, cluster);
  }

  const baseNameCounts = new Map<CrowdTokenInput[], Map<string, number>>();
  const clusterHasSpotlight = new Map<CrowdTokenInput[], boolean>();
  for (const cluster of new Set(clusterOf.values())) {
    const counts = new Map<string, number>();
    let spotlight = false;
    for (const m of cluster) {
      const key = stripTrailingNumber(m.name).base.toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (m.hovered || m.selected || m.targeted) spotlight = true;
    }
    baseNameCounts.set(cluster, counts);
    clusterHasSpotlight.set(cluster, spotlight);
  }

  type DraftBox = {
    token: CrowdTokenInput;
    layout: TokenCrowdLayout;
    sx: number;
    sy: number;
    width: number;
    height: number;
    baseY: number;
  };
  const crowdBoxes: DraftBox[] = [];

  for (const t of tokens) {
    const focused = t.hovered || t.selected || t.activeTurn || t.targeted || peekAll;
    const neighbors = neighborsById.get(t.id) ?? [];
    const inCrowd = !t.isDead && !t.isObject && neighbors.length > 0;
    const cluster = clusterOf.get(t.id);
    const spotlightInCluster = inCrowd && !!cluster && !!clusterHasSpotlight.get(cluster) && !peekAll;
    const dimmed = spotlightInCluster && !focused;
    const hudOpacity = dimmed ? (labelDensity === 'full' ? 0.45 : 0.28) : 1;

    let placement: 'below' | 'above' = 'below';
    // Only flip upper-row labels above their base in overhead view; in 45° tilt,
    // upright 3D torsos stand directly above (-Y) the base and would hide it.
    if (inCrowd && !tilted) {
      let blockedBelow = false;
      let blockedAbove = false;
      for (const n of neighbors) {
        const dx = n.x - t.x;
        const dy = n.y - t.y;
        // Project into camera-upright coordinates (+sy is visually south/down).
        const sx = dx * cos - dy * sin;
        const sy = dx * sin + dy * cos;
        const sumR = t.radius + n.radius;
        if (Math.abs(sx) < sumR * 1.1) {
          if (sy > sumR * 0.25) blockedBelow = true;
          else if (sy < -sumR * 0.25) blockedAbove = true;
        }
      }
      if (blockedBelow && !blockedAbove) placement = 'above';
    }

    let shortName: string | undefined;
    if (inCrowd && !focused && labelDensity !== 'full' && t.kind === 'monster' && cluster) {
      const sameCount = baseNameCounts.get(cluster)?.get(stripTrailingNumber(t.name).base.toLowerCase()) ?? 1;
      shortName = abbreviateCrowdName(t.name, !!t.revealTag, sameCount, neighbors.length >= 2);
    }

    const hasHp = !t.isDead && t.hpFrac !== null;
    const isDamaged = hasHp && t.hpFrac! < 0.999;

    let showName = !t.isDead;
    let showHp = hasHp;
    let showExactHp = hasHp && showHpNumbers;
    let showInitiative = !t.isDead && t.hasInitiative;
    let compactBar = false;

    if (labelDensity === 'minimal') {
      showName = !t.isDead && focused;
      showHp = hasHp && (hpDisplay === 'arc' || focused || isDamaged || t.kind === 'pc');
      showExactHp = hasHp && showHpNumbers && (t.hovered || peekAll);
      showInitiative = !t.isDead && t.hasInitiative && focused;
      compactBar = !focused;
    } else if (labelDensity === 'smart') {
      showName = !t.isDead;
      if (inCrowd) {
        showHp = hasHp && (hpDisplay === 'arc' || focused || isDamaged || t.kind === 'pc');
      } else {
        showHp = hasHp;
      }
      // Keep the battlefield uncluttered by showing the base-rim HP arc / bar
      // cleanly and revealing exact numeric HP only on hover or Alt-peek.
      showExactHp = hasHp && showHpNumbers && (t.hovered || peekAll);
      compactBar = !showExactHp;
      showInitiative = !t.isDead && t.hasInitiative;
    } else {
      // 'full'
      showName = !t.isDead;
      showHp = hasHp;
      showExactHp = hasHp && showHpNumbers;
      showInitiative = !t.isDead && t.hasInitiative;
      compactBar = false;
    }

    // Keep cached static serverHud PNG for default uncrowded 2D tokens, switching
    // smoothly to live Konva HUD whenever crowd layout, hover, or custom modes apply.
    const useLiveHud =
      inCrowd ||
      t.hovered ||
      peekAll ||
      labelDensity !== 'smart' ||
      hpDisplay !== 'arc';

    const layout: TokenCrowdLayout = {
      inCrowd,
      focused,
      dimmed,
      hudOpacity,
      placement,
      yNudge: 0,
      shortName,
      showName,
      showHp,
      showExactHp,
      showInitiative,
      compactBar,
      useLiveHud,
    };
    result.set(t.id, layout);

    if (inCrowd && showName) {
      const displayLabel = shortName ?? t.name;
      const estW = Math.min(58, Math.max(28, displayLabel.length * 4.5 + (t.revealTag ? 10 : 0) + (showInitiative ? 12 : 0)));
      const estH = showExactHp && hpDisplay === 'bar' ? 18 : showExactHp ? 17 : 11;
      const sx = t.x * cos - t.y * sin;
      const sy = t.x * sin + t.y * cos;
      const baseY =
        placement === 'above'
          ? sy - t.radius - estH - 5
          : sy + t.radius + (hpDisplay === 'arc' ? 5 : showHp ? 8 : 3);
      crowdBoxes.push({ token: t, layout, sx, sy, width: estW, height: estH, baseY });
    }
  }

  // Gentle vertical separation ONLY when two tokens sit closely stacked on the
  // same horizontal band so labels stay tightly anchored to their own token base
  // (never drifting down onto a creature in the next row).
  if (crowdBoxes.length > 1) {
    crowdBoxes.sort((a, b) => {
      if (a.layout.focused !== b.layout.focused) return a.layout.focused ? -1 : 1;
      if (a.token.kind !== b.token.kind) return a.token.kind === 'pc' ? -1 : 1;
      return a.baseY - b.baseY || a.sx - b.sx;
    });

    const placed: { minX: number; maxX: number; minY: number; maxY: number; sx: number; sy: number; radius: number }[] = [];
    for (const box of crowdBoxes) {
      let nudge = 0;
      const maxNudge = tilted ? 6 : 10;
      const minX = box.sx - box.width / 2;
      const maxX = box.sx + box.width / 2;
      if (!box.layout.focused) {
        const dir = box.layout.placement === 'above' ? -1 : 1;
        for (let pass = 0; pass < 2; pass++) {
          let moved = false;
          const curMinY = box.baseY + nudge;
          const curMaxY = curMinY + box.height;
          for (const other of placed) {
            // Only separate tokens whose bases are tighter than standard 5-ft grid spacing.
            if (Math.hypot(box.sx - other.sx, box.sy - other.sy) >= (box.token.radius + other.radius) * 0.95) continue;
            if (minX >= other.maxX + 1 || maxX <= other.minX - 1) continue;
            if (curMinY < other.maxY + 1 && curMaxY > other.minY - 1) {
              const push = dir > 0 ? other.maxY + 1 - curMinY : other.minY - 1 - curMaxY;
              const nextNudge = Math.max(-maxNudge, Math.min(maxNudge, nudge + push));
              if (Math.abs(nextNudge - nudge) > 0.5) {
                nudge = nextNudge;
                moved = true;
              }
            }
          }
          if (!moved) break;
        }
      }
      box.layout.yNudge = Math.round(nudge * 10) / 10;
      placed.push({
        minX,
        maxX,
        minY: box.baseY + box.layout.yNudge,
        maxY: box.baseY + box.layout.yNudge + box.height,
        sx: box.sx,
        sy: box.sy,
        radius: box.token.radius,
      });
    }
  }

  return result;
}
