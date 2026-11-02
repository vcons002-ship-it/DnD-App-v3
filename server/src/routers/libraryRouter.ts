import type {
  CharacterCreatePayload,
  ImportConflictResolution,
  MonsterCreatePayload,
  TokenKind,
} from '../../../shared/types.js';
import {
  createCharacter,
  createCharacterFromLibrary,
  createMonsterTemplate,
  createToken,
  getActiveMapId,
  getCharacter,
  getMap,
  importMaps,
  instantiateMonster,
  listTokens,
  previewImportCharacters,
} from '../sessions.js';
import { recordDomainAction, type VersionedActionPatch } from './actionBus.js';

export const libraryRouter = {
  domain: 'library' as const,

  executeSpawnToken(params: {
    sessionId: string;
    mapId: string;
    kind: TokenKind;
    refId: string;
    x: number;
    y: number;
    actorRole: 'dm' | 'player';
    actorSocketId?: string;
  }): VersionedActionPatch<{ tokenId: string; mapId: string; kind: TokenKind; refId: string; x: number; y: number }> | null {
    if (!getMap(params.mapId)) return null;
    if (params.actorRole !== 'dm') {
      if (params.kind !== 'pc') return null;
      const c = getCharacter(params.refId);
      if (!c || c.claimedBy !== params.actorSocketId) return null;
      if (params.mapId !== getActiveMapId(params.sessionId)) return null;
      const exists = listTokens(params.mapId).some(
        (t) => t.kind === 'pc' && t.refId === params.refId,
      );
      if (exists) return null;
    }

    let refId = params.refId;
    if (params.kind === 'monster') {
      const inst = instantiateMonster(params.refId);
      if (!inst) return null;
      refId = inst.id;
    }
    const token = createToken({
      mapId: params.mapId,
      kind: params.kind,
      refId,
      x: params.x,
      y: params.y,
    });
    return recordDomainAction({
      sessionId: params.sessionId,
      domain: 'library',
      action: 'token:spawn',
      actorRole: params.actorRole,
      actorSocketId: params.actorSocketId,
      patch: {
        tokenId: token.id,
        mapId: params.mapId,
        kind: params.kind,
        refId,
        x: token.x,
        y: token.y,
      },
    });
  },

  executeCreateCharacter(params: {
    sessionId: string;
    payload: CharacterCreatePayload;
    actorRole: 'dm' | 'player';
    actorSocketId?: string;
  }) {
    const created = createCharacter(params.sessionId, params.payload);
    const envelope = recordDomainAction({
      sessionId: params.sessionId,
      domain: 'library',
      action: 'character:create',
      actorRole: params.actorRole,
      actorSocketId: params.actorSocketId,
      patch: { characterId: created.id, name: created.name },
    });
    return { character: created, envelope };
  },

  executeLoadCharacterFromLibrary(params: {
    sessionId: string;
    name: string;
    actorRole: 'dm' | 'player';
    actorSocketId?: string;
  }) {
    const character = createCharacterFromLibrary(
      params.sessionId,
      params.name,
    );
    if (!character) return null;
    const envelope = recordDomainAction({
      sessionId: params.sessionId,
      domain: 'library',
      action: 'character:fromLibrary',
      actorRole: params.actorRole,
      actorSocketId: params.actorSocketId,
      patch: { characterId: character.id, name: character.name },
    });
    return { character, envelope };
  },

  executeCreateMonsterTemplate(params: {
    sessionId: string;
    payload: MonsterCreatePayload;
    actorSocketId?: string;
  }) {
    const template = createMonsterTemplate(params.sessionId, params.payload);
    const envelope = recordDomainAction({
      sessionId: params.sessionId,
      domain: 'library',
      action: 'monster:createTemplate',
      actorRole: 'dm',
      actorSocketId: params.actorSocketId,
      patch: { templateId: template.id, name: template.name },
    });
    return { template, envelope };
  },

  previewImport(sessionId: string, sourceCode: string, mapIds: string[]) {
    return previewImportCharacters(sessionId, sourceCode, mapIds);
  },

  executeImportMaps(params: {
    sessionId: string;
    sourceCode: string;
    mapIds: string[];
    resolutions?: Record<string, ImportConflictResolution>;
    isClaimActive?: (claimedBy: string | null) => boolean;
    actorSocketId?: string;
  }) {
    const importedCount = importMaps(params.sessionId, params.sourceCode, params.mapIds, {
      resolutions: params.resolutions ?? {},
      isClaimActive: params.isClaimActive ?? (() => false),
    });
    const envelope = recordDomainAction({
      sessionId: params.sessionId,
      domain: 'library',
      action: 'session:importMaps',
      actorRole: 'dm',
      actorSocketId: params.actorSocketId,
      patch: { sourceCode: params.sourceCode, importedCount },
    });
    return { importedCount, envelope };
  },
};
