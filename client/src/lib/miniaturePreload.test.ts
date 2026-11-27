import {it,expect,vi} from 'vitest';
import {MINIATURES,miniatureForLod,miniatureForPreload,miniatureForQuality,miniaturePreloadDefinitions,refreshMiniatureCatalog,resolveMiniature} from './miniatures';
import manifest from '../../public/miniatures/manifest.json';
import qualityManifest from '../../public/miniatures/quality-manifest.json';
import battlefieldManifest from '../../public/miniatures/battlefield-manifest.json';
import {miniatureLodPair,miniatureLodForPixels} from '../../../shared/miniatureLod';

it('only prepares the coarse character model of the selected graphics pair',()=>{
  for(const id of ['druk','varis','vanec'])for(const quality of ['high','balanced','low'] as const){
    const pair=miniatureLodPair(quality),model=MINIATURES[id];
    const preload=miniatureForPreload(model,quality);
    expect(preload.url).toBe(miniatureForLod(model,pair.far).url);
    if(quality!=='low')expect(preload.url).not.toContain('-battlefield-');
    expect(preload.fallbackUrl).toBeUndefined();
    const near=miniatureForLod(model,pair.near,quality);
    expect(near.url).not.toBe(preload.url);
    expect(near.fallbackUrl).toBe(preload.url);
  }
});
it('routes Druk across High, Balanced, Low, and Battlefield tiers while preserving base metadata',()=>{
  const highExpected=manifest.models.find(m=>m.id==='druk')!;
  const balancedExpected=qualityManifest.models.find(m=>m.id==='druk'&&m.profile==='balanced')!;
  const lowExpected=qualityManifest.models.find(m=>m.id==='druk'&&m.profile==='low')!;
  const bfExpected=battlefieldManifest.models.find(m=>m.id==='druk')!;
  const model=MINIATURES.druk;
  expect(model.url).toBe(highExpected.url);
  expect(model.baseCenter).toEqual(highExpected.baseCenter);
  expect(model.baseDiameter).toBe(highExpected.baseDiameter);
  expect(model.baseTextureUrl).toBe(highExpected.baseTextureUrl);
  expect(resolveMiniature('Druk','pc')).toBe(model);
  expect(resolveMiniature('Druk','pc',{modelType:'druk'})).toBe(model);
  expect(miniaturePreloadDefinitions(['druk'])).toEqual([model]);
  expect(miniatureForQuality(model,'high')?.url).toBe(highExpected.url);
  expect(miniatureForQuality(model,'auto')?.url).toBe(highExpected.url);
  expect(miniatureForQuality(model,'balanced')?.url).toBe(balancedExpected.url);
  expect(miniatureForQuality(model,'low')?.url).toBe(lowExpected.url);
  expect(miniatureForQuality(model,'off')?.url).toBe(lowExpected.url);
  expect(miniatureForLod(model,'high').url).toBe(highExpected.url);
  expect(miniatureForLod(model,'balanced').url).toBe(balancedExpected.url);
  expect(miniatureForLod(model,'low').url).toBe(lowExpected.url);
  expect(miniatureForLod(model,'battlefield').url).toBe(bfExpected.url);
  for(const level of ['battlefield','low','balanced','high'] as const){
    const resolved=miniatureForLod(model,level);
    expect(resolved.baseCenter).toEqual(highExpected.baseCenter);
    expect(resolved.baseDiameter).toBe(highExpected.baseDiameter);
    expect(resolved.baseTextureUrl).toBe(highExpected.baseTextureUrl);
  }
  expect(miniatureForLod(model,miniatureLodPair('high').far,'high').url).toBe(balancedExpected.url);
  expect(miniatureForLod(model,miniatureLodPair('high').near,'high').url).toBe(highExpected.url);
  expect(miniatureForLod(model,miniatureLodPair('low').far,'low').url).toBe(bfExpected.url);
  expect(miniatureForLod(model,miniatureLodPair('low').near,'low').url).toBe(lowExpected.url);
  expect(miniatureLodForPixels(360,'high')).toBe('high');
});
it('keeps custom uploads and existing creature sculpts unchanged',()=>{
  for(const id of ['custom-hero','druk']){
    const custom={id,url:'/uploads/miniatures/custom.glb',baseDiameter:1,baseCenter:[0,0,0] as [number,number,number]};
    for(const quality of ['auto','high','balanced','low','off'] as const){
      expect(miniatureForQuality(custom,quality)).toBe(custom);
      expect(miniatureForPreload(custom,quality)).toBe(custom);
      expect(miniatureForLod(custom,miniatureLodPair(quality).near,quality)).toBe(custom);
    }
  }
  expect(miniatureForPreload(MINIATURES.goblin,'low')).toBe(MINIATURES.goblin);
});
it('reserves denser creature geometry for on-screen High close-ups',()=>{
  for(const id of ['goblin','human-bandit']){
    const model=MINIATURES[id];expect(model.highDetail).toBeDefined();
    expect(model.balancedDetail).toBeUndefined();
    for(const quality of ['low','balanced','high'] as const){
      expect(miniatureForPreload(model,quality)).toBe(model);
      const level=miniatureLodForPixels(1000,quality,undefined,false);
      expect(miniatureForLod(model,level,quality)).toBe(model);
      const near=miniatureForLod(model,miniatureLodPair(quality).near,quality);
      expect(near.url).toBe(quality==='high'?model.highDetail!.url:model.url);
      expect(near.baseCenter).toBe(model.baseCenter);
      expect(near.id).toBe(model.id);
    }
    expect(miniatureForLod(model,'high','balanced')).toBe(model);
    expect(miniatureForLod(model,'high','low')).toBe(model);
  }
});
it.each(['hero-quality-test','druk'])('routes generated character %s to its own High, Balanced and Low models',async(id)=>{
  const detail=(tier:string,triangles:number)=>({url:`/uploads/miniatures/hero-${tier}.glb`,bytes:5000000,triangles,sha256:'a'.repeat(64)});
  const model={id,url:'/uploads/miniatures/hero-standard.glb',baseCenter:[0,0,0],baseDiameter:1,bytes:4000000,triangles:20256,sha256:'b'.repeat(64),highDetail:detail('high',120256),balancedDetail:detail('balanced',60256)};
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({models:[model]})}));
  try{
    await refreshMiniatureCatalog();
    const hero=resolveMiniature('Test','pc',{modelType:model.id})!;
    for(const quality of ['high','balanced','low'] as const){
      expect(miniatureForPreload(hero,quality).url).toBe(model.url);
      const near=miniatureForLod(hero,miniatureLodPair(quality).near,quality);
      expect(near.url).toBe(quality==='high'?model.highDetail.url:quality==='balanced'?model.balancedDetail.url:model.url);
      if(quality!=='low')expect(near.fallbackUrl).toBe(model.url);
    }
    expect(miniatureForLod(hero,'high','low').url).toBe(model.url);
    expect(miniatureForLod(hero,'balanced','high').url).toBe(model.url);
    model.highDetail.url='https://untrusted.example/high.glb';
    await refreshMiniatureCatalog();
    expect(resolveMiniature('Test','pc',{modelType:model.id})!.highDetail).toBeUndefined();
  }finally{vi.unstubAllGlobals();}
});
