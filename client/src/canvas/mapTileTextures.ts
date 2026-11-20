import { LinearFilter, LinearMipmapLinearFilter, NoColorSpace, Texture, type WebGLRenderer } from 'three';

type ReadyListener = (width: number, height: number) => void;

type CacheEntry = {
  texture: Texture;
  width: number;
  height: number;
  ready: boolean;
  disposed: boolean;
  users: number;
  listeners: Set<ReadyListener>;
};

export type AcquiredMapTileTexture = {
  texture: Texture;
  readonly ready: boolean;
  release: () => void;
};

const cacheByRenderer = new WeakMap<WebGLRenderer, Map<string, CacheEntry>>();

/** Clamp decoded map tile dimensions to the active GPU budget / MAX_TEXTURE_SIZE. */
export function clampMapTextureDimensions(width: number, height: number, maxDim: number): { width: number; height: number; scaled: boolean } {
  const nw = Math.max(1, Math.round(width));
  const nh = Math.max(1, Math.round(height));
  const limit = Math.max(256, Math.floor(maxDim));
  const peak = Math.max(nw, nh);
  if (peak <= limit) return { width: nw, height: nh, scaled: false };
  const scale = limit / peak;
  return {
    width: Math.max(1, Math.round(nw * scale)),
    height: Math.max(1, Math.round(nh * scale)),
    scaled: true,
  };
}

/** Share one decoded raw-sRGB GPU Texture per renderer/budget/URL, clamped safely
 * for older GPUs and phones so darkvisionTerrain and gpuMapFloor never double-upload. */
export function acquireMapTileTexture(
  renderer: WebGLRenderer,
  url: string,
  requestedMaxDim: number,
  onReady?: ReadyListener,
): AcquiredMapTileTexture {
  const gpuMax = renderer.capabilities?.maxTextureSize || 4096;
  const maxDim = Math.max(256, Math.min(gpuMax, Math.floor(requestedMaxDim || 8192)));
  let cache = cacheByRenderer.get(renderer);
  if (!cache) {
    cache = new Map();
    cacheByRenderer.set(renderer, cache);
  }
  const cacheKey = `${maxDim}:${url}`;
  let entry = cache.get(cacheKey);

  if (!entry) {
    const texture = new Texture();
    texture.colorSpace = NoColorSpace;
    texture.minFilter = LinearMipmapLinearFilter;
    texture.magFilter = LinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = Math.min(8, renderer.capabilities?.getMaxAnisotropy?.() ?? 1);

    const created: CacheEntry = {
      texture,
      width: 1,
      height: 1,
      ready: false,
      disposed: false,
      users: 0,
      listeners: new Set(),
    };
    entry = created;
    cache.set(cacheKey, created);

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (created.disposed) return;
      const nw = img.naturalWidth || img.width || 1;
      const nh = img.naturalHeight || img.height || 1;
      const clamped = clampMapTextureDimensions(nw, nh, maxDim);
      if (clamped.scaled && typeof document !== 'undefined') {
        const canvas = document.createElement('canvas');
        canvas.width = clamped.width;
        canvas.height = clamped.height;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(img, 0, 0, clamped.width, clamped.height);
          texture.image = canvas;
        } else {
          texture.image = img;
        }
      } else {
        texture.image = img;
      }
      created.width = nw;
      created.height = nh;
      created.ready = true;
      texture.needsUpdate = true;
      for (const listener of created.listeners) listener(nw, nh);
      created.listeners.clear();
    };
    img.onerror = () => {
      if (cache?.get(cacheKey) === created) cache.delete(cacheKey);
      created.listeners.clear();
    };
    img.src = url;
  }

  entry.users++;
  if (onReady) {
    if (entry.ready) onReady(entry.width, entry.height);
    else entry.listeners.add(onReady);
  }

  const current = entry;
  let released = false;
  return {
    texture: current.texture,
    get ready() {
      return current.ready;
    },
    release() {
      if (released) return;
      released = true;
      if (onReady) current.listeners.delete(onReady);
      if (--current.users <= 0 && !current.disposed) {
        current.disposed = true;
        if (cache?.get(cacheKey) === current) cache.delete(cacheKey);
        current.listeners.clear();
        current.texture.dispose();
      }
    },
  };
}
