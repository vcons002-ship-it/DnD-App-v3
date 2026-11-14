import { describe, expect, it } from 'vitest';
import {
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
  setSheetAbility,
  updateCharacter,
  updateMonster,
} from './sessions.js';
import {
  resolveAbilityRoll,
  resolveAttack,
  resolveAttackDamage,
  resolveForcedSave,
} from './combat.js';
import { processHitEffects } from './hitEffectTurns.js';
import { withDiceSource } from '../../shared/dice.js';
import { effectiveAc, saveExtra } from '../../shared/modifiers.js';
import { spellAreaFor } from '../../shared/spellAreas.js';
import { effectiveSpeed, rollBlessBaneBonus } from '../../shared/spellBuffs.js';
import { effectiveSheetAbility, spellMaxTargets } from '../../shared/spellExecution.js';
import { spellCastSummary, spellCombatSupport } from '../../shared/spellSupport.js';
import type { SheetAbility, Weapon } from '../../shared/types.js';

function fixedDice(d20 = 12, d4 = 3) {
  const seenSides: number[][] = [];
  return {
    seenSides,
    run<T>(fn: () => T): T {
      return withDiceSource((sides) => {
        seenSides.push([...sides]);
        if (sides.length === 2 && sides[0] === 20 && sides[1] === 20) return [4, 16];
        return sides.map((s) => (s === 4 ? d4 : s === 20 ? d20 : Math.min(s, 3)));
      }, fn);
    },
  };
}

function setupArena() {
  const session = createSession('Manual Spell Builder Arena');
  const map = createMap(session.id, { name: 'Arena' });
  setActiveMap(session.id, map.id);
  const longsword: Weapon = { name: 'Longsword', kind: 'melee', damage: '1d8', damageType: 'slashing' };
  let caster = createCharacter(session.id, {
    name: 'Lyra',
    className: 'Cleric',
    level: 5,
    maxHp: 60,
    curHp: 60,
    armorClass: 15,
    stats: { STR: 10, DEX: 14, CON: 14, INT: 12, WIS: 18, CHA: 12 },
    saveProficiencies: ['WIS', 'CHA'],
    weapons: [longsword],
  });
  caster = updateCharacter(caster.id, {
    spellSlots: {
      L1: { max: 4, used: 0 },
      L2: { max: 3, used: 0 },
      L3: { max: 3, used: 0 },
    },
  })!;
  const ally = createCharacter(session.id, {
    name: 'Mira',
    className: 'Sorcerer',
    level: 5,
    maxHp: 50,
    curHp: 50,
    armorClass: 10,
    speed: '30 ft.',
    stats: { STR: 8, DEX: 14, CON: 12, INT: 10, WIS: 12, CHA: 18 },
    saveProficiencies: ['CON', 'CHA'],
    weapons: [],
  });
  const enemyTemplate = createMonsterTemplate(session.id, {
    name: 'Bandit Captain',
    maxHp: 80,
    armorClass: 14,
    speed: '30 ft.',
    stats: { STR: 12, DEX: 12, CON: 12, INT: 10, WIS: 10, CHA: 10 },
  });
  const enemy = updateMonster(instantiateMonster(enemyTemplate.id)!.id, {
    weapons: [{ name: 'Scimitar', kind: 'melee', damage: '6', damageType: 'slashing', attackBonus: 5 }],
  })!;
  const casterTok = createToken({ mapId: map.id, kind: 'pc', refId: caster.id, x: 100, y: 100 });
  const allyTok = createToken({ mapId: map.id, kind: 'pc', refId: ally.id, x: 150, y: 100 });
  const enemyTok = createToken({ mapId: map.id, kind: 'monster', refId: enemy.id, x: 250, y: 100 });
  return { session, map, caster, ally, enemy, casterTok, allyTok, enemyTok };
}

describe('Manual spell effect builder end-to-end mechanics', () => {
  it('updates sheetAbilities in place for both PC and Monster while overriding canonical profiles', () => {
    const { caster, enemy } = setupArena();
    const s1: SheetAbility = { id: 'ab-1', name: 'Fire Bolt', type: 'spell', level: 0, description: 'First' };
    const haste: SheetAbility = { id: 'ab-haste', name: 'Haste', type: 'spell', level: 3, description: 'Speed' };
    const s3: SheetAbility = { id: 'ab-3', name: 'Shield', type: 'spell', level: 1, description: 'Last' };
    setSheetAbility('pc', caster.id, s1);
    setSheetAbility('pc', caster.id, haste);
    setSheetAbility('pc', caster.id, s3);

    const editedHaste: SheetAbility = {
      ...haste,
      executionProfile: 'manual',
      roll: { kind: 'damage', dice: '3d6', damageType: 'lightning', baseLevel: 3 },
    };
    setSheetAbility('pc', caster.id, editedHaste);

    const pcAbilities = getCharacter(caster.id)!.sheetAbilities;
    expect(pcAbilities.map((a) => a.id)).toEqual(['ab-1', 'ab-haste', 'ab-3']);
    expect(effectiveSheetAbility(pcAbilities[1]).roll?.damageType).toBe('lightning');
    expect(spellCombatSupport(pcAbilities[1])?.manualCastOnly).toBe(false);
    expect(spellCastSummary(pcAbilities[1])?.text).toContain('3d6');
    expect(spellCastSummary(pcAbilities[1])?.text.toLowerCase()).toContain('lightning');

    const m1: SheetAbility = { id: 'm-1', name: 'Glare', type: 'ability', description: 'Gaze' };
    const m2: SheetAbility = { id: 'm-2', name: 'Bash', type: 'ability', description: 'Hit' };
    setSheetAbility('monster', enemy.id, m1);
    setSheetAbility('monster', enemy.id, m2);
    setSheetAbility('monster', enemy.id, {
      ...m1,
      executionProfile: 'manual',
      roll: { kind: 'save', save: 'WIS', dc: 15, saveDamage: 'none', dice: '2d8', damageType: 'psychic' },
    });

    const monsterAbilities = getMonster(enemy.id)!.sheetAbilities;
    expect(monsterAbilities.map((a) => a.id)).toEqual(['m-1', 'm-2']);
    expect(monsterAbilities[0].roll?.dc).toBe(15);
  });

  it('executes manual save + customEffect (zeroSpeed, repeat save, ongoing damage, concentration cleanup)', () => {
    const { session, caster, enemy, enemyTok } = setupArena();
    const shackle: SheetAbility = {
      id: 'man-shackle',
      name: 'Mind Shackle',
      type: 'spell',
      source: 'custom',
      executionProfile: 'manual',
      level: 2,
      tags: ['concentration'],
      description: 'Psychic shackles halt the foe.',
      roll: {
        kind: 'save',
        save: 'WIS',
        saveDamage: 'half',
        baseLevel: 2,
        dice: '2d6',
        damageType: 'psychic',
        customEffect: {
          conditionLabel: 'Mind Shackled',
          zeroSpeed: true,
          repeatSave: 'WIS',
          repeatPhase: 'end',
          repeatDamage: '1d6',
          repeatDamageType: 'psychic',
          saveBeforeDamage: true,
        },
      },
    };
    setSheetAbility('pc', caster.id, shackle);

    // Failed initial save (d20 = 2, d6 rolls = 3 -> 2d6 = 6 psychic damage)
    fixedDice(2, 3).run(() => {
      expect(
        resolveAbilityRoll(session.id, caster.name, getCharacter(caster.id)!, shackle, 2, undefined, enemyTok.id),
      ).toBe(true);
      const pending = listRollLog(session.id).at(-1)!;
      if (pending.apply) resolveForcedSave(session.id, pending.id, enemyTok.id);
    });

    const afterHit = getMonster(enemy.id)!;
    expect(afterHit.curHp).toBe(74); // 80 - 6
    expect(afterHit.conditions.some((c) => c.label === 'Mind Shackled')).toBe(true);
    expect(effectiveSpeed(afterHit)).toBe('0 ft.');
    expect(getCharacter(caster.id)!.conditions.some((c) => c.isConcentration)).toBe(true);

    // Round 1 end: fail repeat WIS save -> takes 1d6 = 3 psychic damage, keeps condition
    setCombatRound(session.id, 1);
    fixedDice(2, 3).run(() => {
      processHitEffects(session.id, enemyTok, 'end');
    });
    expect(getMonster(enemy.id)!.curHp).toBe(71);
    expect(getMonster(enemy.id)!.conditions.some((c) => c.label === 'Mind Shackled')).toBe(true);

    // Round 2 end: pass repeat WIS save -> saveBeforeDamage clears condition without taking turn damage
    setCombatRound(session.id, 2);
    fixedDice(19, 3).run(() => {
      processHitEffects(session.id, enemyTok, 'end');
    });
    expect(getMonster(enemy.id)!.curHp).toBe(71);
    expect(getMonster(enemy.id)!.conditions.some((c) => c.label === 'Mind Shackled')).toBe(false);

    // Recast then end caster's concentration -> condition is cleared
    fixedDice(2, 3).run(() => {
      resolveAbilityRoll(session.id, caster.name, getCharacter(caster.id)!, shackle, 2, undefined, enemyTok.id);
      const pending = listRollLog(session.id).at(-1)!;
      if (pending.apply) resolveForcedSave(session.id, pending.id, enemyTok.id);
    });
    expect(getMonster(enemy.id)!.conditions.some((c) => c.label === 'Mind Shackled')).toBe(true);
    endConcentration('pc', caster.id, 'test');
    expect(getMonster(enemy.id)!.conditions.some((c) => c.label === 'Mind Shackled')).toBe(false);
  });

  it('honors manual attackBonus override, attackRange, and on-hit customEffect rider', () => {
    const { session, caster, casterTok, enemy, enemyTok } = setupArena();
    const frostBolt: SheetAbility = {
      id: 'man-frost',
      name: 'Frost Lance',
      type: 'spell',
      source: 'custom',
      executionProfile: 'manual',
      level: 1,
      description: 'Cold lance with on-hit chill.',
      roll: {
        kind: 'attack',
        attackBonus: 11, // derived would be +7 (+4 WIS +3 PB); d20=3 + 11 = 14 hits AC 14
        attackRange: 'ranged',
        dice: '2d8',
        damageType: 'cold',
        customEffect: {
          conditionLabel: 'Frostbitten',
          speedReduction: 10,
          nextAttackDisadvantage: true,
          durationRounds: 2,
        },
      },
    };
    setSheetAbility('pc', caster.id, frostBolt);

    fixedDice(3, 3).run(() => {
      expect(
        resolveAbilityRoll(session.id, caster.name, getCharacter(caster.id)!, frostBolt, 1, undefined, enemyTok.id),
      ).toBe(true);
      const pending = listRollLog(session.id).at(-1)!;
      expect(pending.total).toBe(14);
      expect(pending.pending).toBeTruthy();
      expect(pending.pending?.done).toBeFalsy();
      resolveAttackDamage(session.id, caster.name, pending.id);
    });

    const chilled = getMonster(enemy.id)!;
    expect(chilled.curHp).toBe(74); // 80 - (3+3)
    expect(chilled.conditions.some((c) => c.label === 'Frostbitten')).toBe(true);
    expect(effectiveSpeed(chilled)).toBe('20 ft.'); // 30 - 10

    // Enemy's next attack suffers disadvantage from nextAttackDisadvantage
    const atkDice = fixedDice(12, 3);
    atkDice.run(() => {
      resolveAttack(session.id, chilled.name, enemyTok.id, casterTok.id, 0);
    });
    expect(atkDice.seenSides.some((s) => s.length === 2 && s[0] === 20 && s[1] === 20)).toBe(true);
  });

  it('applies manual no-dice buff AC/baseAc, attack/save dice, speedBonus, resistance, and condition immunity', () => {
    const { session, caster, ally, allyTok } = setupArena();
    const bastion: SheetAbility = {
      id: 'man-buff',
      name: 'Arcane Bastion',
      type: 'spell',
      source: 'custom',
      executionProfile: 'manual',
      level: 2,
      description: 'Comprehensive defensive & offensive buff.',
      roll: {
        kind: 'damage',
        dice: '0',
        baseLevel: 2,
        targetMode: 'single',
        customEffect: {
          target: 'ally',
          conditionLabel: 'Arcane Bastion',
          aura: 'blue',
          baseAc: 13,
          baseAcAddsDex: true,
          acBonus: 2,
          attackBonus: 1,
          saveBonus: 2,
          attackBonusDice: '1d4',
          saveBonusDice: '-1d4',
          speedBonus: 15,
          resistDamageTypes: ['fire'],
          immuneConditions: ['Frightened'],
        },
      },
    };
    setSheetAbility('pc', caster.id, bastion);

    expect(
      resolveAbilityRoll(session.id, caster.name, getCharacter(caster.id)!, bastion, 2, undefined, allyTok.id),
    ).toBe(true);

    const buffed = getCharacter(ally.id)!;
    expect(buffed.conditions.some((c) => c.label === 'Arcane Bastion')).toBe(true);
    expect(effectiveAc(buffed)).toBe(17); // baseAc 13 + DEX 2 + acBonus 2
    expect(saveExtra(buffed, 'WIS').total).toBe(2);
    expect(effectiveSpeed(buffed)).toBe('45 ft.'); // 30 + 15

    fixedDice(12, 3).run(() => {
      const atkRoll = rollBlessBaneBonus(buffed, 'attack');
      const saveRoll = rollBlessBaneBonus(buffed, 'save');
      expect(atkRoll.bonus).toBe(3);
      expect(saveRoll.bonus).toBe(-3);
    });

    // Resistance to fire halves fire spell damage
    const fireHit: SheetAbility = {
      id: 'man-fire',
      name: 'Ember Ray',
      type: 'spell',
      source: 'custom',
      executionProfile: 'manual',
      level: 1,
      description: 'Auto fire hit.',
      roll: { kind: 'damage', dice: '10', damageType: 'fire' },
    };
    const hpBefore = getCharacter(ally.id)!.curHp;
    setSheetAbility('pc', caster.id, fireHit);
    resolveAbilityRoll(session.id, caster.name, getCharacter(caster.id)!, fireHit, 1, undefined, allyTok.id);
    expect(getCharacter(ally.id)!.curHp).toBe(hpBefore - 5);

    // Condition immunity blocks Frightened
    setCondition('pc', ally.id, { id: 'fright-test', label: 'Frightened', aura: 'red', isConcentration: false });
    expect(getCharacter(ally.id)!.conditions.some((c) => c.label === 'Frightened')).toBe(false);
  });

  it('cures listed conditions via manual saveless cure without logging "takes 0"', () => {
    const { session, caster, ally, allyTok } = setupArena();
    setCondition('pc', ally.id, { id: 'c1', label: 'Poisoned', aura: 'green', isConcentration: false });
    setCondition('pc', ally.id, { id: 'c2', label: 'Blinded', aura: 'red', isConcentration: false });
    setCondition('pc', ally.id, { id: 'c3', label: 'Prone', aura: 'red', isConcentration: false });

    const cleanse: SheetAbility = {
      id: 'man-cleanse',
      name: 'Purify Touch',
      type: 'spell',
      source: 'custom',
      executionProfile: 'manual',
      level: 1,
      description: 'Removes Poisoned and Blinded.',
      roll: {
        kind: 'damage',
        dice: '0',
        baseLevel: 1,
        targetMode: 'single',
        customEffect: {
          target: 'ally',
          cureConditions: ['Poisoned', 'Blinded'],
        },
      },
    };
    setSheetAbility('pc', caster.id, cleanse);

    expect(
      resolveAbilityRoll(session.id, caster.name, getCharacter(caster.id)!, cleanse, 1, undefined, allyTok.id),
    ).toBe(true);

    const remaining = getCharacter(ally.id)!.conditions.map((c) => c.label);
    expect(remaining).not.toContain('Poisoned');
    expect(remaining).not.toContain('Blinded');
    expect(remaining).toContain('Prone');

    const log = listRollLog(session.id).at(-1)!;
    expect(log.detail).not.toMatch(/takes 0/i);
  });

  it('scales target cap on upcast using scaleTargets and enforces cap at lower slots', () => {
    const { session, caster, ally, casterTok, allyTok, enemyTok } = setupArena();
    const extraAlly = createCharacter(session.id, {
      name: 'Dorian',
      className: 'Fighter',
      level: 3,
      maxHp: 30,
      curHp: 30,
      armorClass: 15,
    });
    const extraTok = createToken({ mapId: casterTok.mapId, kind: 'pc', refId: extraAlly.id, x: 180, y: 100 });

    const multiBuff: SheetAbility = {
      id: 'man-multi',
      name: 'Shared Ward',
      type: 'spell',
      source: 'custom',
      executionProfile: 'manual',
      level: 1,
      description: 'Buffs 1 creature +1 per upcast level.',
      roll: {
        kind: 'damage',
        dice: '0',
        baseLevel: 1,
        targetMode: 'multiple',
        maxTargets: 1,
        scaleTargets: 1,
        customEffect: {
          target: 'ally',
          conditionLabel: 'Shared Ward',
          acBonus: 1,
        },
      },
    };
    setSheetAbility('pc', caster.id, multiBuff);

    expect(spellMaxTargets(multiBuff.roll, 1, 1)).toBe(1);
    expect(spellMaxTargets(multiBuff.roll, 3, 1)).toBe(3);

    // Picking 3 targets at level 1 exceeds maxTargets=1 -> rejected
    expect(
      resolveAbilityRoll(
        session.id,
        caster.name,
        getCharacter(caster.id)!,
        multiBuff,
        1,
        undefined,
        undefined,
        undefined,
        undefined,
        [casterTok.id, allyTok.id, extraTok.id],
      ),
    ).toBe(false);

    // Upcast to level 3 allows 3 targets -> all 3 buffed
    expect(
      resolveAbilityRoll(
        session.id,
        caster.name,
        getCharacter(caster.id)!,
        multiBuff,
        3,
        undefined,
        undefined,
        undefined,
        undefined,
        [casterTok.id, allyTok.id, extraTok.id],
      ),
    ).toBe(true);
    expect(getCharacter(caster.id)!.conditions.some((c) => c.label === 'Shared Ward')).toBe(true);
    expect(getCharacter(ally.id)!.conditions.some((c) => c.label === 'Shared Ward')).toBe(true);
    expect(getCharacter(extraAlly.id)!.conditions.some((c) => c.label === 'Shared Ward')).toBe(true);
    expect(getMonster(enemyTok.refId)!.conditions.some((c) => c.label === 'Shared Ward')).toBe(false);
  });

  it('supports custom roll.area shapes and explicit "no-area" opt-out on catalog spells', () => {
    expect(spellAreaFor({ name: 'Fireball', type: 'spell', level: 3 })?.kind).toBe('sphere');

    const noAreaFireball: SheetAbility = {
      id: 'fb-noarea',
      name: 'Fireball',
      type: 'spell',
      level: 3,
      executionProfile: 'manual',
      tags: ['no-area'],
      description: 'Modified single-target blast.',
      roll: { kind: 'save', save: 'DEX', dice: '8d6', damageType: 'fire', targetMode: 'single' },
    };
    expect(spellAreaFor(noAreaFireball)).toBeUndefined();

    const customCone: SheetAbility = {
      id: 'custom-cone',
      name: 'Acid Breath',
      type: 'spell',
      level: 2,
      executionProfile: 'manual',
      description: '30-ft cone of acid.',
      roll: {
        kind: 'save',
        save: 'DEX',
        dice: '4d8',
        damageType: 'acid',
        area: { kind: 'cone', sizeFt: 30, rangeFt: 0, self: true },
      },
    };
    expect(spellAreaFor(customCone)).toEqual({ kind: 'cone', sizeFt: 30, rangeFt: 0, self: true });
  });

  it('reports combat-ready support and cast summary for custom smite abilities', () => {
    const grimSmite: SheetAbility = {
      id: 'man-smite',
      name: 'Grim Smite',
      type: 'spell',
      source: 'custom',
      executionProfile: 'manual',
      level: 2,
      actionType: 'bonus',
      description: 'Deal necrotic smite damage on a melee hit.',
      smite: {
        dice: '3d8',
        scaleDice: '1d8',
        damageType: 'necrotic',
        bonusVs: { creatureTypes: ['celestial'], dice: '1d8' },
      },
    };
    const support = spellCombatSupport(grimSmite);
    expect(support).not.toBeNull();
    expect(support?.manualCastOnly).toBe(false);
    expect(support?.automated.join(' ').toLowerCase()).toContain('post-hit option');
    const summary = spellCastSummary(grimSmite);
    expect(summary?.needsEdit).toBe(false);
    expect(summary?.text).toContain('3d8');
    expect(summary?.text).toContain('1d8/lvl');
    expect(summary?.text.toLowerCase()).toContain('necrotic');
  });
});
