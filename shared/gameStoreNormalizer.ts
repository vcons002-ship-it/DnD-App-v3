import type {
  Annotation,
  Character,
  MapImage,
  MapState,
  Measurement,
  Monster,
  MonsterPublic,
  Role,
  StateSnapshot,
  Token,
} from './types.js';
import type { MapWall } from './mapWalls.js';
import type { MapEnvironmentLight } from './mapEnvironment.js';
import { equal } from './stateDelta.js';

export type NormalizedDoor = MapWall & { mapId: string };
export type NormalizedWall = MapWall & { mapId: string };
export type NormalizedLight = MapEnvironmentLight & { mapId: string };
export type NormalizedCreature = Character | Monster | MonsterPublic;

export type NormalizedCombatState = {
  round: number;
  activeTurnTokenId: string | null;
  initiativePending: boolean;
  hideDmRolls: boolean;
};

export type NormalizedMapVision = {
  mapId: string;
  sharedPartyVision: boolean;
  explorationMode: 'remembered' | 'revealed';
  mapVisionEnabled: boolean;
  tokenVisionEnabled: boolean;
  mapFogEnabled: boolean;
  tokenFogEnabled: boolean;
};

export type NormalizedGameState = {
  hasSnapshot: boolean;
  seq: number;
  sessionCode: string | null;
  sessionName: string;
  role: Role | null;
  activeMapId: string | null;
  viewingMapId: string | null;
  creaturesById: Record<string, NormalizedCreature>;
  charactersById: Record<string, Character>;
  characterIds: string[];
  monstersById: Record<string, Monster | MonsterPublic>;
  monsterIds: string[];
  tokensById: Record<string, Token>;
  tokenIds: string[];
  mapsById: Record<string, MapState>;
  mapIds: string[];
  doorsById: Record<string, NormalizedDoor>;
  lightsById: Record<string, NormalizedLight>;
  wallsById: Record<string, NormalizedWall>;
  pingsById: Record<string, Measurement>;
  spellEffectsById: Record<string, Annotation>;
  mapImagesById: Record<string, MapImage>;
  combatState: NormalizedCombatState;
  initiativeOrder: string[];
  mapVisionById: Record<string, NormalizedMapVision>;
};

const EMPTY_COMBAT_STATE: NormalizedCombatState = {
  round: 0,
  activeTurnTokenId: null,
  initiativePending: false,
  hideDmRolls: false,
};

export function createEmptyNormalizedGameState(): NormalizedGameState {
  return {
    hasSnapshot: false,
    seq: 0,
    sessionCode: null,
    sessionName: '',
    role: null,
    activeMapId: null,
    viewingMapId: null,
    creaturesById: {},
    charactersById: {},
    characterIds: [],
    monstersById: {},
    monsterIds: [],
    tokensById: {},
    tokenIds: [],
    mapsById: {},
    mapIds: [],
    doorsById: {},
    lightsById: {},
    wallsById: {},
    pingsById: {},
    spellEffectsById: {},
    mapImagesById: {},
    combatState: EMPTY_COMBAT_STATE,
    initiativeOrder: [],
    mapVisionById: {},
  };
}

function stabilizeRecordById<T extends { id: string }>(
  prevRecord: Record<string, T>,
  prevIds: string[],
  items: readonly T[],
): { byId: Record<string, T>; ids: string[] } {
  let recordChanged = Object.keys(prevRecord).length !== items.length;
  let orderChanged = prevIds.length !== items.length;
  const nextRecord: Record<string, T> = {};
  const nextIds: string[] = new Array(items.length);

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const id = item.id;
    nextIds[i] = id;
    if (!orderChanged && prevIds[i] !== id) orderChanged = true;

    const existing = prevRecord[id];
    if (existing !== undefined && (existing === item || equal(existing, item))) {
      nextRecord[id] = existing;
    } else {
      nextRecord[id] = item;
      recordChanged = true;
    }
  }

  return {
    byId: recordChanged ? nextRecord : prevRecord,
    ids: orderChanged ? nextIds : prevIds,
  };
}

function stabilizeSimpleRecord<T extends { id: string }>(
  prevRecord: Record<string, T>,
  items: readonly T[],
): Record<string, T> {
  let changed = Object.keys(prevRecord).length !== items.length;
  const nextRecord: Record<string, T> = {};
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const existing = prevRecord[item.id];
    if (existing !== undefined && (existing === item || equal(existing, item))) {
      nextRecord[item.id] = existing;
    } else {
      nextRecord[item.id] = item;
      changed = true;
    }
  }
  return changed ? nextRecord : prevRecord;
}

function computeInitiativeOrder(tokens: readonly Token[]): string[] {
  const fighting = tokens.filter((t) => t.initiative !== null || t.inCombatEffective);
  fighting.sort((a, b) => {
    if (a.initiative === null && b.initiative === null) return 0;
    if (a.initiative === null) return 1;
    if (b.initiative === null) return -1;
    return b.initiative - a.initiative;
  });
  return fighting.map((t) => t.id);
}

function extractVisionSlice(map: MapState): NormalizedMapVision {
  return {
    mapId: map.id,
    sharedPartyVision: map.sharedPartyVision !== false,
    explorationMode: map.explorationMode ?? 'remembered',
    mapVisionEnabled: !!map.mapVisionEnabled,
    tokenVisionEnabled: !!map.tokenVisionEnabled,
    mapFogEnabled: !!map.mapFogEnabled,
    tokenFogEnabled: !!map.tokenFogEnabled,
  };
}

/**
 * Normalize a `StateSnapshot` into fine-grained entity records while preserving
 * exact object/array references (`===`) for every slice whose data has not changed.
 */
export function normalizeSnapshot(
  prev: NormalizedGameState,
  snapshot: StateSnapshot,
  seq?: number,
): NormalizedGameState {
  const nextSeq = seq !== undefined ? seq : prev.seq + 1;

  const chars = stabilizeRecordById(prev.charactersById, prev.characterIds, snapshot.characters ?? []);
  const mons = stabilizeRecordById(prev.monstersById, prev.monsterIds, snapshot.monsters ?? []);
  const toks = stabilizeRecordById(prev.tokensById, prev.tokenIds, snapshot.tokens ?? []);

  let creaturesById = prev.creaturesById;
  if (
    !prev.hasSnapshot ||
    chars.byId !== prev.charactersById ||
    mons.byId !== prev.monstersById
  ) {
    creaturesById = { ...chars.byId, ...mons.byId };
  }

  const rawMaps = (snapshot.maps ?? []).map((m) =>
    snapshot.map && snapshot.map.id === m.id ? snapshot.map : m,
  );
  if (snapshot.map && !rawMaps.some((m) => m.id === snapshot.map!.id)) {
    rawMaps.push(snapshot.map);
  }
  const maps = stabilizeRecordById(prev.mapsById, prev.mapIds, rawMaps);

  let doorsById = prev.doorsById;
  let wallsById = prev.wallsById;
  let lightsById = prev.lightsById;
  let mapVisionById = prev.mapVisionById;

  if (!prev.hasSnapshot || maps.byId !== prev.mapsById) {
    const rawDoors: NormalizedDoor[] = [];
    const rawWalls: NormalizedWall[] = [];
    const rawLights: NormalizedLight[] = [];
    const nextVisionById: Record<string, NormalizedMapVision> = {};
    let visionChanged = Object.keys(prev.mapVisionById).length !== rawMaps.length;

    for (const m of rawMaps) {
      for (const w of m.walls ?? []) {
        const wallWithMap: NormalizedWall = { ...w, mapId: m.id };
        rawWalls.push(wallWithMap);
        if (w.door) {
          rawDoors.push(wallWithMap);
        }
      }
      for (const l of m.environment?.lights ?? []) {
        rawLights.push({ ...l, mapId: m.id });
      }
      const nextVis = extractVisionSlice(m);
      const prevVis = prev.mapVisionById[m.id];
      if (prevVis && equal(prevVis, nextVis)) {
        nextVisionById[m.id] = prevVis;
      } else {
        nextVisionById[m.id] = nextVis;
        visionChanged = true;
      }
    }

    doorsById = stabilizeSimpleRecord(prev.doorsById, rawDoors);
    wallsById = stabilizeSimpleRecord(prev.wallsById, rawWalls);
    lightsById = stabilizeSimpleRecord(prev.lightsById, rawLights);
    mapVisionById = visionChanged ? nextVisionById : prev.mapVisionById;
  }

  const pingsById = stabilizeSimpleRecord(prev.pingsById, snapshot.measurements ?? []);
  const spellEffectsById = stabilizeSimpleRecord(prev.spellEffectsById, snapshot.annotations ?? []);
  const mapImagesById = stabilizeSimpleRecord(prev.mapImagesById, snapshot.mapImages ?? []);

  const nextCombatState: NormalizedCombatState = {
    round: snapshot.round ?? 0,
    activeTurnTokenId: snapshot.activeTurnTokenId ?? null,
    initiativePending: !!snapshot.initiativePending,
    hideDmRolls: !!snapshot.hideDmRolls,
  };
  const combatState = equal(prev.combatState, nextCombatState)
    ? prev.combatState
    : nextCombatState;

  const computedOrder = computeInitiativeOrder(snapshot.tokens ?? []);
  const initiativeOrder = equal(prev.initiativeOrder, computedOrder)
    ? prev.initiativeOrder
    : computedOrder;

  return {
    hasSnapshot: true,
    seq: nextSeq,
    sessionCode: snapshot.sessionCode ?? null,
    sessionName: snapshot.sessionName ?? '',
    role: snapshot.role ?? null,
    activeMapId: snapshot.activeMapId ?? null,
    viewingMapId: snapshot.map?.id ?? snapshot.activeMapId ?? null,
    creaturesById,
    charactersById: chars.byId,
    characterIds: chars.ids,
    monstersById: mons.byId,
    monsterIds: mons.ids,
    tokensById: toks.byId,
    tokenIds: toks.ids,
    mapsById: maps.byId,
    mapIds: maps.ids,
    doorsById,
    lightsById,
    wallsById,
    pingsById,
    spellEffectsById,
    mapImagesById,
    combatState,
    initiativeOrder,
    mapVisionById,
  };
}
