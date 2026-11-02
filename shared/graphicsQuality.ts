import type {EnvironmentQuality} from './mapEnvironment.js';

/** Browser-only rendering budgets. Never used for visibility, movement or dice outcomes. */
export const DEFAULT_GRAPHICS_QUALITY='low' as const;
export type AutoGraphicsTier='high'|'balanced'|'low';
export type HardwareTierId='tier1'|'tier2'|'tier3';
export type HardwareTierLabel='Laptop / Battery Saver'|'Balanced'|'Ultra';

export type HardwareBenchmarkSample={
  avgFps:number;
  p95FrameMs:number;
  maxTextureSize?:number;
  rendererString?:string;
  batterySaver?:boolean;
};

/**
 * Classify a startup GPU benchmark sample into an automatic quality tier.
 * Integrated Intel HD/UHD or battery-saver devices map to Tier 1 (`'low'`),
 * mid-range GPUs map to Tier 2 (`'balanced'`), and discrete GPUs map to Tier 3 (`'high'`).
 */
export function classifyHardwareBenchmark(sample:HardwareBenchmarkSample):AutoGraphicsTier{
  if(sample.batterySaver)return 'low';
  const renderer=(sample.rendererString??'').toLowerCase();
  const isLegacyIntegrated=/intel\(r\)\s*(hd|uhd)\s*graphics\s*(4\d\d|5\d\d|6\d\d)|\bswiftshader\b|\bllvmpipe\b|\bmali-4|\badreno\s*[345]/i.test(renderer);
  if(isLegacyIntegrated||(sample.maxTextureSize!==undefined&&sample.maxTextureSize<=2048))return 'low';
  if(sample.avgFps<35||sample.p95FrameMs>34)return 'low';
  if(sample.avgFps<54||sample.p95FrameMs>21)return 'balanced';
  return 'high';
}

export function graphicsBudget(quality:EnvironmentQuality, viewportWidth=1440,autoTier?:AutoGraphicsTier){
  const resolved=quality==='auto'?(autoTier??(viewportWidth<900?'balanced':'high')):quality;
  const legacy=resolved==='legacy';
  const low=resolved==='low'||resolved==='off'||legacy;
  const hardwareTier:HardwareTierId=low?'tier1':resolved==='balanced'?'tier2':'tier3';
  const hardwareTierLabel:HardwareTierLabel=low?'Laptop / Battery Saver':resolved==='balanced'?'Balanced':'Ultra';
  return {
    resolved,
    legacy,
    hardwareTier,
    hardwareTierLabel,
    frameloop:'demand' as const,
    activeSceneFps:low?30:60,
    idleSceneFps:low?12:resolved==='balanced'?20:30,
    maxMapTextureResolutionPx:low?2048:resolved==='balanced'?4096:8192,
    maxMeshTriangles:low?5000:resolved==='balanced'?25000:100000,
    visionPassMode:low?'stencil2d' as const:resolved==='balanced'?'dynamic2d' as const:'ultra3d' as const,
    tokenRenderMode:legacy||resolved==='off'?'2d-sprites' as const:low?'decimated-or-2d' as const:resolved==='balanced'?'battlefield-lod' as const:'hero-3d' as const,
    animatedSpellShaders:resolved==='high',
    full3dDicePhysics:!legacy&&resolved!=='off',

    modelQuality:resolved==='off'||legacy?'low' as const:resolved,
    miniatureLightMode:low?'ground' as const:'directional' as const,
    pixelRatioCap:low?1:resolved==='balanced'?1.5:2,
    localShadowSize:low?256:resolved==='balanced'?384:512,
    localShadowLights:resolved==='off'||legacy?0:low?2:4,
    localShadowMethod:resolved==='high'?'cube' as const:'floor' as const,
    localShadowFps:30,
    localShadowPoseFps:10,
    localShadowFloorSize:low?512:768,
    mapShadowSize:low?512:resolved==='balanced'?1024:2048,
    diceShadowSize:low?256:resolved==='balanced'?512:1024,
    diceRenderWidth:low?960:resolved==='balanced'?1200:1440,
    particleScale:resolved==='off'||legacy?0:low?.18:resolved==='balanced'?.35:1,
    mistQuality:resolved==='off'||legacy?'off' as const:resolved==='high'?'high' as const:'low' as const,
  };
}

export function parseGraphicsQuality(value:unknown):EnvironmentQuality{
  return value==='auto'||value==='high'||value==='balanced'||value==='low'||value==='off'||value==='legacy'?value:DEFAULT_GRAPHICS_QUALITY;
}
