export interface NumericDraftOptions {
  allowNegative?: boolean;
  allowDecimal?: boolean;
}

/** Normalize a numeric text draft, eliminating redundant leading zeros while
 *  preserving empty strings and partial numeric entry like "-" or "0.". */
export function normalizeNumericDraft(raw: string, opts: NumericDraftOptions = {}): string {
  const allowNegative = opts.allowNegative ?? true;
  const allowDecimal = opts.allowDecimal ?? false;
  let s = raw.trim();
  if (!s) return '';

  const hasMinus = s.startsWith('-');
  s = s.replace(/[+-]/g, '');
  const sign = allowNegative && hasMinus ? '-' : '';

  if (allowDecimal) {
    // Keep digits and at most one decimal point.
    let seenDot = false;
    let cleaned = '';
    for (const ch of s) {
      if (ch >= '0' && ch <= '9') cleaned += ch;
      else if (ch === '.' && !seenDot) {
        cleaned += ch;
        seenDot = true;
      }
    }
    if (!cleaned) return sign;
    const dotIdx = cleaned.indexOf('.');
    if (dotIdx !== -1) {
      const intPart = cleaned.slice(0, dotIdx).replace(/^0+(?=\d)/, '');
      const fracPart = cleaned.slice(dotIdx + 1);
      return `${sign}${intPart || '0'}.${fracPart}`;
    }
    const stripped = cleaned.replace(/^0+(?=\d)/, '').replace(/^00+$/, '0');
    return `${sign}${stripped}`;
  }

  const digits = s.replace(/\D+/g, '');
  if (!digits) return sign;
  const stripped = digits.replace(/^0+(?=\d)/, '').replace(/^00+$/, '0');
  return `${sign}${stripped}`;
}

/** Parse a draft string to a finite number, or undefined for incomplete drafts
 *  ("", "-", ".", "-."). Normalizes -0 to 0. */
export function parseNumericDraft(draft: string): number | undefined {
  const trimmed = draft.trim();
  if (!trimmed || trimmed === '-' || trimmed === '.' || trimmed === '-.') return undefined;
  if (trimmed.endsWith('.')) {
    const whole = Number(trimmed.slice(0, -1));
    return Number.isFinite(whole) ? (Object.is(whole, -0) ? 0 : whole) : undefined;
  }
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return undefined;
  return Object.is(n, -0) ? 0 : n;
}

export function clampNumber(value: number, min?: number, max?: number): number {
  let out = value;
  if (min !== undefined && out < min) out = min;
  if (max !== undefined && out > max) out = max;
  return out;
}
