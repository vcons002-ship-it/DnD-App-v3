import Konva from 'konva';

export type GpuGroundTokenSprite = {
  id: string;
  canvas: HTMLCanvasElement;
  x: number;
  y: number;
  bx: number;
  by: number;
  w: number;
  h: number;
  opacity: number;
  version: string;
};

type CachedSprite = {
  node: Konva.Group;
  version: string;
  canvas: HTMLCanvasElement;
  bx: number;
  by: number;
  w: number;
  h: number;
};

/** Rasterize 2D ground token bodies (e.g. chests, 2D objects) into cached
 *  canvases for the GPU floor without coupling to camera rotation or upright HUDs. */
export function createGroundTokenSpriteReader() {
  const cache = new Map<string, CachedSprite>();
  return (layer: Konva.Layer | null): GpuGroundTokenSprite[] => {
    if (!layer) {
      cache.clear();
      return [];
    }
    const present = new Set<string>();
    const result: GpuGroundTokenSprite[] = [];
    for (const node of layer.getChildren()) {
      if (!(node instanceof Konva.Group) || !node.hasName('token')) continue;
      if (!node.visible() || node.getAbsoluteOpacity() <= 0 || node.getAttr('miniatureReady')) continue;
      const id = node.getAttr('tokenId') as string | undefined;
      if (!id) continue;
      const version = String(node.getAttr('tokenBodyVersion') ?? '');
      let entry = cache.get(id);
      if (!entry || entry.node !== node || entry.version !== version || version === '') {
        const art = node.findOne<Konva.Group>('.token-art');
        if (!art) {
          cache.delete(id);
          continue;
        }
        const clone = art.clone({ x: 0, y: 0, listening: false }) as Konva.Group;
        clone.findOne('.token-upright-hud')?.destroy();
        const b = clone.getClientRect({ skipTransform: true });
        if (!(b.width > 0 && b.height > 0)) {
          clone.destroy();
          cache.delete(id);
          continue;
        }
        const bx = Math.floor(b.x) - 2;
        const by = Math.floor(b.y) - 2;
        const w = Math.ceil(b.width) + 4;
        const h = Math.ceil(b.height) + 4;
        const pixelRatio = Math.min(2, Math.max(0.5, 512 / Math.max(1, w, h)));
        const canvas = clone.toCanvas({ x: bx, y: by, width: w, height: h, pixelRatio });
        clone.destroy();
        entry = { node, version, canvas, bx, by, w, h };
        cache.set(id, entry);
      }
      present.add(id);
      result.push({
        id,
        canvas: entry.canvas,
        x: node.x(),
        y: node.y(),
        bx: entry.bx,
        by: entry.by,
        w: entry.w,
        h: entry.h,
        opacity: node.getAbsoluteOpacity(),
        version: entry.version,
      });
    }
    for (const id of cache.keys()) {
      if (!present.has(id)) cache.delete(id);
    }
    return result;
  };
}
