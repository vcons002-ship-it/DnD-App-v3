import { memo, useMemo } from 'react';
import type { StateSnapshot } from '../../../shared/types';
import {
  buildTokenHudPills,
  VIEWPORT_LAYER_Z_INDEX,
} from '../../../shared/tokenHudProjection';

type Props = {
  snapshot: StateSnapshot;
  view: { x: number; y: number; scale: number };
  pxPerFoot: number;
  groundScaleY?: number;
  isVisibleAt?: (id: string, x: number, y: number) => boolean;
};

/**
 * Lightweight GPU-transformed (`translate3d`) HTML overlay layer for token HUD
 * pills (HP bars, death-save pips, condition badges, carried lantern indicator).
 * Uses `pointer-events: none` so all pointer interactions pass straight through
 * to the unified tabletop scene.
 */
export const TokenHtmlHudOverlay = memo(function TokenHtmlHudOverlay({
  snapshot,
  view,
  pxPerFoot,
  groundScaleY = 1,
  isVisibleAt,
}: Props) {
  const pills = useMemo(
    () =>
      buildTokenHudPills({
        snapshot,
        view,
        pxPerFoot,
        groundScaleY,
        isVisibleAt,
      }),
    [snapshot, view, pxPerFoot, groundScaleY, isVisibleAt],
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
