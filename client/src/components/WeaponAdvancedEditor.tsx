import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DAMAGE_TYPES } from '../../../shared/damage';
import { isValidDiceExpression } from '../../../shared/dice';
import {
  cleanDiceRules,
  formatWeaponTriggersSummary,
  isSimpleAutoCastSpell,
} from '../../../shared/diceRules';
import { spellDamageTypeChoices } from '../../../shared/spellExecution';
import type {
  DiceRulesSpec,
  SheetAbility,
  SpellCustomEffect,
  Weapon,
  WeaponTrigger,
  WeaponTriggerSpell,
  WeaponTriggerWhen,
} from '../../../shared/types';
import { DiceRulesEditor } from './DiceRulesEditor';
import { NumberInput } from './NumberInput';

type Props = {
  weapon: Weapon;
  sheetAbilities?: SheetAbility[];
  onSave: (updated: Weapon) => void;
  onClose: () => void;
};

const SAVE_ABILITIES = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'] as const;

const TRIGGER_WHEN_OPTIONS: { value: WeaponTriggerWhen; label: string }[] = [
  { value: 'on-hit', label: 'On Hit' },
  { value: 'on-crit', label: 'On Critical Hit' },
  { value: 'on-nat-20', label: 'On Natural 20' },
  { value: 'on-d20-at-least', label: 'On Natural d20 ≥ Threshold' },
  { value: 'on-damage-max', label: 'On Any Damage Die Max' },
  { value: 'on-damage-match', label: 'On Matching Damage Dice' },
  { value: 'on-miss', label: 'On Miss' },
];

function makeTriggerId(): string {
  return `trig-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function WeaponAdvancedEditor({ weapon, sheetAbilities = [], onSave, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [critThreshold, setCritThreshold] = useState<number>(
    weapon.critThreshold ?? weapon.diceRules?.critThreshold ?? 20,
  );
  const [diceRules, setDiceRules] = useState<DiceRulesSpec | undefined>(weapon.diceRules);
  const [triggers, setTriggers] = useState<WeaponTrigger[]>(() =>
    (weapon.triggers ?? []).map((t) => ({ ...t })),
  );
  const [spellQueryByTrigger, setSpellQueryByTrigger] = useState<Record<string, string>>({});
  const [activeSpellPicker, setActiveSpellPicker] = useState<string | null>(null);
  const [spellSearchResults, setSpellSearchResults] = useState<SheetAbility[]>([]);
  const [cachedSpells, setCachedSpells] = useState<Record<string, SheetAbility>>({});
  const [error, setError] = useState<string | null>(null);

  useLayoutEffect(() => {
    const node = dialogRef.current;
    if (node && !node.open) node.showModal();
    return () => {
      if (node?.open) node.close();
    };
  }, []);

  const activeQuery = activeSpellPicker ? (spellQueryByTrigger[activeSpellPicker] ?? '') : '';

  useEffect(() => {
    if (!activeSpellPicker) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/spells?q=${encodeURIComponent(activeQuery)}`, { signal: ctrl.signal })
        .then((r) => r.json())
        .then((d) => {
          if (ctrl.signal.aborted) return;
          const rows = (d.results ?? []) as SheetAbility[];
          setSpellSearchResults(rows);
          setCachedSpells((prev) => {
            const next = { ...prev };
            for (const row of rows) next[row.name.trim().toLowerCase()] = row;
            return next;
          });
        })
        .catch(() => !ctrl.signal.aborted && setSpellSearchResults([]));
    }, activeQuery ? 180 : 0);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [activeSpellPicker, activeQuery]);

  // Seed spell lookup cache for existing configured spells so auto-cast vs prompt badge is accurate.
  useEffect(() => {
    const missing = triggers
      .map((t) => t.castSpell?.spellName?.trim())
      .filter((name): name is string => Boolean(name))
      .filter((name) => {
        const key = name.toLowerCase();
        return (
          !cachedSpells[key] &&
          !sheetAbilities.some((a) => a.name.trim().toLowerCase() === key)
        );
      });
    if (missing.length === 0) return;
    fetch('/api/spells/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ names: missing }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data?.resolved) return;
        setCachedSpells((prev) => {
          const next = { ...prev };
          for (const [k, v] of Object.entries(data.resolved as Record<string, SheetAbility>)) {
            next[k.toLowerCase()] = v;
          }
          return next;
        });
      })
      .catch(() => {});
  }, [triggers, sheetAbilities, cachedSpells]);

  const sheetSpellOptions = useMemo(
    () => sheetAbilities.filter((a) => a.type === 'spell' || Boolean(a.roll)),
    [sheetAbilities],
  );

  const patchTrigger = (id: string, patch: Partial<WeaponTrigger>) => {
    setTriggers((old) => old.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  };

  const patchTriggerEffect = (id: string, patch: Partial<SpellCustomEffect>) => {
    setTriggers((old) =>
      old.map((t) => (t.id === id ? { ...t, effect: { ...(t.effect ?? {}), ...patch } } : t)),
    );
  };

  const patchTriggerSpell = (id: string, patch: Partial<WeaponTriggerSpell>) => {
    setTriggers((old) =>
      old.map((t) =>
        t.id === id
          ? {
              ...t,
              castSpell: { ...(t.castSpell ?? { spellName: '' }), ...patch },
            }
          : t,
      ),
    );
  };

  const addTemplate = (tpl: string) => {
    const id = makeTriggerId();
    if (tpl === 'vicious') {
      setTriggers((old) => [
        ...old,
        {
          id,
          name: 'Vicious Strike',
          enabled: true,
          when: 'on-crit',
          extraDamageDice: '2d6',
          extraDamageType: weapon.damageType || 'slashing',
          doubleOnCrit: false,
        },
      ]);
    } else if (tpl === 'undead-bane') {
      setTriggers((old) => [
        ...old,
        {
          id,
          name: 'Bane of Undead',
          enabled: true,
          when: 'on-hit',
          targetCreatureTypes: ['undead'],
          extraDamageDice: '2d6',
          extraDamageType: 'radiant',
          doubleOnCrit: true,
        },
      ]);
    } else if (tpl === 'vampiric') {
      setTriggers((old) => [
        ...old,
        {
          id,
          name: 'Life Drain',
          enabled: true,
          when: 'on-hit',
          healDice: '1d6',
          healMode: 'hitPoints',
        },
      ]);
    } else if (tpl === 'prone-crit') {
      setTriggers((old) => [
        ...old,
        {
          id,
          name: 'Crushing Blow',
          enabled: true,
          when: 'on-crit',
          effectSave: 'STR',
          effectDc: 14,
          effect: {
            conditionLabel: 'Prone',
            target: 'affected',
            aura: 'red',
          },
        },
      ]);
    } else if (tpl === 'fireball-20') {
      setTriggers((old) => [
        ...old,
        {
          id,
          name: 'Detonate Fireball',
          enabled: true,
          when: 'on-nat-20',
          castSpell: {
            spellName: 'Fireball',
            castLevel: 3,
            castMode: 'prompt',
          },
        },
      ]);
    } else if (tpl === 'guiding-bolt-hit') {
      setTriggers((old) => [
        ...old,
        {
          id,
          name: 'Astral Flare',
          enabled: true,
          when: 'on-hit',
          castSpell: {
            spellName: 'Guiding Bolt',
            castLevel: 1,
            targetMode: 'target',
          },
        },
      ]);
    } else {
      setTriggers((old) => [
        ...old,
        {
          id,
          name: 'Custom Trigger',
          enabled: true,
          when: 'on-hit',
        },
      ]);
    }
  };

  const resolveAbilityForTriggerSpell = (ts?: WeaponTriggerSpell): SheetAbility | undefined => {
    if (!ts) return undefined;
    if (ts.abilityId) {
      const owned = sheetAbilities.find((a) => a.id === ts.abilityId);
      if (owned) return owned;
    }
    const key = ts.spellName.trim().toLowerCase();
    if (!key) return undefined;
    return (
      sheetAbilities.find((a) => a.name.trim().toLowerCase() === key) ?? cachedSpells[key]
    );
  };

  const handleSave = () => {
    setError(null);
    const exprChecks: [string, string | undefined][] = [
      ['Exploding bonus die', diceRules?.exploding?.bonusDice],
      ['Matching bonus dice', diceRules?.matchingDice?.bonusDice],
      ['Extra critical dice', diceRules?.extraCritDice],
      ...triggers.flatMap((t): [string, string | undefined][] => [
        [`${t.name || 'Trigger'} extra damage`, t.extraDamageDice],
        [`${t.name || 'Trigger'} heal dice`, t.healDice],
      ]),
    ];
    for (const [label, expr] of exprChecks) {
      const trimmed = expr?.trim();
      if (trimmed && !isValidDiceExpression(trimmed)) {
        setError(`Invalid dice expression for "${label}": "${trimmed}".`);
        return;
      }
    }

    const cleanedTriggers: WeaponTrigger[] = triggers
      .map((t) => {
        const types = (t.targetCreatureTypes ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean);
        const fx = t.effect && (
          t.effect.conditionLabel?.trim() ||
          t.effect.note?.trim() ||
          t.effect.durationRounds ||
          t.effect.aura ||
          t.effect.acBonus ||
          t.effect.zeroSpeed ||
          t.effect.attackDisadvantage
        )
          ? {
              ...t.effect,
              ...(t.effect.conditionLabel?.trim() ? { conditionLabel: t.effect.conditionLabel.trim() } : {}),
              ...(t.effect.note?.trim() ? { note: t.effect.note.trim() } : {}),
            }
          : undefined;
        const spell = t.castSpell?.spellName?.trim()
          ? {
              spellName: t.castSpell.spellName.trim(),
              ...(t.castSpell.abilityId ? { abilityId: t.castSpell.abilityId } : {}),
              ...(t.castSpell.castLevel !== undefined ? { castLevel: t.castSpell.castLevel } : {}),
              ...(t.castSpell.dcOverride !== undefined ? { dcOverride: t.castSpell.dcOverride } : {}),
              ...(t.castSpell.damageType?.trim() ? { damageType: t.castSpell.damageType.trim().toLowerCase() } : {}),
              ...(t.castSpell.targetMode ? { targetMode: t.castSpell.targetMode } : {}),
              ...(t.castSpell.castMode ? { castMode: t.castSpell.castMode } : {}),
            }
          : undefined;
        const clean: WeaponTrigger = {
          id: t.id || makeTriggerId(),
          name: t.name.trim() || 'Weapon Trigger',
          enabled: t.enabled !== false,
          when: t.when,
          ...(t.when === 'on-d20-at-least' ? { d20Threshold: Math.max(2, Math.min(20, t.d20Threshold ?? 19)) } : {}),
          ...(types.length ? { targetCreatureTypes: types } : {}),
          ...(t.extraDamageDice?.trim() ? { extraDamageDice: t.extraDamageDice.trim() } : {}),
          ...(t.extraDamageType?.trim() ? { extraDamageType: t.extraDamageType.trim().toLowerCase() } : {}),
          ...(t.doubleOnCrit !== undefined ? { doubleOnCrit: t.doubleOnCrit } : {}),
          ...(fx ? { effect: fx } : {}),
          ...(t.effectSave ? { effectSave: t.effectSave } : {}),
          ...(t.effectSave && t.effectDc !== undefined ? { effectDc: t.effectDc } : {}),
          ...(t.healDice?.trim() ? { healDice: t.healDice.trim() } : {}),
          ...(t.healDice?.trim() && t.healMode ? { healMode: t.healMode } : {}),
          ...(spell ? { castSpell: spell } : {}),
          ...(t.note?.trim() ? { note: t.note.trim() } : {}),
        };
        return clean;
      })
      .filter(
        (t) =>
          Boolean(
            t.extraDamageDice ||
              t.healDice ||
              t.effect ||
              t.castSpell,
          ),
      );

    const cleanedRules = cleanDiceRules(diceRules);
    onSave({
      ...weapon,
      critThreshold: critThreshold < 20 ? Math.max(2, Math.min(19, Math.floor(critThreshold))) : undefined,
      diceRules: cleanedRules,
      triggers: cleanedTriggers.length ? cleanedTriggers : undefined,
    });
    onClose();
  };

  const critSelectValue =
    critThreshold === 20 || critThreshold === 19 || critThreshold === 18
      ? String(critThreshold)
      : 'custom';

  const triggerChips = formatWeaponTriggersSummary(triggers);

  return createPortal(
    <dialog
      ref={dialogRef}
      className="modal spell-effect-editor-modal"
      aria-label={`Weapon advanced rules for ${weapon.name || 'weapon'}`}
      onKeyDown={(e) => e.stopPropagation()}
      onCancel={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === dialogRef.current) onClose();
      }}
    >
      <div className="see-surface" onClick={(e) => e.stopPropagation()}>
        <div className="see-head">
          <h3>⚙ Advanced Weapon Rules · {weapon.name || 'Unnamed Weapon'}</h3>
          <button className="res-x" title="Close" onClick={onClose} style={{ marginLeft: 'auto' }}>
            ✕
          </button>
        </div>

        <div className="see-body">
          {error && (
            <div
              className="see-banner"
              style={{ borderColor: '#f87171', background: 'rgba(248, 113, 113, 0.12)', color: '#fecaca' }}
            >
              {error}
            </div>
          )}

          {/* 1. Critical Hit Range */}
          <section className="see-section">
            <div className="see-section-title">
              <span>Critical Hit Range</span>
              <span style={{ fontWeight: 400, textTransform: 'none', color: 'var(--muted)' }}>
                Natural d20 rolls at or above this threshold score a critical hit
              </span>
            </div>
            <div className="see-grid">
              <label className="see-field">
                Critical Threshold
                <select
                  value={critSelectValue}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === 'custom') setCritThreshold(17);
                    else setCritThreshold(Number(v));
                  }}
                >
                  <option value="20">Standard (20)</option>
                  <option value="19">Improved Critical (19–20)</option>
                  <option value="18">Superior Critical (18–20)</option>
                  <option value="custom">Custom natural d20…</option>
                </select>
              </label>
              {critSelectValue === 'custom' && (
                <label className="see-field">
                  Minimum Natural d20
                  <NumberInput
                    min={2}
                    max={19}
                    value={critThreshold}
                    onValueChange={(v) => setCritThreshold(v ?? 19)}
                  />
                </label>
              )}
            </div>
          </section>

          {/* 2. Weapon Dice Rules */}
          <DiceRulesEditor
            context="weapon"
            showCrit
            defaultExpanded={Boolean(diceRules)}
            value={diceRules}
            onChange={setDiceRules}
            defaultDamageType={weapon.damageType}
          />

          {/* 3. Conditional Triggers */}
          <section className="see-section">
            <div className="see-section-title">
              <span>Conditional Roll Triggers ({triggers.length})</span>
              {triggerChips.length > 0 && (
                <span style={{ fontWeight: 400, textTransform: 'none', color: 'var(--text)' }}>
                  {triggerChips.join(' · ')}
                </span>
              )}
            </div>

            <div className="see-chips">
              <span className="muted" style={{ fontSize: 11, alignSelf: 'center', marginRight: 4 }}>
                Quick Add:
              </span>
              <button type="button" className="see-chip" onClick={() => addTemplate('vicious')}>
                💥 Vicious (+2d6 on Crit)
              </button>
              <button type="button" className="see-chip" onClick={() => addTemplate('undead-bane')}>
                ☀ +2d6 Radiant vs Undead
              </button>
              <button type="button" className="see-chip" onClick={() => addTemplate('vampiric')}>
                🩸 +1d6 Heal on Hit
              </button>
              <button type="button" className="see-chip" onClick={() => addTemplate('prone-crit')}>
                🦶 Prone Save on Crit
              </button>
              <button type="button" className="see-chip" onClick={() => addTemplate('fireball-20')}>
                🔥 Fireball on Nat 20
              </button>
              <button type="button" className="see-chip" onClick={() => addTemplate('guiding-bolt-hit')}>
                ✨ Guiding Bolt on Hit
              </button>
              <button type="button" className="see-chip on" onClick={() => addTemplate('blank')}>
                ＋ Blank Trigger
              </button>
            </div>

            {triggers.length === 0 && (
              <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                Add conditional effects for crits, natural 20s, high d20 rolls, max/matching damage dice, hits, or misses.
              </p>
            )}

            {triggers.map((t, idx) => {
              const resolvedSpell = resolveAbilityForTriggerSpell(t.castSpell);
              const spellAutoCast = resolvedSpell
                ? isSimpleAutoCastSpell(resolvedSpell, t.castSpell?.castLevel)
                : false;
              const dmgChoices = resolvedSpell
                ? spellDamageTypeChoices(resolvedSpell, t.castSpell?.castLevel)
                : [];
              const pickerOpen = activeSpellPicker === t.id;
              return (
                <div
                  key={t.id}
                  className="see-banner"
                  style={{ flexDirection: 'column', alignItems: 'stretch', gap: 10 }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <label className="see-check">
                      <input
                        type="checkbox"
                        checked={t.enabled !== false}
                        onChange={(e) => patchTrigger(t.id, { enabled: e.target.checked })}
                      />
                      <strong>Trigger #{idx + 1}</strong>
                    </label>
                    <input
                      style={{ flex: '1 1 180px' }}
                      value={t.name}
                      placeholder="Trigger label (shown in tray badge)"
                      onChange={(e) => patchTrigger(t.id, { name: e.target.value })}
                    />
                    <button
                      type="button"
                      className="btn tiny"
                      onClick={() => setTriggers((old) => old.filter((x) => x.id !== t.id))}
                    >
                      Remove
                    </button>
                  </div>

                  <div className="see-grid">
                    <label className="see-field">
                      Trigger Condition
                      <select
                        value={t.when}
                        onChange={(e) =>
                          patchTrigger(t.id, { when: e.target.value as WeaponTriggerWhen })
                        }
                      >
                        {TRIGGER_WHEN_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    {t.when === 'on-d20-at-least' && (
                      <label className="see-field">
                        Natural d20 ≥
                        <NumberInput
                          min={2}
                          max={20}
                          value={t.d20Threshold ?? 19}
                          onValueChange={(v) => patchTrigger(t.id, { d20Threshold: v ?? 19 })}
                        />
                      </label>
                    )}
                    <label className="see-field">
                      Target Creature Types (optional)
                      <input
                        value={(t.targetCreatureTypes ?? []).join(', ')}
                        placeholder="e.g. undead, fiend (blank = all)"
                        onChange={(e) =>
                          patchTrigger(t.id, {
                            targetCreatureTypes: e.target.value
                              .split(',')
                              .map((s) => s.trim().toLowerCase())
                              .filter(Boolean),
                          })
                        }
                      />
                    </label>
                  </div>

                  {/* Extra Damage + Healing */}
                  <div className="see-grid">
                    <label className="see-field">
                      Extra Damage Dice
                      <input
                        value={t.extraDamageDice ?? ''}
                        placeholder="e.g. 2d6"
                        onChange={(e) =>
                          patchTrigger(t.id, { extraDamageDice: e.target.value || undefined })
                        }
                      />
                    </label>
                    <label className="see-field">
                      Extra Damage Type
                      <select
                        value={t.extraDamageType ?? ''}
                        onChange={(e) =>
                          patchTrigger(t.id, { extraDamageType: e.target.value || undefined })
                        }
                      >
                        <option value="">Same as weapon</option>
                        {DAMAGE_TYPES.map((dt) => (
                          <option key={dt} value={dt}>
                            {dt}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="see-check" style={{ alignSelf: 'end', paddingBottom: 4 }}>
                      <input
                        type="checkbox"
                        checked={t.doubleOnCrit ?? t.when === 'on-hit'}
                        onChange={(e) => patchTrigger(t.id, { doubleOnCrit: e.target.checked })}
                      />
                      Double extra dice on crit
                    </label>
                    <label className="see-field">
                      Heal / Temp HP Dice
                      <input
                        value={t.healDice ?? ''}
                        placeholder="e.g. 1d6"
                        onChange={(e) =>
                          patchTrigger(t.id, { healDice: e.target.value || undefined })
                        }
                      />
                    </label>
                    {t.healDice && (
                      <label className="see-field">
                        Heal Mode
                        <select
                          value={t.healMode ?? 'hitPoints'}
                          onChange={(e) =>
                            patchTrigger(t.id, {
                              healMode: e.target.value as WeaponTrigger['healMode'],
                            })
                          }
                        >
                          <option value="hitPoints">Restore Hit Points (self)</option>
                          <option value="temporary">Grant Temporary HP (self)</option>
                        </select>
                      </label>
                    )}
                  </div>

                  {/* Condition / Save */}
                  <div className="see-grid">
                    <label className="see-field">
                      Apply Condition Label
                      <input
                        value={t.effect?.conditionLabel ?? ''}
                        placeholder="e.g. Prone, Frightened, Poisoned"
                        onChange={(e) =>
                          patchTriggerEffect(t.id, { conditionLabel: e.target.value || undefined })
                        }
                      />
                    </label>
                    <label className="see-field">
                      Effect Target
                      <select
                        value={t.effect?.target ?? 'affected'}
                        onChange={(e) =>
                          patchTriggerEffect(t.id, {
                            target: e.target.value as SpellCustomEffect['target'],
                          })
                        }
                      >
                        <option value="affected">Target Hit</option>
                        <option value="self">Wielder (Self)</option>
                      </select>
                    </label>
                    <label className="see-field">
                      Save Required
                      <select
                        value={t.effectSave ?? ''}
                        onChange={(e) =>
                          patchTrigger(t.id, {
                            effectSave: (e.target.value || undefined) as WeaponTrigger['effectSave'],
                          })
                        }
                      >
                        <option value="">Automatic (no save)</option>
                        {SAVE_ABILITIES.map((ab) => (
                          <option key={ab} value={ab}>
                            {ab} Save
                          </option>
                        ))}
                      </select>
                    </label>
                    {t.effectSave && (
                      <label className="see-field">
                        Save DC
                        <NumberInput
                          min={1}
                          max={35}
                          value={t.effectDc ?? 13}
                          onValueChange={(v) => patchTrigger(t.id, { effectDc: v ?? 13 })}
                        />
                      </label>
                    )}
                    <label className="see-field">
                      Duration (rounds)
                      <NumberInput
                        allowEmpty
                        min={1}
                        max={100}
                        placeholder="e.g. 1"
                        value={t.effect?.durationRounds}
                        onValueChange={(v) => patchTriggerEffect(t.id, { durationRounds: v })}
                      />
                    </label>
                    <label className="see-field">
                      Effect Aura
                      <select
                        value={t.effect?.aura ?? ''}
                        onChange={(e) =>
                          patchTriggerEffect(t.id, {
                            aura: (e.target.value || undefined) as SpellCustomEffect['aura'],
                          })
                        }
                      >
                        <option value="">Auto</option>
                        <option value="red">Red</option>
                        <option value="blue">Blue</option>
                        <option value="green">Green</option>
                      </select>
                    </label>
                  </div>

                  {/* Free Spell Cast */}
                  <div
                    style={{
                      borderTop: '1px solid rgba(255,255,255,0.08)',
                      paddingTop: 8,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 8,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <strong style={{ fontSize: 12 }}>Cast Spell on Trigger (free · never uses slots):</strong>
                      {t.castSpell?.spellName ? (
                        <>
                          <span className="see-chip on">✨ {t.castSpell.spellName}</span>
                          {resolvedSpell && (
                            <span className="muted" style={{ fontSize: 11 }}>
                              {t.castSpell.castMode === 'prompt' ||
                              (!t.castSpell.castMode && !spellAutoCast)
                                ? '🎯 Prompts caster to aim/place (no slot)'
                                : '⚡ Auto-casts immediately (no slot)'}
                            </span>
                          )}
                          <button
                            type="button"
                            className="btn tiny"
                            onClick={() => patchTrigger(t.id, { castSpell: undefined })}
                          >
                            Clear Spell
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="btn tiny"
                          onClick={() => setActiveSpellPicker(pickerOpen ? null : t.id)}
                        >
                          {pickerOpen ? 'Close Spell Picker' : '🔍 Choose Spell…'}
                        </button>
                      )}
                    </div>

                    {(pickerOpen || t.castSpell?.spellName) && (
                      <>
                        {pickerOpen && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                              <input
                                autoFocus
                                style={{ flex: '1 1 220px' }}
                                placeholder="Search SRD spells (e.g. Fireball, Guiding Bolt, Healing Word)…"
                                value={spellQueryByTrigger[t.id] ?? ''}
                                onChange={(e) =>
                                  setSpellQueryByTrigger((prev) => ({
                                    ...prev,
                                    [t.id]: e.target.value,
                                  }))
                                }
                              />
                              <button
                                type="button"
                                className="btn tiny"
                                onClick={() => setActiveSpellPicker(null)}
                              >
                                Done
                              </button>
                            </div>
                            {sheetSpellOptions.length > 0 && (
                              <div className="see-chips">
                                <span className="muted" style={{ fontSize: 11, alignSelf: 'center' }}>
                                  On Sheet:
                                </span>
                                {sheetSpellOptions.slice(0, 8).map((ab) => (
                                  <button
                                    key={ab.id}
                                    type="button"
                                    className="see-chip"
                                    onClick={() => {
                                      patchTrigger(t.id, {
                                        castSpell: {
                                          spellName: ab.name,
                                          abilityId: ab.id,
                                          castLevel: ab.level ?? 1,
                                        },
                                      });
                                      setActiveSpellPicker(null);
                                    }}
                                  >
                                    {ab.name}
                                  </button>
                                ))}
                              </div>
                            )}
                            {spellSearchResults.length > 0 && (
                              <div className="item-picker" style={{ maxHeight: 150, overflow: 'auto' }}>
                                {spellSearchResults.slice(0, 12).map((sp) => (
                                  <button
                                    key={sp.id || sp.name}
                                    type="button"
                                    className="suggest-row"
                                    onClick={() => {
                                      patchTrigger(t.id, {
                                        castSpell: {
                                          spellName: sp.name,
                                          castLevel: sp.level ?? 1,
                                        },
                                      });
                                      setActiveSpellPicker(null);
                                    }}
                                  >
                                    {sp.name}
                                    <span className="muted">
                                      {sp.level === 0 ? 'Cantrip' : `Level ${sp.level}`}
                                      {sp.school ? ` · ${sp.school}` : ''}
                                    </span>
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        )}

                        {t.castSpell?.spellName && (
                          <div className="see-grid">
                            <label className="see-field">
                              Spell Name
                              <div style={{ display: 'flex', gap: 4 }}>
                                <input
                                  value={t.castSpell.spellName}
                                  onChange={(e) =>
                                    patchTriggerSpell(t.id, {
                                      spellName: e.target.value,
                                      abilityId: undefined,
                                    })
                                  }
                                />
                                <button
                                  type="button"
                                  className="btn tiny"
                                  onClick={() => setActiveSpellPicker(pickerOpen ? null : t.id)}
                                >
                                  Pick
                                </button>
                              </div>
                            </label>
                            <label className="see-field">
                              Cast Level
                              <NumberInput
                                min={0}
                                max={9}
                                value={t.castSpell.castLevel ?? resolvedSpell?.level ?? 1}
                                onValueChange={(v) => patchTriggerSpell(t.id, { castLevel: v })}
                              />
                            </label>
                            <label className="see-field">
                              Spell Target
                              <select
                                value={t.castSpell.targetMode ?? 'target'}
                                onChange={(e) =>
                                  patchTriggerSpell(t.id, {
                                    targetMode: e.target.value as 'target' | 'self',
                                  })
                                }
                              >
                                <option value="target">Attacked Target</option>
                                <option value="self">Attacker (Self)</option>
                              </select>
                            </label>
                            <label className="see-field">
                              Cast Delivery
                              <select
                                value={t.castSpell.castMode ?? ''}
                                onChange={(e) =>
                                  patchTriggerSpell(t.id, {
                                    castMode: (e.target.value || undefined) as 'auto' | 'prompt' | undefined,
                                  })
                                }
                              >
                                <option value="">Auto-detect (auto if simple, prompt if AoE)</option>
                                <option value="auto">Force immediate auto-cast</option>
                                <option value="prompt">Always show 1-click prompt</option>
                              </select>
                            </label>
                            <label className="see-field">
                              DC Override (optional)
                              <NumberInput
                                allowEmpty
                                min={1}
                                max={35}
                                placeholder="caster DC"
                                value={t.castSpell.dcOverride}
                                onValueChange={(v) => patchTriggerSpell(t.id, { dcOverride: v })}
                              />
                            </label>
                            {dmgChoices.length > 0 && (
                              <label className="see-field">
                                Damage Element
                                <select
                                  value={t.castSpell.damageType ?? ''}
                                  onChange={(e) =>
                                    patchTriggerSpell(t.id, {
                                      damageType: e.target.value || undefined,
                                    })
                                  }
                                >
                                  <option value="">Prompt / Choose on cast</option>
                                  {dmgChoices.map((dt) => (
                                    <option key={dt} value={dt}>
                                      {dt}
                                    </option>
                                  ))}
                                </select>
                              </label>
                            )}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </section>
        </div>

        <div className="see-footer">
          <div className="see-actions" style={{ width: '100%', justifyContent: 'flex-end' }}>
            <div className="see-actions-right">
              <button type="button" className="btn tiny" onClick={onClose}>
                Cancel
              </button>
              <button type="button" className="btn tiny on" onClick={handleSave}>
                💾 Save Weapon Rules
              </button>
            </div>
          </div>
        </div>
      </div>
    </dialog>,
    document.body,
  );
}
