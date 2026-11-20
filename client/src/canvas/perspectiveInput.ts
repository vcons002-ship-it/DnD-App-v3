import type Konva from 'konva';
import { unprojectGround } from './miniatureProjection';

/** Adapt Konva's public pointer registration before its hit testing and drag math.
 * Canvas elements are projected; the Stage event surface stays viewport-sized.
 * Native events remain untouched, so screen-space menus retain normal coordinates.
 */
export function installPerspectiveInput(stage: Konva.Stage, width: number, height: number, tilt: number, rotation = 0, current?: () => {tilt:number;rotation:number}) {
  const original = stage.setPointersPositions;
  const content = stage.getContent();
  let cachedRect: { left: number; top: number; sx: number; sy: number } | null = null;
  const refreshRect = () => {
    const rect = content.getBoundingClientRect();
    cachedRect = {
      left: rect.left,
      top: rect.top,
      sx: rect.width / content.clientWidth || 1,
      sy: rect.height / content.clientHeight || 1,
    };
    return cachedRect;
  };
  const invalidateRect = () => { cachedRect = null; };
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(invalidateRect) : null;
  ro?.observe(content);
  window.addEventListener('resize', invalidateRect);
  window.addEventListener('scroll', invalidateRect, true);

  stage.setPointersPositions = function (event) {
    const evt = event as Event | undefined;
    const type = evt?.type;
    const rect = (type === 'mousedown' || type === 'pointerdown' || type === 'touchstart' || type === 'wheel' || !cachedRect)
      ? refreshRect()
      : cachedRect;
    const { left, top, sx, sy } = rect;
    const point = (p: { clientX: number; clientY: number; identifier?: number }) => {
      const projection=current?.() ?? {tilt,rotation};
      const v = unprojectGround((p.clientX - left) / sx, (p.clientY - top) / sy, width, height, projection.tilt, projection.rotation);
      return { clientX: left + v.x * sx, clientY: top + v.y * sy, identifier: p.identifier };
    };
    const adjusted = new Proxy(event, { get(target, key) {
      if (key === 'clientX' || key === 'clientY') return point(target)[key];
      if ((key === 'touches' || key === 'changedTouches') && target[key]) return Array.from(target[key] as TouchList, point);
      return Reflect.get(target, key, target);
    } });
    original.call(stage, adjusted);
  };
  return () => {
    stage.setPointersPositions = original;
    ro?.disconnect();
    window.removeEventListener('resize', invalidateRect);
    window.removeEventListener('scroll', invalidateRect, true);
  };
}
