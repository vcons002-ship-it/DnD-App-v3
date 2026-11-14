import type { Character, Monster, SheetAbility, Token, TokenKind } from '../../shared/types.js';
import { combatSpell, spareTheDyingRangeFt, type CombatSpellKey } from '../../shared/combatSpells.js';
import { tokenDistanceFt } from '../../shared/distance.js';
import { hasLineOfSight } from '../../shared/mapWalls.js';
import { effectiveStats, isWearingArmor } from '../../shared/modifiers.js';
import { spellcastingKeyFor } from '../../shared/spellExecution.js';
import { spellcastingMod } from '../../shared/spellMath.js';
import { spellTarget, timedConcentration } from './combatHelpers.js';
import { newId } from './db.js';
import {
  addRollLog,
  applyDamage,
  clearCondition,
  getCharacter,
  getMap,
  getMonster,
  getSessionById,
  getToken,
  isDeadEntity,
  listTokens,
  queueSpellImpact,
  setCondition,
  setDeathSaves,
  setLastAttackRole,
  setTempHp,
} from './sessions.js';

const getEnt = (kind: TokenKind, id: string) => (kind === 'pc' ? getCharacter(id) : getMonster(id));

function casterToken(sid: string, kind: TokenKind, id: string): Token | undefined {
  const mapId = getSessionById(sid)?.activeMapId;
  return mapId ? listTokens(mapId).find((t) => t.kind === kind && t.refId === id) : undefined;
}

function sameCreature(aKind: TokenKind, aId: string, bKind: TokenKind, bId: string): boolean {
  return aKind === bKind && aId === bId;
}

function rangeForKey(key: CombatSpellKey, casterLevel: number): number {
  if (key === 'shield of faith') return 60;
  if (key === 'spare the dying') return spareTheDyingRangeFt(casterLevel);
  return 5;
}

function validateTargetReachAndSight(
  sid: string,
  casterTok: Token | undefined,
  tok: Token,
  rangeFt: number,
  spellName: string,
): string | undefined {
  if (!casterTok) return undefined;
  if (casterTok.mapId !== tok.mapId) return `${spellName} requires a target on the active map.`;
  if (sameCreature(casterTok.kind, casterTok.refId, tok.kind, tok.refId)) return undefined;
  const map = getMap(tok.mapId);
  if (!map || map.sessionId !== sid) return `${spellName} requires a target on the active map.`;
  if (!hasLineOfSight(casterTok, tok, map.walls)) return 'A wall or closed door blocks this target.';
  if (tokenDistanceFt(casterTok, tok, map) > rangeFt + 1e-6) {
    return `${spellName} reaches up to ${rangeFt} feet.`;
  }
  return undefined;
}

function collectRecipients(
  sid: string,
  kind: TokenKind,
  casterId: string,
  ability: SheetAbility,
  key: CombatSpellKey,
  castLevel?: number,
  targetTokenId?: string,
  targetTokenIds?: string[],
): { recipients?: { kind: TokenKind; refId: string; entity: Character | Monster; tok?: Token }[]; error?: string } {
  const caster = getEnt(kind, casterId);
  if (!caster || caster.sessionId !== sid) return { error: 'Caster is unavailable.' };
  const cTok = casterToken(sid, kind, casterId);
  if (key === 'blur' || key === 'see invisibility') {
    if (isDeadEntity(kind, caster) || caster.curHp <= 0) {
      return { error: `${ability.name} requires a living caster.` };
    }
    return { recipients: [{ kind, refId: casterId, entity: caster, tok: cTok }] };
  }
  const slotLvl = Math.max(ability.level ?? 1, castLevel ?? ability.level ?? 1);
  const rawIds =
    key === 'heroism' && slotLvl > 1 && targetTokenIds?.length
      ? targetTokenIds
      : targetTokenIds?.length
        ? [targetTokenIds[0]]
        : targetTokenId
          ? [targetTokenId]
          : [];
  if ((key === 'spare the dying' || key === 'revivify') && rawIds.length === 0) {
    return { error: `Choose a target creature for ${ability.name}.` };
  }
  if (key === 'heroism' && rawIds.length > slotLvl) {
    return { error: `Heroism at level ${slotLvl} can target at most ${slotLvl} creature(s).` };
  }
  if (rawIds.length === 0) {
    if (isDeadEntity(kind, caster) || caster.curHp <= 0) {
      return { error: `${ability.name} requires a living creature.` };
    }
    if (key === 'mage armor' && kind === 'pc' && isWearingArmor(caster as Character)) {
      return { error: 'Mage Armor requires a creature that is not wearing armor.' };
    }
    return { recipients: [{ kind, refId: casterId, entity: caster, tok: cTok }] };
  }

  const rangeFt = rangeForKey(key, caster.level || 1);
  const seen = new Set<string>();
  const recipients: { kind: TokenKind; refId: string; entity: Character | Monster; tok?: Token }[] = [];
  for (const tid of rawIds) {
    const tok = spellTarget(sid, tid);
    const targetEnt = tok ? getEnt(tok.kind, tok.refId) : null;
    if (!tok || !targetEnt || (tok.kind === 'monster' && (targetEnt as Monster).objectKind)) {
      return { error: `Choose a valid creature for ${ability.name}.` };
    }
    const entKey = `${tok.kind}:${tok.refId}`;
    if (seen.has(entKey)) return { error: 'Choose distinct creatures.' };
    seen.add(entKey);

    const reachErr = validateTargetReachAndSight(sid, cTok, tok, rangeFt, ability.name);
    if (reachErr) return { error: reachErr };

    if (key === 'revivify') {
      if (!isDeadEntity(tok.kind, targetEnt)) return { error: 'Revivify requires a dead creature.' };
    } else if (key === 'spare the dying') {
      if (isDeadEntity(tok.kind, targetEnt) || targetEnt.curHp > 0) {
        return { error: 'Spare the Dying requires a living creature at 0 hit points.' };
      }
    } else {
      if (isDeadEntity(tok.kind, targetEnt) || targetEnt.curHp <= 0) {
        return { error: `${ability.name} requires a living creature.` };
      }
      if (key === 'mage armor' && tok.kind === 'pc' && isWearingArmor(targetEnt as Character)) {
        return { error: 'Mage Armor requires a creature that is not wearing armor.' };
      }
    }
    recipients.push({ kind: tok.kind, refId: tok.refId, entity: targetEnt, tok });
  }
  return { recipients };
}

/** Validate target eligibility, armor constraints, range, and sight before spending slots. */
export function combatSpellTargetError(
  sid: string,
  kind: TokenKind,
  casterId: string,
  ability: SheetAbility,
  castLevel?: number,
  targetTokenId?: string,
  targetTokenIds?: string[],
  _choice?: string,
): string | undefined {
  const key = combatSpell(ability);
  if (!key) return undefined;
  return collectRecipients(sid, kind, casterId, ability, key, castLevel, targetTokenId, targetTokenIds).error;
}

function clearPriorSpellCondition(kind: TokenKind, id: string, spellKeyLower: string) {
  const ent = getEnt(kind, id);
  for (const c of ent?.conditions ?? []) {
    if (!c.isConcentration && c.combatEffect?.spell.trim().toLowerCase() === spellKeyLower) {
      clearCondition(kind, id, c.id);
    }
  }
}

export function castCombatSpell(
  sid: string,
  roller: string,
  kind: TokenKind,
  casterId: string,
  ability: SheetAbility,
  castLevel?: number,
  targetTokenId?: string,
  targetTokenIds?: string[],
  choice?: string,
): { ok: boolean; error?: string } {
  const key = combatSpell(ability);
  const caster = getEnt(kind, casterId);
  if (!key || !caster || caster.sessionId !== sid) {
    return { ok: false, error: 'Unsupported spell.' };
  }
  const { recipients, error } = collectRecipients(
    sid,
    kind,
    casterId,
    ability,
    key,
    castLevel,
    targetTokenId,
    targetTokenIds,
  );
  if (error || !recipients?.length) {
    return { ok: false, error: error ?? 'No valid target.' };
  }

  const slotLvl = Math.max(ability.level ?? 0, castLevel ?? ability.level ?? 0);
  const round = getSessionById(sid)?.combatRound ?? 0;
  const timedRounds = (rounds: number) => ({
    expiresAt: Date.now() + rounds * 6000,
    ...(round > 0 ? { expiresRound: round + rounds } : {}),
  });
  const concSpells = new Set<CombatSpellKey>(['shield of faith', 'blur', 'greater invisibility', 'heroism']);
  const concEffect = concSpells.has(key)
    ? timedConcentration(kind, casterId, ability.name, key === 'shield of faith' ? 100 : 10, slotLvl)
    : undefined;
  if (concSpells.has(key) && !concEffect) {
    return { ok: false, error: 'Unable to start concentration for this spell.' };
  }

  setLastAttackRole(kind, casterId, 'caster');
  const names = recipients.map((r) => r.entity.name).join(', ');
  const upcastNote = slotLvl > (ability.level ?? 0) && slotLvl > 0 ? ` (L${slotLvl})` : '';

  if (key === 'shield of faith') {
    const r = recipients[0];
    clearPriorSpellCondition(r.kind, r.refId, 'shield of faith');
    setCondition(r.kind, r.refId, {
      id: newId(),
      label: 'Shield of Faith (+2 AC)',
      aura: 'green',
      isConcentration: false,
      customText: '+2 bonus to AC while concentrating.',
      combatEffect: { ...concEffect!, concentration: true },
    });
    queueSpellImpact(sid, r.kind, r.refId, 'Shield of Faith');
    addRollLog(sid, {
      roller,
      label: 'Shield of Faith',
      expr: `Shield of Faith${upcastNote}`,
      total: 2,
      detail: `${caster.name}: Shield of Faith${upcastNote} → ${r.entity.name} (+2 AC while concentrating, up to 10 minutes).`,
      description: ability.description || undefined,
    });
    return { ok: true };
  }

  if (key === 'mage armor') {
    const r = recipients[0];
    clearPriorSpellCondition(r.kind, r.refId, 'mage armor');
    setCondition(r.kind, r.refId, {
      id: newId(),
      label: 'Mage Armor',
      aura: 'blue',
      isConcentration: false,
      customText: 'Base AC becomes 13 + DEX modifier for 8 hours while unarmored.',
      combatEffect: {
        casterKind: kind,
        casterId,
        spell: 'Mage Armor',
        castLevel: slotLvl,
        castId: newId(),
        ...timedRounds(4800),
      },
    });
    queueSpellImpact(sid, r.kind, r.refId, 'Mage Armor');
    addRollLog(sid, {
      roller,
      label: 'Mage Armor',
      expr: `Mage Armor${upcastNote}`,
      total: 0,
      detail: `${caster.name}: Mage Armor${upcastNote} → ${r.entity.name} (base AC 13 + DEX modifier for 8 hours).`,
      description: ability.description || undefined,
    });
    return { ok: true };
  }

  if (key === 'blur') {
    const r = recipients[0];
    clearPriorSpellCondition(r.kind, r.refId, 'blur');
    setCondition(r.kind, r.refId, {
      id: newId(),
      label: 'Blur',
      aura: 'blue',
      isConcentration: false,
      customText: 'Attackers relying on sight have Disadvantage on attack rolls against you.',
      combatEffect: { ...concEffect!, concentration: true },
    });
    queueSpellImpact(sid, r.kind, r.refId, 'Blur');
    addRollLog(sid, {
      roller,
      label: 'Blur',
      expr: `Blur${upcastNote}`,
      total: 0,
      detail: `${caster.name}: Blur${upcastNote} — attackers without Blindsight/Truesight have Disadvantage (concentration).`,
      description: ability.description || undefined,
    });
    return { ok: true };
  }

  if (key === 'see invisibility') {
    const r = recipients[0];
    clearPriorSpellCondition(r.kind, r.refId, 'see invisibility');
    setCondition(r.kind, r.refId, {
      id: newId(),
      label: 'See Invisibility',
      aura: 'blue',
      isConcentration: false,
      customText: 'See invisible creatures and objects as if visible for 1 hour.',
      combatEffect: {
        casterKind: kind,
        casterId,
        spell: 'See Invisibility',
        castLevel: slotLvl,
        castId: newId(),
        ...timedRounds(600),
      },
    });
    queueSpellImpact(sid, r.kind, r.refId, 'See Invisibility');
    addRollLog(sid, {
      roller,
      label: 'See Invisibility',
      expr: `See Invisibility${upcastNote}`,
      total: 0,
      detail: `${caster.name}: See Invisibility — sees invisible creatures and into the Ethereal Plane for 1 hour.`,
      description: ability.description || undefined,
    });
    return { ok: true };
  }

  if (key === 'greater invisibility') {
    const r = recipients[0];
    clearPriorSpellCondition(r.kind, r.refId, 'greater invisibility');
    setCondition(r.kind, r.refId, {
      id: newId(),
      label: 'Invisible',
      aura: 'blue',
      isConcentration: false,
      customText: 'Invisible even when attacking or casting spells while concentrating.',
      combatEffect: { ...concEffect!, spell: 'Greater Invisibility', concentration: true },
    });
    queueSpellImpact(sid, r.kind, r.refId, 'Greater Invisibility');
    addRollLog(sid, {
      roller,
      label: 'Greater Invisibility',
      expr: `Greater Invisibility${upcastNote}`,
      total: 0,
      detail: `${caster.name}: Greater Invisibility${upcastNote} → ${r.entity.name} (remains invisible on attacks/damage/casts while concentrating).`,
      description: ability.description || undefined,
    });
    return { ok: true };
  }

  if (key === 'heroism') {
    const mod = Math.max(1, spellcastingMod(effectiveStats(caster).scores, kind === 'pc' ? spellcastingKeyFor(caster as Character, ability) : undefined));
    for (const r of recipients) {
      clearPriorSpellCondition(r.kind, r.refId, 'heroism');
      const liveEnt = getEnt(r.kind, r.refId)!;
      for (const cond of liveEnt.conditions) {
        if (!cond.isConcentration && cond.label.trim().toLowerCase() === 'frightened') {
          clearCondition(r.kind, r.refId, cond.id);
        }
      }
      const nextTemp = Math.max(liveEnt.tempHp, mod);
      setTempHp(r.kind, r.refId, nextTemp);
      setCondition(r.kind, r.refId, {
        id: newId(),
        label: `Heroism (+${mod} THP)`,
        aura: 'green',
        isConcentration: false,
        customText: `Immune to Frightened; gains ${mod} temporary HP at the start of each turn.`,
        combatEffect: {
          ...concEffect!,
          concentration: true,
          tempHpPerTurn: mod,
          immuneConditions: ['Frightened'],
        },
      });
      queueSpellImpact(sid, r.kind, r.refId, 'Heroism');
    }
    addRollLog(sid, {
      roller,
      label: 'Heroism',
      expr: `Heroism${upcastNote}`,
      total: mod,
      detail: `${caster.name}: Heroism${upcastNote} → ${names} (immune to Frightened, +${mod} temp HP now and at start of each turn while concentrating).`,
      description: ability.description || undefined,
    });
    return { ok: true };
  }

  if (key === 'protection from poison') {
    const r = recipients[0];
    clearPriorSpellCondition(r.kind, r.refId, 'protection from poison');
    for (const cond of getEnt(r.kind, r.refId)?.conditions ?? []) {
      if (!cond.isConcentration && cond.label.trim().toLowerCase() === 'poisoned') {
        clearCondition(r.kind, r.refId, cond.id);
      }
    }
    setCondition(r.kind, r.refId, {
      id: newId(),
      label: 'Protection from Poison',
      aura: 'green',
      isConcentration: false,
      customText: 'Resistance to Poison damage (also grants save advantage vs poison for 1 hour).',
      combatEffect: {
        casterKind: kind,
        casterId,
        spell: 'Protection from Poison',
        castLevel: slotLvl,
        castId: newId(),
        resistDamageTypes: ['poison'],
        ...timedRounds(600),
      },
    });
    queueSpellImpact(sid, r.kind, r.refId, 'Protection from Poison');
    addRollLog(sid, {
      roller,
      label: 'Protection from Poison',
      expr: `Protection from Poison${upcastNote}`,
      total: 0,
      detail: `${caster.name}: Protection from Poison${upcastNote} → ${r.entity.name} (neutralizes Poisoned, grants Poison resistance for 1 hour).`,
      description: ability.description || undefined,
    });
    return { ok: true };
  }

  if (key === 'lesser restoration') {
    const r = recipients[0];
    const targetEnt = getEnt(r.kind, r.refId)!;
    const valid = ['blinded', 'deafened', 'paralyzed', 'poisoned'];
    const wanted = choice?.trim().toLowerCase();
    const matchesChoice = wanted && valid.includes(wanted)
      ? targetEnt.conditions.filter((c) => !c.isConcentration && c.label.trim().toLowerCase() === wanted)
      : [];
    const fallback = targetEnt.conditions.find((c) => !c.isConcentration && valid.includes(c.label.trim().toLowerCase()));
    const toRemove = matchesChoice.length ? matchesChoice : fallback ? [fallback] : [];
    const removedLabels: string[] = [];
    for (const c of toRemove) {
      removedLabels.push(c.label);
      clearCondition(r.kind, r.refId, c.id);
    }
    queueSpellImpact(sid, r.kind, r.refId, 'Lesser Restoration');
    addRollLog(sid, {
      roller,
      label: 'Lesser Restoration',
      expr: `Lesser Restoration${upcastNote}`,
      total: removedLabels.length,
      detail: removedLabels.length
        ? `${caster.name}: Lesser Restoration${upcastNote} → ${r.entity.name} (cured ${removedLabels.join(', ')}).`
        : `${caster.name}: Lesser Restoration${upcastNote} → ${r.entity.name} (no matching Blinded/Deafened/Paralyzed/Poisoned condition active).`,
      description: ability.description || undefined,
    });
    return { ok: true };
  }

  if (key === 'greater restoration') {
    const r = recipients[0];
    const targetEnt = getEnt(r.kind, r.refId)!;
    const want = choice?.trim().toLowerCase() ?? 'auto';
    const isAuto = !choice || want.startsWith('auto');
    const cured: string[] = [];

    const clearMatching = (pred: (c: (typeof targetEnt.conditions)[number]) => boolean) => {
      for (const c of getEnt(r.kind, r.refId)?.conditions ?? []) {
        if (!c.isConcentration && pred(c)) {
          cured.push(c.label);
          clearCondition(r.kind, r.refId, c.id);
          return true;
        }
      }
      return false;
    };

    const tryHarm = () => clearMatching((c) => !!c.combatEffect?.harmMaxHpReduction);
    const tryPetrified = () => clearMatching((c) => c.label.trim().toLowerCase() === 'petrified');
    const tryCharmed = () => {
      const child = getEnt(r.kind, r.refId)?.conditions.find((c) => !c.isConcentration && c.label.trim().toLowerCase() === 'charmed');
      if (!child) return false;
      const targetId = child.combatEffect?.parentConditionId ?? child.id;
      const parent = getEnt(r.kind, r.refId)?.conditions.find((c) => c.id === targetId);
      cured.push(parent?.label ?? child.label);
      clearCondition(r.kind, r.refId, targetId);
      return true;
    };
    const tryExhaustion = () => {
      const exh = getEnt(r.kind, r.refId)?.conditions.find((c) => !c.isConcentration && /^exhaustion\b/i.test(c.label.trim()));
      if (!exh) return false;
      const m = /(\d+)/.exec(exh.label);
      const lvl = m ? Number(m[1]) : 1;
      if (lvl > 1) {
        setCondition(r.kind, r.refId, { ...exh, label: `Exhaustion ${lvl - 1}` });
        cured.push(`Exhaustion reduced (${lvl} → ${lvl - 1})`);
      } else {
        clearCondition(r.kind, r.refId, exh.id);
        cured.push(exh.label);
      }
      return true;
    };
    const tryCurse = () =>
      clearMatching((c) => /\b(?:curse|cursed|bestow curse)\b/i.test(c.label) || /\b(?:curse|bestow curse)\b/i.test(c.combatEffect?.spell ?? ''));

    if (want.includes('hp') || want.includes('maximum')) tryHarm();
    else if (want.includes('petrif')) tryPetrified();
    else if (want.includes('charm')) tryCharmed();
    else if (want.includes('exhaust')) tryExhaustion();
    else if (want.includes('curse')) tryCurse();
    else if (isAuto) {
      tryHarm() || tryPetrified() || tryCharmed() || tryExhaustion() || tryCurse();
    }

    queueSpellImpact(sid, r.kind, r.refId, 'Greater Restoration');
    addRollLog(sid, {
      roller,
      label: 'Greater Restoration',
      expr: `Greater Restoration${upcastNote}`,
      total: cured.length,
      detail: cured.length
        ? `${caster.name}: Greater Restoration${upcastNote} → ${r.entity.name} (removed/reduced ${cured.join(', ')}).`
        : `${caster.name}: Greater Restoration${upcastNote} → ${r.entity.name} (cast; ${choice ?? 'selected effect'} noted for DM).`,
      description: ability.description || undefined,
    });
    return { ok: true };
  }

  if (key === 'spare the dying') {
    const r = recipients[0];
    if (r.kind === 'pc') {
      setDeathSaves(r.refId, 3, 0);
    }
    queueSpellImpact(sid, r.kind, r.refId, 'Spare the Dying');
    addRollLog(sid, {
      roller,
      label: 'Spare the Dying',
      expr: 'Spare the Dying',
      total: 0,
      detail: `${caster.name}: Spare the Dying → ${r.entity.name} is now STABLE at 0 HP.`,
      description: ability.description || undefined,
    });
    return { ok: true };
  }

  if (key === 'revivify') {
    const r = recipients[0];
    const reviveRollId = newId();
    applyDamage(r.kind, r.refId, -1, undefined, false, reviveRollId, { revive: true, spell: 'Revivify' });
    addRollLog(sid, {
      roller,
      label: 'Revivify',
      expr: `Revivify${upcastNote}`,
      total: 1,
      detail: `${caster.name}: Revivify${upcastNote} returns ${r.entity.name} to life with 1 HP.`,
      description: ability.description || undefined,
    }, reviveRollId);
    return { ok: true };
  }

  if (key === 'death ward') {
    const r = recipients[0];
    clearPriorSpellCondition(r.kind, r.refId, 'death ward');
    setCondition(r.kind, r.refId, {
      id: newId(),
      label: 'Death Ward',
      aura: 'green',
      isConcentration: false,
      customText: 'Drops to 1 HP instead of 0 HP the first time damage would drop it (8 hours).',
      combatEffect: {
        casterKind: kind,
        casterId,
        spell: 'Death Ward',
        castLevel: slotLvl,
        castId: newId(),
        ...timedRounds(4800),
      },
    });
    queueSpellImpact(sid, r.kind, r.refId, 'Death Ward');
    addRollLog(sid, {
      roller,
      label: 'Death Ward',
      expr: `Death Ward${upcastNote}`,
      total: 0,
      detail: `${caster.name}: Death Ward${upcastNote} → ${r.entity.name} (warded for 8 hours; drops to 1 HP once instead of 0 HP).`,
      description: ability.description || undefined,
    });
    return { ok: true };
  }

  return { ok: false, error: 'Unhandled combat spell.' };
}
