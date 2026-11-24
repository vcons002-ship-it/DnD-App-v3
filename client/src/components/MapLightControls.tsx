import {useSyncExternalStore} from 'react';
import type {MapState} from '../../../shared/types';
import {DEFAULT_MAP_ENVIRONMENT,newMapLightSettings,mapLightColorHex,sanitizeMapLightColor,type MapEnvironmentLight,type MapLightDefaults,type MapLightColor,type MapEnvironment} from '../../../shared/mapEnvironment';
import {useStore} from '../state/socket';
import {useEnvironmentEditor} from '../lib/useEnvironmentEditor';
import {SettingSlider} from './MapSettingSlider';

export type CopiedLightStyle = Omit<MapEnvironmentLight, 'id' | 'x' | 'y'>;
let copiedLightStyle: CopiedLightStyle | null = null;
const styleListeners = new Set<() => void>();
function setCopiedLightStyle(next: CopiedLightStyle) {
  copiedLightStyle = next;
  for (const fn of styleListeners) fn();
}
function subscribeCopiedLightStyle(cb: () => void) {
  styleListeners.add(cb);
  return () => { styleListeners.delete(cb); };
}
function getCopiedLightStyle() {
  return copiedLightStyle;
}

export function LightColorControl({label,caption='Color',color,onChange}:{label:string;caption?:string;color:MapLightColor;onChange:(color:MapLightColor)=>void}){
  return <label className="environment-light-color">{caption}
    <input type="color" aria-label={`${label} picker`} value={mapLightColorHex(color)} onChange={e=>onChange(sanitizeMapLightColor(e.target.value))}/>
    <select aria-label={label} value={color.startsWith('#')?'custom':color} onChange={e=>onChange(sanitizeMapLightColor(e.target.value))}>
      <option value="warm">Warm</option><option value="cool">Cool</option><option value="green">Eerie green</option><option value="custom" disabled>Custom</option>
    </select>
  </label>;
}

export function BulkLightFields({lights,allLights,onUpdateLights,onApplyAsDefault}:{
  lights:MapEnvironmentLight[];
  allLights:MapEnvironmentLight[];
  onUpdateLights:(next:MapEnvironmentLight[],newColor?:MapLightColor)=>void;
  onApplyAsDefault?:(style:CopiedLightStyle)=>void;
}){
  const clipboardStyle = useSyncExternalStore(subscribeCopiedLightStyle, getCopiedLightStyle);
  if(!lights.length)return null;
  const selectedIds=new Set(lights.map(l=>l.id));
  const primary=lights[0];
  const anyEnabled=lights.some(l=>l.enabled!==false);
  const patchSelected=(patch:Partial<MapEnvironmentLight>,newColor?:MapLightColor)=>{
    onUpdateLights(allLights.map(l=>selectedIds.has(l.id)?{...l,...patch}:l),newColor);
  };
  const extractStyle=(l:MapEnvironmentLight):CopiedLightStyle=>({
    enabled:l.enabled!==false,
    color:l.color,
    radiusFt:l.radiusFt,
    heightFt:l.heightFt,
    intensity:l.intensity,
    flicker:l.flicker,
    fixture:l.fixture??'torch',
    visibleTorch:!!l.visibleTorch,
  });
  const labelPrefix=lights.length===1?`Light`:`${lights.length} lights`;
  return <div className="bulk-light-fields" style={{display:'grid',gap:6}}>
    <div style={{display:'flex',gap:4,flexWrap:'wrap'}}>
      <button
        type="button"
        className="btn tiny"
        title="Copy color, radius, height, intensity, flicker, and fixture from this light"
        onClick={()=>setCopiedLightStyle(extractStyle(primary))}
      >
        Copy style
      </button>
      <button
        type="button"
        className="btn tiny"
        disabled={!clipboardStyle}
        title={clipboardStyle?`Paste copied ${clipboardStyle.color} ${clipboardStyle.radiusFt}ft light preset onto selected light(s)`:'Copy a light style first'}
        onClick={()=>{if(clipboardStyle)patchSelected(clipboardStyle,clipboardStyle.color);}}
      >
        Paste style
      </button>
      {onApplyAsDefault&&<button
        type="button"
        className="btn tiny"
        title="Use this light's settings as the default for newly placed lights"
        onClick={()=>onApplyAsDefault(extractStyle(primary))}
      >
        Use for new
      </button>}
    </div>
    <label className="environment-toggle">
      <input type="checkbox" checked={anyEnabled} onChange={e=>patchSelected({enabled:e.target.checked})}/>
      {lights.length===1?'Light enabled (on)':`Selected lights on (${lights.filter(l=>l.enabled!==false).length}/${lights.length})`}
    </label>
    <LightColorControl label={`${labelPrefix} color`} color={primary.color} onChange={color=>patchSelected({color},color)}/>
    <SettingSlider label="Lit radius" value={primary.radiusFt} min={3} max={60} suffix=" ft" onCommit={radiusFt=>patchSelected({radiusFt})}/>
    <SettingSlider label="Height" value={primary.heightFt} min={.5} max={30} step={.5} suffix=" ft" onCommit={heightFt=>patchSelected({heightFt})}/>
    <SettingSlider label="Strength" value={Math.round(primary.intensity*100)} min={10} max={200} suffix="%" onCommit={v=>patchSelected({intensity:v/100})}/>
    <label className="environment-toggle">
      <input type="checkbox" checked={lights.every(l=>l.flicker)} onChange={e=>patchSelected({flicker:e.target.checked})}/>
      Gentle flicker
    </label>
    <label style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:8}}>
      <span>Model</span>
      <select aria-label={`${labelPrefix} model`} value={primary.fixture??'torch'} onChange={e=>patchSelected({fixture:e.target.value as 'torch'|'lantern'})}>
        <option value="torch">Torch</option>
        <option value="lantern">Lantern</option>
      </select>
    </label>
    <label className="environment-toggle">
      <input type="checkbox" checked={lights.some(l=>!!l.visibleTorch)} onChange={e=>patchSelected({visibleTorch:e.target.checked})}/>
      Show 3D {primary.fixture==='lantern'?'lantern':'torch'}
    </label>
  </div>;
}

export function MapLightControls({map,onPlace,onSelectAllLights}:{map:MapState;onPlace:(lightId?:string)=>void;onSelectAllLights?:()=>void}){
  const settings=map.environment??DEFAULT_MAP_ENVIRONMENT;
  const save=useStore(s=>s.setMapEnvironment);
  const {placement,place}=useEnvironmentEditor();
  const update=(patch:Partial<MapEnvironment>)=>save(map.id,patch);
  const defaults=newMapLightSettings(settings);
  const updateDefaults=(patch:Partial<MapLightDefaults>)=>update({newLightDefaults:patch});
  const anyLit=settings.lights.some(l=>l.enabled!==false);
  const toggleAllLights=()=>update({lights:settings.lights.map(l=>({...l,enabled:!anyLit}))});
  return <div className="map-light-controls">
        {settings.lights.length>0&&<div style={{display:'flex',gap:6,flexWrap:'wrap',marginBottom:6}}>
          <button type="button" className={`btn tiny ${anyLit?'on':''}`} onClick={toggleAllLights}>
            {anyLit?'Turn all lights off':'Turn all lights on'}
          </button>
          {onSelectAllLights&&<button type="button" className="btn tiny" onClick={onSelectAllLights}>
            Select all lights ({settings.lights.length})
          </button>}
        </div>}
        <strong>New light settings</strong>
        <LightColorControl label="New light color" caption="New light color" color={settings.newLightColor??'warm'} onChange={color=>update({newLightColor:color})}/>
        <SettingSlider label="New light lit radius" value={defaults.radiusFt} min={3} max={60} suffix=" ft" onCommit={radiusFt=>updateDefaults({radiusFt})}/>
        <SettingSlider label="New light height" value={defaults.heightFt} min={.5} max={30} step={.5} suffix=" ft" onCommit={heightFt=>updateDefaults({heightFt})}/>
        <SettingSlider label="New light strength" value={defaults.intensity*100} min={10} max={200} suffix="%" onCommit={v=>updateDefaults({intensity:v/100})}/>
        <label className="environment-toggle"><input aria-label="New light gentle flicker" type="checkbox" checked={defaults.flicker} onChange={e=>updateDefaults({flicker:e.target.checked})}/>Gentle flicker</label>
        <label>Model <select aria-label="New light model" value={defaults.fixture} onChange={e=>updateDefaults({fixture:e.target.value as 'torch'|'lantern'})}><option value="torch">Torch</option><option value="lantern">Lantern</option></select></label>
        <label className="environment-toggle"><input aria-label="New light show 3D fixture" type="checkbox" checked={!!defaults.visibleTorch} onChange={e=>updateDefaults({visibleTorch:e.target.checked})}/>Show 3D fixture</label>
        <small>Saved for every new light on this map. Click repeatedly to add lights; right-click or double-click any light marker on the map to edit it.</small>
        {placement?.mapId===map.id?<button className="btn tiny" onClick={()=>place(null)}>Cancel light placement</button>:<button className="btn tiny" onClick={()=>onPlace()}>Place light on map</button>}
        <div className="environment-light-list">{settings.lights.map((light,index)=>{
          const edit=(patch:Partial<typeof light>)=>update({lights:settings.lights.map(l=>l.id===light.id?{...l,...patch}:l)});
          const isOn=light.enabled!==false;
          return <details key={light.id}><summary>Light {index+1} · {light.color}{isOn?'':' (off)'}</summary>
            <label className="environment-toggle"><input type="checkbox" checked={isOn} onChange={e=>edit({enabled:e.target.checked})}/>Enabled (on)</label>
            <LightColorControl label={`Light ${index+1} color`} color={light.color} onChange={color=>update({newLightColor:color,lights:settings.lights.map(l=>l.id===light.id?{...l,color}:l)})}/>
            <SettingSlider label={`Light ${index+1} lit radius`} value={light.radiusFt} min={3} max={60} suffix=" ft" onCommit={v=>edit({radiusFt:v})}/>
            <SettingSlider label={`Light ${index+1} height`} value={light.heightFt} min={.5} max={30} step={.5} suffix=" ft" onCommit={v=>edit({heightFt:v})}/>
            <SettingSlider label={`Light ${index+1} strength`} value={light.intensity*100} min={10} max={200} suffix="%" onCommit={v=>edit({intensity:v/100})}/>
            <label className="environment-toggle"><input type="checkbox" checked={light.flicker} onChange={e=>edit({flicker:e.target.checked})}/>Gentle flicker</label>
            <label>Model <select aria-label={`Light ${index+1} model`} value={light.fixture??'torch'} onChange={e=>edit({fixture:e.target.value as 'torch'|'lantern'})}><option value="torch">Torch</option><option value="lantern">Lantern</option></select></label>
            <label className="environment-toggle"><input type="checkbox" checked={!!light.visibleTorch} onChange={e=>edit({visibleTorch:e.target.checked})}/>Show 3D {light.fixture==='lantern'?'lantern':'torch'}</label>
            <button className="btn tiny" onClick={()=>onPlace(light.id)}>Move light {index+1}</button>
            <button className="btn tiny" onClick={()=>{update({lights:settings.lights.filter(l=>l.id!==light.id)});place(null);}}>Remove light {index+1}</button>
          </details>;
        })}</div>

  </div>;
}
