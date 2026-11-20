import {lightFalloffGlsl,LIGHT_SPILL_MULTIPLIER,nearestLightPoint,type LightBeam} from '../../../shared/lightFalloff';
import {Box3, DataTexture, FloatType, Mesh, MeshStandardMaterial, NearestFilter, RGBAFormat, Vector2, Vector3, Vector4, type Camera, type Group, type Material, type Object3D, type Texture} from 'three';
import type {MiniatureDefinition} from '../lib/miniatures';
import {type MapWall} from '../../../shared/mapWalls';
import {localShadowGlsl,type createLocalLightShadows} from './localLightShadows';
import {createLightSightCache} from '../../../shared/lightSightCache';

const EMPTY_WALLS:readonly MapWall[]=[];
const TORCH_DATA_WIDTH=19;
export type MiniatureLightMode='directional'|'spells-ground'|'ground';
type GroundField={torchField:{value:Texture};torchBounds:{value:Vector4}};
// Valid sampler while no environment is mounted or the shared-sight pass is unlit.
const emptyGroundField=new DataTexture(new Uint8Array(4),1,1);emptyGroundField.needsUpdate=true;
export type TorchLight = {id:string;x:number;y:number;height:number;fixtureX?:number;fixtureY?:number;fixtureHeight?:number;radius:number;strength:number;nominalRadius?:number;nominalStrength?:number;color:Vector3;visibleTorch:boolean;fixture?:'torch'|'lantern';carried?:boolean;facing?:number;shadowSlot?:number;transient?:boolean;
  /** A flashing area spell's light: shows terrain in the viewer's line of sight. */
  revealsTerrain?:boolean;beam?:LightBeam};

/** Each figure gets its strongest nearby sources, independent of the map's light count. */
export function createMiniatureTorchLighting(shadowUniforms:ReturnType<typeof createLocalLightShadows>['uniforms']){
  const torchArray=new Float32Array(TORCH_DATA_WIDTH*4);
  const torchDataTexture=new DataTexture(torchArray,TORCH_DATA_WIDTH,1,RGBAFormat,FloatType);
  torchDataTexture.minFilter=torchDataTexture.magFilter=NearestFilter;
  torchDataTexture.needsUpdate=true;
  const shaderUniforms={...shadowUniforms,torchData:{value:torchDataTexture as Texture},torchDataRow:{value:0},torchDataRows:{value:1},
    torchGroundEnabled:{value:0},torchGroundField:{value:emptyGroundField as Texture},torchGroundBounds:{value:new Vector4()},torchGroundPoint:{value:new Vector2()}};
  const uniforms={...shaderUniforms,torchShadowSlots:{value:Array<number>(8).fill(-1)},darkvisionDetail:{value:0},torchCount:{value:0},torchPositions:{value:Array.from({length:8},()=>new Vector4())},torchColors:{value:Array.from({length:8},()=>new Vector3())}};
  const writeTorchData=()=>{
    let dirty=false;
    const write=(offset:number,value:number)=>{const f=Math.fround(value);if(torchArray[offset]!==f){torchArray[offset]=f;dirty=true;}};
    write(0,uniforms.torchCount.value);
    write(1,uniforms.darkvisionDetail.value);
    for(let i=0;i<8;i++){
      const p=uniforms.torchPositions.value[i],c=uniforms.torchColors.value[i],pos=(1+i)*4,col=(9+i)*4;
      write(pos,p.x);write(pos+1,p.y);write(pos+2,p.z);write(pos+3,p.w);
      write(col,c.x);write(col+1,c.y);write(col+2,c.z);write(col+3,uniforms.torchShadowSlots.value[i]);
    }
    if(dirty)torchDataTexture.needsUpdate=true;
  };
  const sight=createLightSightCache();
  let signature='';
  let lastLights:readonly TorchLight[]|undefined,lastWalls:readonly MapWall[]|undefined;
  let lastX=NaN,lastZ=NaN,lastMode:MiniatureLightMode|''='',lastDarkvision:boolean|undefined,lastGroundEnabled=-1;
  let cachedChosen:{light:TorchLight;nx:number;ny:number}[]=[];
  return {uniforms,get signature(){return signature;},get cacheState(){return sight.state;},attach(material:Material){
    if(!(material instanceof MeshStandardMaterial))return;
    const previous=material.onBeforeCompile,cache=material.customProgramCacheKey();
    material.onBeforeCompile=function(shader,renderer){
      previous.call(this,shader,renderer);Object.assign(shader.uniforms,shaderUniforms);
      shader.vertexShader=`varying vec3 torchWorldPosition;varying vec3 torchGroundRadiance;
        uniform float torchGroundEnabled;uniform sampler2D torchGroundField;uniform vec4 torchGroundBounds;uniform vec2 torchGroundPoint;\n`+shader.vertexShader;
      shader.vertexShader=shader.vertexShader.replace('#include <worldpos_vertex>',`#include <worldpos_vertex>
        vec4 torchWorld=vec4(transformed,1.);
        #ifdef USE_INSTANCING
          torchWorld=instanceMatrix*torchWorld;
        #endif
        torchWorldPosition=(modelMatrix*torchWorld).xyz;
        // Low samples the already-rendered, wall-clipped ground field. One
        // sample per vertex supplies a uniform response across the whole figure.
        vec2 groundPoint=torchGroundPoint;
        torchGroundRadiance=vec3(0.);
        if(torchGroundEnabled>.5){
          vec2 groundUv=(groundPoint-torchGroundBounds.xy)/max(torchGroundBounds.zw,vec2(.001));
          if(all(greaterThanEqual(groundUv,vec2(0.)))&&all(lessThanEqual(groundUv,vec2(1.)))){vec4 groundSample=texture2D(torchGroundField,groundUv);float groundStrength=max(groundSample.r,max(groundSample.g,groundSample.b));torchGroundRadiance=groundStrength>.0001?groundSample.rgb*((groundStrength+groundSample.a)/groundStrength):groundSample.rgb;}
        }`);
      shader.fragmentShader=localShadowGlsl+lightFalloffGlsl+`varying vec3 torchWorldPosition; varying vec3 torchGroundRadiance; uniform sampler2D torchData; uniform float torchDataRow; uniform float torchDataRows;
        vec4 torchDataTexel(float col){return texture2D(torchData,vec2((col+.5)/${TORCH_DATA_WIDTH}.,(torchDataRow+.5)/torchDataRows));}\n`+shader.fragmentShader;
      shader.fragmentShader=shader.fragmentShader.replace('#include <lights_fragment_begin>',`#include <lights_fragment_begin>
        vec4 torchMeta=torchDataTexel(0.);
        int torchCountVal=int(torchMeta.x+.5);
        float darkvisionDetailVal=torchMeta.y;
        float darkvisionLight=max(torchGroundRadiance.r,max(torchGroundRadiance.g,torchGroundRadiance.b));
        #if defined(RE_Direct)
        for(int torchIndex=0;torchIndex<8;torchIndex++){
          if(torchIndex>=torchCountVal)break;
          vec4 torchPosData=torchDataTexel(1.+float(torchIndex));
          vec4 torchColData=torchDataTexel(9.+float(torchIndex));
          vec3 worldDelta=torchPosData.xyz-torchWorldPosition;
          float torchDistance=length(worldDelta);
          directLight.direction=transformDirection(worldDelta/max(.001,torchDistance),viewMatrix);
          float shadow=localLightVisibility(torchColData.a,torchWorldPosition+inverseTransformDirection(geometryNormal,viewMatrix)*.35,.14);
          float irradiance=torchColData.a<-1.5?spellEmissionIrradiance(torchDistance,torchPosData.w,1.):lightIrradiance(torchDistance,torchPosData.w,1.);
          directLight.color=torchColData.rgb*irradiance*shadow;
          darkvisionLight+=max(directLight.color.r,max(directLight.color.g,directLight.color.b));
          directLight.visible=true;
          // A little local reflected light keeps surfaces facing away from a hip
          // lantern readable. This vanishes with the source; it is not ambient lift.
          reflectedLight.indirectDiffuse+=material.diffuseColor*directLight.color*.16;
          RE_Direct(directLight,geometryPosition,geometryNormal,geometryViewDir,geometryClearcoatNormal,material,reflectedLight);
        }
        #endif`);
      shader.fragmentShader=shader.fragmentShader.replace('#include <opaque_fragment>',`
        outgoingLight+=diffuseColor.rgb*torchGroundRadiance*.48;
        float sourceLuma=dot(diffuseColor.rgb,vec3(.2126,.7152,.0722));
        float contour=pow(1.-abs(dot(normalize(normal),normalize(vViewPosition))),3.);
        // Gentle midtone/facing detail for creatures in unlit heavy darkness.
        // Coverage removes this contribution wherever a torch supplies light.
        float detail=.010+smoothstep(.08,.70,sourceLuma)*.038+contour*.028;
        outgoingLight+=vec3(detail*darkvisionDetailVal*(1.-lightColorCoverage(darkvisionLight)));
        #include <opaque_fragment>`);
    };
    material.customProgramCacheKey=()=>cache+'-nearby-torches-v14-atlas';
  },update(lights:readonly TorchLight[],root:Group,_camera:Camera,darkvision=false,walls:readonly MapWall[]=EMPTY_WALLS,mode:MiniatureLightMode='directional',field?:GroundField){
    uniforms.darkvisionDetail.value=darkvision?1:0;
    uniforms.torchGroundEnabled.value=mode==='ground'&&field&&lights.length?1:0;
    uniforms.torchGroundField.value=field?.torchField.value??emptyGroundField;
    if(field)uniforms.torchGroundBounds.value.copy(field.torchBounds.value);else uniforms.torchGroundBounds.value.set(0,0,0,0);
    uniforms.torchGroundPoint.value.set(root.position.x,root.position.z);
    const rx=root.position.x,rz=root.position.z,groundEnabled=uniforms.torchGroundEnabled.value;
    if(lights!==lastLights||walls!==lastWalls||rx!==lastX||rz!==lastZ||mode!==lastMode||darkvision!==lastDarkvision||groundEnabled!==lastGroundEnabled){
      lastLights=lights;lastWalls=walls;lastX=rx;lastZ=rz;lastMode=mode;lastDarkvision=darkvision;lastGroundEnabled=groundEnabled;
      const chosen:{light:TorchLight;nx:number;ny:number;score:number}[]=[];
      // Balanced spells illuminate terrain only. Low bypasses per-figure source
      // selection entirely, including its ray checks and eight-light shader loop.
      if(mode!=='ground')for(const light of lights){
        if(mode==='spells-ground'&&light.transient)continue;
        const nearest=nearestLightPoint(light,rx,rz);
        const d2=(nearest.x-rx)**2+(nearest.y-rz)**2;
        if(d2>(light.radius*LIGHT_SPILL_MULTIPLIER)**2)continue;
        if(!sight.visible(light.id,light,{x:rx,y:rz},walls))continue;
        const score=light.strength*light.radius**2/Math.max(1,d2+light.height**2*.25);
        let i=0;while(i<chosen.length&&chosen[i].score>=score)i++;
        if(i<8){chosen.splice(i,0,{light,nx:nearest.x,ny:nearest.y,score});if(chosen.length>8)chosen.pop();}
      }
      chosen.sort((a,b)=>a.light.id.localeCompare(b.light.id));
      cachedChosen=chosen;
      uniforms.torchCount.value=chosen.length;
      signature=JSON.stringify([mode,groundEnabled,darkvision,chosen.map(c=>c.light.id)]);
    }
    for(let i=0;i<cachedChosen.length;i++){
      const {light,nx,ny}=cachedChosen[i];
      uniforms.torchPositions.value[i].set(nx,light.height,ny,light.radius);
      uniforms.torchColors.value[i].copy(light.color).multiplyScalar(light.strength);
      uniforms.torchShadowSlots.value[i]=light.transient?-2:light.shadowSlot??-1;
    }
    writeTorchData();
  },dispose(){torchDataTexture.dispose();}};
}

/** Sample the side of the belt, before adding outline shells or accessories. */
export function measureLanternAnchor(model:Group,definition:MiniatureDefinition){
  model.updateMatrixWorld(true);
  let body:Object3D|undefined;
  model.traverse(node=>{if(!body && /body/i.test(node.name))body=node;});
  const d=definition.baseDiameter,base=new Vector3().fromArray(definition.baseCenter);
  if(!body)return new Vector3(-d*.28,d*.75,d*.10);
  const bounds=new Box3().setFromObject(body),height=bounds.max.y-bounds.min.y;
  const waist=bounds.min.y+height*.52,point=new Vector3(),samples:Vector3[]=[];
  body.traverse(node=>{
    if(!(node instanceof Mesh))return;
    const positions=node.geometry.getAttribute('position'),index=node.geometry.index;
    if(!positions)return;
    const start=node.geometry.drawRange.start,end=Math.min(index?.count??positions.count,start+node.geometry.drawRange.count);
    const stride=Math.max(1,Math.ceil((end-start)/20000));
    for(let i=start;i<end;i+=stride){
      point.fromBufferAttribute(positions,index?index.getX(i):i).applyMatrix4(node.matrixWorld);
      if(Math.abs(point.y-waist)<d*.045 && Math.abs(point.x-base.x)<d*.4)samples.push(point.clone());
    }
  });
  const xs=samples.map(p=>p.x).sort((a,b)=>a-b);
  const x=xs.length?xs[Math.floor((xs.length-1)*.05)]:base.x-d*.28;
  const side=samples.filter(p=>p.x<=x+d*.065).map(p=>p.z).sort((a,b)=>a-b);
  // A slightly forward-facing hip position stays clear of the belt's center.
  return new Vector3(x,waist,side.length?side[Math.floor((side.length-1)*.68)]:base.z+d*.10).sub(base);
}
