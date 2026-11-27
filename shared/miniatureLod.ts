export type MiniatureLod = 'battlefield' | 'low' | 'balanced' | 'high';
export type MiniatureLodBudget = 'low' | 'balanced' | 'high' | 'auto' | 'off';

// High uses Balanced as its distant floor and upgrades at 180 CSS px; Balanced
// keeps Low/Balanced at 180 px, and Low uses Battlefield/Low at 100 px.
const PAIRS = {
  high: {far: 'balanced', near: 'high', pixels: 180},
  balanced: {far: 'low', near: 'balanced', pixels: 180},
  low: {far: 'battlefield', near: 'low', pixels: 100},
} as const;

/** Each resolved graphics mode downloads at most its two geometry tiers.
 * Auto callers normally pass their resolved performance tier. */
export function miniatureLodPair(quality: MiniatureLodBudget) {
  return PAIRS[quality === 'low' || quality === 'off' ? 'low' : quality === 'balanced' ? 'balanced' : 'high'];
}

/** Start preparing only the same preset's close tier, while the visible figure
 * is approaching close-up size. Display thresholds remain unchanged. */
export function miniatureLodShouldPrepare(pixels:number,quality:MiniatureLodBudget,onScreen:boolean):boolean {
  return onScreen && Number.isFinite(pixels) && pixels >= miniatureLodPair(quality).pixels*.55;
}

/** CSS-pixel base diameter, independent of DPR and map scale. The detailed
 * model is only eligible inside the viewport. Hysteresis prevents zoom jitter. */
export function miniatureLodForPixels(pixels: number, quality: MiniatureLodBudget, previous?: MiniatureLod, onScreen = true): MiniatureLod {
  const p = Number.isFinite(pixels) ? Math.max(0, pixels) : 0;
  const pair = miniatureLodPair(quality);
  if (!onScreen) return pair.far;
  const threshold = pair.pixels * (previous === pair.near ? .85 : previous === pair.far ? 1.15 : 1);
  return p >= threshold ? pair.near : pair.far;
}
