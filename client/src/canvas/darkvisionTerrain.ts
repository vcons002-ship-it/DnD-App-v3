import {acquireAnimatedMap} from './animatedMapMedia';
import {acquireMapTileTexture} from './mapTileTextures';
import {lightFalloffGlsl} from '../../../shared/lightFalloff';
import {exploredTerrainBrightness,HEAVY_DARKVISION_MEMORY_BRIGHTNESS,REGULAR_DARKVISION_TERRAIN_BRIGHTNESS} from '../../../shared/terrainLighting';
import {Color,Mesh,PlaneGeometry,ShaderMaterial,VideoTexture,Vector2,Scene,WebGLRenderTarget,type Texture,type Camera,type WebGLRenderer} from 'three';
import type {EnvironmentPreviewSettings} from './battlefieldEnvironment';
import {environmentVisibilityGlsl,type createEnvironmentVisibility} from './environmentVisibility';
import {torchFieldGlsl,type createBattlefieldLighting} from './battlefieldLighting';
/** Read original artwork, before the darkness grade removes its useful detail. */
export function createDarkvisionTerrain(scene:Scene,renderer:WebGLRenderer,visibility:ReturnType<typeof createEnvironmentVisibility>['uniforms'],lights:ReturnType<typeof createBattlefieldLighting>['fieldUniforms'],grade:ReturnType<typeof createBattlefieldLighting>['terrainGrade'],depth:{texture:Texture;resolution:Vector2},invalidate:()=>void){
 const entries:{mesh:Mesh;memory:Mesh;texture:Texture;material:ShaderMaterial;memoryMaterial:ShaderMaterial;release:()=>void;releaseTile:()=>void;videoTexture?:VideoTexture}[]=[];let key='',generation=0,memoryKey='';
 const memoryScene=new Scene(),savedClearColor=new Color();let lastCanvas:HTMLCanvasElement|null=null,memoryVersion=0,memoryTarget:WebGLRenderTarget|undefined;
 const memoryBrightness={value:.2};
 const clear=()=>{generation++;memoryKey='';
  if(lastCanvas){lastCanvas.getContext('2d')?.clearRect(0,0,lastCanvas.width,lastCanvas.height);lastCanvas.dataset.ready='false';}
  for(const e of entries){scene.remove(e.mesh);memoryScene.remove(e.memory);e.mesh.geometry.dispose();e.material.dispose();e.memoryMaterial.dispose();e.videoTexture?.dispose();e.release();e.releaseTile();}entries.length=0;};
 return {update(settings:EnvironmentPreviewSettings){
  memoryBrightness.value=exploredTerrainBrightness(settings);
  const enabled=!!settings.darkvisionTerrain;
  const tiles=settings.darkvisionTerrain??[];
  const maxTex=settings.maxMapTextureResolutionPx??8192;
  const next=JSON.stringify([enabled,!!settings.heavyDarkness,maxTex,tiles,settings.darkvisionGrid]);if(next===key)return;key=next;clear();if(!enabled)return;
  const version=generation;
  for(const [index,tile] of tiles.entries()){
   const material=new ShaderMaterial({transparent:true,depthTest:false,depthWrite:false,toneMapped:false,uniforms:{...visibility,...lights,...grade,memoryPass:{value:0},memoryBrightness,figureDepth:{value:depth.texture},resolution:{value:depth.resolution},art:{value:null},texel:{value:new Vector2(1/1024,1/1024)},gridSize:{value:settings.darkvisionGrid?.size??0},gridOffset:{value:new Vector2(settings.darkvisionGrid?.x??0,settings.darkvisionGrid?.y??0)}},
    vertexShader:`varying vec2 artUv;varying vec3 world;void main(){artUv=uv;world=(modelMatrix*vec4(position,1.)).xyz;gl_Position=projectionMatrix*viewMatrix*vec4(world,1.);}`,
    fragmentShader:`${environmentVisibilityGlsl}${torchFieldGlsl}${lightFalloffGlsl}
     uniform sampler2D art,figureDepth;uniform vec2 texel,resolution,gridOffset;uniform float gridSize,memoryPass,memoryBrightness,gradeOpacity,sceneTintStrength;uniform vec3 gradeColor,sceneTint;varying vec2 artUv;varying vec3 world;
     float lum(vec2 p){return dot(texture2D(art,p).rgb,vec3(.2126,.7152,.0722));}
     vec3 toSrgb(vec3 c){return mix(pow(max(c,vec3(0.)),vec3(1./2.4))*1.055-vec3(.055),c*12.92,lessThanEqual(c,vec3(.0031308)));}
     void main(){if(memoryPass<.5&&(environmentVisible(world.xz)<.5||texture2D(figureDepth,gl_FragCoord.xy/resolution).r<.999999))discard;
      vec4 lightField=torchFieldAt(world.xz);vec3 illumination=lightField.rgb;float strength=max(illumination.r,max(illumination.g,illumination.b));float coverage=lightColorCoverage(strength),unlit=1.-coverage;
      vec4 source=texture2D(art,artUv);float l=dot(source.rgb,vec3(.2126,.7152,.0722)),detail=0.;
      // Regular sight does not need the heavy-darkness contour samples.
      if(memoryPass>.5||${settings.heavyDarkness?'true':'false'}){
       vec2 stepUv=max(texel*2.,fwidth(artUv)*1.5);
       float edge=length(vec2(lum(artUv+vec2(stepUv.x,0.))-lum(artUv-vec2(stepUv.x,0.)),lum(artUv+vec2(0.,stepUv.y))-lum(artUv-vec2(0.,stepUv.y))));
       detail=smoothstep(.025,.22,edge)*.20+smoothstep(.35,.85,l)*.13;
      }
      float grid=0.;if(gridSize>0.){vec2 cell=(world.xz-gridOffset)/gridSize;vec2 d=abs(fract(cell-.5)-.5)/max(fwidth(cell),vec2(.0001));grid=1.-smoothstep(.35,1.15,min(d.x,d.y));}
      float recovery=max(detail,grid*.30);
      if(memoryPass>1.5){
       vec3 remembered=mix(source.rgb,vec3(1.),grid*(80./255.));
       if(memoryPass<2.5)remembered=vec3(dot(remembered,vec3(.2126,.7152,.0722))*memoryBrightness);
       gl_FragColor=vec4(remembered,source.a);
      }else if(memoryPass>.5){
       // The unlit ground grade and darkvision detail, slightly dimmed for memory.
       // Memory contains artwork/grid only: no torches, creatures or weather.
       float alpha=gradeOpacity+sceneTintStrength*(1.-gradeOpacity);
       vec3 tint=(gradeColor*gradeOpacity*(1.-sceneTintStrength)+sceneTint*sceneTintStrength)/max(.001,alpha);
       vec3 ground=mix(source.rgb,toSrgb(tint),alpha);
       // Softer memory highlights for contours, bright artwork and the grid.
       // Keep the darker ground grade and current-sight recovery unchanged.
       float remembered=dot(mix(ground,vec3(.35),recovery),vec3(.2126,.7152,.0722));
       gl_FragColor=vec4(vec3(remembered*${HEAVY_DARKVISION_MEMORY_BRIGHTNESS}),source.a);
      }else if(${settings.heavyDarkness?'false':'true'}) {
       // Regular sight reveals naturally dark artwork rather than adding pale
       // contour highlights. The shared light mask restores the original lit
       // scene, while the CSS vision grade leaves a small amount of color.
       float brightness=clamp((1.-gradeOpacity)*2.,${REGULAR_DARKVISION_TERRAIN_BRIGHTNESS},1.);
       gl_FragColor=vec4(mix(source.rgb*brightness,vec3(.16),grid*.5),unlit*source.a);
      }else {
       // Preserve the artwork's hue in recovered detail without lifting its
       // brightness. The current-sight overlay keeps its color muted;
       // the memory pass above remains completely grayscale.
       vec3 recovered=mix(vec3(.55),clamp(source.rgb*.55/max(l,.05),0.,1.),.65);
       gl_FragColor=vec4(recovered,recovery*unlit*source.a);
      }
     }`});
   const mesh=new Mesh(new PlaneGeometry(tile.w,tile.h),material);mesh.rotation.x=-Math.PI/2;mesh.position.set(tile.x+tile.w/2,.006,tile.y+tile.h/2);mesh.renderOrder=3+index*.001;mesh.frustumCulled=false;mesh.visible=false;scene.add(mesh);
   const memoryMaterial=material.clone();
   // Share texture/grade uniforms, but select the terrain-only output for memory.
   memoryMaterial.uniforms={...material.uniforms,memoryPass:{value:1}};
   const memory=new Mesh(mesh.geometry,memoryMaterial);memory.copy(mesh,false);memory.material=memoryMaterial;memory.visible=false;memoryScene.add(memory);
   let videoTexture:VideoTexture|undefined;
   let readyFired=false;
   const acquiredTile=acquireMapTileTexture(renderer,tile.url,maxTex,(w,h)=>{
    if(version!==generation)return;
    readyFired=true;
    material.uniforms.texel.value.set(1/Math.max(1,w),1/Math.max(1,h));
    mesh.visible=memory.visible=true;
    memoryKey='';
    invalidate();
   });
   const texture=acquiredTile.texture;
   material.uniforms.art.value=texture;
   // Memory always reads the poster, never the live animation or scene effects.
   memoryMaterial.uniforms.art={value:texture};
   let release=()=>{};
   if(tile.videoPath){
    const handle=acquireAnimatedMap(tile.videoPath),e=handle.entry;
    videoTexture=new VideoTexture(e.video);videoTexture.generateMipmaps=false;
    const refresh=()=>{if(version!==generation)return;material.uniforms.art.value=e.ready&&!e.failed?videoTexture!:texture;invalidate();};
    const paint=()=>{if(version===generation&&e.ready&&!e.failed)invalidate();};
    e.listeners.add(refresh);e.frameListeners.add(paint);refresh();
    release=()=>{e.listeners.delete(refresh);e.frameListeners.delete(paint);handle.release();};
   }
   entries.push({mesh,memory,texture,material,memoryMaterial,release,releaseTile:acquiredTile.release,videoTexture});
   if(readyFired)mesh.visible=memory.visible=true;
  }
 },renderMemory(renderer:WebGLRenderer,camera:Camera,canvas:HTMLCanvasElement|null,gpuComposite=false,modeOverride?:1|2|3){
  if((!gpuComposite&&!canvas)||!entries.length||entries.some(e=>!e.memory.visible))return;
  const w=renderer.domElement.width,h=renderer.domElement.height;
  const mode=modeOverride??(canvas?.dataset.mode==='retained'?3:canvas?.dataset.mode==='regular'?2:1),copy2d=!gpuComposite;
  const next=JSON.stringify([key,w,h,mode,copy2d,memoryBrightness.value,camera.projectionMatrix.elements,camera.matrixWorld.elements,grade.gradeColor.value.toArray(),grade.gradeOpacity.value,grade.sceneTint.value.toArray(),grade.sceneTintStrength.value]);
  if(canvas===lastCanvas&&next===memoryKey)return;
  lastCanvas=canvas;memoryKey=next;
  if(copy2d&&canvas&&(canvas.width!==w||canvas.height!==h)){canvas.width=w;canvas.height=h;}
  for(const entry of entries)entry.memoryMaterial.uniforms.memoryPass.value=mode;
  if(gpuComposite){
   if(!memoryTarget||memoryTarget.width!==w||memoryTarget.height!==h){
    memoryTarget?.dispose();
    memoryTarget=new WebGLRenderTarget(w,h,{depthBuffer:false,stencilBuffer:false});
   }
   const prevTarget=renderer.getRenderTarget(),prevAutoClear=renderer.autoClear,prevAlpha=renderer.getClearAlpha(),prevShadow=renderer.shadowMap.needsUpdate;
   renderer.getClearColor(savedClearColor);
   try{
    renderer.shadowMap.needsUpdate=false;
    renderer.setRenderTarget(memoryTarget);
    renderer.setClearColor(0x000000,0);
    renderer.autoClear=true;
    renderer.clear(true,false,false);
    renderer.render(memoryScene,camera);
   }finally{
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(savedClearColor,prevAlpha);
    renderer.autoClear=prevAutoClear;
    renderer.shadowMap.needsUpdate=prevShadow;
   }
  }else{
   renderer.render(memoryScene,camera);
   if(canvas){const context=canvas.getContext('2d')!;context.clearRect(0,0,w,h);context.drawImage(renderer.domElement,0,0);}
  }
  if(canvas){
   canvas.dataset.ready='true';
   canvas.dataset.version=String(++memoryVersion);
  }
 },get memoryTexture(){return memoryTarget?.texture??null;},dispose(){clear();memoryTarget?.dispose();memoryTarget=undefined;}};
}
