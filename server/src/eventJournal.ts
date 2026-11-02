import { db, newId } from './db.js';
import {
  getCharacter,
  getMonster,
  getSessionById,
  getToken,
  moveToken,
  setCombatRound,
  setTempHp,
} from './sessions.js';
import type { TokenKind } from '../../shared/types.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS event_journal (
    id           TEXT PRIMARY KEY,
    session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq          INTEGER NOT NULL,
    round        INTEGER NOT NULL DEFAULT 0,
    domain       TEXT NOT NULL,
    action       TEXT NOT NULL,
    actor_role   TEXT NOT NULL,
    label        TEXT NOT NULL,
    forward_json TEXT NOT NULL,
    inverse_json TEXT NOT NULL,
    undone       INTEGER NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_event_journal_session_seq
    ON event_journal(session_id, seq);
  CREATE INDEX IF NOT EXISTS idx_event_journal_session_round
    ON event_journal(session_id, round, seq);
`);

export type JournalPayload =
  | {
      kind: 'token:move';
      tokenId: string;
      mapId: string;
      x: number;
      y: number;
    }
  | {
      kind: 'entity:hp';
      entityKind: TokenKind;
      refId: string;
      curHp: number;
      tempHp: number;
    }
  | {
      kind: 'combat:round';
      round: number;
    };

export type EventJournalEntry = {
  id: string;
  sessionId: string;
  seq: number;
  round: number;
  domain: string;
  action: string;
  actorRole: 'dm' | 'player';
  label: string;
  forward: JournalPayload;
  inverse: JournalPayload;
  undone: boolean;
  createdAt: number;
};

type JournalRow = {
  id: string;
  session_id: string;
  seq: number;
  round: number;
  domain: string;
  action: string;
  actor_role: 'dm' | 'player';
  label: string;
  forward_json: string;
  inverse_json: string;
  undone: number;
  created_at: number;
};

function rowToEntry(row: JournalRow): EventJournalEntry {
  return {
    id: row.id,
    sessionId: row.session_id,
    seq: row.seq,
    round: row.round,
    domain: row.domain,
    action: row.action,
    actorRole: row.actor_role,
    label: row.label,
    forward: JSON.parse(row.forward_json) as JournalPayload,
    inverse: JSON.parse(row.inverse_json) as JournalPayload,
    undone: row.undone === 1,
    createdAt: row.created_at,
  };
}

function applyJournalPayload(sessionId: string, payload: JournalPayload): boolean {
  switch (payload.kind) {
    case 'token:move': {
      const tok = getToken(payload.tokenId);
      if (!tok) return false;
      moveToken(payload.tokenId, payload.x, payload.y, false);
      return true;
    }
    case 'entity:hp': {
      const entity =
        payload.entityKind === 'pc'
          ? getCharacter(payload.refId)
          : getMonster(payload.refId);
      if (!entity) return false;
      const table = payload.entityKind === 'pc' ? 'characters' : 'monsters';
      db.prepare(`UPDATE ${table} SET cur_hp = ? WHERE id = ?`).run(
        payload.curHp,
        payload.refId,
      );
      setTempHp(payload.entityKind, payload.refId, payload.tempHp);
      return true;
    }
    case 'combat:round': {
      setCombatRound(sessionId, payload.round);
      return true;
    }
  }
}

/**
 * Append a reversible action/combat/movement event to the persistent SQLite journal.
 * Appending a new forward action clears any previously undone redo branch for that session.
 */
export function appendJournalEvent(params: {
  sessionId: string;
  domain: string;
  action: string;
  actorRole: 'dm' | 'player';
  label: string;
  forward: JournalPayload;
  inverse: JournalPayload;
  round?: number;
  createdAt?: number;
}): EventJournalEntry {
  return db.transaction(() => {
    // Prune redo branch when a new action is committed
    db.prepare('DELETE FROM event_journal WHERE session_id = ? AND undone = 1').run(
      params.sessionId,
    );

    const maxSeqRow = db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM event_journal WHERE session_id = ?')
      .get(params.sessionId) as { max_seq: number };
    const seq = (maxSeqRow?.max_seq ?? 0) + 1;
    const round =
      params.round !== undefined
        ? params.round
        : (getSessionById(params.sessionId)?.combatRound ?? 0);
    const id = newId();
    const createdAt = params.createdAt ?? Date.now();

    db.prepare(
      `INSERT INTO event_journal (
        id, session_id, seq, round, domain, action, actor_role, label, forward_json, inverse_json, undone, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    ).run(
      id,
      params.sessionId,
      seq,
      round,
      params.domain,
      params.action,
      params.actorRole,
      params.label,
      JSON.stringify(params.forward),
      JSON.stringify(params.inverse),
      createdAt,
    );

    return {
      id,
      sessionId: params.sessionId,
      seq,
      round,
      domain: params.domain,
      action: params.action,
      actorRole: params.actorRole,
      label: params.label,
      forward: params.forward,
      inverse: params.inverse,
      undone: false,
      createdAt,
    };
  })();
}

/**
 * Undo the latest non-undone event in the session's SQLite journal (multi-step DM undo).
 */
export function undoJournalEvent(sessionId: string): EventJournalEntry | null {
  return db.transaction(() => {
    const row = db
      .prepare(
        'SELECT * FROM event_journal WHERE session_id = ? AND undone = 0 ORDER BY seq DESC LIMIT 1',
      )
      .get(sessionId) as JournalRow | undefined;
    if (!row) return null;

    const entry = rowToEntry(row);
    if (!applyJournalPayload(sessionId, entry.inverse)) return null;

    db.prepare('UPDATE event_journal SET undone = 1 WHERE id = ?').run(entry.id);
    return { ...entry, undone: true };
  })();
}

/**
 * Redo the earliest undone event in the session's SQLite journal (multi-step DM redo).
 */
export function redoJournalEvent(sessionId: string): EventJournalEntry | null {
  return db.transaction(() => {
    const row = db
      .prepare(
        'SELECT * FROM event_journal WHERE session_id = ? AND undone = 1 ORDER BY seq ASC LIMIT 1',
      )
      .get(sessionId) as JournalRow | undefined;
    if (!row) return null;

    const entry = rowToEntry(row);
    if (!applyJournalPayload(sessionId, entry.forward)) return null;

    db.prepare('UPDATE event_journal SET undone = 0 WHERE id = ?').run(entry.id);
    return { ...entry, undone: false };
  })();
}

/**
 * Retrieve the ordered event timeline for a specific combat round (or all active rounds)
 * to drive combat round replay and round-by-round inspection.
 */
export function replayCombatRound(
  sessionId: string,
  round?: number,
): EventJournalEntry[] {
  const rows = (
    round !== undefined
      ? db
          .prepare(
            'SELECT * FROM event_journal WHERE session_id = ? AND round = ? AND undone = 0 ORDER BY seq ASC',
          )
          .all(sessionId, round)
      : db
          .prepare(
            'SELECT * FROM event_journal WHERE session_id = ? AND undone = 0 ORDER BY seq ASC',
          )
          .all(sessionId)
  ) as JournalRow[];
  return rows.map(rowToEntry);
}

export function listJournalEvents(sessionId: string): EventJournalEntry[] {
  const rows = db
    .prepare('SELECT * FROM event_journal WHERE session_id = ? ORDER BY seq ASC')
    .all(sessionId) as JournalRow[];
  return rows.map(rowToEntry);
}
