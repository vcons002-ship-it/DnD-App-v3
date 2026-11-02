import type { SnapshotDelta } from '../../../shared/stateDelta.js';

export type RouterDomain = 'movement' | 'combat' | 'mapAuthoring' | 'library';

export type VersionedActionPatch<TPatch = Record<string, unknown>> = {
  seq: number;
  sessionId: string;
  domain: RouterDomain;
  action: string;
  actorRole: 'dm' | 'player';
  actorSocketId?: string;
  patch: TPatch;
  delta?: SnapshotDelta;
  timestamp: number;
};

const sessionSequences = new Map<string, number>();
const sessionActionLog = new Map<string, VersionedActionPatch[]>();
const MAX_IN_MEMORY_ACTIONS = 250;

export function nextSessionSeq(sessionId: string): number {
  const next = (sessionSequences.get(sessionId) ?? 0) + 1;
  sessionSequences.set(sessionId, next);
  return next;
}

export function getSessionSeq(sessionId: string): number {
  return sessionSequences.get(sessionId) ?? 0;
}

export function recordDomainAction<TPatch = Record<string, unknown>>(params: {
  sessionId: string;
  domain: RouterDomain;
  action: string;
  actorRole: 'dm' | 'player';
  actorSocketId?: string;
  patch: TPatch;
  delta?: SnapshotDelta;
  timestamp?: number;
}): VersionedActionPatch<TPatch> {
  const seq = nextSessionSeq(params.sessionId);
  const envelope: VersionedActionPatch<TPatch> = {
    seq,
    sessionId: params.sessionId,
    domain: params.domain,
    action: params.action,
    actorRole: params.actorRole,
    actorSocketId: params.actorSocketId,
    patch: params.patch,
    ...(params.delta ? { delta: params.delta } : {}),
    timestamp: params.timestamp ?? Date.now(),
  };

  let log = sessionActionLog.get(params.sessionId);
  if (!log) {
    log = [];
    sessionActionLog.set(params.sessionId, log);
  }
  log.push(envelope as VersionedActionPatch);
  if (log.length > MAX_IN_MEMORY_ACTIONS) {
    log.splice(0, log.length - MAX_IN_MEMORY_ACTIONS);
  }
  return envelope;
}

export function listDomainActions(
  sessionId: string,
  domain?: RouterDomain,
): VersionedActionPatch[] {
  const log = sessionActionLog.get(sessionId) ?? [];
  return domain ? log.filter((entry) => entry.domain === domain) : [...log];
}

export function clearDomainActions(sessionId: string): void {
  sessionSequences.delete(sessionId);
  sessionActionLog.delete(sessionId);
}
