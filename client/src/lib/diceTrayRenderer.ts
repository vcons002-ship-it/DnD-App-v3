import * as THREE from 'three';
import {createMaterialDie,getDiceStage} from './materialDice';
import {trayFaceValues,type Toss,type TrayDie} from './diceTrayTypes';
import {diceTrayLayoutForPool,diePhysicalScale} from '../../../shared/diceTrayLayout';
import type {DiceTheme} from '../../../shared/diceThemes';
import {createDiceTrails} from './diceTrail';
import {createWoodlandWake} from './diceWoodlandWake';
import {createShatterWorld} from './diceShatterPhysics';
import {createDiceTableScene,createPlainDiceTableSurface,preloadDiceTableTexture} from './diceTableScene';
import {getPrewarmedBoardCanvas,normalizeTrayArtKey,preloadTrayArtImage,setPrewarmedBoardCanvas} from './diceBoardAssets';
import type {DiceTableSeat} from './diceTableCamera';
import type {StateSnapshot} from '../../../shared/types';
import {createDiceRendererCache} from './diceRendererCache';
import {currentGraphicsBudget} from './useEnvironmentQuality';
import {diceGraphicsGeneration} from './useDiceRendering';

export type DiceAppearanceTest={liquidInk?:boolean;molten?:boolean;lightning?:boolean;dmGlow?:number;denseDm?:boolean;varisTrail?:boolean;mossAgate?:boolean;enchantedAmber?:boolean;woodlandWake?:boolean};

const trayTextures=new Map<string,Promise<THREE.Texture>>();
let residentFeltMap:THREE.CanvasTexture|undefined;
let residentOcclusionMap:THREE.CanvasTexture|undefined;
let residentShadowMap:THREE.CanvasTexture|undefined;
let residentRingMap:THREE.CanvasTexture|undefined;
let residentWoodMap:THREE.CanvasTexture|undefined;
let residentWoodBumpMap:THREE.CanvasTexture|undefined;
let residentLeatherBumpMap:THREE.CanvasTexture|undefined;
let residentTrayGeometries:{
  plinth:THREE.BufferGeometry;
  mainFrame:THREE.BufferGeometry;
  crown:THREE.BufferGeometry;
  trim:THREE.BufferGeometry;
  liner:THREE.BufferGeometry;
  clasp:THREE.BufferGeometry;
  rivet:THREE.BufferGeometry;
}|undefined;

function getSharedTrayMaps(renderer:THREE.WebGLRenderer){
  if(!residentFeltMap){
    const felt=document.createElement('canvas');felt.width=felt.height=256;
    const feltCtx=felt.getContext('2d')!;
    const bg=feltCtx.createRadialGradient(128,128,18,128,128,170);
    bg.addColorStop(0,'#213b32');bg.addColorStop(.75,'#192d26');bg.addColorStop(1,'#12221c');
    feltCtx.fillStyle=bg;feltCtx.fillRect(0,0,256,256);
    for(let k=0;k<18000;k++){feltCtx.fillStyle=k%2?'#ffffff09':'#00000014';feltCtx.fillRect((k*73)%256,Math.floor(k*41.7)%256,1,1);}
    feltCtx.strokeStyle='#d6c59822';feltCtx.lineWidth=1.5;feltCtx.setLineDash([5,4]);feltCtx.strokeRect(8,8,240,240);
    residentFeltMap=new THREE.CanvasTexture(felt);residentFeltMap.colorSpace=THREE.SRGBColorSpace;
    residentFeltMap.wrapS=residentFeltMap.wrapT=THREE.RepeatWrapping;residentFeltMap.repeat.set(6,4);
    renderer.initTexture(residentFeltMap);
  }
  if(!residentOcclusionMap){
    const occlusionCanvas=document.createElement('canvas');occlusionCanvas.width=occlusionCanvas.height=128;
    const oc=occlusionCanvas.getContext('2d')!;
    const edgeShade=oc.createLinearGradient(0,0,0,128);
    edgeShade.addColorStop(0,'#000c');edgeShade.addColorStop(.3,'#0005');edgeShade.addColorStop(1,'#0000');
    oc.fillStyle=edgeShade;oc.fillRect(0,0,128,128);
    residentOcclusionMap=new THREE.CanvasTexture(occlusionCanvas);
    renderer.initTexture(residentOcclusionMap);
  }
  if(!residentShadowMap){
    const canvas=document.createElement('canvas');canvas.width=canvas.height=64;
    const c=canvas.getContext('2d')!,gradient=c.createRadialGradient(32,32,4,32,32,32);
    gradient.addColorStop(0,'#000b');gradient.addColorStop(1,'#0000');c.fillStyle=gradient;c.fillRect(0,0,64,64);
    residentShadowMap=new THREE.CanvasTexture(canvas);
    renderer.initTexture(residentShadowMap);
  }
  if(!residentRingMap){
    const size=128,cCanvas=document.createElement('canvas');cCanvas.width=cCanvas.height=size;
    const rc=cCanvas.getContext('2d')!,cx=size/2,cy=size/2;
    const g=rc.createRadialGradient(cx,cy,size*.26,cx,cy,size*.5);
    g.addColorStop(0,'rgba(255,255,255,0)');
    g.addColorStop(.22,'rgba(255,255,255,0.12)');
    g.addColorStop(.36,'rgba(255,255,255,0.98)');
    g.addColorStop(.52,'rgba(255,255,255,0.96)');
    g.addColorStop(.68,'rgba(255,255,255,0.34)');
    g.addColorStop(1,'rgba(255,255,255,0)');
    rc.fillStyle=g;rc.fillRect(0,0,size,size);
    residentRingMap=new THREE.CanvasTexture(cCanvas);residentRingMap.colorSpace=THREE.SRGBColorSpace;
    residentRingMap.minFilter=THREE.LinearMipmapLinearFilter;residentRingMap.magFilter=THREE.LinearFilter;
    renderer.initTexture(residentRingMap);
  }
  if(!residentWoodMap||!residentWoodBumpMap){
    const s=256;
    const colorCanvas=document.createElement('canvas');colorCanvas.width=colorCanvas.height=s;
    const bumpCanvas=document.createElement('canvas');bumpCanvas.width=bumpCanvas.height=s;
    const cc=colorCanvas.getContext('2d')!,bc=bumpCanvas.getContext('2d')!;
    const cImg=cc.createImageData(s,s),bImg=bc.createImageData(s,s);
    for(let y=0;y<s;y++){
      for(let x=0;x<s;x++){
        const u=x/s,v=y/s;
        const warp=Math.sin(u*Math.PI*2)*1.6+Math.sin(u*Math.PI*6+1.1)*.5;
        const ring=Math.sin((v*14+warp)*Math.PI);
        const fine=Math.sin(v*72+u*18.84)*.35;
        const pore=((Math.imul(x*73856093^y*19349663,2654435761)>>>0)%97)<3?1:0;
        const grain=Math.max(0,Math.min(1,.72+ring*.16+fine*.07-pore*.22));
        const idx=(y*s+x)*4;
        cImg.data[idx]=Math.round(255*grain);
        cImg.data[idx+1]=Math.round(244*grain);
        cImg.data[idx+2]=Math.round(230*grain);
        cImg.data[idx+3]=255;
        const bumpV=Math.round(Math.max(0,Math.min(255,145+ring*42+fine*20-pore*85)));
        bImg.data[idx]=bImg.data[idx+1]=bImg.data[idx+2]=bumpV;bImg.data[idx+3]=255;
      }
    }
    cc.putImageData(cImg,0,0);bc.putImageData(bImg,0,0);
    residentWoodMap=new THREE.CanvasTexture(colorCanvas);residentWoodMap.colorSpace=THREE.SRGBColorSpace;
    residentWoodBumpMap=new THREE.CanvasTexture(bumpCanvas);
    for(const t of [residentWoodMap,residentWoodBumpMap]){
      t.wrapS=t.wrapT=THREE.RepeatWrapping;t.anisotropy=renderer.capabilities.getMaxAnisotropy();renderer.initTexture(t);
    }
  }
  if(!residentLeatherBumpMap){
    const s=128,lCanvas=document.createElement('canvas');lCanvas.width=lCanvas.height=s;
    const lc=lCanvas.getContext('2d')!,lImg=lc.createImageData(s,s);
    for(let y=0;y<s;y++){
      for(let x=0;x<s;x++){
        const h=Math.imul((x*374761393)^(y*668265263),1274126177)>>>0;
        const cell=Math.sin(x*.45)*Math.cos(y*.45);
        const val=Math.round(Math.max(0,Math.min(255,130+cell*45+((h%64)-32))));
        const idx=(y*s+x)*4;
        lImg.data[idx]=lImg.data[idx+1]=lImg.data[idx+2]=val;lImg.data[idx+3]=255;
      }
    }
    lc.putImageData(lImg,0,0);
    residentLeatherBumpMap=new THREE.CanvasTexture(lCanvas);
    residentLeatherBumpMap.wrapS=residentLeatherBumpMap.wrapT=THREE.RepeatWrapping;residentLeatherBumpMap.repeat.set(8,6);
    renderer.initTexture(residentLeatherBumpMap);
  }
  return {feltMap:residentFeltMap,occlusionMap:residentOcclusionMap,shadowMap:residentShadowMap,ringMap:residentRingMap,woodMap:residentWoodMap,woodBumpMap:residentWoodBumpMap,leatherBumpMap:residentLeatherBumpMap};
}

function roundedRectShape(hx:number,hy:number,r:number):THREE.Shape{
  const rr=Math.min(r,hx*.48,hy*.48),s=new THREE.Shape();
  s.moveTo(-hx+rr,-hy);
  s.lineTo(hx-rr,-hy);s.quadraticCurveTo(hx,-hy,hx,-hy+rr);
  s.lineTo(hx,hy-rr);s.quadraticCurveTo(hx,hy,hx-rr,hy);
  s.lineTo(-hx+rr,hy);s.quadraticCurveTo(-hx,hy,-hx,hy-rr);
  s.lineTo(-hx,-hy+rr);s.quadraticCurveTo(-hx,-hy,-hx+rr,-hy);
  return s;
}

function roundedHolePath(hx:number,hy:number,r:number):THREE.Path{
  const rr=Math.min(r,hx*.48,hy*.48),p=new THREE.Path();
  p.moveTo(-hx+rr,-hy);
  p.quadraticCurveTo(-hx,-hy,-hx,-hy+rr);p.lineTo(-hx,hy-rr);p.quadraticCurveTo(-hx,hy,-hx+rr,hy);
  p.lineTo(hx-rr,hy);p.quadraticCurveTo(hx,hy,hx,hy-rr);
  p.lineTo(hx,-hy+rr);p.quadraticCurveTo(hx,-hy,hx-rr,-hy);
  p.lineTo(-hx+rr,-hy);
  return p;
}

/** Build a continuous mitered hollow frame with smooth chamfered bevels and rail-aligned wood UVs. */
function createFrameGeometry(
  outerHx:number,outerHy:number,outerR:number,
  innerHx:number,innerHy:number,innerR:number,
  totalDepth:number,bevelSize:number,bevelThickness:number,bevelSegments=3,curveSegments=10,
):THREE.BufferGeometry{
  const depth=Math.max(.01,totalDepth-bevelThickness*2);
  const shape=roundedRectShape(outerHx-bevelSize,outerHy-bevelSize,Math.max(.02,outerR-bevelSize));
  shape.holes.push(roundedHolePath(innerHx+bevelSize,innerHy+bevelSize,Math.max(.02,innerR+bevelSize)));
  const geom=new THREE.ExtrudeGeometry(shape,{depth,bevelEnabled:bevelSize>0&&bevelThickness>0,bevelSize,bevelThickness,bevelSegments,curveSegments});
  geom.translate(0,0,bevelThickness);
  geom.computeVertexNormals();
  const pos=geom.getAttribute('position'),uv=geom.getAttribute('uv');
  if(pos&&uv){
    for(let i=0;i<pos.count;i++){
      const x=pos.getX(i),y=pos.getY(i),z=pos.getZ(i);
      const horizontalRail=Math.abs(y)/outerHy>=Math.abs(x)/outerHx;
      const along=horizontalRail?x:y;
      const across=(horizontalRail?y:x)+z*.6;
      uv.setXY(i,along*.18,across*.55);
    }
    uv.needsUpdate=true;
  }
  return geom;
}

function createCornerClaspGeometry():THREE.BufferGeometry{
  const shape=new THREE.Shape();
  shape.moveTo(-.02,.02);shape.lineTo(-.02,-1.06);shape.lineTo(.46,-1.06);
  shape.lineTo(.46,-.46);shape.lineTo(1.06,-.46);shape.lineTo(1.06,.02);
  shape.closePath();
  const geom=new THREE.ExtrudeGeometry(shape,{depth:.10,bevelEnabled:true,bevelSize:.02,bevelThickness:.02,bevelSegments:2});
  geom.translate(0,0,.02);geom.computeVertexNormals();
  return geom;
}

function getSharedTrayGeometries(){
  if(!residentTrayGeometries){
    const rivet=new THREE.CylinderGeometry(.048,.055,.036,10);
    rivet.rotateX(Math.PI/2);
    residentTrayGeometries={
      plinth:createFrameGeometry(7.72,5.22,.34,6.96,4.46,.04,.40,.06,.05,2,6),
      mainFrame:createFrameGeometry(7.64,5.14,.28,7.10,4.60,.06,1.00,.085,.085,3,8),
      crown:createFrameGeometry(7.50,5.00,.22,7.13,4.63,.06,.14,.032,.032,2,6),
      trim:createFrameGeometry(7.36,4.86,.16,7.22,4.72,.12,.06,.014,.014,1,6),
      liner:createFrameGeometry(7.14,4.64,.08,7.01,4.51,.05,.90,.025,.035,2,6),
      clasp:createCornerClaspGeometry(),
      rivet,
    };
  }
  return residentTrayGeometries;
}

export const warmTrayGraphics=()=>{getDiceStage();};
export async function loadTrayTexture(themeId:string){
  const key=normalizeTrayArtKey(themeId);
  if(!key)return undefined;
  try{
    let promise=trayTextures.get(key);
    if(!promise){
      promise=(async()=>{
        const decoded=await preloadTrayArtImage(key);
        const texture=decoded?new THREE.Texture(decoded):await new THREE.TextureLoader().loadAsync(`/art/dice-trays/${key}-v1.webp`);
        texture.colorSpace=THREE.SRGBColorSpace;texture.needsUpdate=true;
        const stage=getDiceStage();texture.anisotropy=stage.renderer.capabilities.getMaxAnisotropy();
        // Retain a resident source, so disposing a throw's clones does not
        // delete/re-upload the same full-resolution artwork on the next roll.
        stage.renderer.initTexture(texture);return texture;
      })();
      trayTextures.set(key,promise);
    }
    return (await promise).clone();
  }catch{trayTextures.delete(key);return undefined;}
}
// Retain a small representative scene so Three.js keeps the compiled material
// programs resident. Disposing it immediately would undo the shader preload.
// The same face/body programs are shared by all polyhedral dice and percentile
// labels; actual live dice still receive their authoritative faces and poses.
const warmedDice = new Map<string, ReturnType<typeof createTrayRenderer>>();
let graphicsPreload: Promise<void> = Promise.resolve();
const graphicsPending=new Map<string,Promise<void>>();
export const waitForDiceGraphics = (themeId?:string) => themeId===undefined?graphicsPreload:graphicsPending.get(themeId)??Promise.resolve();
export const diceGraphicsPreloaded = (themeId: string) => warmedDice.has(themeId);
export const prepareDiceTableTexture = preloadDiceTableTexture;
export {diceTableBackground} from './diceTableScene';
const liveRenderers=createDiceRendererCache<ReturnType<typeof createTrayRenderer>>(12,36);
let liveRendererContext='';
export function acquireLiveTrayRenderer(context:string,dice:TrayDie[],toss:Toss,theme:DiceTheme,art?:THREE.Texture,dieThemes?:readonly DiceTheme[]){
  if(context!==liveRendererContext){liveRenderers.clear();liveRendererContext=context;}
  const key=JSON.stringify([diceGraphicsGeneration(),currentGraphicsBudget().resolved,theme,dieThemes,toss.radius,toss.trayScale,dice.map(d=>[d.sides,d.set,!!d.crit,!!d.tens,!!d.ones])]);
  const lease=liveRenderers.acquire(key,dice.length,()=>createTrayRenderer(dice,toss,theme,undefined,art,true,dieThemes));
  if(lease.reused){art?.dispose();lease.value.resetForRoll(toss);}
  return lease;
}
export function preloadDiceGraphics(theme: DiceTheme, canStart: () => boolean,context?:string) {
  const pending=graphicsPending.get(theme.id);if(pending)return pending;
  graphicsPreload = graphicsPreload.then(async () => {
    if (!canStart()) return;
    await preloadDiceTableTexture();
    if (!canStart()) return;
    const warmWidth=typeof window!=='undefined'?Math.max(320,Math.min(760,(window.innerWidth||800)-28)):600;
    const warmHeight=warmWidth*10.2/15.2;
    const warmDpr=typeof window!=='undefined'?Math.min(2,window.devicePixelRatio||1):1;
    if(!warmedDice.has(theme.id)){
      const art = await loadTrayTexture(theme.id);
      if (!canStart()) { art?.dispose(); return; }
      // Prepare every geometry/number variant, including percentile and critical
      // materials, before the player needs it. Keep up to six theme samples.
      const dice:TrayDie[]=[4,6,8,10,12,20,10,10,6].map((sides,index)=>({
        sides,value:1,index,set:0,tens:index===6,ones:index===7,crit:index===8,
      }));
      const toss: Toss = {settleTimes: [], wallHits: 0, frames: new Float32Array(dice.length*14),
        frameCount: 2, step: 1, radius: .65, trayScale: 1, topFaces: dice.map(()=>0), duration: 1};
      const renderer = createTrayRenderer(dice, toss, theme, undefined, art, true);
      try {
        await renderer.prepare(warmWidth, warmHeight, warmDpr, canStart);
        if(canStart()&&!getPrewarmedBoardCanvas(theme.id)){
          const snap=document.createElement('canvas');
          const snapW=760,snapH=Math.round(760*10.2/15.2);
          snap.width=snapW;snap.height=snapH;
          const snapCtx=snap.getContext('2d');
          if(snapCtx){
            renderer.setActiveCount(0);
            renderer.draw(snapCtx,snapW,snapH,1,0,performance.now());
            renderer.setActiveCount(dice.length);
            setPrewarmedBoardCanvas(theme.id,snap);
          }
        }
        warmedDice.set(theme.id, renderer);
        // Bound browser-session cache when a viewer switches among characters.
        if (warmedDice.size > 6) {
          const oldest = warmedDice.keys().next().value!;
          warmedDice.get(oldest)!.dispose(); warmedDice.delete(oldest);
        }
      } catch (error) { renderer.dispose(); throw error; }
    }
    if(context&&canStart()){
      for(const pool of [
        [{sides:20,value:1,index:0,set:0}],
        [{sides:20,value:1,index:0,set:0},{sides:20,value:1,index:1,set:1}],
      ] as TrayDie[][]){
        if(!canStart())break;
        const art=await loadTrayTexture(theme.id);
        if(!canStart()){art?.dispose();break;}
        const layout=diceTrayLayoutForPool(pool.length);
        const toss:Toss={settleTimes:[],wallHits:0,frames:new Float32Array(pool.length*14),frameCount:2,
          step:1,radius:layout.radius,trayScale:layout.scale,topFaces:pool.map(()=>0),duration:1};
        const lease=acquireLiveTrayRenderer(context,pool,toss,theme,art);
        try {await lease.value.prepare(warmWidth,warmHeight,warmDpr,canStart);}
        finally {lease.release();}
      }
    }
  }).catch(() => {}); // Disabled WebGL retains the normal roll fallback.
  const task=graphicsPreload.finally(()=>graphicsPending.delete(theme.id));
  graphicsPending.set(theme.id,task);return task;
}
export function createTrayRenderer(dice:TrayDie[],toss:Toss,theme:DiceTheme,keptSet?:number,trayArt?:THREE.Texture,fixedFaces=false,dieThemes?:readonly DiceTheme[],appearance?:DiceAppearanceTest){
  const budget=currentGraphicsBudget();
  appearance ??= {molten:true,lightning:true,liquidInk:true,dmGlow:.65,denseDm:true,varisTrail:true,mossAgate:false,woodlandWake:true};
  const stage=getDiceStage(),scene=new THREE.Scene();scene.environment=stage.scene.environment;
  const trayScale=toss.trayScale??1;
  const tray=new THREE.Group();tray.scale.set(trayScale,trayScale,1);scene.add(tray);
  // Frame every physical pool at the same apparent tray size. Larger pools
  // retain their established dice-to-tray ratio and therefore look smaller.
  const camera=new THREE.PerspectiveCamera(25,15.2/10.2,.1,60*trayScale);camera.position.set(0,-8,25).multiplyScalar(trayScale);camera.lookAt(0,0,.25*trayScale);camera.updateMatrixWorld();
  let tableScene:ReturnType<typeof createDiceTableScene>|undefined;
  const plainTable=createPlainDiceTableSurface(scene,trayScale);
  let tableKey='',sceneRevision=0,preparedSize='',compiledRevision=-1;
  scene.add(new THREE.HemisphereLight(0xf6eedf,0x243038,.78));
  const light=new THREE.DirectionalLight(0xfff3dd,1.62);light.position.set(-9,3,6).multiplyScalar(trayScale);light.castShadow=true;light.shadow.mapSize.set(budget.diceShadowSize,budget.diceShadowSize);
  Object.assign(light.shadow.camera,{left:-10*trayScale,right:10*trayScale,top:8*trayScale,bottom:-8*trayScale,near:.1,far:35*trayScale});light.shadow.bias=-.0003;light.shadow.normalBias=.025;scene.add(light);
  const geometry:THREE.BufferGeometry[]=[],materials:THREE.Material[]=[],textures:THREE.Texture[]=[];
  const box=(x:number,y:number,z:number,w:number,h:number,d:number,color:number):THREE.Mesh<THREE.BufferGeometry,THREE.Material>=>{
    const g=new THREE.BoxGeometry(w,h,d),m=new THREE.MeshStandardMaterial({color,roughness:.86,envMapIntensity:.18});
    const mesh=new THREE.Mesh(g,m);mesh.position.set(x,y,z);mesh.castShadow=true;mesh.receiveShadow=true;tray.add(mesh);geometry.push(g);materials.push(m);return mesh;
  };
  const {feltMap,occlusionMap,shadowMap,ringMap,woodMap,woodBumpMap,leatherBumpMap}=getSharedTrayMaps(stage.renderer);
  const trayGeoms=getSharedTrayGeometries();
  const addFramePiece=(geom:THREE.BufferGeometry,mat:THREE.Material,z:number,castShadow=false)=>{
    const m=new THREE.Mesh(geom,mat);m.position.z=z;m.castShadow=castShadow;m.receiveShadow=true;tray.add(m);
    if(!materials.includes(mat))materials.push(mat);return m;
  };
  // Stepped dark plinth base anchors the sculpted tray firmly onto the tabletop.
  addFramePiece(
    trayGeoms.plinth,
    new THREE.MeshStandardMaterial({color:0x0f0c12,roughness:.82,metalness:.06,envMapIntensity:.22}),
    -.34,
    false,
  );
  const floor=box(0,0,-.17,14.4,9.4,.3,0x182a27);
  floor.name='tray-bed';
  if(trayArt){trayArt.anisotropy=stage.renderer.capabilities.getMaxAnisotropy();textures.push(trayArt);}
  const feltMaterial=new THREE.MeshStandardMaterial({map:trayArt??feltMap,roughness:.94,metalness:0,bumpMap:feltMap,bumpScale:.012,envMapIntensity:.35});materials.push(feltMaterial);floor.material=feltMaterial;
  const palette=theme.id.startsWith('dm-')
    ? {wood:0x232936,crown:0x1b202b,trim:0xa8b5c4,liner:0x181c24}
    : theme.id==='fighter'
      ? {wood:0x28211d,crown:0x1b1716,trim:0xc49545,liner:0x1c1714}
      : theme.id==='ranger'
        ? {wood:0x4b2b18,crown:0x361e0f,trim:0x8c5a32,liner:0x1d2619}
        : theme.id==='sorcerer'
          ? {wood:0x3b131d,crown:0x270b12,trim:0x9aa2b2,liner:0x1e0e14}
          : {wood:0x4a2c1d,crown:0x331d13,trim:0xb38a4c,liner:0x1c2520};
  // Sculpted hardwood perimeter frame with smooth chamfered shoulders and mitered wood grain.
  addFramePiece(
    trayGeoms.mainFrame,
    new THREE.MeshStandardMaterial({color:palette.wood,map:woodMap,bumpMap:woodBumpMap,bumpScale:.024,roughness:.52,metalness:.04,envMapIntensity:.52}),
    .04,
    true,
  );
  // Raised upper rail crown + continuous recessed metallic inlay channel.
  addFramePiece(
    trayGeoms.crown,
    new THREE.MeshStandardMaterial({color:palette.crown,map:woodMap,bumpMap:woodBumpMap,bumpScale:.018,roughness:.44,metalness:.06,envMapIntensity:.56}),
    .98,
    false,
  );
  const trimMaterial=new THREE.MeshStandardMaterial({color:palette.trim,metalness:.82,roughness:.30,envMapIntensity:.85});
  addFramePiece(trayGeoms.trim,trimMaterial,1.10,false);
  // Cushioned inner suede/leather wall lining with padded top lip.
  addFramePiece(
    trayGeoms.liner,
    new THREE.MeshStandardMaterial({color:palette.liner,map:feltMap,bumpMap:leatherBumpMap,bumpScale:.02,roughness:.88,metalness:.02,envMapIntensity:.22}),
    -.02,
    true,
  );
  // Sculpted beveled corner hardware brackets + domed rivets locking the mitered rails.
  for(const [cx,cy,rot] of [[-7.58,5.08,0],[7.58,5.08,-Math.PI/2],[7.58,-5.08,Math.PI],[-7.58,-5.08,Math.PI/2]] as const){
    const corner=new THREE.Group();
    corner.position.set(cx,cy,1.03);corner.rotation.z=rot;
    const bracket=new THREE.Mesh(trayGeoms.clasp,trimMaterial);
    bracket.castShadow=false;bracket.receiveShadow=true;corner.add(bracket);
    for(const [rx,ry] of [[.22,-.22],[.84,-.22],[.22,-.84]] as const){
      const rivet=new THREE.Mesh(trayGeoms.rivet,trimMaterial);
      rivet.castShadow=false;rivet.receiveShadow=true;rivet.position.set(rx,ry,.145);corner.add(rivet);
    }
    tray.add(corner);
  }
  // Soft contact occlusion anchors the recessed bed along all 4 padded inner walls.
  for(const [x,y,w,h,rotation] of [[0,4.48,14.04,.50,0],[0,-4.48,14.04,.50,Math.PI],[-6.98,0,9.04,.50,Math.PI/2],[6.98,0,9.04,.50,-Math.PI/2]]){
    const g=new THREE.PlaneGeometry(w,h),m=new THREE.MeshBasicMaterial({map:occlusionMap,transparent:true,depthWrite:false,depthTest:true,polygonOffset:true,polygonOffsetFactor:-1});
    const mesh=new THREE.Mesh(g,m);mesh.position.set(x,y,-.014);mesh.rotation.z=rotation;mesh.renderOrder=0;tray.add(mesh);geometry.push(g);materials.push(m);
  }
  const shadows=dice.map(()=>{const g=new THREE.PlaneGeometry(2,2),m=new THREE.MeshBasicMaterial({map:shadowMap,transparent:true,depthWrite:false,depthTest:true,polygonOffset:true,polygonOffsetFactor:-1});const mesh=new THREE.Mesh(g,m);mesh.renderOrder=0;scene.add(mesh);geometry.push(g);materials.push(m);return mesh;});
  const handles=dice.map((d,i)=>{const dieTheme=dieThemes?.[i]??theme;const h=createMaterialDie(d.sides,dieTheme,!!d.crit,!!d.tens,!!d.ones);h.setMossAgate(!!appearance?.mossAgate);h.setEnchantedAmber(!!appearance?.enchantedAmber);h.setMoltenCracks(!!appearance?.molten);h.setInternalLightning(!!appearance?.lightning);h.setInnerGlow(appearance?.dmGlow??0);h.setLiquidInk(!!appearance?.liquidInk);h.setDenseResin(!!appearance?.denseDm);h.setFaceValues(fixedFaces?Array.from({length:d.sides},(_,j)=>d.tens?j*10:d.ones?j:j+1):trayFaceValues(d,toss.topFaces[i]),fixedFaces);h.object.scale.setScalar(toss.radius*diePhysicalScale(d.sides));h.setTrayLighting(true);
    // The standard shadow pass cannot transmit resin or discard this custom
    // inlay shader's empty areas. Keep its soft contact shadow instead of an
    // opaque silhouette cast by every numbered face.
    h.object.traverse(child=>{if(child instanceof THREE.Mesh)child.castShadow=!!child.userData.shatterChunk||!child.userData.dicePowerArt&&!(dieTheme.id.startsWith('dm-')&&!d.crit);});scene.add(h.object);return h;});
  // Depth-tested rings sit strictly on the tray bed underneath every 3D die (never occluding die faces).
  const rings=dice.map(d=>{
    const ringSize=toss.radius*diePhysicalScale(d.sides)*3.15;
    const g=new THREE.PlaneGeometry(ringSize,ringSize);
    const m=new THREE.MeshBasicMaterial({map:ringMap,color:d.set===keptSet?0x39ef87:0xff5365,transparent:true,opacity:.96,depthTest:true,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-2,polygonOffsetUnits:-2});
    const mesh=new THREE.Mesh(g,m);mesh.renderOrder=1;mesh.visible=false;scene.add(mesh);geometry.push(g);materials.push(m);return mesh;
  });
  const a=new THREE.Quaternion(),b=new THREE.Quaternion(),projectedNumber=new THREE.Vector3();
  const rangerIndices=dice.flatMap((d,i)=>(dieThemes?.[i]??theme).id==='ranger'&&!d.crit?[i]:[]);
  // A shared floor pass receives each enclosed mote's light without adding
  // dozens of dynamic lights or shadow maps to crowded dice rolls.
  const moteLights=rangerIndices.map(()=>new THREE.Vector3());
  if(moteLights.length){
    feltMaterial.onBeforeCompile=shader=>{
      shader.uniforms.moteLights={value:moteLights};shader.uniforms.moteRadius={value:toss.radius};
      shader.vertexShader='varying vec3 moteFloorPosition;\n'+shader.vertexShader;
      shader.vertexShader=shader.vertexShader.replace('#include <worldpos_vertex>','#include <worldpos_vertex>\nmoteFloorPosition=(modelMatrix*vec4(transformed,1.)).xyz;');
      shader.fragmentShader=`varying vec3 moteFloorPosition;uniform vec3 moteLights[${moteLights.length}];uniform float moteRadius;\n`+shader.fragmentShader;
      shader.fragmentShader=shader.fragmentShader.replace('#include <opaque_fragment>',`vec3 moteIllumination=vec3(0.);
        for(int k=0;k<${moteLights.length};k++){
          vec3 offset=(moteFloorPosition-moteLights[k])/moteRadius;
          float falloff=.24/pow(1.+dot(offset,offset)*.8,2.);
          moteIllumination+=vec3(.38,1.,.08)*falloff;
        }
        outgoingLight+=diffuseColor.rgb*moteIllumination;
        #include <opaque_fragment>`);
    };
    feltMaterial.customProgramCacheKey=()=>`ranger-mote-floor-${moteLights.length}`;
  }
  const trails=appearance?.varisTrail?(appearance.woodlandWake?createWoodlandWake(scene,toss.radius,rangerIndices,trayScale):createDiceTrails(scene,toss.radius,rangerIndices,trayScale)):undefined;
  let activeCount=dice.length,liveResults:readonly (number|null)[]|undefined;
  let customRingColors:readonly (number|null)[]|undefined;
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');
  const shatterWorld=dice.some((_,i)=>(dieThemes?.[i]??theme).id==='fighter')?createShatterWorld(toss.radius,trayScale):undefined;
  const shatterProxies=shatterWorld?handles.map((h,i)=>{h.setShatterWorld(shatterWorld);return shatterWorld.addDieProxy(dice[i].sides,toss.radius*diePhysicalScale(dice[i].sides));}):[];
  return {
    resetForRoll(next:Toss){
      toss=next;liveResults=undefined;activeCount=dice.length;keptSet=undefined;customRingColors=undefined;
      handles.forEach(h=>h.resetForRoll());shatterWorld?.reset();trails?.reset();
      rings.forEach(r=>r.visible=false);shadows.forEach(s=>s.visible=false);
    },
    setTableView(seats:readonly DiceTableSeat[],activeId:string,fromId:string|undefined,art:ReadonlyMap<string,THREE.Texture>){
      plainTable.mesh.visible=false;
      const key=JSON.stringify([seats,activeId]);
      if(tableScene&&key===tableKey){art.forEach(t=>t.dispose());tableScene.restart(fromId);return;}
      tableKey=key;sceneRevision++;
      tableScene?.dispose();art.forEach(t=>textures.push(t));
      camera.far=250*trayScale;camera.updateProjectionMatrix();
      tableScene=createDiceTableScene(scene,tray,camera,trayScale,seats,activeId,fromId,art);
    },
    startTableCamera(){tableScene?.run();},
    setTableMap(snapshot:StateSnapshot,viewerId?:string){tableScene?.map(snapshot,viewerId);},
    tableCameraState(){return tableScene?.state();},
    trayFootprint(){
      // Project the actual deck corners for browser framing checks.
      return [[-7.4,-4.9],[7.4,-4.9],[7.4,4.9],[-7.4,4.9]].map(([x,y])=>{
        const p=new THREE.Vector3(x*trayScale,y*trayScale,0).project(camera);
        return {x:(p.x+1)/2,y:(1-p.y)/2};
      });
    },
    setReviewZoom(zoom:number){camera.zoom=zoom;camera.updateProjectionMatrix();},
    setResults(values:readonly (number|null)[]){liveResults=values;},
    setExplosionTime(at:number|null|undefined){handles.forEach(h=>h.setExplosionAt(at));},
    powerStates(){return handles.slice(0,activeCount).map(h=>h.powerState());},
    graphicsState(){return {quality:budget.resolved,shadowSize:budget.diceShadowSize,pixelRatioCap:budget.pixelRatioCap,maxRenderWidth:budget.diceRenderWidth};},
    setActiveCount(count:number){activeCount=count;},
    trailPointCount(){return trails?.pointCount()??0;},
    trailBranchCount(){return trails?.branchCount()??0;},
    async prepare(width:number,height:number,dpr:number,canRender:()=>boolean=()=>true){
      await preloadDiceTableTexture();
      if(plainTable.prepare())sceneRevision++;
      const rw=Math.min(budget.diceRenderWidth,Math.round(width*Math.min(dpr,budget.pixelRatioCap))),rh=Math.round(rw*height/width),signature=`${rw}:${rh}:${sceneRevision}`;
      if(preparedSize===signature)return;
      // Launch poses start outside the camera. Warm visible dice, transmission,
      // textures and shadow passes before acknowledging readiness to the server.
      // This detached WebGL canvas is never shown during preparation.
      handles.forEach(h=>{h.object.position.set(0,0,toss.radius);h.updatePose(camera,performance.now());});
      handles.forEach(h=>h.prewarmShatter(true));
      const compile=(target:THREE.WebGLRenderTarget|null)=>{
        const previousTarget=stage.renderer.getRenderTarget(),shadows=stage.renderer.shadowMap.enabled;
        try {stage.renderer.shadowMap.enabled=true;stage.renderer.setRenderTarget(target);return stage.renderer.compileAsync(scene,camera);}
        finally {stage.renderer.setRenderTarget(previousTarget);stage.renderer.shadowMap.enabled=shadows;}
      };
      try {
        // Resin's transmission pass uses linear output without tone mapping.
        // compileAsync on the screen alone misses this variant, forcing the
        // driver to compile it synchronously inside the first actual render.
        if(compiledRevision!==sceneRevision){
          await compile(stage.linearCompileTarget);
          await compile(null);compiledRevision=sceneRevision;
        }
        // A live throw may begin while another theme compiles in the background.
        // Never resize/draw its shared canvas for a cancelled background warmup.
        if(canRender()){
          const shadows=stage.renderer.shadowMap.enabled;
          try {stage.renderer.setSize(rw,rh,false);stage.renderer.shadowMap.enabled=true;stage.renderer.render(scene,camera);preparedSize=signature;}
          finally {stage.renderer.shadowMap.enabled=shadows;}
        }
      }
      finally {handles.forEach(h=>h.prewarmShatter(false));}
    },
    setKeptSet(set:number|undefined){keptSet=set;rings.forEach((ring,i)=>(ring.material as THREE.MeshBasicMaterial).color.set(dice[i].set===set?0x39ef87:0xff5365));},
    setDieRings(colors:readonly (number|null)[]|undefined){
      customRingColors=colors;
      if(!colors)return;
      rings.forEach((ring,i)=>{const c=colors[i];if(c!==undefined&&c!==null)(ring.material as THREE.MeshBasicMaterial).color.set(c);});
    },
    numberPosition(index:number){
      const point=handles[index].resultPosition(projectedNumber);
      point.project(camera);
      return {x:(point.x+1)/2,y:(1-point.y)/2};
    },
    draw(ctx:CanvasRenderingContext2D,width:number,height:number,dpr:number,elapsed:number,now:number){
      tableScene?.update(now);
      shatterWorld?.advance(now);
      const frame=Math.min(toss.frameCount-1,elapsed/toss.step),i=Math.floor(frame),j=Math.min(i+1,toss.frameCount-1),t=frame-i;
      const waitingForCamera=tableScene!==undefined&&!tableScene.state().done;
      handles.forEach((h,k)=>{
        h.object.visible=k<activeCount&&!waitingForCamera;shadows[k].visible=k<activeCount&&!waitingForCamera;
        if(k>=activeCount||waitingForCamera){rings[k].visible=false;return;}
        const x=(i*dice.length+k)*7,y=(j*dice.length+k)*7,f=toss.frames;
        h.object.position.set(THREE.MathUtils.lerp(f[x],f[y],t),THREE.MathUtils.lerp(f[x+1],f[y+1],t),THREE.MathUtils.lerp(f[x+2],f[y+2],t));
        a.fromArray(f,x+3);b.fromArray(f,y+3);h.object.quaternion.slerpQuaternions(a,b,t);
        const die=dice[k];
        const value=liveResults?liveResults[k]:elapsed>=(toss.settleTimes[k]??toss.duration)?die.value:null;
        const tensIndex=die.tens?k:k-1,tens=liveResults?.[tensIndex],ones=liveResults?.[tensIndex+1];
        const percentile=liveResults&& (die.tens||die.ones)?tens!=null&&ones!=null?((tens-1)*10+ones-1)||100:undefined:die.percentileValue;
        h.setRollResult((die.tens||die.ones)&&percentile===undefined?null:value, value==null?undefined:percentile);
        h.setReducedMotion(reduced.matches);h.updatePose(camera,now);
        shadows[k].visible=!h.powerState().broken;
        const proxy=shatterProxies[k];if(proxy){proxy.position.set(h.object.position.x,h.object.position.y,h.object.position.z);proxy.quaternion.set(h.object.quaternion.x,h.object.quaternion.y,h.object.quaternion.z,h.object.quaternion.w);proxy.collisionFilterMask=h.powerState().broken?0:12;proxy.aabbNeedsUpdate=true;}
        const ring=rings[k];
        if(customRingColors!==undefined){
          const color=customRingColors[k]??null;
          ring.visible=color!==null;
          if(color!==null)(ring.material as THREE.MeshBasicMaterial).color.set(color);
        }else{
          ring.visible=keptSet!==undefined&&elapsed>=toss.duration;
        }
        ring.position.set(h.object.position.x,h.object.position.y,-.004);
        const shadow=shadows[k];shadow.position.set(h.object.position.x,h.object.position.y,-.010);
        const dieRadius=toss.radius*diePhysicalScale(dice[k].sides);
        const clearance=Math.max(0,h.object.position.z-dieRadius*.65);
        shadow.scale.setScalar(dieRadius*(1.0+clearance*.18));(shadow.material as THREE.MeshBasicMaterial).opacity=Math.max(.15,.9-clearance*.18);
      });
      rangerIndices.forEach((index,k)=>waitingForCamera?moteLights[k].set(0,0,-10000):handles[index].innerLightPosition(moteLights[k]));
      trails?.update(handles.map(h=>h.object),now);
      const rw=Math.min(budget.diceRenderWidth,Math.round(width*Math.min(dpr,budget.pixelRatioCap))),rh=Math.round(rw*height/width);
      if(stage.renderer.domElement.width!==rw||stage.renderer.domElement.height!==rh)stage.renderer.setSize(rw,rh,false);
      const previousShadows=stage.renderer.shadowMap.enabled;stage.renderer.shadowMap.enabled=true;
      stage.renderer.render(scene,camera);stage.renderer.shadowMap.enabled=previousShadows;
      ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,width,height);ctx.drawImage(stage.renderer.domElement,0,0,width,height);
    },
    dispose(){plainTable.dispose();tableScene?.dispose();trails?.dispose();light.shadow.dispose();handles.forEach(h=>h.dispose());shatterWorld?.dispose();geometry.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());textures.forEach(t=>t.dispose());scene.clear();}
  };
}
