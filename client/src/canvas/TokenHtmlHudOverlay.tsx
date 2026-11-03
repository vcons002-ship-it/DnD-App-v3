import { memo, useMemo } from 'react';
import type { StateSnapshot } from '../../../shared/types';
import {
  buildTokenHudPills,
  VIEWPORT_LAYER_Z_INDEX,
} from '../../../shared/tokenHudProjection';
import { useGameStore } from '../store/useGameStore';

type Props = {
  snapshot: StateSnapshot;
  view: { x: number; y: number; scale: number };
  pxPerFoot: number;
  groundScaleY?: number;
  isVisibleAt?: (id: string, x: number, y: number) => boolean;
};

/**
 * Lightweight GPU-transformed (`translate3d`) HTML overlay layer for token HUD
 * pills (death-save pips). Uses normalized `charactersById` / `monstersById` from
 * `useGameStore` and emits DOM elements only when a token has active overlay content.
 */
export const TokenHtmlHudOverlay = memo(function TokenHtmlHudOverlay({
  snapshot,
  view,
  pxPerFoot,
  groundScaleY = 1,
  isVisibleAt,
}: Props) {
  const charactersById = useGameStore((s) => s.charactersById);
  const monstersById = useGameStore((s) => s.monstersById);

  const pills = useMemo(
    () =>
      buildTokenHudPills({
        snapshot,
        view,
        pxPerFoot,
        groundScaleY,
        isVisibleAt,
        charactersById: Object.keys(charactersById).length ? charactersById : undefined,
        monstersById: Object.keys(monstersById).length ? monstersById : undefined,
        onlyWithOverlayContent: true,
      }),
    [snapshot, view, pxPerFoot, groundScaleY, isVisibleAt, charactersById, monstersById],
  );

  if (!pills.length) return null;

  return (
    <div
      className="v3-token-html-hud-layer"
      data-testid="v3-token-html-hud-layer"
      aria-hidden="true"
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        overflow: 'hidden',
        zIndex: VIEWPORT_LAYER_Z_INDEX.tokenHtmlHudOverlay,
      }}
    >
      {pills.map((pill) => (
        <div
          key={pill.tokenId}
          data-token-hud-id={pill.tokenId}
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            transform: pill.transformCss,
            willChange: 'transform',
            pointerEvents: 'none',
          }}
        >
          {pill.deathSaveSuccesses !== undefined && (
            <div
              className="v3-token-death-saves"
              style={{
                display: 'flex',
                gap: 2,
                justifyContent: 'center',
                fontSize: 9,
                lineHeight: 1,
              }}
            >
              <span style={{ color: '#2ecc71' }}>
                {'●'.repeat(pill.deathSaveSuccesses)}
                {'○'.repeat(Math.max(0, 3 - pill.deathSaveSuccesses))}
              </span>
              <span style={{ color: '#e74c3c' }}>
                {'●'.repeat(pill.deathSaveFailures ?? 0)}
                {'○'.repeat(Math.max(0, 3 - (pill.deathSaveFailures ?? 0)))}
              </span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
});
