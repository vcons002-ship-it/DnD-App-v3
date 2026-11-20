import {forwardRef,useEffect,useId,useImperativeHandle,useLayoutEffect,useRef} from 'react';
import type {VisionLight,PlayerVision} from '../../../shared/playerVision';
import {lightBeamOutline,type LightBeam} from '../../../shared/lightFalloff';
import {groundYScale,groundPerspectiveCss,perspectiveSlope,type BattlefieldView} from './miniatureProjection';
import type {ExploredTerrain} from '../../../shared/exploration';
import {wallVisibilityPolygon,SIGHT_EXTENT,type WallPoint} from '../../../shared/mapWalls';
import type {TokenPresentation} from './tokenPresentation';
import type {MapEnvironment} from '../../../shared/mapEnvironment';
import type {VisionCoverFrame} from './miniatureVisionComposite';
import {createVisionLightProjector} from './visionLightEllipse';
import {createVisionLightMask} from './visionLightMask';
import {exploredTerrainBrightness,HEAVY_DARKVISION_DESATURATION,REGULAR_DARKVISION_DESATURATION} from '../../../shared/terrainLighting';
import type {LegacyGeometry} from '../../../shared/legacyVision';
type Camera={view:BattlefieldView;tilt:number;rotation:number;width:number;height:number};
const circleVertices=Array.from({length:96},(_,i)=>({x:Math.cos(i*Math.PI/48),y:Math.sin(i*Math.PI/48)}));
const stabilizeLight=(l:VisionLight):VisionLight=>{
 if(l.transient)return l;
 const radius=(l as {nominalRadius?:number}).nominalRadius??l.radius;
 const strength=(l as {nominalStrength?:number}).nominalStrength??l.strength;
 return radius===l.radius&&strength===l.strength?l:{...l,radius,strength};
};
const sameLight=(a:VisionLight,b:VisionLight)=>a.id===b.id&&a.x===b.x&&a.y===b.y&&a.radius===b.radius&&a.height===b.height&&a.strength===b.strength&&!!a.transient===!!b.transient&&a.beam?.ax===b.beam?.ax&&a.beam?.ay===b.beam?.ay&&a.beam?.bx===b.beam?.bx&&a.beam?.by===b.beam?.by;
const sameLights=(a:readonly VisionLight[],b:readonly VisionLight[])=>a.length===b.length&&a.every((l,i)=>sameLight(l,b[i]));
export type PlayerVisionHandle={cover:()=>VisionCoverFrame|undefined;memoryCanvas:()=>HTMLCanvasElement|null;frame:(now?:number)=>void;prepareLights:(lights:VisionLight[])=>void;lights:(lights:VisionLight[])=>void;camera:(c:Partial<Camera>)=>void;move:(id:string,x:number,y:number)=>void};
/** Terrain visibility stays below lifted miniature pixels. The GPU path keeps
 * artwork grading below figures and grades their full silhouette at the base.
 * Never disabled by effect quality. */
type TerrainTile={url:string;x:number;y:number;w:number;h:number};
type MemoryTerrain={environment?:MapEnvironment;explored?:ExploredTerrain;tiles:TerrainTile[];bounds:{x:number;y:number;w:number;h:number};grid?:{size:number;x:number;y:number}};
let projCap=64,clipCap=128;
let projX=new Float64Array(projCap),projY=new Float64Array(projCap),projW=new Float64Array(projCap);
let clipX=new Float64Array(clipCap),clipY=new Float64Array(clipCap),clipW=new Float64Array(clipCap);
const ensureProjScratch=(len:number)=>{if(len>projCap){projCap=Math.max(len,projCap*2);projX=new Float64Array(projCap);projY=new Float64Array(projCap);projW=new Float64Array(projCap);}};
const ensureClipScratch=(len:number)=>{if(len>clipCap){clipCap=Math.max(len,clipCap*2);clipX=new Float64Array(clipCap);clipY=new Float64Array(clipCap);clipW=new Float64Array(clipCap);}};
const r1=(n:number)=>Math.round(n*10)/10;
export const PlayerVisionOverlay=forwardRef<PlayerVisionHandle,Camera&{vision:PlayerVision;serverGeometry?:LegacyGeometry|null;spellLighting?:boolean;mapFogOfWar?:boolean;keepRevealed?:boolean;terrain?:MemoryTerrain;presentation?:TokenPresentation}>(function PlayerVisionOverlay(props,ref){
 const shade=useRef<HTMLDivElement>(null);
 const nearShade=useRef<HTMLDivElement>(null),nearPaths=useRef<SVGGElement>(null);
 const root=useRef<HTMLDivElement>(null);
 const lightPaths=useRef<SVGGElement>(null),originPaths=useRef<SVGGElement>(null);
 const spellPaths=useRef<SVGGElement>(null);
 const sightPaths=useRef<SVGClipPathElement>(null),lightClips=useRef<SVGGElement>(null);
 const memoryPaths=useRef<SVGClipPathElement>(null),memoryPlane=useRef<HTMLDivElement>(null),memoryMap=useRef<HTMLDivElement>(null);
 const memoryCanvas=useRef<HTMLCanvasElement>(null);
 const retainedRange=useRef<SVGGElement>(null);
 const memoryProjection=useRef<{geometry:ExploredTerrain|undefined;camera:string}|null>(null);
 const exploredRingsCache=useRef(new WeakMap<ExploredTerrain,WallPoint[][][]>());
 const wallsCache=useRef<{walls:PlayerVision['walls'];key:string}>({walls:undefined,key:'[]'});
 const polygonCache=useRef(new Map<string,{key:string;points:WallPoint[]}>());
 const projectedPolygons=useRef(new WeakMap<WallPoint[],{camera:string;path:string}>());
 const worldPolygons=useRef(new WeakMap<WallPoint[],string>());
 const circlePaths=useRef(new Map<string,{key:string;path:string}>());
 const worldCirclePaths=useRef(new Map<string,{key:string;path:string}>());
 const id=useId().replace(/:/g,'');
 const lightId=`vision-lights-${id}`,shadeId=`vision-shade-${id}`,nearId=`vision-near-${id}`,coverId=`vision-cover-${id}`;
 const flashId=`vision-visible-flash-${id}`;
 const sightId=`vision-sight-${id}`;
 const memoryId=`vision-memory-${id}`,rangeId=`vision-retained-range-${id}`;
 useLayoutEffect(()=>{
  const parent=root.current?.parentElement;
  parent?.style.setProperty('--player-vision-cover',props.mapFogOfWar===false&&!props.vision.heavy?'none':`url(#${coverId})`);
  parent?.style.setProperty('--spell-vision-visible',props.mapFogOfWar===false&&!props.vision.heavy?'none':`url(#${flashId})`);
  return ()=>{parent?.style.removeProperty('--spell-vision-visible');parent?.style.removeProperty('--player-vision-cover');};
 },[coverId,props.mapFogOfWar,props.vision.heavy]);
 const state=useRef(props),latestProps=useRef(props),syncedProps=useRef<typeof props|null>(null);latestProps.current=props;const live=useRef(new Map<string,{x:number;y:number}>());
 const propCamera=useRef({view:props.view,tilt:props.tilt,rotation:props.rotation});
 const renderedLights=useRef<VisionLight[]|null>(null);
 const pendingDraw=useRef(0),fullDraw=useRef(true),lastBaseLightDraw=useRef(0);
 const lastBaseDraw=useRef<{key:string;geometry:ExploredTerrain|undefined;memory:HTMLCanvasElement|null}|null>(null),lastWorldDraw=useRef<{key:string;geometry:ExploredTerrain|undefined;memory:HTMLCanvasElement|null}|null>(null);
 const svgSyncedKey=useRef(''),svgSyncedWorldKey=useRef('');
 const ordinaryMask=useRef<ReturnType<typeof createVisionLightMask>>(),spellMask=useRef<ReturnType<typeof createVisionLightMask>>();
 const prepareProjection=useRef<Parameters<ReturnType<typeof createVisionLightMask>['prepare']>[1]>();
 const drawCount=useRef(0),baseDrawCount=useRef(0);
 const coverFrame=useRef<VisionCoverFrame>();
 const domCache=useRef<{rot?:string;tilt?:string;shape?:boolean;filter?:string;nearDisplay?:string;nearFilter?:string}>({});
 const SVG_NS='http://www.w3.org/2000/svg';
 const syncPaths=(container:SVGElement|null,items:readonly {d:string;fill?:string;clipRule?:string}[])=>{
  if(!container)return;
  while(container.children.length>items.length)container.lastElementChild?.remove();
  for(let i=0;i<items.length;i++){
   const item=items[i];
   let el=container.children[i] as SVGElement|undefined;
   if(!el||el.tagName.toLowerCase()!=='path'){
    const pathEl=document.createElementNS(SVG_NS,'path');
    if(el)container.replaceChild(pathEl,el);else container.appendChild(pathEl);
    el=pathEl;
   }
   if(el.getAttribute('d')!==item.d)el.setAttribute('d',item.d);
   if(item.fill!==undefined){if(el.getAttribute('fill')!==item.fill)el.setAttribute('fill',item.fill);}
   else if(el.hasAttribute('fill'))el.removeAttribute('fill');
   if(item.clipRule!==undefined){if(el.getAttribute('clip-rule')!==item.clipRule)el.setAttribute('clip-rule',item.clipRule);}
   else if(el.hasAttribute('clip-rule'))el.removeAttribute('clip-rule');
  }
 };
 const syncCoverRect=(container:SVGElement|null,w:number,h:number)=>{
  if(!container)return;
  while(container.children.length>1)container.lastElementChild?.remove();
  let rect=container.firstElementChild as SVGElement|null;
  if(!rect||rect.tagName.toLowerCase()!=='rect'){
   rect=document.createElementNS(SVG_NS,'rect');
   if(container.firstElementChild)container.replaceChild(rect,container.firstElementChild);else container.appendChild(rect);
  }
  const sw=String(w),sh=String(h);
  if(rect.getAttribute('width')!==sw)rect.setAttribute('width',sw);
  if(rect.getAttribute('height')!==sh)rect.setAttribute('height',sh);
  if(rect.getAttribute('fill')!=='white')rect.setAttribute('fill','white');
 };
 const draw=()=>{
  const began=performance.now();
  if(!shade.current||!lightPaths.current||!originPaths.current||!sightPaths.current||!lightClips.current)return;
  const {vision,view,tilt,rotation,width,height}=state.current;
  if(root.current){
   const rStr=String(rotation),tStr=String(tilt);
   if(domCache.current.rot!==rStr){root.current.dataset.cameraRotation=rStr;domCache.current.rot=rStr;}
   if(domCache.current.tilt!==tStr){root.current.dataset.cameraTilt=tStr;domCache.current.tilt=tStr;}
  }
  const sy=groundYScale(tilt),a=rotation*Math.PI/180,c=Math.cos(a),s=Math.sin(a),k=perspectiveSlope(width,height,tilt);
  const orthoUnrotated=k===0&&s===0&&c===1&&sy===1;
  const projectionKey=[view.x,view.y,view.scale,tilt,rotation,width,height].join(':');
  const lightEllipse=createVisionLightProjector(view,tilt,rotation,width,height);
  if(wallsCache.current.walls!==vision.walls)wallsCache.current={walls:vision.walls,key:JSON.stringify(vision.walls??[])};
  const wallsKey=wallsCache.current.key;
  const activeKeys=new Set<string>();
  const polygon=(point:{id:string;x:number;y:number},radius:number)=>{
   const slot=point.id+':'+radius;activeKeys.add(slot);
   const key=`${point.x},${point.y}:${wallsKey}`;
   const cached=polygonCache.current.get(slot);
   if(cached?.key===key)return cached.points;
   const supplied=state.current.serverGeometry?.outlines,ready=supplied?.shapes[slot];
   // Static light clips and accepted sight origins arrive prepared by the server.
   // Intermediate animation positions retain the existing smooth projection.
   const points=supplied?.wallsKey===wallsKey&&ready?.x===point.x&&ready?.y===point.y?ready.points:wallVisibilityPolygon(point,vision.walls??[],radius);
   polygonCache.current.set(slot,{key,points});return points;
  };
  const project=(vertices:WallPoint[])=>{
   const cached=projectedPolygons.current.get(vertices);
   if(cached?.camera===projectionKey)return cached.path;
   const n=vertices.length;
   if(!n){projectedPolygons.current.set(vertices,{camera:projectionKey,path:''});return '';}
   if(orthoUnrotated){
    let result='M'+r1(view.x+vertices[0].x*view.scale)+','+r1(view.y+vertices[0].y*view.scale);
    for(let i=1;i<n;i++){
     const v=vertices[i];
     result+='L'+r1(view.x+v.x*view.scale)+','+r1(view.y+v.y*view.scale);
    }
    result+='Z';
    projectedPolygons.current.set(vertices,{camera:projectionKey,path:result});
    return result;
   }
   ensureProjScratch(n);ensureClipScratch(n*2);
   const hw=width/2,hh=height/2,scaleY=view.scale*sy;
   for(let i=0;i<n;i++){
    const vertex=vertices[i];
    const dx=view.x+vertex.x*view.scale-hw;
    const dy=view.y+vertex.y*scaleY-hh;
    const x=c*dx-s*dy/sy,y=s*dx*sy+c*dy;
    projX[i]=x;projY[i]=y;projW[i]=1-y*k;
   }
   // Clip behind-camera vertices before perspective division, including deep zoom.
   let m=0;
   for(let i=0;i<n;i++){
    const j=(i+1)%n;
    const px=projX[i],py=projY[i],pw=projW[i],qx=projX[j],qy=projY[j],qw=projW[j];
    const pin=pw>=.01,qin=qw>=.01;
    if(pin){clipX[m]=px;clipY[m]=py;clipW[m]=pw;m++;}
    if(pin!==qin){
     const t=(.01-pw)/(qw-pw);
     clipX[m]=px+(qx-px)*t;clipY[m]=py+(qy-py)*t;clipW[m]=.01;m++;
    }
   }
   let result='';
   if(m){
    result='M'+r1(hw+clipX[0]/clipW[0])+','+r1(hh+clipY[0]/clipW[0]);
    for(let i=1;i<m;i++)result+='L'+r1(hw+clipX[i]/clipW[i])+','+r1(hh+clipY[i]/clipW[i]);
    result+='Z';
   }
   projectedPolygons.current.set(vertices,{camera:projectionKey,path:result});return result;
  };
  const worldProject=(vertices:WallPoint[])=>{
   const cached=worldPolygons.current.get(vertices);
   if(cached!==undefined)return cached;
   if(!vertices.length){worldPolygons.current.set(vertices,'');return '';}
   let result='M'+r1(vertices[0].x)+','+r1(vertices[0].y);
   for(let i=1;i<vertices.length;i++){
    const v=vertices[i];
    result+='L'+r1(v.x)+','+r1(v.y);
   }
   result+='Z';
   worldPolygons.current.set(vertices,result);
   return result;
  };
  const livePoint=(p:{id:string;x:number;y:number})=>state.current.presentation?.position(p.id)??live.current.get(p.id)??p;
  const path=(point:{id:string;x:number;y:number;beam?:LightBeam},radius:number,actual=false,occlude=false)=>{
   const p=actual?point:livePoint(point);
   if(occlude)return project(polygon({...p,id:point.id},radius));
   const slot=point.id+':'+radius,key=[projectionKey,p.x,p.y,point.beam?`${point.beam.ax},${point.beam.ay},${point.beam.bx},${point.beam.by}`:''].join(':');activeKeys.add('circle:'+slot);
   const cached=circlePaths.current.get(slot);if(cached?.key===key)return cached.path;
   const result=project(point.beam?lightBeamOutline(point.beam,radius):circleVertices.map(v=>({x:p.x+v.x*radius,y:p.y+v.y*radius})));
   circlePaths.current.set(slot,{key,path:result});return result;
  };
  const worldPath=(point:{id:string;x:number;y:number;beam?:LightBeam},radius:number,actual=false,occlude=false)=>{
   const p=actual?point:livePoint(point);
   if(occlude)return worldProject(polygon({...p,id:point.id},radius));
   const slot=point.id+':'+radius,key=[p.x,p.y,point.beam?`${point.beam.ax},${point.beam.ay},${point.beam.bx},${point.beam.by}`:''].join(':');activeKeys.add('wcircle:'+slot);
   const cached=worldCirclePaths.current.get(slot);if(cached?.key===key)return cached.path;
   const result=worldProject(point.beam?lightBeamOutline(point.beam,radius):circleVertices.map(v=>({x:p.x+v.x*radius,y:p.y+v.y*radius})));
   worldCirclePaths.current.set(slot,{key,path:result});return result;
  };
  const worldTransform=`translate(${view.x} ${view.y}) scale(${view.scale})`;
  const setWorldTransform=(node:SVGElement|null,enabled:boolean)=>{
   if(!node)return;
   if(enabled){
    if(node.getAttribute('transform')!==worldTransform)node.setAttribute('transform',worldTransform);
   }else if(node.hasAttribute('transform')){
    node.removeAttribute('transform');
   }
  };
  const sourceLights=renderedLights.current??vision.lights;
  const positioned=(l:VisionLight)=>l.transient?l:stabilizeLight({...l,...livePoint(l)});
  // Separate retained nodes keep spell flashes from rebuilding sight, history,
  // ordinary attenuation bands, or the GPU terrain cover on every frame.
  ordinaryMask.current??=createVisionLightMask(lightPaths.current,lightClips.current,`vision-lamp-${id}`);
  if(spellPaths.current)spellMask.current??=createVisionLightMask(spellPaths.current,lightClips.current,`vision-spell-${id}`);
  setWorldTransform(lightPaths.current,orthoUnrotated);
  setWorldTransform(spellPaths.current,orthoUnrotated);
  const worldEllipse=(cx:number,cy:number,r:number)=>({cx,cy,rx:r,ry:r,rotation:0});
  const projectPoint=(x:number,y:number):{x:number;y:number}|undefined=>{
   if(orthoUnrotated)return {x,y};
   const dx=view.x+x*view.scale-width/2,dy=view.y+y*view.scale*sy-height/2;
   const px=c*dx-s*dy/sy,py=s*dx*sy+c*dy,w=1-py*k;
   return w>=.01?{x:width/2+px/w,y:height/2+py/w}:undefined;
  };
  const projection=orthoUnrotated
   ?{key:'world',wallsKey,occluded:!!vision.walls?.length,ellipse:worldEllipse,point:projectPoint,
     circle:(l:VisionLight,r:number)=>worldPath(l,r,true),clip:(l:VisionLight)=>worldPath(l,SIGHT_EXTENT,true,true)}
   :{key:projectionKey,wallsKey,occluded:!!vision.walls?.length,ellipse:lightEllipse,point:projectPoint,
     circle:(l:VisionLight,r:number)=>path(l,r,true),clip:(l:VisionLight)=>path(l,SIGHT_EXTENT,true,true)};
  prepareProjection.current=projection;
  const gpuFull=root.current?.parentElement?.dataset.gpuVisionFull==='true';
  const spellLights=sourceLights.filter(l=>l.transient&&state.current.spellLighting!==false);
  if(!gpuFull&&(spellLights.length||(spellMask.current?.stats.lights??0)>0))spellMask.current?.sync(spellLights.map(positioned),projection);
  const finish=()=>{if(root.current){
   root.current.dataset.visionCpuMs=(performance.now()-began).toFixed(2);
   root.current.dataset.visionDrawCount=String(++drawCount.current);
   root.current.dataset.visionBaseDrawCount=String(baseDrawCount.current);
   if(!domCache.current.shape){root.current.dataset.lightBandShape='ellipse';root.current.dataset.lightBandReuse='retained';domCache.current.shape=true;}
  }};
  if(!fullDraw.current){finish();return;}
  fullDraw.current=false;
  const geometry=state.current.presentation?state.current.presentation.explored():state.current.terrain?.explored,camera=projectionKey;
  const wallFog=state.current.mapFogOfWar!==false;
  const ordinaryLights=sourceLights.filter(l=>!l.transient).map(positioned);
  const worldKey=[
   wallsKey,vision.heavy,!!vision.daylight,vision.radius,wallFog,!!state.current.keepRevealed,
   state.current.serverGeometry?.outlines?.wallsKey??'',
   vision.origins.map(o=>{const p=livePoint(o);return `${o.id}:${p.x},${p.y}`;}).join('|'),
   ordinaryLights.map(l=>`${l.id}:${l.x},${l.y},${l.radius},${l.height},${l.strength},${l.beam?`${l.beam.ax},${l.beam.ay},${l.beam.bx},${l.beam.by}`:''}`).join('|'),
  ].join('~'),baseKey=`${projectionKey}~${worldKey}`;
  if(coverFrame.current&&lastBaseDraw.current?.key===baseKey&&lastBaseDraw.current.geometry===geometry&&lastBaseDraw.current.memory===memoryCanvas.current&&(gpuFull||svgSyncedKey.current===baseKey)){
   finish();return;
  }
  lastBaseDraw.current={key:baseKey,geometry,memory:memoryCanvas.current};
  lastBaseLightDraw.current=began;baseDrawCount.current++;
  const originPolygon=(o:{id:string;x:number;y:number},radius:number)=>{
   const p=livePoint(o);
   return wallFog?polygon({...p,id:o.id},radius):circleVertices.map(v=>({x:p.x+v.x*radius,y:p.y+v.y*radius}));
  };
  if(gpuFull){
   if(!coverFrame.current||lastWorldDraw.current?.key!==worldKey||lastWorldDraw.current.geometry!==geometry||lastWorldDraw.current.memory!==memoryCanvas.current){
    lastWorldDraw.current={key:worldKey,geometry,memory:memoryCanvas.current};
    coverFrame.current={enabled:wallFog||vision.heavy,
     grade:{heavy:vision.heavy,daylight:!!vision.daylight,near:!vision.daylight&&!vision.heavy?vision.origins.map(o=>originPolygon(o,vision.radius)):[]},
     explored:geometry??[],memory:memoryCanvas.current,keepRevealed:!!state.current.keepRevealed,
     memoryRange:undefined,
     origins:vision.origins.map(o=>originPolygon(o,vision.heavy?vision.radius:SIGHT_EXTENT)),
     sight:vision.origins.map(o=>originPolygon(o,SIGHT_EXTENT)),
     lights:ordinaryLights.map(source=>({source,polygon:polygon(source,SIGHT_EXTENT)}))};
    for(const slot of polygonCache.current.keys())if(!activeKeys.has(slot))polygonCache.current.delete(slot);
   }
   if(svgSyncedWorldKey.current!==worldKey){
    svgSyncedWorldKey.current=worldKey;
    if(originPaths.current.hasAttribute('transform'))originPaths.current.removeAttribute('transform');
    syncPaths(originPaths.current,vision.origins.map(o=>({d:worldPath(o,vision.heavy?vision.radius:SIGHT_EXTENT,false,wallFog&&!!vision.walls?.length),fill:'black'})));
   }
   finish();return;
  }
  // Reproject remembered terrain only when history or camera changes, never for
  // every light flicker. It contains map images/grid only, not a live scene copy.
  if(memoryPaths.current&&(memoryProjection.current?.geometry!==geometry||memoryProjection.current?.camera!==camera)){
   let rings:WallPoint[][][]= [];
   if(geometry?.length){
    let cachedRings=exploredRingsCache.current.get(geometry);
    if(!cachedRings){
     cachedRings=geometry.map(p=>p.map(r=>r.map(([x,y])=>({x,y}))));
     exploredRingsCache.current.set(geometry,cachedRings);
    }
    rings=cachedRings;
   }
   syncPaths(memoryPaths.current,rings.map(p=>({d:p.map(r=>project(r)).join(''),clipRule:'evenodd'})));
   memoryProjection.current={geometry,camera};
   if(memoryPlane.current)memoryPlane.current.style.transform=groundPerspectiveCss(width,height,tilt,rotation);
   if(memoryMap.current)memoryMap.current.style.transform=`translate(${view.x}px,${view.y}px) scale(${view.scale},${view.scale*sy})`;
  }
  const sightD=vision.origins.map(o=>path(o,SIGHT_EXTENT,false,wallFog));
  syncPaths(sightPaths.current,sightD.map(d=>({d})));
  setWorldTransform(originPaths.current,orthoUnrotated);
  const circleItems=vision.origins.map((o,i)=>{
   const useSight=!vision.heavy&&(wallFog&&!!vision.walls?.length===wallFog);
   const d=orthoUnrotated
    ?(useSight?worldPath(o,SIGHT_EXTENT,false,wallFog):worldPath(o,vision.heavy?vision.radius:SIGHT_EXTENT,false,wallFog&&!!vision.walls?.length))
    :(useSight?sightD[i]:path(o,vision.heavy?vision.radius:SIGHT_EXTENT,false,wallFog&&!!vision.walls?.length));
   return {d,fill:'black'};
  });
  setWorldTransform(nearPaths.current,orthoUnrotated);
  syncPaths(nearPaths.current,!vision.daylight&&!vision.heavy?vision.origins.map(o=>({d:orthoUnrotated?worldPath(o,vision.radius,false,wallFog):path(o,vision.radius,false,wallFog)})):[]);
  // Ordinary lanterns keep steady nominal vision geometry while the 3D renderer
  // and cosmetic spell-light bands animate independently.
  ordinaryMask.current.sync(ordinaryLights,projection);
  // Keep the SVG mask in the DOM and share light geometry between both masks.
  // Encoding/decoding two large SVG image URLs per frame caused mobile stalls.
  syncPaths(originPaths.current,circleItems);
  setWorldTransform(retainedRange.current,orthoUnrotated&&vision.heavy);
  if(vision.heavy)syncPaths(retainedRange.current,vision.origins.map(o=>({d:orthoUnrotated?worldPath(o,vision.radius):path(o,vision.radius),fill:'white'})));
  else syncCoverRect(retainedRange.current,width,height);
  if(svgSyncedWorldKey.current!==worldKey)svgSyncedWorldKey.current=worldKey;
  svgSyncedKey.current=baseKey;
  if(!coverFrame.current||lastWorldDraw.current?.key!==worldKey||lastWorldDraw.current.geometry!==geometry||lastWorldDraw.current.memory!==memoryCanvas.current){lastWorldDraw.current={key:worldKey,geometry,memory:memoryCanvas.current};coverFrame.current={enabled:wallFog||vision.heavy,
   grade:{heavy:vision.heavy,daylight:!!vision.daylight,near:!vision.daylight&&!vision.heavy?vision.origins.map(o=>originPolygon(o,vision.radius)):[]},
   explored:geometry??[],memory:memoryCanvas.current,keepRevealed:!!state.current.keepRevealed,
   memoryRange:undefined,
   origins:vision.origins.map(o=>originPolygon(o,vision.heavy?vision.radius:SIGHT_EXTENT)),
   sight:vision.origins.map(o=>originPolygon(o,SIGHT_EXTENT)),
   lights:ordinaryLights.map(source=>({source,polygon:polygon(source,SIGHT_EXTENT)}))};
  for(const slot of polygonCache.current.keys())if(!activeKeys.has(slot))polygonCache.current.delete(slot);}
  for(const slot of circlePaths.current.keys())if(!activeKeys.has('circle:'+slot))circlePaths.current.delete(slot);
  for(const slot of worldCirclePaths.current.keys())if(!activeKeys.has('wcircle:'+slot))worldCirclePaths.current.delete(slot);
  // Cosmetic flashes restore color only inside already-visible terrain. They
  // never enter this cover or authorize/persist exploration. A flashing area
  // spell's reach joins the GPU cover alone, inside sight (see SpellFlash).
  const filter=vision.daylight?'none':vision.heavy?`grayscale(${HEAVY_DARKVISION_DESATURATION})`:'grayscale(.88) brightness(.78)';
  if(domCache.current.filter!==filter){shade.current.style.backdropFilter=filter;shade.current.style.setProperty('-webkit-backdrop-filter',filter);domCache.current.filter=filter;}
  const nearFilter=`grayscale(${REGULAR_DARKVISION_DESATURATION}) brightness(1.18)`;
  const nearDisplay=vision.daylight||vision.heavy?'none':'';
  if(nearShade.current){
   if(domCache.current.nearDisplay!==nearDisplay){nearShade.current.style.display=nearDisplay;domCache.current.nearDisplay=nearDisplay;}
   if(domCache.current.nearFilter!==nearFilter){nearShade.current.style.backdropFilter=nearFilter;nearShade.current.style.setProperty('-webkit-backdrop-filter',nearFilter);domCache.current.nearFilter=nearFilter;}
  }
  finish();
 };
 // Movement, camera following and flickering lights can all update in one
 // frame. Rebuild the SVG masks once using the final state, not for every event.
 const schedule=()=>{if(!pendingDraw.current)pendingDraw.current=requestAnimationFrame(()=>{pendingDraw.current=0;draw();});};
 const syncProps=()=>{const next=latestProps.current;if(syncedProps.current===next)return false;syncedProps.current=next;const previous=propCamera.current,current=state.current,sameView=next.view.x===previous.view.x&&next.view.y===previous.view.y&&next.view.scale===previous.view.scale;state.current={...next,view:sameView?current.view:next.view,tilt:next.tilt===previous.tilt?current.tilt:next.tilt,rotation:next.rotation===previous.rotation?current.rotation:next.rotation};propCamera.current={view:next.view,tilt:next.tilt,rotation:next.rotation};if(next.vision!==current.vision)renderedLights.current=null;for(const [id,p] of live.current){const o=next.vision.origins.find(x=>x.id===id)??next.vision.lights.find(x=>x.id===id);if(!o||(o.x===p.x&&o.y===p.y))live.current.delete(id);}fullDraw.current=true;return true;};
 useEffect(()=>()=>{cancelAnimationFrame(pendingDraw.current);ordinaryMask.current?.dispose();spellMask.current?.dispose();},[]);
 useImperativeHandle(ref,()=>({
  cover(){syncProps();if(pendingDraw.current||fullDraw.current){cancelAnimationFrame(pendingDraw.current);pendingDraw.current=0;draw();}return coverFrame.current;},
  memoryCanvas:()=>memoryCanvas.current,
  frame(){syncProps();fullDraw.current=true;cancelAnimationFrame(pendingDraw.current);pendingDraw.current=0;draw();},
  prepareLights(next){
   if(state.current.spellLighting!==false&&prepareProjection.current){spellMask.current?.prepare(next,prepareProjection.current);
    if(root.current)root.current.dataset.preparedSpellMasks=String(spellMask.current?.stats.prepared??0);
   }
  },
  lights(next){
   syncProps();const filtered=(state.current.spellLighting===false?next.filter(l=>!l.transient):next).map(stabilizeLight);
   const previous=(renderedLights.current??state.current.vision.lights).filter(l=>state.current.spellLighting!==false||!l.transient).map(stabilizeLight);
   if(sameLights(filtered,previous))return;
   const prevOrdinary=previous.filter(l=>!l.transient),nextOrdinary=filtered.filter(l=>!l.transient);
   renderedLights.current=filtered;
   if(!sameLights(nextOrdinary,prevOrdinary))fullDraw.current=true;
   schedule();
  },
  camera(next){fullDraw.current=true;state.current={...state.current,...next};cancelAnimationFrame(pendingDraw.current);pendingDraw.current=0;draw();},
  move(id,x,y){
   if(!state.current.vision.origins.some(o=>o.id===id)&&!state.current.vision.lights.some(l=>l.id===id))return;
   live.current.set(id,{x,y});fullDraw.current=true;schedule();
  },
 }),[]);
 useLayoutEffect(()=>{
  // Server snapshots can arrive during a camera drag, before React receives its
  // final view. Preserve imperative camera fields when their props are unchanged.
  if(syncProps()||pendingDraw.current||fullDraw.current){cancelAnimationFrame(pendingDraw.current);pendingDraw.current=0;draw();}},[props]);
 const terrain=props.terrain,b=terrain?.bounds,g=terrain?.grid;
 return <><div ref={root} data-testid="player-vision" data-wall-geometry-source={props.serverGeometry?.outlines?'server':'client'} data-explored-regions={terrain?.explored?.length??0} data-wall-count={props.vision.walls?.length??0} data-range-ft={props.vision.heavy?props.vision.rangeFt:'unlimited'} data-heavy={String(props.vision.heavy)} data-origin-count={props.vision.origins.length}
  style={{position:'absolute',inset:0,zIndex:2,pointerEvents:'none',overflow:'hidden'}}>
  <svg width={props.width} height={props.height} style={{position:'absolute',inset:0}} aria-hidden="true"><defs>
   <clipPath id={sightId} clipPathUnits="userSpaceOnUse" ref={sightPaths}/><g ref={lightClips}/>
   <clipPath id={memoryId} clipPathUnits="userSpaceOnUse" ref={memoryPaths}/>
   <g id={lightId} ref={lightPaths}/>
   <mask id={rangeId} maskUnits="userSpaceOnUse" x="0" y="0" width={props.width} height={props.height}><g ref={retainedRange}/></mask>
   <g id={`${nearId}-paths`} ref={nearPaths}/>
   <mask id={shadeId} maskUnits="userSpaceOnUse" x="0" y="0" width={props.width} height={props.height}>
    <rect width={props.width} height={props.height} fill="white"/><use href={`#${nearId}-paths`} fill="black"/><use href={`#${lightId}`}/><g ref={spellPaths}/>{props.keepRevealed&&<g clipPath={`url(#${memoryId})`}><rect width={props.width} height={props.height} fill="black"/></g>}
   </mask>
   <mask id={nearId} maskUnits="userSpaceOnUse" x="0" y="0" width={props.width} height={props.height}>
    <rect width={props.width} height={props.height} fill="black"/><use href={`#${nearId}-paths`} fill="white"/><use href={`#${lightId}`}/>
   </mask>
   <mask id={coverId} maskUnits="userSpaceOnUse" x="0" y="0" width={props.width} height={props.height}>
    <rect width={props.width} height={props.height} fill="white"/><g ref={originPaths}/>{props.vision.origins.length>0&&<g clipPath={`url(#${sightId})`}><use href={`#${lightId}`}/></g>}
   </mask>
   <mask id={flashId} maskUnits="userSpaceOnUse" x="0" y="0" width={props.width} height={props.height}>
    <rect width={props.width} height={props.height} fill="white"/><rect width={props.width} height={props.height} fill="black" mask={`url(#${coverId})`}/>
   </mask>
  </defs></svg>
  <div data-testid="automatic-map-fog" style={{display:props.mapFogOfWar===false&&!props.vision.heavy?'none':undefined,position:'absolute',inset:0,background:'#050608',maskImage:`url(#${coverId})`}}>
   {terrain&&b&&<div data-testid="explored-terrain" style={{position:'absolute',inset:0,overflow:'hidden',clipPath:`url(#${memoryId})`}}>
    <div ref={memoryPlane} data-testid="explored-terrain-grade" style={{position:'absolute',width:props.width,height:props.height,overflow:props.tilt?undefined:'hidden',transformOrigin:'50% 50%',filter:props.keepRevealed?'none':`grayscale(1) brightness(${exploredTerrainBrightness(terrain.environment,props.vision.heavy)})`}}>
     <div ref={memoryMap} style={{position:'absolute',transformOrigin:'0 0'}}>
      {!terrain.tiles.length&&<div style={{position:'absolute',left:b.x,top:b.y,width:b.w,height:b.h,background:'#2a2f3a'}}/>}
      {terrain.tiles.map((t,i)=><img key={`${t.url}:${i}`} src={t.url} alt="" draggable={false} style={{position:'absolute',left:t.x,top:t.y,width:t.w,height:t.h,maxWidth:'none'}}/>)}
      {g&&g.size>0&&<div style={{position:'absolute',left:b.x,top:b.y,width:b.w,height:b.h,backgroundImage:'linear-gradient(to right,#ffffff50 1px,transparent 1px),linear-gradient(to bottom,#ffffff50 1px,transparent 1px)',backgroundSize:`${g.size}px ${g.size}px`,backgroundPosition:`${g.x-b.x}px ${g.y-b.y}px`}}/>}
     </div>
    </div>
    <canvas ref={memoryCanvas} data-testid="darkvision-memory-terrain" data-mode={props.keepRevealed?'retained':props.vision.heavy?'heavy':'regular'} aria-hidden="true" style={{display:props.vision.heavy&&!props.keepRevealed?undefined:'none',position:'absolute',inset:0,width:'100%',height:'100%'}}/>
   </div>}
  </div>
 </div>
  <div ref={shade} data-testid="player-vision-shade" style={{position:'absolute',inset:0,zIndex:4,pointerEvents:'none',maskImage:`url(#${shadeId})`}}/>
  <div ref={nearShade} data-testid="dim-light-darkvision" style={{position:'absolute',inset:0,zIndex:4,pointerEvents:'none',maskImage:`url(#${nearId})`}}/>
 </>;
});
