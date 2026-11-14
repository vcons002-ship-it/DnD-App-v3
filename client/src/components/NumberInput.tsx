import { useEffect, useRef, useState, type FocusEvent, type InputHTMLAttributes } from 'react';
import { clampNumber, normalizeNumericDraft, parseNumericDraft } from '../lib/numberInput';

export interface NumberInputProps
  extends Omit<
    InputHTMLAttributes<HTMLInputElement>,
    'type' | 'value' | 'defaultValue' | 'onChange' | 'min' | 'max'
  > {
  value: number | '' | null | undefined;
  onValueChange: (value: number | undefined) => void;
  min?: number;
  max?: number;
  allowDecimal?: boolean;
  allowNegative?: boolean;
  allowEmpty?: boolean;
  emptyFallback?: number;
  commitOnBlur?: boolean;
}

function externalToString(value: number | '' | null | undefined): string {
  if (value === '' || value === null || value === undefined) return '';
  if (typeof value === 'number' && !Number.isFinite(value)) return '';
  return String(Object.is(value, -0) ? 0 : value);
}

/**
 * Draft-backed `<input type="number">` that lets users clear fields and type
 * replacements cleanly without a leading `0` refilling mid-edit.
 */
export function NumberInput({
  value,
  onValueChange,
  min,
  max,
  step,
  allowDecimal,
  allowNegative,
  allowEmpty = false,
  emptyFallback,
  commitOnBlur = false,
  onFocus,
  onBlur,
  ...rest
}: NumberInputProps) {
  const canDecimal =
    allowDecimal ??
    (step === 'any' || (typeof step === 'number' ? !Number.isInteger(step) : typeof step === 'string' && step.includes('.')));
  const canNegative = allowNegative ?? (min === undefined || min < 0);

  const [draft, setDraft] = useState<string>(() => externalToString(value));
  const focusedRef = useRef(false);

  useEffect(() => {
    if (!focusedRef.current) {
      setDraft(externalToString(value));
    }
  }, [value]);

  const handleFocus = (e: FocusEvent<HTMLInputElement>) => {
    focusedRef.current = true;
    onFocus?.(e);
  };

  const handleBlur = (e: FocusEvent<HTMLInputElement>) => {
    focusedRef.current = false;
    const parsed = parseNumericDraft(draft);
    if (parsed === undefined) {
      if (allowEmpty) {
        setDraft('');
        onValueChange(undefined);
      } else if (emptyFallback !== undefined) {
        const next = clampNumber(emptyFallback, min, max);
        setDraft(String(next));
        onValueChange(next);
      } else {
        setDraft(externalToString(value));
      }
    } else {
      const clamped = clampNumber(parsed, min, max);
      setDraft(String(clamped));
      if (commitOnBlur || clamped !== parsed || clamped !== value) {
        onValueChange(clamped);
      }
    }
    onBlur?.(e);
  };

  return (
    <input
      {...rest}
      type="number"
      min={min}
      max={max}
      step={step}
      value={draft}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onChange={(e) => {
        const raw = e.target.value;
        // Ignore transient browser badInput (e.g. typing a letter into type=number)
        // that blanks e.target.value before any valid digit is entered.
        if (e.target.validity?.badInput && raw === '') return;
        const nextDraft = normalizeNumericDraft(raw, {
          allowNegative: canNegative,
          allowDecimal: canDecimal,
        });
        setDraft(nextDraft);
        if (nextDraft === '' || nextDraft === '-' || nextDraft === '.' || nextDraft === '-.') {
          if (allowEmpty && nextDraft === '' && !commitOnBlur) {
            onValueChange(undefined);
          }
          return;
        }
        const parsed = parseNumericDraft(nextDraft);
        if (parsed === undefined) return;
        if (!commitOnBlur) {
          onValueChange(clampNumber(parsed, min, max));
        }
      }}
    />
  );
}
