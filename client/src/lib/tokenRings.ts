/**
 * Concentric ground-ring layout around a token base.
 *
 * All 3D radii are normalized to `baseDiameter = 1.0`, so the miniature base
 * outer rim sits at radius `0.50`. From inside out:
 *   1. Framed HP arc sits ON TOP of the token's front pedestal edge (~0.41..0.495).
 *   2. Up to 3 condition rings (red / green / blue) stack tightly outside `0.50`.
 *   3. Selection ring (crisp white) encircles the condition stack.
 *   4. Active-turn ring (bold gold) encircles everything on the outside,
 *      stepping cleanly past the selection ring when both are active.
 */

export interface RingBand {
  inner: number;
  outer: number;
}

export interface TokenRingLayout3D {
  conditions: RingBand[];
  selection: RingBand;
  turn: RingBand;
  /** Maximum outward scale multiplier for gentle active-turn pulse. */
  turnPulseMaxScale: number;
}

const MAX_CONDITION_RINGS = 3;
const CONDITION_START = 0.516;
const CONDITION_WIDTH = 0.032;
const CONDITION_GAP = 0.011;

const BASE_OUTER_CLEARANCE = 0.508;
const SELECTION_GAP = 0.015;
const SELECTION_WIDTH = 0.034;
const TURN_GAP_ALONE = 0.016;
const TURN_GAP_AFTER_SELECTION = 0.026;
const TURN_WIDTH = 0.05;
export const TURN_PULSE_MAX_SCALE = 1.022;

export function conditionRingBand3D(index: number): RingBand {
  const inner = CONDITION_START + index * (CONDITION_WIDTH + CONDITION_GAP);
  return { inner, outer: inner + CONDITION_WIDTH };
}

export function computeTokenRingLayout3D(
  conditionCount: number,
  selected: boolean,
): TokenRingLayout3D {
  const count = Math.max(0, Math.min(MAX_CONDITION_RINGS, Math.floor(conditionCount)));
  const conditions = Array.from({ length: count }, (_, i) => conditionRingBand3D(i));
  const innerOuter = count > 0 ? conditions[count - 1]!.outer : BASE_OUTER_CLEARANCE;

  const selectionInner = innerOuter + SELECTION_GAP;
  const selection: RingBand = {
    inner: selectionInner,
    outer: selectionInner + SELECTION_WIDTH,
  };

  const turnInner = selected
    ? selection.outer + TURN_GAP_AFTER_SELECTION
    : innerOuter + TURN_GAP_ALONE;
  const turn: RingBand = {
    inner: turnInner,
    outer: turnInner + TURN_WIDTH,
  };

  return {
    conditions,
    selection,
    turn,
    turnPulseMaxScale: TURN_PULSE_MAX_SCALE,
  };
}

/**
 * Matching 2D Konva ring radii (in map pixels around `radius`) so top-down 2D
 * tokens preserve the same inner-conditions -> selection -> active-turn order.
 */
export interface TokenRingLayout2D {
  conditionRadii: number[];
  conditionStrokeWidth: number;
  selectionRadius: number;
  selectionStrokeWidth: number;
  turnRadius: number;
  turnStrokeWidth: number;
}

export function computeTokenRingLayout2D(
  radius: number,
  conditionCount: number,
  selected: boolean,
): TokenRingLayout2D {
  const count = Math.max(0, Math.min(MAX_CONDITION_RINGS, Math.floor(conditionCount)));
  const conditionStrokeWidth = 3.2;
  const conditionPitch = 4.6;
  const conditionStart = radius + 4.5;
  const conditionRadii = Array.from({ length: count }, (_, i) => conditionStart + i * conditionPitch);
  const innerOuter = count > 0
    ? conditionRadii[count - 1]! + conditionStrokeWidth / 2
    : radius + 2.5;

  const selectionStrokeWidth = 2.6;
  const selectionRadius = innerOuter + 2.2 + selectionStrokeWidth / 2;

  const turnStrokeWidth = 4.2;
  const turnBase = selected ? selectionRadius + selectionStrokeWidth / 2 + 2.4 : innerOuter + 2.4;
  const turnRadius = turnBase + turnStrokeWidth / 2;

  return {
    conditionRadii,
    conditionStrokeWidth,
    selectionRadius,
    selectionStrokeWidth,
    turnRadius,
    turnStrokeWidth,
  };
}
