import { describe, expect, it, beforeEach } from 'vitest';
import {
  createEmptyNormalizedGameState,
  normalizeSnapshot,
} from '../../shared/gameStoreNormalizer.js';
import type { StateSnapshot } from '../../shared/types.js';
import {
  clearDomainActions,
  combatRouter,
  libraryRouter,
  listDomainActions,
  mapAuthoringRouter,
  movementRouter,
} from './routers/index.js';
import {
  createCharacter,
  createMap,
  createMonsterTemplate,
  createSession,
  createToken,
  getCharacter,
  getMap,
  getToken,
  instantiateMonster,
  setActiveMap,
  setSharedPartyVision,
  updateMapEnvironment,
} from './sessions.js';
import { editMapWalls } from './mapWalls.js';
import { buildSnapshot } from './visibility.js';

function makeRealSnapshot(): { snapshot: StateSnapshot; pcTokenId: string } {
  const s = createSession('V3 Norm Test');
  const map = createMap(s.id, { name: 'Crypt', imagePath: '/uploads/crypt.png' });
  setActiveMap(s.id, map.id);
  setSharedPartyVision(s.id, map.id, false);
  editMapWalls(s.id, map.id, {
    add: { id: 'wall-1', ax: 0, ay: 0, bx: 100, by: 0 },
  });
  editMapWalls(s.id, map.id, {
    add: { id: 'door-1', ax: 100, ay: 0, bx: 150, by: 0, door: true, open: false },
  });
  updateMapEnvironment(s.id, map.id, {
    lights: [
      {
        id: 'light-1',
        x: 200,
        y: 200,
        radiusFt: 20,
        heightFt: 6,
        color: 'warm',
        intensity: 1,
        flicker: true,
      },
    ],
  });
  const char = createCharacter(s.id, { name: 'Druk', maxHp: 44 });
  const tpl = createMonsterTemplate(s.id, { name: 'Goblin', maxHp: 7 });
  const mon = instantiateMonster(tpl.id)!;
  const tok1 = createToken({ mapId: map.id, kind: 'pc', refId: char.id, x: 100, y: 100 });
  createToken({ mapId: map.id, kind: 'monster', refId: mon.id, x: 300, y: 300 });
  const snapshot = buildSnapshot(s.id, 'dm', map.id, 'dm-sock')!;
  return { snapshot, pcTokenId: tok1.id };
}

describe('Phase 1 — Normalized Client Store & Domain Routers', () => {
  it('normalizes entities into O(1) lookup maps and preserves exact references across single-token movement', () => {
    const empty = createEmptyNormalizedGameState();
    const { snapshot: snap1, pcTokenId } = makeRealSnapshot();
    const state1 = normalizeSnapshot(empty, snap1, 1);

    expect(state1.hasSnapshot).toBe(true);
    expect(state1.seq).toBe(1);
    expect(state1.tokensById[pcTokenId].x).toBe(100);
    expect(state1.doorsById['door-1'].open).toBe(false);
    expect(state1.wallsById['wall-1'].bx).toBe(100);
    expect(state1.lightsById['light-1'].radiusFt).toBe(20);
    expect(state1.mapVisionById[snap1.map!.id].sharedPartyVision).toBe(false);

    // Move only pcTokenId; every other slice must retain exact referential equality (===)
    const snap2: StateSnapshot = {
      ...snap1,
      tokens: snap1.tokens.map((t) =>
        t.id === pcTokenId ? { ...t, x: 150, y: 125 } : t,
      ),
    };
    const state2 = normalizeSnapshot(state1, snap2, 2);

    expect(state2.seq).toBe(2);
    expect(state2.tokensById[pcTokenId].x).toBe(150);
    // Unchanged slices preserve exact references so subscribed React components never re-render
    expect(state2.creaturesById).toBe(state1.creaturesById);
    expect(state2.charactersById).toBe(state1.charactersById);
    expect(state2.monstersById).toBe(state1.monstersById);
    expect(state2.mapsById).toBe(state1.mapsById);
    expect(state2.doorsById).toBe(state1.doorsById);
    expect(state2.lightsById).toBe(state1.lightsById);
    expect(state2.wallsById).toBe(state1.wallsById);
    expect(state2.pingsById).toBe(state1.pingsById);
    expect(state2.spellEffectsById).toBe(state1.spellEffectsById);
    expect(state2.combatState).toBe(state1.combatState);
    expect(state2.initiativeOrder).toBe(state1.initiativeOrder);
    expect(state2.mapVisionById).toBe(state1.mapVisionById);
  });

  describe('Server Domain Routers & Versioned Action Bus', () => {
    let sessionId: string;
    let mapId: string;

    beforeEach(() => {
      const session = createSession('V3 Router Test');
      sessionId = session.id;
      const map = createMap(sessionId, {
        name: 'Dungeon Floor',
        imagePath: '/uploads/floor.png',
      });
      mapId = map.id;
      clearDomainActions(sessionId);
    });

    it('routes library, movement, mapAuthoring (including sharedPartyVision), and combat actions with sequential versioned envelopes', async () => {
      // 1. Library router: create character & spawn token
      const { character } = libraryRouter.executeCreateCharacter({
        sessionId,
        payload: { name: 'Varis', maxHp: 35 },
        actorRole: 'dm',
      });
      const spawnEnv = libraryRouter.executeSpawnToken({
        sessionId,
        mapId,
        kind: 'pc',
        refId: character.id,
        x: 50,
        y: 50,
        actorRole: 'dm',
      });
      expect(spawnEnv).not.toBeNull();
      const tokenId = spawnEnv!.patch.tokenId;

      // 2. Movement router: move token & toggle lantern
      const moveRes = await movementRouter.executeMoveToken({
        sessionId,
        tokenId,
        x: 150,
        y: 200,
        actorRole: 'dm',
        recordExploration: false,
      });
      expect(moveRes.ok).toBe(true);
      expect(getToken(tokenId)?.x).toBe(150);

      const lanternEnv = movementRouter.executeSetLantern({
        sessionId,
        tokenId,
        enabled: true,
        actorRole: 'dm',
      });
      expect(lanternEnv?.patch.enabled).toBe(true);
      expect(getToken(tokenId)?.carriedLantern).toBe(true);

      // 3. MapAuthoring router: toggle sharedPartyVision (PR #195) & exploration mode
      const partyVisEnv = mapAuthoringRouter.executeSetSharedPartyVision({
        sessionId,
        mapId,
        enabled: false,
      });
      expect(partyVisEnv?.patch.enabled).toBe(false);
      expect(getMap(mapId)?.sharedPartyVision).toBe(false);

      // 4. Combat router: apply damage & set condition
      const dmgEnv = combatRouter.executeApplyDamage({
        sessionId,
        kind: 'pc',
        refId: character.id,
        amount: 10,
        actorRole: 'dm',
      });
      expect(dmgEnv?.patch.beforeHp).toBe(35);
      expect(dmgEnv?.patch.afterHp).toBe(25);
      expect(getCharacter(character.id)?.curHp).toBe(25);

      const allActions = listDomainActions(sessionId);
      expect(allActions.map((a) => a.seq)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(allActions.map((a) => `${a.domain}:${a.action}`)).toEqual([
        'library:character:create',
        'library:token:spawn',
        'movement:token:move',
        'movement:token:setLantern',
        'mapAuthoring:fog:setPartyVision',
        'combat:entity:damage',
      ]);
    });
  });
});
