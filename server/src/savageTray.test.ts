import { describe, it, expect } from 'vitest';
import { rollWeaponAttack, type AttackOutcome } from '../../shared/combatMath.js';
import { hasDrukMaximum } from '../../shared/dicePresentationTiming.js';
import type { LiveDiceFrame } from '../../shared/liveDiceTypes.js';
import type { Weapon } from '../../shared/types.js';
import { physicalFaces, runLiveCommand } from './liveRolls.js';
import { requestLiveRerollChoice } from './liveRollContext.js';

const greatsword: Weapon = { name: 'Greatsword', kind: 'melee', damage: '2d6', damageType: 'slashing' };
const greataxe: Weapon = { name: 'Greataxe', kind: 'melee', damage: '1d12', damageType: 'slashing' };
const attacker = { stats: { STR: 16 }, level: 5, isMonster: false };

const fixedHit = (crit: boolean): AttackOutcome => ({
  face: crit ? 20 : 15,
  bonus: 6,
  attackTotal: crit ? 26 : 21,
  crit,
  fumble: false,
  hit: true,
  damage: 0,
  detail: '',
  detailToHit: 'd20[15] +6',
  toHitSteps: [],
  damageDiceSteps: [],
  damageModSteps: [],
});

describe('Savage Attacker & Savage Attacks continuous live tray', () => {
  it('keeps Savage Attacker reroll waves, curved links, and kept/discarded markings in one continuous tray', async () => {
    const frames: LiveDiceFrame[] = [];
    let outcome!: AttackOutcome;
    let seed = 100;
    await runLiveCommand(
      () => {
        outcome = rollWeaponAttack(attacker, greatsword, 12, undefined, {
          fixedAttack: fixedHit(false),
          rerollDamageDice: true,
        });
      },
      (frame) => frames.push(frame),
      { label: 'Greatsword', roller: 'Druk', className: 'Fighter', waitForPresentation: async () => {} },
      (sides, publish, meta, _seed, info) => physicalFaces(sides, publish, meta, seed++, info),
    );

    expect(new Set(frames.map((f) => f.id)).size).toBe(1);
    expect(frames.every((f, i) => i === 0 || f.seq > frames[i - 1].seq)).toBe(true);

    const wave1Settled = frames.find((f) => f.done && f.sides.length === 2)!;
    expect(wave1Settled).toBeTruthy();
    expect(wave1Settled.plannedDice).toEqual([
      { sides: 6, set: 0, critical: false },
      { sides: 6, set: 0, critical: false },
      { sides: 6, set: 1, critical: false },
      { sides: 6, set: 1, critical: false },
    ]);
    expect(wave1Settled.diceTrigger?.kind).toBe('savage-attacker');
    expect(wave1Settled.trayBanner?.tone).toBe('savage-reroll');

    const final = frames.at(-1)!;
    expect(final.done).toBe(true);
    expect(final.sides).toEqual([6, 6, 6, 6]);
    expect(final.sets).toEqual([0, 0, 1, 1]);
    expect(final.rerollLinks).toEqual([{ from: 0, to: 2 }, { from: 1, to: 3 }]);
    expect(final.poses.slice(0, 14)).toEqual(wave1Settled.poses);

    const roll1 = (final.values[0] as number) + (final.values[1] as number);
    const roll2 = (final.values[2] as number) + (final.values[3] as number);
    const expectedKept = roll2 > roll1 ? 1 : 0;
    expect(final.kept).toBe(expectedKept);
    expect(final.discardedDice).toEqual([expectedKept !== 0, expectedKept !== 0, expectedKept !== 1, expectedKept !== 1]);
    expect(final.trayBanner?.title).toBe('Savage Attacker');
    expect(outcome.damage).toBe(Math.max(roll1, roll2) + 3);
    expect(outcome.detail).toContain(`[SAVAGE ${Math.max(roll1, roll2)}/${Math.min(roll1, roll2)}]`);
  }, 20000);

  it('rolls Savage Attacks extra crit die in the same crit damage tray with clear labels and breakdown source', async () => {
    const frames: LiveDiceFrame[] = [];
    let outcome!: AttackOutcome;
    await runLiveCommand(
      () => {
        outcome = rollWeaponAttack(attacker, greataxe, 12, undefined, {
          fixedAttack: fixedHit(true),
          extraCritDie: true,
        });
      },
      (frame) => frames.push(frame),
      { label: 'Greataxe', roller: 'Druk', className: 'Fighter', waitForPresentation: async () => {} },
      (sides, publish, meta, _seed, info) => physicalFaces(sides, publish, meta, 202, info),
    );

    expect(new Set(frames.map((f) => f.id)).size).toBe(1);
    const final = frames.at(-1)!;
    expect(final.done).toBe(true);
    expect(final.sides).toEqual([12, 12, 12]);
    expect(final.critical).toEqual([false, true, false]);
    expect(final.dieRoles).toEqual(['base', 'crit', 'savage-crit']);
    expect(final.dieLabels).toEqual([null, 'CRIT', 'Savage Attacks']);
    expect(final.trayBanner?.tone).toBe('savage-crit');
    expect(final.trayBanner?.title).toBe('Savage Attacks');
    expect(final.diceTrigger?.kind).toBe('savage-attacks');
    expect(final.diceTrigger?.groups).toEqual([{ value: final.values[2], indices: [2] }]);
    expect(outcome.damageDiceSteps[2]).toMatchObject({
      label: '1d12',
      critical: true,
      source: 'Savage Attacks',
    });
    expect(outcome.damage).toBe((final.values[0] as number) + (final.values[1] as number) + (final.values[2] as number) + 3);
  }, 20000);

  it('composes Savage Attacker + Savage Attacks on a critical hit by rerolling all 3d12 inside one 6-die continuous tray', async () => {
    const frames: LiveDiceFrame[] = [];
    let outcome!: AttackOutcome;
    let seed = 300;
    await runLiveCommand(
      () => {
        outcome = rollWeaponAttack(attacker, greataxe, 12, undefined, {
          fixedAttack: fixedHit(true),
          rerollDamageDice: true,
          extraCritDie: true,
        });
      },
      (frame) => frames.push(frame),
      { label: 'Greataxe', roller: 'Druk', className: 'Fighter', waitForPresentation: async () => {} },
      (sides, publish, meta, _seed, info) => physicalFaces(sides, publish, meta, seed++, info),
    );

    expect(new Set(frames.map((f) => f.id)).size).toBe(1);
    expect(frames.every((f, i) => i === 0 || f.seq > frames[i - 1].seq)).toBe(true);

    const wave1Settled = frames.find((f) => f.done && f.sides.length === 3)!;
    const final = frames.at(-1)!;
    expect(wave1Settled).toBeTruthy();
    expect(final.done).toBe(true);
    expect(final.sides).toEqual([12, 12, 12, 12, 12, 12]);
    expect(final.sets).toEqual([0, 0, 0, 1, 1, 1]);
    expect(final.critical).toEqual([false, true, false, false, true, false]);
    expect(final.dieRoles).toEqual(['base', 'crit', 'savage-crit', 'reroll', 'reroll-crit', 'savage-crit']);
    expect(final.rerollLinks).toEqual([
      { from: 0, to: 3 },
      { from: 1, to: 4 },
      { from: 2, to: 5 },
    ]);
    expect(final.poses.slice(0, 21)).toEqual(wave1Settled.poses);

    const r1 = (final.values[0] as number) + (final.values[1] as number) + (final.values[2] as number);
    const r2 = (final.values[3] as number) + (final.values[4] as number) + (final.values[5] as number);
    const keptSet = r2 > r1 ? 1 : 0;
    expect(final.kept).toBe(keptSet);
    expect(final.discardedDice).toEqual([
      keptSet !== 0,
      keptSet !== 0,
      keptSet !== 0,
      keptSet !== 1,
      keptSet !== 1,
      keptSet !== 1,
    ]);
    expect(final.trayBanner?.tone).toBe('savage-both');
    expect(final.diceTrigger?.kind).toBe('savage-attacker');
    expect(outcome.damage).toBe(Math.max(r1, r2) + 3);
    expect(outcome.detail).toContain(`[SAVAGE ${Math.max(r1, r2)}/${Math.min(r1, r2)}]`);
  }, 20000);

  it('supports interactive tray reroll prompt (both Reroll=true -> Wave 2 and Keep=false -> Wave 1 only)', async () => {
    for (const acceptReroll of [true, false]) {
      const frames: LiveDiceFrame[] = [];
      let promptSeen = 0;
      let outcome!: AttackOutcome;
      let seed = 400;
      await runLiveCommand(
        () => {
          outcome = rollWeaponAttack(attacker, greataxe, 12, undefined, {
            fixedAttack: fixedHit(true),
            rerollDamageDice: true,
            extraCritDie: true,
            interactiveReroll: true,
            chooseReroll: (info) => requestLiveRerollChoice('savage-interactive', info),
          });
        },
        (frame) => frames.push(frame),
        {
          label: 'Greataxe',
          roller: 'Druk',
          className: 'Fighter',
          waitForPresentation: async () => {},
          chooseReroll: async (_frameId, info) => {
            promptSeen++;
            expect(info.label).toBe('Savage Attacker');
            expect(info.diceSummary).toContain('3d12');
            return acceptReroll;
          },
        },
        (sides, publish, meta, _seed, info) => physicalFaces(sides, publish, meta, seed++, info),
      );

      expect(promptSeen).toBe(1);
      expect(frames.some((f) => f.rerollOfferLabel === 'Savage Attacker')).toBe(true);
      expect(frames.some((f) => !!f.rerollPrompt && f.rerollPrompt.label === 'Savage Attacker')).toBe(true);
      const final = frames.at(-1)!;
      expect(final.rerollPrompt).toBeUndefined();
      expect(outcome.usedReroll).toBe(acceptReroll);
      expect(final.sides).toHaveLength(acceptReroll ? 6 : 3);
    }
  }, 25000);

  it('excludes discarded Savage Attacker max dice from hasDrukMaximum while honoring kept & Savage Attacks dice', () => {
    const baseFrame: LiveDiceFrame = {
      id: 'druk-test',
      seq: 1,
      label: 'Greataxe',
      roller: 'Druk',
      className: 'Fighter',
      sides: [12, 12, 12, 12, 12],
      sets: [0, 0, 1, 1, 2],
      critical: [false, true, false, true, true],
      percentile: [null, null, null, null, null],
      rerolls: [0, 0, 0, 0, 0],
      radius: 1,
      poses: [],
      elapsed: 4,
      done: true,
      kept: 1,
      discardedDice: [true, true, false, false, false],
      values: [12, 1, 7, 8, 9],
    };
    expect(hasDrukMaximum(baseFrame)).toBe(false);
    expect(hasDrukMaximum({ ...baseFrame, values: [12, 1, 7, 8, 12] })).toBe(true);
    expect(hasDrukMaximum({ ...baseFrame, values: [3, 1, 12, 8, 5] })).toBe(true);
  });
});
