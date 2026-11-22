import { useState } from 'react';
import { DAMAGE_TYPES } from '../../../shared/damage';
import { formatDiceRulesSummary, hasActiveDiceRules } from '../../../shared/diceRules';
import type {
  DiceRulesSpec,
  ExplodingDiceRule,
  MatchingDiceRule,
  MinFaceDiceRule,
  RerollDiceRule,
  SpellCustomEffect,
} from '../../../shared/types';
import { NumberInput } from './NumberInput';

const SAVE_ABILITIES = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'] as const;

type Props = {
  value?: DiceRulesSpec;
  onChange: (next: DiceRulesSpec | undefined) => void;
  context: 'spell' | 'weapon';
  showCrit?: boolean;
  defaultDamageType?: string;
  defaultExpanded?: boolean;
};

type CapMode = 'castingMod' | 'proficiency' | 'number' | 'unlimited';

function capModeFor(val: 'castingMod' | 'proficiency' | number | undefined): CapMode {
  if (val === 'castingMod') return 'castingMod';
  if (val === 'proficiency') return 'proficiency';
  if (typeof val === 'number') return 'number';
  return 'unlimited';
}

export function DiceRulesEditor({
  value,
  onChange,
  context,
  showCrit = false,
  defaultDamageType,
  defaultExpanded = false,
}: Props) {
  const active = hasActiveDiceRules(value);
  const [open, setOpen] = useState(() => defaultExpanded || active);
  const rules: DiceRulesSpec = value ?? {};
  const summary = formatDiceRulesSummary(value);

  const update = (patch: Partial<DiceRulesSpec>) => {
    const next: DiceRulesSpec = { ...rules, ...patch };
    onChange(next);
  };

  const setExploding = (exploding: ExplodingDiceRule | undefined) => update({ exploding });
  const setReroll = (reroll: RerollDiceRule | undefined) => update({ reroll });
  const setMinFace = (minFace: MinFaceDiceRule | undefined) => update({ minFace });
  const setMatching = (matchingDice: MatchingDiceRule | undefined) => update({ matchingDice });

  const patchMatchingEffect = (patch: Partial<SpellCustomEffect>) => {
    const cur = rules.matchingDice ?? { action: 'effect' as const, minMatches: 2 };
    setMatching({
      ...cur,
      effect: { ...(cur.effect ?? {}), ...patch },
    });
  };

  const applyPreset = (preset: string) => {
    if (preset === 'clear') {
      onChange(undefined);
      return;
    }
    setOpen(true);
    if (preset === 'sorcerous-burst') {
      update({
        exploding: {
          on: 'max',
          limit: 'castingMod',
          recursive: true,
          label: 'Sorcerous Burst',
        },
      });
    } else if (preset === 'chromatic-orb') {
      update({
        matchingDice: {
          minMatches: 2,
          action: 'leap',
          leapRangeFt: 30,
          maxLeaps: 'slotLevel',
          label: 'Orb Bounce',
        },
      });
    } else if (preset === 'elemental-adept') {
      update({
        minFace: {
          value: 2,
          ...(defaultDamageType ? { damageType: defaultDamageType } : {}),
          label: 'Elemental Adept',
        },
      });
    } else if (preset === 'empowered') {
      update({
        reroll: {
          mode: 'die-lte',
          maxFace: 2,
          keep: 'new',
          maxDice: 'castingMod',
          label: 'Empowered Spell',
        },
      });
    } else if (preset === 'vicious') {
      update({
        extraCritDice: '2d6',
        extraCritDamageType: defaultDamageType || undefined,
        extraCritLabel: 'Vicious Weapon',
      });
    } else if (preset === 'brutal') {
      update({
        extraCritWeaponDice: 1,
        extraCritLabel: 'Brutal Strike',
      });
    } else if (preset === 'gwf') {
      update({
        minFace: {
          value: 3,
          label: 'Great Weapon Fighting',
        },
      });
    } else if (preset === 'exploding-weapon') {
      update({
        exploding: {
          on: 'max',
          limit: 4,
          recursive: true,
          label: 'Exploding Die',
        },
      });
    }
  };

  const exploding = rules.exploding;
  const reroll = rules.reroll;
  const minFace = rules.minFace;
  const matching = rules.matchingDice;
  const hasCritSection =
    showCrit ||
    Boolean(rules.extraCritWeaponDice || rules.extraCritDice?.trim());

  const expCapMode = exploding ? capModeFor(exploding.limit) : 'castingMod';
  const rerollCapMode = reroll ? capModeFor(reroll.maxDice) : 'unlimited';
  const leapCapMode = matching?.maxLeaps === 'slotLevel' || matching?.maxLeaps === undefined ? 'slotLevel' : 'number';

  return (
    <section className="see-section" aria-label="Dice Roll Rules and Triggers">
      <div className="see-section-title">
        <button
          type="button"
          className="btn tiny"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          style={{ textTransform: 'none', letterSpacing: 0 }}
        >
          {open ? '▾' : '▸'} Dice Roll Rules &amp; Triggers
        </button>
        {summary.length > 0 ? (
          <div className="see-chips" style={{ flex: 1 }}>
            {summary.map((chip) => (
              <span key={chip} className="see-chip on" style={{ cursor: 'default' }}>
                {chip}
              </span>
            ))}
          </div>
        ) : (
          <span style={{ fontWeight: 400, textTransform: 'none', color: 'var(--muted)' }}>
            Exploding dice, reroll low faces, floors, matching-die triggers
          </span>
        )}
      </div>

      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="see-chips" aria-label="Dice rule presets">
            <span className="muted" style={{ fontSize: 11, alignSelf: 'center', marginRight: 4 }}>
              Presets:
            </span>
            {context === 'spell' ? (
              <>
                <button type="button" className="see-chip" onClick={() => applyPreset('sorcerous-burst')}>
                  ✨ Sorcerous Burst (Explode)
                </button>
                <button type="button" className="see-chip" onClick={() => applyPreset('chromatic-orb')}>
                  🔮 Chromatic Orb (Match Bounce)
                </button>
                <button type="button" className="see-chip" onClick={() => applyPreset('elemental-adept')}>
                  🛡 Min Die 2 (Elemental Adept)
                </button>
                <button type="button" className="see-chip" onClick={() => applyPreset('empowered')}>
                  ♻ Reroll 1–2s (Empowered)
                </button>
              </>
            ) : (
              <>
                <button type="button" className="see-chip" onClick={() => applyPreset('vicious')}>
                  💥 Vicious (+2d6 crit)
                </button>
                <button type="button" className="see-chip" onClick={() => applyPreset('brutal')}>
                  🪓 Brutal (+1 crit die)
                </button>
                <button type="button" className="see-chip" onClick={() => applyPreset('gwf')}>
                  ⚖ GWF Floor (1–2→3)
                </button>
                <button type="button" className="see-chip" onClick={() => applyPreset('exploding-weapon')}>
                  ✨ Exploding Max
                </button>
              </>
            )}
            {active && (
              <button type="button" className="see-chip" onClick={() => applyPreset('clear')}>
                ✕ Clear All
              </button>
            )}
          </div>

          {/* 1. Exploding Dice */}
          <div className="see-banner" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
            <div className="see-checks" style={{ justifyContent: 'space-between' }}>
              <label className="see-check">
                <input
                  type="checkbox"
                  checked={!!exploding}
                  onChange={(e) =>
                    setExploding(
                      e.target.checked
                        ? { on: 'max', limit: context === 'spell' ? 'castingMod' : 3, recursive: true }
                        : undefined,
                    )
                  }
                />
                <strong>Exploding Dice</strong>
                <span className="muted">(e.g. Sorcerous Burst — max face spawns extra die in same tray)</span>
              </label>
            </div>
            {exploding && (
              <div className="see-grid">
                <label className="see-field">
                  Explode Trigger
                  <select
                    value={exploding.on === 'max' ? 'max' : 'face'}
                    onChange={(e) =>
                      setExploding({
                        ...exploding,
                        on: e.target.value === 'max' ? 'max' : 6,
                      })
                    }
                  >
                    <option value="max">On die maximum face</option>
                    <option value="face">On specific face value…</option>
                  </select>
                </label>
                {typeof exploding.on === 'number' && (
                  <label className="see-field">
                    Trigger Face
                    <NumberInput
                      min={1}
                      max={100}
                      value={exploding.on}
                      onValueChange={(v) => setExploding({ ...exploding, on: v ?? 6 })}
                    />
                  </label>
                )}
                <label className="see-field">
                  Bonus Die (blank = match die)
                  <input
                    value={exploding.bonusDice ?? ''}
                    placeholder="same die (e.g. 1d8)"
                    onChange={(e) =>
                      setExploding({ ...exploding, bonusDice: e.target.value || undefined })
                    }
                  />
                </label>
                <label className="see-field">
                  Explosion Cap
                  <select
                    value={expCapMode}
                    onChange={(e) => {
                      const m = e.target.value as CapMode;
                      setExploding({
                        ...exploding,
                        limit: m === 'unlimited' ? undefined : m === 'number' ? 3 : m,
                      });
                    }}
                  >
                    <option value="castingMod">Spellcasting modifier (min 0)</option>
                    <option value="proficiency">Proficiency bonus</option>
                    <option value="number">Fixed cap…</option>
                    <option value="unlimited">Unlimited (safety cap 10)</option>
                  </select>
                </label>
                {expCapMode === 'number' && (
                  <label className="see-field">
                    Max Explosions
                    <NumberInput
                      min={1}
                      max={20}
                      value={typeof exploding.limit === 'number' ? exploding.limit : 3}
                      onValueChange={(v) => setExploding({ ...exploding, limit: v ?? 3 })}
                    />
                  </label>
                )}
                <label className="see-field">
                  Tray Pill Label
                  <input
                    value={exploding.label ?? ''}
                    placeholder="e.g. Sorcerous Burst"
                    onChange={(e) =>
                      setExploding({ ...exploding, label: e.target.value || undefined })
                    }
                  />
                </label>
                <label className="see-check" style={{ alignSelf: 'end', paddingBottom: 4 }}>
                  <input
                    type="checkbox"
                    checked={exploding.recursive !== false}
                    onChange={(e) => setExploding({ ...exploding, recursive: e.target.checked })}
                  />
                  Chain recursively
                </label>
              </div>
            )}
          </div>

          {/* 2. Reroll Low Dice */}
          <div className="see-banner" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
            <label className="see-check">
              <input
                type="checkbox"
                checked={!!reroll}
                onChange={(e) =>
                  setReroll(
                    e.target.checked
                      ? { mode: 'die-lte', maxFace: 2, keep: 'higher', label: 'Empowered Reroll' }
                      : undefined,
                  )
                }
              />
              <strong>Reroll Low Dice</strong>
              <span className="muted">(shows visual reroll links &amp; kept/discarded badges)</span>
            </label>
            {reroll && (
              <div className="see-grid">
                <label className="see-field">
                  Reroll Mode
                  <select
                    value={reroll.mode}
                    onChange={(e) =>
                      setReroll({ ...reroll, mode: e.target.value as RerollDiceRule['mode'] })
                    }
                  >
                    <option value="die-lte">Individual dice ≤ threshold</option>
                    <option value="full-pool">Entire damage pool (Savage style)</option>
                  </select>
                </label>
                {reroll.mode === 'die-lte' && (
                  <>
                    <label className="see-field">
                      Reroll Faces ≤
                      <NumberInput
                        min={1}
                        max={20}
                        value={reroll.maxFace ?? 2}
                        onValueChange={(v) => setReroll({ ...reroll, maxFace: v ?? 2 })}
                      />
                    </label>
                    <label className="see-field">
                      Max Dice Rerolled
                      <select
                        value={rerollCapMode}
                        onChange={(e) => {
                          const m = e.target.value as CapMode;
                          setReroll({
                            ...reroll,
                            maxDice: m === 'unlimited' ? undefined : m === 'number' ? 3 : m,
                          });
                        }}
                      >
                        <option value="unlimited">All qualifying dice</option>
                        <option value="castingMod">Spellcasting modifier</option>
                        <option value="proficiency">Proficiency bonus</option>
                        <option value="number">Fixed count…</option>
                      </select>
                    </label>
                    {rerollCapMode === 'number' && (
                      <label className="see-field">
                        Dice Cap
                        <NumberInput
                          min={1}
                          max={20}
                          value={typeof reroll.maxDice === 'number' ? reroll.maxDice : 3}
                          onValueChange={(v) => setReroll({ ...reroll, maxDice: v ?? 3 })}
                        />
                      </label>
                    )}
                  </>
                )}
                <label className="see-field">
                  Keep Policy
                  <select
                    value={reroll.keep}
                    onChange={(e) =>
                      setReroll({ ...reroll, keep: e.target.value as RerollDiceRule['keep'] })
                    }
                  >
                    <option value="higher">Keep higher result</option>
                    <option value="new">Must use new roll</option>
                  </select>
                </label>
                <label className="see-field">
                  Tray Pill Label
                  <input
                    value={reroll.label ?? ''}
                    placeholder="e.g. Empowered Spell"
                    onChange={(e) =>
                      setReroll({ ...reroll, label: e.target.value || undefined })
                    }
                  />
                </label>
              </div>
            )}
          </div>

          {/* 3. Minimum Die Floor */}
          <div className="see-banner" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
            <label className="see-check">
              <input
                type="checkbox"
                checked={!!minFace}
                onChange={(e) =>
                  setMinFace(
                    e.target.checked
                      ? { value: context === 'weapon' ? 3 : 2, label: context === 'weapon' ? 'Min Face Floor' : 'Elemental Adept' }
                      : undefined,
                  )
                }
              />
              <strong>Minimum Die Value Floor</strong>
              <span className="muted">(e.g. GWF 1–2→3 or Elemental Adept 1→2)</span>
            </label>
            {minFace && (
              <div className="see-grid">
                <label className="see-field">
                  Minimum Face
                  <NumberInput
                    min={2}
                    max={20}
                    value={minFace.value}
                    onValueChange={(v) => setMinFace({ ...minFace, value: v ?? 2 })}
                  />
                </label>
                <label className="see-field">
                  Only Damage Type
                  <select
                    value={minFace.damageType ?? ''}
                    onChange={(e) =>
                      setMinFace({ ...minFace, damageType: e.target.value || undefined })
                    }
                  >
                    <option value="">All damage dice</option>
                    {DAMAGE_TYPES.map((dt) => (
                      <option key={dt} value={dt}>
                        {dt}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="see-field">
                  Tray Pill Label
                  <input
                    value={minFace.label ?? ''}
                    placeholder="e.g. Great Weapon Fighting"
                    onChange={(e) =>
                      setMinFace({ ...minFace, label: e.target.value || undefined })
                    }
                  />
                </label>
              </div>
            )}
          </div>

          {/* 4. Matching Dice Trigger */}
          <div className="see-banner" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
            <label className="see-check">
              <input
                type="checkbox"
                checked={!!matching}
                onChange={(e) =>
                  setMatching(
                    e.target.checked
                      ? {
                          minMatches: 2,
                          action: context === 'spell' ? 'leap' : 'bonus-dice',
                          ...(context === 'spell'
                            ? { leapRangeFt: 30, maxLeaps: 'slotLevel' }
                            : { bonusDice: '1d6', bonusDamageType: defaultDamageType }),
                        }
                      : undefined,
                  )
                }
              />
              <strong>On Matching Damage Dice</strong>
              <span className="muted">(when 2+ dice roll the same number, trigger bounce, extra dice, or effect)</span>
            </label>
            {matching && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div className="see-grid">
                  <label className="see-field">
                    Min Matching Dice
                    <NumberInput
                      min={2}
                      max={10}
                      value={matching.minMatches ?? 2}
                      onValueChange={(v) => setMatching({ ...matching, minMatches: v ?? 2 })}
                    />
                  </label>
                  <label className="see-field">
                    Matching Action
                    <select
                      value={matching.action}
                      onChange={(e) => {
                        const action = e.target.value as MatchingDiceRule['action'];
                        setMatching({
                          ...matching,
                          action,
                          ...(action === 'leap' && !matching.leapRangeFt ? { leapRangeFt: 30, maxLeaps: 'slotLevel' } : {}),
                          ...(action === 'bonus-dice' && !matching.bonusDice ? { bonusDice: '1d6' } : {}),
                        });
                      }}
                    >
                      {context === 'spell' && <option value="leap">Bounce / Leap to another target</option>}
                      <option value="bonus-dice">Roll bonus damage dice in same tray</option>
                      <option value="effect">Apply condition / debuff / buff</option>
                    </select>
                  </label>
                  <label className="see-field">
                    Label
                    <input
                      value={matching.label ?? ''}
                      placeholder="e.g. Doubles Surge"
                      onChange={(e) =>
                        setMatching({ ...matching, label: e.target.value || undefined })
                      }
                    />
                  </label>
                </div>

                {matching.action === 'leap' && (
                  <div className="see-grid">
                    <label className="see-field">
                      Leap Range (ft)
                      <NumberInput
                        min={5}
                        max={300}
                        step={5}
                        value={matching.leapRangeFt ?? 30}
                        onValueChange={(v) => setMatching({ ...matching, leapRangeFt: v ?? 30 })}
                      />
                    </label>
                    <label className="see-field">
                      Max Leaps
                      <select
                        value={leapCapMode}
                        onChange={(e) =>
                          setMatching({
                            ...matching,
                            maxLeaps: e.target.value === 'slotLevel' ? 'slotLevel' : 2,
                          })
                        }
                      >
                        <option value="slotLevel">Equal to spell slot level</option>
                        <option value="number">Fixed leap count…</option>
                      </select>
                    </label>
                    {leapCapMode === 'number' && (
                      <label className="see-field">
                        Leap Count
                        <NumberInput
                          min={1}
                          max={9}
                          value={typeof matching.maxLeaps === 'number' ? matching.maxLeaps : 2}
                          onValueChange={(v) => setMatching({ ...matching, maxLeaps: v ?? 2 })}
                        />
                      </label>
                    )}
                  </div>
                )}

                {matching.action === 'bonus-dice' && (
                  <div className="see-grid">
                    <label className="see-field">
                      Bonus Damage Dice
                      <input
                        value={matching.bonusDice ?? ''}
                        placeholder="e.g. 1d8 or 2d6"
                        onChange={(e) =>
                          setMatching({ ...matching, bonusDice: e.target.value || undefined })
                        }
                      />
                    </label>
                    <label className="see-field">
                      Bonus Damage Type
                      <select
                        value={matching.bonusDamageType ?? ''}
                        onChange={(e) =>
                          setMatching({ ...matching, bonusDamageType: e.target.value || undefined })
                        }
                      >
                        <option value="">Same as attack/spell</option>
                        {DAMAGE_TYPES.map((dt) => (
                          <option key={dt} value={dt}>
                            {dt}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                )}

                {matching.action === 'effect' && (
                  <div className="see-grid">
                    <label className="see-field">
                      Condition / Effect Label
                      <input
                        value={matching.effect?.conditionLabel ?? ''}
                        placeholder="e.g. Staggered, Prone, Burning"
                        onChange={(e) => patchMatchingEffect({ conditionLabel: e.target.value || undefined })}
                      />
                    </label>
                    <label className="see-field">
                      Target
                      <select
                        value={matching.effect?.target ?? 'affected'}
                        onChange={(e) =>
                          patchMatchingEffect({ target: e.target.value as SpellCustomEffect['target'] })
                        }
                      >
                        <option value="affected">Target Hit</option>
                        <option value="self">Caster / Wielder (Self)</option>
                      </select>
                    </label>
                    <label className="see-field">
                      Save Required
                      <select
                        value={matching.effectSave ?? ''}
                        onChange={(e) =>
                          setMatching({
                            ...matching,
                            effectSave: (e.target.value || undefined) as MatchingDiceRule['effectSave'],
                          })
                        }
                      >
                        <option value="">Automatic (no save)</option>
                        {SAVE_ABILITIES.map((ab) => (
                          <option key={ab} value={ab}>
                            {ab} Save (caster DC)
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="see-field">
                      Duration (rounds)
                      <NumberInput
                        allowEmpty
                        min={1}
                        max={100}
                        placeholder="e.g. 1"
                        value={matching.effect?.durationRounds}
                        onValueChange={(v) => patchMatchingEffect({ durationRounds: v })}
                      />
                    </label>
                    <label className="see-field">
                      Aura
                      <select
                        value={matching.effect?.aura ?? ''}
                        onChange={(e) =>
                          patchMatchingEffect({
                            aura: (e.target.value || undefined) as SpellCustomEffect['aura'],
                          })
                        }
                      >
                        <option value="">Auto</option>
                        <option value="red">Red (Debuff)</option>
                        <option value="blue">Blue (Ward)</option>
                        <option value="green">Green (Buff)</option>
                      </select>
                    </label>
                    <label className="see-field">
                      Note
                      <input
                        value={matching.effect?.note ?? ''}
                        placeholder="Optional condition note"
                        onChange={(e) => patchMatchingEffect({ note: e.target.value || undefined })}
                      />
                    </label>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 5. Extra Critical Hit Dice */}
          {hasCritSection && (
            <div className="see-banner" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
              <div style={{ fontWeight: 700, fontSize: 12 }}>
                Extra Critical Hit Dice <span className="muted">(added visually to the same tray on crit)</span>
              </div>
              <div className="see-grid">
                <label className="see-field">
                  Extra Weapon Dice on Crit
                  <NumberInput
                    allowEmpty
                    min={0}
                    max={10}
                    placeholder="e.g. 1 (Brutal)"
                    value={rules.extraCritWeaponDice}
                    onValueChange={(v) => update({ extraCritWeaponDice: v })}
                  />
                </label>
                <label className="see-field">
                  Extra Custom Crit Dice
                  <input
                    value={rules.extraCritDice ?? ''}
                    placeholder="e.g. 2d6 (Vicious)"
                    onChange={(e) => update({ extraCritDice: e.target.value || undefined })}
                  />
                </label>
                <label className="see-field">
                  Extra Crit Damage Type
                  <select
                    value={rules.extraCritDamageType ?? ''}
                    onChange={(e) =>
                      update({ extraCritDamageType: e.target.value || undefined })
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
                <label className="see-field">
                  Crit Die Tray Label
                  <input
                    value={rules.extraCritLabel ?? ''}
                    placeholder="e.g. Vicious Weapon"
                    onChange={(e) => update({ extraCritLabel: e.target.value || undefined })}
                  />
                </label>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
