import Konva from 'konva';
import {invalidateRetainedToken} from './retainedTokenLayer';
import {TETHER_PILL_COVERED_OPACITY} from '../lib/tetherPillPlacement';

export type MiniatureNameLabel = {
  id: string;
  canvas: HTMLCanvasElement;
  /** Top-left, top-right, bottom-left, bottom-right in map coordinates. */
  points: {x:number;y:number}[];
  opacity: number;
  emphasized: boolean;
  /** Render even without a 3D miniature token (e.g. attack tether range pill). */
  alwaysVisible?: boolean;
  /** Opacity multiplier when depth-covered by a 3D miniature silhouette. */
  coveredOpacity?: number;
};

const depthHudSelector='.token-label, .token-tracking-tag, .token-health';

/** GPU names/health replace only the scene paint; their Konva nodes retain typography
 * and transforms for texture generation. Opacity zero still makes Konva paint
 * stroked text through a full-layer perfect-draw buffer on every movement. */
export function setMiniatureNamesRendered(layer:Konva.Layer,ids:ReadonlySet<string>) {
  let changed=false;
  for(const node of layer.getChildren().filter((n):n is Konva.Group=>n instanceof Konva.Group&&n.hasName('token'))) {
    const visible=!ids.has(node.getAttr('tokenId'));
    const version=node.getAttr('tokenLabelVersion');
    const old=paintSuppression.get(node);
    if(old?.visible===visible&&old.version===version)continue;
    paintSuppression.set(node,{visible,version});
    for(const label of node.find(depthHudSelector)) {
      if(label.visible()!==visible){label.visible(visible);invalidateRetainedToken(node);changed=true;}
    }
  }
  if(changed)layer.batchDraw();
}
const paintSuppression=new WeakMap<Konva.Group,{visible:boolean;version:unknown}>();

/** Rasterize the existing name/tag/health HUD only when its content changes.
 * Positions follow the live Konva transforms, including drag and camera rotation. */
export function createMiniatureNameReader() {
  const cache=new Map<string,{key:string;poseKey:string;points:{x:number;y:number}[];node:Konva.Group;hud:Konva.Group;canvas:HTMLCanvasElement;bounds:{x:number;y:number;width:number;height:number}}>();
  return (layer:Konva.Layer|null,emphasized:(id:string)=>boolean):MiniatureNameLabel[]=>{
    if(!layer){cache.clear();return [];}
    const inverse=layer.getAbsoluteTransform().copy().invert();
    const density=Math.min(4,Math.max(2,Math.ceil(layer.scaleX()*Math.min(2,window.devicePixelRatio||1))));
    const present=new Set<string>();
    const result:MiniatureNameLabel[]=[];
    for(const node of layer.getChildren().filter((n):n is Konva.Group=>n instanceof Konva.Group&&n.hasName('token'))) {
      if(!node.visible()||node.getAbsoluteOpacity()<=0)continue;
      const id=node.getAttr('tokenId') as string;
      let entry=cache.get(id);
      const version=node.getAttr('tokenLabelVersion');
      const key=JSON.stringify([density,version]);
      const reusable=entry?.node===node&&entry.key===key&&version!==undefined;
      const hud=reusable?entry!.hud:node.findOne<Konva.Group>('.token-upright-hud');
      if(!hud||!hud.visible())continue;
      present.add(id);
      // TokenShape publishes typography/layout and visible HP changes. Motion,
      // selection and torch flicker reuse these HUD pixels.
      if(!reusable){
        const labels=hud.find(depthHudSelector);
        if(!labels.length){cache.delete(id);continue;}
        const group=new Konva.Group({listening:false});
        for(const label of labels)group.add(label.clone({opacity:label.opacity(),visible:true,listening:false}));
        const b=group.getClientRect();
        const bounds={x:Math.floor(b.x)-1,y:Math.floor(b.y)-1,width:Math.ceil(b.width)+3,height:Math.ceil(b.height)+3};
        const canvas=group.toCanvas({...bounds,pixelRatio:density});
        group.destroy();entry={key,poseKey:'',points:[],node,hud,canvas,bounds};cache.set(id,entry);
      }
      const poseKey=[node.x(),node.y(),hud.x(),hud.y(),hud.rotation()].join(':');
      if(entry!.poseKey!==poseKey){const b=entry!.bounds,matrix=inverse.copy().multiply(hud.getAbsoluteTransform());entry!.points=[{x:b.x,y:b.y},{x:b.x+b.width,y:b.y},{x:b.x,y:b.y+b.height},{x:b.x+b.width,y:b.y+b.height}].map(p=>matrix.point(p));entry!.poseKey=poseKey;}const points=entry!.points;
      result.push({id,canvas:entry!.canvas,points,opacity:node.getAbsoluteOpacity(),emphasized:emphasized(id)});
    }
    for(const id of cache.keys())if(!present.has(id))cache.delete(id);
    return result;
  };
}

/** Hide only the Konva paint children of GPU-rendered tether pills while
 *  keeping the parent group active so transforms/attrs continue updating. */
export function setTetherPillsRendered(layer:Konva.Layer,ids:ReadonlySet<string>) {
  let changed=false;
  for(const pill of layer.find('.ray-mid-pill')) {
    if(!(pill instanceof Konva.Group))continue;
    const id=pill.getAttr('pillId') as string|undefined;
    const showKonva=!id||!ids.has(id);
    for(const child of pill.find('.ray-mid-pill-bg, .ray-mid-pill-text')) {
      if(child.visible()!==showKonva){child.visible(showKonva);changed=true;}
    }
  }
  if(changed)layer.batchDraw();
}

/** Rasterize attack tether range pills once per text/color change and track
 *  their live map-space quad so the 3D name layer can depth-mask them behind
 *  miniatures using the same fade-when-covered shader as token names. */
export function createTetherPillReader() {
  const cache=new Map<string,{styleKey:string;canvas:HTMLCanvasElement;refW:number;refH:number;refPad:number;poseKey:string;points:{x:number;y:number}[]}>();
  return (layer:Konva.Layer|null):MiniatureNameLabel[]=>{
    if(!layer){cache.clear();return [];}
    const pills=layer.find('.ray-mid-pill');
    if(!pills.length){cache.clear();return [];}
    const inverse=layer.getAbsoluteTransform().copy().invert();
    const present=new Set<string>();
    const result:MiniatureNameLabel[]=[];
    for(const pill of pills) {
      if(!(pill instanceof Konva.Group)||!pill.isVisible()||pill.getAbsoluteOpacity()<=0)continue;
      const id=pill.getAttr('pillId') as string|undefined;
      const label=String(pill.getAttr('pillLabel')??'');
      const outOfRange=Boolean(pill.getAttr('pillOutOfRange'));
      const border=String(pill.getAttr('pillBorder')??'#8e96a4');
      const spark=String(pill.getAttr('pillSpark')??'#eef2f7');
      const pillW=Number(pill.getAttr('pillW')??0);
      const pillH=Number(pill.getAttr('pillH')??0);
      if(!id||!label||!(pillW>0)||!(pillH>0))continue;
      present.add(id);
      const styleKey=`${label}|${outOfRange?1:0}|${border}|${spark}`;
      let entry=cache.get(id);
      if(!entry||entry.styleKey!==styleKey) {
        const refFont=14;
        const refH=refFont*1.55;
        const refW=Math.max(refFont*3.0,label.length*refFont*0.62+refFont*1.0);
        const refStroke=refFont*0.095;
        const refPad=Math.ceil(refStroke*2)+2;
        const group=new Konva.Group({listening:false});
        group.add(new Konva.Rect({
          width:refW,
          height:refH,
          fill:'rgba(14, 17, 24, 0.62)',
          opacity:0.82,
          stroke:outOfRange?'#e07b67':border,
          strokeWidth:refStroke,
          cornerRadius:refH/2,
          listening:false,
        }));
        group.add(new Konva.Text({
          width:refW,
          height:refH,
          align:'center',
          verticalAlign:'middle',
          text:label,
          fill:outOfRange?'#ffb3a3':spark,
          stroke:'rgba(0, 0, 0, 0.72)',
          strokeWidth:refFont*0.14,
          fillAfterStrokeEnabled:true,
          fontStyle:'bold',
          fontSize:refFont,
          listening:false,
        }));
        const canvas=group.toCanvas({x:-refPad,y:-refPad,width:refW+refPad*2,height:refH+refPad*2,pixelRatio:2});
        group.destroy();
        entry={styleKey,canvas,refW,refH,refPad,poseKey:'',points:[]};
        cache.set(id,entry);
      }
      const poseKey=[pill.x(),pill.y(),pill.rotation(),pill.scaleX(),pill.scaleY(),pill.offsetX(),pill.offsetY(),pillW,pillH].join(':');
      if(entry.poseKey!==poseKey) {
        const padX=entry.refPad*(pillW/entry.refW);
        const padY=entry.refPad*(pillH/entry.refH);
        const matrix=inverse.copy().multiply(pill.getAbsoluteTransform());
        entry.points=[
          {x:-padX,y:-padY},
          {x:pillW+padX,y:-padY},
          {x:-padX,y:pillH+padY},
          {x:pillW+padX,y:pillH+padY},
        ].map(p=>matrix.point(p));
        entry.poseKey=poseKey;
      }
      result.push({
        id,
        canvas:entry.canvas,
        points:entry.points,
        opacity:pill.getAbsoluteOpacity(),
        emphasized:false,
        alwaysVisible:true,
        coveredOpacity:TETHER_PILL_COVERED_OPACITY,
      });
    }
    for(const id of cache.keys())if(!present.has(id))cache.delete(id);
    return result;
  };
}
