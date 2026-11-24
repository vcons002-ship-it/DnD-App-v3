import { describe, expect, it, vi } from 'vitest';
import { hasLineOfSight, stopAtWalls } from '../../shared/mapWalls.js';
import { visionContains } from '../../shared/playerVision.js';
import { moveWallEndpoint, snapAngle45, wallEndpointHandles } from '../../shared/wallGeometry.js';
import { dropConn, setConn, type IOServer } from './connections.js';
import { duplicateMapFeatures, moveMapFeatures } from './mapFeatureDelete.js';
import { editMapWalls, setWallDoor } from './mapWalls.js';
import {
  claimCharacter,
  createCharacter,
  createMap,
  createSession,
  createToken,
  getMap,
  getMonster,
  getToken,
  setActiveMap,
  updateMapEnvironment,
} from './sessions.js';
import { registerSocketHandlers } from './socketHandlers.js';
import { peekUndo, popUndo } from './undo.js';
import { buildSnapshot } from './visibility.js';

describe('Map feature editor improvements', () => {
  it('records incremental undo for adding walls, cutting doors, moving walls, erasing sections, and deleting walls', () => {
    const s = createSession('Undo walls');
    const m = createMap(s.id, { name: 'Keep' });

    expect(
      editMapWalls(
        s.id,
        m.id,
        { add: { id: 'w1', kind: 'rectangle', ax: 100, ay: 100, bx: 500, by: 120 } },
        { recordUndo: true },
      ),
    ).toBeNull();
    expect(peekUndo(s.id)).toBe('Add wall');
    expect(getMap(m.id)!.walls).toHaveLength(1);

    // Cut a door, then undo the door cut: restores original wall and removes auto-created door token.
    expect(
      editMapWalls(
        s.id,
        m.id,
        { door: { wallId: 'w1', id: 'd1', ax: 240, ay: 110, bx: 300, by: 110 } },
        { recordUndo: true },
      ),
    ).toBeNull();
    expect(peekUndo(s.id)).toBe('Cut door');
    const doorWall = getMap(m.id)!.walls!.find((w) => w.id === 'd1')!;
    expect(doorWall.door).toBe(true);
    const doorTokId = doorWall.tokenId!;
    expect(getToken(doorTokId)).toBeTruthy();

    popUndo(s.id)!.run();
    expect(getToken(doorTokId)).toBeNull();
    expect(getMap(m.id)!.walls!.map((w) => w.id)).toEqual(['w1']);

    // Erase a section, then undo it.
    expect(
      editMapWalls(
        s.id,
        m.id,
        { eraseArea: { ax: 250, ay: 90, bx: 320, by: 130 } },
        { recordUndo: true },
      ),
    ).toBeNull();
    expect(peekUndo(s.id)).toBe('Erase wall section');
    expect(hasLineOfSight({ x: 285, y: 50 }, { x: 285, y: 180 }, getMap(m.id)!.walls!)).toBe(true);

    popUndo(s.id)!.run();
    expect(hasLineOfSight({ x: 285, y: 50 }, { x: 285, y: 180 }, getMap(m.id)!.walls!)).toBe(false);

    // Undo the initial wall addition itself.
    expect(peekUndo(s.id)).toBe('Add wall');
    popUndo(s.id)!.run();
    expect(getMap(m.id)!.walls).toEqual([]);
  });

  it('cuts doors cleanly on curved walls and where multiple walls meet at the doorway', () => {
    const s = createSession('Doors on curves & junctions');
    const m = createMap(s.id, { name: 'Tower & Hall' });

    // 1. Curved circular tower wall with an off-tangent chord drag.
    expect(
      editMapWalls(s.id, m.id, {
        add: { id: 'tower', kind: 'circle', ax: 100, ay: 100, bx: 300, by: 300, thickness: 12 },
      }),
    ).toBeNull();
    expect(hasLineOfSight({ x: 200, y: 200 }, { x: 360, y: 200 }, getMap(m.id)!.walls!)).toBe(false);
    expect(
      editMapWalls(s.id, m.id, {
        door: { wallId: 'tower', id: 'tower-door', ax: 296, ay: 175, bx: 296, by: 225 },
      }),
    ).toBeNull();
    expect(hasLineOfSight({ x: 200, y: 200 }, { x: 360, y: 200 }, getMap(m.id)!.walls!)).toBe(false);
    expect(setWallDoor(s.id, m.id, 'tower-door', true)).toBeNull();
    expect(hasLineOfSight({ x: 200, y: 200 }, { x: 360, y: 200 }, getMap(m.id)!.walls!)).toBe(true);

    // 2. Two separate walls meeting end-to-end right in the middle of the doorway, plus a T-junction stub.
    const m2 = createMap(s.id, { name: 'Junction' });
    editMapWalls(s.id, m2.id, { add: { id: 'left-seg', kind: 'rectangle', ax: 0, ay: 195, bx: 200, by: 205 } });
    editMapWalls(s.id, m2.id, { add: { id: 'right-seg', kind: 'rectangle', ax: 200, ay: 195, bx: 400, by: 205 } });
    editMapWalls(s.id, m2.id, { add: { id: 't-stub', kind: 'rectangle', ax: 196, ay: 195, bx: 204, by: 208 } });
    expect(hasLineOfSight({ x: 200, y: 150 }, { x: 200, y: 250 }, getMap(m2.id)!.walls!)).toBe(false);

    expect(
      editMapWalls(s.id, m2.id, {
        door: { wallId: 'left-seg', id: 'junction-door', ax: 175, ay: 200, bx: 225, by: 200 },
      }),
    ).toBeNull();
    // Closed door still blocks sight.
    expect(hasLineOfSight({ x: 200, y: 150 }, { x: 200, y: 250 }, getMap(m2.id)!.walls!)).toBe(false);
    // Opening the single junction door clears sight across all three meeting wall pieces.
    expect(setWallDoor(s.id, m2.id, 'junction-door', true)).toBeNull();
    expect(hasLineOfSight({ x: 200, y: 150 }, { x: 200, y: 250 }, getMap(m2.id)!.walls!)).toBe(true);
  });

  it('toggles lights on/off without losing settings and records undo for socket light placement and edits', async () => {
    const s = createSession('Light toggle & undo');
    const m = createMap(s.id, { name: 'Crypt' });
    setActiveMap(s.id, m.id);
    updateMapEnvironment(s.id, m.id, { enabled: true, lighting: 'dungeon', heavyDarkness: true, lights: [] });

    const human = createCharacter(s.id, { name: 'Human', race: 'Human' });
    claimCharacter(human.id, 'p-sock');
    createToken({ mapId: m.id, kind: 'pc', refId: human.id, x: 100, y: 100 });

    const handlers = new Map<string, (p: any) => unknown>();
    let connect!: (socket: any) => void;
    const io = { on: (_: string, cb: typeof connect) => { connect = cb; }, to: () => ({ emit: vi.fn() }) };
    registerSocketHandlers(io as unknown as IOServer, { livePhysics: false });
    const dmId = 'dm-light-' + s.id;
    connect({ id: dmId, on: (ev: string, fn: (p: any) => unknown) => handlers.set(ev, fn), emit: vi.fn() });

    try {
      setConn(dmId, { sessionId: s.id, role: 'dm', viewMapId: m.id, playerId: null });
      await handlers.get('map:placeLight')!({ mapId: m.id, x: 600, y: 100 });
      expect(getMap(m.id)!.environment!.lights).toHaveLength(1);
      expect(peekUndo(s.id)).toBe('Place light');

      // Lit torch at (600, 100) is visible to the 0 ft Human in heavy darkness.
      expect(visionContains(buildSnapshot(s.id, 'player', null, 'p-sock')!.playerVision, 600, 100)).toBe(true);

      // Turn all lights off via map:setEnvironment: preserves the light record with enabled=false, extinguishes sight, and records undo.
      const placed = getMap(m.id)!.environment!.lights[0];
      await handlers.get('map:setEnvironment')!({
        mapId: m.id,
        settings: { lights: [{ ...placed, enabled: false, color: 'cool', radiusFt: 30 }] },
      });
      expect(getMap(m.id)!.environment!.lights[0]).toMatchObject({ id: placed.id, enabled: false, color: 'cool', radiusFt: 30 });
      expect(visionContains(buildSnapshot(s.id, 'player', null, 'p-sock')!.playerVision, 600, 100)).toBe(false);
      expect(peekUndo(s.id)).toBe('Edit map lights');

      // Undo restores the lit state; second undo removes the placed light.
      popUndo(s.id)!.run();
      expect(getMap(m.id)!.environment!.lights[0].enabled).toBeUndefined();
      expect(visionContains(buildSnapshot(s.id, 'player', null, 'p-sock')!.playerVision, 600, 100)).toBe(true);

      popUndo(s.id)!.run();
      expect(getMap(m.id)!.environment!.lights).toEqual([]);
    } finally {
      dropConn(dmId);
    }
  });

  it('converts barriers between Wall, Window, and Arch with undo', () => {
    const s = createSession('Barrier conversion');
    const m = createMap(s.id, { name: 'Chapel' });
    editMapWalls(s.id, m.id, { add: { id: 'b1', kind: 'rectangle', ax: 100, ay: 195, bx: 400, by: 205 } });

    const blockedMove = () => stopAtWalls({ x: 250, y: 150 }, { x: 250, y: 250 }, 10, getMap(m.id)!.walls!).y < 200;
    expect(hasLineOfSight({ x: 250, y: 150 }, { x: 250, y: 250 }, getMap(m.id)!.walls!)).toBe(false);
    expect(blockedMove()).toBe(true);

    // Convert Wall -> Window: blocks movement, allows sight.
    expect(editMapWalls(s.id, m.id, { barrierType: { wallIds: ['b1'], kind: 'window' } }, { recordUndo: true })).toBeNull();
    expect(peekUndo(s.id)).toBe('Convert barrier type');
    expect(hasLineOfSight({ x: 250, y: 150 }, { x: 250, y: 250 }, getMap(m.id)!.walls!)).toBe(true);
    expect(blockedMove()).toBe(true);

    // Convert Window -> Arch: allows both movement and sight.
    expect(editMapWalls(s.id, m.id, { barrierType: { wallIds: ['b1'], kind: 'arch' } }, { recordUndo: true })).toBeNull();
    expect(hasLineOfSight({ x: 250, y: 150 }, { x: 250, y: 250 }, getMap(m.id)!.walls!)).toBe(true);
    expect(blockedMove()).toBe(false);

    // Undo Arch -> Window, then Undo Window -> solid Wall.
    popUndo(s.id)!.run();
    expect(getMap(m.id)!.walls![0].window).toBe(true);
    expect(blockedMove()).toBe(true);

    popUndo(s.id)!.run();
    expect(getMap(m.id)!.walls![0].window).toBeUndefined();
    expect(hasLineOfSight({ x: 250, y: 150 }, { x: 250, y: 250 }, getMap(m.id)!.walls!)).toBe(false);
  });

  it('updates single and bulk door states (open, locked, secret, DC) with undo', () => {
    const s = createSession('Door inspector');
    const m = createMap(s.id, { name: 'Vault' });
    setActiveMap(s.id, m.id);
    editMapWalls(s.id, m.id, { add: { id: 'w', kind: 'rectangle', ax: 0, ay: 195, bx: 600, by: 205 } });
    editMapWalls(s.id, m.id, { door: { wallId: 'w', id: 'd1', ax: 150, ay: 200, bx: 210, by: 200 } });
    editMapWalls(s.id, m.id, { door: { wallId: 'd1-part-1', id: 'd2', ax: 350, ay: 200, bx: 410, by: 200 } });

    const pc = createCharacter(s.id, { name: 'Scout' });
    claimCharacter(pc.id, 'scout-sock');
    createToken({ mapId: m.id, kind: 'pc', refId: pc.id, x: 180, y: 240 });

    const d1TokId = getMap(m.id)!.walls!.find((w) => w.id === 'd1')!.tokenId!;
    // Visible door token appears in player snapshot initially.
    expect(buildSnapshot(s.id, 'player', null, 'scout-sock')!.tokens.some((t) => t.id === d1TokId)).toBe(true);

    // Mark both doors locked (DC 18) and secret (hidden from players).
    expect(
      editMapWalls(
        s.id,
        m.id,
        { doorState: { doorIds: ['d1', 'd2'], locked: true, hidden: true, objectDc: 18 } },
        { recordUndo: true },
      ),
    ).toBeNull();
    expect(peekUndo(s.id)).toBe('Edit door');
    const d1Tok = getToken(d1TokId)!;
    expect(d1Tok.isHidden).toBe(true);
    expect(getMonster(d1Tok.refId)!.objectDc).toBe(18);
    expect(getMonster(d1Tok.refId)!.conditions.some((c) => c.label === 'Locked')).toBe(true);
    // Secret door token is hidden from player snapshot.
    expect(buildSnapshot(s.id, 'player', null, 'scout-sock')!.tokens.some((t) => t.id === d1TokId)).toBe(false);
    // Locked door refuses player-style setWallDoor open until unlocked.
    expect(setWallDoor(s.id, m.id, 'd1', true)).toContain('locked');

    // Undo restores unlocked, unhidden, DC 12 state.
    popUndo(s.id)!.run();
    expect(getToken(d1TokId)!.isHidden).toBe(false);
    expect(getMonster(d1Tok.refId)!.objectDc).toBe(12);
    expect(getMonster(d1Tok.refId)!.conditions.some((c) => c.label === 'Locked')).toBe(false);
  });

  it('duplicates and moves mixed wall + light selections with atomic undo, and reshapes endpoints & angles', () => {
    const s = createSession('Duplicate, move & endpoints');
    const m = createMap(s.id, { name: 'Corridor' });
    editMapWalls(s.id, m.id, { add: { id: 'pillar', kind: 'circle', ax: 80, ay: 80, bx: 120, by: 120, thickness: 4 } });
    updateMapEnvironment(s.id, m.id, {
      enabled: true,
      lights: [{ id: 'sconce', x: 100, y: 70, radiusFt: 20, heightFt: 8, intensity: 1, color: 'warm', flicker: true }],
    });

    // Duplicate pillar + sconce together by (+96, 0).
    expect(
      duplicateMapFeatures(
        s.id,
        m.id,
        [{ sourceId: 'pillar', newId: 'pillar-copy' }],
        [{ sourceId: 'sconce', newId: 'sconce-copy' }],
        96,
        0,
      ),
    ).toBeNull();
    expect(peekUndo(s.id)).toBe('Duplicate map features');
    expect(getMap(m.id)!.walls!.map((w) => w.id)).toEqual(['pillar', 'pillar-copy']);
    expect(getMap(m.id)!.environment!.lights.map((l) => [l.id, l.x, l.y])).toEqual([
      ['sconce', 100, 70],
      ['sconce-copy', 196, 70],
    ]);

    // Move the duplicated pair by (0, +48) and undo both steps.
    expect(moveMapFeatures(s.id, m.id, ['pillar-copy'], ['sconce-copy'], 0, 48)).toBeNull();
    expect(peekUndo(s.id)).toBe('Move map features');
    expect(getMap(m.id)!.environment!.lights.find((l) => l.id === 'sconce-copy')).toMatchObject({ x: 196, y: 118 });

    popUndo(s.id)!.run();
    expect(getMap(m.id)!.environment!.lights.find((l) => l.id === 'sconce-copy')).toMatchObject({ x: 196, y: 70 });

    popUndo(s.id)!.run();
    expect(getMap(m.id)!.walls!.map((w) => w.id)).toEqual(['pillar']);
    expect(getMap(m.id)!.environment!.lights.map((l) => l.id)).toEqual(['sconce']);

    // Endpoint drag handles & 45-degree angle snap math.
    const snapped = snapAngle45({ x: 100, y: 100 }, { x: 200, y: 108 });
    expect(snapped.y).toBeCloseTo(100, 5);
    expect(snapped.x).toBeGreaterThan(199);

    const lineWall = { id: 'ln', ax: 50, ay: 50, bx: 150, by: 50, thickness: 6 };
    expect(wallEndpointHandles(lineWall)).toEqual([
      { x: 50, y: 50 },
      { x: 150, y: 50 },
    ]);
    expect(moveWallEndpoint(lineWall, 1, { x: 220, y: 90 })).toMatchObject({ ax: 50, ay: 50, bx: 220, by: 90 });

    const rotRect = { id: 'rr', kind: 'rectangle' as const, ax: 100, ay: 100, bx: 200, by: 140, rotation: 30 };
    const handles = wallEndpointHandles(rotRect);
    expect(handles).toHaveLength(4);
    const opp = handles[0];
    const resized = moveWallEndpoint(rotRect, 2, { x: handles[2].x + 20, y: handles[2].y + 10 });
    // Opposite corner 0 stays pinned in world space!
    const nextHandles = wallEndpointHandles(resized);
    expect(nextHandles[0].x).toBeCloseTo(opp.x, 5);
    expect(nextHandles[0].y).toBeCloseTo(opp.y, 5);
  });
});
