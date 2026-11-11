import {partySpell} from '../../../shared/partySpells';
import {tokenDistanceFt} from '../../../shared/distance';
import { AdvantageToggle } from './AdvantageToggle';
import { targetLabel, previewAttackAdvantage } from '../lib/targets';
import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from 'react';
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

type MobileDock = 'left' | 'right';

type ViewportMetrics = {
  vw: number;
  vh: number;
  mobile: boolean;
  safeTop: number;
};

function readSafeTopPx(): number {
  if (typeof document === 'undefined') return 52;
  const topbar = document.querySelector('.layout > .topbar');
  const bottom = topbar ? topbar.getBoundingClientRect().bottom : 0;
  return Math.max(8, Math.round((bottom || 44) + 6));
}

function readViewport(): ViewportMetrics {
  if (typeof window === 'undefined') {
    return { vw: 1024, vh: 768, mobile: false, safeTop: 52 };
  }
  const vw = window.innerWidth;
  const vh = Math.round(window.visualViewport?.height ?? window.innerHeight);
  const coarse =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches;
  const hasTouch = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0;
  const mobile =
    coarse || vw <= 820 || vh <= 600 || (hasTouch && Math.min(vw, vh) <= 820);
  return { vw, vh, mobile, safeTop: readSafeTopPx() };
}

function computeMobileAutoDock(
  x: number,
  vp: ViewportMetrics,
  tetherDx: number,
): MobileDock {
  const sx = Number.isFinite(x) ? x : vp.vw * 0.5;
  const midX = vp.vw * 0.5;
  const sheetW = Math.min(210, Math.round(vp.vw * 0.47));
  const leftZoneEnd = 6 + sheetW;
  const rightZoneStart = vp.vw - sheetW - 6;
  // When the tapped target sits in the open center strip (clear of both side
  // rails), dock opposite the horizontal tether direction so the attacker ->
  // target line stays unobstructed; default right so the bottom-left player
  // HUD orb stays clear too.
  if (sx > leftZoneEnd - 8 && sx < rightZoneStart + 8) {
    if (tetherDx > 8) return 'left';
    if (tetherDx < -8) return 'right';
    return sx > midX + 20 ? 'left' : 'right';
  }
  return sx > midX ? 'left' : 'right';
}

/**
 * Right-click / long-press action menu anchored at a token. Quick combat actions
 * (damage/heal where HP is visible) for everyone; DM gets the editing actions.
 */
export function FloatingMenu({ snapshot, token, attacker: defaultAttacker, x, y, onClose }: Props) {
  const [chosenAttacker, setChosenAttacker] = useState('');
  const [collapsed, setCollapsed] = useState(false);
  const [dockPref, setDockPref] = useState<'auto' | MobileDock>('auto');
  const [viewport, setViewport] = useState<ViewportMetrics>(readViewport);
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number }>(() => ({
    left: Number.isFinite(x) ? x : 16,
    top: Number.isFinite(y) ? y : 16,
  }));
  useEffect(() => {
    setDockPref('auto');
    setCollapsed(false);
  }, [token.id]);
  const socketId = useStore(s => s.socket?.id);
  const actors = snapshot.tokens.filter(t => !t.sharedSightOnly && !t.partiallyRevealed && t.mapId === token.mapId && (snapshot.role === 'dm' ||
    t.kind === 'pc' && snapshot.characters.some(c => c.id === t.refId && c.claimedBy === socketId) ||
    t.kind === 'monster' && snapshot.monsters.some(m => m.id === t.refId && m.disposition === 'friendly')) && !resolveToken(snapshot,t).objectKind);
  const attacker = actors.find(t => t.id === chosenAttacker) ?? defaultAttacker ?? actors.find(t => t.id === snapshot.activeTurnTokenId) ?? actors[0] ?? null;
  const isMobileSheet = viewport.mobile;
  const tetherDx = attacker && attacker.id !== token.id ? attacker.x - token.x : 0;
  const tetherDy = attacker && attacker.id !== token.id ? attacker.y - token.y : 0;
  const autoDock = computeMobileAutoDock(x, viewport, tetherDx);
  const effectiveDock: MobileDock = dockPref !== 'auto' ? dockPref : autoDock;

  useLayoutEffect(() => {
    const computePosition = () => {
      const vp = readViewport();
      setViewport((prev) =>
        prev.vw === vp.vw &&
        prev.vh === vp.vh &&
        prev.mobile === vp.mobile &&
        prev.safeTop === vp.safeTop
          ? prev
          : vp,
      );
      if (vp.mobile) return;
      const el = menuRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (!rect.width && !rect.height) return;
      const scaleRatio = el.offsetWidth > 0 ? rect.width / el.offsetWidth : 1;
      const sx = Number.isFinite(x) ? x : vp.vw * 0.5;
      const sy = Number.isFinite(y) ? y : vp.vh * 0.5;
      const offset = 24;
      const preferLeft =
        (tetherDx > 20 && sx - rect.width - offset >= 8) || sx + offset + rect.width > vp.vw - 8;
      const rawLeft = preferLeft ? sx - rect.width - offset : sx + offset;
      const leftPx = Math.max(8, Math.min(rawLeft, vp.vw - rect.width - 8));
      const rawTop = tetherDy > 20 && sy - rect.height * 0.6 >= 8 ? sy - rect.height * 0.5 : sy - 16;
      const topPx = Math.max(8, Math.min(rawTop, vp.vh - rect.height - 8));
      setPosition({
        left: Math.round(leftPx / (scaleRatio || 1)),
        top: Math.round(topPx / (scaleRatio || 1)),
      });
    };
    computePosition();
    window.addEventListener('resize', computePosition);
    const vv = window.visualViewport;
    vv?.addEventListener('resize', computePosition);
    return () => {
      window.removeEventListener('resize', computePosition);
      vv?.removeEventListener('resize', computePosition);
    };
  }, [x, y, tetherDx, tetherDy, collapsed, isMobileSheet]);
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
      data-dock={isMobileSheet ? effectiveDock : undefined}
      ref={menuRef}
      role="dialog" aria-label="Token actions"
      style={
        isMobileSheet
          ? ({ '--fm-safe-top': `${viewport.safeTop}px` } as CSSProperties)
          : position
      }
      onWheel={(e) => e.stopPropagation()}
      // Stop the menu's own pointerdown from triggering the outside-click close.
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="floating-menu-title">
        <span className="fm-title-label" title={targetLabel(snapshot, token, attacker ?? undefined)}>
          {targetLabel(snapshot, token)}
        </span>
        {attacker && attacker.id !== token.id && snapshot.map && attacker.mapId === token.mapId && (
          <span className="fm-title-dist">
            {Math.round(tokenDistanceFt(attacker, token, snapshot.map))} ft
          </span>
        )}
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
              aria-label="Move token actions to opposite edge"
              title="Move menu to opposite side of screen"
              onClick={() =>
                setDockPref(() => (effectiveDock === 'left' ? 'right' : 'left'))
              }
            >
              ⇄
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
          {!!d.conditions.length && <p className="floating-menu-note fm-conditions-note">{d.conditions.map(c => c.label).join(', ')}</p>}
          {!targetObjectKind && (actors.length > 0 || ((canAttackAsSelected || canCastAsSelected) && attacker)) && (
            <div className={`fm-actor-bar${canAttackAsSelected || canCastAsSelected ? ' is-combat' : ''}`}>
              <span className="fm-actor-label">
                {(canAttackAsSelected || canCastAsSelected) && (
                  <span className="fm-attacker-icon">{targetingSelf ? '✨' : '⚔️'}</span>
                )}
                {canAttackAsSelected || canCastAsSelected
                  ? targetingSelf
                    ? 'Casting as'
                    : 'Attacking as'
                  : 'Act as'}
              </span>
              {actors.length > 0 ? (
                <select
                  aria-label="Act as"
                  value={attacker?.id ?? ''}
                  onChange={(e) => setChosenAttacker(e.target.value)}
                >
                  {actors.map((t) => (
                    <option key={t.id} value={t.id}>
                      {targetLabel(snapshot, t)}
                    </option>
                  ))}
                </select>
              ) : (
                attacker && <strong className="fm-actor-static">{resolveToken(snapshot, attacker).name}</strong>
              )}
              {(canAttackAsSelected || canCastAsSelected) && !targetingSelf && (
                <button
                  type="button"
                  className={`btn tiny fm-line-btn${showTargetLine ? ' on' : ''}`}
                  aria-label="Toggle targeting line"
                  aria-pressed={showTargetLine}
                  title="Toggle animated targeting tether to this target"
                  onClick={() => setShowTargetLine(!showTargetLine)}
                >
                  🎯
                </button>
              )}
            </div>
          )}

          {/* Non-combat object: interact (toggle state, reveal/hide). */}
          {targetObjectKind && (
            <ObjectControls snapshot={snapshot} token={token} editable={isDm} />
          )}

          {(canAttackAsSelected || canCastAsSelected) && (
            <div className="fm-attacks">
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
                {canAttackAsSelected && (
                  <button
                    className={`btn tiny ${offhand ? 'on' : ''}`}
                    aria-label="Off hand"
                    title="Off-hand bonus attack"
                    onClick={() => toggleOption('offhand')}
                  >
                    {isMobileSheet ? 'Off' : 'Off hand'}
                  </button>
                )}
                {aWeapons.some(w => w.versatileDamage) && (
                  <button
                    className={`btn tiny ${twoHanded ? 'on' : ''}`}
                    aria-label="Two hands"
                    title="Use weapon two-handed"
                    onClick={() => toggleOption('twoHanded')}
                  >
                    {isMobileSheet ? '2H' : 'Two hands'}
                  </button>
                )}
              </div>}
              {canAttackAsSelected && (
                <div className="fm-weapons-list">
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

          {/* Quick damage/heal — kept open so several can be applied in a row. */}
          {canSeeHp && (
            <DamageHealControls
              compact
              onApply={(delta) => applyDamage(token.kind, token.refId, delta)}
              onTemp={(amt) => setTempHp(token.kind, token.refId, amt)}
            />
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
