import {DataTexture,FloatType,NearestFilter,RGBAFormat,type Material,type Vector2,type Vector3,type Vector4,type Texture} from 'three';

export type MiniatureLightUniforms={torchCount:{value:number};darkvisionDetail:{value:number};torchShadowSlots:{value:number[]};torchPositions:{value:Vector4[]};torchColors:{value:Vector3[]};torchGroundEnabled?:{value:number};torchGroundField?:{value:Texture};torchGroundBounds?:{value:Vector4};torchGroundPoint?:{value:Vector2};[key:string]:{value:unknown}|undefined};
const WIDTH=19;

/** One row per instance preserves its own nearby lights and wall occlusion.
 * This removes light-set boundaries from otherwise identical model draws.
 * Shared shadow maps stay ordinary uniforms; only source selection is packed. */
export function createMiniatureBatchLighting(capacity:number){
  const data=new Float32Array(WIDTH*capacity*4),texture=new DataTexture(data,WIDTH,capacity,RGBAFormat,FloatType);
  texture.minFilter=texture.magFilter=NearestFilter;
  texture.needsUpdate=true;
  const uniforms={torchData:{value:texture},torchDataRows:{value:capacity}};
  let dirty=false;
  const write=(offset:number,value:number)=>{const f=Math.fround(value);if(data[offset]!==f){data[offset]=f;dirty=true;}};
  return {texture,
    write(row:number,source:MiniatureLightUniforms){
      const base=row*WIDTH*4;
      write(base,source.torchCount.value);write(base+1,source.darkvisionDetail.value);
      for(let i=0;i<8;i++){
        const p=source.torchPositions.value[i],c=source.torchColors.value[i],pos=base+(1+i)*4,col=base+(9+i)*4;
        write(pos,p.x);write(pos+1,p.y);write(pos+2,p.z);write(pos+3,p.w);
        write(col,c.x);write(col+1,c.y);write(col+2,c.z);write(col+3,source.torchShadowSlots.value[i]);
      }
    },
    flush(){if(dirty){texture.needsUpdate=true;dirty=false;}},
    attach(material:Material){
      const hook=material.onBeforeCompile,cache=material.customProgramCacheKey();
      material.onBeforeCompile=function(shader,renderer){
        hook.call(this,shader,renderer);Object.assign(shader.uniforms,uniforms);
        shader.vertexShader='attribute float instanceTorchRow; varying float batchTorchRow;\n'+shader.vertexShader;
        shader.vertexShader=shader.vertexShader.replace('#include <project_vertex>','#include <project_vertex>\nbatchTorchRow=instanceTorchRow;');
        // Basic base materials have no torch hook; their shader is left intact.
        if(shader.fragmentShader.includes('uniform float torchDataRow;')){
          shader.fragmentShader=shader.fragmentShader
            .replace('uniform float torchDataRow;','varying float batchTorchRow;')
            .replace('(torchDataRow+.5)','(batchTorchRow+.5)');
        }
      };
      material.customProgramCacheKey=()=>cache+'-batched-light-rows-v2-world';
    },
    dispose(){texture.dispose();},
  };
}

/** Balanced/Low keep source selection uniform within a draw, packed into a single
 * 19x1 DataTexture to avoid per-material uniform array uploads across frames. */
export function createMiniatureSharedLighting(source:MiniatureLightUniforms){
  const data=new Float32Array(WIDTH*4),texture=new DataTexture(data,WIDTH,1,RGBAFormat,FloatType);
  texture.minFilter=texture.magFilter=NearestFilter;
  texture.needsUpdate=true;
  let dirty=false;
  const writeVal=(offset:number,value:number)=>{const f=Math.fround(value);if(data[offset]!==f){data[offset]=f;dirty=true;}};
  const uniforms={torchData:{value:texture},torchDataRow:{value:0},torchDataRows:{value:1},
    ...(source.torchGroundEnabled?{torchGroundEnabled:{value:source.torchGroundEnabled.value},torchGroundField:{value:source.torchGroundField!.value},torchGroundBounds:{value:source.torchGroundBounds!.value}}:{})};
  return {
    write(row:number,next:MiniatureLightUniforms){
      if(row!==0)return;
      writeVal(0,next.torchCount.value);writeVal(1,next.darkvisionDetail.value);
      for(let i=0;i<8;i++){
        const p=next.torchPositions.value[i],c=next.torchColors.value[i],pos=(1+i)*4,col=(9+i)*4;
        writeVal(pos,p.x);writeVal(pos+1,p.y);writeVal(pos+2,p.z);writeVal(pos+3,p.w);
        writeVal(col,c.x);writeVal(col+1,c.y);writeVal(col+2,c.z);writeVal(col+3,next.torchShadowSlots.value[i]);
      }
      if(uniforms.torchGroundEnabled&&next.torchGroundEnabled){uniforms.torchGroundEnabled.value=next.torchGroundEnabled.value;uniforms.torchGroundField!.value=next.torchGroundField!.value;uniforms.torchGroundBounds!.value=next.torchGroundBounds!.value;}
    },flush(){if(dirty){texture.needsUpdate=true;dirty=false;}},dispose(){texture.dispose();},
    attach(material:Material){
      const hook=material.onBeforeCompile,cache=material.customProgramCacheKey();
      material.onBeforeCompile=function(shader,renderer){hook.call(this,shader,renderer);Object.assign(shader.uniforms,uniforms);
        shader.vertexShader='attribute vec2 instanceGroundPoint;\n'+shader.vertexShader;
        shader.vertexShader=shader.vertexShader.replace('vec2 groundPoint=torchGroundPoint;','vec2 groundPoint=instanceGroundPoint;');
      };
      material.customProgramCacheKey=()=>cache+'-batched-shared-lights-v3-tex';
    },
  };
}
