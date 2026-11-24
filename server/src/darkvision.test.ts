import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PC_DARKVISION_FT,
  defaultSpeciesDarkvisionFt,
  extractDarkvisionFromTraits,
  resolveBaseDarkvisionFt,
  resolveCreatureDarkvisionFt,
  sanitizeDarkvisionFt,
} from '../../shared/darkvision.js';
import { visionContains, visionShowsAffinity } from '../../shared/playerVision.js';
import { exportSheetJSON, parseSheetJSON, parseSheetText } from '../../shared/sheetIO.js';
import {
  claimCharacter,
  clearCondition,
  createCharacter,
  createCharacterFromLibrary,
  createMap,
  createMonsterTemplate,
  createSession,
  createToken,
  getCharacter,
  getMonster,
  getToken,
  instantiateMonster,
  moveToken,
  setActiveMap,
  setCondition,
  setSharedPartyVision,
  updateCharacter,
  updateMapEnvironment,
  updateMonster,
  type MonsterInput,
} from './sessions.js';
import { db } from './db.js';
import { buildSnapshot } from './visibility.js';
import { recordWalkingMove } from './walking.js';
import { editMapWalls } from './mapWalls.js';
import { getLibraryCreature, saveLibraryCharacter, saveLibraryCreature } from './library.js';
import { getSrd } from './creatures/srd.js';

describe('shared darkvision resolver', () => {
  it('resolves canonical 5e species defaults and specificity ordering', () => {
    expect(defaultSpeciesDarkvisionFt('Human')).toBe(0);
    expect(defaultSpeciesDarkvisionFt('Halfling')).toBe(0);
    expect(defaultSpeciesDarkvisionFt('Goliath')).toBe(0);
    expect(defaultSpeciesDarkvisionFt('Kenku')).toBe(0);
    expect(defaultSpeciesDarkvisionFt('Elf')).toBe(60);
    expect(defaultSpeciesDarkvisionFt('Half-Elf')).toBe(60);
    expect(defaultSpeciesDarkvisionFt('Half-Orc')).toBe(60);
    expect(defaultSpeciesDarkvisionFt('Gnome')).toBe(60);
    expect(defaultSpeciesDarkvisionFt('Dragonborn')).toBe(60);
    expect(defaultSpeciesDarkvisionFt('Tiefling')).toBe(60);
    expect(defaultSpeciesDarkvisionFt('Aasimar')).toBe(60);
    expect(defaultSpeciesDarkvisionFt('Dwarf')).toBe(120);
    expect(defaultSpeciesDarkvisionFt('Orc')).toBe(120);
    expect(defaultSpeciesDarkvisionFt('Drow')).toBe(120);
    expect(defaultSpeciesDarkvisionFt('Deep Gnome')).toBe(120);
    expect(defaultSpeciesDarkvisionFt('')).toBeUndefined();
    expect(defaultSpeciesDarkvisionFt('Customfolk')).toBeUndefined();
  });

  it('extracts trait darkvision without misreading spells or anti-darkvision spell text', () => {
    expect(
      extractDarkvisionFromTraits([
        { name: 'Senses and skills', description: 'Blindsight 10 ft., darkvision 60 ft.; passive Perception 13.' },
      ]),
    ).toBe(60);
    expect(
      extractDarkvisionFromTraits(
        [],
        [
          { id: 't1', name: 'Darkvision (Orc)', type: 'ability', meta: 'Passive · 120 ft', description: 'Dim light within 120 feet.' },
        ],
      ),
    ).toBe(120);
    expect(
      extractDarkvisionFromTraits(
        [],
        [
          { id: 't2', name: 'Darkvision', type: 'ability', description: 'See better in dim light and darkness within 60 feet.' },
        ],
      ),
    ).toBe(60);
    // Prepared Darkvision spell (type === 'spell') and Darkness spell descriptions never grant passive darkvision.
    expect(
      extractDarkvisionFromTraits(
        [
          {
            name: 'Darkness',
            description: 'Nonmagical light and Darkvision cannot illuminate or see through it.',
          },
        ],
        [{ id: 's1', name: 'Darkvision', type: 'spell', description: 'Grant willing creature darkvision 150 ft.' }],
      ),
    ).toBeUndefined();
    // Devil's Sight still extracts 120 ft.
    expect(
      extractDarkvisionFromTraits([
        { name: "Devil's Sight", description: 'Darkvision 120 ft.; magical darkness does not block this darkvision.' },
      ]),
    ).toBe(120);
  });

  it('prioritizes explicit override, handles fallbacks, and folds active condition boosts', () => {
    expect(sanitizeDarkvisionFt(-15)).toBe(0);
    expect(sanitizeDarkvisionFt(999)).toBe(600);
    expect(sanitizeDarkvisionFt(null)).toBeUndefined();
    expect(sanitizeDarkvisionFt('')).toBeUndefined();

    // Explicit 0 overrides Elf species default.
    expect(resolveBaseDarkvisionFt({ kind: 'pc', race: 'Elf', darkvisionFt: 0 })).toBe(0);
    // Blank PC falls back to 60 ft for legacy compatibility; monster without traits falls back to 0 ft.
    expect(resolveBaseDarkvisionFt({ kind: 'pc', race: '' })).toBe(DEFAULT_PC_DARKVISION_FT);
    expect(resolveBaseDarkvisionFt({ kind: 'monster' })).toBe(0);
    // Condition boost raises base 0 ft Human or 60 ft Elf without lowering Dwarf 120 ft.
    expect(
      resolveCreatureDarkvisionFt({
        kind: 'pc',
        race: 'Human',
        conditions: [{ label: 'Darkvision 60 ft', isConcentration: false }],
      }),
    ).toBe(60);
    expect(
      resolveCreatureDarkvisionFt({
        kind: 'pc',
        race: 'Dwarf',
        conditions: [{ label: 'Darkvision 60 ft', isConcentration: false }],
      }),
    ).toBe(120);
    expect(
      resolveCreatureDarkvisionFt({
        kind: 'pc',
        race: 'Human',
        conditions: [{ label: 'Darkvision 150 ft', isConcentration: false }],
      }),
    ).toBe(150);
  });
});

describe('per-creature darkvision on maps', () => {
  it('enforces 0 ft, 60 ft, and 120 ft darkvision in heavy darkness while keeping distant lights visible', async () => {
    const s = createSession('Per-creature heavy darkness');
    const map = createMap(s.id, { name: 'Cavern' });
    setActiveMap(s.id, map.id);
    setSharedPartyVision(s.id, map.id, false);
    updateMapEnvironment(s.id, map.id, { enabled: true, lighting: 'dungeon', heavyDarkness: true, lights: [] });

    const human = createCharacter(s.id, { name: 'Human', race: 'Human' });
    const elf = createCharacter(s.id, { name: 'Elf', race: 'Elf' });
    const dwarf = createCharacter(s.id, { name: 'Dwarf', race: 'Dwarf' });
    claimCharacter(human.id, 'p-human');
    claimCharacter(elf.id, 'p-elf');
    claimCharacter(dwarf.id, 'p-dwarf');

    const humanTok = createToken({ mapId: map.id, kind: 'pc', refId: human.id, x: 100, y: 100 });
    createToken({ mapId: map.id, kind: 'pc', refId: elf.id, x: 100, y: 100 });
    createToken({ mapId: map.id, kind: 'pc', refId: dwarf.id, x: 100, y: 100 });

    const goblinTmpl = createMonsterTemplate(s.id, { name: 'Goblin', maxHp: 7 });
    // Distances from (100,100) at 10 px/ft: 400 px = 40 ft, 800 px = 80 ft, 1100 px = 110 ft, 1400 px = 140 ft
    const at40 = createToken({ mapId: map.id, kind: 'monster', refId: instantiateMonster(goblinTmpl.id)!.id, x: 500, y: 100 });
    const at80 = createToken({ mapId: map.id, kind: 'monster', refId: instantiateMonster(goblinTmpl.id)!.id, x: 900, y: 100 });
    const at110 = createToken({ mapId: map.id, kind: 'monster', refId: instantiateMonster(goblinTmpl.id)!.id, x: 1200, y: 100 });
    const at140 = createToken({ mapId: map.id, kind: 'monster', refId: instantiateMonster(goblinTmpl.id)!.id, x: 1500, y: 100 });

    // Human (0 ft): sees no unlit enemies in heavy darkness, nor unlit explored terrain while walking.
    const humanSnap = buildSnapshot(s.id, 'player', null, 'p-human')!;
    expect(humanSnap.playerVision?.rangeFt).toBe(0);
    expect(humanSnap.tokens.some((t) => t.id === at40.id && !t.sharedSightOnly)).toBe(false);
    expect(humanSnap.exploredTerrain).toEqual([]);
    const beforeWalk = getToken(humanTok.id)!;
    const afterWalk = moveToken(humanTok.id, 100, 600, true)!;
    await recordWalkingMove(beforeWalk, afterWalk, true, false);
    expect(buildSnapshot(s.id, 'player', null, 'p-human')!.exploredTerrain).toEqual([]);
    moveToken(humanTok.id, 100, 100, false, true);

    // Elf (60 ft): personally sees 40 ft, not 80 ft.
    const elfSnap = buildSnapshot(s.id, 'player', null, 'p-elf')!;
    expect(elfSnap.playerVision?.rangeFt).toBe(60);
    expect(elfSnap.tokens.some((t) => t.id === at40.id && !t.sharedSightOnly)).toBe(true);
    expect(elfSnap.tokens.some((t) => t.id === at80.id && !t.sharedSightOnly)).toBe(false);

    // Dwarf (120 ft): personally sees 40 ft, 80 ft, and 110 ft, not 140 ft.
    const dwarfSnap = buildSnapshot(s.id, 'player', null, 'p-dwarf')!;
    expect(dwarfSnap.playerVision?.rangeFt).toBe(120);
    expect(dwarfSnap.tokens.some((t) => t.id === at80.id && !t.sharedSightOnly)).toBe(true);
    expect(dwarfSnap.tokens.some((t) => t.id === at110.id && !t.sharedSightOnly)).toBe(true);
    expect(dwarfSnap.tokens.some((t) => t.id === at140.id && !t.sharedSightOnly)).toBe(false);

    // Turning on a distant torch at 140 ft lets even the 0 ft Human see the lit enemy.
    updateMapEnvironment(s.id, map.id, {
      lights: [{ id: 'far-torch', x: 1500, y: 100, radiusFt: 15, heightFt: 5, intensity: 1, color: 'warm', flicker: true }],
    });
    expect(buildSnapshot(s.id, 'player', null, 'p-human')!.tokens.some((t) => t.id === at140.id && !t.sharedSightOnly)).toBe(true);

    // Carrying a lantern reveals adjacent enemies for a 0 ft Human and records lit exploration on walk.
    updateMapEnvironment(s.id, map.id, { lights: [] });
    db.prepare('UPDATE tokens SET carried_lantern = 1 WHERE id = ?').run(humanTok.id);
    const litHumanSnap = buildSnapshot(s.id, 'player', null, 'p-human')!;
    expect(litHumanSnap.tokens.some((t) => t.id === at40.id && !t.sharedSightOnly)).toBe(false); // 40 ft > 20 ft lantern radius
    expect(visionContains(litHumanSnap.playerVision, 200, 100)).toBe(true);
    const walkLitFrom = getToken(humanTok.id)!;
    const walkLitTo = moveToken(humanTok.id, 300, 100, true)!;
    await recordWalkingMove(walkLitFrom, walkLitTo, true, false);
    expect(buildSnapshot(s.id, 'player', null, 'p-human')!.exploredTerrain!.length).toBeGreaterThan(0);
  });

  it('evaluates wall LOS and darkvision per origin for mixed-darkvision parties', () => {
    const s = createSession('Mixed party wall + darkvision');
    const map = createMap(s.id, { name: 'Hall' });
    editMapWalls(s.id, map.id, { add: { id: 'w1', ax: 300, ay: -200, bx: 300, by: 400 } });
    setActiveMap(s.id, map.id);
    updateMapEnvironment(s.id, map.id, { enabled: true, lighting: 'dungeon', heavyDarkness: true, lights: [] });

    const dwarf = createCharacter(s.id, { name: 'Dwarf', race: 'Dwarf' });
    const human = createCharacter(s.id, { name: 'Human', race: 'Human' });
    claimCharacter(dwarf.id, 'mixed-sock');
    claimCharacter(human.id, 'mixed-sock');

    // Dwarf (120 ft) is behind the wall at x=100; Human (0 ft) has clear LOS at x=800.
    createToken({ mapId: map.id, kind: 'pc', refId: dwarf.id, x: 100, y: 100 });
    createToken({ mapId: map.id, kind: 'pc', refId: human.id, x: 800, y: 100 });
    const foeTmpl = createMonsterTemplate(s.id, { name: 'Goblin', maxHp: 7 });
    const foe = createToken({ mapId: map.id, kind: 'monster', refId: instantiateMonster(foeTmpl.id)!.id, x: 900, y: 100 });

    // Even though foe is within Dwarf's 120 ft radius AND Human has line-of-sight, neither origin both sees it and has darkvision.
    const unlit = buildSnapshot(s.id, 'player', null, 'mixed-sock')!;
    expect(visionContains(unlit.playerVision, foe.x, foe.y)).toBe(false);
    expect(unlit.tokens.some((t) => t.id === foe.id)).toBe(false);

    // Adding a torch near the foe lets the Human see it cleanly.
    updateMapEnvironment(s.id, map.id, {
      lights: [{ id: 'l1', x: 900, y: 100, radiusFt: 15, heightFt: 5, intensity: 1, color: 'warm', flicker: true }],
    });
    const lit = buildSnapshot(s.id, 'player', null, 'mixed-sock')!;
    expect(visionContains(lit.playerVision, foe.x, foe.y)).toBe(true);
    expect(lit.tokens.some((t) => t.id === foe.id)).toBe(true);
  });

  it('uses per-creature darkvision distances for affinity in regular darkness and condition boosts', () => {
    const s = createSession('Regular darkness + conditions');
    const map = createMap(s.id, { name: 'Night Road' });
    setActiveMap(s.id, map.id);
    updateMapEnvironment(s.id, map.id, { enabled: true, lighting: 'night', heavyDarkness: false, lights: [] });

    const human = createCharacter(s.id, { name: 'Human', race: 'Human' });
    const elf = createCharacter(s.id, { name: 'Elf', race: 'Elf' });
    const dwarf = createCharacter(s.id, { name: 'Dwarf', race: 'Dwarf' });
    claimCharacter(human.id, 'r-human');
    claimCharacter(elf.id, 'r-elf');
    claimCharacter(dwarf.id, 'r-dwarf');
    createToken({ mapId: map.id, kind: 'pc', refId: human.id, x: 100, y: 100 });
    createToken({ mapId: map.id, kind: 'pc', refId: elf.id, x: 100, y: 100 });
    createToken({ mapId: map.id, kind: 'pc', refId: dwarf.id, x: 100, y: 100 });

    const humanVision = buildSnapshot(s.id, 'player', null, 'r-human')!.playerVision!;
    const elfVision = buildSnapshot(s.id, 'player', null, 'r-elf')!.playerVision!;
    const dwarfVision = buildSnapshot(s.id, 'player', null, 'r-dwarf')!.playerVision!;

    expect(visionShowsAffinity(humanVision, 150, 100)).toBe(false);
    expect(visionShowsAffinity(elfVision, 600, 100)).toBe(true);
    expect(visionShowsAffinity(elfVision, 900, 100)).toBe(false);
    expect(visionShowsAffinity(dwarfVision, 1200, 100)).toBe(true);

    // Condition boost dynamically expands heavy-darkness vision on a Human PC.
    updateMapEnvironment(s.id, map.id, { lighting: 'dungeon', heavyDarkness: true });
    expect(visionContains(buildSnapshot(s.id, 'player', null, 'r-human')!.playerVision, 850, 100)).toBe(false);
    setCondition('pc', human.id, { id: 'dv-buff', label: 'Darkvision 90 ft', aura: 'blue', isConcentration: false });
    expect(visionContains(buildSnapshot(s.id, 'player', null, 'r-human')!.playerVision, 850, 100)).toBe(true);
    clearCondition('pc', human.id, 'dv-buff');
    expect(visionContains(buildSnapshot(s.id, 'player', null, 'r-human')!.playerVision, 850, 100)).toBe(false);
  });

  it('persists explicit/cleared darkvision across DB, library, SRD, sheet I/O, and hides enemy senses from players', () => {
    const s = createSession('Persistence & privacy');
    const map = createMap(s.id, { name: 'Dungeon' });
    setActiveMap(s.id, map.id);
    updateMapEnvironment(s.id, map.id, { enabled: true, lighting: 'dungeon', heavyDarkness: true });

    const pc = createCharacter(s.id, { name: 'Gnome Scout', race: 'Gnome', darkvisionFt: 90 });
    expect(pc.darkvisionFt).toBe(90);
    const pcTok = createToken({ mapId: map.id, kind: 'pc', refId: pc.id, x: 100, y: 100 });
    expect(getToken(pcTok.id)!.darkvisionFt).toBe(90);

    // Clearing override with null reverts to species auto (Gnome = 60 ft).
    const cleared = updateCharacter(pc.id, { darkvisionFt: null })!;
    expect(cleared.darkvisionFt).toBeUndefined();
    expect(getToken(pcTok.id)!.darkvisionFt).toBe(60);

    // Library round-trip for explicit 0 ft override.
    updateCharacter(pc.id, { darkvisionFt: 0 });
    expect(getCharacter(pc.id)!.darkvisionFt).toBe(0);
    saveLibraryCharacter({ ...getCharacter(pc.id)!, name: 'Dark-Blind Gnome' }, true);
    const restored = createCharacterFromLibrary(s.id, 'Dark-Blind Gnome')!;
    expect(restored.darkvisionFt).toBe(0);

    // Sheet JSON + plain-text round-trip.
    const jsonPatch = parseSheetJSON(exportSheetJSON(restored))!;
    expect(jsonPatch.darkvisionFt).toBe(0);
    const textPatch = parseSheetText('Name: Drow Blade\nRace: Elf\nDarkvision 120 ft.');
    expect(textPatch.darkvisionFt).toBe(120);

    // SRD monster + library + player snapshot privacy.
    expect(getSrd('Goblin')?.darkvisionFt).toBe(60);
    expect(getSrd('Young Red Dragon')?.darkvisionFt).toBe(120);
    expect(getSrd('Bandit')?.darkvisionFt).toBeUndefined();

    const goblinSrd = getSrd('Goblin')!;
    const goblinTmpl = createMonsterTemplate(s.id, { ...goblinSrd, source: 'srd' } as MonsterInput);
    expect(goblinTmpl.darkvisionFt).toBe(60);
    const goblin = instantiateMonster(goblinTmpl.id)!;
    const goblinTok = createToken({ mapId: map.id, kind: 'monster', refId: goblin.id, x: 120, y: 100 });
    expect(getToken(goblinTok.id)!.darkvisionFt).toBe(60);

    updateMonster(goblin.id, { darkvisionFt: 150 });
    expect(getMonster(goblin.id)!.darkvisionFt).toBe(150);
    expect(getToken(goblinTok.id)!.darkvisionFt).toBe(150);

    saveLibraryCreature({ ...getMonster(goblin.id)!, name: 'Far-Seeing Goblin' }, true);
    expect(getLibraryCreature('Far-Seeing Goblin')?.darkvisionFt).toBe(150);

    claimCharacter(pc.id, 'priv-p');
    const dmSnap = buildSnapshot(s.id, 'dm', map.id)!;
    expect(dmSnap.tokens.find((t) => t.id === goblinTok.id)?.darkvisionFt).toBe(150);
    const playerSnap = buildSnapshot(s.id, 'player', null, 'priv-p')!;
    expect(playerSnap.tokens.find((t) => t.id === pcTok.id)?.darkvisionFt).toBe(0);
    expect(playerSnap.tokens.find((t) => t.id === goblinTok.id)?.darkvisionFt).toBeUndefined();
  });
});
