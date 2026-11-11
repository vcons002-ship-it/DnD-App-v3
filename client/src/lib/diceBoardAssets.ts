// Pure 2D dice board & table surface cache (zero Three.js / WebGL imports).
// Safely runs during session/map preload in every mode — including Legacy Mode,
// where creating a WebGL context on initial load is prohibited.

const TRAY_ART_KEYS = ['dm', 'fighter', 'ranger', 'sorcerer'] as const;
export type TrayArtKey = (typeof TRAY_ART_KEYS)[number];

export function normalizeTrayArtKey(themeId: string): TrayArtKey | undefined {
  if (themeId.startsWith('dm-')) return 'dm';
  if ((TRAY_ART_KEYS as readonly string[]).includes(themeId)) return themeId as TrayArtKey;
  return undefined;
}

let woodCanvas: HTMLCanvasElement | undefined;
let woodBackgroundUrl = '';
let woodWarmup: Promise<HTMLCanvasElement> | undefined;

const decodedTrayImages = new Map<TrayArtKey, HTMLImageElement>();
const trayImagePromises = new Map<TrayArtKey, Promise<HTMLImageElement | undefined>>();
const prewarmedBoards = new Map<string, HTMLCanvasElement>();

export const diceTableBackgroundSync = (): string => woodBackgroundUrl;
export const getDiceTableWoodCanvas = (): HTMLCanvasElement | undefined => woodCanvas;
export const getDecodedTrayArtImage = (themeId: string): HTMLImageElement | undefined => {
  const key = normalizeTrayArtKey(themeId);
  return key ? decodedTrayImages.get(key) : undefined;
};

function ensureWoodLine(ctx: CanvasRenderingContext2D, y: number): void {
  const tone = 30 + Math.sin(y * 0.71) * 5 + Math.sin(y * 0.033) * 7;
  ctx.strokeStyle = `rgb(${tone + 28},${tone + 5},${tone * 0.65})`;
  ctx.beginPath();
  for (let x = 0; x <= 2048; x += 8) {
    const knot =
      Math.exp(-(((x - 1270) / 330) ** 2) - ((y - 610) / 220) ** 2) *
      Math.sin((x - 1270) * 0.005) *
      48;
    const yy = y + Math.sin(x * 0.003 + y * 0.008) * 5 + knot;
    if (x) ctx.lineTo(x, yy);
    else ctx.moveTo(x, yy);
  }
  ctx.stroke();
}

export function prepareDiceWoodSurface(): Promise<HTMLCanvasElement> {
  if (woodCanvas) return Promise.resolve(woodCanvas);
  return (woodWarmup ??= (async () => {
    const started = performance.now();
    const wood = document.createElement('canvas');
    wood.width = 2048;
    wood.height = 1024;
    const ctx = wood.getContext('2d')!;
    ctx.fillStyle = '#382217';
    ctx.fillRect(0, 0, 2048, 1024);
    for (let y = 0; y < 1024; y++) {
      ensureWoodLine(ctx, y);
      // Yield while preparing the first texture so map input remains responsive.
      if (y % 64 === 63) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    for (let y = 0; y < 1024; y += 256) {
      ctx.fillStyle = '#080402';
      ctx.fillRect(0, y, 2048, 2);
    }
    woodCanvas = wood;
    try {
      woodBackgroundUrl = wood.toDataURL('image/jpeg', 0.9);
    } catch {
      woodBackgroundUrl = '';
    }
    performance.measure('dice-table-texture-preparation', { start: started, end: performance.now() });
    return wood;
  })());
}

export function preloadTrayArtImage(themeId: string): Promise<HTMLImageElement | undefined> {
  const key = normalizeTrayArtKey(themeId);
  if (!key) return Promise.resolve(undefined);
  const existing = decodedTrayImages.get(key);
  if (existing) return Promise.resolve(existing);
  let pending = trayImagePromises.get(key);
  if (!pending) {
    pending = new Promise<HTMLImageElement | undefined>((resolve) => {
      const img = new Image();
      img.decoding = 'async';
      const finish = (ok: boolean) => {
        if (!ok) {
          trayImagePromises.delete(key);
          resolve(undefined);
          return;
        }
        const finalize = () => {
          decodedTrayImages.set(key, img);
          resolve(img);
        };
        if (typeof img.decode === 'function') {
          img.decode().then(finalize, finalize);
        } else {
          finalize();
        }
      };
      img.onload = () => finish(true);
      img.onerror = () => finish(false);
      img.src = `/art/dice-trays/${key}-v1.webp`;
    });
    trayImagePromises.set(key, pending);
  }
  return pending;
}

export async function preloadDiceBoardAssets(
  themeIds: readonly string[],
  canContinue: () => boolean = () => true,
  onStep?: (completed: number, total: number) => void,
): Promise<void> {
  const artKeys = new Set<TrayArtKey>(TRAY_ART_KEYS);
  for (const id of themeIds) {
    const key = normalizeTrayArtKey(id);
    if (key) artKeys.add(key);
  }
  const keys = [...artKeys];
  const total = 1 + keys.length;
  let done = 0;
  if (!canContinue()) return;
  await prepareDiceWoodSurface();
  done++;
  onStep?.(done, total);
  for (const key of keys) {
    if (!canContinue()) return;
    await preloadTrayArtImage(key);
    done++;
    onStep?.(done, total);
  }
}

export function setPrewarmedBoardCanvas(themeId: string, snapshot: HTMLCanvasElement): void {
  prewarmedBoards.set(themeId, snapshot);
  if (themeId.startsWith('dm-') && !prewarmedBoards.has('dm')) {
    prewarmedBoards.set('dm', snapshot);
  }
}

export function getPrewarmedBoardCanvas(themeId: string): HTMLCanvasElement | undefined {
  return prewarmedBoards.get(themeId) ?? (themeId.startsWith('dm-') ? prewarmedBoards.get('dm') : undefined);
}

function themeFrameColors(themeId: string): { rim: string; trim: string } {
  if (themeId.startsWith('dm-')) return { rim: '#171b23', trim: '#9ba5b1' };
  if (themeId === 'fighter') return { rim: '#111116', trim: '#a27632' };
  if (themeId === 'ranger') return { rim: '#241207', trim: '#784825' };
  if (themeId === 'sorcerer') return { rim: '#22080e', trim: '#454956' };
  return { rim: '#160904', trim: '#49413a' };
}

/**
 * Synchronously paints the pre-warmed dice board onto `target` on Frame 0 so
 * initial rolls never flash an empty brown box while async shaders or workers start.
 */
export function drawPrewarmedDiceBoard(target: HTMLCanvasElement, themeId: string, dpr = 1): boolean {
  const ctx = target.getContext('2d');
  if (!ctx) return false;
  const cssWidth = target.clientWidth || 600;
  const cssHeight = cssWidth * (10.2 / 15.2);
  const pixelRatio = Math.max(1, dpr);
  const pixelWidth = Math.round(cssWidth * pixelRatio);
  const pixelHeight = Math.round(cssHeight * pixelRatio);
  if (target.width !== pixelWidth || target.height !== pixelHeight) {
    target.width = pixelWidth;
    target.height = pixelHeight;
  }
  ctx.save();
  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

  const prewarmed = getPrewarmedBoardCanvas(themeId);
  if (prewarmed) {
    ctx.clearRect(0, 0, cssWidth, cssHeight);
    ctx.drawImage(prewarmed, 0, 0, cssWidth, cssHeight);
    ctx.restore();
    return true;
  }

  // Pure-2D fallback (used before 3D warmup finishes or on Legacy 3D's first roll):
  // draw the wood surface + recessed framed tray bed with decoded class artwork.
  if (woodCanvas) {
    ctx.drawImage(woodCanvas, 0, 0, cssWidth, cssHeight);
  } else {
    ctx.fillStyle = '#382217';
    ctx.fillRect(0, 0, cssWidth, cssHeight);
  }

  const { rim, trim } = themeFrameColors(themeId);
  const padX = cssWidth * 0.064;
  const padY = cssHeight * 0.078;
  const trayW = cssWidth - padX * 2;
  const trayH = cssHeight - padY * 2;
  const wall = Math.max(8, cssWidth * 0.026);
  const bedX = padX + wall;
  const bedY = padY + wall;
  const bedW = trayW - wall * 2;
  const bedH = trayH - wall * 2;

  // Outer plinth shadow & rim
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.62)';
  ctx.shadowBlur = Math.max(10, cssWidth * 0.028);
  ctx.shadowOffsetY = Math.max(4, cssHeight * 0.014);
  ctx.fillStyle = '#100e13';
  ctx.beginPath();
  ctx.roundRect(padX - 3, padY - 2, trayW + 6, trayH + 5, 8);
  ctx.fill();
  ctx.restore();

  ctx.fillStyle = rim;
  ctx.beginPath();
  ctx.roundRect(padX, padY, trayW, trayH, 6);
  ctx.fill();

  // Metallic lip trim
  ctx.strokeStyle = trim;
  ctx.lineWidth = Math.max(1.5, wall * 0.16);
  ctx.strokeRect(padX + wall * 0.36, padY + wall * 0.36, trayW - wall * 0.72, trayH - wall * 0.72);

  // Recessed tray bed (decoded artwork or dark green felt)
  ctx.save();
  ctx.beginPath();
  ctx.rect(bedX, bedY, bedW, bedH);
  ctx.clip();
  const art = getDecodedTrayArtImage(themeId);
  if (art) {
    ctx.drawImage(art, bedX, bedY, bedW, bedH);
  } else {
    ctx.fillStyle = '#1b3029';
    ctx.fillRect(bedX, bedY, bedW, bedH);
  }
  // Inner contact occlusion along the 4 walls
  const shade = Math.max(10, wall * 1.35);
  const topGrad = ctx.createLinearGradient(0, bedY, 0, bedY + shade);
  topGrad.addColorStop(0, 'rgba(0,0,0,0.58)');
  topGrad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = topGrad;
  ctx.fillRect(bedX, bedY, bedW, shade);

  const botGrad = ctx.createLinearGradient(0, bedY + bedH, 0, bedY + bedH - shade);
  botGrad.addColorStop(0, 'rgba(0,0,0,0.45)');
  botGrad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = botGrad;
  ctx.fillRect(bedX, bedY + bedH - shade, bedW, shade);

  const leftGrad = ctx.createLinearGradient(bedX, 0, bedX + shade, 0);
  leftGrad.addColorStop(0, 'rgba(0,0,0,0.5)');
  leftGrad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = leftGrad;
  ctx.fillRect(bedX, bedY, shade, bedH);

  const rightGrad = ctx.createLinearGradient(bedX + bedW, 0, bedX + bedW - shade, 0);
  rightGrad.addColorStop(0, 'rgba(0,0,0,0.5)');
  rightGrad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = rightGrad;
  ctx.fillRect(bedX + bedW - shade, bedY, shade, bedH);
  ctx.restore();

  ctx.restore();
  return true;
}
