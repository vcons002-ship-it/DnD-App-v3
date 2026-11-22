import { test, expect, budget, type APIRequestContext, type Page } from './helpers/test';
import { io, type Socket } from 'socket.io-client';
import os from 'node:os';
import path from 'node:path';
import type { LiveDiceFrame } from '../shared/liveDiceTypes';
import type { SheetAbility, StateSnapshot, Weapon } from '../shared/types';
import { DM_SECRET, PORT } from './playwright.config';
import {
  dismissCommittedRoll,
  LIVE_COMBAT_TIMEOUT,
  observeCombatDice,
  waitForCombatRoll,
} from './helpers/combatLive';

const ARTIFACT_DIR = process.env.DICE_SHOWCASE_DIR || path.join(os.tmpdir(), 'dnd-dice-showcase');

const connections: Socket[] = [];
test.beforeEach(() => test.setTimeout(180_000));
test.afterEach(() => connections.splice(0).forEach((socket) => socket.disconnect()));

const SAVAGE_ATTACKER: SheetAbility = {
  id: 'feat-savage-attacker',
  name: 'Savage Attacker',
  type: 'ability',
  description: 'Once per turn when you hit with a weapon, reroll its damage dice via the damage tray button and use either total.',
  stance: { active: false, appliesTo: 'all', rerollDamageDice: true },
};

const SAVAGE_ATTACKS: SheetAbility = {
  id: 'racial-savage-attacks',
  name: 'Savage Attacks',
  type: 'stance',
  description: 'Roll one additional weapon damage die on a melee critical hit.',
  stance: { active: true, appliesTo: 'melee', extraCritDie: true },
};

const GREAT_WEAPON_FIGHTING: SheetAbility = {
  id: 'fs-gwf',
  name: 'Great Weapon Fighting',
  type: 'ability',
  description:
    'When you roll a 1 or a 2 on a damage die for an attack you make with a melee weapon that you are wielding with two hands, you can treat the roll as a 3.',
};

const HALFLING_LUCKY: SheetAbility = {
  id: 'trait-halfling-lucky',
  name: 'Lucky',
  type: 'ability',
  tags: ['halfling'],
  description:
    'When you roll a 1 on the d20 of an attack roll, ability check, or saving throw, you can reroll the die and must use the new roll.',
};

async function createArena(
  request: APIRequestContext,
  page: Page,
  opts: {
    weapons: Weapon[];
    abilities: SheetAbility[];
    paralyzeTarget?: boolean;
    manualDamage?: boolean;
    spellSlots?: Record<string, { max: number; used: number }>;
  },
) {
  const created = await request.post('/api/sessions', {
    headers: { 'x-dm-passphrase': DM_SECRET },
    data: { name: 'Custom dice triggers E2E' },
  });
  expect(created.ok()).toBeTruthy();
  const { code } = await created.json();
  const socket = io(`http://localhost:${PORT}`, { transports: ['websocket'], forceNew: true });
  connections.push(socket);
  const frames = observeCombatDice(socket);
  const snapshot = async (): Promise<StateSnapshot> => {
    const result = await socket.timeout(5000).emitWithAck('join', {
      sessionCode: code,
      role: 'dm',
      dmPassphrase: DM_SECRET,
    });
    expect(result.ok).toBe(true);
    return result.snapshot;
  };
  const initial = await snapshot();
  const character = initial.characters.find((candidate) => candidate.name === 'Druk')!;
  socket.emit('character:update', {
    characterId: character.id,
    stats: { STR: 16, DEX: 12, CON: 14, INT: 12, WIS: 12, CHA: 12 },
    armorClass: 10,
    maxHp: 200,
    curHp: 200,
    weapons: opts.weapons,
    sheetAbilities: opts.abilities,
    ...(opts.spellSlots ? { spellSlots: opts.spellSlots } : {}),
  });
  socket.emit('session:setManualDamage', { manual: opts.manualDamage ?? true });

  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 1000;
    canvas.height = 600;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#273128';
    ctx.fillRect(0, 0, 1000, 600);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  const map = await (
    await request.post(`/api/sessions/${code}/maps`, {
      headers: { 'x-dm-passphrase': DM_SECRET },
      multipart: {
        name: 'Arena',
        image: { name: 'arena.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') },
      },
    })
  ).json();

  socket.emit('map:setGrid', { mapId: map.id, gridSizePx: 64, feetPerSquare: 5, widthFt: 95, locked: false });
  socket.emit('map:setActive', { mapId: map.id });
  socket.emit('fog:setLayer', { mapId: map.id, layer: 'map', enabled: false });
  socket.emit('fog:setLayer', { mapId: map.id, layer: 'tokens', enabled: false });
  socket.emit('token:spawn', { mapId: map.id, kind: 'pc', refId: character.id, x: 300, y: 240 });
  socket.emit('monster:create', {
    name: 'Training Golem',
    disposition: 'enemy',
    maxHp: 500,
    armorClass: 1,
    weapons: [],
  });
  const template = (await snapshot()).monsterTemplates.find((m) => m.name === 'Training Golem')!;
  socket.emit('token:spawn', { mapId: map.id, kind: 'monster', refId: template.id, x: 340, y: 240 });
  const ready = await snapshot();
  const targetToken = ready.tokens.find((t) => t.kind === 'monster')!;
  if (opts.paralyzeTarget) {
    socket.emit('condition:set', {
      kind: 'monster',
      refId: targetToken.refId,
      condition: { label: 'Paralyzed', aura: 'yellow' },
    });
  }
  await snapshot();

  await page.setViewportSize({ width: 1440, height: 900 });
  page.setDefaultTimeout(budget(15_000));
  await page.goto(`/join?code=${code}`);
  await page.getByRole('button', { name: 'Join', exact: true }).click();
  await page.locator('.claim-row').filter({ hasText: 'Druk' }).click();
  await expect(page.getByTestId('player-hud')).toBeVisible();

  const clickToken = async (id: string) => {
    const point = await page.evaluate((tokenId) => {
      const stage = (window as unknown as { Konva: { stages: any[] } }).Konva.stages.find(
        (s) => s.find('.token-hit-region').length,
      );
      const shape = stage.find('.token-hit-region').find((node: any) => node.getAttr('tokenId') === tokenId);
      const position = shape.getAbsolutePosition();
      const bounds = stage.container().getBoundingClientRect();
      return { x: bounds.left + position.x, y: bounds.top + position.y };
    }, id);
    await page.mouse.click(point.x, point.y);
  };

  return { socket, snapshot, frames, characterId: character.id, targetTokenId: targetToken.id, targetRefId: targetToken.refId, clickToken };
}

async function attackAndStartDamage(
  page: Page,
  ctx: Awaited<ReturnType<typeof createArena>>,
  weaponName: RegExp,
): Promise<{ attackId: string; dmgFrames: () => LiveDiceFrame[]; trayId: string }> {
  let attackEntry;
  for (let attempt = 0; attempt < 5 && !attackEntry; attempt++) {
    const previous = new Set((await ctx.snapshot()).rollLog.map((r) => r.id));
    await page.locator('.compact-player-combat').getByRole('button', { name: weaponName }).click();
    const entry = await waitForCombatRoll(ctx.snapshot, previous, (r) => r.label === 'Attack');
    await dismissCommittedRoll(page, entry.id);
    if (entry.pending && !entry.pending.done) attackEntry = entry;
  }
  expect(attackEntry).toBeTruthy();

  const frameCursor = ctx.frames.length;
  await page.locator('.damage-prompt-btn').click();
  await expect(page.locator('[data-live-dice="true"]')).toBeVisible({ timeout: LIVE_COMBAT_TIMEOUT });

  let trayId = '';
  await expect
    .poll(() => {
      const hit = ctx.frames.slice(frameCursor).find((f) => !!f.plannedDice);
      if (hit) trayId = hit.id;
      return trayId;
    }, { timeout: LIVE_COMBAT_TIMEOUT })
    .not.toBe('');

  return {
    attackId: attackEntry!.id,
    dmgFrames: () => ctx.frames.slice(frameCursor).filter((f) => f.id === trayId),
    trayId,
  };
}

async function captureSettledTray(
  page: Page,
  trayId: string,
  minFilledCount: number,
  outFileName: string,
  bannerSelector?: string,
  roleLabelSelector?: string,
) {
  let clipBox: { x: number; y: number; width: number; height: number } | null = null;
  await expect
    .poll(
      async () => {
        clipBox = await page.evaluate(
          ({ id, minFilled, banner, roleLabel }) => {
            const tray = document.querySelector(`.roll-reveal-backdrop[data-roll-id="${id}"]`);
            if (!tray) return null;
            if (tray.querySelectorAll('.tray-die-result[data-filled="true"]').length < minFilled) return null;
            if (roleLabel && tray.querySelectorAll(`${roleLabel}[data-positioned="true"]`).length < 1) return null;
            if (banner) {
              const b = tray.querySelector(banner) as HTMLElement | null;
              if (!b) return null;
              const style = window.getComputedStyle(b);
              if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return null;
            }
            const card = tray.querySelector('.roll-reveal') as HTMLElement | null;
            if (!card) return null;
            const rect = card.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return null;
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
          },
          { id: trayId, minFilled: minFilledCount, banner: bannerSelector ?? null, roleLabel: roleLabelSelector ?? null },
        );
        return clipBox !== null;
      },
      { timeout: LIVE_COMBAT_TIMEOUT, intervals: [30, 50] },
    )
    .toBe(true);
  await page.screenshot({
    path: path.join(ARTIFACT_DIR, outFileName),
    animations: 'disabled',
    clip: clipBox!,
  });
  await expect(page.locator(`.roll-reveal-backdrop[data-roll-id="${trayId}"] .roll-reveal`).first()).toBeVisible({ timeout: 1000 });
}

test('Captures Savage Attacker + Savage Attacks unified crit tray screenshot', async ({ page, request }) => {
  const ctx = await createArena(request, page, {
    weapons: [{ name: 'Greataxe', kind: 'melee', damage: '1d12', damageType: 'slashing', attackBonus: 100 }],
    abilities: [SAVAGE_ATTACKER, SAVAGE_ATTACKS],
    paralyzeTarget: true,
  });
  const roll = await attackAndStartDamage(page, ctx, /Greataxe/);
  const tray = page.locator(`.roll-reveal-backdrop[data-roll-id="${roll.trayId}"]`);
  const rerollBtn = tray.getByRole('button', { name: /Reroll \(Savage Attacker\)/i });
  await expect(rerollBtn).toBeVisible({ timeout: LIVE_COMBAT_TIMEOUT });
  await expect(rerollBtn).toBeEnabled({ timeout: LIVE_COMBAT_TIMEOUT });
  await captureSettledTray(
    page,
    roll.trayId,
    3,
    'dice-flow-savage-prompt.png',
    '.tray-savage-banner[data-tray-banner="savage-crit"]',
    '.tray-die-role-label.is-savage-crit',
  );
  await rerollBtn.click();
  await expect.poll(() => roll.dmgFrames().some((f) => f.done && f.sides.length === 6), { timeout: LIVE_COMBAT_TIMEOUT, intervals: [50, 80] }).toBe(true);
  await captureSettledTray(
    page,
    roll.trayId,
    6,
    'dice-flow-savage.png',
    '.tray-savage-banner[data-tray-banner="savage-both"]',
    '.tray-die-role-label.is-savage-crit',
  );
  await expect.poll(async () => (await ctx.snapshot()).rollLog.find((r) => r.id === roll.attackId)?.pending?.done, { timeout: LIVE_COMBAT_TIMEOUT }).toBe(true);
});

test('Captures Great Weapon Fighting floor (1,2→3) with teal rings, pill, banner & raw→adjusted boxes', async ({ page, request }) => {
  const ctx = await createArena(request, page, {
    weapons: [
      {
        name: 'Greathammer',
        kind: 'melee',
        damage: '4d4',
        damageType: 'bludgeoning',
        attackBonus: 100,
        tags: ['heavy', 'two-handed'],
      },
    ],
    abilities: [GREAT_WEAPON_FIGHTING],
  });

  let captured = false;
  for (let attempt = 0; attempt < 6 && !captured; attempt++) {
    const roll = await attackAndStartDamage(page, ctx, /Greathammer/);
    await expect.poll(() => roll.dmgFrames().some((f) => f.done && f.sides.length === 4), { timeout: LIVE_COMBAT_TIMEOUT, intervals: [50, 80] }).toBe(true);
    const doneFrame = roll.dmgFrames().find((f) => f.done);
    if (doneFrame?.dieRoles?.includes('floored')) {
      await captureSettledTray(
        page,
        roll.trayId,
        4,
        'dice-flow-gwf-floor.png',
        '.tray-savage-banner[data-tray-banner="floor"]',
        '.tray-die-role-label.is-floored',
      );
      captured = true;
    } else {
      const skipBtn = page.getByRole('button', { name: 'Skip roll animation' });
      if (await skipBtn.isVisible().catch(() => false)) await skipBtn.click();
    }
    await expect.poll(async () => (await ctx.snapshot()).rollLog.find((r) => r.id === roll.attackId)?.pending?.done, { timeout: LIVE_COMBAT_TIMEOUT }).toBe(true);
    await dismissCommittedRoll(page, roll.attackId);
  }
  expect(captured).toBe(true);
});

test('Edits custom exploding spell in SpellEffectEditor and captures exploding burst tray screenshot', async ({ page, request }) => {
  const starterCustomSpell: SheetAbility = {
    id: 'custom-storm-crack',
    name: 'Storm Crack',
    type: 'spell',
    level: 0,
    description: 'Crackling lightning arc.',
    source: 'custom',
    executionProfile: 'manual',
    roll: { kind: 'damage', dice: '6d4', damageType: 'lightning', castingAbility: 'INT' },
  };
  const ctx = await createArena(request, page, {
    weapons: [],
    abilities: [starterCustomSpell],
  });

  // Author Exploding Dice via SpellEffectEditor -> DiceRulesEditor
  await page.getByRole('button', { name: 'Character', exact: true }).click();
  await page.locator('.character-window').getByRole('button', { name: 'Spellbook', exact: true }).click();
  await page.getByRole('button', { name: 'Edit Storm Crack', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit spell Storm Crack' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: /Dice Roll Rules & Triggers/i }).click();
  await dialog.getByLabel(/Exploding Dice/i).check();
  await dialog.getByLabel('Explosion Cap').selectOption('number');
  await dialog.getByLabel('Max Explosions').fill('3');
  await dialog.getByLabel('Tray Pill Label').fill('Storm Surge');
  await dialog.getByRole('button', { name: /Save Spell Effects/i }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: 'Close character window', exact: true }).click();

  let captured = false;
  for (let attempt = 0; attempt < 5 && !captured; attempt++) {
    const frameCursor = ctx.frames.length;
    const previous = new Set((await ctx.snapshot()).rollLog.map((r) => r.id));
    await page.getByRole('region', { name: 'Combat panel' }).getByRole('button', { name: 'Cast Storm Crack', exact: true }).click();
    const castDialog = page.getByRole('dialog', { name: 'Cast Storm Crack', exact: true });
    await expect(castDialog).toBeVisible();
    await castDialog.getByRole('button', { name: /Cast Storm Crack/i }).click();

    await expect(page.locator('[data-live-dice="true"]')).toBeVisible({ timeout: LIVE_COMBAT_TIMEOUT });
    let finalFrame: LiveDiceFrame | undefined;
    await expect
      .poll(
        () => {
          const mine = ctx.frames.slice(frameCursor);
          const f = mine.at(-1);
          if (!f?.done) return false;
          // If the last settled die was a 4 (and explosions remain under cap 3), wait briefly for the next wave frame.
          const lastDice = f.sides.map((_, i) => f.values[i]);
          const usedExplosions = f.burstLinks?.length ?? 0;
          const anyTriggerPending =
            f.burstLinks && usedExplosions < 3
              ? lastDice.slice(-1)[0] === 4
              : lastDice.some((v) => v === 4) && !f.burstLinks;
          if (anyTriggerPending && mine.filter((x) => x.done).length === 1) return false;
          finalFrame = f;
          return true;
        },
        { timeout: LIVE_COMBAT_TIMEOUT, intervals: [60, 100] },
      )
      .toBe(true);

    const trayId = finalFrame!.id;
    if ((finalFrame?.burstLinks?.length ?? 0) > 0) {
      await captureSettledTray(
        page,
        trayId,
        finalFrame!.sides.length,
        'dice-flow-exploding-custom.png',
        '.tray-savage-banner[data-tray-banner="explode"]',
        '.tray-die-role-label.is-exploded',
      );
      captured = true;
    } else {
      const skipBtn = page.getByRole('button', { name: 'Skip roll animation' });
      if (await skipBtn.isVisible().catch(() => false)) await skipBtn.click();
    }
    const entry = await waitForCombatRoll(ctx.snapshot, previous, (r) => r.label === 'Storm Crack');
    await dismissCommittedRoll(page, entry.id);
  }
  expect(captured).toBe(true);
});

test('Edits weapon in WeaponAdvancedEditor (⚙) and captures same-tray rider + TriggeredSpellPrompt', async ({ page, request }) => {
  const ctx = await createArena(request, page, {
    weapons: [{ name: 'Greatsword', kind: 'melee', damage: '2d6', damageType: 'slashing', attackBonus: 100 }],
    abilities: [],
    spellSlots: { L3: { max: 2, used: 0 } },
  });

  await page.getByRole('button', { name: 'Character', exact: true }).click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('button', { name: 'Advanced rules for Greatsword', exact: true }).click();
  const adv = page.getByRole('dialog', { name: 'Weapon advanced rules for Greatsword' });
  await expect(adv).toBeVisible();

  await adv.getByLabel('Critical Threshold').selectOption('19');
  await adv.getByRole('button', { name: '＋ Blank Trigger' }).click();
  await adv.getByPlaceholder('Trigger label (shown in tray badge)').first().fill('Solar Flare');
  await adv.getByLabel('Extra Damage Dice').first().fill('2d6');
  await adv.getByLabel('Extra Damage Type').first().selectOption('radiant');

  await adv.getByRole('button', { name: /Fireball on Nat 20/i }).click();
  await adv.getByLabel('Trigger Condition').nth(1).selectOption('on-hit');

  await adv.getByRole('button', { name: /Save Weapon Rules/i }).click();
  await expect(adv).toHaveCount(0);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Close character window', exact: true }).click();

  const roll = await attackAndStartDamage(page, ctx, /Greatsword/);
  await expect.poll(() => roll.dmgFrames().some((f) => f.done && f.sides.length === 4), { timeout: LIVE_COMBAT_TIMEOUT, intervals: [50, 80] }).toBe(true);
  await captureSettledTray(
    page,
    roll.trayId,
    4,
    'dice-flow-weapon-trigger.png',
    '.tray-savage-banner[data-tray-banner="rider"]',
    '.tray-die-role-label.is-rider',
  );

  await expect.poll(async () => (await ctx.snapshot()).rollLog.find((r) => r.id === roll.attackId)?.pending?.done, { timeout: LIVE_COMBAT_TIMEOUT }).toBe(true);
  await dismissCommittedRoll(page, roll.attackId);

  const prompt = page.getByRole('region', { name: 'Triggered weapon spell' });
  await expect(prompt).toBeVisible({ timeout: LIVE_COMBAT_TIMEOUT });
  await expect(prompt).toContainText('Fireball');
  await expect(prompt).toContainText('Free cast · no spell slot');
  await page.screenshot({ path: path.join(ARTIFACT_DIR, 'dice-flow-triggered-spell.png'), animations: 'disabled' });

  // Place triggered Fireball cleanly without spending L3 slots
  await prompt.getByRole('button', { name: /Place Fireball/i }).click();
  const area = page.getByRole('region', { name: 'Place spell area' });
  await expect(area).toContainText('Free weapon trigger');
  await ctx.clickToken(ctx.targetTokenId);
  await area.getByRole('button', { name: /Confirm area/ }).click();
  await expect.poll(async () => (await ctx.snapshot()).rollLog.some((r) => r.label === 'Fireball'), { timeout: LIVE_COMBAT_TIMEOUT }).toBe(true);
  const after = await ctx.snapshot();
  const char = after.characters.find((c) => c.id === ctx.characterId)!;
  expect(char.spellSlots.L3?.used ?? 0).toBe(0);
});

test('Captures Halfling Lucky Nat 1 reroll in same d20 tray', async ({ page, request }) => {
  test.setTimeout(360_000);
  const ctx = await createArena(request, page, {
    weapons: [],
    abilities: [HALFLING_LUCKY],
    manualDamage: false,
  });

  const previous = new Set((await ctx.snapshot()).rollLog.map((r) => r.id));
  const drawer = page.getByRole('region', { name: 'Quick skill checks' });
  const disBtn = drawer.getByRole('button', { name: 'Dis', exact: true });
  const acrobaticsBtn = drawer.getByRole('button', { name: /Roll Acrobatics check/i });
  const skipBtn = page.getByRole('button', { name: 'Skip roll animation' });

  let captured = false;
  for (let attempt = 0; attempt < 90 && !captured; attempt++) {
    const frameCursor = ctx.frames.length;
    if (!(await drawer.isVisible().catch(() => false))) {
      await page.getByRole('button', { name: 'Checks', exact: true }).click();
    }
    await expect(drawer).toBeVisible();
    if (!((await disBtn.getAttribute('class')) ?? '').includes('on')) {
      await disBtn.click();
    }
    await acrobaticsBtn.click();

    await expect(page.locator('[data-live-dice="true"]')).toBeVisible({ timeout: LIVE_COMBAT_TIMEOUT });
    let settledFrame: LiveDiceFrame | undefined;
    await expect
      .poll(
        () => {
          const mine = ctx.frames.slice(frameCursor);
          const f = mine.at(-1);
          if (!f?.done) return false;
          // If wave 1 rolled a 1 with Halfling Lucky, wait for the lucky-reroll wave!
          if (f.values.some((v) => v === 1) && !f.dieRoles?.includes('lucky-reroll')) return false;
          settledFrame = f;
          return true;
        },
        { timeout: LIVE_COMBAT_TIMEOUT, intervals: [50, 80] },
      )
      .toBe(true);

    if (settledFrame?.dieRoles?.includes('lucky-reroll')) {
      await captureSettledTray(
        page,
        settledFrame.id,
        settledFrame.sides.length,
        'dice-flow-lucky.png',
        '.tray-savage-banner[data-tray-banner="lucky"]',
        '.tray-die-role-label.is-lucky-reroll',
      );
      captured = true;
    } else {
      if (await skipBtn.isVisible().catch(() => false)) await skipBtn.click();
    }
    const entry = await waitForCombatRoll(ctx.snapshot, previous, (r) => r.label.includes('Acrobatics'));
    previous.add(entry.id);
    await dismissCommittedRoll(page, entry.id);
  }
  expect(captured).toBe(true);
});
