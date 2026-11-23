import type {StateSnapshot,Token} from '../../shared/types.js';
import type {LegacyMotion,LegacyMotionFrame} from '../../shared/legacyMotion.js';
import {unionTerrain} from '../../shared/explorationSight.js';
import {CARRIED_LANTERN_LIGHT_HEIGHT_FT} from '../../shared/lightFalloff.js';
import {createPlayerVision,fogVisionContainsToken,fogVisionIntersectsToken,needsVisibilityLayer,tokenRadiusPx,usesMapVision,usesTokenVision,visionShowsAffinity,type PlayerVision} from '../../shared/playerVision.js';
import {tokenVisibleAt} from '../../shared/fog.js';
import {hasLineOfSight} from '../../shared/mapWalls.js';
import {isInvisible} from '../../shared/advancedSpells.js';
import {seesInvisible} from '../../shared/invisibleSight.js';
import {tokenDistanceFt} from '../../shared/distance.js';
import {facingAfterMove} from '../../shared/tokenFacing.js';
import {legacyPath} from '../../shared/legacyVision.js';
import {equal} from '../../shared/stateDelta.js';
import {walkingRoute,type WalkingRoute} from './walking.js';
import {visibilityWorkers,formatExploredMemory} from './visibilityWorkers.js';
import {tokenSprites} from './tokenSprites.js';
import {legacyTerrainFrames} from './legacyTerrain.js';
import {LEGACY_MOTION_STEPS} from '../../shared/legacyMotion.js';
import {tokenMoveDuration,tokenMoveProgress} from '../../client/src/canvas/tokenMotion.js';
import {explorationGeneration} from './exploration.js';
import {createSnapshotBuilder} from './visibility.js';
import {listCharacters,listMonsters,listTokens} from './sessions.js';
import type {MovementFrameTiming} from '../../shared/movementTiming.js';
import {walkingMapKey} from './legacyMotionMap.js';
import {grantMotionAssets} from './renderAssets.js';
import {renderingLayerKey} from './renderedSnapshot.js';
const intermediateCache=new Map<string,StateSnapshot[]>();
const motionCache=new Map<string,Promise<LegacyMotion|undefined>>();
export function clearLegacyMotionCache(){motionCache.clear();intermediateCache.clear();}
const formatMemory=formatExploredMemory;
const isGhost=(t:StateSnapshot['tokens'][number])=>!!t.revealedOnly&&t.kind!=='pc';
function normalizeFrameToken(token:StateSnapshot['tokens'][number],moves:LegacyMotion['moves'],endTokens:Map<string,StateSnapshot['tokens'][number]>){
 const move=moves[token.id];if(!move)return token;
 const end=endTokens.get(token.id);
 const facing=end?end.facing:facingAfterMove(move.from.x,move.from.y,move.to.x,move.to.y,token.facing);
 return {...token,...move.to,...(facing!==undefined||token.facing!==undefined?{facing}:{})};
}
type ClipDepartingContext={
 after:StateSnapshot;live:Token;route:WalkingRoute;stayingMoves:LegacyMotion['moves'];
 monById:Map<string,ReturnType<typeof listMonsters>[number]>;charById:Map<string,ReturnType<typeof listCharacters>[number]>;
 partyVision?:PlayerVision;ownedPcs:Token[];mapFog:Set<string>|null;tokenFog:Set<string>|null;sameAsParty:boolean;
};
/** Clip a departing move just past the viewer's sight boundary so unseen
 * destination coordinates and beyond-sight travel distance never leak. */
function clipDepartingMove(ctx:ClipDepartingContext):{x:number;y:number}|undefined{
 const {after,live,route,stayingMoves,monById,charById,partyVision,ownedPcs,mapFog,tokenFog,sameAsParty}=ctx;
 const map=after.map!,vision=after.playerVision!;
 const dx=route.to.x-route.from.x,dy=route.to.y-route.from.y,dist=Math.hypot(dx,dy);
 if(!(dist>0))return route.to;
 const ux=dx/dist,uy=dy/dist,grid=map.gridSizePx??50,px=grid/Math.max(.001,map.feetPerSquare??5);
 const walls=map.walls??[],wallVis=usesTokenVision(map),radiusPx=tokenRadiusPx(live,map);
 const monster=live.kind==='monster'?monById.get(live.refId):undefined;
 const foe=live.kind==='monster'&&monster?.disposition!=='friendly',invisibleEnemy=foe&&isInvisible(monster);
 const checkParty=map.sharedPartyVision!==false&&!sameAsParty&&!!partyVision&&live.kind==='monster'&&!monster?.objectKind;
 const movingPos=(id:string,frac:number,fallback:{x:number;y:number})=>{const m=stayingMoves[id];return m?{x:m.from.x+(m.to.x-m.from.x)*frac,y:m.from.y+(m.to.y-m.from.y)*frac}:fallback;};
 const visionAt=(base:PlayerVision,frac:number,probeX:number,probeY:number,fogOk:boolean):PlayerVision=>{
  const movedOrigin=base.origins.some(o=>!!stayingMoves[o.id]);
  const origins=movedOrigin?base.origins.map(o=>({...o,...movingPos(o.id,frac,o)})):base.origins;
  const movedLight=base.lights.some(l=>!!stayingMoves[l.id]);
  if(!movedOrigin&&!movedLight&&!live.carriedLantern)return base;
  let lights=movedLight?base.lights.map(l=>({...l,...movingPos(l.id,frac,l)})):base.lights;
  if(live.carriedLantern){
   lights=lights.filter(l=>l.id!==live.id);
   if(fogOk&&origins.some(o=>!walls.length||hasLineOfSight(o,{x:probeX,y:probeY},walls))){
    lights.push({id:live.id,x:probeX,y:probeY,radius:20*px,height:CARRIED_LANTERN_LIGHT_HEIGHT_FT*px,strength:.85,carried:true});
   }
  }
  return {...base,origins,lights};
 };
 const canSeeAt=(d:number):boolean=>{
  const x=route.from.x+ux*d,y=route.from.y+uy*d;
  const fogOk=tokenVisibleAt({role:after.role,hidden:false,owned:false,foe,mapFog,tokenFog,grid,x,y});
  if(!fogOk)return false;
  const frac=Math.min(1,Math.max(0,d/dist));
  if(invisibleEnemy&&!ownedPcs.some(o=>{const ch=charById.get(o.refId);return !!ch&&seesInvisible(ch,tokenDistanceFt({...o,...movingPos(o.id,frac,o)},{...live,x,y},map));}))return false;
  if(fogVisionIntersectsToken(visionAt(vision,frac,x,y,fogOk),x,y,radiusPx,wallVis))return true;
  return checkParty&&!!partyVision&&fogVisionContainsToken(visionAt(partyVision,frac,x,y,fogOk),x,y,radiusPx,wallVis);
 };
 if(!canSeeAt(0))return undefined;
 const stepPx=Math.max(dist/512,Math.min(dist/16,Math.max(8,radiusPx*.4)));
 const count=Math.floor((dist-1e-6)/stepPx);
 let lastVisible=0;
 for(let i=1;i<=count;i++){const d=i*stepPx;if(canSeeAt(d))lastVisible=d;}
 if(canSeeAt(dist))return route.to;
 let lo=lastVisible,hi=Math.min(dist,lastVisible+stepPx);
 for(let i=0;i<16;i++){const mid=(lo+hi)*.5;if(canSeeAt(mid))lo=mid;else hi=mid;}
 const dExit=Math.min(dist,lo+Math.max(2,radiusPx*.15+2));
 return dExit>=dist?route.to:{x:route.from.x+ux*dExit,y:route.from.y+uy*dExit};
}
// Send membership plus only display overrides/extras. Repeating two full token
// lists would recreate every unchanged token object in a slow client's React tree.
function fields(s:StateSnapshot,at:number,endpoint:StateSnapshot,moves:LegacyMotion['moves']):LegacyMotionFrame{
 const endTokens=new Map(endpoint.tokens.map(t=>[t.id,t])),endMonsters=new Map(endpoint.monsters.map(m=>[m.id,m]));
 const tokens=s.tokens.flatMap(t=>{const norm=normalizeFrameToken(t,moves,endTokens);return equal(norm,endTokens.get(t.id))?[]:[norm];});
 const monsters=s.monsters.filter(m=>!equal(m,endMonsters.get(m.id)));
 const tokenSprites=Object.fromEntries(Object.entries(s.tokenSprites??{}).filter(([id,pair])=>!equal(pair,endpoint.tokenSprites?.[id])));
 return {at,tokenIds:s.tokens.map(t=>t.id),...(tokens.length?{tokens}:{}),...(monsters.length?{monsters}:{}),...(Object.keys(tokenSprites).length?{tokenSprites}:{}),legacyGeometry:s.legacyGeometry,visionRaster:s.visionRaster,visionTiles:s.visionTiles};
}
/** Never infer a walking path from two arbitrary snapshots: teleports, GM
 * relocations, changed maps/fog and coalesced walks must snap immediately. */
export async function prepareLegacyMotion(id:string,before:StateSnapshot,after:StateSnapshot,timing?:MovementFrameTiming,options?:{endpoint?:()=>Promise<StateSnapshot>;current?:()=>boolean;compact?:boolean;membershipOnly?:boolean}):Promise<LegacyMotion|undefined>{
 if(options?.membershipOnly&&!needsVisibilityLayer(after.map,after.playerVision))return;
 if(!before.map||!after.map||before.explorationEpoch!==after.explorationEpoch||walkingMapKey(before.map)!==walkingMapKey(after.map)||!equal(before.mapImages,after.mapImages)||before.tokenLayerRaster||after.tokenLayerRaster)return;
 const generation=explorationGeneration(after.map.id),wallsJson=JSON.stringify(after.map.walls??[]);
 const old=new Map(before.tokens.map(t=>[t.id,t])),afterById=new Map(after.tokens.map(t=>[t.id,t])),moves:LegacyMotion['moves']={},routes:WalkingRoute[]=[];
 for(const t of after.tokens){
  const previous=old.get(t.id);if(!previous||previous.x===t.x&&previous.y===t.y||isGhost(previous)||isGhost(t))continue;
  const route=walkingRoute(t.id);
  if(!route||route.generation!==generation||t.teleportedAt!==previous.teleportedAt||route.mapId!==after.map.id||route.walls!==wallsJson||route.from.x!==previous.x||route.from.y!==previous.y||route.to.x!==t.x||route.to.y!==t.y)return;
  moves[t.id]={from:route.from,to:route.to};routes.push(route);
 }
 const stayingMoves={...moves};
 let current:Map<string,Token>|undefined;
 if(after.playerVision&&before.tokens.some(t=>!afterById.has(t.id)&&!isGhost(t))){
  current=new Map(listTokens(after.map.id).map(t=>[t.id,t]));
  const departing:{live:Token;route:WalkingRoute}[]=[];
  for(const previous of before.tokens){
   if(afterById.has(previous.id)||isGhost(previous))continue;
   const live=current.get(previous.id);
   if(!live||live.isHidden||(live.x===previous.x&&live.y===previous.y))continue;
   const route=walkingRoute(live.id);
   if(!route||route.crossedWall||route.generation!==generation||live.teleportedAt!==previous.teleportedAt||route.mapId!==after.map.id||route.walls!==wallsJson||route.from.x!==previous.x||route.from.y!==previous.y||route.to.x!==live.x||route.to.y!==live.y)return;
   departing.push({live,route});
  }
  if(departing.length){
   const monById=new Map(listMonsters(after.map.sessionId).map(m=>[m.id,m])),charById=new Map(listCharacters(after.map.sessionId).map(c=>[c.id,c]));
   const originIds=new Set(after.playerVision.origins.map(o=>o.id));
   const ownedPcs=[...current.values()].filter(t=>originIds.has(t.id)),ownedSet=new Set(ownedPcs.map(t=>t.refId));
   const party=new Set([...current.values()].filter(t=>t.kind==='pc'&&!t.isHidden).map(t=>t.refId));
   const sameAsParty=ownedSet.size===party.size&&[...ownedSet].every(o=>party.has(o));
   const mapFog=after.map.mapFogEnabled?new Set(after.map.mapFogRevealed):null;
   const tokenFog=after.map.tokenFogEnabled?new Set(after.map.tokenFogRevealed):null;
   const grid=after.map.gridSizePx??50;
   const partyVision=after.map.sharedPartyVision!==false&&!sameAsParty&&party.size>0
    ?createPlayerVision(after.map,[...current.values()],party,t=>tokenVisibleAt({role:'player',hidden:t.isHidden,owned:t.kind==='pc',foe:t.kind==='monster'&&monById.get(t.refId)?.disposition!=='friendly',mapFog,tokenFog,grid,x:t.x,y:t.y}))
    :undefined;
   for(const {live,route} of departing){
    const exit=clipDepartingMove({after,live,route,stayingMoves,monById,charById,partyVision,ownedPcs,mapFog,tokenFog,sameAsParty});
    if(!exit)continue;
    moves[live.id]={from:route.from,to:exit};routes.push(route);
   }
  }
 }
 if(!routes.length)return;
 const moveKey=Object.entries(moves).sort(([a],[b])=>a.localeCompare(b)).map(([tid,m])=>`${tid}:${m.from.x},${m.from.y}->${m.to.x},${m.to.y}`).join('|');
 const coalesceKey=JSON.stringify([renderingLayerKey(before),renderingLayerKey(after),routes.map(r=>`${r.id}:${r.generation}`),moveKey,options?.compact===true,options?.membershipOnly===true]);
 const existing=motionCache.get(coalesceKey);
 if(existing){
  const shared=await existing;
  if(shared&&grantMotionAssets(id,shared)){
   motionCache.delete(coalesceKey);motionCache.set(coalesceKey,existing);
   return shared;
  }
  motionCache.delete(coalesceKey);
 }
 const work=(async():Promise<LegacyMotion|undefined>=>{
  const liveTokens=current??new Map(listTokens(after.map!.id).map(t=>[t.id,t]));
  const first={...before,tokens:before.tokens.filter(t=>liveTokens.has(t.id)&&(after.role==='dm'||!liveTokens.get(t.id)!.isHidden)).map(t=>moves[t.id]?{...t,facing:liveTokens.get(t.id)!.facing}:t),partyView:undefined,legacyMotion:undefined};
  const rawViews:StateSnapshot[]=[];
  // Exploration changes only at the route's halfway and final poses. Reuse
  // these unions rather than clipping the same remembered terrain 13 times.
  const remembered=unionTerrain([before.exploredTerrain??[]]);
  const personalIds=new Set((after.playerVision?.origins??[]).flatMap(o=>{const t=liveTokens.get(o.id);return t?.kind==='pc'?[t.refId]:[];}));
  const halfway=unionTerrain([before.exploredTerrain??[],...routes.flatMap(r=>after.map?.sharedPartyVision===false?Object.entries(r.halfByCharacter??{}).filter(([id])=>personalIds.has(id)).map(([,shape])=>shape):r.half?[r.half]:[])]);
  if(!after.playerVision){
   for(let index=0;index<=LEGACY_MOTION_STEPS;index++){
    if(options?.current&&!options.current())return;
    const at=index/LEGACY_MOTION_STEPS,t=tokenMoveProgress(at,1);
    const base=index===0?first:index===LEGACY_MOTION_STEPS?after:{...after,tokens:after.tokens.map(tok=>{const p=moves[tok.id];return p?{...tok,x:p.from.x+(p.to.x-p.from.x)*t,y:p.from.y+(p.to.y-p.from.y)*t}:tok;})};
    rawViews.push({...after,...base,partyView:undefined,legacyMotion:undefined});
   }
  }else if(routes.some(r=>r.crossedWall)){
   for(let index=0;index<=LEGACY_MOTION_STEPS;index++){
    if(options?.current&&!options.current())return;
    const t=tokenMoveProgress(index/LEGACY_MOTION_STEPS,1);
    rawViews.push(t<.5?{...after,...first,partyView:undefined,legacyMotion:undefined,exploredTerrain:remembered}:{...after,partyView:undefined,legacyMotion:undefined,exploredTerrain:after.exploredTerrain});
   }
  }else{
   const originIds=new Set(after.playerVision?.origins.map(o=>o.id));
   const ownedIds=[...liveTokens.values()].filter(t=>originIds.has(t.id)).map(t=>t.refId).sort();
   const routeKey=`${routes.map(r=>`${r.id}:${r.generation}`).join('|')}|${moveKey}`;
   const cacheKey=JSON.stringify([after.map,after.role,ownedIds,routeKey,after.tokens,after.monsters,before.exploredTerrain??[],after.exploredTerrain??[]]);
   let intermediates=intermediateCache.get(cacheKey);
   if(!intermediates){
    const positions=new Map<string,{x:number;y:number}>();
    const build=createSnapshotBuilder(after.map!.sessionId,{positions,owned:new Set(ownedIds)});
    const built:StateSnapshot[]=[];
    for(let index=1;index<LEGACY_MOTION_STEPS;index++){
     if(options?.current&&!options.current())return;
     const at=index/LEGACY_MOTION_STEPS,t=tokenMoveProgress(at,1);
     positions.clear();for(const [tid,p] of Object.entries(moves))positions.set(tid,{x:p.from.x+(p.to.x-p.from.x)*t,y:p.from.y+(p.to.y-p.from.y)*t});
     const authorized=build?.(after.role,after.map!.id,id);
     if(!authorized||authorized.map?.id!==after.map!.id)return;
     built.push({...authorized,exploredTerrain:t>=.5?halfway:remembered});
    }
    intermediates=built;
    if(intermediateCache.size>=16)intermediateCache.delete(intermediateCache.keys().next().value!);
    intermediateCache.set(cacheKey,intermediates);
   }
   rawViews.push({...after,...first,partyView:undefined,legacyMotion:undefined,exploredTerrain:remembered});
   for(const step of intermediates)rawViews.push({...after,...step,partyView:undefined,legacyMotion:undefined});
   rawViews.push({...after,partyView:undefined,legacyMotion:undefined,exploredTerrain:after.exploredTerrain});
  }
  // Standard rendering and unassisted Legacy need authorized creature membership,
  // but render their own continuously moving sight. Do not rasterize these poses.
  const pxPerFoot=after.map!.gridSizePx/Math.max(.001,after.map!.feetPerSquare);
  const maxDistancePx=Math.max(0,...Object.values(moves).map(m=>Math.hypot(m.to.x-m.from.x,m.to.y-m.from.y)));
  const durationMs=tokenMoveDuration(maxDistancePx,pxPerFoot);
  if(options?.membershipOnly){
   const endpoint=options.endpoint?await options.endpoint():after;
   return {membershipOnly:true,id:routes.map(r=>r.id).join(':'),durationMs,moves,
    frames:rawViews.map((view,index)=>{const frame=fields(view,index/LEGACY_MOTION_STEPS,endpoint,moves);
     return {...frame,tokenSprites:undefined,legacyGeometry:undefined,visionRaster:undefined,visionTiles:undefined};})};
  }
  const hasFullGeometry=(s:StateSnapshot)=>!!s.legacyGeometry&&!s.visionRaster&&!s.visionTiles&&(!needsVisibilityLayer(s.map,s.playerVision)||s.legacyGeometry.sight.length>0||s.legacyGeometry.near.length>0||s.legacyGeometry.lights.length>0||(s.legacyGeometry.memory?.length??0)>0);
  const rememberedMemory=after.playerVision?formatMemory(remembered):[];
  const halfwayMemory=after.playerVision?formatMemory(halfway):[];
  const stepGeomByVision=new Map<string,Promise<{sight:string[];near:string[];lights:string[]}>>();
  const prepared=await Promise.all(rawViews.map(async(view,index)=>{
   if(options?.current&&!options.current())return view;
   const t=tokenMoveProgress(index/LEGACY_MOTION_STEPS,1);
   if(index===LEGACY_MOTION_STEPS&&hasFullGeometry(after))view.legacyGeometry=after.legacyGeometry;
   else if(index===0&&hasFullGeometry(before)&&first.tokens.length===before.tokens.length)view.legacyGeometry=before.legacyGeometry;
   else if(view.playerVision&&needsVisibilityLayer(view.map,view.playerVision)){
    if(hasFullGeometry(after)&&equal(view.playerVision,after.playerVision)){
     view.legacyGeometry={sight:after.legacyGeometry!.sight,near:after.legacyGeometry!.near,lights:after.legacyGeometry!.lights,memory:t>=.5?halfwayMemory:rememberedMemory,affinity:view.tokens.filter(tok=>!tok.sharedSightOnly&&!tok.partiallyRevealed&&visionShowsAffinity(view.playerVision,tok.x,tok.y,tokenRadiusPx(tok,view.map))).map(tok=>tok.id)};
    }else{
     if(hasFullGeometry(before)&&equal(view.playerVision,before.playerVision)){
      view.legacyGeometry={sight:before.legacyGeometry!.sight,near:before.legacyGeometry!.near,lights:before.legacyGeometry!.lights,memory:t>=.5?halfwayMemory:rememberedMemory,affinity:view.tokens.filter(tok=>!tok.sharedSightOnly&&!tok.partiallyRevealed&&visionShowsAffinity(view.playerVision,tok.x,tok.y,tokenRadiusPx(tok,view.map))).map(tok=>tok.id)};
     }else{
      const vKey=JSON.stringify(view.playerVision);
      let geomPromise=stepGeomByVision.get(vKey);
      if(!geomPromise){
       geomPromise=visibilityWorkers.run({mapId:view.map!.id,vision:view.playerVision,wallFog:usesMapVision(view.map),tokens:[]},timing?span=>timing.workers.push(span):undefined);
       stepGeomByVision.set(vKey,geomPromise);
      }
      const geom=await geomPromise;
      view.legacyGeometry={...geom,memory:index===LEGACY_MOTION_STEPS?formatMemory(after.exploredTerrain):t>=.5?halfwayMemory:rememberedMemory,affinity:view.tokens.filter(tok=>!tok.sharedSightOnly&&!tok.partiallyRevealed&&visionShowsAffinity(view.playerVision,tok.x,tok.y,tokenRadiusPx(tok,view.map))).map(tok=>tok.id)};
     }
    }
   }
   else view.legacyGeometry={sight:[],near:[],lights:[],memory:[],affinity:view.tokens.filter(t=>!t.sharedSightOnly&&!t.partiallyRevealed).map(t=>t.id)};
   return view;
  }));
  if(options?.current&&!options.current())return;
  const endById=options?.endpoint?new Map(after.tokens.map(t=>[t.id,t])):undefined;
  const endAffinity=options?.endpoint&&after.legacyGeometry?new Set(after.legacyGeometry.affinity):undefined;
  const endMonsters=options?.endpoint?new Map(after.monsters.map(m=>[m.id,m])):undefined;
  const [images]=await Promise.all([
   process.env.SERVER_RASTER_VISION==='1'&&needsVisibilityLayer(after.map,after.playerVision)?legacyTerrainFrames(id,prepared,true,timing,options?.compact===true):undefined,
   Promise.all(prepared.map(async(view,index)=>{
    if(!view.playerVision||(options?.current&&!options.current()))return;
    if(endById&&endAffinity&&endMonsters){
     if(index===LEGACY_MOTION_STEPS){view.tokenSprites={};return;}
     const viewAffinity=new Set(view.legacyGeometry?.affinity??[]);
     const viewMonsters=new Map(view.monsters.map(m=>[m.id,m]));
     const changedTokens=view.tokens.filter(t=>{
      const endTok=endById.get(t.id);if(!endTok)return true;
      if(!!t.sharedSightOnly!==!!endTok.sharedSightOnly||!!t.partiallyRevealed!==!!endTok.partiallyRevealed||viewAffinity.has(t.id)!==endAffinity.has(t.id))return true;
      if(!equal(moves[t.id]?{...t,...moves[t.id].to,facing:endTok.facing}:t,endTok))return true;
      return t.kind==='monster'&&!equal(viewMonsters.get(t.refId),endMonsters.get(t.refId));
     });
     view.tokenSprites=changedTokens.length?await tokenSprites(id,{...view,tokens:changedTokens},true):{};
    }else{
     view.tokenSprites=await tokenSprites(id,view,true);
    }
   })),
  ]);
  if(options?.current&&!options.current())return;
  const endpoint=options?.endpoint?await options.endpoint():after;
  const output:LegacyMotionFrame[]=[];
  for(let index=0;index<prepared.length;index++)output.push(fields(prepared[index],index/LEGACY_MOTION_STEPS,endpoint,moves));
  // Atlas frames are one decoded image each for cover and graded artwork.
  // Geometry paths remain available only on maps without raster artwork.
  if(images?.atlas)for(const frame of output){frame.visionRaster=undefined;frame.visionTiles=undefined;frame.legacyGeometry={sight:[],near:[],lights:[],memory:[],affinity:frame.legacyGeometry?.affinity??[]};}
  return {id:routes.map(r=>r.id).join(':'),durationMs,moves,frames:output,atlas:images?.atlas};
 })();
 if(motionCache.size>=16)motionCache.delete(motionCache.keys().next().value!);
 motionCache.set(coalesceKey,work);
 work.then(res=>{if(!res&&motionCache.get(coalesceKey)===work)motionCache.delete(coalesceKey);}).catch(()=>{if(motionCache.get(coalesceKey)===work)motionCache.delete(coalesceKey);});
 return work;
}
