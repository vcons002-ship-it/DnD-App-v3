import {LIGHT_SPILL_MULTIPLIER} from '../../../shared/lightFalloff';
import {lightCoverage,type VisionLight} from '../../../shared/playerVision';
import type {createVisionLightProjector} from './visionLightEllipse';

const SVG='http://www.w3.org/2000/svg';
const element=<K extends keyof SVGElementTagNameMap>(tag:K)=>document.createElementNS(SVG,tag);
const BAND_STEPS=16;
const r1=(n:number)=>Math.round(n*10)/10;
const r2=(n:number)=>Math.round(n*100)/100;
type Entry={
 node:SVGGElement;ellipseEl:SVGEllipseElement;fallbackGroup:SVGGElement;
 grad:SVGRadialGradientElement;stops:SVGStopElement[];gradId:string;
 clip:SVGClipPathElement;clipPath:SVGPathElement;
 geometry:string;profile:string;occlusion:string;clipAttr:string;focalKey:string;
 fallbackHtml:string;shapes:string[];alphas:string[];
};
type Projection={key:string;wallsKey:string;occluded:boolean;ellipse:ReturnType<typeof createVisionLightProjector>;
 circle:(light:VisionLight,radius:number)=>string;clip:(light:VisionLight)=>string;
 point?:(x:number,y:number)=>{x:number;y:number}|undefined};

/** Persist one radial-gradient <ellipse> per point light (with beam/horizon
 * path fallback) and update SVG attributes in place to avoid DOM rebuilds and
 * full-group innerHTML parsing on camera gestures or torch flicker. */
export function createVisionLightMask(group:SVGGElement,defs:SVGGElement,id:string){
 const entries=new Map<string,Entry>(),stagedEntries=new Map<string,Entry>(),detachedDefs=element('g');
 let serial=0,created=0,geometryUpdates=0,domWrites=0;
 const setAttr=(el:SVGElement,name:string,value:string)=>{
  if(el.getAttribute(name)!==value){el.setAttribute(name,value);domWrites++;return true;}
  return false;
 };
 const clearAttr=(el:SVGElement,name:string)=>{
  if(el.getAttribute(name)!==null){el.removeAttribute(name);domWrites++;return true;}
  return false;
 };
 function syncInternal(lights:readonly VisionLight[],projection:Projection,prepare=false){
  const target=prepare?stagedEntries:entries,clipContainer=prepare?detachedDefs:defs;
  const live=new Set<string>();
  for(const rawLight of lights){
   const nominalRadius=!rawLight.transient&&(rawLight as {nominalRadius?:number}).nominalRadius!==undefined?(rawLight as {nominalRadius?:number}).nominalRadius!:rawLight.radius;
   const nominalStrength=!rawLight.transient&&(rawLight as {nominalStrength?:number}).nominalStrength!==undefined?(rawLight as {nominalStrength?:number}).nominalStrength!:rawLight.strength;
   const light=(nominalRadius===rawLight.radius&&nominalStrength===rawLight.strength)?rawLight:{...rawLight,radius:nominalRadius,strength:nominalStrength};
   // A zero peak produces no attenuation anywhere. Avoid projection and wall
   // clipping for that source until it contributes, without discarding its cache.
   live.add(light.id);if(lightCoverage(0,light)===0)continue;
   let entry=target.get(light.id);
   if(!entry&&!prepare&&stagedEntries.has(light.id)){
    entry=stagedEntries.get(light.id)!;stagedEntries.delete(light.id);target.set(light.id,entry);
    defs.append(entry.clip);defs.append(entry.grad);group.append(entry.node);domWrites++;
   }
   if(!entry){
    const s=serial++,gradId=id+'-g-'+s;
    const clip=element('clipPath'),clipPath=element('path');
    clip.id=id+'-'+s;clip.setAttribute('clipPathUnits','userSpaceOnUse');clip.append(clipPath);
    const grad=element('radialGradient');
    grad.id=gradId;grad.setAttribute('gradientUnits','objectBoundingBox');
    grad.setAttribute('cx','0.5');grad.setAttribute('cy','0.5');grad.setAttribute('r','0.5');
    grad.setAttribute('fx','0.50');grad.setAttribute('fy','0.50');
    const stops:SVGStopElement[]=[];
    for(let i=0;i<=BAND_STEPS;i++){
     const stop=element('stop');
     stop.setAttribute('offset',(i/BAND_STEPS).toFixed(4));
     stop.setAttribute('stop-color','black');
     stop.setAttribute('stop-opacity','0');
     grad.append(stop);stops.push(stop);
    }
    clipContainer.append(clip);clipContainer.append(grad);
    const node=element('g'),ellipseEl=element('ellipse'),fallbackGroup=element('g');
    ellipseEl.setAttribute('cx','0');ellipseEl.setAttribute('cy','0');ellipseEl.setAttribute('rx','1');ellipseEl.setAttribute('ry','1');
    ellipseEl.setAttribute('fill',`url(#${gradId})`);
    node.append(ellipseEl,fallbackGroup);
    if(!prepare){group.append(node);domWrites++;}
    entry={node,ellipseEl,fallbackGroup,grad,stops,gradId,clip,clipPath,geometry:'',profile:'',occlusion:'',clipAttr:'',focalKey:'0.50:0.50',fallbackHtml:'',shapes:[],alphas:[]};
    target.set(light.id,entry);created++;
   }
   const maxRadius=light.radius*LIGHT_SPILL_MULTIPLIER;
   const profile=[light.radius,light.height,light.strength,!!light.transient].join(':');
   const profileChanged=entry.profile!==profile;
   if(profileChanged){
    for(let i=0;i<=BAND_STEPS;i++){
     setAttr(entry.stops[i],'stop-opacity',lightCoverage(maxRadius*i/BAND_STEPS,light).toFixed(4));
    }
    entry.alphas=[];entry.profile=profile;
   }
   const occlusion=[projection.key,projection.wallsKey,projection.occluded,light.x,light.y].join(':');
   if(entry.occlusion!==occlusion){
    if(projection.occluded){
     const path=projection.clip(light);
     setAttr(entry.clipPath,'d',path);
     const clipAttr=`url(#${entry.clip.id})`;
     if(entry.clipAttr!==clipAttr){setAttr(entry.node,'clip-path',clipAttr);entry.clipAttr=clipAttr;}
    }else if(entry.clipAttr){
     clearAttr(entry.node,'clip-path');entry.clipAttr='';
    }
    entry.occlusion=occlusion;
   }
   const geometry=[projection.key,light.x,light.y,light.radius,JSON.stringify(light.beam)].join(':');
   const geometryChanged=entry.geometry!==geometry;
   if(geometryChanged){entry.shapes=[];entry.geometry=geometry;geometryUpdates++;}
   const outer=!light.beam?projection.ellipse(light.x,light.y,maxRadius):undefined;
   if(outer){
    if(entry.fallbackHtml){entry.fallbackGroup.innerHTML='';entry.fallbackHtml='';domWrites++;}
    clearAttr(entry.ellipseEl,'display');
    if(geometryChanged){
     setAttr(entry.ellipseEl,'transform',`translate(${r1(outer.cx)} ${r1(outer.cy)}) rotate(${r2(outer.rotation)}) scale(${r2(outer.rx)} ${r2(outer.ry)})`);
     let fx='0.50',fy='0.50';
     const center=projection.point?.(light.x,light.y);
     if(center){
      const dx=center.x-outer.cx,dy=center.y-outer.cy,rad=outer.rotation*Math.PI/180,c=Math.cos(rad),s=Math.sin(rad);
      let u=(dx*c+dy*s)/Math.max(1e-6,outer.rx),v=(-dx*s+dy*c)/Math.max(1e-6,outer.ry);
      const len=Math.hypot(u,v);if(len>.94){u*=.94/len;v*=.94/len;}
      fx=(.5+u*.5).toFixed(2);fy=(.5+v*.5).toFixed(2);
     }
     const fKey=`${fx}:${fy}`;
     if(entry.focalKey!==fKey){setAttr(entry.grad,'fx',fx);setAttr(entry.grad,'fy',fy);entry.focalKey=fKey;}
    }
   }else if(geometryChanged||profileChanged||!entry.fallbackHtml){
    setAttr(entry.ellipseEl,'display','none');
    if(!entry.alphas.length){
     let previous=0;
     for(let i=48;i>=1;i--){
      const coverage=lightCoverage(maxRadius*i/48-light.radius/64,light);
      const alpha=Math.max(0,(coverage-previous)/Math.max(.00001,1-previous));previous=coverage;
      entry.alphas.push(alpha>.0001?alpha.toFixed(4):'');
     }
    }
    const bands:string[]=[];
    for(let index=0;index<48;index++)if(entry.alphas[index]){
     if(!entry.shapes[index]){
      const radius=maxRadius*(48-index)/48,ellipse=light.beam?undefined:projection.ellipse(light.x,light.y,radius);
      entry.shapes[index]=ellipse
       ?`<ellipse cx="${ellipse.cx.toFixed(2)}" cy="${ellipse.cy.toFixed(2)}" rx="${ellipse.rx.toFixed(2)}" ry="${ellipse.ry.toFixed(2)}" transform="rotate(${ellipse.rotation.toFixed(4)} ${ellipse.cx.toFixed(2)} ${ellipse.cy.toFixed(2)})"`
       :`<path d="${projection.circle(light,radius)}"`;
     }
     bands.push(`${entry.shapes[index]} fill="black" fill-opacity="${entry.alphas[index]}"/>`);
    }
    const html=bands.join('');
    if(entry.fallbackHtml!==html){entry.fallbackGroup.innerHTML=html;entry.fallbackHtml=html;domWrites++;}
   }
  }
  for(const [key,entry] of target)if(!live.has(key)){
   entry.node.remove();entry.clip.remove();entry.grad.remove();target.delete(key);domWrites++;
  }
 }
 return {sync:(lights:readonly VisionLight[],projection:Projection)=>syncInternal(lights,projection),
  prepare:(lights:readonly VisionLight[],projection:Projection)=>syncInternal(lights.slice(0,24),projection,true),
  get stats(){return {created,geometryUpdates,domWrites,lights:entries.size,prepared:stagedEntries.size};},
  dispose(){for(const entry of [...entries.values(),...stagedEntries.values()]){entry.node.remove();entry.clip.remove();entry.grad.remove();}entries.clear();stagedEntries.clear();group.innerHTML='';}};
}
