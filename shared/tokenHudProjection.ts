import type { Character, Condition, Monster, MonsterPublic, StateSnapshot } from './types.js';
import { VIEWPORT_LAYER_Z_INDEX } from './visionStencilGeometry.js';

export type TokenHudPillDescriptor = {
  tokenId: string;
  name: string;
  screenX: number;
  screenY: number;
  transformCss: string;
  hpRatio: number | null;
  curHp?: number;
  maxHp?: number;
  tempHp: number;
  deathSaveSuccesses?: number;
  deathSaveFailures?: number;
  conditions: Condition[];
  carriedLantern: boolean;
  isActiveTurn: boolean;
};

/**
 * Project a map-space point `(mapX, mapY)` into screen-space coordinates and a
 * GPU-composited `translate3d(x, y, 0)` CSS transform.
 */
export function projectTokenHudTransform(params: {
  mapX: number;
  mapY: number;
  tokenRadiusPx: number;
  view: { x: number; y: number; scale: number };
  groundScaleY?: number;
}): { screenX: number; screenY: number; transformCss: string } {
  const sy = params.groundScaleY ?? 1;
  const screenX = params.view.x + params.mapX * params.view.scale;
  const screenY =
    params.view.y + (params.mapY + params.tokenRadiusPx + 6) * params.view.scale * sy;
  const rx = Math.round(screenX * 10) / 10;
  const ry = Math.round(screenY * 10) / 10;
  return {
    screenX: rx,
    screenY: ry,
    transformCss: `translate3d(${rx}px, ${ry}px, 0) translate(-50%, 0)`,
  };
}

/**
 * Build lightweight HTML HUD pill descriptors for visible tokens on the current map.
 * Accepts optional normalized `charactersById` / `monstersById` lookup records from
 * `useGameStore` to avoid `O(N)` Map allocations on every render.
 */
export function buildTokenHudPills(params: {
  snapshot: StateSnapshot;
  view: { x: number; y: number; scale: number };
  pxPerFoot: number;
  groundScaleY?: number;
  isVisibleAt?: (id: string, x: number, y: number) => boolean;
  charactersById?: Readonly<Record<string, Character>>;
  monstersById?: Readonly<Record<string, Monster | MonsterPublic>>;
  onlyWithOverlayContent?: boolean;
}): TokenHudPillDescriptor[] {
  const {
    snapshot,
    view,
    pxPerFoot,
    groundScaleY = 1,
    isVisibleAt,
    charactersById,
    monstersById,
    onlyWithOverlayContent = false,
  } = params;
  const charsById = charactersById
    ? null
    : new Map<string, Character>((snapshot.characters ?? []).map((c) => [c.id, c]));
  const monsById = monstersById
    ? null
    : new Map<string, Monster | MonsterPublic>((snapshot.monsters ?? []).map((m) => [m.id, m]));

  const pills: TokenHudPillDescriptor[] = [];

  for (const token of snapshot.tokens ?? []) {
    if (token.isHidden && snapshot.role !== 'dm') continue;
    if (token.partiallyRevealed) continue;
    if (onlyWithOverlayContent && token.kind !== 'pc') continue;

    const entity =
      token.kind === 'pc'
        ? charactersById
          ? charactersById[token.refId]
          : charsById!.get(token.refId)
        : monstersById
          ? monstersById[token.refId]
          : monsById!.get(token.refId);
    if (!entity) continue;
    if ('objectKind' in entity && entity.objectKind) continue;

    const curHp = 'curHp' in entity && typeof entity.curHp === 'number' ? entity.curHp : undefined;
    const isPcDown =
      token.kind === 'pc' &&
      curHp === 0 &&
      'deathSaves' in entity &&
      !!entity.deathSaves;
    if (onlyWithOverlayContent && !isPcDown) continue;
    if (isVisibleAt && !isVisibleAt(token.id, token.x, token.y)) continue;

    const radiusPx = (token.widthFt * pxPerFoot) / 2;
    const projected = projectTokenHudTransform({
      mapX: token.x,
      mapY: token.y,
      tokenRadiusPx: radiusPx,
      view,
      groundScaleY,
    });

    const maxHp =
      'maxHp' in entity && typeof entity.maxHp === 'number' && entity.maxHp > 0
        ? entity.maxHp
        : undefined;
    const hpRatio =
      curHp !== undefined && maxHp !== undefined
        ? Math.max(0, Math.min(1, curHp / maxHp))
        : null;

    pills.push({
      tokenId: token.id,
      name: entity.name,
      screenX: projected.screenX,
      screenY: projected.screenY,
      transformCss: projected.transformCss,
      hpRatio,
      curHp,
      maxHp,
      tempHp: ('tempHp' in entity ? entity.tempHp : 0) ?? 0,
      ...(isPcDown && 'deathSaves' in entity && entity.deathSaves
        ? {
            deathSaveSuccesses: entity.deathSaves.successes,
            deathSaveFailures: entity.deathSaves.failures,
          }
        : {}),
      conditions: entity.conditions ?? [],
      carriedLantern: !!token.carriedLantern,
      isActiveTurn: snapshot.activeTurnTokenId === token.id,
    });
  }

  return pills;
}

export { VIEWPORT_LAYER_Z_INDEX };
