import type { Condition, TokenKind } from '../../../shared/types.js';
import { newId } from '../db.js';
import {
  advanceTurn,
  applyDamage,
  clearCondition,
  clearInitiative,
  getCharacter,
  getMonster,
  getSessionById,
  rollAllInitiative,
  setCombatRound,
  setCondition,
  setTempHp,
  setTokenInCombat,
  setTokenInitiative,
  startCombat,
} from '../sessions.js';
import { appendJournalEvent } from '../eventJournal.js';
import { recordDomainAction, type VersionedActionPatch } from './actionBus.js';

export const combatRouter = {
  domain: 'combat' as const,

  executeStartCombat(params: {
    sessionId: string;
    mapId: string;
    actorRole: 'dm' | 'player';
    actorSocketId?: string;
    isConnected?: (id: string) => boolean;
  }): VersionedActionPatch<{ mapId: string }> {
    startCombat(params.sessionId, params.isConnected);
    return recordDomainAction({
      sessionId: params.sessionId,
      domain: 'combat',
      action: 'combat:start',
      actorRole: params.actorRole,
      actorSocketId: params.actorSocketId,
      patch: { mapId: params.mapId },
    });
  },

  executeRollAllInitiative(params: {
    sessionId: string;
    mapId: string;
    actorRole: 'dm' | 'player';
    actorSocketId?: string;
  }): VersionedActionPatch<{ mapId: string }> {
    rollAllInitiative(params.mapId);
    return recordDomainAction({
      sessionId: params.sessionId,
      domain: 'combat',
      action: 'initiative:rollAll',
      actorRole: params.actorRole,
      actorSocketId: params.actorSocketId,
      patch: { mapId: params.mapId },
    });
  },

  executeAdvanceTurn(params: {
    sessionId: string;
    mapId: string;
    actorRole: 'dm' | 'player';
    actorSocketId?: string;
  }): VersionedActionPatch<{ mapId: string; nextTokenId: string | null }> {
    advanceTurn(params.sessionId);
    const nextTokenId = getSessionById(params.sessionId)?.activeTurnTokenId ?? null;
    return recordDomainAction({
      sessionId: params.sessionId,
      domain: 'combat',
      action: 'initiative:next',
      actorRole: params.actorRole,
      actorSocketId: params.actorSocketId,
      patch: { mapId: params.mapId, nextTokenId },
    });
  },

  executeSetInitiative(params: {
    sessionId: string;
    tokenId: string;
    initiative: number | null;
    actorRole: 'dm' | 'player';
    actorSocketId?: string;
  }): VersionedActionPatch<{ tokenId: string; initiative: number | null }> {
    setTokenInitiative(params.tokenId, params.initiative);
    return recordDomainAction({
      sessionId: params.sessionId,
      domain: 'combat',
      action: 'token:setInitiative',
      actorRole: params.actorRole,
      actorSocketId: params.actorSocketId,
      patch: { tokenId: params.tokenId, initiative: params.initiative },
    });
  },

  executeSetTokenInCombat(params: {
    sessionId: string;
    tokenId: string;
    inCombat?: boolean;
    actorRole: 'dm' | 'player';
    actorSocketId?: string;
  }): VersionedActionPatch<{ tokenId: string; inCombat?: boolean }> {
    setTokenInCombat(params.tokenId, params.inCombat);
    return recordDomainAction({
      sessionId: params.sessionId,
      domain: 'combat',
      action: 'token:setInCombat',
      actorRole: params.actorRole,
      actorSocketId: params.actorSocketId,
      patch: { tokenId: params.tokenId, inCombat: params.inCombat },
    });
  },

  executeClearInitiative(params: {
    sessionId: string;
    mapId: string;
    actorRole: 'dm' | 'player';
    actorSocketId?: string;
  }): VersionedActionPatch<{ mapId: string }> {
    clearInitiative(params.sessionId);
    return recordDomainAction({
      sessionId: params.sessionId,
      domain: 'combat',
      action: 'initiative:clear',
      actorRole: params.actorRole,
      actorSocketId: params.actorSocketId,
      patch: { mapId: params.mapId },
    });
  },

  executeSetRound(params: {
    sessionId: string;
    round: number;
    actorRole: 'dm' | 'player';
    actorSocketId?: string;
  }): VersionedActionPatch<{ round: number }> {
    setCombatRound(params.sessionId, params.round);
    return recordDomainAction({
      sessionId: params.sessionId,
      domain: 'combat',
      action: 'combat:setRound',
      actorRole: params.actorRole,
      actorSocketId: params.actorSocketId,
      patch: { round: params.round },
    });
  },

  executeApplyDamage(params: {
    sessionId: string;
    kind: TokenKind;
    refId: string;
    amount: number;
    actorRole: 'dm' | 'player';
    actorSocketId?: string;
  }): VersionedActionPatch<{
    kind: TokenKind;
    refId: string;
    amount: number;
    beforeHp: number;
    beforeTempHp: number;
    afterHp: number;
    afterTempHp: number;
  }> | null {
    const before = params.kind === 'pc' ? getCharacter(params.refId) : getMonster(params.refId);
    if (!before) return null;
    const beforeHp = before.curHp;
    const beforeTempHp = before.tempHp ?? 0;
    applyDamage(params.kind, params.refId, params.amount);
    const after = params.kind === 'pc' ? getCharacter(params.refId) : getMonster(params.refId);
    const afterHp = after?.curHp ?? beforeHp;
    const afterTempHp = after?.tempHp ?? 0;
    appendJournalEvent({
      sessionId: params.sessionId,
      domain: 'combat',
      action: 'entity:damage',
      actorRole: params.actorRole,
      label: `${params.amount >= 0 ? 'Damage' : 'Heal'} ${before.name} (${beforeHp} -> ${afterHp} HP)`,
      forward: {
        kind: 'entity:hp',
        entityKind: params.kind,
        refId: params.refId,
        curHp: afterHp,
        tempHp: afterTempHp,
      },
      inverse: {
        kind: 'entity:hp',
        entityKind: params.kind,
        refId: params.refId,
        curHp: beforeHp,
        tempHp: beforeTempHp,
      },
    });
    return recordDomainAction({
      sessionId: params.sessionId,
      domain: 'combat',
      action: 'entity:damage',
      actorRole: params.actorRole,
      actorSocketId: params.actorSocketId,
      patch: {
        kind: params.kind,
        refId: params.refId,
        amount: params.amount,
        beforeHp,
        beforeTempHp,
        afterHp,
        afterTempHp,
      },
    });
  },

  executeSetTempHp(params: {
    sessionId: string;
    kind: TokenKind;
    refId: string;
    amount: number;
    actorRole: 'dm' | 'player';
    actorSocketId?: string;
  }): VersionedActionPatch<{ kind: TokenKind; refId: string; amount: number }> {
    setTempHp(params.kind, params.refId, params.amount);
    return recordDomainAction({
      sessionId: params.sessionId,
      domain: 'combat',
      action: 'entity:tempHp',
      actorRole: params.actorRole,
      actorSocketId: params.actorSocketId,
      patch: { kind: params.kind, refId: params.refId, amount: params.amount },
    });
  },

  executeSetCondition(params: {
    sessionId: string;
    kind: TokenKind;
    refId: string;
    condition: Omit<Condition, 'id'> & { id?: string };
    actorRole: 'dm' | 'player';
    actorSocketId?: string;
  }): VersionedActionPatch<{ kind: TokenKind; refId: string; label: string }> {
    setCondition(params.kind, params.refId, {
      ...params.condition,
      id: params.condition.id ?? newId(),
    });
    return recordDomainAction({
      sessionId: params.sessionId,
      domain: 'combat',
      action: 'condition:set',
      actorRole: params.actorRole,
      actorSocketId: params.actorSocketId,
      patch: { kind: params.kind, refId: params.refId, label: params.condition.label },
    });
  },

  executeClearCondition(params: {
    sessionId: string;
    kind: TokenKind;
    refId: string;
    conditionId: string;
    actorRole: 'dm' | 'player';
    actorSocketId?: string;
  }): VersionedActionPatch<{ kind: TokenKind; refId: string; conditionId: string }> {
    clearCondition(params.kind, params.refId, params.conditionId);
    return recordDomainAction({
      sessionId: params.sessionId,
      domain: 'combat',
      action: 'condition:clear',
      actorRole: params.actorRole,
      actorSocketId: params.actorSocketId,
      patch: { kind: params.kind, refId: params.refId, conditionId: params.conditionId },
    });
  },
};
