import {advancedSpell} from '../../../shared/advancedSpells';
import {tokenDistanceFt} from '../../../shared/distance';
import {partySpell} from '../../../shared/partySpells';
import { inferAbilityActionCost } from '../../../shared/spellPrep';
import { evaluateWeaponRange } from '../../../shared/weaponRange';
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  Character,
  Monster,
  StateSnapshot,
  Token,
  TokenKind,
} from '../../../shared/types';
import { targetLists, targetLabel, previewAttackAdvantage } from '../lib/targets';
import {ShowDeadTargets, ShowHealEnemies} from './ShowDeadTargets';
import { useWeaponAttackOptions } from '../lib/useWeaponAttackOptions';
import { useStore } from '../state/socket';
import { AbilityButtons } from './AbilityButtons';
import { AbilityToggles, hasToggle } from './AbilityToggles';
import { AdvantageToggle } from './AdvantageToggle';
import { CharacterResources } from './CharacterResources';
import { DeathSaves } from './DeathSaves';
import { WeaponButtons } from './WeaponButtons';
import { effectiveSheetAbility, isCanonicalHasteProfile } from '../../../shared/spellExecution';
import { spellCombatSupport } from '../../../shared/spellSupport';
import { spellSlotOptions, selectSpellSlot, type SpellSlotPool } from '../../../shared/spellSlotPools';
import { confirmConcentration, spellBaseLevel, upcastable, isCastSpell } from '../lib/spellcasting';
import {SpellCastControl} from './SpellCastControl';

import { activeHasteCondition, spellActionBlock, spellActionBlockMessage } from '../../../shared/spellBuffs';
import {ActiveSpellActions} from './ActiveSpellActions';
import { HasteExtraAction } from './HasteExtraAction';

/**
 * The right panel's unified "Combat" section: ONE target dropdown plus every
 * rollable action the attacker has against it — weapon attacks (with the
 * off-hand / versatile-2H toggles; the server resolves to-hit vs the target's
 * AC and auto-applies damage) and rollable abilities (attack/save/damage fire
 * at the target; heals pick an ally, self default). This replaces the old
 * standalone Attacks section — the Spells & Abilities section stays for
 * editing/preparing and points its rolls here (`rollsElsewhere`).
 * `defaultTargetId` pre-selects the target (the token a player clicked);
 * players can't target friendly creatures (`validTargets`).
 */
export function CombatSection({
  snapshot,
  attacker,
  caster,
  kind,
  defaultTargetId,
  compactPlayer = false,
}: {
  snapshot: StateSnapshot;
  attacker: Token;
  /** The attacking entity (the attacker token's PC or creature). */
  caster: Character | Monster;
  kind: TokenKind;
  defaultTargetId?: string;
  /** Presentation only; all rolling, targeting and resource actions are shared. */
  compactPlayer?: boolean;
}) {
  const combatAttack = useStore((s) => s.combatAttack);
  const mapTargetPick = useStore((s) => s.mapTargetPick);
  const setMapTargetPick = useStore((s) => s.setMapTargetPick);
  const lastActionUsed = useStore((s) => s.lastActionUsed);
  const [hoveredWeaponIdx, setHoveredWeaponIdx] = useState<number | null>(null);
  const [hasteAttackArmed, setHasteAttackArmed] = useState(false);
  const haste = activeHasteCondition(caster);
  const ownTurn = snapshot.activeTurnTokenId === attacker.id;
  const actionBlock = spellActionBlock(caster);
  useEffect(() => {
    if (!haste || haste.combatEffect?.hasteActionUsed || !ownTurn) setHasteAttackArmed(false);
  }, [haste?.id, haste?.combatEffect?.hasteActionUsed, ownTurn, caster.id]);

  // Soft Turn Economy Pips: reset each initiative turn, auto-mark on ownTurn rolls,
  // and allow click-to-toggle without ever hard-locking buttons.
  const turnEconomyKey = `${snapshot.round}:${snapshot.activeTurnTokenId ?? ''}:${attacker.id}`;
  const [economyState, setEconomyState] = useState<{
    key: string;
    action: boolean;
    bonus: boolean;
    reactionOverride?: boolean;
  }>({ key: turnEconomyKey, action: false, bonus: false });
  useEffect(() => {
    setEconomyState((prev) =>
      prev.key === turnEconomyKey ? prev : { key: turnEconomyKey, action: false, bonus: false },
    );
  }, [turnEconomyKey]);
  const seenActionNonce = useRef(lastActionUsed?.n ?? 0);
  useEffect(() => {
    if (!lastActionUsed || lastActionUsed.n === seenActionNonce.current) return;
    seenActionNonce.current = lastActionUsed.n;
    if (lastActionUsed.refId !== attacker.refId || snapshot.round <= 0) return;
    if (lastActionUsed.cost === 'reaction') {
      setEconomyState((prev) => ({ ...prev, key: turnEconomyKey, reactionOverride: true }));
    } else if (ownTurn && lastActionUsed.cost === 'action') {
      setEconomyState((prev) => ({ ...prev, key: turnEconomyKey, action: true }));
    } else if (ownTurn && lastActionUsed.cost === 'bonus') {
      setEconomyState((prev) => ({ ...prev, key: turnEconomyKey, bonus: true }));
    }
  }, [lastActionUsed, attacker.refId, snapshot.round, ownTurn, turnEconomyKey]);
  const serverReactionSpent = caster.conditions.some((c) =>
    /^(reaction spent|riposte spent)$/i.test(c.label.trim()),
  );
  const actionSpent = economyState.key === turnEconomyKey ? economyState.action : false;
  const bonusSpent = economyState.key === turnEconomyKey ? economyState.bonus : false;
  const reactionSpent =
    economyState.key === turnEconomyKey && economyState.reactionOverride !== undefined
      ? economyState.reactionOverride
      : serverReactionSpent;

  // Advantage/disadvantage is the attacking creature's shared per-entity toggle
  // (set in the skills panel for a PC, or the creature panel for a monster);
  // we just consume it when an attack fires.
  const consumeAdvantage = useStore((s) => s.consumeAdvantage);
  // …and show it right here, big, so it's obvious BEFORE you click an attack
  // (it used to live only in the skills/dice panels, nowhere near the buttons).
  const armedAdv = useStore((s) => s.manualAdvantage[attacker.refId]);
  const summonCast = useStore((s) => s.summonCast);
  const summonMap = useStore((s) => s.snapshot?.map);
  const notify = useStore((s) => s.notify);
  const weapons = caster.weapons;
  const abilities = caster.sheetAbilities.filter((a) => partySpell(a)!=='shield' && advancedSpell(a)!=='counterspell' && !effectiveSheetAbility(a).summon && (!!effectiveSheetAbility(a).roll || spellCombatSupport(a)?.manualCastOnly));
  const [summonLevels, setSummonLevels] = useState<Record<string, number>>({});
  const [summonPools, setSummonPools] = useState<Record<string, SpellSlotPool>>({});
  const summonLevel = (a: (typeof caster.sheetAbilities)[number]) => summonLevels[a.id] ?? spellBaseLevel(a);
  // Summon-tagged spells/abilities get a ✋ Summon button right here in the console.
  const summonAbilities = caster.sheetAbilities.filter(a=>!spellCombatSupport(a)?.manualCastOnly).map(a=>effectiveSheetAbility(a)).filter((a) => a.summon);
  const castSummon = async (a: (typeof summonAbilities)[number]) => {
    if (!summonMap) {
      notify('No active map to summon onto.');
      return;
    }
    if (!await confirmConcentration(caster, a)) return;
    const g = summonMap.gridSizePx || 50;
    const spectral=a.name.toLowerCase()==='spiritual weapon';
    const anchor=spectral?snapshot.tokens.find(t=>t.id===effectiveTargetId)??attacker:undefined;
    const reachPx=5*g/(summonMap.feetPerSquare||5);
    summonCast({
      kind,
      refId: caster.id,
      abilityId: a.id,
      mapId: summonMap.id,
      x: anchor?anchor.x-reachPx:g * 2 + Math.random() * g * 2,
      y: anchor?anchor.y:g * 2 + Math.random() * g * 2,
      castLevel: upcastable(a) ? summonLevel(a) : undefined,
      slotPool: 'spellSlots' in caster ? summonPools[a.id] ?? selectSpellSlot(caster, summonLevel(a))?.pool : undefined,
    });
    if (ownTurn && snapshot.round > 0) {
      const cost = inferAbilityActionCost(a);
      if (cost === 'bonus') setEconomyState((prev) => ({ ...prev, key: turnEconomyKey, bonus: true }));
      else if (cost === 'action') setEconomyState((prev) => ({ ...prev, key: turnEconomyKey, action: true }));
    }
    notify(spectral?'Spiritual Weapon requested beside the selected target. Use its active spell attack; on later turns drag it up to 20 ft.':`Summon requested — drag ${a.summon?.name?.trim() || a.name} into place after it appears.`);
  };

  const showDead = useStore(s => s.showDeadTargets);
  const showHealEnemies = useStore(s => s.showHealEnemies);
  const {attack:targets,heal:healList}=useMemo(()=>targetLists(snapshot,attacker,showDead,showHealEnemies),[snapshot,attacker,showDead,showHealEnemies]);
  const validDefault =
    defaultTargetId && targets.some((t) => t.id === defaultTargetId)
      ? defaultTargetId
      : undefined;
  const [targetId, setTargetId] = useState(validDefault ?? '');
  const validAllyDefault =
    defaultTargetId && defaultTargetId !== attacker.id && healList.some((t) => t.id === defaultTargetId)
      ? defaultTargetId
      : undefined;
  const [lineSource, setLineSource] = useState<'attack' | 'ally' | 'heal' | 'buff'>(
    validAllyDefault && !validDefault ? 'ally' : 'attack',
  );
  useEffect(() => {
    setTargetId(validDefault ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attacker.id]);
  const { offhand, twoHanded, toggleOption } = useWeaponAttackOptions(attacker);

  // Heals pick from allies instead (self first = default) and apply on cast.
  const hasHeal = abilities.some((a) => effectiveSheetAbility(a).roll?.kind === 'heal');
  const [healTargetId, setHealTargetId] = useState(validAllyDefault ?? healList[0]?.id ?? '');
  const buffList = healList.filter(token => token.mapId === attacker.mapId && !token.sharedSightOnly && !token.partiallyRevealed);
  const hasHasteSpell = abilities.some(isCanonicalHasteProfile);
  const [buffTargetId, setBuffTargetId] = useState(validAllyDefault ?? attacker.id);

  // Pre-select the clicked token as the target when it changes.
  useEffect(() => {
    if (validDefault) {
      setTargetId(validDefault);
      setLineSource('attack');
    } else if (validAllyDefault) {
      setHealTargetId(validAllyDefault);
      if (buffList.some((t) => t.id === validAllyDefault)) setBuffTargetId(validAllyDefault);
      setLineSource('ally');
    } else {
      setLineSource('attack');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [validDefault, validAllyDefault]);

  // Right-clicking, Alt+Clicking, or using the 🎯 crosshair button on a token aims
  // the matching dropdown at it. Only CHANGES count (the nonce ref).
  const combatTarget = useStore((s) => s.combatTarget);
  const seenTargetNonce = useRef(combatTarget?.n ?? 0);
  useEffect(() => {
    if (!combatTarget || combatTarget.n === seenTargetNonce.current) return;
    seenTargetNonce.current = combatTarget.n;
    if (combatTarget.mode === 'heal') {
      if (healList.some((t) => t.id === combatTarget.id)) {
        setHealTargetId(combatTarget.id);
        setLineSource(combatTarget.id !== attacker.id ? 'heal' : 'attack');
      }
      return;
    }
    if (combatTarget.mode === 'buff') {
      if (buffList.some((t) => t.id === combatTarget.id)) {
        setBuffTargetId(combatTarget.id);
        setLineSource(combatTarget.id !== attacker.id ? 'buff' : 'attack');
      }
      return;
    }
    if (combatTarget.mode === 'attack') {
      if (targets.some((t) => t.id === combatTarget.id)) {
        setTargetId(combatTarget.id);
        setLineSource('attack');
      }
      return;
    }
    if (targets.some((t) => t.id === combatTarget.id)) {
      setTargetId(combatTarget.id);
      setLineSource('attack');
    } else if (combatTarget.id !== attacker.id && healList.some((t) => t.id === combatTarget.id)) {
      setHealTargetId(combatTarget.id);
      if (buffList.some((t) => t.id === combatTarget.id)) setBuffTargetId(combatTarget.id);
      setLineSource('heal');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [combatTarget]);

  // The select state can hold an id no longer in the list (the target token was
  // deleted, or the DM switched maps) — a stale-but-truthy id would leave the
  // attack buttons enabled while firing at a token the server drops silently.
  // Clamp to the live list for everything that reads it.
  const nothingRollable = weapons.length === 0 && abilities.length === 0;
  const effectiveTargetId = targets.some((t) => t.id === targetId)
    ? targetId
    : targets[0]?.id ?? '';
  const rootRef = useRef<HTMLDivElement>(null);
  const showTargetLine = useStore((s) => s.showTargetLine);
  const setShowTargetLine = useStore((s) => s.setShowTargetLine);
  const setCombatPanelTarget = useStore((s) => s.setCombatPanelTarget);
  const currentHealTargetId = healList.some((t) => t.id === healTargetId) ? healTargetId : healList[0]?.id ?? '';
  const currentBuffTargetId = buffList.some((t) => t.id === buffTargetId) ? buffTargetId : buffList[0]?.id ?? '';
  const lineTargetId =
    lineSource === 'ally' && validAllyDefault
      ? validAllyDefault
      : lineSource === 'heal' && hasHeal && currentHealTargetId && currentHealTargetId !== attacker.id
        ? currentHealTargetId
        : lineSource === 'buff' && hasHasteSpell && currentBuffTargetId && currentBuffTargetId !== attacker.id
          ? currentBuffTargetId
          : effectiveTargetId;

  const selectedTargetToken = targets.find((t) => t.id === effectiveTargetId);
  const targetDistanceFt =
    selectedTargetToken && snapshot.map && selectedTargetToken.mapId === attacker.mapId
      ? tokenDistanceFt(attacker, selectedTargetToken, snapshot.map)
      : undefined;

  const tetherRangeMeta = useMemo(() => {
    if (!lineTargetId || lineTargetId === attacker.id || !snapshot.map) return { midLabel: undefined, outOfRange: false };
    const lineTok = snapshot.tokens.find((t) => t.id === lineTargetId && t.mapId === attacker.mapId);
    if (!lineTok) return { midLabel: undefined, outOfRange: false };
    const dist = tokenDistanceFt(attacker, lineTok, snapshot.map);
    const rounded = `${Math.round(dist)} ft`;
    if (lineTargetId === effectiveTargetId) {
      const hoveredWeapon = hoveredWeaponIdx !== null ? weapons[hoveredWeaponIdx] : undefined;
      if (hoveredWeapon) {
        const ev = evaluateWeaponRange(hoveredWeapon, dist);
        return { midLabel: ev.pillText, outOfRange: ev.status === 'out' };
      }
      if (weapons.length > 0 && abilities.length === 0) {
        const evals = weapons.map((w) => evaluateWeaponRange(w, dist));
        if (evals.every((e) => e.status === 'out')) {
          return { midLabel: `${rounded} · Out`, outOfRange: true };
        }
        if (evals.every((e) => e.status !== 'normal') && evals.some((e) => e.status === 'long')) {
          return { midLabel: `${rounded} · Long`, outOfRange: false };
        }
      }
    }
    return { midLabel: rounded, outOfRange: false };
  }, [lineTargetId, attacker, snapshot.map, snapshot.tokens, effectiveTargetId, hoveredWeaponIdx, weapons, abilities.length]);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) {
      setCombatPanelTarget(null);
      return;
    }
    const sync = () => {
      const hiddenAncestor = el.closest('[hidden]');
      if (!hiddenAncestor && !nothingRollable && lineTargetId && lineTargetId !== attacker.id) {
        setCombatPanelTarget({
          attackerTokenId: attacker.id,
          targetTokenId: lineTargetId,
          midLabel: tetherRangeMeta.midLabel,
          outOfRange: tetherRangeMeta.outOfRange,
        });
      } else {
        setCombatPanelTarget(null);
      }
    };
    sync();
    const dockWindow = el.closest('[data-dock-window]') ?? el.parentElement;
    if (!dockWindow) return () => setCombatPanelTarget(null);
    const obs = new MutationObserver(sync);
    obs.observe(dockWindow, { attributes: true, subtree: true, attributeFilter: ['hidden', 'class'] });
    return () => {
      obs.disconnect();
      setCombatPanelTarget(null);
    };
  }, [attacker.id, lineTargetId, nothingRollable, setCombatPanelTarget, tetherRangeMeta.midLabel, tetherRangeMeta.outOfRange]);

  const anyToggle = caster.sheetAbilities.some(hasToggle);
  const isPc = 'resources' in caster;
  if (nothingRollable && !anyToggle && !isPc && summonAbilities.length === 0)
    return <><HasteExtraAction caster={caster} kind={kind} ownTurn={ownTurn} attackArmed={hasteAttackArmed} onArmAttack={setHasteAttackArmed} /><p className="muted">No attacks or rollable abilities.</p></>;

  const effectiveHealId = healList.some((t) => t.id === healTargetId)
    ? healTargetId
    : healList[0]?.id ?? '';
  const effectiveBuffId = buffList.some(token => token.id === buffTargetId) ? buffTargetId : buffList[0]?.id ?? '';
  const previewWeapon =
    hoveredWeaponIdx !== null
      ? weapons[hoveredWeaponIdx]
      : weapons.length === 1 && abilities.length === 0
        ? weapons[0]
        : undefined;
  const advPreview = previewAttackAdvantage(snapshot, attacker, selectedTargetToken, armedAdv, previewWeapon);

  // A 2H toggle only matters when some weapon is versatile (has 2H damage).
  const anyVersatile = weapons.some(
    (w) =>
      w.versatileDamage?.trim() ||
      (w.tags ?? []).some((t) => t.toLowerCase() === 'versatile'),
  );

  const economyBar = snapshot.round > 0 && (
    <div className="turn-economy-bar" role="group" aria-label="Turn economy tracker">
      <button
        type="button"
        className={`economy-pip is-action${actionSpent ? ' spent' : ''}`}
        aria-pressed={actionSpent}
        title="Action — soft reminder (click to toggle; never locks buttons)"
        onClick={() => setEconomyState((prev) => ({ ...prev, key: turnEconomyKey, action: !actionSpent }))}
      >
        ● Action{actionSpent ? ' ✓' : ''}
      </button>
      <button
        type="button"
        className={`economy-pip is-bonus${bonusSpent ? ' spent' : ''}`}
        aria-pressed={bonusSpent}
        title="Bonus Action — soft reminder (click to toggle; never locks buttons)"
        onClick={() => setEconomyState((prev) => ({ ...prev, key: turnEconomyKey, bonus: !bonusSpent }))}
      >
        ⚡ Bonus{bonusSpent ? ' ✓' : ''}
      </button>
      <button
        type="button"
        className={`economy-pip is-reaction${reactionSpent ? ' spent' : ''}`}
        aria-pressed={reactionSpent}
        title="Reaction — soft reminder (click to toggle; never locks buttons)"
        onClick={() => setEconomyState((prev) => ({ ...prev, key: turnEconomyKey, reactionOverride: !reactionSpent }))}
      >
        ↩ Reaction{reactionSpent ? ' ✓' : ''}
      </button>
    </div>
  );

  const rollControls = (
    <>
      {!nothingRollable && (
        <div className="dice-row combat-target-row">
          <span className="muted spell-tag">Target</span>
          <select aria-label="Attack target" value={effectiveTargetId} onChange={(e) => { setTargetId(e.target.value); setLineSource('attack'); }}>
            {!targets.length && <option value="">No living targets</option>}
            {targets.map((t) => (
              <option key={t.id} value={t.id}>
                {targetLabel(snapshot, t, attacker)}
              </option>
            ))}
          </select>
          <button
            type="button"
            className={`btn tiny target-pick-btn${mapTargetPick === 'attack' ? ' on' : ''}`}
            aria-label="Pick attack target on map"
            aria-pressed={mapTargetPick === 'attack'}
            title="Click a creature on the map to target (or Alt+Click anytime)"
            onClick={() => setMapTargetPick(mapTargetPick === 'attack' ? null : 'attack')}
          >
            🎯
          </button>
          <ShowDeadTargets/>
          <label
            className="muted spell-tag"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
            title="Show animated targeting tether to the selected target"
          >
            <input
              type="checkbox"
              checked={showTargetLine}
              onChange={(e) => setShowTargetLine(e.target.checked)}
            />{' '}
            Target Line
          </label>
        </div>
      )}
      {!nothingRollable && (
        <div className="dice-row combat-adv-row">
          <span className="muted spell-tag">{compactPlayer ? 'Roll' : 'Next roll'}</span>
          <AdvantageToggle entityId={attacker.refId} size="lg" />
          {advPreview.reasons.length > 0 && (
            <span className={`${advPreview.state === 'adv' ? 'adv-up' : advPreview.state === 'dis' ? 'adv-down' : 'muted'}${compactPlayer ? ' combat-armed-note' : ''}`} role="status">
              {advPreview.reasons.length === 1 && advPreview.reasons[0] === 'manual'
                ? armedAdv === 'adv' ? 'advantage armed' : 'disadvantage armed'
                : `${advPreview.state === 'adv' ? (armedAdv === 'adv' ? 'advantage armed' : 'auto advantage') : advPreview.state === 'dis' ? (armedAdv === 'dis' ? 'disadvantage armed' : 'auto disadvantage') : 'straight (adv + dis)'}: ${advPreview.reasons.join(', ')}`}
            </span>
          )}
        </div>
      )}
    </>
  );

  const weaponButtons = (
    <WeaponButtons
      weapons={weapons}
      twoHanded={twoHanded}
      disabled={!effectiveTargetId || !!actionBlock}
      distanceFt={targetDistanceFt}
      onHoverWeapon={setHoveredWeaponIdx}
      onAttack={(i) =>
        combatAttack({
          attackerTokenId: attacker.id,
          targetTokenId: effectiveTargetId,
          weaponIndex: i,
          advantage: consumeAdvantage(attacker.refId),
          offhand: !hasteAttackArmed && offhand || undefined,
          twoHanded: twoHanded || undefined,
          hasteAction: hasteAttackArmed || undefined,
        })
      }
    />
  );

  return (
    <div ref={rootRef} className={`attack-controls${compactPlayer ? ' compact-player-combat' : ''}`}>
      {'deathSaves' in caster && <DeathSaves character={caster} editable />}
      {economyBar}
      <ActiveSpellActions caster={caster} kind={kind} ownTurn={ownTurn} targetTokenId={effectiveTargetId||undefined} />
      <HasteExtraAction caster={caster} kind={kind} ownTurn={ownTurn} attackArmed={hasteAttackArmed} onArmAttack={setHasteAttackArmed} />
      {actionBlock === 'Hold Person paralysis' && <div className="spell-action-block" role="status">
        {spellActionBlockMessage(caster, { inCombat: snapshot.round > 0 })}
        <div><button className="btn tiny" onClick={() => {
          const message = spellActionBlockMessage(caster, { inCombat: snapshot.round > 0 });
          if (message) notify(`${caster.name}: ${message}`, { durationMs: 8000 });
        }}>Why blocked?</button></div>
      </div>}
      {compactPlayer ? <div className="combat-roll-controls">{rollControls}</div> : rollControls}
      {nothingRollable && (
        <p className="muted">No attacks or rollable abilities.</p>
      )}
      {/* Damage/attack-altering toggles (Rage, masteries, maneuvers, marks). */}
      <fieldset disabled={!!actionBlock} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}><AbilityToggles
        character={caster}
        kind={kind}
        snapshot={snapshot}
        targets={targets}
        currentTargetId={effectiveTargetId || undefined}
      /></fieldset>
      {weapons.length > 0 && (
        <>
          <div className="dice-row combat-weapon-options">
            {compactPlayer && <span className="muted spell-tag">Weapons</span>}
            <button
              className={`btn tiny ${offhand ? 'on' : ''}`}
              title="Off-hand attack: drop the ability modifier from damage"
              aria-pressed={offhand}
              onClick={() => toggleOption('offhand')}
            >
              Off-hand
            </button>
            {anyVersatile && (
              <button
                className={`btn tiny ${twoHanded ? 'on' : ''}`}
                title="Two-handed: use a versatile weapon's 2H damage dice"
                aria-pressed={twoHanded}
                onClick={() => toggleOption('twoHanded')}
              >
                2H
              </button>
            )}
          </div>
          {compactPlayer ? <div className="combat-weapon-list">{weaponButtons}</div> : weaponButtons}
        </>
      )}
      {hasHeal && healList.length > 0 && (
        <div className="dice-row combat-heal-row">
          <span className="muted spell-tag">Heal target</span>
          <select
            aria-label="Heal target"
            value={effectiveHealId}
            onChange={(e) => { setHealTargetId(e.target.value); setLineSource(e.target.value !== attacker.id ? 'heal' : 'attack'); }}
          >
            {healList.map((t, i) => (
              <option key={t.id} value={t.id}>
                {targetLabel(snapshot, t, attacker)}
                {i === 0 && t.refId === caster.id ? ' (you)' : ''}
              </option>
            ))}
          </select>
          <button
            type="button"
            className={`btn tiny target-pick-btn${mapTargetPick === 'heal' ? ' on' : ''}`}
            aria-label="Pick heal target on map"
            aria-pressed={mapTargetPick === 'heal'}
            title="Click a creature on the map to heal (or Alt+Click anytime)"
            onClick={() => setMapTargetPick(mapTargetPick === 'heal' ? null : 'heal')}
          >
            🎯
          </button>
          <ShowHealEnemies />
        </div>
      )}
      {hasHasteSpell && buffList.length > 0 && <div className="dice-row combat-buff-target">
        <span className="muted spell-tag">Buff target</span>
        <select aria-label="Buff target" value={effectiveBuffId} onChange={event => { setBuffTargetId(event.target.value); setLineSource(event.target.value !== attacker.id ? 'buff' : 'attack'); }}>
          {buffList.map(token => <option key={token.id} value={token.id}>{targetLabel(snapshot, token, attacker)}{token.id === attacker.id ? ' (you)' : ''}</option>)}
        </select>
        <button
          type="button"
          className={`btn tiny target-pick-btn${mapTargetPick === 'buff' ? ' on' : ''}`}
          aria-label="Pick buff target on map"
          aria-pressed={mapTargetPick === 'buff'}
          title="Click a creature on the map to buff"
          onClick={() => setMapTargetPick(mapTargetPick === 'buff' ? null : 'buff')}
        >
          🎯
        </button>
      </div>}
      <AbilityButtons
        abilities={abilities}
        kind={kind}
        caster={caster}
        targetTokenId={effectiveTargetId || undefined}
        healTargetId={effectiveHealId || undefined}
        buffTargetId={effectiveBuffId}
      />
      {summonAbilities.length > 0 && (
        <div className="combat-summon-row">
          {summonAbilities.map((a) => isCastSpell(a)?<div key={a.id} className="combat-ability-row is-spell"><SpellCastControl ability={a} caster={caster} kind={kind}/></div>:<div key={a.id} className={`combat-ability-row is-spell${upcastable(a) ? ' has-options' : ''}`}>
            <button
              className="btn tiny attack-row spell-attack-btn"
              disabled={!!actionBlock}
              title={`Summon ${a.summon?.name?.trim() || a.name}${(a.level ?? 0) >= 1 ? ' (spends a spell slot)' : ''}`}
              onClick={() => castSummon(a)}
            >
              {a.summon?.icon || '✋'} Summon {a.summon?.name?.trim() || a.name}
            </button>

            {upcastable(a) && <><span className="combat-ability-options-tag" aria-hidden="true">↳ Slot</span><select aria-label={`${a.name} summon level`} className="spell-level" value={summonLevel(a)} onChange={event => setSummonLevels(values => ({ ...values, [a.id]: Number(event.target.value) }))}>
              {Array.from({ length: 10 - spellBaseLevel(a) }, (_, index) => spellBaseLevel(a) + index).map(level => <option key={level} value={level}>L{level}</option>)}
            </select></>}
            {'spellSlots' in caster && upcastable(a) && Object.keys(caster.spellSlots).some(key => /^P[1-5]$/.test(key)) && <select aria-label={`${a.name} summon slot pool`} value={summonPools[a.id] ?? selectSpellSlot(caster, summonLevel(a))?.pool ?? 'spellcasting'} onChange={event => {
              const pool = event.target.value as SpellSlotPool;
              setSummonPools(values => ({ ...values, [a.id]: pool }));
              const slot = spellSlotOptions(caster, spellBaseLevel(a)).find(option => option.pool === pool && option.remaining > 0);
              if (slot) setSummonLevels(values => ({ ...values, [a.id]: slot.level }));
            }}><option value="spellcasting">Spellcasting</option><option value="pact">Pact Magic</option></select>}
          </div>)}
        </div>
      )}
      {/* The compact player HUD already owns the editable resource rack.
          Keep the original resource controls in the unchanged DM console. */}
      {'resources' in caster && !compactPlayer && (
        <CharacterResources character={caster} editable compact />
      )}
    </div>
  );
}
