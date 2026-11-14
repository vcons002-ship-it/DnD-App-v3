import { describe, expect, it } from 'vitest';
import {
  applyDamage,
  clearCondition,
  createCharacter,
  createMap,
  createMonsterTemplate,
  createSession,
  createToken,
  endConcentration,
  getCharacter,
  getMonster,
  instantiateMonster,
  listRollLog,
  setActiveMap,
  setCombatRound,
  setCondition,
  setDeathSaves,
  setSheetAbility,
  setTempHp,
  updateCharacter,
  updateMonster,
} from './sessions.js';
import {
  resolveAbilityRoll,
  resolveAttack,
  resolveAttackDamage,
  resolveForcedSave,
  resolveRiposte,
} from './combat.js';
import { resolveDeathSave, resolveSave, resolveSaves } from './combatChecks.js';
import { noteConcentration } from './combatHelpers.js';
import { processHitEffects } from './hitEffectTurns.js';
import { resolveHitFeature } from './hitFeatures.js';
import { shakeAwake, shieldGate } from './partySpellEffects.js';
import { listRipostes } from './reactions.js';
import { restCharacter } from './rests.js';
import { getAllSpells, getSpell } from './spells/srd.js';
import { buildSnapshot } from './visibility.js';
import { withDiceSource } from '../../shared/dice.js';
import { evaluateAttackContext } from '../../shared/conditionEffects.js';
import { abilityKey } from '../../shared/hitFeatures.js';
import { effectiveAc, saveExtra } from '../../shared/modifiers.js';
import { effectiveSpeed } from '../../shared/spellBuffs.js';
import { spellCombatSupport } from '../../shared/spellSupport.js';
import type { SheetAbility, Weapon } from '../../shared/types.js';

function spellAbility(name: string, extra: Partial<SheetAbility> = {}): SheetAbility {
  const key = abilityKey({ name });
  const base = getSpell(name) ?? getAllSpells().find((s) => abilityKey(s) === key);
  if (!base) throw new Error(`Missing catalog spell: ${name}`);
  return {
    ...base,
    id: `spell-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    source: 'srd',
    ...extra,
  };
}

function setupArena() {
  const session = createSession('High-Value Spells Arena');
  const map = createMap(session.id, { name: 'Arena' });
  setActiveMap(session.id, map.id);
  const melee: Weapon = { name: 'Longsword', kind: 'melee', damage: '1d8', damageType: 'slashing' };
  const ranged: Weapon = { name: 'Longbow', kind: 'ranged', damage: '1d8', damageType: 'piercing', range: '150/600' };
  let caster = createCharacter(session.id, {
    name: 'Aeliana',
    className: 'Cleric',
    level: 11,
    maxHp: 90,
    curHp: 90,
    armorClass: 14,
    stats: { STR: 10, DEX: 14, CON: 14, INT: 16, WIS: 18, CHA: 16 },
    saveProficiencies: ['WIS', 'CHA'],
    weapons: [melee, ranged],
  });
  caster = updateCharacter(caster.id, {
    spellSlots: {
      L1: { max: 4, used: 0 },
      L2: { max: 3, used: 0 },
      L3: { max: 3, used: 0 },
      L4: { max: 3, used: 0 },
      L5: { max: 2, used: 0 },
      L6: { max: 1, used: 0 },
      L7: { max: 1, used: 0 },
    },
  })!;
  const ally = createCharacter(session.id, {
    name: 'Bryn',
    className: 'Fighter',
    level: 5,
    maxHp: 60,
    curHp: 60,
    armorClass: 15,
    stats: { STR: 16, DEX: 12, CON: 14, INT: 10, WIS: 12, CHA: 10 },
    saveProficiencies: ['STR', 'CON'],
    weapons: [melee],
  });
  const enemyTemplate = createMonsterTemplate(session.id, {
    name: 'Cultist',
    maxHp: 80,
    armorClass: 14,
    stats: { STR: 12, DEX: 12, CON: 12, INT: 10, WIS: 10, CHA: 10 },
  });
  const enemy = updateMonster(instantiateMonster(enemyTemplate.id)!.id, {
    weapons: [
      { name: 'Claw', kind: 'melee', damage: '6', damageType: 'slashing', attackBonus: 6 },
      { name: 'Shortbow', kind: 'ranged', damage: '6', damageType: 'piercing', attackBonus: 6, range: '80/320' },
    ],
  })!;
  const casterTok = createToken({ mapId: map.id, kind: 'pc', refId: caster.id, x: 100, y: 100 });
  const allyTok = createToken({ mapId: map.id, kind: 'pc', refId: ally.id, x: 150, y: 100 }); // 5 ft from caster
  const enemyTok = createToken({ mapId: map.id, kind: 'monster', refId: enemy.id, x: 200, y: 100 }); // 10 ft from caster, 5 ft from ally
  return { session, map, caster, ally, enemy, casterTok, allyTok, enemyTok };
}

function fixedDice(d20 = 12, d4 = 3) {
  const seenSides: number[][] = [];
  return {
    seenSides,
    run<T>(fn: () => T): T {
      return withDiceSource((sides) => {
        seenSides.push([...sides]);
        if (sides.length === 2 && sides[0] === 20 && sides[1] === 20) return [5, 17];
        return sides.map((s) => (s === 4 ? d4 : s === 20 ? d20 : Math.min(s, 3)));
      }, fn);
    },
  };
}

function resolveSingleTargetSaveIfPending(sid: string, targetTokenId: string) {
  const entry = listRollLog(sid).at(-1);
  if (entry?.apply && !(entry.apply.consumedTargets ?? []).includes(targetTokenId)) {
    resolveForcedSave(sid, entry.id, targetTokenId);
  }
}

describe('Bless and Bane d20 modifiers and invariants', () => {
  it('enforces Bless/Bane upcast target limits, runs Bane CHA saves, applies +/-1d4 across d20 rolls, and never rolls d4 when inactive', () => {
    const { session, caster, ally, enemy, casterTok, allyTok, enemyTok } = setupArena();
    const extra1 = instantiateMonster(createMonsterTemplate(session.id, { name: 'Foe-1', maxHp: 30 }).id)!;
    const extra2 = instantiateMonster(createMonsterTemplate(session.id, { name: 'Foe-2', maxHp: 30 }).id)!;
    const extra3 = instantiateMonster(createMonsterTemplate(session.id, { name: 'Foe-3', maxHp: 30 }).id)!;
    const foe1Tok = createToken({ mapId: casterTok.mapId, kind: 'monster', refId: extra1.id, x: 250, y: 100 });
    const foe2Tok = createToken({ mapId: casterTok.mapId, kind: 'monster', refId: extra2.id, x: 300, y: 100 });
    const foe3Tok = createToken({ mapId: casterTok.mapId, kind: 'monster', refId: extra3.id, x: 350, y: 100 });

    const bless = spellAbility('Bless');
    const bane = spellAbility('Bane');
    const fireBolt = spellAbility('Fire Bolt');
    const sacredFlame = spellAbility('Sacred Flame');
    const holdPerson = spellAbility('Hold Person');
    setSheetAbility('pc', caster.id, bless);
    setSheetAbility('pc', caster.id, bane);
    setSheetAbility('pc', caster.id, fireBolt);
    setSheetAbility('pc', caster.id, sacredFlame);
    setSheetAbility('pc', caster.id, holdPerson);

    // 1. Invariant: with neither Bless nor Bane active, 0 d4 rolls occur across all d20 systems
    const baseline = fixedDice(11, 4);
    baseline.run(() => {
      expect(resolveAttack(session.id, ally.name, allyTok.id, enemyTok.id, 0)).toBe(true);
      expect(resolveAbilityRoll(session.id, caster.name, getCharacter(caster.id)!, fireBolt, 0, undefined, enemyTok.id)).toBe(true);
      expect(resolveAbilityRoll(session.id, caster.name, getCharacter(caster.id)!, sacredFlame, 0, undefined, enemyTok.id)).toBe(true);
      resolveSingleTargetSaveIfPending(session.id, enemyTok.id);
      resolveSaves(session.id, 'DM', [allyTok.id], 'CON', 10);
      resolveSave(session.id, ally.name, 'pc', ally.id, 'DEX');
      applyDamage('pc', ally.id, ally.curHp);
      resolveDeathSave(session.id, ally.id);
    });
    expect(baseline.seenSides.flat().includes(4)).toBe(false);
    // Revive ally back to full HP and clear Unconscious/Prone for remaining checks
    applyDamage('pc', ally.id, -60, undefined, false, undefined, { correction: true });
    for (const c of getCharacter(ally.id)!.conditions) clearCondition('pc', ally.id, c.id);

    // 2. Bless level 1 rejects 4 targets, accepts 3 targets; level 2 accepts 4
    expect(resolveAbilityRoll(session.id, caster.name, getCharacter(caster.id)!, bless, 1, undefined, undefined, undefined, undefined, [casterTok.id, allyTok.id, foe1Tok.id, foe2Tok.id])).toBe(false);
    expect(resolveAbilityRoll(session.id, caster.name, getCharacter(caster.id)!, bless, 2, undefined, undefined, undefined, undefined, [casterTok.id, allyTok.id, foe1Tok.id, foe2Tok.id])).toBe(true);
    expect(getCharacter(ally.id)!.conditions.some((c) => c.label === 'Bless (+1d4)')).toBe(true);

    // Blessed PC rolls get +1d4[3] across weapon attack, spell attack, forced save, resolveSaves, resolveSave, concentration check, death save, and repeat save
    const allyBaseToHit = fixedDice(10, 3);
    allyBaseToHit.run(() => {
      resolveAttack(session.id, ally.name, allyTok.id, enemyTok.id, 0); // STR+3 + PB+3 + Bless+3 = 19 total on d20=10
    });
    const atkEntry = listRollLog(session.id).at(-1)!;
    expect(atkEntry.reveal?.attackTotal).toBe(19);
    expect(atkEntry.detail).toContain('Bless +1d4[3]');

    fixedDice(10, 3).run(() => {
      resolveAbilityRoll(session.id, caster.name, getCharacter(caster.id)!, fireBolt, 0, undefined, casterTok.id);
    });
    // Caster DC/attack uses WIS +4 + PB +4 = +8 + d20(10) + Bless(3) = 21
    expect(listRollLog(session.id).at(-1)!.reveal?.attackTotal).toBe(21);

    // Caster Bane CHA saves: pass prevents Bane, fail applies Bane (-1d4)
    fixedDice(20, 3).run(() => {
      expect(resolveAbilityRoll(session.id, caster.name, getCharacter(caster.id)!, bane, 1, undefined, undefined, undefined, undefined, [enemyTok.id, foe3Tok.id])).toBe(true);
    });
    expect(getMonster(enemy.id)!.conditions.some((c) => c.label === 'Bane (-1d4)')).toBe(false);
    // Dropping concentration clears Bless when replacing with Bane below, too
    expect(getCharacter(ally.id)!.conditions.some((c) => c.label === 'Bless (+1d4)')).toBe(false);

    fixedDice(2, 2).run(() => {
      expect(resolveAbilityRoll(session.id, caster.name, getCharacter(caster.id)!, bane, 1, undefined, undefined, undefined, undefined, [enemyTok.id, foe3Tok.id])).toBe(true);
    });
    expect(getMonster(enemy.id)!.conditions.some((c) => c.label === 'Bane (-1d4)')).toBe(true);

    // Re-apply Bless onto ally while Bane is on enemy (without breaking Bane? Keep separate concentration casters!)
    const caster2 = createCharacter(session.id, { name: 'Cleric2', className: 'Cleric', level: 5, stats: { WIS: 16 } });
    setSheetAbility('pc', caster2.id, bless);
    resolveAbilityRoll(session.id, caster2.name, caster2, bless, 1, undefined, allyTok.id);
    expect(getCharacter(ally.id)!.conditions.some((c) => c.label === 'Bless (+1d4)')).toBe(true);

    // Forced save on Baned enemy (-2): cast untargeted Sacred Flame first so resolveForcedSave triggers under fixedDice(15, 2)
    const sfId = (() => {
      fixedDice(8, 3).run(() => {
        resolveAbilityRoll(session.id, caster2.name, getCharacter(caster2.id)!, sacredFlame, 0);
      });
      return listRollLog(session.id).at(-1)!.id;
    })();
    // Resolve Bane(-2) on enemy DEX save (+1 mod, d20=15 -> 15 + 1 - 2 = 14)
    fixedDice(15, 2).run(() => resolveForcedSave(session.id, sfId, enemyTok.id));
    expect(listRollLog(session.id).at(-1)!.reveal?.attackTotal).toBe(14);
    expect(listRollLog(session.id).at(-1)!.detail).toContain('Bane -1d4[2]');

    // resolveSaves (group save) with Bless +3
    fixedDice(10, 3).run(() => resolveSaves(session.id, 'DM', [allyTok.id], 'CON', 15));
    // CON +2 + PB +3 + d20 10 + Bless 3 = 18
    expect(listRollLog(session.id).at(-1)!.total).toBe(18);
    expect(listRollLog(session.id).at(-1)!.detail).toContain('Bless +1d4[3]');

    // resolveSave (stat-block / concentration save check) with Bless +3
    fixedDice(10, 3).run(() => resolveSave(session.id, ally.name, 'pc', ally.id, 'CON'));
    expect(listRollLog(session.id).at(-1)!.total).toBe(18);

    // resolveDeathSave on downed Blessed ally (d20=8 + Bless 3 = 11 -> PASS >= 10)
    applyDamage('pc', ally.id, ally.curHp);
    fixedDice(8, 3).run(() => expect(resolveDeathSave(session.id, ally.id)).toBe(true));
    expect(listRollLog(session.id).at(-1)!.total).toBe(11);
    expect(getCharacter(ally.id)!.deathSaves.successes).toBe(1);
    applyDamage('pc', ally.id, -60, undefined, false, undefined, { correction: true });

    // Turn-end repeat save under Bane (-2): give enemy Paralyzed repeatSave condition from caster2
    setCondition('monster', enemy.id, {
      id: 'repeat-hold',
      label: 'Paralyzed',
      aura: 'red',
      isConcentration: false,
      combatEffect: {
        casterKind: 'pc',
        casterId: caster2.id,
        spell: 'Hold Person',
        dc: 15,
        save: 'WIS',
        phase: 'end',
        expiresAt: Date.now() + 60000,
      },
    });
    setCombatRound(session.id, 1);
    // Enemy WIS +0, d20=15 - Bane 2 = 13 < DC 15 -> FAILS repeat save!
    fixedDice(15, 2).run(() => processHitEffects(session.id, enemyTok, 'end'));
    expect(listRollLog(session.id).at(-1)!.total).toBe(13);
    expect(listRollLog(session.id).at(-1)!.detail).toContain('Bane -1d4[2]');
    expect(getMonster(enemy.id)!.conditions.some((c) => c.id === 'repeat-hold')).toBe(true);

    // Concentration drop clears Bless and Bane
    endConcentration('pc', caster.id, 'broken');
    endConcentration('pc', caster2.id, 'broken');
    expect(getCharacter(ally.id)!.conditions.some((c) => c.label === 'Bless (+1d4)')).toBe(false);
    expect(getMonster(enemy.id)!.conditions.some((c) => c.label === 'Bane (-1d4)')).toBe(false);
  });
});

describe('Damage and healing riders (Heal, Harm, Vicious Mockery, Arms of Hadar, Armor of Agathys, Branding Smite)', () => {
  it('Heal heals flat 70 (+10/lvl) without casting modifier and cures Blinded, Deafened, and Poisoned', () => {
    const { session, caster, ally, allyTok } = setupArena();
    const heal = spellAbility('Heal');
    setSheetAbility('pc', caster.id, heal);
    updateCharacter(ally.id, { maxHp: 120, curHp: 10 });
    setCondition('pc', ally.id, { id: 'c1', label: 'Blinded', aura: 'red', isConcentration: false });
    setCondition('pc', ally.id, { id: 'c2', label: 'Deafened', aura: 'red', isConcentration: false });
    setCondition('pc', ally.id, { id: 'c3', label: 'Poisoned', aura: 'red', isConcentration: false });
    setCondition('pc', ally.id, { id: 'c4', label: 'Prone', aura: 'red', isConcentration: false });

    expect(resolveAbilityRoll(session.id, caster.name, getCharacter(caster.id)!, heal, 6, undefined, allyTok.id)).toBe(true);
    const afterL6 = getCharacter(ally.id)!;
    expect(afterL6.curHp).toBe(80); // 10 + 70, no WIS mod added
    expect(afterL6.conditions.map((c) => c.label)).toEqual(['Prone']);

    updateCharacter(ally.id, { curHp: 10 });
    expect(resolveAbilityRoll(session.id, caster.name, getCharacter(caster.id)!, heal, 7, undefined, allyTok.id)).toBe(true);
    expect(getCharacter(ally.id)!.curHp).toBe(90); // 10 + 80
  });

  it('Harm reduces max HP on failed CON save (floored at 1), leaves max HP on pass, and is cured by Greater Restoration and Long Rest', () => {
    const { session, caster, ally, allyTok } = setupArena();
    const harm = spellAbility('Harm');
    const greaterResto = spellAbility('Greater Restoration');
    setSheetAbility('pc', caster.id, harm);
    setSheetAbility('pc', caster.id, greaterResto);

    // Failed save against 14*3 = 42 necrotic damage -> maxHp 60 - 42 = 18
    fixedDice(2, 3).run(() => {
      expect(resolveAbilityRoll(session.id, caster.name, getCharacter(caster.id)!, harm, 6, undefined, allyTok.id)).toBe(true);
      resolveSingleTargetSaveIfPending(session.id, allyTok.id);
    });
    expect(getCharacter(ally.id)!.maxHp).toBe(18);
    expect(getCharacter(ally.id)!.curHp).toBe(18);

    // Greater Restoration restores max HP
    expect(resolveAbilityRoll(session.id, caster.name, getCharacter(caster.id)!, greaterResto, 5, undefined, allyTok.id, undefined, undefined, undefined, 'HP Maximum Reduction')).toBe(true);
    expect(getCharacter(ally.id)!.maxHp).toBe(60);

    // Huge Harm damage floors maxHp at 1, and passed save leaves maxHp intact; Long Rest restores it
    updateCharacter(ally.id, { curHp: 60 });
    withDiceSource((sides) => sides.map((s) => (s === 6 ? 6 : 2)), () => {
      // 14*6 = 84 necrotic -> maxHp reduces by 84 floored to 1
      expect(resolveAbilityRoll(session.id, caster.name, getCharacter(caster.id)!, harm, 6, undefined, allyTok.id)).toBe(true);
      resolveSingleTargetSaveIfPending(session.id, allyTok.id);
    });
    expect(getCharacter(ally.id)!.maxHp).toBe(1);
    applyDamage('pc', ally.id, -1, undefined, false, undefined, { correction: true });
    const restOut = restCharacter(session.id, ally.id, 'long')!;
    expect(restOut.skipped).toBeUndefined();
    expect(getCharacter(ally.id)!.maxHp).toBe(60);

    // Passed CON save takes half damage without reducing max HP
    fixedDice(20, 3).run(() => {
      expect(resolveAbilityRoll(session.id, caster.name, getCharacter(caster.id)!, harm, 6, undefined, allyTok.id)).toBe(true);
      resolveSingleTargetSaveIfPending(session.id, allyTok.id);
    });
    expect(getCharacter(ally.id)!.maxHp).toBe(60);
    expect(getCharacter(ally.id)!.curHp).toBe(39); // 60 - floor(42/2)
  });

  it('Vicious Mockery applies next-attack disadvantage, consumes on first attack/ray 0, and expires at turn end', () => {
    const { session, caster, ally, enemy, casterTok, allyTok, enemyTok } = setupArena();
    const vm = spellAbility('Vicious Mockery');
    const scorchingRay = spellAbility('Scorching Ray');
    setSheetAbility('pc', ally.id, vm);
    setSheetAbility('pc', caster.id, scorchingRay);

    // Apply Vicious Mockery to caster (10 ft away from enemyTok so ranged attacks aren't penalized by 5 ft proximity)
    fixedDice(2, 3).run(() => {
      expect(resolveAbilityRoll(session.id, ally.name, getCharacter(ally.id)!, vm, 0, undefined, casterTok.id)).toBe(true);
      resolveSingleTargetSaveIfPending(session.id, casterTok.id);
    });
    expect(getCharacter(caster.id)!.conditions.some((c) => c.label === 'Vicious Mockery (disadv next attack)')).toBe(true);

    // Ray 0 of Scorching Ray consumes Vicious Mockery Disadvantage; Ray 1 attacks straight
    const ray1Dice = fixedDice(12, 3);
    ray1Dice.run(() => {
      expect(resolveAbilityRoll(session.id, caster.name, getCharacter(caster.id)!, scorchingRay, 2, undefined, enemyTok.id)).toBe(true);
    });
    const rayRollId = listRollLog(session.id).at(-1)!.id;
    const attackDice1 = fixedDice(12, 3);
    attackDice1.run(() => {
      resolveForcedSave(session.id, rayRollId, enemyTok.id, undefined, 0);
      const pendingAttack = listRollLog(session.id).at(-1)!;
      if (pendingAttack.pending && !pendingAttack.pending.done) {
        resolveAttackDamage(session.id, caster.name, pendingAttack.id);
      }
    });
    expect(attackDice1.seenSides.some((s) => s.length === 2 && s[0] === 20 && s[1] === 20)).toBe(true); // Disadvantage on ray 0
    expect(getCharacter(caster.id)!.conditions.some((c) => c.label === 'Vicious Mockery (disadv next attack)')).toBe(false);

    const attackDice2 = fixedDice(12, 3);
    attackDice2.run(() => {
      resolveForcedSave(session.id, rayRollId, enemyTok.id, undefined, 1);
      const pendingAttack = listRollLog(session.id).at(-1)!;
      if (pendingAttack.pending && !pendingAttack.pending.done) {
        resolveAttackDamage(session.id, caster.name, pendingAttack.id);
      }
    });
    expect(attackDice2.seenSides.some((s) => s.length === 2 && s[0] === 20 && s[1] === 20)).toBe(false); // straight roll on ray 1

    // When unused, Vicious Mockery survives start of turn and expires at end of turn
    fixedDice(2, 3).run(() => {
      resolveAbilityRoll(session.id, ally.name, getCharacter(ally.id)!, vm, 0, undefined, casterTok.id);
      resolveSingleTargetSaveIfPending(session.id, casterTok.id);
    });
    setCombatRound(session.id, 1);
    processHitEffects(session.id, casterTok, 'start');
    expect(getCharacter(caster.id)!.conditions.some((c) => c.label === 'Vicious Mockery (disadv next attack)')).toBe(true);
    processHitEffects(session.id, casterTok, 'end');
    expect(getCharacter(caster.id)!.conditions.some((c) => c.label === 'Vicious Mockery (disadv next attack)')).toBe(false);
  });

  it('Arms of Hadar excludes caster, blocks Shield/Riposte reactions until start of turn, and still permits shakeAwake', () => {
    const { session, map, caster, ally, enemy, casterTok, allyTok, enemyTok } = setupArena();
    const arms = spellAbility('Arms of Hadar');
    const shield = spellAbility('Shield');
    setSheetAbility('pc', caster.id, arms);
    setSheetAbility('pc', ally.id, shield);
    setSheetAbility('pc', ally.id, {
      id: 'rip-1',
      name: 'Riposte',
      type: 'maneuver',
      level: 0,
      description: '',
      maneuver: { addDieTo: 'damage', active: false },
    });
    updateCharacter(ally.id, {
      resources: { 'Superiority Dice': { used: 0, max: 4 } },
      spellSlots: { L1: { max: 2, used: 0 } },
    });

    // Put another ally 5 ft from allyTok (15 ft from casterTok so Arms of Hadar doesn't damage them first)
    const sleeper = createCharacter(session.id, { name: 'Sleeper', className: 'Rogue', level: 3, maxHp: 30, curHp: 30 });
    const sleeperTok = createToken({ mapId: map.id, kind: 'pc', refId: sleeper.id, x: 150, y: 150 });
    void sleeperTok;

    // Miss ally before Arms of Hadar so a Riposte offer exists and shieldGate is available
    expect(shieldGate(session.id, 'pc', ally.id, 18, false)).toBeTruthy();
    fixedDice(2, 3).run(() => resolveAttack(session.id, enemy.name, enemyTok.id, allyTok.id, 0));
    const preOffer = listRipostes(session.id)[0];
    expect(preOffer).toBeTruthy();

    // Cast Arms of Hadar at caster (10-ft emanation excludes caster, hits allyTok at 5ft & enemyTok at 10ft)
    fixedDice(2, 3).run(() => {
      expect(
        resolveAbilityRoll(session.id, caster.name, getCharacter(caster.id)!, arms, 1, undefined, undefined, undefined, {
          mapId: map.id,
          points: [{ x: casterTok.x, y: casterTok.y }],
          angle: 0,
        }),
      ).toBe(true);
    });
    expect(getCharacter(caster.id)!.curHp).toBe(90); // caster excluded
    expect(getCharacter(ally.id)!.conditions.some((c) => c.label === 'Arms of Hadar (no reactions)')).toBe(true);

    // Shield gate and Riposte are blocked while Arms of Hadar condition is active
    expect(shieldGate(session.id, 'pc', ally.id, 18, false)).toBeUndefined();
    expect(resolveRiposte(session.id, ally.name, preOffer.id, 0)).toMatchObject({ ok: false });

    // Action (shakeAwake) is NOT blocked by reaction loss
    setCondition('pc', sleeper.id, {
      id: 'hyp-1',
      label: 'Hypnotic Pattern',
      aura: 'red',
      isConcentration: false,
      combatEffect: { casterKind: 'monster', casterId: enemy.id, spell: 'Hypnotic Pattern', expiresAt: Date.now() + 60000 },
    });
    expect(shakeAwake(session.id, allyTok.id, sleeperTok.id)).toBeUndefined();
    expect(getCharacter(sleeper.id)!.conditions.some((c) => c.label === 'Hypnotic Pattern')).toBe(false);

    // Cleared at start of target's next turn -> shieldGate allowed again
    setCombatRound(session.id, 1);
    processHitEffects(session.id, allyTok, 'start');
    expect(getCharacter(ally.id)!.conditions.some((c) => c.label === 'Arms of Hadar (no reactions)')).toBe(false);
    expect(shieldGate(session.id, 'pc', ally.id, 18, false)).toBeTruthy();
  });

  it('Armor of Agathys grants 5*lvl temp HP, retaliates with Cold damage on melee hits (even when depleting temp HP), and ignores ranged hits', () => {
    const { session, caster, enemy, casterTok, enemyTok } = setupArena();
    const aoa = spellAbility('Armor of Agathys');
    setSheetAbility('pc', caster.id, aoa);
    setTempHp('pc', caster.id, 3); // smaller pool replaced by 10 at L2

    expect(resolveAbilityRoll(session.id, caster.name, getCharacter(caster.id)!, aoa, 2)).toBe(true);
    expect(getCharacter(caster.id)!.tempHp).toBe(10);
    expect(getCharacter(caster.id)!.conditions.some((c) => c.label.startsWith('Armor of Agathys'))).toBe(true);

    // Ranged attack hits Armor of Agathys -> temp HP absorbs, NO cold retaliation
    const enemyHpBefore = getMonster(enemy.id)!.curHp;
    fixedDice(18, 3).run(() => {
      resolveAttack(session.id, enemy.name, enemyTok.id, casterTok.id, 1); // Shortbow (ranged), 6 damage
      resolveAttackDamage(session.id, enemy.name, listRollLog(session.id).at(-1)!.id);
    });
    expect(getCharacter(caster.id)!.tempHp).toBe(4);
    expect(getMonster(enemy.id)!.curHp).toBe(enemyHpBefore);
    expect(getCharacter(caster.id)!.conditions.some((c) => c.label.startsWith('Armor of Agathys'))).toBe(true);

    // Depleting melee hit -> deals 10 Cold retaliation, clears Armor of Agathys condition
    fixedDice(18, 3).run(() => {
      resolveAttack(session.id, enemy.name, enemyTok.id, casterTok.id, 0); // Claw (melee), 6 damage
      resolveAttackDamage(session.id, enemy.name, listRollLog(session.id).at(-1)!.id);
    });
    expect(getCharacter(caster.id)!.tempHp).toBe(0);
    expect(getMonster(enemy.id)!.curHp).toBe(enemyHpBefore - 10);
    expect(getCharacter(caster.id)!.conditions.some((c) => c.label.startsWith('Armor of Agathys'))).toBe(false);

    // Subsequent melee hit triggers no further retaliation
    const enemyHpAfter = getMonster(enemy.id)!.curHp;
    fixedDice(18, 3).run(() => {
      resolveAttack(session.id, enemy.name, enemyTok.id, casterTok.id, 0);
      resolveAttackDamage(session.id, enemy.name, listRollLog(session.id).at(-1)!.id);
    });
    expect(getMonster(enemy.id)!.curHp).toBe(enemyHpAfter);
  });

  it('Branding Smite is offered on both melee and ranged hits, adds upcast radiant damage + concentration, and suppresses Invisibility', () => {
    const { session, caster, enemy, casterTok, enemyTok } = setupArena();
    const brand = spellAbility('Branding Smite');
    setSheetAbility('pc', caster.id, brand);
    setCondition('monster', enemy.id, { id: 'm-invis', label: 'Invisible', aura: 'blue', isConcentration: false });

    // Confirm offered on ranged hit as well as melee hit (give caster high attack bonus so even disadvantaged roll hits AC 14)
    updateCharacter(caster.id, {
      weapons: [
        { name: 'Longsword', kind: 'melee', damage: '1d8', damageType: 'slashing', attackBonus: 12 },
        { name: 'Longbow', kind: 'ranged', damage: '1d8', damageType: 'piercing', range: '150/600', attackBonus: 12 },
      ],
    });
    fixedDice(19, 3).run(() => {
      resolveAttack(session.id, caster.name, casterTok.id, enemyTok.id, 1); // Longbow (ranged)
    });
    const rangedRoll = listRollLog(session.id).at(-1)!;
    expect(rangedRoll.pending?.hitOptions?.abilityIds).toContain(brand.id);
    resolveAttackDamage(session.id, caster.name, rangedRoll.id);

    // Melee hit + Branding Smite cast at level 3 (3d6 radiant) -> 3*3 = +9 radiant + suppresses Invisibility
    const hpBefore = getMonster(enemy.id)!.curHp;
    fixedDice(19, 3).run(() => {
      resolveAttack(session.id, caster.name, casterTok.id, enemyTok.id, 0); // Longsword (melee)
      const meleeRoll = listRollLog(session.id).at(-1)!;
      expect(meleeRoll.pending?.hitOptions?.abilityIds).toContain(brand.id);
      const res = resolveHitFeature(session.id, caster.name, meleeRoll.id, brand.id, 3);
      expect(res.ok).toBe(true);
    });
    expect(getMonster(enemy.id)!.curHp).toBe(hpBefore - (3 + 9)); // 1d8->3 slashing + 3d6->9 radiant
    expect(getCharacter(caster.id)!.conditions.some((c) => c.isConcentration && c.label === 'Concentration: Branding Smite')).toBe(true);
    expect(getMonster(enemy.id)!.conditions.some((c) => c.label === 'Branding Smite' && c.combatEffect?.suppressesInvisibility)).toBe(true);

    // Invisibility suppression cancels the invisible-target disadvantage
    const ctx = evaluateAttackContext({
      attackerConditions: [],
      targetConditions: getMonster(enemy.id)!.conditions,
      within5ft: true,
    });
    expect(ctx.adv.state).toBeUndefined();
  });
});

describe('CombatSpell 12 buffs and restorations', () => {
  it('applies Shield of Faith, Mage Armor, Blur, See Invisibility, Greater Invisibility, and Heroism mechanics', () => {
    const { session, caster, ally, enemy, casterTok, allyTok, enemyTok } = setupArena();
    const sof = spellAbility('Shield of Faith');
    const mageArmor = spellAbility('Mage Armor');
    const blur = spellAbility('Blur');
    const seeInvis = spellAbility('See Invisibility');
    const greaterInvis = spellAbility('Greater Invisibility');
    const heroism = spellAbility('Heroism');
    const fireBolt = spellAbility('Fire Bolt');
    for (const s of [sof, mageArmor, blur, seeInvis, greaterInvis, heroism, fireBolt]) setSheetAbility('pc', caster.id, s);

    // Shield of Faith (+2 AC + concentration)
    expect(resolveAbilityRoll(session.id, caster.name, getCharacter(caster.id)!, sof, 1, undefined, allyTok.id)).toBe(true);
    expect(effectiveAc(getCharacter(ally.id)!)).toBe(17); // 15 + 2
    endConcentration('pc', caster.id, 'switch');
    expect(effectiveAc(getCharacter(ally.id)!)).toBe(15);

    // Mage Armor (13 + DEX +1 = 14 on AC-10 unarmored target, rejected when armored)
    updateCharacter(ally.id, { armorClass: 10 });
    expect(resolveAbilityRoll(session.id, caster.name, getCharacter(caster.id)!, mageArmor, 1, undefined, allyTok.id)).toBe(true);
    expect(effectiveAc(getCharacter(ally.id)!)).toBe(14); // 13 + 1 DEX
    updateCharacter(ally.id, { items: [{ id: 'arm', name: 'Chain Mail', note: 'Heavy armor', qty: 1, equipped: true }] });
    expect(resolveAbilityRoll(session.id, caster.name, getCharacter(caster.id)!, mageArmor, 1, undefined, allyTok.id)).toBe(false);
    updateCharacter(ally.id, { armorClass: 15, items: [] });

    // Blur: sight-based attack has Disadvantage, Blindsight ignores Blur
    expect(resolveAbilityRoll(session.id, caster.name, getCharacter(caster.id)!, blur, 2)).toBe(true);
    const sightRoll = fixedDice(12, 3);
    sightRoll.run(() => resolveAttack(session.id, enemy.name, enemyTok.id, casterTok.id, 0));
    expect(sightRoll.seenSides.some((s) => s.length === 2)).toBe(true);

    updateMonster(enemy.id, { abilities: [{ name: 'Blindsight', description: 'Blindsight 60 ft.' }] });
    const blindRoll = fixedDice(12, 3);
    blindRoll.run(() => resolveAttack(session.id, enemy.name, enemyTok.id, casterTok.id, 0));
    expect(blindRoll.seenSides.some((s) => s.length === 2)).toBe(false);

    // See Invisibility reveals invisible enemy in player buildSnapshot
    setCondition('monster', enemy.id, { id: 'inv-e', label: 'Invisible', aura: 'blue', isConcentration: false });
    expect(buildSnapshot(session.id, 'player')!.tokens.some((t) => t.id === enemyTok.id)).toBe(false);
    expect(resolveAbilityRoll(session.id, caster.name, getCharacter(caster.id)!, seeInvis, 2)).toBe(true);
    expect(buildSnapshot(session.id, 'player')!.tokens.some((t) => t.id === enemyTok.id)).toBe(true);

    // Greater Invisibility grants Invisible, grants adv / imposes dis, and persists after attack & spellcast
    updateMonster(enemy.id, { abilities: [] });
    for (const c of getMonster(enemy.id)!.conditions) clearCondition('monster', enemy.id, c.id);
    expect(resolveAbilityRoll(session.id, caster.name, getCharacter(caster.id)!, greaterInvis, 4, undefined, casterTok.id)).toBe(true);
    expect(getCharacter(caster.id)!.conditions.some((c) => c.label === 'Invisible')).toBe(true);
    const giAtk = fixedDice(12, 3);
    giAtk.run(() => {
      resolveAttack(session.id, caster.name, casterTok.id, enemyTok.id, 0);
      resolveAbilityRoll(session.id, caster.name, getCharacter(caster.id)!, fireBolt, 0, undefined, enemyTok.id);
    });
    expect(giAtk.seenSides.some((s) => s.length === 2)).toBe(true);
    expect(getCharacter(caster.id)!.conditions.some((c) => c.label === 'Invisible')).toBe(true);

    // Heroism cures Frightened, blocks reapplying Frightened, grants WIS mod (+4) temp HP, refreshes on start of turn, upcasts to 2 targets
    setCondition('pc', ally.id, { id: 'fr1', label: 'Frightened', aura: 'red', isConcentration: false });
    expect(resolveAbilityRoll(session.id, caster.name, getCharacter(caster.id)!, heroism, 2, undefined, undefined, undefined, undefined, [casterTok.id, allyTok.id])).toBe(true);
    expect(getCharacter(ally.id)!.tempHp).toBe(4);
    expect(getCharacter(caster.id)!.tempHp).toBe(4);
    expect(getCharacter(ally.id)!.conditions.some((c) => c.label === 'Frightened')).toBe(false);
    setCondition('pc', ally.id, { id: 'fr2', label: 'Frightened', aura: 'red', isConcentration: false });
    expect(getCharacter(ally.id)!.conditions.some((c) => c.label === 'Frightened')).toBe(false);
    setTempHp('pc', ally.id, 1);
    setCombatRound(session.id, 1);
    processHitEffects(session.id, allyTok, 'start');
    expect(getCharacter(ally.id)!.tempHp).toBe(4);
  });

  it('applies Protection from Poison, Lesser/Greater Restoration, Spare the Dying, Revivify, and Death Ward', () => {
    const { session, caster, ally, enemy, casterTok, allyTok, enemyTok } = setupArena();
    const pfp = spellAbility('Protection from Poison');
    const lesser = spellAbility('Lesser Restoration');
    const greater = spellAbility('Greater Restoration');
    const spare = spellAbility('Spare the Dying');
    const revivify = spellAbility('Revivify');
    const deathWard = spellAbility('Death Ward');
    for (const s of [pfp, lesser, greater, spare, revivify, deathWard]) setSheetAbility('pc', caster.id, s);

    // Protection from Poison clears Poisoned and halves incoming Poison damage
    setCondition('pc', ally.id, { id: 'psn', label: 'Poisoned', aura: 'red', isConcentration: false });
    expect(resolveAbilityRoll(session.id, caster.name, getCharacter(caster.id)!, pfp, 2, undefined, allyTok.id)).toBe(true);
    expect(getCharacter(ally.id)!.conditions.some((c) => c.label === 'Poisoned')).toBe(false);
    updateMonster(enemy.id, {
      weapons: [{ name: 'Venom', kind: 'melee', damage: '10', damageType: 'poison', attackBonus: 10 }],
    });
    fixedDice(19, 3).run(() => {
      resolveAttack(session.id, enemy.name, enemyTok.id, allyTok.id, 0);
      resolveAttackDamage(session.id, enemy.name, listRollLog(session.id).at(-1)!.id);
    });
    expect(getCharacter(ally.id)!.curHp).toBe(55); // 10 poison -> 5 resisted

    // Lesser Restoration cures chosen condition
    setCondition('pc', ally.id, { id: 'par', label: 'Paralyzed', aura: 'red', isConcentration: false });
    setCondition('pc', ally.id, { id: 'bln', label: 'Blinded', aura: 'red', isConcentration: false });
    expect(resolveAbilityRoll(session.id, caster.name, getCharacter(caster.id)!, lesser, 2, undefined, allyTok.id, undefined, undefined, undefined, 'Blinded')).toBe(true);
    expect(getCharacter(ally.id)!.conditions.some((c) => c.label === 'Blinded')).toBe(false);
    expect(getCharacter(ally.id)!.conditions.some((c) => c.label === 'Paralyzed')).toBe(true);
    expect(resolveAbilityRoll(session.id, caster.name, getCharacter(caster.id)!, lesser, 2, undefined, allyTok.id, undefined, undefined, undefined, 'Paralyzed')).toBe(true);
    expect(getCharacter(ally.id)!.conditions.some((c) => c.label === 'Paralyzed')).toBe(false);

    // Greater Restoration decrements Exhaustion 3 -> 2 and clears Petrified / Charmed
    setCondition('pc', ally.id, { id: 'exh', label: 'Exhaustion 3', aura: 'red', isConcentration: false });
    setCondition('pc', ally.id, { id: 'pet', label: 'Petrified', aura: 'red', isConcentration: false });
    expect(resolveAbilityRoll(session.id, caster.name, getCharacter(caster.id)!, greater, 5, undefined, allyTok.id, undefined, undefined, undefined, 'Exhaustion (-1 Level)')).toBe(true);
    expect(getCharacter(ally.id)!.conditions.some((c) => c.label === 'Exhaustion 2')).toBe(true);
    expect(resolveAbilityRoll(session.id, caster.name, getCharacter(caster.id)!, greater, 5, undefined, allyTok.id, undefined, undefined, undefined, 'Petrified')).toBe(true);
    expect(getCharacter(ally.id)!.conditions.some((c) => c.label === 'Petrified')).toBe(false);

    // Spare the Dying scales to 30 ft at Cleric lvl 11 (Wait lvl 11 = 60 ft! Move ally to 30 ft)
    updateCharacter(caster.id, { level: 5 }); // range 30 ft at level 5
    applyDamage('pc', ally.id, 60);
    setDeathSaves(ally.id, 0, 1);
    // 30 ft = 300 px -> (400, 100) from (100, 100)
    // Temporarily move ally via update; use createToken/sessions helper via 30ft coordinates
    const farAlly = createCharacter(session.id, { name: 'FarDown', className: 'Rogue', level: 3, maxHp: 30, curHp: 0 });
    const farTok = createToken({ mapId: casterTok.mapId, kind: 'pc', refId: farAlly.id, x: 400, y: 100 }); // 30 ft away
    expect(resolveAbilityRoll(session.id, caster.name, getCharacter(caster.id)!, spare, 0, undefined, farTok.id)).toBe(true);
    expect(getCharacter(farAlly.id)!.deathSaves.successes).toBe(3);

    // Revivify rejects living target, revives dead target at 0 HP + 3 failed death saves to 1 HP
    expect(resolveAbilityRoll(session.id, caster.name, getCharacter(caster.id)!, revivify, 3, undefined, casterTok.id)).toBe(false);
    setDeathSaves(ally.id, 0, 3);
    expect(resolveAbilityRoll(session.id, caster.name, getCharacter(caster.id)!, revivify, 3, undefined, allyTok.id)).toBe(true);
    expect(getCharacter(ally.id)!.curHp).toBe(1);
    expect(getCharacter(ally.id)!.deathSaves.failures).toBe(0);

    // Death Ward saves target at 1 HP once instead of dropping to 0 HP, then expires
    updateCharacter(ally.id, { curHp: 8 });
    expect(resolveAbilityRoll(session.id, caster.name, getCharacter(caster.id)!, deathWard, 4, undefined, allyTok.id)).toBe(true);
    expect(getCharacter(ally.id)!.conditions.some((c) => c.label === 'Death Ward')).toBe(true);
    applyDamage('pc', ally.id, 15, 'slashing');
    expect(getCharacter(ally.id)!.curHp).toBe(1);
    expect(getCharacter(ally.id)!.conditions.some((c) => c.label === 'Death Ward')).toBe(false);
    applyDamage('pc', ally.id, 5, 'slashing');
    expect(getCharacter(ally.id)!.curHp).toBe(0);
  });
});

describe('Crowd control spells (Faerie Fire, Entangle, Slow, Blindness/Deafness, Tasha’s Hideous Laughter)', () => {
  it('Faerie Fire outlines failed targets in 20-ft cube, grants advantage, and suppresses Invisibility', () => {
    const { session, map, caster, enemy, casterTok, enemyTok } = setupArena();
    const ff = spellAbility('Faerie Fire');
    setSheetAbility('pc', caster.id, ff);
    setCondition('monster', enemy.id, { id: 'e-inv', label: 'Invisible', aura: 'blue', isConcentration: false });

    fixedDice(2, 3).run(() => {
      expect(
        resolveAbilityRoll(session.id, caster.name, getCharacter(caster.id)!, ff, 1, undefined, undefined, undefined, {
          mapId: map.id,
          points: [{ x: enemyTok.x, y: enemyTok.y }],
          angle: 0,
        }),
      ).toBe(true);
    });
    expect(getMonster(enemy.id)!.conditions.some((c) => c.label === 'Faerie Fire')).toBe(true);
    expect(buildSnapshot(session.id, 'player')!.tokens.some((t) => t.id === enemyTok.id)).toBe(true);

    const atk = fixedDice(12, 3);
    atk.run(() => resolveAttack(session.id, caster.name, casterTok.id, enemyTok.id, 0));
    expect(atk.seenSides.some((s) => s.length === 2)).toBe(true);
  });

  it('Entangle restrains failed creatures in 20-ft square and clears when concentration ends', () => {
    const { session, map, caster, enemy, enemyTok } = setupArena();
    const entangle = spellAbility('Entangle');
    setSheetAbility('pc', caster.id, entangle);

    fixedDice(2, 3).run(() => {
      expect(
        resolveAbilityRoll(session.id, caster.name, getCharacter(caster.id)!, entangle, 1, undefined, undefined, undefined, {
          mapId: map.id,
          points: [{ x: enemyTok.x, y: enemyTok.y }],
          angle: 0,
        }),
      ).toBe(true);
    });
    expect(getMonster(enemy.id)!.conditions.some((c) => c.label === 'Restrained')).toBe(true);
    endConcentration('pc', caster.id, 'ended');
    expect(getMonster(enemy.id)!.conditions.some((c) => c.label === 'Restrained')).toBe(false);
  });

  it('Slow hits up to 6 chosen targets in 40-ft cube, applies -2 AC & DEX saves, halved speed, blocks reactions, and repeats WIS save at turn end', () => {
    const { session, map, caster, ally, enemy, allyTok, enemyTok } = setupArena();
    const slow = spellAbility('Slow');
    setSheetAbility('pc', caster.id, slow);
    updateCharacter(ally.id, { speed: '30 ft' });
    setSheetAbility('pc', ally.id, spellAbility('Shield'));

    fixedDice(2, 3).run(() => {
      expect(
        resolveAbilityRoll(session.id, caster.name, getCharacter(caster.id)!, slow, 3, undefined, undefined, undefined, {
          mapId: map.id,
          points: [{ x: allyTok.x, y: allyTok.y }],
          angle: 0,
          selected: [allyTok.id, enemyTok.id],
        }),
      ).toBe(true);
    });
    const slowedAlly = getCharacter(ally.id)!;
    expect(slowedAlly.conditions.some((c) => c.label === 'Slow')).toBe(true);
    expect(effectiveAc(slowedAlly)).toBe(13); // 15 - 2
    expect(saveExtra(slowedAlly, 'DEX').total).toBe(-2);
    expect(effectiveSpeed(slowedAlly)).toBe('15 ft');
    expect(shieldGate(session.id, 'pc', ally.id, 18, false)).toBeUndefined();

    // End-of-turn repeat WIS save passes -> Slow removed
    setCombatRound(session.id, 1);
    fixedDice(20, 3).run(() => processHitEffects(session.id, allyTok, 'end'));
    expect(getCharacter(ally.id)!.conditions.some((c) => c.label === 'Slow')).toBe(false);
    expect(effectiveAc(getCharacter(ally.id)!)).toBe(15);
  });

  it('Blindness/Deafness supports condition choice without concentration and upcasts to extra targets', () => {
    const { session, caster, enemy, casterTok, enemyTok } = setupArena();
    const foe2 = instantiateMonster(createMonsterTemplate(session.id, { name: 'Goblin2', maxHp: 30 }).id)!;
    const foe2Tok = createToken({ mapId: casterTok.mapId, kind: 'monster', refId: foe2.id, x: 250, y: 100 });
    const bd = spellAbility('Blindness/Deafness');
    setSheetAbility('pc', caster.id, bd);
    setSheetAbility('pc', caster.id, spellAbility('Bless'));

    // Start Bless concentration first to confirm Blindness/Deafness does NOT drop concentration
    resolveAbilityRoll(session.id, caster.name, getCharacter(caster.id)!, spellAbility('Bless'), 1, undefined, casterTok.id);
    expect(getCharacter(caster.id)!.conditions.some((c) => c.isConcentration)).toBe(true);

    // L2 cannot target 2 creatures; L3 targets 2 creatures with Deafened/Blinded
    expect(resolveAbilityRoll(session.id, caster.name, getCharacter(caster.id)!, bd, 2, undefined, undefined, undefined, undefined, [enemyTok.id, foe2Tok.id], 'Deafened')).toBe(false);
    fixedDice(2, 3).run(() => {
      expect(resolveAbilityRoll(session.id, caster.name, getCharacter(caster.id)!, bd, 3, undefined, undefined, undefined, undefined, [enemyTok.id, foe2Tok.id], 'Deafened')).toBe(true);
    });
    expect(getCharacter(caster.id)!.conditions.some((c) => c.isConcentration && c.label === 'Concentration: Bless')).toBe(true);
    expect(getMonster(enemy.id)!.conditions.some((c) => c.label === 'Deafened')).toBe(true);
    expect(getMonster(foe2.id)!.conditions.some((c) => c.label === 'Deafened')).toBe(true);

    // Repeat CON save clears Deafened
    setCombatRound(session.id, 1);
    fixedDice(20, 3).run(() => processHitEffects(session.id, enemyTok, 'end'));
    expect(getMonster(enemy.id)!.conditions.some((c) => c.label === 'Deafened')).toBe(false);
  });

  it("Tasha's Hideous Laughter applies Prone & Incapacitated, upcasts, and triggers an Advantage WIS save on AoE damage inside resolvePlacedSpell", () => {
    const { session, map, caster, ally, enemy, allyTok, enemyTok } = setupArena();
    const laughter = spellAbility("Tasha's Hideous Laughter");
    const fireball = spellAbility('Fireball');
    setSheetAbility('pc', caster.id, laughter);
    setSheetAbility('pc', caster.id, fireball);

    // L2 upcast hits both ally & enemy
    fixedDice(2, 3).run(() => {
      expect(resolveAbilityRoll(session.id, caster.name, getCharacter(caster.id)!, laughter, 2, undefined, undefined, undefined, undefined, [allyTok.id, enemyTok.id])).toBe(true);
    });
    expect(getCharacter(ally.id)!.conditions.some((c) => c.label === "Tasha's Hideous Laughter")).toBe(true);
    expect(getCharacter(ally.id)!.conditions.some((c) => c.label === 'Incapacitated')).toBe(true);
    expect(getCharacter(ally.id)!.conditions.some((c) => c.label === 'Prone')).toBe(true);

    // Drop concentration, re-cast L1 at enemy only (using a second caster so Fireball won't drop caster's own concentration)
    endConcentration('pc', caster.id, 'reset');
    const wizard = createCharacter(session.id, { name: 'Evoker', className: 'Wizard', level: 5, stats: { INT: 16 } });
    setSheetAbility('pc', wizard.id, fireball);
    const wizTok = createToken({ mapId: map.id, kind: 'pc', refId: wizard.id, x: 50, y: 100 });
    void wizTok;

    fixedDice(2, 3).run(() => {
      expect(resolveAbilityRoll(session.id, caster.name, getCharacter(caster.id)!, laughter, 1, undefined, enemyTok.id)).toBe(true);
    });
    expect(getMonster(enemy.id)!.conditions.some((c) => c.label === "Tasha's Hideous Laughter")).toBe(true);

    // Place Fireball on enemyTok under withDiceSource: damage triggers Advantage WIS save ([5, 17] -> 17 >= DC)
    const fbSides: number[][] = [];
    withDiceSource((sides) => {
      fbSides.push([...sides]);
      if (sides.length === 2 && sides[0] === 20 && sides[1] === 20) return [5, 17];
      return sides.map((s) => (s === 20 ? 12 : 3));
    }, () => {
      expect(
        resolveAbilityRoll(session.id, wizard.name, wizard, fireball, 3, undefined, undefined, undefined, {
          mapId: map.id,
          points: [{ x: enemyTok.x, y: enemyTok.y }],
          angle: 0,
        }),
      ).toBe(true);
    });
    expect(fbSides.some((s) => s.length === 2 && s[0] === 20 && s[1] === 20)).toBe(true);
    expect(getMonster(enemy.id)!.conditions.some((c) => c.label === "Tasha's Hideous Laughter")).toBe(false);
    expect(getMonster(enemy.id)!.conditions.some((c) => c.label === 'Incapacitated')).toBe(false);
    expect(listRollLog(session.id).some((r) => r.label === "Tasha's Hideous Laughter — Damage WIS save" && r.detail.includes('PASS'))).toBe(true);
  });
});

describe('Custom, manual, and edited-roll opt-outs', () => {
  it('excludes custom, executionProfile manual, and edited spells from Combat ready and canonical automation', () => {
    const { session, caster, ally, allyTok } = setupArena();

    const customShieldOfFaith = spellAbility('Shield of Faith', { source: 'custom' });
    const manualAgathys = spellAbility('Armor of Agathys', { executionProfile: 'manual' });
    const editedHeal = spellAbility('Heal', {
      roll: { kind: 'heal', dice: '4d8', baseLevel: 6, damageType: 'healing', healingBonus: 'none' },
    });
    const editedFaerie = spellAbility('Faerie Fire', {
      roll: { kind: 'damage', dice: '2d6', baseLevel: 1, damageType: 'fire' },
    });
    const manualBranding = spellAbility('Branding Smite', { executionProfile: 'manual' });

    expect(spellCombatSupport(customShieldOfFaith)?.status).toBe('manual');
    expect(spellCombatSupport(manualAgathys)?.status).toBe('partial'); // retains saved roll without canonical cold ward
    expect(spellCombatSupport(editedHeal)?.status).toBe('partial');
    expect(spellCombatSupport(editedFaerie)?.status).toBe('partial');
    expect(spellCombatSupport(manualBranding)?.status).toBe('partial');

    setSheetAbility('pc', caster.id, customShieldOfFaith);
    setSheetAbility('pc', caster.id, manualAgathys);
    setSheetAbility('pc', caster.id, editedHeal);
    updateCharacter(ally.id, { maxHp: 60, curHp: 10 });
    setCondition('pc', ally.id, { id: 'e-bln', label: 'Blinded', aura: 'red', isConcentration: false });

    // Custom Shield of Faith logs manual cast without granting Shield of Faith +2 AC buff condition
    expect(resolveAbilityRoll(session.id, caster.name, getCharacter(caster.id)!, customShieldOfFaith, 1, undefined, allyTok.id)).toBe(true);
    expect(effectiveAc(getCharacter(ally.id)!)).toBe(15);

    // executionProfile: 'manual' Armor of Agathys does not attach Armor of Agathys retaliation ward
    expect(resolveAbilityRoll(session.id, caster.name, getCharacter(caster.id)!, manualAgathys, 1)).toBe(true);
    expect(getCharacter(caster.id)!.conditions.some((c) => c.label.startsWith('Armor of Agathys'))).toBe(false);

    // Edited Heal (4d8) uses authored roll and does NOT auto-cure Blinded
    fixedDice(12, 3).run(() => {
      expect(resolveAbilityRoll(session.id, caster.name, getCharacter(caster.id)!, editedHeal, 6, undefined, allyTok.id)).toBe(true);
    });
    expect(getCharacter(ally.id)!.curHp).toBe(22); // 10 + 4*3
    expect(getCharacter(ally.id)!.conditions.some((c) => c.label === 'Blinded')).toBe(true);
  });
});
