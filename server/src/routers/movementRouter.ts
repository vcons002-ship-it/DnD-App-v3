import {
  getActiveMapId,
  getCharacter,
  getMap,
  getMonster,
  getToken,
  moveToken,
  resizeMiniature,
  resizeToken,
  setTokenLantern,
  wallLimitedMove,
} from '../sessions.js';
import { setWallDoor } from '../mapWalls.js';
import { recordWalkingMove } from '../walking.js';
import { appendJournalEvent } from '../eventJournal.js';
import { recordDomainAction, type VersionedActionPatch } from './actionBus.js';

export type MoveTokenResult =
  | {
      ok: true;
      from: { x: number; y: number };
      to: { x: number; y: number };
      envelope: VersionedActionPatch<{
        tokenId: string;
        mapId: string;
        from: { x: number; y: number };
        to: { x: number; y: number };
        relocate: boolean;
      }>;
    }
  | { ok: false; error: string };

export const movementRouter = {
  domain: 'movement' as const,

  async executeMoveToken(params: {
    sessionId: string;
    tokenId: string;
    x: number;
    y: number;
    actorRole: 'dm' | 'player';
    actorSocketId?: string;
    relocate?: boolean;
    recordExploration?: boolean;
  }): Promise<MoveTokenResult> {
    const before = getToken(params.tokenId);
    if (!before) return { ok: false, error: 'Token not found.' };
    const map = getMap(before.mapId);
    if (!map || map.sessionId !== params.sessionId) {
      return { ok: false, error: 'Token does not belong to this session.' };
    }
    if (map.walls?.some((w) => w.tokenId === before.id)) {
      return { ok: false, error: 'Door-linked tokens cannot be dragged.' };
    }
    if (params.actorRole === 'player') {
      if (before.isHidden) return { ok: false, error: 'Token is hidden.' };
      if (before.kind === 'monster') {
        const m = getMonster(before.refId);
        if (!m || m.disposition !== 'friendly' || m.objectKind) {
          return { ok: false, error: 'Only friendly companions can be moved by players.' };
        }
      }
    }

    const relocate = params.actorRole === 'dm' && !!params.relocate;
    const from = { x: before.x, y: before.y };
    const moved = moveToken(
      params.tokenId,
      params.x,
      params.y,
      params.actorRole !== 'dm',
      relocate,
    );
    if (!moved) return { ok: false, error: 'Move rejected.' };

    if (params.recordExploration !== false) {
      try {
        await recordWalkingMove(before, moved, getActiveMapId(params.sessionId) === map.id, relocate);
      } catch {
        // Non-fatal exploration worker fallback
      }
    }

    const envelope = recordDomainAction({
      sessionId: params.sessionId,
      domain: 'movement',
      action: 'token:move',
      actorRole: params.actorRole,
      actorSocketId: params.actorSocketId,
      patch: {
        tokenId: params.tokenId,
        mapId: before.mapId,
        from,
        to: { x: moved.x, y: moved.y },
        relocate,
      },
    });

    appendJournalEvent({
      sessionId: params.sessionId,
      domain: 'movement',
      action: 'token:move',
      actorRole: params.actorRole,
      label: `Move token ${params.tokenId} (${from.x},${from.y}) -> (${moved.x},${moved.y})`,
      forward: {
        kind: 'token:move',
        tokenId: params.tokenId,
        mapId: before.mapId,
        x: moved.x,
        y: moved.y,
      },
      inverse: {
        kind: 'token:move',
        tokenId: params.tokenId,
        mapId: before.mapId,
        x: from.x,
        y: from.y,
      },
    });

    return { ok: true, from, to: { x: moved.x, y: moved.y }, envelope };
  },

  previewWallLimitedMove(tokenId: string, x: number, y: number, isDm: boolean): { x: number; y: number } | null {
    const token = getToken(tokenId);
    if (!token) return null;
    return !isDm && Number.isFinite(x) && Number.isFinite(y)
      ? wallLimitedMove(token, x, y)
      : { x, y };
  },

  executeSetLantern(params: {
    sessionId: string;
    tokenId: string;
    enabled: boolean;
    actorRole: 'dm' | 'player';
    actorSocketId?: string;
  }): VersionedActionPatch<{ tokenId: string; enabled: boolean }> | null {
    const token = getToken(params.tokenId);
    if (!token) return null;
    const map = getMap(token.mapId);
    if (!map || map.sessionId !== params.sessionId) return null;
    if (params.actorRole === 'player') {
      const character = token.kind === 'pc' ? getCharacter(token.refId) : null;
      if (token.isHidden || character?.claimedBy !== params.actorSocketId) return null;
    }
    setTokenLantern(params.tokenId, params.enabled);
    return recordDomainAction({
      sessionId: params.sessionId,
      domain: 'movement',
      action: 'token:setLantern',
      actorRole: params.actorRole,
      actorSocketId: params.actorSocketId,
      patch: { tokenId: params.tokenId, enabled: params.enabled },
    });
  },

  executeToggleDoor(params: {
    sessionId: string;
    mapId: string;
    doorId: string;
    open: boolean;
    actorRole: 'dm' | 'player';
    actorSocketId?: string;
  }): { ok: true; envelope: VersionedActionPatch<{ mapId: string; doorId: string; open: boolean }> } | { ok: false; error: string } {
    const error = setWallDoor(params.sessionId, params.mapId, params.doorId, params.open);
    if (error) return { ok: false, error };
    const envelope = recordDomainAction({
      sessionId: params.sessionId,
      domain: 'movement',
      action: 'map:setDoor',
      actorRole: params.actorRole,
      actorSocketId: params.actorSocketId,
      patch: { mapId: params.mapId, doorId: params.doorId, open: params.open },
    });
    return { ok: true, envelope };
  },

  executeResizeToken(params: {
    sessionId: string;
    tokenId: string;
    widthFt: number;
    miniature?: boolean;
    actorRole: 'dm' | 'player';
    actorSocketId?: string;
  }): VersionedActionPatch<{ tokenId: string; widthFt: number; miniature: boolean }> | null {
    const token = getToken(params.tokenId);
    if (!token || !Number.isFinite(params.widthFt)) return null;
    const map = getMap(token.mapId);
    if (!map || map.sessionId !== params.sessionId) return null;
    if (params.miniature) resizeMiniature(params.tokenId, params.widthFt);
    else resizeToken(params.tokenId, params.widthFt);
    return recordDomainAction({
      sessionId: params.sessionId,
      domain: 'movement',
      action: 'token:resize',
      actorRole: params.actorRole,
      actorSocketId: params.actorSocketId,
      patch: { tokenId: params.tokenId, widthFt: params.widthFt, miniature: !!params.miniature },
    });
  },
};
