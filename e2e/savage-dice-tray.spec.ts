import { test, expect, budget, type APIRequestContext, type Page } from './helpers/test';
import { io, type Socket } from 'socket.io-client';
import type { LiveDiceFrame } from '../shared/liveDiceTypes';
import type { SheetAbility, StateSnapshot, Weapon } from '../shared/types';
import { DM_SECRET, PORT } from './playwright.config';
import { dismissCommittedRoll, LIVE_COMBAT_TIMEOUT, observeCombatDice, waitForCombatRoll } from './helpers/combatLive';

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

async function createArena(
  request: APIRequestContext,
  page: Page,
  opts: { weapons: Weapon[]; abilities: SheetAbility[]; paralyzeTarget?: boolean },
) {
  const created = await request.post('/api/sessions', {
    headers: { 'x-dm-passphrase': DM_SECRET },
    data: { name: 'Savage dice tray E2E' },
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
    stats: { STR: 16, DEX: 10, CON: 14, INT: 10, WIS: 10, CHA: 10 },
    armorClass: 10,
    maxHp: 200,
    curHp: 200,
    weapons: opts.weapons,
    sheetAbilities: opts.abilities,
  });
  socket.emit('session:setManualDamage', { manual: true });

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
        name: 'Savage arena',
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
    name: 'Practice dummy',
    disposition: 'enemy',
    maxHp: 300,
    armorClass: 1,
    weapons: [],
  });
  const template = (await snapshot()).monsterTemplates.find((m) => m.name === 'Practice dummy')!;
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
  return { socket, snapshot, frames, targetRefId: targetToken.refId };
}

async function attackAndStartDamage(
  page: Page,
  ctx: Awaited<ReturnType<typeof createArena>>,
  weaponName: RegExp,
): Promise<{ hpBefore: number; attackId: string; dmgFrames: LiveDiceFrame[]; trayId: string; crit: boolean }> {
  let attackEntry;
  for (let attempt = 0; attempt < 5 && !attackEntry; attempt++) {
    const previous = new Set((await ctx.snapshot()).rollLog.map((r) => r.id));
    await page.locator('.compact-player-combat').getByRole('button', { name: weaponName }).click();
    const entry = await waitForCombatRoll(ctx.snapshot, previous, (r) => r.label === 'Attack');
    await dismissCommittedRoll(page, entry.id);
    if (entry.pending && !entry.pending.done) attackEntry = entry;
  }
  expect(attackEntry).toBeTruthy();

  const before = await ctx.snapshot();
  const hpBefore = before.monsters.find((m) => m.id === ctx.targetRefId)!.curHp;
  const frameCursor = ctx.frames.length;
  await page.locator('.damage-prompt-btn').click();
  await expect(page.locator('[data-live-dice="true"]')).toBeVisible({ timeout: LIVE_COMBAT_TIMEOUT });

  let trayId = '';
  await expect
    .poll(() => {
      const recent = ctx.frames.slice(frameCursor);
      const hit = recent.find((f) => !!f.plannedDice);
      if (hit) trayId = hit.id;
      return trayId;
    }, { timeout: LIVE_COMBAT_TIMEOUT })
    .not.toBe('');

  return {
    hpBefore,
    attackId: attackEntry!.id,
    crit: Boolean(attackEntry?.pending?.crit),
    get dmgFrames() {
      return ctx.frames.slice(frameCursor).filter((f) => f.id === trayId);
    },
    trayId,
  };
}

test('Savage Attacker uses an interactive tray button (no stance toggle) and rerolls in the same tray without skipping animation', async ({ page, request }) => {
  const ctx = await createArena(request, page, {
    weapons: [{ name: 'Greatsword', kind: 'melee', damage: '2d6', damageType: 'slashing', attackBonus: 100 }],
    abilities: [SAVAGE_ATTACKER],
  });

  // No standalone On/Off toggle in the Combat panel for Savage Attacker.
  await expect(page.locator('.combat-toggle-row', { hasText: 'Savage Attacker' })).toHaveCount(0);

  const roll = await attackAndStartDamage(page, ctx, /Greatsword/);
  const baseCount = roll.crit ? 4 : 2;

  const tray = page.locator(`.roll-reveal-backdrop[data-roll-id="${roll.trayId}"]`);
  await expect(tray).toBeVisible();
  const stageBefore = await tray.locator('.dice-tray-stage').boundingBox();
  expect(stageBefore).toBeTruthy();

  // Clicking the waiting offer bar while Wave 1 tumbles must NOT skip the roll animation.
  const waitingBar = tray.getByRole('region', { name: 'Savage Attacker reroll option' });
  if (await waitingBar.isVisible().catch(() => false)) {
    await waitingBar.click();
    await expect(tray).toBeVisible();
  }

  const rerollBtn = tray.getByRole('button', { name: /Reroll \(Savage Attacker\)/i });
  const keepBtn = tray.getByRole('button', { name: /^Keep \d+/i });
  await expect(rerollBtn).toBeVisible({ timeout: LIVE_COMBAT_TIMEOUT });
  await expect(rerollBtn).toBeEnabled({ timeout: LIVE_COMBAT_TIMEOUT });
  await expect(keepBtn).toBeVisible();
  // Wait for initial dice boxes to fill before triggering Wave 2
  await expect(tray.locator('.tray-die-result')).toHaveCount(baseCount);

  const preRerollCount = roll.dmgFrames.length;
  await rerollBtn.click();

  // Tray must stay alive and animate Wave 2 (`done === false` frames with 2 * baseCount dice) — never skipping!
  await expect(page.locator('[data-live-dice="true"]')).toBeVisible();
  await expect
    .poll(() => roll.dmgFrames.slice(preRerollCount).some((f) => !f.done && f.sides.length === baseCount * 2), { timeout: LIVE_COMBAT_TIMEOUT, intervals: [30, 50] })
    .toBe(true);

  await expect.poll(() => roll.dmgFrames.some((f) => f.done && f.sides.length === baseCount * 2), { timeout: LIVE_COMBAT_TIMEOUT, intervals: [50, 80] }).toBe(true);
  await expect(tray.locator('.tray-savage-banner[data-tray-banner="savage-reroll"]')).toContainText('Savage Attacker');
  await expect(tray.locator('.tray-die-result')).toHaveCount(baseCount * 2);
  await expect(tray.locator('.tray-die-result[data-result="kept"]')).toHaveCount(baseCount);
  await expect(tray.locator('.tray-die-result[data-result="discarded"]')).toHaveCount(baseCount);
  const stageAfter = await tray.locator('.dice-tray-stage').boundingBox();
  expect(stageAfter).toBeTruthy();
  expect(Math.abs(stageAfter!.width - stageBefore!.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(stageAfter!.height - stageBefore!.height)).toBeLessThanOrEqual(1);

  // Curved SVG reroll links from original dice -> rerolled dice inside the same tray.
  await expect(tray.locator('svg.tray-trigger-links [data-reroll-parent]')).toHaveCount(baseCount);
  for (let i = 0; i < baseCount; i++) {
    const core = tray.locator(`svg.tray-trigger-links path.tray-trigger-core[data-from="${i}"][data-to="${i + baseCount}"]`);
    await expect(core).toHaveAttribute('d', /^M\s+[-\d.]+\s+[-\d.]+\s+Q\s+[-\d.]+\s+[-\d.]+\s+[-\d.]+\s+[-\d.]+$/);
  }

  await expect.poll(async () => (await ctx.snapshot()).rollLog.find((r) => r.id === roll.attackId)?.pending?.done, { timeout: LIVE_COMBAT_TIMEOUT }).toBe(true);
  const dmgEntry = (await ctx.snapshot()).rollLog.findLast((r) => r.label === 'Damage')!;
  const after = await ctx.snapshot();
  expect(after.monsters.find((m) => m.id === ctx.targetRefId)!.curHp).toBe(roll.hpBefore - dmgEntry.total);
  expect(new Set(roll.dmgFrames.map((f) => f.id)).size).toBe(1);
});

test('Clicking Keep on Savage Attacker tray button resolves with Wave 1 dice only', async ({ page, request }) => {
  const ctx = await createArena(request, page, {
    weapons: [{ name: 'Greatsword', kind: 'melee', damage: '2d6', damageType: 'slashing', attackBonus: 100 }],
    abilities: [SAVAGE_ATTACKER],
  });
  const roll = await attackAndStartDamage(page, ctx, /Greatsword/);
  const baseCount = roll.crit ? 4 : 2;
  const tray = page.locator(`.roll-reveal-backdrop[data-roll-id="${roll.trayId}"]`);
  const keepBtn = tray.getByRole('button', { name: /^Keep \d+/i });
  await expect(keepBtn).toBeVisible({ timeout: LIVE_COMBAT_TIMEOUT });
  await expect(keepBtn).toBeEnabled({ timeout: LIVE_COMBAT_TIMEOUT });
  await keepBtn.click();

  await expect.poll(async () => (await ctx.snapshot()).rollLog.find((r) => r.id === roll.attackId)?.pending?.done, { timeout: LIVE_COMBAT_TIMEOUT }).toBe(true);
  expect(roll.dmgFrames.at(-1)?.sides).toHaveLength(baseCount);
  const dmgEntry = (await ctx.snapshot()).rollLog.findLast((r) => r.label === 'Damage')!;
  expect(dmgEntry.detail).not.toContain('[SAVAGE');
});

test('Savage Attacks extra crit die renders in the same crit tray with floating label and breakdown credit', async ({ page, request }) => {
  const ctx = await createArena(request, page, {
    weapons: [{ name: 'Greataxe', kind: 'melee', damage: '1d12', damageType: 'slashing', attackBonus: 100 }],
    abilities: [SAVAGE_ATTACKS],
    paralyzeTarget: true,
  });
  const roll = await attackAndStartDamage(page, ctx, /Greataxe/);

  const tray = page.locator(`.roll-reveal-backdrop[data-roll-id="${roll.trayId}"]`);
  await expect(tray.locator('.tray-savage-banner[data-tray-banner="savage-crit"]')).toContainText('Savage Attacks');

  await expect.poll(() => roll.dmgFrames.some((f) => f.done && f.sides.length === 3), { timeout: LIVE_COMBAT_TIMEOUT, intervals: [50, 80] }).toBe(true);
  await expect(tray.locator('.tray-die-result')).toHaveCount(3);
  const savageBox = tray.locator('.tray-die-result[data-role="savage-crit"]');
  await expect(savageBox).toHaveCount(1);
  await expect(savageBox.locator('.tray-die-badge')).toHaveText('Savage Attacks');

  // Floating role pill pinned over the 3D Savage Attacks die inside the tray.
  const floatingLabel = tray.locator('.tray-die-role-label.is-savage-crit');
  await expect(floatingLabel).toBeVisible();
  await expect(floatingLabel).toHaveText('Savage Attacks');

  await expect.poll(async () => (await ctx.snapshot()).rollLog.find((r) => r.id === roll.attackId)?.pending?.done, { timeout: LIVE_COMBAT_TIMEOUT }).toBe(true);
  await expect(page.locator('.roll-damage-breakdown').last()).toContainText('1d12 Savage Attacks');
  expect(new Set(roll.dmgFrames.map((f) => f.id)).size).toBe(1);
});

test('Composes Savage Attacker tray button and Savage Attacks extra crit die in one 6-die crit pool (3d12 vs 3d12)', async ({ page, request }) => {
  const ctx = await createArena(request, page, {
    weapons: [{ name: 'Greataxe', kind: 'melee', damage: '1d12', damageType: 'slashing', attackBonus: 100 }],
    abilities: [SAVAGE_ATTACKER, SAVAGE_ATTACKS],
    paralyzeTarget: true,
  });
  const roll = await attackAndStartDamage(page, ctx, /Greataxe/);

  const tray = page.locator(`.roll-reveal-backdrop[data-roll-id="${roll.trayId}"]`);
  await expect(tray).toBeVisible();

  const rerollBtn = tray.getByRole('button', { name: /Reroll \(Savage Attacker\)/i });
  await expect(rerollBtn).toBeVisible({ timeout: LIVE_COMBAT_TIMEOUT });
  await expect(rerollBtn).toBeEnabled({ timeout: LIVE_COMBAT_TIMEOUT });
  await expect(tray.locator('.tray-die-result')).toHaveCount(3);
  await rerollBtn.click();

  await expect.poll(() => roll.dmgFrames.some((f) => f.done && f.sides.length === 6), { timeout: LIVE_COMBAT_TIMEOUT, intervals: [50, 80] }).toBe(true);
  await expect(tray.locator('.tray-savage-banner[data-tray-banner="savage-both"]')).toContainText('Savage Attacker & Savage Attacks');
  await expect(tray.locator('.tray-die-result')).toHaveCount(6);
  await expect(tray.locator('.tray-die-result[data-result="kept"]')).toHaveCount(2);
  await expect(tray.locator('.tray-die-result[data-result="discarded"]')).toHaveCount(3);
  await expect(tray.locator('.tray-die-result[data-role="savage-crit"]')).toHaveCount(2);
  await expect(tray.locator('svg.tray-trigger-links [data-reroll-parent]')).toHaveCount(3);
  await expect(tray.locator('.tray-die-role-label.is-savage-crit')).toHaveCount(1);
  await expect(tray.locator('.tray-die-role-label.is-savage-crit')).toBeVisible();

  await expect.poll(async () => (await ctx.snapshot()).rollLog.find((r) => r.id === roll.attackId)?.pending?.done, { timeout: LIVE_COMBAT_TIMEOUT }).toBe(true);
  const after = await ctx.snapshot();
  const dmgEntry = after.rollLog.findLast((r) => r.label === 'Damage')!;
  expect(after.monsters.find((m) => m.id === ctx.targetRefId)!.curHp).toBe(roll.hpBefore - dmgEntry.total);
  expect(new Set(roll.dmgFrames.map((f) => f.id)).size).toBe(1);
});
