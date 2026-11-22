import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LiveDiceFrame } from '../../shared/liveDiceTypes.js';
import type { Weapon, WeaponTrigger } from '../../shared/types.js';
import { resolveAttack, resolveAttackDamage, resolveTriggeredSpell } from './combat.js';
import { physicalFaces, runLiveCommand } from './liveRolls.js';
import {
  claimCharacter,
  createCharacter,
  createMap,
  createMonsterTemplate,
  createSession,
  createToken,
  getCharacter,
  getMonster,
  getRollEntry,
  instantiateMonster,
  listRollLog,
  setActiveMap,
  setManualDamage,
  setTempHp,
} from './sessions.js';
import { buildSnapshot } from './visibility.js';

afterEach(() => vi.restoreAllMocks());

function mockRandomSequence(values: number[]) {
  let idx = 0;
  return vi.spyOn(Math, 'random').mockImplementation(() => {
    const v = values[Math.min(idx, values.length - 1)];
    idx++;
    return v;
  });
}

function setupArena(opts: { weapon: Weapon; manualDamage?: boolean; targetAc?: number; targetHp?: number; targetType?: string; targetResist?: string[] }) {
  const session = createSession('Weapon Trigger Test');
  const map = createMap(session.id, { name: 'Arena' });
  setActiveMap(session.id, map.id);
  setManualDamage(session.id, opts.manualDamage ?? false);
  const attacker = createCharacter(session.id, {
    name: 'Aldric',
    className: 'Paladin',
    level: 7,
    maxHp: 60,
    curHp: 40,
    stats: { STR: 18, CHA: 16, CON: 14 },
    spellSlots: { '1': { max: 4, used: 0 }, '3': { max: 2, used: 0 } },
    weapons: [opts.weapon],
  });
  const atkTok = createToken({ mapId: map.id, kind: 'pc', refId: attacker.id, x: 50, y: 100 });
  const tpl = createMonsterTemplate(session.id, {
    name: opts.targetType === 'undead' ? 'Ghoul' : 'Bandit',
    armorClass: opts.targetAc ?? 12,
    maxHp: opts.targetHp ?? 100,
    creatureType: opts.targetType ?? 'humanoid',
    resistances: opts.targetResist ?? [],
  });
  const monster = instantiateMonster(tpl.id)!;
  const tgtTok = createToken({ mapId: map.id, kind: 'monster', refId: monster.id, x: 70, y: 100 });
  return { session, map, attacker, atkTok, monster, tgtTok };
}

describe('Weapon Trigger Conditions & Effects', () => {
  it('evaluates all 7 trigger conditions accurately (on-hit, on-crit, on-nat-20, on-d20-at-least, on-damage-max, on-damage-match, on-miss)', () => {
    const triggers: WeaponTrigger[] = [
      { id: 't-hit', name: 'HitSpark', when: 'on-hit', extraDamageDice: '1d4', extraDamageType: 'fire', doubleOnCrit: false },
      { id: 't-crit', name: 'CritBurst', when: 'on-crit', extraDamageDice: '1d4', extraDamageType: 'radiant', doubleOnCrit: false },
      { id: 't-nat20', name: 'Nat20Boom', when: 'on-nat-20', extraDamageDice: '1d4', extraDamageType: 'thunder', doubleOnCrit: false },
      { id: 't-d20-18', name: 'HighRoll', when: 'on-d20-at-least', d20Threshold: 18, extraDamageDice: '1d4', extraDamageType: 'force', doubleOnCrit: false },
      { id: 't-max', name: 'MaxFace', when: 'on-damage-max', extraDamageDice: '1d4', extraDamageType: 'cold', doubleOnCrit: false },
      { id: 't-match', name: 'Doubles', when: 'on-damage-match', extraDamageDice: '1d4', extraDamageType: 'acid', doubleOnCrit: false },
      { id: 't-miss', name: 'Graze', when: 'on-miss', extraDamageDice: '1d4', extraDamageType: 'slashing', doubleOnCrit: false },
    ];
    const weapon: Weapon = {
      name: 'Runeblade',
      kind: 'melee',
      damage: '2d6',
      damageType: 'slashing',
      critThreshold: 19,
      triggers,
    };

    // Case 1: Nat 19 -> hits AC 12, crits (due to critThreshold 19) + d20 >= 18, NOT nat-20, base 2d6 = [6, 6] (max + match)
    // Wait: let's set base 2d6 = [6, 6], each rider d4 = 2
    const arena1 = setupArena({ weapon, targetHp: 200 });
    mockRandomSequence([0.92, 0.99, 0.99, 0.99, 0.99, 0.3, 0.3, 0.3, 0.3, 0.3]);
    // wait: d20 = 19 (0.92), base 2d6 (0.99,0.99 = 6,6) + crit 2d6 (0.99,0.99 = 6,6) + STR 4 = 28;
    // fired: on-hit(2), on-crit(2), on-d20>=18(2), on-damage-max(2), on-damage-match(2) = +10; skipped: on-nat-20 & on-miss!
    resolveAttack(arena1.session.id, 'Aldric', arena1.atkTok.id, arena1.tgtTok.id, 0);
    expect(getMonster(arena1.monster.id)!.curHp).toBe(200 - (24 + 4 + 10));

    // Case 2: Nat 20 -> ALSO fires on-nat-20 (+2 = +12 rider total if base has max & match)
    const arena2 = setupArena({ weapon, targetHp: 200 });
    mockRandomSequence([0.99, 0.99, 0.99, 0.99, 0.99, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3]);
    resolveAttack(arena2.session.id, 'Aldric', arena2.atkTok.id, arena2.tgtTok.id, 0);
    expect(getMonster(arena2.monster.id)!.curHp).toBe(200 - (24 + 4 + 12));

    // Case 3: Miss (Nat 2 vs AC 25) -> ONLY on-miss Graze fires!
    const arena3 = setupArena({ weapon, targetAc: 25, targetHp: 50 });
    mockRandomSequence([0.05, 0.3]); // d20=2 (miss), graze 1d4=2
    resolveAttack(arena3.session.id, 'Aldric', arena3.atkTok.id, arena3.tgtTok.id, 0);
    expect(getMonster(arena3.monster.id)!.curHp).toBe(48);
  });

  it('filters by targetCreatureTypes and rolls rider dice inside the same continuous live tray', async () => {
    const undeadBane: Weapon = {
      name: 'Sunblade',
      kind: 'melee',
      damage: '1d8',
      damageType: 'slashing',
      triggers: [
        {
          id: 'bane-undead',
          name: 'Undead Bane',
          when: 'on-hit',
          targetCreatureTypes: ['undead'],
          extraDamageDice: '2d6',
          extraDamageType: 'radiant',
          doubleOnCrit: true,
        },
      ],
    };
    const undeadArena = setupArena({ weapon: undeadBane, targetType: 'undead', targetHp: 100 });
    mockRandomSequence([0.72, 0.5, 0.5, 0.5]); // d20=15, 1d8=5+4=9, 2d6=[4,4]=8 -> 17 total
    resolveAttack(undeadArena.session.id, 'Aldric', undeadArena.atkTok.id, undeadArena.tgtTok.id, 0);
    expect(getMonster(undeadArena.monster.id)!.curHp).toBe(83);

    const humanArena = setupArena({ weapon: undeadBane, targetType: 'humanoid', targetHp: 100 });
    mockRandomSequence([0.72, 0.5]); // d20=15, 1d8=5+4=9 only (no radiant vs humanoid)
    resolveAttack(humanArena.session.id, 'Aldric', humanArena.atkTok.id, humanArena.tgtTok.id, 0);
    expect(getMonster(humanArena.monster.id)!.curHp).toBe(91);

    const liveArena = setupArena({ weapon: undeadBane, targetType: 'undead', targetHp: 100, targetAc: 1 });
    // Live tray: extra rider dice join the SAME continuous tray with dieRole: 'rider'
    const frames: LiveDiceFrame[] = [];
    await runLiveCommand(
      () => {
        resolveAttack(liveArena.session.id, 'Aldric', liveArena.atkTok.id, liveArena.tgtTok.id, 0);
      },
      (f) => frames.push(f),
      { label: 'Sunblade', roller: 'Aldric', className: 'Paladin', waitForPresentation: async () => {} },
      (sides, publish, meta, _seed, info) => physicalFaces(sides, publish, meta, 4, info),
    );
    const damageFrame = frames.filter((f) => !f.sides.every((s) => s === 20)).at(-1)!;
    expect(damageFrame.sides).toEqual([8, 6, 6]);
    expect(damageFrame.dieRoles).toContain('rider');
    expect(damageFrame.dieLabels?.filter((l) => l === 'Undead Bane').length).toBe(2);
  });

  it('applies condition effects with effectSave, keeps self-buffs on killing blows, and preserves larger temp HP pools', () => {
    const vampWeapon: Weapon = {
      name: 'Bloodletter',
      kind: 'melee',
      damage: '1d8',
      damageType: 'slashing',
      triggers: [
        {
          id: 'knockdown',
          name: 'Shield Bash',
          when: 'on-hit',
          effectSave: 'STR',
          effectDc: 15,
          effect: { conditionLabel: 'Prone', target: 'affected', aura: 'red' },
        },
        {
          id: 'killing-rush',
          name: 'Blood Rush',
          when: 'on-hit',
          effect: { conditionLabel: 'Hasted Surge', target: 'self', aura: 'green' },
        },
        {
          id: 'temp-ward',
          name: 'Blood Ward',
          when: 'on-hit',
          healDice: '1d6',
          healMode: 'temporary',
        },
      ],
    };
    const arena = setupArena({ weapon: vampWeapon, targetHp: 5 });
    // Give attacker 12 existing tempHp first! Rolling 1d6 (max 6) must KEEP 12!
    setTempHp('pc', arena.attacker.id, 12);

    // d20 = 15 (hit), 1d8 = 6 + 4 = 10 -> kills 5 HP Bandit, heal 1d6 = 3 (smaller than 12!), self-buff MUST still apply!
    mockRandomSequence([0.72, 0.7, 0.4]);
    resolveAttack(arena.session.id, 'Aldric', arena.atkTok.id, arena.tgtTok.id, 0);
    expect(getMonster(arena.monster.id)!.curHp).toBe(0);
    expect(getCharacter(arena.attacker.id)!.tempHp).toBe(12);
    expect(getCharacter(arena.attacker.id)!.conditions.some((c) => c.label === 'Hasted Surge')).toBe(true);
  });

  it('auto-casts simple single-target spells immediately without spending slots, and scopes prompted AoE offers safely', () => {
    const spellSword: Weapon = {
      name: 'Staffblade of Storms',
      kind: 'melee',
      damage: '1d6',
      damageType: 'bludgeoning',
      triggers: [
        {
          id: 'auto-bolt',
          name: 'Auto Bolt',
          when: 'on-hit',
          castSpell: { spellName: 'Guiding Bolt', castLevel: 1, castMode: 'auto' },
        },
        {
          id: 'prompt-fireball',
          name: 'Nova Burst',
          when: 'on-crit',
          castSpell: { spellName: 'Fireball', castLevel: 3, castMode: 'prompt' },
        },
      ],
    };
    const arena = setupArena({ weapon: spellSword, targetHp: 200 });
    // Player A owns Aldric; Player B does not
    claimCharacter(arena.attacker.id, 'sock-a', 'player-a');

    // Roll Nat 20 crit:
    // Auto Guiding Bolt resolves automatically without spending slot 1 or slot 3, AND Fireball offer is queued!
    mockRandomSequence([0.99, 0.5, 0.5, 0.72, 0.5, 0.5, 0.5, 0.5]);
    expect(resolveAttack(arena.session.id, 'Aldric', arena.atkTok.id, arena.tgtTok.id, 0)).toBe(true);

    const charAfterHit = getCharacter(arena.attacker.id)!;
    expect(charAfterHit.spellSlots['1'].used).toBe(0);
    expect(charAfterHit.spellSlots['3'].used).toBe(0);

    // Check roll log for Fireball offer & test visibility scoping
    const triggerEntry = listRollLog(arena.session.id).find((r) => (r.triggeredSpells?.length ?? 0) > 0)!;
    expect(triggerEntry).toBeTruthy();
    const offer = triggerEntry.triggeredSpells![0];
    expect(offer.ability.name).toBe('Fireball');

    const ownerSnap = buildSnapshot(arena.session.id, 'player', undefined, 'sock-a', 'player-a')!;
    const strangerSnap = buildSnapshot(arena.session.id, 'player', undefined, 'sock-b', 'player-b')!;
    const dmSnap = buildSnapshot(arena.session.id, 'dm')!;
    expect(ownerSnap.rollLog.find((r) => r.id === triggerEntry.id)?.triggeredSpells?.length).toBe(1);
    expect(strangerSnap.rollLog.find((r) => r.id === triggerEntry.id)?.triggeredSpells).toBeUndefined();
    expect(dmSnap.rollLog.find((r) => r.id === triggerEntry.id)?.triggeredSpells?.length).toBe(1);

    // Resolve triggered Fireball placement at target coordinates, verify 0 slot spend & reject double-use!
    const res1 = resolveTriggeredSpell(arena.session.id, 'Aldric', {
      rollId: triggerEntry.id,
      offerId: offer.id,
      area: {
        mapId: arena.map.id,
        points: [{ x: arena.tgtTok.x, y: arena.tgtTok.y }],
        angle: 0,
      },
    });
    expect(res1).toEqual({ ok: true });
    expect(getCharacter(arena.attacker.id)!.spellSlots['3'].used).toBe(0);
    expect(getRollEntry(triggerEntry.id, arena.session.id)?.triggeredSpells?.[0].used).toBe(true);

    const res2 = resolveTriggeredSpell(arena.session.id, 'Aldric', {
      rollId: triggerEntry.id,
      offerId: offer.id,
      dismiss: true,
    });
    expect(res2.ok).toBe(false);
  });

  it('defers live calculation presentation until same-tray weapon trigger dice finish settling', async () => {
    const solarWeapon: Weapon = {
      name: 'Greatsword',
      kind: 'melee',
      damage: '2d6',
      damageType: 'slashing',
      attackBonus: 100,
      triggers: [
        {
          id: 'solar-flare',
          name: 'Solar Flare',
          when: 'on-hit',
          extraDamageDice: '2d6',
          extraDamageType: 'radiant',
          doubleOnCrit: true,
        },
      ],
    };
    const arena = setupArena({ weapon: solarWeapon, manualDamage: true, targetHp: 200 });
    await runLiveCommand(
      () => {
        expect(resolveAttack(arena.session.id, 'Aldric', arena.atkTok.id, arena.tgtTok.id, 0)).toBe(true);
      },
      () => {},
      { label: 'Attack', roller: 'Aldric', className: 'Paladin', waitForPresentation: async () => {} },
      async (sides) => sides.map(() => 15),
    );
    const attackEntry = listRollLog(arena.session.id).find((r) => r.label === 'Attack')!;
    expect(attackEntry?.pending?.live).toBeTruthy();

    const frames: LiveDiceFrame[] = [];
    await runLiveCommand(
      () => {
        resolveAttackDamage(arena.session.id, 'Aldric', attackEntry.id);
      },
      (f) => frames.push(f),
      { label: 'Greatsword', roller: 'Aldric', className: 'Paladin', waitForPresentation: async () => {} },
      (sides, publish, meta, _seed, info) => physicalFaces(sides, publish, meta, 7, info),
    );

    const calcFrames = frames.filter((f) => !!f.calculation);
    expect(calcFrames.length).toBe(1);
    // Must never fire prematurely on Wave 1 (2d6) before Solar Flare (+2d6) enters the same tray.
    expect(frames.some((f) => f.sides.length === 2 && !!f.calculation)).toBe(false);
    expect(calcFrames[0].sides).toEqual([6, 6, 6, 6]);
    expect(calcFrames[0].dieRoles).toEqual(['base', 'base', 'rider', 'rider']);
    const rolledSum = calcFrames[0].values.reduce<number>((sum, val) => sum + (val ?? 0), 0);
    // Aldric has STR 18 (+4); calculation holds combined weapon + Solar Flare + STR total.
    expect(calcFrames[0].calculation?.damage).toBe(rolledSum + 4);
  });
});
