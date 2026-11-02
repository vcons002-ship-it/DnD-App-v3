import { describe, expect, it, beforeEach } from 'vitest';
import { evaluateAttackContext } from '../../shared/conditionEffects.js';
import { registerRuleModifier } from '../../shared/ruleModifiers.js';
import {
  combatRouter,
  libraryRouter,
  movementRouter,
  redoJournalEvent,
  replayCombatRound,
  undoJournalEvent,
} from './routers/index.js';
import {
  createMap,
  createSession,
  getCharacter,
  getToken,
  setCombatRound,
} from './sessions.js';

describe('Phase 4 — Declarative Combat Pipeline & SQLite Event Journal', () => {
  it('evaluates cover grades, illumination & darkvision/devils-sight senses, Pack Tactics, and custom RuleModifiers through evaluateAttackContext', () => {
    // 1. Half cover (+2 AC) & unseen target in darkness without darkvision -> disadvantage
    const darkNoVision = evaluateAttackContext({
      attackerConditions: [],
      targetConditions: [],
      within5ft: false,
      cover: 'half',
      illumination: {
        attackerLight: 'bright',
        targetLight: 'darkness',
        attackerSenses: ['normal'],
        targetSenses: ['darkvision'],
      },
    });
    expect(darkNoVision.acBonus).toBe(2);
    expect(darkNoVision.dexSaveBonus).toBe(2);
    expect(darkNoVision.adv.state).toBe('dis');
    expect(darkNoVision.adv.reasons).toContain('unseen target (darkness)');

    // 2. Attacker with darkvision sees target in non-magical darkness -> straight roll
    const darkWithDarkvision = evaluateAttackContext({
      attackerConditions: [],
      targetConditions: [],
      within5ft: false,
      cover: 'three-quarters',
      illumination: {
        attackerLight: 'bright',
        targetLight: 'darkness',
        attackerSenses: ['darkvision'],
        targetSenses: ['darkvision'],
      },
    });
    expect(darkWithDarkvision.acBonus).toBe(5);
    expect(darkWithDarkvision.adv.state).toBeUndefined();

    // 3. Magical darkness blocks normal darkvision but Devil's Sight sees through it (unseen attacker advantage!)
    const devilsSightInMagicalDarkness = evaluateAttackContext({
      attackerConditions: [],
      targetConditions: [],
      within5ft: true,
      illumination: {
        attackerLight: 'magical-darkness',
        targetLight: 'magical-darkness',
        attackerSenses: ['devilsSight'],
        targetSenses: ['darkvision'],
      },
    });
    expect(devilsSightInMagicalDarkness.adv.state).toBe('adv');
    expect(devilsSightInMagicalDarkness.adv.reasons).toContain('unseen attacker (darkness)');

    // 4. Total cover blocks direct targeting
    const totalCover = evaluateAttackContext({
      attackerConditions: [],
      targetConditions: [],
      within5ft: false,
      cover: 'total',
    });
    expect(totalCover.blockedReason).toBe('Target has total cover');

    // 5. Pack Tactics & custom RuleModifier registration
    const unregister = registerRuleModifier({
      id: 'custom-high-ground',
      category: 'stance',
      description: 'High ground grants +1 AC to defender in test',
      evaluate: () => ({
        id: 'custom-high-ground',
        label: 'High Ground',
        category: 'stance',
        acBonus: 1,
      }),
    });
    try {
      const packAndCustom = evaluateAttackContext({
        attackerConditions: [],
        targetConditions: [],
        attackerEntity: {
          abilities: [{ name: 'Pack Tactics', description: 'Advantage when ally is adjacent.' }],
        },
        within5ft: true,
        allyAdjacentToTarget: true,
      });
      expect(packAndCustom.adv.state).toBe('adv');
      expect(packAndCustom.adv.reasons).toContain('Pack Tactics');
      expect(packAndCustom.acBonus).toBe(1);
    } finally {
      unregister();
    }
  });

  describe('SQLite Event Journal — Multi-Step DM Undo/Redo & Combat Round Replay', () => {
    let sessionId: string;
    let mapId: string;

    beforeEach(() => {
      const session = createSession('V3 Journal Test');
      sessionId = session.id;
      const map = createMap(sessionId, {
        name: 'Arena',
        imagePath: '/uploads/arena.png',
      });
      mapId = map.id;
    });

    it('persists movement and combat events in SQLite, supports multi-step undo/redo, and replays combat rounds', async () => {
      setCombatRound(sessionId, 1);

      const { character } = libraryRouter.executeCreateCharacter({
        sessionId,
        payload: { name: 'Druk', maxHp: 44 },
        actorRole: 'dm',
      });
      const spawnEnv = libraryRouter.executeSpawnToken({
        sessionId,
        mapId,
        kind: 'pc',
        refId: character.id,
        x: 100,
        y: 100,
        actorRole: 'dm',
      });
      const tokenId = spawnEnv!.patch.tokenId;

      // Round 1: Move token (100,100) -> (200,150) and take 12 damage (44 -> 32 HP)
      await movementRouter.executeMoveToken({
        sessionId,
        tokenId,
        x: 200,
        y: 150,
        actorRole: 'dm',
        recordExploration: false,
      });
      combatRouter.executeApplyDamage({
        sessionId,
        kind: 'pc',
        refId: character.id,
        amount: 12,
        actorRole: 'dm',
      });

      // Round 2: Move token (200,150) -> (300,250) and take 8 damage (32 -> 24 HP)
      setCombatRound(sessionId, 2);
      await movementRouter.executeMoveToken({
        sessionId,
        tokenId,
        x: 300,
        y: 250,
        actorRole: 'dm',
        recordExploration: false,
      });
      combatRouter.executeApplyDamage({
        sessionId,
        kind: 'pc',
        refId: character.id,
        amount: 8,
        actorRole: 'dm',
      });

      expect(getToken(tokenId)?.x).toBe(300);
      expect(getCharacter(character.id)?.curHp).toBe(24);

      // Replay Round 1 vs Round 2
      const round1Log = replayCombatRound(sessionId, 1);
      const round2Log = replayCombatRound(sessionId, 2);
      expect(round1Log).toHaveLength(2);
      expect(round2Log).toHaveLength(2);
      expect(round1Log.map((e) => e.action)).toEqual(['token:move', 'entity:damage']);

      // Multi-step Undo: Step 1 undoes Round 2 damage (24 -> 32 HP)
      const undone1 = undoJournalEvent(sessionId);
      expect(undone1?.action).toBe('entity:damage');
      expect(getCharacter(character.id)?.curHp).toBe(32);

      // Multi-step Undo: Step 2 undoes Round 2 move ((300,250) -> (200,150))
      const undone2 = undoJournalEvent(sessionId);
      expect(undone2?.action).toBe('token:move');
      expect(getToken(tokenId)).toMatchObject({ x: 200, y: 150 });

      // Multi-step Undo: Step 3 undoes Round 1 damage (32 -> 44 HP)
      const undone3 = undoJournalEvent(sessionId);
      expect(undone3?.action).toBe('entity:damage');
      expect(getCharacter(character.id)?.curHp).toBe(44);

      // Multi-step Redo: Step 1 redoes Round 1 damage (44 -> 32 HP)
      const redone1 = redoJournalEvent(sessionId);
      expect(redone1?.action).toBe('entity:damage');
      expect(getCharacter(character.id)?.curHp).toBe(32);

      // Multi-step Redo: Step 2 redoes Round 2 move ((200,150) -> (300,250))
      const redone2 = redoJournalEvent(sessionId);
      expect(redone2?.action).toBe('token:move');
      expect(getToken(tokenId)).toMatchObject({ x: 300, y: 250 });
    });
  });
});
