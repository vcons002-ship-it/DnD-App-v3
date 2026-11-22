import { describe, expect, it } from 'vitest';
import { computeDiceResultsLayout } from './diceResultsLayout';

describe('computeDiceResultsLayout', () => {
  it('keeps resultsHeight strictly constant across pool size and badge transitions', () => {
    const dims = { width: 920, height: 600 };
    const baseline = computeDiceResultsLayout({
      ...dims,
      count: 1,
      hasDieBadges: false,
      hasSaveDice: false,
    });
    expect(baseline.resultsHeight).toBe(69);

    const shortViewport = computeDiceResultsLayout({
      width: 920,
      height: 478,
      count: 1,
      hasDieBadges: false,
      hasSaveDice: false,
    });
    expect(shortViewport.resultsHeight).toBe(60);

    for (const count of [1, 2, 3, 4, 6, 9, 12, 20, 40]) {
      for (const hasDieBadges of [false, true]) {
        for (const hasSaveDice of [false, true]) {
          const next = computeDiceResultsLayout({
            ...dims,
            count,
            hasDieBadges,
            hasSaveDice,
          });
          expect(next.resultsHeight).toBe(baseline.resultsHeight);
          expect(next.columns * next.rows).toBeGreaterThanOrEqual(count);
        }
      }
    }
  });

  it('keeps default result cards compact when rolling only a few dice', () => {
    for (const count of [1, 2, 3, 4]) {
      const plain = computeDiceResultsLayout({
        width: 1015,
        height: 718,
        count,
        hasDieBadges: false,
        hasSaveDice: false,
      });
      expect(plain.colMaxWidth).toBeLessThanOrEqual(60);
      expect(plain.numberSize).toBeLessThanOrEqual(22);
      expect(plain.resultsHeight).toBeLessThanOrEqual(70);

      const badged = computeDiceResultsLayout({
        width: 1015,
        height: 718,
        count,
        hasDieBadges: true,
        hasSaveDice: false,
      });
      expect(badged.colMaxWidth).toBeLessThanOrEqual(88);
      expect(badged.numberSize).toBeLessThanOrEqual(22);
      expect(badged.resultsHeight).toBeLessThanOrEqual(70);
    }
  });

  it('keeps 9 and 12 badged dice on a single desktop row without wrapping or resizing the tray', () => {
    const nine = computeDiceResultsLayout({
      width: 920,
      height: 550,
      count: 9,
      hasDieBadges: true,
      hasSaveDice: false,
    });
    expect(nine.rows).toBe(1);
    expect(nine.columns).toBe(9);
    expect(nine.compact).toBe(false);
    expect(nine.dense).toBe(false);
    expect(nine.numberSize).toBeGreaterThanOrEqual(16);

    const twelve = computeDiceResultsLayout({
      width: 920,
      height: 550,
      count: 12,
      hasDieBadges: true,
      hasSaveDice: false,
    });
    expect(twelve.rows).toBe(1);
    expect(twelve.columns).toBe(12);
    expect(twelve.compact).toBe(false);
    expect(twelve.dense).toBe(false);
    expect(twelve.numberSize).toBeGreaterThanOrEqual(16);
  });

  it('scales result cells and fonts down cleanly for 20 and 40 dice inside the same fixed strip', () => {
    const six = computeDiceResultsLayout({
      width: 920,
      height: 600,
      count: 6,
      hasDieBadges: false,
      hasSaveDice: false,
    });
    const twenty = computeDiceResultsLayout({
      width: 920,
      height: 600,
      count: 20,
      hasDieBadges: false,
      hasSaveDice: false,
    });
    const fortyWide = computeDiceResultsLayout({
      width: 920,
      height: 600,
      count: 40,
      hasDieBadges: false,
      hasSaveDice: false,
    });
    const fortyNarrow = computeDiceResultsLayout({
      width: 720,
      height: 600,
      count: 40,
      hasDieBadges: false,
      hasSaveDice: false,
    });

    expect(six.resultsHeight).toBe(twenty.resultsHeight);
    expect(twenty.resultsHeight).toBe(fortyWide.resultsHeight);
    expect(twenty.rows).toBe(2);
    expect(twenty.compact).toBe(true);
    expect(fortyWide.dense).toBe(true);
    expect(fortyWide.numberSize).toBeLessThan(twenty.numberSize);
    expect(fortyNarrow.rows).toBe(3);
    expect(fortyNarrow.dense).toBe(true);
    expect(fortyNarrow.numberSize).toBeLessThanOrEqual(twenty.numberSize);
    expect(twenty.numberSize).toBeLessThan(six.numberSize);
    expect(fortyNarrow.labelSize).toBeLessThanOrEqual(twenty.labelSize);
    expect(fortyNarrow.numberSize).toBeLessThan(fortyNarrow.cellHeight);
    expect(fortyNarrow.cellHeight).toBeGreaterThanOrEqual(19);
  });
});
