import clipping from 'polygon-clipping';
import {cutDoor,distanceToWall,sanitizeWalls,type MapWall,type WallEdit,type WallPoint} from './mapWalls.js';
import {wallContours,wallBoundarySegments,insideWallGeometry} from './wallGeometry.js';

export function polygonWall(id:string,rings:WallPoint[][]):MapWall {
 const points=rings[0];
 return {id,kind:'polygon',ax:Math.min(...points.map(p=>p.x)),ay:Math.min(...points.map(p=>p.y)),bx:Math.max(...points.map(p=>p.x)),by:Math.max(...points.map(p=>p.y)),points,...(rings.length>1?{holes:rings.slice(1)}:{})};
}

function measureWallBand(w:MapWall,c:WallPoint,tx:number,ty:number,nx:number,ny:number,len:number):{lo:number;hi:number}|null {
 const sampleOffsets=[0,-len*.25,len*.25,-len*.42,len*.42].map(s=>s+1.37e-4);
 let bestLo=Infinity,bestHi=-Infinity,found=false;
 for(const sOff of sampleOffsets){
  const origin={x:c.x+tx*sOff,y:c.y+ty*sOff};
  const hits:number[]=[];
  for(const {a,b} of wallBoundarySegments(w)){
   const sa=(a.x-origin.x)*tx+(a.y-origin.y)*ty,sb=(b.x-origin.x)*tx+(b.y-origin.y)*ty;
   if((sa<0)===(sb<0)||Math.abs(sa-sb)<1e-8)continue;
   const t=sa/(sa-sb),p={x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t};
   hits.push((p.x-origin.x)*nx+(p.y-origin.y)*ny);
  }
  hits.sort((a,b)=>a-b);
  let band:{lo:number;hi:number;distance:number}|undefined;
  for(let i=0;i<hits.length-1;i++){
   const lo=hits[i],hi=hits[i+1],mid=(lo+hi)/2;
   if(hi-lo<.01||!insideWallGeometry({x:origin.x+nx*mid,y:origin.y+ny*mid},w))continue;
   const distance=Math.max(lo,0,-hi);
   if(!band||distance<band.distance)band={lo,hi,distance};
  }
  // Ignore opposite-wall hits across a small room (anything far beyond local wall reach).
  if(band&&band.distance<=Math.max(24,len*.6)){
   bestLo=Math.min(bestLo,band.lo);
   bestHi=Math.max(bestHi,band.hi);
   found=true;
  }
 }
 return found?{lo:bestLo,hi:bestHi}:null;
}

/** Cut only the local band under the drag, not the far side of a circular room. */
export function cutPolygonDoor(w:MapWall,d:NonNullable<WallEdit['door']>):MapWall[]|null {
 if(w.door||![d.ax,d.ay,d.bx,d.by].every(Number.isFinite)||!/^[\w-]{1,64}$/.test(d.id))return null;
 const rings=wallContours(w);if(!rings.length)return null;
 const dx=d.bx-d.ax,dy=d.by-d.ay,len=Math.hypot(dx,dy);if(len<.1)return null;
 const tx=dx/len,ty=dy/len,nx=-ty,ny=tx,c={x:(d.ax+d.bx)/2,y:(d.ay+d.by)/2};
 const band=measureWallBand(w,c,tx,ty,nx,ny,len);
 if(!band)return null;
 // Curves can bow across the doorway width; cover the full measured band plus a capped margin.
 const pad=Math.min(len*.35,Math.max(1.5,(band.hi-band.lo)*.65))+.25;
 const point=(s:number,n:number):[number,number]=>[c.x+tx*s+nx*n,c.y+ty*s+ny*n];
 const cutter:clipping.Polygon=[[point(-len/2,band.lo-pad),point(len/2,band.lo-pad),point(len/2,band.hi+pad),point(-len/2,band.hi+pad)]];
 const source:clipping.Polygon=rings.map(r=>r.map(p=>[p.x,p.y]));
 try{
  const doors=clipping.intersection(source,cutter);if(!doors.length)return null;
  const convert=(poly:clipping.Polygon,id:string)=>polygonWall(id,poly.map(r=>r.slice(0,-1).map(([x,y])=>({x,y}))));
  const rawRemaining=clipping.difference(source,cutter).map((p,i)=>convert(p,`${d.id}-part-${i}`));
  const remaining=sanitizeWalls(rawRemaining);
  const doorWall=doors.length===1
   ? {...convert(doors[0],d.id),door:true,open:false}
   : {...polygonWall(d.id,[[point(-len/2,band.lo),point(len/2,band.lo),point(len/2,band.hi),point(-len/2,band.hi)].map(([x,y])=>({x,y}))]),door:true,open:false};
  const [validDoor]=sanitizeWalls([doorWall]);
  if(!validDoor)return null;
  return [...remaining,validDoor];
 }catch{return null;} // A degenerate/self-crossing drag leaves the original wall untouched.
}

/** Cut a doorway cleanly even when curved walls bow or multiple walls meet at the opening. */
export function cutDoorAcrossWalls(walls:readonly MapWall[],d:NonNullable<WallEdit['door']>):MapWall[]|null {
 if(![d.ax,d.ay,d.bx,d.by].every(Number.isFinite)||!/^[\w-]{1,64}$/.test(d.id))return null;
 const dx=d.bx-d.ax,dy=d.by-d.ay,len=Math.hypot(dx,dy);if(len<.1)return null;
 const tx=dx/len,ty=dy/len,nx=-ty,ny=tx,c={x:(d.ax+d.bx)/2,y:(d.ay+d.by)/2};
 const samplePts=[0,.2,.4,.6,.8,1].map(t=>({x:d.ax+dx*t,y:d.ay+dy*t}));
 const candidates=walls.filter(w=>{
  if(w.door||w.window||w.arch)return false;
  const tol=Math.max(14,(w.thickness??6)*1.25);
  return w.id===d.wallId&&samplePts.some(p=>distanceToWall(p,w)<=tol*1.5)||samplePts.some(p=>distanceToWall(p,w)<=tol);
 });
 if(!candidates.length)return null;

 // Fast path: single candidate wall preserves exact legacy segment/polygon door geometry.
 if(candidates.length===1){
  const single=candidates[0];
  const parts=cutDoor(single,d)??cutPolygonDoor(single,d);
  if(parts){
   const next=[...walls.filter(w=>w.id!==single.id),...parts];
   const cleaned=sanitizeWalls(next);
   if(cleaned.some(w=>w.id===d.id&&w.door))return cleaned;
  }
 }

 // Multi-wall junction / fallback path: measure combined band across all meeting walls,
 // subtract an oriented doorway cutter from every candidate wall, and insert one clean door.
 let lo=Infinity,hi=-Infinity,anySolid=false;
 for(const w of candidates){
  if(wallContours(w).length){
   anySolid=true;
   const band=measureWallBand(w,c,tx,ty,nx,ny,len);
   if(band){lo=Math.min(lo,band.lo);hi=Math.max(hi,band.hi);}
   else{const half=Math.max(3,(w.thickness??8)/2);lo=Math.min(lo,-half);hi=Math.max(hi,half);}
  }else{
   for(const {a,b} of wallBoundarySegments(w)){
    for(const p of [a,b,{x:(a.x+b.x)/2,y:(a.y+b.y)/2}]){
     const s=(p.x-c.x)*tx+(p.y-c.y)*ty,n=(p.x-c.x)*nx+(p.y-c.y)*ny;
     if(Math.abs(s)<=len*.65&&Math.abs(n)<=16){lo=Math.min(lo,n-1);hi=Math.max(hi,n+1);}
    }
   }
  }
 }
 if(!Number.isFinite(lo)||!Number.isFinite(hi)){lo=-4;hi=4;}
 const cutPad=Math.min(len*.35,Math.max(2,(hi-lo)*.65+1.5));
 const cutLo=lo-cutPad,cutHi=hi+cutPad;
 const pt=(s:number,n:number):[number,number]=>[c.x+tx*s+nx*n,c.y+ty*s+ny*n];
 const cutter:clipping.Polygon=[[pt(-len/2,cutLo),pt(len/2,cutLo),pt(len/2,cutHi),pt(-len/2,cutHi)]];
 const candidateIds=new Set(candidates.map(w=>w.id));
 let partIdx=0,cutAny=false;
 const intersectedSolids:clipping.MultiPolygon=[];

 const updated:MapWall[]=[];
 for(const w of walls){
  if(!candidateIds.has(w.id)){updated.push(w);continue;}
  const rings=wallContours(w);
  if(rings.length){
   const source:clipping.Polygon=rings.map(r=>r.map(p=>[p.x,p.y]));
   try{
    const inter=clipping.intersection(source,cutter);
    if(!inter.length){updated.push(w);continue;}
    cutAny=true;
    intersectedSolids.push(...inter);
    const diff=clipping.difference(source,cutter).map(poly=>polygonWall(`${d.id}-part-${partIdx++}`,poly.map(r=>r.slice(0,-1).map(([x,y])=>({x,y})))));
    updated.push(...sanitizeWalls(diff));
   }catch{updated.push(w);}
   continue;
  }
  // Zero-thickness line wall in oriented (s, n) space: clip [-len/2, len/2] x [cutLo, cutHi].
  let wallChanged=false;
  const kept:{a:WallPoint;b:WallPoint}[]=[];
  for(const {a,b} of wallBoundarySegments(w)){
   const sa=(a.x-c.x)*tx+(a.y-c.y)*ty,na=(a.x-c.x)*nx+(a.y-c.y)*ny;
   const sb=(b.x-c.x)*tx+(b.y-c.y)*ty,nb=(b.x-c.x)*nx+(b.y-c.y)*ny;
   const ds=sb-sa,dn=nb-na;
   let t0=0,t1=1,hit=true;
   for(const [p,q] of [[-ds,sa+len/2],[ds,len/2-sa],[-dn,na-cutLo],[dn,cutHi-na]]){
    if(Math.abs(p)<1e-9){if(q<0){hit=false;break;}}
    else if(p<0)t0=Math.max(t0,q/p);
    else t1=Math.min(t1,q/p);
   }
   if(!hit||t0>=t1||t1<=0||t0>=1){kept.push({a,b});continue;}
   wallChanged=true;cutAny=true;
   if(t0>0)kept.push({a,b:{x:a.x+(b.x-a.x)*t0,y:a.y+(b.y-a.y)*t0}});
   if(t1<1)kept.push({a:{x:a.x+(b.x-a.x)*t1,y:a.y+(b.y-a.y)*t1},b});
  }
  if(!wallChanged){updated.push(w);continue;}
  for(const seg of kept){
   if(Math.hypot(seg.a.x-seg.b.x,seg.a.y-seg.b.y)>=.1){
    updated.push({id:`${d.id}-part-${partIdx++}`,ax:seg.a.x,ay:seg.a.y,bx:seg.b.x,by:seg.b.y});
   }
  }
 }
 if(!cutAny)return null;

 let doorPiece:MapWall;
 if(!anySolid){
  doorPiece={id:d.id,ax:d.ax,ay:d.ay,bx:d.bx,by:d.by,door:true,open:false};
 }else{
  let unioned:clipping.MultiPolygon=[];
  try{
   if(intersectedSolids.length===1)unioned=[intersectedSolids[0]];
   else if(intersectedSolids.length>1)unioned=clipping.union(intersectedSolids[0],...intersectedSolids.slice(1));
  }catch{unioned=[];}
  if(unioned.length===1){
   doorPiece={...polygonWall(d.id,unioned[0].map(r=>r.slice(0,-1).map(([x,y])=>({x,y})))),door:true,open:false};
  }else{
   const dLo=Math.min(lo,-.5),dHi=Math.max(hi,.5);
   doorPiece={...polygonWall(d.id,[[pt(-len/2,dLo),pt(len/2,dLo),pt(len/2,dHi),pt(-len/2,dHi)].map(([x,y])=>({x,y}))]),door:true,open:false};
  }
 }
 const [validDoor]=sanitizeWalls([doorPiece]);
 if(!validDoor)return null;
 return [...sanitizeWalls(updated),validDoor];
}
