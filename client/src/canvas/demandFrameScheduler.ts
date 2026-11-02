export type FrameInvalidationReason =
  | 'camera'
  | 'tokenMove'
  | 'vision'
  | 'dice'
  | 'environment'
  | 'hud'
  | 'contextRestored';

export type DemandFrameTask = (timestamp: number, reasons: ReadonlySet<FrameInvalidationReason>) => boolean | void;

export type DemandFrameScheduler = {
  /** Mark the viewport dirty so one frame is scheduled on next RAF (`frameloop="demand"`). */
  invalidate: (reason?: FrameInvalidationReason, holdMs?: number) => void;
  /** Subscribe a render callback. Returning `true` keeps the loop awake for one more frame. */
  subscribe: (task: DemandFrameTask) => () => void;
  /** True when the tabletop is completely idle (`0 FPS` / `0% GPU`). */
  isIdle: () => boolean;
  /** Total frames rendered since creation (for diagnostics/tests). */
  getFrameCount: () => number;
  /** Cancel any pending RAF immediately. */
  dispose: () => void;
};

type BrowserAnimApi = {
  requestAnimationFrame?: (cb: (time: number) => void) => number;
  cancelAnimationFrame?: (id: number) => void;
};

const browserAnim = globalThis as unknown as BrowserAnimApi;

/**
 * On-demand frame scheduler (`frameloop="demand"`).
 * Drops to `0 FPS` / `0% GPU` when the tabletop is idle and wakes immediately
 * on token movement, camera pan/zoom, dice rolls, or lighting/vision updates.
 */
export function createDemandFrameScheduler(
  requestRaf: (cb: (time: number) => void) => number = (cb) =>
    typeof browserAnim.requestAnimationFrame === 'function'
      ? browserAnim.requestAnimationFrame(cb)
      : 0,
  cancelRaf: (id: number) => void = (id) => {
    if (typeof browserAnim.cancelAnimationFrame === 'function') {
      browserAnim.cancelAnimationFrame(id);
    }
  },
  now: () => number = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
): DemandFrameScheduler {
  const tasks = new Set<DemandFrameTask>();
  const pendingReasons = new Set<FrameInvalidationReason>();
  let rafId = 0;
  let holdUntil = 0;
  let frameCount = 0;

  const scheduleIfNeeded = () => {
    if (rafId !== 0 || tasks.size === 0) return;
    if (pendingReasons.size === 0 && now() >= holdUntil) return;
    rafId = requestRaf(tick);
  };

  const tick = (timestamp: number) => {
    rafId = 0;
    frameCount++;
    const reasonsSnapshot = new Set(pendingReasons);
    pendingReasons.clear();

    let keepAlive = timestamp < holdUntil;
    for (const task of tasks) {
      if (task(timestamp, reasonsSnapshot) === true) {
        keepAlive = true;
      }
    }

    if (keepAlive || pendingReasons.size > 0) {
      if (keepAlive && pendingReasons.size === 0) {
        pendingReasons.add('environment');
      }
      scheduleIfNeeded();
    }
  };

  return {
    invalidate(reason = 'camera', holdMs = 0) {
      pendingReasons.add(reason);
      if (holdMs > 0) {
        holdUntil = Math.max(holdUntil, now() + holdMs);
      }
      scheduleIfNeeded();
    },
    subscribe(task) {
      tasks.add(task);
      scheduleIfNeeded();
      return () => {
        tasks.delete(task);
        if (tasks.size === 0 && rafId !== 0) {
          cancelRaf(rafId);
          rafId = 0;
        }
      };
    },
    isIdle() {
      return rafId === 0 && pendingReasons.size === 0 && now() >= holdUntil;
    },
    getFrameCount() {
      return frameCount;
    },
    dispose() {
      if (rafId !== 0) {
        cancelRaf(rafId);
        rafId = 0;
      }
      pendingReasons.clear();
      holdUntil = 0;
      tasks.clear();
    },
  };
}

export const globalViewportScheduler = createDemandFrameScheduler();
