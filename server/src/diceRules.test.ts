import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  rollRuledDamagePool,
  rollSavingThrow,
  rollWeaponAttack,
  type AttackOutcome,
} from '../../shared/combatMath.js';
import { detectWeaponPassiveRules } from '../../shared/diceRules.js';
import { damageRollBreakdown } from '../../shared/rollBreakdown.js';
import type { LiveDiceFrame } from '../../shared/liveDiceTypes.js';
import type { SheetAbility, Weapon } from '../../shared/types.js';
import {
  resolveAbilityRoll,
  resolveAttack,
  resolveOrbLeap,
  resolveSave,
  resolveSkillRoll,
} from './combat.js';
import { physicalFaces, runLiveCommand } from './liveRolls.js';
import {
  createCharacter,
  createMap,
  createMonsterTemplate,
  createSession,
  createToken,
  getMonster,
  instantiateMonster,
  listRollLog,
  setActiveMap,
  setManualDamage,
} from './sessions.js';

afterEach(() => vi.restoreAllMocks());

function mockRandomSequence(values: number[]) {
  let idx = 0;
  return vi.spyOn(Math, 'random').mockImplementation(() => {
    const v = values[Math.min(idx, values.length - 1)];
    idx++;
    return v;
  });
}

function setupCombat() {
  const session = createSession('DiceRules Test');
  const map = createMap(session.id, { name: 'Arena' });
  setActiveMap(session.id, map.id);
  setManualDamage(session.id, false);
  const spawnMonster = (name: string, opts: { ac?: number; hp?: number; x?: number; resistances?: string[]; creatureType?: string } = {}) => {
    const tpl = createMonsterTemplate(session.id, {
      name,
      armorClass: opts.ac ?? 10,
      maxHp: opts.hp ?? 200,
      resistances: opts.resistances ?? [],
      creatureType: opts.creatureType ?? 'beast',
    });
    const m = instantiateMonster(tpl.id)!;
    const tok = createToken({ mapId: map.id, kind: 'monster', refId: m.id, x: opts.x ?? 100, y: 100 });
    return { monster: m, token: tok };
  };
  return { session, map, spawnMonster };
}

describe('Custom Spell Dice Rules', () => {
  it('supports custom exploding spells (non-Sorcerous Burst) with recursive cap and live burst tray', async () => {
    const { session, map, spawnMonster } = setupCombat();
    const stormSpell: SheetAbility = {
      id: 'custom-storm-crack',
      name: 'Storm Crack',
      type: 'spell',
      level: 1,
      description: 'Hurls crackling lightning that leaps again on max rolls.',
      source: 'custom',
      executionProfile: 'manual',
      roll: {
        kind: 'attack',
        dice: '1d6',
        damageType: 'lightning',
        castingAbility: 'CHA',
        diceRules: {
          exploding: {
            on: 'max',
            limit: 2,
            recursive: true,
            label: 'Storm Crack Surge',
          },
        },
      },
    };
    const caster = createCharacter(session.id, {
      name: 'Lyra',
      className: 'Sorcerer',
      level: 5,
      stats: { CHA: 16 },
      sheetAbilities: [stormSpell],
    });
    createToken({ mapId: map.id, kind: 'pc', refId: caster.id, x: 50, y: 100 });
    const { token: target } = spawnMonster('Dummy', { ac: 10, hp: 100 });

    // d20 = 15 (hit), d6 = 6 (explode #1), d6 = 6 (explode #2 hits cap), d6 = 4 (ignored due to cap? No: 1 base + 2 exploded)
    // Wait: roll 1 = 6 -> explode #1 rolls 6 -> explode #2 rolls 4 (stops at cap 2)
    mockRandomSequence([0.72, 0.99, 0.99, 0.55]);
    const ok = resolveAbilityRoll(session.id, 'Lyra', caster, stormSpell, 1, undefined, target.id);
    expect(ok).toBe(true);
    expect(getMonster(target.refId)!.curHp).toBe(100 - (6 + 6 + 4));

    // Also test limit: 2 caps a 3rd explosion even if the 2nd exploded die rolls 6
    const { token: target2 } = spawnMonster('Dummy2', { ac: 10, hp: 100, x: 150 });
    mockRandomSequence([0.72, 0.99, 0.99, 0.99]);
    resolveAbilityRoll(session.id, 'Lyra', caster, stormSpell, 1, undefined, target2.id);
    expect(getMonster(target2.refId)!.curHp).toBe(100 - (6 + 6 + 6));

    // Verify live continuous tray frames emit burstLinks, exploded dieRole, and explode banner (seed 4 hits 6 on 1d6)
    const frames: LiveDiceFrame[] = [];
    await runLiveCommand(
      () => {
        rollRuledDamagePool({
          title: 'Storm Crack',
          diceExpr: '1d6',
          crit: false,
          damageType: 'lightning',
          diceRules: stormSpell.roll!.diceRules,
        });
      },
      (f) => frames.push(f),
      { label: 'Storm Crack', roller: 'Lyra', className: 'Sorcerer', waitForPresentation: async () => {} },
      (sides, publish, meta, _seedVal, info) => physicalFaces(sides, publish, meta, 1, info),
    );
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.some((f) => f.trayBanner?.title === 'Savage Attacker')).toBe(false);
    expect(frames.some((f) => f.diceTrigger?.kind === 'savage-attacker')).toBe(false);
    const finalFrame = frames.at(-1)!;
    expect(finalFrame.burstLinks?.length).toBeGreaterThan(0);
    expect(finalFrame.dieRoles).toContain('exploded');
    expect(finalFrame.trayBanner?.tone).toBe('explode');
  });

  it('does not emit Savage Attacker banner or trigger on Wave 1 of custom exploding Storm Crack (6d4)', async () => {
    const { session, map, spawnMonster } = setupCombat();
    const storm6d4: SheetAbility = {
      id: 'custom-storm-crack-6d4',
      name: 'Storm Crack',
      type: 'spell',
      level: 0,
      description: 'Hurls crackling lightning that leaps again on max rolls.',
      source: 'custom',
      executionProfile: 'manual',
      roll: {
        kind: 'damage',
        dice: '6d4',
        damageType: 'lightning',
        castingAbility: 'CHA',
        diceRules: { exploding: { on: 'max', limit: 6, recursive: true, label: 'Storm Surge' } },
      },
    };
    const caster = createCharacter(session.id, {
      name: 'Lyra',
      className: 'Sorcerer',
      level: 5,
      stats: { CHA: 16 },
      sheetAbilities: [storm6d4],
    });
    createToken({ mapId: map.id, kind: 'pc', refId: caster.id, x: 50, y: 100 });
    const { token: target } = spawnMonster('Dummy', { ac: 10, hp: 100 });

    const spellFrames: LiveDiceFrame[] = [];
    await runLiveCommand(
      () => {
        resolveAbilityRoll(session.id, 'Lyra', caster, storm6d4, 0, undefined, target.id);
      },
      (f) => spellFrames.push(f),
      { label: 'Storm Crack', roller: 'Lyra', className: 'Sorcerer', waitForPresentation: async () => {} },
      (sides, publish, meta, _seedVal, info) => physicalFaces(sides, publish, meta, 7, info),
    );
    expect(spellFrames.length).toBeGreaterThan(0);
    expect(spellFrames.some((f) => f.trayBanner?.title === 'Savage Attacker')).toBe(false);
    expect(spellFrames.some((f) => f.diceTrigger?.kind === 'savage-attacker')).toBe(false);
  });

  it('supports custom bouncing spells (non-Chromatic Orb) with custom range and maxLeaps', () => {
    const { session, map, spawnMonster } = setupCombat();
    const customBounce: SheetAbility = {
      id: 'arcane-ricochet',
      name: 'Arcane Ricochet',
      type: 'spell',
      level: 1,
      description: 'Ricochets to another target within 45 ft when damage dice match.',
      source: 'custom',
      executionProfile: 'manual',
      roll: {
        kind: 'attack',
        dice: '3d8',
        damageType: 'force',
        castingAbility: 'INT',
        diceRules: {
          matchingDice: {
            minMatches: 2,
            action: 'leap',
            leapRangeFt: 45,
            maxLeaps: 2,
            label: 'Arcane Ricochet',
          },
        },
      },
    };
    const caster = createCharacter(session.id, {
      name: 'Kael',
      className: 'Wizard',
      level: 5,
      stats: { INT: 18 },
      sheetAbilities: [customBounce],
    });
    createToken({ mapId: map.id, kind: 'pc', refId: caster.id, x: 50, y: 100 });
    // Grid default: 50px = 5ft -> 40ft apart = 400px (beyond default 30ft orb range, inside custom 45ft range!)
    const { token: t1 } = spawnMonster('Goblin A', { ac: 5, hp: 100, x: 100 });
    const { token: t2 } = spawnMonster('Goblin B', { ac: 5, hp: 100, x: 500 });
    const { token: t3 } = spawnMonster('Goblin C', { ac: 5, hp: 100, x: 600 });
    const { token: t4 } = spawnMonster('Goblin D', { ac: 5, hp: 100, x: 650 });

    // Every roll = 0.5 -> d20 = 11 (hit), 3d8 = [5, 5, 5] (triple match!)
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    expect(resolveAbilityRoll(session.id, 'Kael', caster, customBounce, 1, undefined, t1.id)).toBe(true);
    const firstLog = listRollLog(session.id).filter((r) => r.apply?.orb).at(-1)!;
    expect(firstLog.apply?.orb).toMatchObject({
      spellName: 'Arcane Ricochet',
      leapRangeFt: 45,
      maxLeaps: 2,
      available: true,
    });

    // Leap 1 across 40ft succeeds (allowed by custom 45ft leapRangeFt)
    expect(resolveOrbLeap(session.id, firstLog.id, t2.id)).toEqual({ ok: true });
    const secondLog = listRollLog(session.id).filter((r) => r.apply?.orb).at(-1)!;
    expect(secondLog.apply?.orb?.available).toBe(true);

    // Leap 2 succeeds and exhausts custom maxLeaps = 2
    expect(resolveOrbLeap(session.id, secondLog.id, t3.id)).toEqual({ ok: true });
    const thirdLog = listRollLog(session.id).filter((r) => r.apply?.orb).at(-1)!;
    expect(thirdLog.apply?.orb?.available).toBe(false);
    expect(resolveOrbLeap(session.id, thirdLog.id, t4.id).ok).toBe(false);
  });

  it('triggers matching-dice bonus-dice and matching-dice effect with saving throw', () => {
    const { session, map, spawnMonster } = setupCombat();
    const spellBonus: SheetAbility = {
      id: 'twin-spark',
      name: 'Twin Spark',
      type: 'spell',
      level: 1,
      description: 'Adds thunder damage on matching dice.',
      source: 'custom',
      executionProfile: 'manual',
      roll: {
        kind: 'attack',
        dice: '2d6',
        damageType: 'lightning',
        castingAbility: 'INT',
        diceRules: {
          matchingDice: {
            minMatches: 2,
            action: 'bonus-dice',
            bonusDice: '1d8',
            bonusDamageType: 'thunder',
            label: 'Resonant Boom',
          },
        },
      },
    };
    const spellEffect: SheetAbility = {
      id: 'staggering-bolt',
      name: 'Staggering Bolt',
      type: 'spell',
      level: 1,
      description: 'Staggers targets when damage dice match.',
      source: 'custom',
      executionProfile: 'manual',
      roll: {
        kind: 'attack',
        dice: '2d6',
        damageType: 'force',
        castingAbility: 'INT',
        diceRules: {
          matchingDice: {
            minMatches: 2,
            action: 'effect',
            effectSave: 'CON',
            effect: { conditionLabel: 'Staggered', target: 'affected', aura: 'red' },
            label: 'Concussive Match',
          },
        },
      },
    };
    const caster = createCharacter(session.id, {
      name: 'Kael',
      className: 'Wizard',
      level: 5,
      stats: { INT: 18 },
      sheetAbilities: [spellBonus, spellEffect],
    });
    createToken({ mapId: map.id, kind: 'pc', refId: caster.id, x: 50, y: 100 });
    const { token: t1 } = spawnMonster('Target1', { ac: 5, hp: 100 });
    const { token: t2 } = spawnMonster('Target2', { ac: 5, hp: 100, x: 150 });

    // d20 = 15 (hit), 2d6 = [4, 4] (match!), bonus 1d8 = [6]
    mockRandomSequence([0.72, 0.55, 0.55, 0.7]);
    expect(resolveAbilityRoll(session.id, 'Kael', caster, spellBonus, 1, undefined, t1.id)).toBe(true);
    expect(getMonster(t1.refId)!.curHp).toBe(100 - (4 + 4 + 6));

    // d20 = 15 (hit), 2d6 = [4, 4] (match!), CON save d20 = 2 (fail vs DC 15)
    mockRandomSequence([0.72, 0.55, 0.55, 0.06]);
    expect(resolveAbilityRoll(session.id, 'Kael', caster, spellEffect, 1, undefined, t2.id)).toBe(true);
    expect(getMonster(t2.refId)!.conditions.some((c) => c.label === 'Staggered')).toBe(true);
  });

  it('supports individual low-die rerolls (Empowered Spell style) in one continuous tray', async () => {
    const { session, map, spawnMonster } = setupCombat();
    const empoweredFire: SheetAbility = {
      id: 'emp-blast',
      name: 'Empowered Blast',
      type: 'spell',
      level: 1,
      description: 'Rerolls up to two low damage dice.',
      source: 'custom',
      executionProfile: 'manual',
      roll: {
        kind: 'damage',
        dice: '4d6',
        damageType: 'fire',
        castingAbility: 'CHA',
        diceRules: {
          reroll: {
            mode: 'die-lte',
            maxFace: 2,
            maxDice: 2,
            keep: 'new',
            label: 'Empowered Spell',
          },
        },
      },
    };
    const caster = createCharacter(session.id, {
      name: 'Lyra',
      className: 'Sorcerer',
      level: 5,
      stats: { CHA: 18 },
      sheetAbilities: [empoweredFire],
    });
    createToken({ mapId: map.id, kind: 'pc', refId: caster.id, x: 50, y: 100 });
    spawnMonster('Dummy');

    let matchingFrame: LiveDiceFrame | undefined;
    for (let s = 1; s < 80; s++) {
      const candidate: LiveDiceFrame[] = [];
      await runLiveCommand(
        () => {
          resolveAbilityRoll(session.id, 'Lyra', caster, empoweredFire, 1);
        },
        (f) => candidate.push(f),
        { label: 'Empowered Blast', roller: 'Lyra', className: 'Sorcerer', waitForPresentation: async () => {} },
        (sides, publish, meta, seedVal, info) => physicalFaces(sides, publish, meta, (seedVal ?? s) + s++, info),
      );
      const last = candidate.at(-1);
      if (last?.rerollLinks?.length) {
        matchingFrame = last;
        break;
      }
    }
    expect(matchingFrame).toBeTruthy();
    expect(matchingFrame!.rerollLinks!.length).toBeLessThanOrEqual(2);
    expect(matchingFrame!.discardedDice?.some(Boolean)).toBe(true);
    expect(matchingFrame!.trayBanner?.tone).toBe('reroll');
  });
});

describe('SRD Passives & Unified Visual Flow', () => {
  it('enforces Great Weapon Fighting 1,2→3 floor in live tray, RevealStep, and diceTerms breakdown', async () => {
    const { session, map, spawnMonster } = setupCombat();
    const gwf: SheetAbility = {
      id: 'fs-gwf',
      name: 'Great Weapon Fighting',
      type: 'ability',
      description: 'When you roll a 1 or a 2 on a damage die for an attack you make with a melee weapon that you are wielding with two hands, you can treat the roll as a 3.',
    };
    const greatsword: Weapon = {
      name: 'Greatsword',
      kind: 'melee',
      damage: '2d6',
      damageType: 'slashing',
      tags: ['heavy', 'two-handed'],
    };
    const fighter = createCharacter(session.id, {
      name: 'Druk',
      className: 'Fighter',
      level: 5,
      stats: { STR: 16 },
      weapons: [greatsword],
      sheetAbilities: [gwf],
    });
    const fTok = createToken({ mapId: map.id, kind: 'pc', refId: fighter.id, x: 50, y: 100 });
    const { token: goblin } = spawnMonster('Goblin', { ac: 5, hp: 100 });

    // d20 = 15 (hit), damage dice roll [1, 2] -> floored to [3, 3] (+3 STR = 9)
    mockRandomSequence([0.72, 0.01, 0.2]);
    expect(resolveAttack(session.id, 'Druk', fTok.id, goblin.id, 0)).toBe(true);
    expect(getMonster(goblin.refId)!.curHp).toBe(91);
    const atkEntry = listRollLog(session.id).at(-1)!;
    const rawStep = atkEntry.reveal?.damageDice?.find((s) => s.rawFaces?.length);
    expect(rawStep).toBeTruthy();
    expect(rawStep!.rawFaces).toEqual([1, 2]);
    expect(rawStep!.faces).toEqual([3, 3]);
    expect(damageRollBreakdown(atkEntry)).toContain('→');

    // Live tray check: find seed where 2d6 hits a 1 or 2 -> dieAdjustedValues & 'floored'
    let flooredFrame: LiveDiceFrame | undefined;
    const gwfPassive = detectWeaponPassiveRules({ level: 5, className: 'Fighter', sheetAbilities: [gwf] }, greatsword, false);
    for (let s = 1; s < 50; s++) {
      const candidate: LiveDiceFrame[] = [];
      await runLiveCommand(
        () => {
          rollWeaponAttack(
            { stats: { STR: 16 }, level: 5, isMonster: false },
            greatsword,
            10,
            undefined,
            {
              diceRules: gwfPassive.mergedRules,
              fixedAttack: {
                face: 15, bonus: 6, attackTotal: 21, crit: false, fumble: false, hit: true,
                damage: 0, detail: '', detailToHit: 'd20[15] +6', toHitSteps: [], damageDiceSteps: [], damageModSteps: [],
              } as AttackOutcome,
            },
          );
        },
        (f) => candidate.push(f),
        { label: 'Greatsword', roller: 'Druk', className: 'Fighter', waitForPresentation: async () => {} },
        (sides, publish, meta, seedVal, info) => physicalFaces(sides, publish, meta, (seedVal ?? s) + s++, info),
      );
      const last = candidate.at(-1);
      if (last?.dieRoles?.includes('floored')) {
        flooredFrame = last;
        break;
      }
    }
    expect(flooredFrame).toBeTruthy();
    expect(flooredFrame!.trayBanner?.tone).toBe('floor');
    expect(flooredFrame!.dieAdjustedValues?.some((v) => v === 3)).toBe(true);
  });

  it('applies Elemental Adept 1→2 floor AND bypasses matching damage resistance', () => {
    const { session, map, spawnMonster } = setupCombat();
    const adeptFire: SheetAbility = {
      id: 'feat-elem-adept',
      name: 'Elemental Adept',
      type: 'ability',
      description: 'Spells you cast ignore resistance to fire damage. When you roll damage for a spell you cast that deals fire damage, you can treat any 1 on a damage die as a 2.',
    };
    const fireBolt: SheetAbility = {
      id: 'custom-fire-bolt',
      name: 'Fire Bolt',
      type: 'spell',
      level: 0,
      description: 'Hurls a mote of fire.',
      source: 'custom',
      executionProfile: 'manual',
      roll: { kind: 'attack', dice: '2d10', damageType: 'fire', castingAbility: 'INT' },
    };
    const wiz = createCharacter(session.id, {
      name: 'Kael',
      className: 'Wizard',
      level: 5,
      stats: { INT: 18 },
      sheetAbilities: [adeptFire, fireBolt],
    });
    createToken({ mapId: map.id, kind: 'pc', refId: wiz.id, x: 50, y: 100 });
    const { token: resistant } = spawnMonster('Fire Imp', { ac: 5, hp: 50, resistances: ['fire'] });

    // d20 = 15 (hit), 2d10 = [1, 1] -> floored to [2, 2] = 4 fire, ignoring fire resistance!
    mockRandomSequence([0.72, 0.01, 0.01]);
    expect(resolveAbilityRoll(session.id, 'Kael', wiz, fireBolt, 0, undefined, resistant.id)).toBe(true);
    expect(getMonster(resistant.refId)!.curHp).toBe(46);
  });

  it('rerolls Halfling Lucky Nat 1s in the same d20 tray across attacks, saves, and skill checks', async () => {
    const { session, map, spawnMonster } = setupCombat();
    const halflingLucky: SheetAbility = {
      id: 'trait-halfling-lucky',
      name: 'Lucky',
      type: 'ability',
      tags: ['halfling'],
      description: 'When you roll a 1 on the d20 of an attack roll, ability check, or saving throw, you can reroll the die and must use the new roll.',
    };
    const dagger: Weapon = { name: 'Dagger', kind: 'melee', damage: '1d4', damageType: 'piercing', tags: ['finesse'] };
    const halfling = createCharacter(session.id, {
      name: 'Milo',
      race: 'Halfling',
      className: 'Rogue',
      level: 5,
      stats: { DEX: 18 },
      weapons: [dagger],
      proficientSkills: ['Stealth'],
      sheetAbilities: [halflingLucky],
    });
    const hTok = createToken({ mapId: map.id, kind: 'pc', refId: halfling.id, x: 50, y: 100 });
    const { token: target } = spawnMonster('Target', { ac: 10, hp: 100 });

    // Attack: Nat 1 (0.0) -> reroll 18 (0.86) -> hit!, 1d4 = 3
    mockRandomSequence([0.0, 0.86, 0.6]);
    expect(resolveAttack(session.id, 'Milo', hTok.id, target.id, 0)).toBe(true);
    expect(getMonster(target.refId)!.curHp).toBeLessThan(100);

    // Save: Nat 1 (0.0) -> reroll 19 (0.91)
    mockRandomSequence([0.0, 0.91]);
    expect(resolveSave(session.id, 'Milo', 'pc', halfling.id, 'DEX')).toBe(true);
    expect(listRollLog(session.id).at(-1)!.detail).toContain('Lucky');

    // Skill check: Nat 1 (0.0) -> reroll 17 (0.81)
    mockRandomSequence([0.0, 0.81]);
    expect(resolveSkillRoll(session.id, 'Milo', halfling, 'Stealth')).toBe(true);
    expect(listRollLog(session.id).at(-1)!.detail).toContain('Lucky');

    // Live tray check: rollSavingThrow inside runLiveCommand when Nat 1 occurs (seed 23 hits 1 on 1d20)
    const candidate: LiveDiceFrame[] = [];
    await runLiveCommand(
      () => {
        rollSavingThrow(
          { stats: { DEX: 18 }, level: 5, isMonster: false },
          'DEX',
          12,
          undefined,
          true,
          'DEX Save',
          { halflingLucky: true },
        );
      },
      (f) => candidate.push(f),
      { label: 'DEX Save', roller: 'Milo', className: 'Rogue', waitForPresentation: async () => {} },
      (sides, publish, meta, _seed, info) => physicalFaces(sides, publish, meta, 28, info),
    );
    const luckyFrame = candidate.at(-1);
    expect(luckyFrame).toBeTruthy();
    expect(luckyFrame!.sides).toEqual([20, 20]);
    expect(luckyFrame!.rerollLinks).toEqual([{ from: 0, to: 1 }]);
    expect(luckyFrame!.dieRoles).toEqual(['base', 'lucky-reroll']);
    expect(luckyFrame!.trayBanner?.tone).toBe('lucky');
  });

  it('stacks Improved/Superior Critical (19-20 / 18-20) with Brutal Critical and Savage Attacks in one tray', async () => {
    const { session, map, spawnMonster } = setupCombat();
    const improved: SheetAbility = { id: 'imp-crit', name: 'Improved Critical', type: 'ability', description: 'Crits on 19-20.' };
    const superior: SheetAbility = { id: 'sup-crit', name: 'Superior Critical', type: 'ability', description: 'Crits on 18-20.' };
    const brutal: SheetAbility = { id: 'brutal-crit', name: 'Brutal Critical', type: 'ability', description: 'Roll additional weapon damage dice on a crit.' };
    const savageAttacks: SheetAbility = {
      id: 'sav-atk',
      name: 'Savage Attacks',
      type: 'stance',
      description: 'Extra melee crit die.',
      stance: { active: true, appliesTo: 'melee', extraCritDie: true },
    };
    const axe: Weapon = { name: 'Greataxe', kind: 'melee', damage: '1d12', damageType: 'slashing' };
    const champ = createCharacter(session.id, {
      name: 'Druk',
      className: 'Barbarian',
      level: 13, // 2 Brutal Critical dice on Barbarian
      stats: { STR: 18 },
      weapons: [axe],
      sheetAbilities: [superior, brutal, savageAttacks, improved],
    });
    const cTok = createToken({ mapId: map.id, kind: 'pc', refId: champ.id, x: 50, y: 100 });
    const { token: ogre } = spawnMonster('Ogre', { ac: 10, hp: 300 });

    // Natural 18 (0.85 -> Math.floor(0.85 * 20) + 1 = 18) triggers Superior Critical!
    mockRandomSequence([0.85, 0.5, 0.5, 0.5, 0.5, 0.5]);
    expect(resolveAttack(session.id, 'Druk', cTok.id, ogre.id, 0)).toBe(true);
    const log = listRollLog(session.id).at(-1)!;
    expect(log.detail).toContain('CRIT');
    expect(log.reveal?.outcome).toBe('crit');

    // Live tray check: Brutal Critical + Savage Attacks produce separate labeled extra crit dice
    const critPassive = detectWeaponPassiveRules(
      { level: 13, className: 'Barbarian', sheetAbilities: [superior, brutal, savageAttacks] },
      axe,
      true,
    );
    const frames: LiveDiceFrame[] = [];
    await runLiveCommand(
      () => {
        rollWeaponAttack(
          { stats: { STR: 18 }, level: 13, isMonster: false },
          axe,
          10,
          undefined,
          {
            diceRules: critPassive.mergedRules,
            extraCritLabels: [...critPassive.extraCritLabels, 'Savage Attacks'],
            extraCritDie: true,
            fixedAttack: {
              face: 18, bonus: 9, attackTotal: 27, crit: true, fumble: false, hit: true,
              damage: 0, detail: '', detailToHit: 'd20[18] +9', toHitSteps: [], damageDiceSteps: [], damageModSteps: [],
            } as AttackOutcome,
          },
        );
      },
      (f) => frames.push(f),
      { label: 'Greataxe', roller: 'Druk', className: 'Barbarian', waitForPresentation: async () => {} },
      (sides, publish, meta, seed, info) => physicalFaces(sides, publish, meta, (seed ?? 1) + 5, info),
    );
    const last = frames.at(-1)!;
    expect(last.sides).toEqual([12, 12, 12, 12, 12]);
    expect(last.dieLabels).toEqual([null, 'CRIT', 'Savage Attacks', 'Brutal Critical', 'Brutal Critical']);
  });
});
