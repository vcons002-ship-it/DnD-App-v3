import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import {config} from './config.js';
import {resolveToken} from '../../shared/tokenDisplay.js';
import {COMBAT_ROLE_ICON} from '../../shared/combatRole.js';
import type {StateSnapshot} from '../../shared/types.js';
import {grantCachedAsset,rasterAsset} from './renderAssets.js';
const escape=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]!));
const portraits=new Map<string,Promise<string|null>>();
const spritePairCache=new Map<string,NonNullable<StateSnapshot['tokenSprites']>[string]>();
/** Uploaded raster portraits only: no URL fetching, SVG scripts or filesystem traversal. */
async function portrait(url:string){
 if(!/^\/uploads\/[a-zA-Z0-9_.-]+$/.test(url))return null;
 let cached=portraits.get(url);if(cached)return cached;
 cached=(async()=>{try{
  const file=path.join(config.uploadsDir,url.slice('/uploads/'.length));
  const stat=await fs.stat(file);if(stat.size>32*1024*1024)return null;
  const buffer=await sharp(file,{limitInputPixels:40_000_000}).resize(384,384,{fit:'fill'}).png().toBuffer();
  return `data:image/png;base64,${buffer.toString('base64')}`;
 }catch{return null;}})();
 if(portraits.size>=256)portraits.delete(portraits.keys().next().value!);
 portraits.set(url,cached);return cached;
}
const svg=(box:{x:number;y:number;width:number;height:number},content:string)=>`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${box.width}" height="${box.height}" viewBox="${box.x} ${box.y} ${box.width} ${box.height}" font-family="Arial, Segoe UI Emoji, sans-serif">${content}</svg>`;
const text=(value:string,x:number,y:number,size:number,extra='')=>`<text x="${x}" y="${y}" font-size="${size}" text-anchor="middle" ${extra}>${escape(value)}</text>`;
const hasEmoji=(s:string)=>/[^\x00-\x7F]/.test(s);
/** Authorized snapshots are the sole source of sprites, including visible HP and death flags.
 * Body and upright HUD remain separate so local pan/rotation/selection require no round trip. */
export async function tokenSprites(id:string,snapshot:StateSnapshot,preShade=false):Promise<NonNullable<StateSnapshot['tokenSprites']>>{
 if(!snapshot.map||!snapshot.tokens.length)return {};
 const map=snapshot.map,result:NonNullable<StateSnapshot['tokenSprites']>={},px=map.gridSizePx/map.feetPerSquare,showHpNumbers=snapshot.role==='dm';
 const entityIndex={characters:new Map(snapshot.characters.map(c=>[c.id,c])),monsters:new Map(snapshot.monsters.map(m=>[m.id,m]))};
 const affinitySet=snapshot.legacyGeometry?new Set(snapshot.legacyGeometry.affinity):undefined;
 // Bounded concurrency (4 tokens at a time) parallelizes cold rooms across the
 // worker pool without flooding the worker queue on 140+ token encounters.
 let cursor=0;
 const worker=async()=>{
  while(cursor<snapshot.tokens.length){
   const t=snapshot.tokens[cursor++];
   const d=resolveToken(snapshot,t,entityIndex),r=Math.max(1,Math.min(512,t.widthFt*px/2)),size=Math.ceil(Math.max(256,r*8));
   // Oversized tokens use the exact client fallback rather than allocating unbounded rasters.
   if(size>2048)continue;
   const affinityVisible=!!(d.disposition&&!t.sharedSightOnly&&!t.partiallyRevealed&&(affinitySet?affinitySet.has(t.id):true));
   const grayscale=preShade&&!!t.sharedSightOnly&&!!snapshot.playerVision?.heavy&&(!d.icon||!!d.dead||!hasEmoji(d.icon));
   const hasHunterMark=!!(t.markLabels?.some(label=>/hunter.s mark/i.test(label))&&!t.sharedSightOnly&&!t.partiallyRevealed);
   const cacheKey=`${px}:${map.gridSizePx}:${t.kind}:${t.widthFt}:${t.shape??'circle'}:${t.invisible?1:0}:${t.partiallyRevealed?1:0}:${t.sharedSightOnly?1:0}:${d.icon}:${d.name}:${d.curHp??''}:${d.maxHp??''}:${d.tempHp??''}:${showHpNumbers?1:0}:${d.dead?1:0}:${t.revealTag??''}:${affinityVisible?d.disposition:''}:${t.combatRole??''}:${hasHunterMark?1:0}:${grayscale?1:0}`;
   const cachedPair=spritePairCache.get(cacheKey);
   if(cachedPair&&grantCachedAsset(id,cachedPair.body)&&grantCachedAsset(id,cachedPair.hud)){
    spritePairCache.delete(cacheKey);spritePairCache.set(cacheKey,cachedPair);
    result[t.id]=cachedPair;
    continue;
   }
   const image=await portrait(d.icon);
   // Preserve external / bundled portraits through the existing client renderer.
   if((d.icon.startsWith('/')||d.icon.startsWith('http'))&&!image)continue;
   const fill=t.kind==='pc'?'#2d6cdf':'#b1432f',shape=t.shape??'circle';
   const silhouette=(attrs:string)=>shape==='square'||(shape==='image'&&image)?`<rect x="${-r}" y="${-r}" width="${r*2}" height="${r*2}" ${attrs}/>`:shape==='diamond'?`<path d="M0 ${-r*1.3}L${r*1.3} 0L0 ${r*1.3}L${-r*1.3} 0Z" ${attrs}/>`:shape==='triangle'?`<path d="M0 ${-r}L${r*.87} ${r*.5}L${-r*.87} ${r*.5}Z" ${attrs}/>`:`<circle r="${r}" ${attrs}/>`;
   const opacity=t.invisible?.28:d.dead?.5:1;
   const clip=shape==='square'?`<rect x="${-r}" y="${-r}" width="${2*r}" height="${2*r}"/>`:shape==='diamond'?`<path d="M0 ${-r}L${r} 0L0 ${r}L${-r} 0Z"/>`:silhouette('');
   const body=image?`<defs><clipPath id="p">${clip}</clipPath></defs><image xlink:href="${image}" x="${-r}" y="${-r}" width="${r*2}" height="${r*2}" opacity="${opacity}" ${shape==='image'?'':'clip-path="url(#p)"'}/>${shape==='image'?'':silhouette('fill="none" stroke="#111111" stroke-opacity=".53" stroke-width="2"')}`:`${silhouette(`fill="${fill}" opacity="${opacity}" stroke="#111111" stroke-opacity=".53" stroke-width="2"`)}${d.icon&&!d.dead&&!hasEmoji(d.icon)?text(d.icon,0,r*.36,r*1.1):''}`;
   const preferredFont=Math.max(9.5,Math.min(11.5,Math.round(map.gridSizePx*.165))),maxLabelW=Math.max(42,Math.min(74,Math.round(r*1.44)));
   const tag=t.revealTag??'',cleanName=d.name.replace(/\s+/g,' ').trim(),fullLabel=tag?`${cleanName} ${tag}`:cleanName;
   const estFullW=fullLabel.length*preferredFont*.56,availW=Math.max(maxLabelW*.55,maxLabelW-2);
   const font=estFullW>availW?Math.max(8.5,preferredFont*(availW/estFullW)):preferredFont;
   const roleR=Math.max(8.5,Math.min(11.5,r*.3)),hasHp=!!(d.maxHp&&d.maxHp>0&&d.curHp!==undefined),hpFont=Math.max(9,Math.min(10.5,Math.round(map.gridSizePx*.155)));
   const showExactHp=!d.dead&&!t.partiallyRevealed&&hasHp&&showHpNumbers;
   const barW=Math.max(30,Math.round(r*1.44)),barH=showExactHp?hpFont+2:5,barR=barH/2,barY=r+2;
   const labelY=hasHp?barY+barH+2:r+4;
   const tagW=tag?tag.length*font*.64+3:0,nameBudget=Math.max(22,maxLabelW-tagW);
   const chars=Math.max(4,Math.floor(nameBudget/(font*.58)));
   const line=cleanName.length>chars?cleanName.slice(0,chars-1)+'…':cleanName;
   const nameW=Math.min(maxLabelW,(line.length+(tag?tag.length+1:0))*font*.58+4);
   const labelFill=t.sharedSightOnly?'#8a919e':'white',labelFade=t.sharedSightOnly?' opacity=".75"':'';
   let hud='';
   if(!d.dead&&!t.partiallyRevealed&&hasHp){const frac=Math.max(0,Math.min(1,d.curHp!/d.maxHp!));hud+=`<rect x="${-barW/2}" y="${barY}" width="${barW}" height="${barH}" rx="${barR}" fill="${showExactHp?'#0b0d12':'black'}" fill-opacity="${showExactHp?'.85':'.56'}"${showExactHp?' stroke="black" stroke-opacity=".7" stroke-width=".75"':''}/><rect x="${-barW/2}" y="${barY}" width="${barW*frac}" height="${barH}" rx="${barR}" fill="${frac>.5?'#39c46b':frac>.25?'#f5c518':'#e23b3b'}"/>`;if(showExactHp)hud+=text(`${d.curHp}/${d.maxHp}`,0,barY+barH/2+hpFont*.34,hpFont,'fill="white" stroke="black" stroke-width="2.2" paint-order="stroke" stroke-linejoin="round" font-weight="bold"');if(d.tempHp){const tf=Math.max(9,Math.min(11,hpFont));hud+=text(`+${d.tempHp}`,barW/2+4+String(d.tempHp).length*tf*.32,barY+barH/2+tf*.34,tf,'fill="#5ce1ff" stroke="black" stroke-width="2" paint-order="stroke" font-weight="bold"');}}
   if(!d.dead&&!t.partiallyRevealed)hud+=`<text x="0" y="${labelY+font*.88}" font-size="${font}" text-anchor="middle" fill="${labelFill}"${labelFade} stroke="black" stroke-width="2.5" paint-order="stroke" stroke-linejoin="round">${escape(line)}${tag?` <tspan font-weight="bold">${escape(tag)}</tspan>`:''}</text>`;
   if(affinityVisible)hud+=`<circle cx="${-r*.8}" cy="${-r*.8}" r="${Math.max(5,r*.16)}" fill="${{friendly:'#39c46b',neutral:'#f5c518',enemy:'#e23b3b'}[d.disposition!]}" stroke="black"/>`;
   if(!d.dead&&!t.partiallyRevealed&&t.kind!=='pc'&&t.combatRole)hud+=`<g transform="translate(${-r*.82} ${r*.46})"><circle r="${roleR}" fill="#0b0d12" stroke="white" stroke-width="1.5"/></g>`;

   if(hasHunterMark)hud+=`<g transform="translate(0 ${-r-22})"><path d="M0 -14L14 0L0 14L-14 0Z" fill="#352106" stroke="#ffe7a1" stroke-width="2"/><circle r="4" fill="#fff5d2"/></g>`;
   const edge=Math.ceil(r*1.3+4),hudEdge=Math.ceil(Math.max(barW/2+24,nameW/2+18,showExactHp?40:0)),top=Math.ceil(r+52),bottom=Math.ceil(labelY+font*1.5+16);
   const bodyBox={x:-edge,y:-edge,width:edge*2,height:edge*2,scale:1};
   const hudBox={x:-hudEdge,y:-top,width:hudEdge*2,height:top+bottom,scale:1};
   // Match the client's shared-sight grayscale transform once per reusable sprite,
   // rather than allocating/filtering a separate canvas for every shared token.
   const bodyArt=grayscale?`<defs><filter id="dark" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values=" .2126 .7152 .0722 0 0 .2126 .7152 .0722 0 0 .2126 .7152 .0722 0 0 0 0 0 1 0"/></filter></defs><g filter="url(#dark)">${body}</g>`:body;
   const [bodyAsset,hudAsset]=await Promise.all([rasterAsset(id,svg(bodyBox,bodyArt),bodyBox),rasterAsset(id,svg(hudBox,hud),hudBox)]);
   const pair={body:bodyAsset,hud:hudAsset,...(grayscale?{grayscale:true}:{})};
   if(spritePairCache.size>=2048)spritePairCache.delete(spritePairCache.keys().next().value!);
   spritePairCache.set(cacheKey,pair);
   result[t.id]=pair;
  }
 };
 await Promise.all(Array.from({length:Math.min(4,snapshot.tokens.length)},()=>worker()));
 return result;
}
