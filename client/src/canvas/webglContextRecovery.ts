import {
  createWebglRecoveryTracker,
  type WebglContextStateSnapshot,
  type WebglRecoveryCallbacks,
} from '../../../shared/webglRecoveryState';
import { globalViewportScheduler } from './demandFrameScheduler';

/**
 * Attach automatic `webglcontextlost` and `webglcontextrestored` listeners to a
 * WebGL `<canvas>` so laptop sleep/wake cycles never blank the tabletop.
 */
export function attachWebglContextRecovery(
  canvas: HTMLCanvasElement | null | undefined,
  callbacks: WebglRecoveryCallbacks = {},
): {
  dispose: () => void;
  getSnapshot: () => WebglContextStateSnapshot;
} {
  const tracker = createWebglRecoveryTracker({
    onContextLost(snapshot) {
      callbacks.onContextLost?.(snapshot);
    },
    onContextRestored(snapshot) {
      callbacks.onContextRestored?.(snapshot);
      globalViewportScheduler.invalidate('contextRestored', 100);
    },
  });

  if (!canvas || typeof canvas.addEventListener !== 'function') {
    return {
      dispose: () => {},
      getSnapshot: tracker.getSnapshot,
    };
  }

  const onLost = (event: Event) => {
    tracker.handleContextLost(Date.now(), () => event.preventDefault());
  };

  const onRestored = () => {
    tracker.handleContextRestored(Date.now());
  };

  canvas.addEventListener('webglcontextlost', onLost, false);
  canvas.addEventListener('webglcontextrestored', onRestored, false);

  return {
    dispose() {
      canvas.removeEventListener('webglcontextlost', onLost, false);
      canvas.removeEventListener('webglcontextrestored', onRestored, false);
    },
    getSnapshot: tracker.getSnapshot,
  };
}
