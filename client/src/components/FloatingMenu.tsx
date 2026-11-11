import {partySpell} from '../../../shared/partySpells';
import {tokenDistanceFt} from '../../../shared/distance';
import { AdvantageToggle } from './AdvantageToggle';
import { targetLabel, previewAttackAdvantage } from '../lib/targets';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { isHasteSpell, effectiveSheetAbility } from '../../../shared/spellExecution';
import { spellCombatSupport } from '../../../shared/spellSupport';
import type {
  Character,
  Monster,
  SheetAbility,
  StateSnapshot,
  Token,
  Weapon,
} from '../../../shared/types';
import { resolveToken } from '../lib/entities';
import { useWeaponAttackOptions } from '../lib/useWeaponAttackOptions';
import { useStore } from '../state/socket';
import { AbilityButtons } from './AbilityButtons';
import { DamageHealControls } from './DamageHealControls';
import { ObjectControls } from './ObjectControls';
import { WeaponButtons } from './WeaponButtons';
import { TokenAdminButtons } from './TokenAdminButtons';

type Props = {
  snapshot: StateSnapshot;
  token: Token;
  /** The currently-selected token — used as the attacker when attacking `token`. */
  attacker: Token | null;
  /** Screen position (clientX/clientY) where the menu was summoned. */
  x: number;
  y: number;
  onClose: () => void;
};

/**
 * Right-click / long-press action menu anchored at a token. Quick combat actions
 * (damage/heal where HP is visible) for everyone; DM gets the editing actions.
 */
export function FloatingMenu({ snapshot, token, attacker: defaultAttacker, x, y, onClose }: Props) {
  const [chosenAttacker, setChosenAttacker] = useState('');
  const [collapsed, setCollapsed] = useState(false);
  const [dockPref, setDockPref] = useState<'auto' | 'top' | 'bottom'>('auto');
  const [isMobileSheet, setIsMobileSheet] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number }>({ left: x, top: y });
  const socketId = useStore(s => s.socket?.id);
  const actors = snapshot.tokens.filter(t => !t.sharedSightOnly && !t.partiallyRevealed && t.mapId === token.mapId && (snapshot.role === 'dm' ||
    t.kind === 'pc' && snapshot.characters.some(c => c.id === t.refId && c.claimedBy === socketId) ||
    t.kind === 'monster' && snapshot.monsters.some(m => m.id === t.refId && m.disposition === 'friendly')) && !resolveToken(snapshot,t).objectKind);
  const attacker = actors.find(t => t.id === chosenAttacker) ?? defaultAttacker ?? actors.find(t => t.id === snapshot.activeTurnTokenId) ?? actors[0] ?? null;
  useLayoutEffect(() => {
    const computePosition = () => {
      const el = menuRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (!rect.width && !rect.height) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const scaleRatio = el.offsetWidth > 0 ? rect.width / el.offsetWidth : 1;
      const coarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
      const mobile = vw <= 760 || vh <= 560 || (coarse && Math.min(vw, vh) <= 640);
      setIsMobileSheet(mobile);

      const tetherDx = attacker && attacker.id !== token.id ? attacker.x - token.x : 0;
      const tetherDy = attacker && attacker.id !== token.id ? attacker.y - token.y : 0;

      let leftPx: number;
      let topPx: number;
      if (mobile) {
        const autoDock: 'top' | 'bottom' =
          y > vh * 0.54 ? 'top' : y < vh * 0.46 ? 'bottom' : tetherDy > 8 ? 'top' : 'bottom';
        const effectiveDock = dockPref === 'auto' ? autoDock : dockPref;
        leftPx = Math.max(8, Math.min(Math.round((vw - rect.width) / 2), vw - rect.width - 8));
        topPx =
          effectiveDock === 'top'
            ? 46
            : Math.max(46, vh - rect.height - 10);
      } else {
        const offset = 24;
        const preferLeft =
          (tetherDx > 20 && x - rect.width - offset >= 8) || x + offset + rect.width > vw - 8;
        const rawLeft = preferLeft ? x - rect.width - offset : x + offset;
        leftPx = Math.max(8, Math.min(rawLeft, vw - rect.width - 8));
        const rawTop = tetherDy > 20 && y - rect.height * 0.6 >= 8 ? y - rect.height * 0.5 : y - 16;
        topPx = Math.max(8, Math.min(rawTop, vh - rect.height - 8));
      }
      setPosition({
        left: Math.round(leftPx / (scaleRatio || 1)),
        top: Math.round(topPx / (scaleRatio || 1)),
      });
    };
    computePosition();
    window.addEventListener('resize', computePosition);
    return () => window.removeEventListener('resize', computePosition);
  }, [x, y, attacker?.id, attacker?.x, attacker?.y, token.id, token.x, token.y, collapsed, dockPref]);
  const applyDamage = useStore((s) => s.applyDamage);
  const setTempHp = useStore((s) => s.setTempHp);
  const combatAttack = useStore((s) => s.combatAttack);
  const consumeAdvantage = useStore((s) => s.consumeAdvantage);
  const { offhand, twoHanded, toggleOption } = useWeaponAttackOptions(attacker);
  const mySocketId = useStore((s) => s.socket?.id);
  const isDm = snapshot.role === 'dm';
  const d = resolveToken(snapshot, token);
  const canSeeHp = d.curHp !== undefined && d.maxHp !== undefined;
  // If the right-clicked token is a non-combat object, offer its interact controls.
  const targetObjectKind =
    token.kind === 'monster'
      ? snapshot.monsters.find((m) => m.id === token.refId)?.objectKind
      : undefined;

  // Attack flow: the SELECTED token is the attacker, the right-clicked `token`
  // is the target. (Select a token, then right-click another to attack it.)
  const aChar =
    attacker?.kind === 'pc'
      ? snapshot.characters.find((c) => c.id === attacker.refId)
      : undefined;
  const aMon =
    attacker?.kind === 'monster'
      ? snapshot.monsters.find((m) => m.id === attacker.refId)
      : undefined;
  const aWeapons: Weapon[] =
    (aMon as { weapons?: Weapon[] } | undefined)?.weapons ?? aChar?.weapons ?? [];
  // Mirror the server's combat:attack gate: the DM, the owner of the attacking
  // PC, or a player using a friendly creature (companion/summon).
  const friendlyAttacker =
    attacker?.kind === 'monster' &&
    (aMon as { disposition?: string } | undefined)?.disposition === 'friendly';
  const canAttackAsSelected =
    !!attacker &&
    attacker.id !== token.id &&
    aWeapons.length > 0 &&
    (isDm ||
      (attacker.kind === 'pc' && aChar?.claimedBy === mySocketId) ||
      friendlyAttacker);

  // Every rollable spell/ability/action the attacker can fire (attack/save/damage/
  // heal). Attack rolls resolve to-hit vs the right-clicked target's AC; save/damage/
  // heal just roll into the log (the "Apply damage" click-to-target flow targets them).
  // Right-clicking the caster's OWN token still offers its heals (cast on self);
  // other rollable kinds need a distinct target.
  const targetingSelf = !!attacker && attacker.id === token.id;
  const castable = (a: SheetAbility) => {
    if(partySpell(a)==='shield')return false;
    const roll = effectiveSheetAbility(a).roll;
    return !!spellCombatSupport(a)?.manualCastOnly || !!roll && (!targetingSelf || roll.kind === 'heal' || isHasteSpell(a) || ['misty step','pass without trace'].includes(partySpell(a)??''));
  };
  const pcAbilities: SheetAbility[] =
    aChar && (isDm || aChar.claimedBy === mySocketId)
      ? aChar.sheetAbilities.filter(castable)
      : [];
  // Monster abilities are DM-only (the ability:roll gate for creatures); the full
  // sheetAbilities list only rides on the DM snapshot anyway.
  const monAbilities: SheetAbility[] =
    isDm && aMon
      ? ((aMon as { sheetAbilities?: SheetAbility[] }).sheetAbilities ?? []).filter(
          castable,
        )
      : [];
  const canCastAsSelected = pcAbilities.length > 0 || monAbilities.length > 0;
  const showTargetLine = useStore((s) => s.showTargetLine);
  const setShowTargetLine = useStore((s) => s.setShowTargetLine);
  const setFloatingMenuTarget = useStore((s) => s.setFloatingMenuTarget);
  useEffect(() => {
    if ((canAttackAsSelected || canCastAsSelected) && attacker && !targetingSelf) {
      setFloatingMenuTarget({ attackerTokenId: attacker.id, targetTokenId: token.id });
    } else {
      setFloatingMenuTarget(null);
    }
    return () => setFloatingMenuTarget(null);
  }, [attacker, token.id, canAttackAsSelected, canCastAsSelected, targetingSelf, setFloatingMenuTarget]);

  // Dismiss on outside click, scroll, or Escape — but IGNORE events for a short
  // grace period after opening. On touch, lifting the finger after the
  // long-press synthesizes a pointerdown/click at the token that would otherwise
  // close the menu the instant it appears. The grace window lets "hold to open,
  // release to keep open" work; a later tap elsewhere still closes it.
  useEffect(() => {
    const openedAt = Date.now();
    const close = () => {
      if (Date.now() - openedAt < 450) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('pointerdown', close);
    window.addEventListener('wheel', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('wheel', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };

  return (
    <div
      className={`floating-menu${isMobileSheet ? ' is-mobile-sheet' : ''}${collapsed ? ' is-collapsed' : ''}`}
      ref={menuRef}
      role="dialog" aria-label="Token actions"
      style={position}
      onWheel={(e) => e.stopPropagation()}
      // Stop the menu's own pointerdown from triggering the outside-click close.
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="floating-menu-title">
        <span className="fm-title-label">
          {targetLabel(snapshot,token,attacker ?? undefined)}
        </span>
        {canSeeHp && (
          <span className="fm-hp">
            {d.curHp}/{d.maxHp}
          </span>
        )}
        <span className="fm-title-actions">
          {isMobileSheet && (
            <button
              type="button"
              className="btn tiny fm-head-btn"
              aria-label="Move token actions top or bottom"
              title="Move menu to opposite edge of screen"
              onClick={() =>
                setDockPref((prev) => {
                  const vh = window.innerHeight;
                  const tetherDy = attacker && attacker.id !== token.id ? attacker.y - token.y : 0;
                  const cur =
                    prev !== 'auto'
                      ? prev
                      : y > vh * 0.54
                        ? 'top'
                        : y < vh * 0.46
                          ? 'bottom'
                          : tetherDy > 8
                            ? 'top'
                            : 'bottom';
                  return cur === 'top' ? 'bottom' : 'top';
                })
              }
            >
              ⇅
            </button>
          )}
          <button
            type="button"
            className={`btn tiny fm-head-btn${collapsed ? ' on' : ''}`}
            aria-label={collapsed ? 'Expand token actions' : 'Minimize menu to view targeting'}
            aria-pressed={collapsed}
            title={collapsed ? 'Expand actions' : 'Peek at battlefield & targeting line'}
            onClick={() => setCollapsed((v) => !v)}
          >
            👁
          </button>
          <button
            type="button"
            className="btn tiny fm-head-btn"
            aria-label="Close token actions"
            title="Close"
            onClick={onClose}
          >
            ✕
          </button>
        </span>
      </div>

      {!collapsed && (
        <div className="floating-menu-body">
          {attacker&&attacker.id!==token.id&&d.conditions.some(c=>c.label==='Hypnotic Pattern')&&snapshot.map&&tokenDistanceFt(attacker,token,snapshot.map)<=5&&<button className="btn" onClick={()=>{useStore.getState().socket?.emit('spell:wake',{actorTokenId:attacker.id,targetTokenId:token.id});onClose();}}>Shake awake ? Action</button>}
          {!!d.conditions.length && <p className="floating-menu-note">{d.conditions.map(c => c.label).join(', ')}</p>}
          {!targetObjectKind && actors.length > 0 && <label className="floating-menu-note fm-act-as-row">
            <span>Act as</span>
            <select aria-label="Act as" value={attacker?.id ?? ''} onChange={e => setChosenAttacker(e.target.value)}>
              {actors.map(t => <option key={t.id} value={t.id}>{targetLabel(snapshot,t)}</option>)}
            </select>
          </label>}

          {/* Non-combat object: interact (toggle state, reveal/hide). */}
          {targetObjectKind && (
            <ObjectControls snapshot={snapshot} token={token} editable={isDm} />
          )}

          {/* Quick damage/heal — kept open so several can be applied in a row. */}
          {canSeeHp && (
            <DamageHealControls
              compact
              onApply={(delta) => applyDamage(token.kind, token.refId, delta)}
              onTemp={(amt) => setTempHp(token.kind, token.refId, amt)}
            />
          )}

          {(canAttackAsSelected || canCastAsSelected) && (
            <div className="fm-attacks">
              <div className="fm-attacker">
                <span className="fm-attacker-icon">{targetingSelf ? '✨' : '⚔️'}</span>
                {targetingSelf ? 'Casting as' : 'Attacking as'}{' '}
                <strong>{resolveToken(snapshot, attacker!).name}</strong>
                <span className="fm-attacker-target">
                  {' '}→ {targetingSelf ? 'self' : d.name}
                </span>
                {!targetingSelf && (
                  <label
                    className="muted spell-tag fm-target-line-toggle"
                    title="Show animated targeting tether to this target"
                  >
                    <input
                      type="checkbox"
                      checked={showTargetLine}
                      onChange={(e) => setShowTargetLine(e.target.checked)}
                    />{' '}
                    Line
                  </label>
                )}
              </div>
              {attacker && <div className="dice-row fm-dice-row"><AdvantageToggle entityId={attacker.refId} />
                {(() => {
                  const adv = previewAttackAdvantage(snapshot, attacker, token, useStore.getState().manualAdvantage[attacker.refId]);
                  const autoReasons = adv.reasons.filter((r) => r !== 'manual');
                  return autoReasons.length > 0 ? (
                    <span className={adv.state === 'adv' ? 'adv-up' : adv.state === 'dis' ? 'adv-down' : 'muted'} role="status">
                      {adv.state === 'adv' ? 'Auto ADV' : adv.state === 'dis' ? 'Auto DIS' : 'Adv+Dis'}: {autoReasons.join(', ')}
                    </span>
                  ) : null;
                })()}
                {canAttackAsSelected && <button className={`btn tiny ${offhand ? 'on' : ''}`} onClick={() => toggleOption('offhand')}>Off hand</button>}
                {aWeapons.some(w => w.versatileDamage) && <button className={`btn tiny ${twoHanded ? 'on' : ''}`} onClick={() => toggleOption('twoHanded')}>Two hands</button>}
              </div>}
              {canAttackAsSelected && (
                <div className={aWeapons.length > 1 ? 'fm-weapons-grid' : undefined}>
                  <WeaponButtons
                    weapons={aWeapons}
                    twoHanded={twoHanded}
                    variant="menu"
                    distanceFt={
                      attacker && snapshot.map && attacker.mapId === token.mapId
                        ? tokenDistanceFt(attacker, token, snapshot.map)
                        : undefined
                    }
                    onAttack={(i) =>
                      run(() =>
                        combatAttack({
                          attackerTokenId: attacker!.id,
                          targetTokenId: token.id,
                          weaponIndex: i,
                          advantage: consumeAdvantage(attacker!.refId),
                          offhand: offhand || undefined,
                          twoHanded: twoHanded || undefined,
                        }),
                      )()
                    }
                  />
                </div>
              )}
              {/* Targeting the right-clicked token: attack rolls resolve to-hit vs
                  its AC; save/damage rolls make IT roll and take the damage right
                  away; heals restore ITS HP on cast. */}
              {canCastAsSelected && (
                <AbilityButtons
                  variant="menu"
                  abilities={aChar ? pcAbilities : monAbilities}
                  kind={aChar ? 'pc' : 'monster'}
                  caster={(aChar ?? aMon) as Character | Monster}
                  targetTokenId={token.id}
                  healTargetId={token.id}
                  onAfter={onClose}
                />
              )}
            </div>
          )}

          {isDm ? (
            <TokenAdminButtons token={token} variant="menu" onAfter={onClose} />
          ) : (
            !canSeeHp &&
            !canAttackAsSelected &&
            !canCastAsSelected && (
              <div className="floating-menu-note muted">No actions available</div>
            )
          )}
        </div>
      )}
    </div>
  );
}
