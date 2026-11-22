export type DiceResultsLayoutInput = {
  width: number;
  height: number;
  count: number;
  hasDieBadges: boolean;
  hasSaveDice: boolean;
};

export type DiceResultsLayout = {
  columns: number;
  rows: number;
  resultsHeight: number;
  colMaxWidth: number;
  cellWidth: number;
  cellHeight: number;
  compact: boolean;
  dense: boolean;
  numberSize: number;
  labelSize: number;
  badgeSize: number;
};

/**
 * Keep the 3D dice tray viewport at a constant height for a given dialog size
 * by locking the results strip height purely to container dimensions and
 * scaling result boxes, rows, and typography inside it.
 */
export function computeDiceResultsLayout({
  width,
  height,
  count,
  hasDieBadges,
  hasSaveDice,
}: DiceResultsLayoutInput): DiceResultsLayout {
  const safeWidth = Math.max(240, Number.isFinite(width) ? width : 800);
  const safeHeight = Math.max(220, Number.isFinite(height) ? height : 500);
  const safeCount = Math.max(1, Math.floor(count));

  // Container-only height so adding waves, badges, or more dice never shrinks the 3D tray.
  const resultsHeight = Math.round(Math.max(60, Math.min(70, safeHeight * 0.115)));

  const gapX = 4;
  const gapY = 3;
  const padY = 4;
  const minSingleRowColWidth = hasSaveDice ? 78 : hasDieBadges ? 56 : 46;
  const maxColsOneRow = Math.max(
    1,
    Math.floor((safeWidth + gapX) / (minSingleRowColWidth + gapX)),
  );

  let rows = 1;
  let columns = safeCount;
  if (safeCount > maxColsOneRow) {
    const minMultiRowColWidth = hasSaveDice ? 58 : 34;
    const maxColsMultiRow = Math.max(
      1,
      Math.floor((safeWidth + gapX) / (minMultiRowColWidth + gapX)),
    );
    const maxReadableRows = Math.max(
      2,
      Math.min(3, Math.floor((resultsHeight - padY + gapY) / (19 + gapY))),
    );
    const minRowsNeeded = Math.max(
      2,
      Math.min(maxReadableRows, Math.ceil(safeCount / maxColsMultiRow)),
    );
    // Prefer balanced rows that maximize cell area without overflowing horizontally.
    let bestRows = minRowsNeeded;
    let bestCols = Math.ceil(safeCount / bestRows);
    let bestArea = 0;
    const maxRowsCandidate = Math.min(maxReadableRows, safeCount);
    for (let r = minRowsNeeded; r <= maxRowsCandidate; r++) {
      const c = Math.ceil(safeCount / r);
      const cw = Math.floor((safeWidth - (c - 1) * gapX) / c);
      const ch = (resultsHeight - padY - (r - 1) * gapY) / r;
      const area = Math.min(cw, 64) * Math.min(ch, 34);
      if (area >= bestArea) {
        bestArea = area;
        bestRows = r;
        bestCols = c;
      }
    }
    rows = bestRows;
    columns = bestCols;
  }

  const maxCardWidth = hasSaveDice ? 92 : hasDieBadges ? 88 : 60;
  const rawCellWidth = Math.floor((safeWidth - (columns - 1) * gapX) / columns);
  const colMaxWidth = Math.max(26, Math.min(maxCardWidth, rawCellWidth));
  const cellWidth = colMaxWidth;
  const cellHeight = (resultsHeight - padY - (rows - 1) * gapY) / rows;

  const compact = rows >= 2 || cellWidth < 56;
  const dense = rows >= 3 || cellHeight < 28 || cellWidth < 44;

  const labelSize = Math.round(Math.max(7, Math.min(11, cellHeight * (compact ? 0.22 : 0.16))));
  const badgeSize = Math.round(Math.max(7, Math.min(9, cellHeight * 0.145)));
  const headerPx = labelSize * 1.15;
  const maxLabelPx = !compact ? 9 : 0;
  const extraLinePx = !dense && (hasDieBadges || hasSaveDice) ? badgeSize * 1.2 + 3 : 0;
  const verticalPad = compact ? 3 : 6;
  const availableForNumber = Math.max(
    10,
    cellHeight - verticalPad - headerPx - extraLinePx - maxLabelPx,
  );
  const numberSize = Math.round(
    Math.max(10, Math.min(22, availableForNumber * 0.92, cellWidth * 0.39)),
  );

  return {
    columns,
    rows,
    resultsHeight,
    colMaxWidth,
    cellWidth,
    cellHeight,
    compact,
    dense,
    numberSize,
    labelSize,
    badgeSize,
  };
}
