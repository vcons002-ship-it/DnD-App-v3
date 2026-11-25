import {Box3, BufferAttribute, BufferGeometry, Color, DataTexture, DynamicDrawUsage, Mesh, NearestFilter, OrthographicCamera, RGBAFormat, Scene, ShaderMaterial, Vector2, Vector3, type Matrix4, type Object3D, type Texture, type WebGLRenderer} from 'three';
export type OutlineRect={x:number;y:number;width:number;height:number};
/** Match the placement group's one base offset without changing source poses. */
export function centeredMiniatureOutlineBounds(model:Object3D,baseCenter:readonly number[]):Box3 {
  return new Box3().setFromObject(model).translate(new Vector3(-baseCenter[0],-baseCenter[1],-baseCenter[2]));
}
/** Separate authored weapon parts get a faint rim; merged bodies still use the
 * general screen-width filter, so creature names do not dim whole figures. */
export function isMiniatureWeaponPart(name:string):boolean {
  return !/body|head|face|full.?model/i.test(name)&&/weapon|sword|knife|dagger|bow|axe|staff|spear|mace|hammer|trident|halberd|scimitar/i.test(name);
}
/** A border only touches the projected model bounds. Merge overlapping scissors
 * so translucent borders are never painted twice. Sparse boards avoid a full
 * screen filter over empty terrain. Rectangles use CSS pixels, bottom-left Y. */
export function mergeOutlineRects(rects:readonly OutlineRect[]):OutlineRect[]{
  const merged:OutlineRect[]=[];
  for(const rect of rects){
    if(rect.width<=0||rect.height<=0)continue;
    let r={...rect},i=0;
    while(i<merged.length){const b=merged[i];
      if(r.x<=b.x+b.width&&b.x<=r.x+r.width&&r.y<=b.y+b.height&&b.y<=r.y+r.height){
        const x=Math.min(r.x,b.x),y=Math.min(r.y,b.y);
        r={x,y,width:Math.max(r.x+r.width,b.x+b.width)-x,height:Math.max(r.y+r.height,b.y+b.height)-y};
        merged.splice(i,1);i=0;
      }else i++;
    }
    merged.push(r);
  }
  return merged;
}

/** Border palette IDs occupy G of the existing body mask; R/A remain unchanged for
 * personal visibility and raised body compositing. No model-shell geometry. */
export function createMiniatureSilhouetteOutline(mask: Texture, depth: Texture, inverse: {value: Matrix4}, highlightMask?: Texture) {
  // 2-row palette: row 0 = RGBA color, row 1 = style flags (R > 0.5 => bold, G > 0.5 => active-turn pulse).
  const bytes = new Uint8Array(256 * 2 * 4), slots = new Map<string, number>();
  const palette = new DataTexture(bytes, 256, 2, RGBAFormat);
  palette.minFilter = palette.magFilter = NearestFilter; palette.generateMipmaps = false;
  const material = new ShaderMaterial({
    uniforms: {body: {value: mask}, bodyDepth: {value: depth}, highlight: {value: highlightMask ?? mask}, hasHighlight: {value: 0}, hasBold: {value: 1}, turnPulse: {value: 1},
      palette: {value: palette}, inverseProjection: inverse,
      resolution: {value: new Vector2(1, 1)}, pixelRatio: {value: 1}},
    vertexShader: 'varying vec2 screenUv; void main(){screenUv=uv;gl_Position=vec4(position.xy,0.,1.);}',
    fragmentShader: `uniform sampler2D body,bodyDepth,highlight,palette; uniform float hasHighlight,hasBold,turnPulse; uniform vec2 resolution; uniform float pixelRatio;
      uniform mat4 inverseProjection; varying vec2 screenUv;
      vec2 snapUv(vec2 uv){return (floor(uv*resolution)+.5)/resolution;}
      vec4 maskAt(vec2 uv){return texture2D(body,snapUv(uv));}
      vec4 highlightAt(vec2 uv){return texture2D(highlight,snapUv(uv));}
      float depthAt(vec2 uv){return texture2D(bodyDepth,snapUv(uv)).r;}
      float indexOf(vec4 m){return floor(m.g*255.+.5);}
      float slotOf(vec4 m){return floor(m.b*255.+.5);}
      float viewDepth(vec2 uv){vec4 p=inverseProjection*vec4(uv*2.-1.,depthAt(uv)*2.-1.,1.);return p.z/p.w;}
      void main(){
        // Draw outlines over empty background AND over farther tokens behind the
        // silhouette, while never painting across the same miniature or over a
        // closer foreground figure.
        vec4 center=maskAt(screenUv);
        bool centerEmpty=center.a<.1;
        float centerSlot=slotOf(center);
        float centerDepth=centerEmpty?1.:depthAt(screenUv);
        float best=0.;float bestDepth=2.;vec4 border=vec4(0.);
        for(int i=0;i<8;i++){
          float angle=float(i)*.78539816339;vec2 direction=vec2(cos(angle),sin(angle));
          vec2 stepUv=direction*pixelRatio/resolution;
          vec2 edge=screenUv+stepUv*1.5;vec4 m=maskAt(edge);float id=indexOf(m);float eslot=slotOf(m);
          if(m.a>=.5&&id>=.5&&(centerEmpty||abs(eslot-centerSlot)>.5)){
            float edepth=depthAt(edge);
            if(centerEmpty||edepth<centerDepth){
              vec4 style=texture2D(palette,vec2((id+.5)/256.,.75));
              bool bold=style.r>.5;
              bool pulsing=style.g>.5;
              vec4 nearBody=maskAt(edge+stepUv*1.5),deepBody=maskAt(edge+stepUv*3.5);
              float coverage=nearBody.a*deepBody.a;
              if(abs(slotOf(nearBody)-eslot)>.5||abs(slotOf(deepBody)-eslot)>.5)coverage=0.;
              vec2 crossUv=vec2(-direction.y,direction.x)*pixelRatio/resolution*(bold?1.6:2.5);
              vec2 inner=edge+stepUv*2.;
              vec4 left=maskAt(inner-crossUv),right=maskAt(inner+crossUv);
              coverage*=left.a*right.a;
              if(abs(slotOf(left)-eslot)>.5||abs(slotOf(right)-eslot)>.5)coverage=0.;
              vec4 here=inverseProjection*vec4(edge*2.-1.,edepth*2.-1.,1.);
              float tolerance=10.*abs(inverseProjection[1][1]/here.w)/max(1.,resolution.y/pixelRatio);
              coverage*=1.-smoothstep(tolerance,tolerance*2.,max(0.,viewDepth(edge)-viewDepth(edge+stepUv*3.5)));
              vec4 color=texture2D(palette,vec2((id+.5)/256.,.25));
              if(pulsing)color.rgb=mix(color.rgb,vec3(1.,.96,.74),.38*turnPulse);
              float pulseMul=pulsing?mix(.62,1.,turnPulse):1.;
              float strength=(bold
                ? max(smoothstep(.15,.7,coverage),m.a*.85)*color.a
                : smoothstep(.25,.85,coverage)*color.a*.7)*pulseMul;
              if(strength>.01&&(edepth<bestDepth-.00001||(abs(edepth-bestDepth)<=.00001&&strength>best))){
                best=strength;bestDepth=edepth;border=color;
              }
            }
          }
          // Outer soft rim pass only when a selected/active/hovered bold outline exists.
          if(hasBold>.5){
            vec2 outerEdge=screenUv+stepUv*3.1;vec4 om=maskAt(outerEdge);float oid=indexOf(om);float oslot=slotOf(om);
            if(om.a>=.5&&oid>=.5&&(centerEmpty||abs(oslot-centerSlot)>.5)){
              float odepth=depthAt(outerEdge);
              if(centerEmpty||odepth<centerDepth){
                vec4 ostyle=texture2D(palette,vec2((oid+.5)/256.,.75));
                if(ostyle.r>.5){
                  bool opulsing=ostyle.g>.5;
                  vec4 ocolor=texture2D(palette,vec2((oid+.5)/256.,.25));
                  if(opulsing)ocolor.rgb=mix(ocolor.rgb,vec3(1.,.96,.74),.45*turnPulse);
                  float ostrength=ocolor.a*(opulsing?mix(.26,.88,turnPulse):.72);
                  if(ostrength>.01&&(odepth<bestDepth-.00001||(abs(odepth-bestDepth)<=.00001&&ostrength>best))){
                    best=ostrength;bestDepth=odepth;border=ocolor;
                  }
                }
              }
            }
          }
        }
        // X-ray shine-through pass: when a Selected or Hovered token is occluded
        // behind another miniature, draw a translucent silhouette rim through the
        // foreground figure so it remains unmistakable in congested crowds.
        if(hasHighlight>.5&&!centerEmpty){
          vec4 hcenter=highlightAt(screenUv);
          if(hcenter.a<.1){
            float xrayBest=0.;vec4 xrayColor=vec4(0.);
            for(int i=0;i<8;i++){
              float angle=float(i)*.78539816339;vec2 direction=vec2(cos(angle),sin(angle));
              vec2 stepUv=direction*pixelRatio/resolution;
              vec2 hedge=screenUv+stepUv*1.7;vec4 hm=highlightAt(hedge);float hid=indexOf(hm);float hslot=slotOf(hm);
              if(hm.a>=.5&&hid>=.5&&abs(hslot-centerSlot)>.5){
                vec4 hc=texture2D(palette,vec2((hid+.5)/256.,.25));
                float s=hc.a*.56;
                if(s>xrayBest){xrayBest=s;xrayColor=hc;}
              }
              vec2 houter=screenUv+stepUv*3.0;vec4 hom=highlightAt(houter);float hoid=indexOf(hom);float hoslot=slotOf(hom);
              if(hom.a>=.5&&hoid>=.5&&abs(hoslot-centerSlot)>.5){
                vec4 hoc=texture2D(palette,vec2((hoid+.5)/256.,.25));
                float s=hoc.a*.32;
                if(s>xrayBest){xrayBest=s;xrayColor=hoc;}
              }
            }
            if(xrayBest>.01){
              if(best<.01){border=xrayColor;best=xrayBest;}
              else{border.rgb=mix(border.rgb,xrayColor.rgb,xrayBest);best=max(best,xrayBest);}
            }
          }
        }
        if(best<.01)discard;
        gl_FragColor=vec4(border.rgb,best);
      }`,
    transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
  });
  const scene = new Scene(), camera = new OrthographicCamera(-1,1,1,-1,0,1);
  let capacity = 32;
  let positions = new Float32Array(capacity * 6 * 3), uvs = new Float32Array(capacity * 6 * 2);
  let geometry = new BufferGeometry();
  let posAttr = new BufferAttribute(positions, 3).setUsage(DynamicDrawUsage);
  let uvAttr = new BufferAttribute(uvs, 2).setUsage(DynamicDrawUsage);
  geometry.setAttribute('position', posAttr);
  geometry.setAttribute('uv', uvAttr);
  geometry.setDrawRange(0, 0);
  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  scene.add(mesh);
  const ensureCapacity = (rects: number) => {
    if (rects <= capacity) return;
    capacity = 2 ** Math.ceil(Math.log2(rects));
    geometry.dispose();
    positions = new Float32Array(capacity * 6 * 3);
    uvs = new Float32Array(capacity * 6 * 2);
    geometry = new BufferGeometry();
    posAttr = new BufferAttribute(positions, 3).setUsage(DynamicDrawUsage);
    uvAttr = new BufferAttribute(uvs, 2).setUsage(DynamicDrawUsage);
    geometry.setAttribute('position', posAttr);
    geometry.setAttribute('uv', uvAttr);
    mesh.geometry = geometry;
  };
  const writeQuad = (index: number, x0: number, y0: number, x1: number, y1: number, u0: number, v0: number, u1: number, v1: number) => {
    const p = index * 18, t = index * 12;
    positions[p] = x0; positions[p+1] = y0; positions[p+2] = 0;
    positions[p+3] = x1; positions[p+4] = y0; positions[p+5] = 0;
    positions[p+6] = x1; positions[p+7] = y1; positions[p+8] = 0;
    positions[p+9] = x0; positions[p+10] = y0; positions[p+11] = 0;
    positions[p+12] = x1; positions[p+13] = y1; positions[p+14] = 0;
    positions[p+15] = x0; positions[p+16] = y1; positions[p+17] = 0;
    uvs[t] = u0; uvs[t+1] = v0;
    uvs[t+2] = u1; uvs[t+3] = v0;
    uvs[t+4] = u1; uvs[t+5] = v1;
    uvs[t+6] = u0; uvs[t+7] = v0;
    uvs[t+8] = u1; uvs[t+9] = v1;
    uvs[t+10] = u0; uvs[t+11] = v1;
  };
  return {
    slot(color: string | undefined, opacity = 1, bold = false, pulse = false) {
      if (!color) return 0;
      const key = `${color}:${opacity}:${bold ? 1 : 0}:${pulse ? 1 : 0}`; let id = slots.get(key);
      if (id !== undefined) return id;
      if (slots.size >= 255) return 0;
      id = slots.size + 1; slots.set(key, id);
      // The overlay writes display-space colors, matching the existing border.
      const c = new Color(color).convertLinearToSRGB();
      bytes.set([Math.round(c.r*255),Math.round(c.g*255),Math.round(c.b*255),Math.round(opacity*255)], id*4);
      bytes.set([bold ? 255 : 0, pulse ? 255 : 0, 0, 255], (256 + id) * 4);
      palette.needsUpdate = true; return id;
    },
    render(renderer: WebGLRenderer,rectangles?:readonly OutlineRect[],hasHighlight=false,hasBold=true,turnPulse=1) {
      material.uniforms.resolution.value.set(renderer.domElement.width,renderer.domElement.height);
      const pixelRatio=renderer.getPixelRatio();
      material.uniforms.pixelRatio.value=pixelRatio;
      material.uniforms.hasHighlight.value=hasHighlight?1:0;
      material.uniforms.hasBold.value=hasBold?1:0;
      material.uniforms.turnPulse.value=turnPulse;
      let count = 0;
      if (rectangles) {
        const merged = mergeOutlineRects(rectangles);
        if (!merged.length) return;
        count = merged.length;
        ensureCapacity(count);
        const cssW = Math.max(1, renderer.domElement.width / pixelRatio);
        const cssH = Math.max(1, renderer.domElement.height / pixelRatio);
        for (let i = 0; i < count; i++) {
          const r = merged[i];
          const u0 = r.x / cssW, u1 = (r.x + r.width) / cssW;
          const v0 = r.y / cssH, v1 = (r.y + r.height) / cssH;
          writeQuad(i, u0 * 2 - 1, v0 * 2 - 1, u1 * 2 - 1, v1 * 2 - 1, u0, v0, u1, v1);
        }
      } else {
        count = 1;
        ensureCapacity(1);
        writeQuad(0, -1, -1, 1, 1, 0, 0, 1, 1);
      }
      posAttr.needsUpdate = true;
      uvAttr.needsUpdate = true;
      geometry.setDrawRange(0, count * 6);
      const autoClear=renderer.autoClear;
      renderer.autoClear=false;
      try { renderer.render(scene,camera); }
      finally { renderer.autoClear=autoClear; }
    },
    dispose(){geometry.dispose();material.dispose();palette.dispose();},
  };
}
