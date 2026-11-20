import {Color,DoubleSide,Mesh,MeshBasicMaterial,NoBlending,OrthographicCamera,PlaneGeometry,Scene,ShaderMaterial,Vector2,Vector3,Vector4,WebGLRenderTarget,LinearFilter,type WebGLRenderer} from 'three';
import type {TorchLight} from './miniatureTorchLighting';

/** Point-source silhouettes on the flat map. Stationary geometry has its own
 * cached quadrant mask; moving figures composite into a single 2x2 atlas. */
export const environmentalLocalShadowGlsl=`
 uniform vec2 localPlanarTexel;
 uniform sampler2D localPlanarAtlas;
 float samplePlanarShadow(vec2 quadOrigin,vec4 bounds,vec3 point,float strength){
   if(point.y>1.)return 1.;
   vec2 uv=(point.xz-bounds.xy)/bounds.zw;uv.y=1.-uv.y;
   if(any(lessThan(uv,vec2(0.)))||any(greaterThan(uv,vec2(1.))))return 1.;
   vec2 uvMin=quadOrigin+localPlanarTexel*.5,uvMax=quadOrigin+vec2(.5)-localPlanarTexel*.5;
   vec2 auv=clamp(quadOrigin+uv*.5,uvMin,uvMax);
   vec2 pixel=localPlanarTexel*1.5;
   float blocked=(texture2D(localPlanarAtlas,auv).r+
     texture2D(localPlanarAtlas,clamp(auv+vec2(pixel.x,0.),uvMin,uvMax)).r+
     texture2D(localPlanarAtlas,clamp(auv-vec2(pixel.x,0.),uvMin,uvMax)).r+
     texture2D(localPlanarAtlas,clamp(auv+vec2(0.,pixel.y),uvMin,uvMax)).r+
     texture2D(localPlanarAtlas,clamp(auv-vec2(0.,pixel.y),uvMin,uvMax)).r)*.2;
   return 1.-blocked*strength;
 }
`;
export function createEnvironmentalLocalShadows(){
 const createTarget=()=>new WebGLRenderTarget(2,2,{minFilter:LinearFilter,magFilter:LinearFilter,depthBuffer:false,stencilBuffer:false});
 const atlas=createTarget(),stationary=createTarget(),keys=Array(4).fill('');
 const bounds=Array.from({length:4},()=>new Vector4(0,0,1,1)),texel=new Vector2(.5,.5),sourcePosition=new Vector3();
 const uniforms={localPlanarTexel:{value:texel},localPlanarAtlas:{value:atlas.texture}};
 const scene=new Scene(),camera=new OrthographicCamera(),material=new MeshBasicMaterial({color:0xffffff,side:DoubleSide,depthTest:false,depthWrite:false,toneMapped:false});
 material.onBeforeCompile=shader=>{
   shader.uniforms.floorShadowSource={value:sourcePosition};
   shader.vertexShader='uniform vec3 floorShadowSource;\n'+shader.vertexShader;
   shader.vertexShader=shader.vertexShader.replace('#include <project_vertex>',`
     vec4 shadowWorld=modelMatrix*vec4(transformed,1.);
     float separation=max(floorShadowSource.y*.08,floorShadowSource.y-shadowWorld.y);
     shadowWorld.xz+=(shadowWorld.xz-floorShadowSource.xz)*max(0.,shadowWorld.y)/separation;
     shadowWorld.y=.05;
     gl_Position=projectionMatrix*viewMatrix*shadowWorld;
   `);
 };
 material.customProgramCacheKey=()=> 'point-floor-shadow-v1';
 const quadOffset=new Vector2();
 const copyScene=new Scene(),copyCamera=new OrthographicCamera(-1,1,1,-1,0,2);
 const copyMaterial=new ShaderMaterial({
   depthTest:false,depthWrite:false,toneMapped:false,blending:NoBlending,
   uniforms:{src:{value:stationary.texture},quadOffset:{value:quadOffset}},
   vertexShader:'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }',
   fragmentShader:'uniform sampler2D src; uniform vec2 quadOffset; varying vec2 vUv; void main(){ gl_FragColor = texture2D(src, quadOffset + vUv * .5); }',
 });
 const copyGeometry=new PlaneGeometry(2,2),copy=new Mesh(copyGeometry,copyMaterial);copy.position.z=-1;copyScene.add(copy);
 const clearColor=new Color();camera.up.set(0,0,-1);
 let staticUpdates=0,dynamicUpdates=0,size=1;
 const fill=(meshes:readonly Mesh[])=>{scene.clear();for(const mesh of meshes){mesh.material=material;scene.add(mesh);}scene.updateMatrixWorld(true);};
 return {uniforms,bounds,
  render(renderer:WebGLRenderer,slot:number,source:TorchLight,staticMeshes:readonly Mesh[],dynamicMeshes:readonly Mesh[],staticKey:string,far:number,resolution:number){
   const nextSize=Math.max(1,Math.min(resolution,Math.floor((renderer.capabilities.maxTextureSize||4096)/2)));
   const previous=renderer.getRenderTarget(),alpha=renderer.getClearAlpha(),autoClear=renderer.autoClear,pending=renderer.shadowMap.needsUpdate;
   renderer.getClearColor(clearColor);
   try{
    renderer.shadowMap.needsUpdate=false;renderer.setClearColor(0,0);
    if(size!==nextSize){
     size=nextSize;const atlasSize=size*2;
     atlas.setSize(atlasSize,atlasSize);stationary.setSize(atlasSize,atlasSize);
     keys.fill('');texel.set(1/atlasSize,1/atlasSize);
     stationary.viewport.set(0,0,atlasSize,atlasSize);stationary.scissorTest=false;
     atlas.viewport.set(0,0,atlasSize,atlasSize);atlas.scissorTest=false;
     renderer.autoClear=true;
     renderer.setRenderTarget(stationary);renderer.clear();
     renderer.setRenderTarget(atlas);renderer.clear();
    }
    bounds[slot].set(source.x-far,source.y-far,far*2,far*2);
    sourcePosition.set(source.x,Math.max(.001,source.height),source.y);
    camera.left=-far;camera.right=far;camera.top=far;camera.bottom=-far;camera.near=.1;camera.far=2000;
    camera.position.set(source.x,1000,source.y);camera.lookAt(source.x,0,source.y);camera.updateProjectionMatrix();
    const qx=slot&1,qy=slot>>1,vx=qx*size,vy=qy*size;
    stationary.viewport.set(vx,vy,size,size);stationary.scissor.set(vx,vy,size,size);stationary.scissorTest=true;
    atlas.viewport.set(vx,vy,size,size);atlas.scissor.set(vx,vy,size,size);atlas.scissorTest=true;
    if(keys[slot]!==staticKey){fill(staticMeshes);renderer.autoClear=true;renderer.setRenderTarget(stationary);renderer.clear();renderer.render(scene,camera);keys[slot]=staticKey;staticUpdates++;}
    quadOffset.set(qx*.5,qy*.5);renderer.autoClear=true;renderer.setRenderTarget(atlas);renderer.clear();renderer.render(copyScene,copyCamera);
    if(dynamicMeshes.length){fill(dynamicMeshes);renderer.autoClear=false;renderer.render(scene,camera);dynamicUpdates++;}
   }finally{
    const atlasSize=Math.max(2,size*2);
    stationary.viewport.set(0,0,atlasSize,atlasSize);stationary.scissorTest=false;
    atlas.viewport.set(0,0,atlasSize,atlasSize);atlas.scissorTest=false;
    renderer.setRenderTarget(previous);renderer.setClearColor(clearColor,alpha);renderer.autoClear=autoClear;renderer.shadowMap.needsUpdate=pending;
   }
  },
  invalidate(){keys.fill('');},
  get state(){return {localShadowStaticUpdates:staticUpdates,localShadowDynamicUpdates:dynamicUpdates,localShadowFloorSize:size};},
  dispose(){scene.clear();material.dispose();copyMaterial.dispose();copyGeometry.dispose();atlas.dispose();stationary.dispose();},
 };
}
