import { describe, expect, it } from 'vitest';
import { clampNumber, normalizeNumericDraft, parseNumericDraft } from './numberInput';

describe('numberInput helpers', () => {
  it('strips redundant leading zeros while keeping standalone zero and decimals', () => {
    expect(normalizeNumericDraft('')).toBe('');
    expect(normalizeNumericDraft('0')).toBe('0');
    expect(normalizeNumericDraft('00')).toBe('0');
    expect(normalizeNumericDraft('05')).toBe('5');
    expect(normalizeNumericDraft('007')).toBe('7');
    expect(normalizeNumericDraft('50')).toBe('50');
    expect(normalizeNumericDraft('-')).toBe('-');
    expect(normalizeNumericDraft('-05')).toBe('-5');
    expect(normalizeNumericDraft('0.5', { allowDecimal: true })).toBe('0.5');
    expect(normalizeNumericDraft('00.5', { allowDecimal: true })).toBe('0.5');
    expect(normalizeNumericDraft('.25', { allowDecimal: true })).toBe('0.25');
    expect(normalizeNumericDraft('0.', { allowDecimal: true })).toBe('0.');
    expect(normalizeNumericDraft('-5', { allowNegative: false })).toBe('5');
  });

  it('parses complete drafts and returns undefined for empty/sign-only drafts', () => {
    expect(parseNumericDraft('')).toBeUndefined();
    expect(parseNumericDraft('-')).toBeUndefined();
    expect(parseNumericDraft('.')).toBeUndefined();
    expect(parseNumericDraft('-.')).toBeUndefined();
    expect(parseNumericDraft('-0')).toBe(0);
    expect(parseNumericDraft('5.')).toBe(5);
    expect(parseNumericDraft('14')).toBe(14);
    expect(parseNumericDraft('-3.5')).toBe(-3.5);
  });

  it('clamps to min and max bounds', () => {
    expect(clampNumber(-2, 0, 10)).toBe(0);
    expect(clampNumber(15, 0, 10)).toBe(10);
    expect(clampNumber(7, 0, 10)).toBe(7);
  });
});
