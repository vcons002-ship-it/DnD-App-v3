import { describe, it, expect } from 'vitest';
import {
  computeTokenRingLayout2D,
  computeTokenRingLayout3D,
} from '../../client/src/lib/tokenRings.js';

describe('tokenRings concentric layout', () => {
  it('stacks 3D condition rings strictly inside selection and active-turn rings with positive gaps', () => {
    for (const count of [0, 1, 2, 3]) {
      for (const selected of [false, true]) {
        const layout = computeTokenRingLayout3D(count, selected);
        expect(layout.conditions).toHaveLength(count);

        // Base outer edge is 0.50; condition rings stay strictly outside base rim and non-overlapping.
        for (let i = 0; i < layout.conditions.length; i++) {
          const band = layout.conditions[i]!;
          expect(band.inner).toBeGreaterThan(0.5);
          expect(band.outer).toBeGreaterThan(band.inner);
          if (i > 0) {
            expect(band.inner).toBeGreaterThan(layout.conditions[i - 1]!.outer + 0.008);
          }
        }

        const innerOuter = count > 0 ? layout.conditions[count - 1]!.outer : 0.505;
        expect(layout.selection.inner).toBeGreaterThan(innerOuter + 0.01);
        expect(layout.selection.outer).toBeGreaterThan(layout.selection.inner);

        if (selected) {
          // Selection and active-turn must remain two cleanly separated outer rings.
          expect(layout.turn.inner).toBeGreaterThan(layout.selection.outer + 0.015);
        } else {
          expect(layout.turn.inner).toBeGreaterThan(innerOuter + 0.012);
        }
        // Outward pulse never shrinks the active-turn ring inward into selection.
        expect(layout.turnPulseMaxScale).toBeGreaterThanOrEqual(1);
        expect(layout.turn.inner * layout.turnPulseMaxScale).toBeGreaterThan(layout.turn.inner);
      }
    }
  });

  it('keeps 2D condition rings inside selection and active-turn rings with non-overlapping strokes', () => {
    const r = 28;
    for (const count of [0, 1, 2, 3]) {
      const both = computeTokenRingLayout2D(r, count, true);
      expect(both.conditionRadii).toHaveLength(count);
      for (let i = 1; i < count; i++) {
        const prevOuter = both.conditionRadii[i - 1]! + both.conditionStrokeWidth / 2;
        const currInner = both.conditionRadii[i]! - both.conditionStrokeWidth / 2;
        expect(currInner).toBeGreaterThan(prevOuter + 0.5);
      }
      const condOuter =
        count > 0
          ? both.conditionRadii[count - 1]! + both.conditionStrokeWidth / 2
          : r;
      const selInner = both.selectionRadius - both.selectionStrokeWidth / 2;
      const selOuter = both.selectionRadius + both.selectionStrokeWidth / 2;
      const turnInner = both.turnRadius - both.turnStrokeWidth / 2;
      expect(selInner).toBeGreaterThan(condOuter + 1);
      expect(turnInner).toBeGreaterThan(selOuter + 1);
    }
  });
});
