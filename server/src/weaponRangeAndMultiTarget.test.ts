import { afterEach, describe, expect, it, vi } from 'vitest';
import { evaluateWeaponRange, formatTetherRangePill, formatWeaponRange, parseWeaponRange } from '../../shared/weaponRange.js';
import { inferAbilityActionCost } from '../../shared/spellPrep.js';
import { withDiceSource } from '../../shared/dice.js';
import type { SheetAbility, Weapon } from '../../shared/types.js';
import { registerSocketHandlers } from './socketHandlers.js';
import { dropConn, setConn, type IOServer } from './connections.js';
import {
  applyDamage,
  claimCharacter,
  clearCondition,
  createCharacter,
  createMap,
  createMonsterTemplate,
  createSession,
  createToken,
  getCharacter,
  getMonster,
  instantiateMonster,
  listRollLog,
  setActiveMap,
  setSheetAbility,
} from './sessions.js';
import { getSpell } from './spells/srd.js';

const connections: string[] = [];
afterEach(() => {
  for (const id of connections.splice(0)) dropConn(id);
  vi.restoreAllMocks();
});

function createTestSocket(sessionId: string, mapId: string, role: 'dm' | 'player' = 'dm') {
  let connect!: (socket: unknown) => void;
  const io = {
    on: (_: string, handler: typeof connect) => {
      connect = handler;
    },
    to: () => ({ emit: () => {} }),
  };
  registerSocketHandlers(io as unknown as IOServer, { livePhysics: false });
  const handlers = new Map<string, (payload: unknown) => void>();
  const id = `multi-target-${Math.random()}`;
  connections.push(id);
  const emit = vi.fn();
  connect({
    id,
    on: (event: string, handler: (payload: unknown) => void) => handlers.set(event, handler),
    emit,
  });
  setConn(id, { sessionId, role, viewMapId: mapId, playerId: null });
  return { id, emit, send: (event: string, payload: unknown) => handlers.get(event)!(payload) };
}

describe('shared weapon range parser & evaluator', () => {
  it('parses melee, reach, thrown, ranged, and custom range strings', () => {
    const longsword: Weapon = { name: 'Longsword', kind: 'melee', damage: '1d8', damageType: 'slashing' };
    expect(parseWeaponRange(longsword)).toMatchObject({ normalFt: 5 });
    expect(formatWeaponRange(parseWeaponRange(longsword))).toBe('5 ft');

    const glaive: Weapon = { name: 'Glaive', kind: 'melee', damage: '1d10', damageType: 'slashing', tags: ['Heavy', 'Reach'] };
    expect(parseWeaponRange(glaive)).toMatchObject({ normalFt: 10, reach: true });
    expect(evaluateWeaponRange(glaive, 10).status).toBe('normal');
    expect(evaluateWeaponRange(glaive, 15).status).toBe('out');

    const dagger: Weapon = { name: 'Dagger', kind: 'melee', damage: '1d4', damageType: 'piercing' };
    expect(parseWeaponRange(dagger)).toMatchObject({ normalFt: 20, longFt: 60, thrown: true });
    expect(evaluateWeaponRange(dagger, 15)).toMatchObject({ status: 'normal', pillText: '15 ft' });
    expect(evaluateWeaponRange(dagger, 35)).toMatchObject({ status: 'long', pillText: '35 ft · Long' });
    expect(evaluateWeaponRange(dagger, 70)).toMatchObject({ status: 'out', pillText: '70 ft · Out' });

    const shortbow: Weapon = { name: 'Shortbow', kind: 'ranged', damage: '1d6', damageType: 'piercing', range: '80/320 ft' };
    expect(parseWeaponRange(shortbow)).toMatchObject({ normalFt: 80, longFt: 320 });
    expect(evaluateWeaponRange(shortbow, 80).status).toBe('normal');
    expect(evaluateWeaponRange(shortbow, 120).status).toBe('long');
    expect(evaluateWeaponRange(shortbow, 325).status).toBe('out');
  });

  it('infers action, bonus action, and reaction costs for spells and abilities', () => {
    expect(inferAbilityActionCost(getSpell('Healing Word')!)).toBe('bonus');
    expect(inferAbilityActionCost(getSpell('Misty Step')!)).toBe('bonus');
    expect(inferAbilityActionCost(getSpell('Shield')!)).toBe('reaction');
    expect(inferAbilityActionCost(getSpell('Fireball')!)).toBe('action');
    expect(inferAbilityActionCost({ name: 'Cunning Strike', type: 'ability', actionType: 'bonus' })).toBe('bonus');
  });

  it('updates midpoint tether range pills live as dragged token distance crosses normal, long, and out-of-range thresholds', () => {
    const longsword: Weapon = { name: 'Longsword', kind: 'melee', damage: '1d8', damageType: 'slashing' };
    const handaxe: Weapon = { name: 'Handaxe', kind: 'melee', damage: '1d6', damageType: 'slashing' };

    // Hovering a 5-ft melee weapon while dragging from 25 ft -> 5 ft:
    expect(formatTetherRangePill(25, { hoveredWeapon: longsword })).toEqual({
      midLabel: '25 ft · Out',
      outOfRange: true,
    });
    expect(formatTetherRangePill(5, { hoveredWeapon: longsword })).toEqual({
      midLabel: '5 ft',
      outOfRange: false,
    });

    // Weapons-only loadout (Longsword 5 ft + Handaxe 20/60 ft) while dragging from 75 ft -> 35 ft -> 15 ft:
    const weaponsOnlyList = [longsword, handaxe];
    expect(formatTetherRangePill(75, { weaponsOnlyList })).toEqual({
      midLabel: '75 ft · Out',
      outOfRange: true,
    });
    expect(formatTetherRangePill(35, { weaponsOnlyList })).toEqual({
      midLabel: '35 ft · Long',
      outOfRange: false,
    });
    expect(formatTetherRangePill(15, { weaponsOnlyList })).toEqual({
      midLabel: '15 ft',
      outOfRange: false,
    });
  });
});

describe('automated Armor of Agathys, Aid, and multi-target tether spells', () => {
  it('Armor of Agathys grants 5*level temp HP to self, adds a cold ward condition, and auto-clears it when temp HP drops to 0', () => {
    const session = createSession('Agathys test');
    const map = createMap(session.id, { name: 'Arena' });
    setActiveMap(session.id, map.id);
    const caster = createCharacter(session.id, {
      name: 'Warlock',
      className: 'Warlock',
      level: 5,
      maxHp: 38,
      curHp: 20,
      stats: { STR: 10, DEX: 14, CON: 14, INT: 10, WIS: 12, CHA: 18 },
    });
    const casterTok = createToken({ mapId: map.id, kind: 'pc', refId: caster.id, x: 100, y: 100 });
    const enemy = instantiateMonster(createMonsterTemplate(session.id, { name: 'Orc', maxHp: 30 }).id)!;
    const enemyTok = createToken({ mapId: map.id, kind: 'monster', refId: enemy.id, x: 150, y: 100 });
    const agathys: SheetAbility = { ...getSpell('Armor of Agathys')!, id: 'agathys', source: 'srd' };
    setSheetAbility('pc', caster.id, agathys);

    const client = createTestSocket(session.id, map.id, 'player');
    claimCharacter(caster.id, client.id);
    client.send('ability:roll', {
      kind: 'pc',
      refId: caster.id,
      abilityId: agathys.id,
      castLevel: 3,
      targetTokenId: enemyTok.id,
    });

    const afterCast = getCharacter(caster.id)!;
    expect(afterCast.tempHp).toBe(15);
    expect(afterCast.curHp).toBe(20);
    expect(getMonster(enemy.id)!.curHp).toBe(30);
    expect(afterCast.conditions.some((c) => /Armor of Agathys \(15 cold\)/i.test(c.label))).toBe(true);
    void casterTok;

    // Partial hit leaves 5 temp HP -> ward remains active.
    applyDamage('pc', caster.id, 10);
    expect(getCharacter(caster.id)!.tempHp).toBe(5);
    expect(getCharacter(caster.id)!.conditions.some((c) => /Armor of Agathys/i.test(c.label))).toBe(true);

    // Depleting temp HP to 0 automatically removes the Armor of Agathys ward.
    applyDamage('pc', caster.id, 8);
    const afterDepleted = getCharacter(caster.id)!;
    expect(afterDepleted.tempHp).toBe(0);
    expect(afterDepleted.curHp).toBe(17);
    expect(afterDepleted.conditions.some((c) => /Armor of Agathys/i.test(c.label))).toBe(false);
  });

  it('Aid buffs up to 3 creatures maxHp & curHp by 5*(level-1), avoids stacking on recast, and unwinds maxHp when cleared', () => {
    const session = createSession('Aid test');
    const map = createMap(session.id, { name: 'Arena' });
    setActiveMap(session.id, map.id);
    const cleric = createCharacter(session.id, {
      name: 'Cleric',
      className: 'Cleric',
      level: 7,
      maxHp: 45,
      curHp: 30,
      stats: { STR: 12, DEX: 10, CON: 14, INT: 10, WIS: 18, CHA: 12 },
    });
    const fighter = createCharacter(session.id, {
      name: 'Fighter',
      className: 'Fighter',
      level: 7,
      maxHp: 60,
      curHp: 60,
    });
    const rogue = createCharacter(session.id, {
      name: 'Rogue',
      className: 'Rogue',
      level: 7,
      maxHp: 40,
      curHp: 25,
    });
    const tCleric = createToken({ mapId: map.id, kind: 'pc', refId: cleric.id, x: 100, y: 100 });
    const tFighter = createToken({ mapId: map.id, kind: 'pc', refId: fighter.id, x: 150, y: 100 });
    const tRogue = createToken({ mapId: map.id, kind: 'pc', refId: rogue.id, x: 200, y: 100 });

    const aid: SheetAbility = { ...getSpell('Aid')!, id: 'aid', source: 'srd' };
    setSheetAbility('pc', cleric.id, aid);
    const dm = createTestSocket(session.id, map.id, 'dm');

    // Cast Aid at level 2 (+5 HP) on all 3 party members.
    dm.send('ability:roll', {
      kind: 'pc',
      refId: cleric.id,
      abilityId: aid.id,
      castLevel: 2,
      targetTokenIds: [tCleric.id, tFighter.id, tRogue.id],
    });

    expect(getCharacter(cleric.id)).toMatchObject({ maxHp: 50, curHp: 35 });
    expect(getCharacter(fighter.id)).toMatchObject({ maxHp: 65, curHp: 65 });
    expect(getCharacter(rogue.id)).toMatchObject({ maxHp: 45, curHp: 30 });

    // Recasting Aid at level 3 (+10 HP) unwinds the +5 first rather than stacking to +15.
    dm.send('ability:roll', {
      kind: 'pc',
      refId: cleric.id,
      abilityId: aid.id,
      castLevel: 3,
      targetTokenIds: [tFighter.id],
    });
    const fighterUpcast = getCharacter(fighter.id)!;
    expect(fighterUpcast).toMatchObject({ maxHp: 70, curHp: 70 });
    expect(fighterUpcast.conditions.filter((c) => c.combatEffect?.aidMaxHpBonus)).toHaveLength(1);

    // Clearing the Aid condition restores maxHp to 60 and clamps curHp from 70 -> 60.
    const aidCond = fighterUpcast.conditions.find((c) => c.combatEffect?.aidMaxHpBonus)!;
    clearCondition('pc', fighter.id, aidCond.id);
    expect(getCharacter(fighter.id)).toMatchObject({ maxHp: 60, curHp: 60 });
  });

  it('applies multi-target Bless, Bane, Mass Healing Word, and upcast Hold Person across chosen map targets', () => {
    const session = createSession('Multi-target spells');
    const map = createMap(session.id, { name: 'Arena' });
    setActiveMap(session.id, map.id);
    const cleric = createCharacter(session.id, {
      name: 'Cleric',
      className: 'Cleric',
      level: 7,
      maxHp: 50,
      curHp: 20,
      stats: { STR: 10, DEX: 12, CON: 14, INT: 10, WIS: 18, CHA: 12 },
    });
    const ally = createCharacter(session.id, {
      name: 'Paladin',
      className: 'Paladin',
      level: 7,
      maxHp: 60,
      curHp: 25,
    });
    const banditA = instantiateMonster(createMonsterTemplate(session.id, {
      name: 'Bandit A',
      creatureType: 'Humanoid',
      maxHp: 30,
      stats: { STR: 10, DEX: 12, CON: 10, INT: 10, WIS: 8, CHA: 8 },
    }).id)!;
    const banditB = instantiateMonster(createMonsterTemplate(session.id, {
      name: 'Bandit B',
      creatureType: 'Humanoid',
      maxHp: 30,
      stats: { STR: 10, DEX: 12, CON: 10, INT: 10, WIS: 8, CHA: 8 },
    }).id)!;

    const tCleric = createToken({ mapId: map.id, kind: 'pc', refId: cleric.id, x: 100, y: 100 });
    const tAlly = createToken({ mapId: map.id, kind: 'pc', refId: ally.id, x: 150, y: 100 });
    const tBanditA = createToken({ mapId: map.id, kind: 'monster', refId: banditA.id, x: 200, y: 100 });
    const tBanditB = createToken({ mapId: map.id, kind: 'monster', refId: banditB.id, x: 250, y: 100 });

    const bless: SheetAbility = { ...getSpell('Bless')!, id: 'bless', source: 'srd' };
    const bane: SheetAbility = { ...getSpell('Bane')!, id: 'bane', source: 'srd' };
    const mhw: SheetAbility = { ...getSpell('Mass Healing Word')!, id: 'mhw', source: 'srd' };
    const holdPerson: SheetAbility = { ...getSpell('Hold Person')!, id: 'hold-person', source: 'srd' };
    for (const s of [bless, bane, mhw, holdPerson]) setSheetAbility('pc', cleric.id, s);

    const dm = createTestSocket(session.id, map.id, 'dm');

    // 1. Multi-target Bless attaches Bless (+1d4) to both allies and Concentration: Bless on caster.
    dm.send('ability:roll', {
      kind: 'pc',
      refId: cleric.id,
      abilityId: bless.id,
      castLevel: 1,
      targetTokenIds: [tCleric.id, tAlly.id],
    });
    expect(getCharacter(cleric.id)!.conditions.some((c) => /Bless \(\+1d4\)/i.test(c.label))).toBe(true);
    expect(getCharacter(ally.id)!.conditions.some((c) => /Bless \(\+1d4\)/i.test(c.label))).toBe(true);

    // 2. Multi-target Mass Healing Word heals all selected targets at once.
    withDiceSource((sides) => sides.map(() => 3), () => {
      dm.send('ability:roll', {
        kind: 'pc',
        refId: cleric.id,
        abilityId: mhw.id,
        castLevel: 3,
        targetTokenIds: [tCleric.id, tAlly.id],
      });
    });
    // 2024 Mass Healing Word: 2d4 + WIS(4) = 6 + 4 = 10 HP each!
    expect(getCharacter(cleric.id)!.curHp).toBe(30);
    expect(getCharacter(ally.id)!.curHp).toBe(35);

    // 3. Multi-target Bane rolls CHA saves for each bandit (roll 2 fails vs DC 15).
    withDiceSource((sides) => sides.map(() => 2), () => {
      dm.send('ability:roll', {
        kind: 'pc',
        refId: cleric.id,
        abilityId: bane.id,
        castLevel: 1,
        targetTokenIds: [tBanditA.id, tBanditB.id],
      });
    });
    expect(getMonster(banditA.id)!.conditions.some((c) => /Bane \(-1d4\)/i.test(c.label))).toBe(true);
    expect(getMonster(banditB.id)!.conditions.some((c) => /Bane \(-1d4\)/i.test(c.label))).toBe(true);

    // 4. Upcast Hold Person (L3 -> 2 humanoids) rolls WIS saves for both bandits and applies Hold Person paralysis!
    withDiceSource((sides) => sides.map(() => 3), () => {
      dm.send('ability:roll', {
        kind: 'pc',
        refId: cleric.id,
        abilityId: holdPerson.id,
        castLevel: 3,
        targetTokenIds: [tBanditA.id, tBanditB.id],
      });
    });
    expect(getMonster(banditA.id)!.conditions.some((c) => c.combatEffect?.spell === 'Hold Person')).toBe(true);
    expect(getMonster(banditB.id)!.conditions.some((c) => c.combatEffect?.spell === 'Hold Person')).toBe(true);
    expect(listRollLog(session.id).length).toBeGreaterThanOrEqual(4);
  });
});
