import type { FogLayer } from '../../../shared/types.js';
import type { MapEnvironment } from '../../../shared/mapEnvironment.js';
import type { WallEdit } from '../../../shared/mapWalls.js';
import {
  coverFog,
  getMap,
  paintFog,
  renameMap,
  reorderMaps,
  setActiveMap,
  setExplorationMode,
  setFogLayer,
  setSharedPartyVision,
  setVisionFog,
  updateMapEnvironment,
} from '../sessions.js';
import { resetExploration } from '../exploration.js';
import { editMapWalls } from '../mapWalls.js';
import { recordDomainAction, type VersionedActionPatch } from './actionBus.js';

export const mapAuthoringRouter = {
  domain: 'mapAuthoring' as const,

  executeSetActiveMap(params: {
    sessionId: string;
    mapId: string;
    actorSocketId?: string;
  }): VersionedActionPatch<{ mapId: string }> | null {
    if (!getMap(params.mapId)) return null;
    setActiveMap(params.sessionId, params.mapId);
    return recordDomainAction({
      sessionId: params.sessionId,
      domain: 'mapAuthoring',
      action: 'map:setActive',
      actorRole: 'dm',
      actorSocketId: params.actorSocketId,
      patch: { mapId: params.mapId },
    });
  },

  executeRenameMap(params: {
    sessionId: string;
    mapId: string;
    name: string;
    actorSocketId?: string;
  }): VersionedActionPatch<{ mapId: string; name: string }> | null {
    if (!getMap(params.mapId)) return null;
    renameMap(params.mapId, params.name);
    return recordDomainAction({
      sessionId: params.sessionId,
      domain: 'mapAuthoring',
      action: 'map:rename',
      actorRole: 'dm',
      actorSocketId: params.actorSocketId,
      patch: { mapId: params.mapId, name: params.name },
    });
  },

  executeReorderMaps(params: {
    sessionId: string;
    orderedIds: string[];
    actorSocketId?: string;
  }): VersionedActionPatch<{ orderedIds: string[] }> | null {
    const ids = params.orderedIds.filter((id) => typeof id === 'string').slice(0, 500);
    if (!ids.length) return null;
    reorderMaps(params.sessionId, ids);
    return recordDomainAction({
      sessionId: params.sessionId,
      domain: 'mapAuthoring',
      action: 'map:reorder',
      actorRole: 'dm',
      actorSocketId: params.actorSocketId,
      patch: { orderedIds: ids },
    });
  },

  executeSetSharedPartyVision(params: {
    sessionId: string;
    mapId: string;
    enabled: boolean;
    actorSocketId?: string;
  }): VersionedActionPatch<{ mapId: string; enabled: boolean }> | null {
    if (!setSharedPartyVision(params.sessionId, params.mapId, params.enabled)) return null;
    return recordDomainAction({
      sessionId: params.sessionId,
      domain: 'mapAuthoring',
      action: 'fog:setPartyVision',
      actorRole: 'dm',
      actorSocketId: params.actorSocketId,
      patch: { mapId: params.mapId, enabled: params.enabled },
    });
  },

  executeSetExplorationMode(params: {
    sessionId: string;
    mapId: string;
    mode: 'remembered' | 'revealed' | 'off';
    actorSocketId?: string;
  }): VersionedActionPatch<{ mapId: string; mode: 'remembered' | 'revealed' | 'off' }> | null {
    if (!setExplorationMode(params.sessionId, params.mapId, params.mode)) return null;
    return recordDomainAction({
      sessionId: params.sessionId,
      domain: 'mapAuthoring',
      action: 'fog:setExploration',
      actorRole: 'dm',
      actorSocketId: params.actorSocketId,
      patch: { mapId: params.mapId, mode: params.mode },
    });
  },

  executeResetExploration(params: {
    sessionId: string;
    mapId: string;
    actorSocketId?: string;
  }): VersionedActionPatch<{ mapId: string }> | null {
    if (!resetExploration(params.sessionId, params.mapId)) return null;
    return recordDomainAction({
      sessionId: params.sessionId,
      domain: 'mapAuthoring',
      action: 'fog:resetExploration',
      actorRole: 'dm',
      actorSocketId: params.actorSocketId,
      patch: { mapId: params.mapId },
    });
  },

  executeSetVisionFog(params: {
    sessionId: string;
    mapId: string;
    layer: FogLayer;
    enabled: boolean;
    actorSocketId?: string;
  }): VersionedActionPatch<{ mapId: string; layer: FogLayer; enabled: boolean }> | null {
    if (!setVisionFog(params.sessionId, params.mapId, params.layer, params.enabled)) return null;
    return recordDomainAction({
      sessionId: params.sessionId,
      domain: 'mapAuthoring',
      action: 'fog:setVision',
      actorRole: 'dm',
      actorSocketId: params.actorSocketId,
      patch: { mapId: params.mapId, layer: params.layer, enabled: params.enabled },
    });
  },

  executeSetFogLayer(params: {
    sessionId: string;
    mapId: string;
    layer: FogLayer;
    enabled: boolean;
    actorSocketId?: string;
  }): VersionedActionPatch<{ mapId: string; layer: FogLayer; enabled: boolean }> | null {
    if (!getMap(params.mapId)) return null;
    setFogLayer(params.mapId, params.layer, params.enabled);
    return recordDomainAction({
      sessionId: params.sessionId,
      domain: 'mapAuthoring',
      action: 'fog:setLayer',
      actorRole: 'dm',
      actorSocketId: params.actorSocketId,
      patch: { mapId: params.mapId, layer: params.layer, enabled: params.enabled },
    });
  },

  executePaintFog(params: {
    sessionId: string;
    mapId: string;
    layer: FogLayer;
    cells: string[];
    reveal: boolean;
    actorSocketId?: string;
  }): VersionedActionPatch<{ mapId: string; layer: FogLayer; cellCount: number; reveal: boolean }> | null {
    const map = getMap(params.mapId);
    if (!map || map.sessionId !== params.sessionId) return null;
    if (!paintFog(params.mapId, params.layer, params.cells, params.reveal)) return null;
    return recordDomainAction({
      sessionId: params.sessionId,
      domain: 'mapAuthoring',
      action: 'fog:paint',
      actorRole: 'dm',
      actorSocketId: params.actorSocketId,
      patch: {
        mapId: params.mapId,
        layer: params.layer,
        cellCount: params.cells.length,
        reveal: params.reveal,
      },
    });
  },

  executeCoverFog(params: {
    sessionId: string;
    mapId: string;
    layer: FogLayer;
    actorSocketId?: string;
  }): VersionedActionPatch<{ mapId: string; layer: FogLayer }> | null {
    const map = getMap(params.mapId);
    if (!map || map.sessionId !== params.sessionId) return null;
    coverFog(params.mapId, params.layer);
    return recordDomainAction({
      sessionId: params.sessionId,
      domain: 'mapAuthoring',
      action: 'fog:cover',
      actorRole: 'dm',
      actorSocketId: params.actorSocketId,
      patch: { mapId: params.mapId, layer: params.layer },
    });
  },

  executeEditWalls(params: {
    sessionId: string;
    mapId: string;
    edit: WallEdit;
    actorSocketId?: string;
  }): { ok: true; envelope: VersionedActionPatch<{ mapId: string }> } | { ok: false; error: string } {
    const error = editMapWalls(params.sessionId, params.mapId, params.edit);
    if (error) return { ok: false, error };
    const envelope = recordDomainAction({
      sessionId: params.sessionId,
      domain: 'mapAuthoring',
      action: 'map:editWalls',
      actorRole: 'dm',
      actorSocketId: params.actorSocketId,
      patch: { mapId: params.mapId },
    });
    return { ok: true, envelope };
  },

  executeUpdateMapEnvironment(params: {
    sessionId: string;
    mapId: string;
    settings: Partial<MapEnvironment>;
    actorSocketId?: string;
  }): VersionedActionPatch<{ mapId: string; updatedKeys: string[] }> | null {
    if (!updateMapEnvironment(params.sessionId, params.mapId, params.settings)) return null;
    return recordDomainAction({
      sessionId: params.sessionId,
      domain: 'mapAuthoring',
      action: 'map:setEnvironment',
      actorRole: 'dm',
      actorSocketId: params.actorSocketId,
      patch: { mapId: params.mapId, updatedKeys: Object.keys(params.settings) },
    });
  },
};
