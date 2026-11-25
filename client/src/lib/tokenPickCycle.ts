/**
 * Pure selection-cycling helpers for congested 3D crowds and global Tab cycling.
 */

export interface CycleTokenCandidate {
  id: string;
  x: number;
  y: number;
  initiativeRank?: number | null;
  isObject?: boolean;
  isDead?: boolean;
}

/**
 * Given an ordered stack of candidate token IDs (e.g. front-to-back along a 3D
 * ray, or board-wide cycle order) and the currently selected token ID, return
 * the next token ID to select.
 */
export function nextCycledTokenId(
  stack: readonly string[],
  currentSelectedId: string | null | undefined,
  backwards = false,
): string | null {
  if (!stack.length) return null;
  if (!currentSelectedId) return backwards ? stack[stack.length - 1]! : stack[0]!;
  const idx = stack.indexOf(currentSelectedId);
  if (idx < 0) return backwards ? stack[stack.length - 1]! : stack[0]!;
  const step = backwards ? -1 : 1;
  return stack[(idx + step + stack.length) % stack.length]!;
}

/**
 * Resolve a single left-click on a 3D/2D token stack:
 * - Fresh click (new spot, different stack, or current selection not in stack):
 *   selects the frontmost token (`stack[0]`).
 * - Repeated click at the same spot (within `sameSpotPx`) while a token in the
 *   stack is already the sole selection: cycles cleanly to the next token behind it.
 */
export function resolveStackClick(opts: {
  stack: readonly string[];
  currentSelectedIds: readonly string[];
  clientX: number;
  clientY: number;
  previousClick: { x: number; y: number; stackKey: string } | null;
  additive?: boolean;
  sameSpotPx?: number;
}): { tokenId: string | null; nextClick: { x: number; y: number; stackKey: string } | null } {
  const { stack, currentSelectedIds, clientX, clientY, previousClick, additive = false, sameSpotPx = 6 } = opts;
  if (!stack.length) return { tokenId: null, nextClick: null };

  const stackKey = stack.join('|');
  const nextClick = { x: clientX, y: clientY, stackKey };

  const sameSpot =
    !additive &&
    !!previousClick &&
    previousClick.stackKey === stackKey &&
    Math.hypot(clientX - previousClick.x, clientY - previousClick.y) <= sameSpotPx;

  if (sameSpot && stack.length > 1 && currentSelectedIds.length === 1 && stack.includes(currentSelectedIds[0]!)) {
    return {
      tokenId: nextCycledTokenId(stack, currentSelectedIds[0]!, false),
      nextClick,
    };
  }

  return { tokenId: stack[0]!, nextClick };
}

/**
 * Deterministic board-wide token order for `Tab` / "Next token":
 * 1. Living creatures in initiative order first.
 * 2. Remaining living creatures ordered top-to-bottom, left-to-right.
 * 3. Dead creatures / objects only when no living creatures are present (or at the end).
 */
export function orderedCycleTokenIds(candidates: readonly CycleTokenCandidate[]): string[] {
  if (!candidates.length) return [];
  const livingCreatures = candidates.filter((c) => !c.isObject && !c.isDead);
  const pool = livingCreatures.length > 0 ? livingCreatures : candidates;
  return [...pool]
    .sort((a, b) => {
      const aInit = a.initiativeRank ?? Number.POSITIVE_INFINITY;
      const bInit = b.initiativeRank ?? Number.POSITIVE_INFINITY;
      if (aInit !== bInit) return aInit - bInit;
      if (Math.abs(a.y - b.y) > 8) return a.y - b.y;
      if (Math.abs(a.x - b.x) > 8) return a.x - b.x;
      return a.id.localeCompare(b.id);
    })
    .map((c) => c.id);
}
