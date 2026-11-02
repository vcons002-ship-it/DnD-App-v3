export type WebglContextLifecycleStatus = 'healthy' | 'lost' | 'restored';

export type WebglContextStateSnapshot = {
  status: WebglContextLifecycleStatus;
  lossCount: number;
  restoreCount: number;
  lastLostAt: number | null;
  lastRestoredAt: number | null;
  recommendedTierOverride: 'low' | null;
};

export type WebglRecoveryCallbacks = {
  onContextLost?: (snapshot: WebglContextStateSnapshot) => void;
  onContextRestored?: (snapshot: WebglContextStateSnapshot) => void;
};

/**
 * Deterministic state machine for WebGL context loss and automatic restoration.
 * If a laptop experiences repeated context losses (>= 2 within 2 minutes),
 * it automatically recommends Tier 1 (`'low'`) to cap VRAM and texture sizes.
 */
export function createWebglRecoveryTracker(callbacks: WebglRecoveryCallbacks = {}) {
  let status: WebglContextLifecycleStatus = 'healthy';
  let lossCount = 0;
  let restoreCount = 0;
  let lastLostAt: number | null = null;
  let lastRestoredAt: number | null = null;
  const recentLossTimestamps: number[] = [];

  const getSnapshot = (): WebglContextStateSnapshot => ({
    status,
    lossCount,
    restoreCount,
    lastLostAt,
    lastRestoredAt,
    recommendedTierOverride: recentLossTimestamps.length >= 2 ? 'low' : null,
  });

  return {
    handleContextLost(now = Date.now(), preventDefault?: () => void): WebglContextStateSnapshot {
      // Calling preventDefault() on a WebGLContextEvent instructs the browser
      // to restore the WebGL context as soon as the GPU wakes up.
      preventDefault?.();
      status = 'lost';
      lossCount++;
      lastLostAt = now;
      recentLossTimestamps.push(now);
      while (recentLossTimestamps.length && now - recentLossTimestamps[0] > 120_000) {
        recentLossTimestamps.shift();
      }
      const snap = getSnapshot();
      callbacks.onContextLost?.(snap);
      return snap;
    },

    handleContextRestored(now = Date.now()): WebglContextStateSnapshot {
      status = 'restored';
      restoreCount++;
      lastRestoredAt = now;
      const snap = getSnapshot();
      callbacks.onContextRestored?.(snap);
      return snap;
    },

    getSnapshot,
  };
}
