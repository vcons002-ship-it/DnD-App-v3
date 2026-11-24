import {db} from './db.js';
import {getMap,getToken,updateMapEnvironment} from './sessions.js';
import {pushUndo} from './undo.js';
import {insertRow} from './backup.js';
import {sanitizeWalls,type MapWall} from '../../shared/mapWalls.js';
import {translateWall} from '../../shared/wallGeometry.js';
import type {MapEnvironmentLight} from '../../shared/mapEnvironment.js';

/** DM-owned selection, deleted as one action; undo preserves later unrelated edits. */
export function deleteMapFeatures(sessionId:string,mapId:string,wallIds:unknown,lightIds:unknown):string|null {
 const valid=(ids:unknown):ids is string[]=>Array.isArray(ids)&&ids.length<=10000&&ids.every(id=>typeof id==='string')&&new Set(ids).size===ids.length;
 if(!valid(wallIds)||!valid(lightIds)||!wallIds.length&&!lightIds.length)return 'Select walls, doors, windows or lights to delete.';
 const map=getMap(mapId);if(!map||map.sessionId!==sessionId)return 'Map not found in this campaign.';
 const removedWalls=(map.walls??[]).filter(w=>wallIds.includes(w.id)),removedLights=(map.environment?.lights??[]).filter(l=>lightIds.includes(l.id));
 if(!removedWalls.length&&!removedLights.length)return null;
 const tokens=removedWalls.flatMap(w=>w.tokenId?[db.prepare('SELECT * FROM tokens WHERE id=? AND map_id=?').get(w.tokenId,mapId) as Record<string,unknown>|undefined]:[]).filter((row):row is Record<string,unknown>=>!!row);
 db.transaction(()=>{
  db.prepare('UPDATE maps SET walls=? WHERE id=? AND session_id=?').run(JSON.stringify((map.walls??[]).filter(w=>!wallIds.includes(w.id))),mapId,sessionId);
  for(const t of tokens)db.prepare('DELETE FROM tokens WHERE id=? AND map_id=?').run(t.id,mapId);
  if(removedLights.length)updateMapEnvironment(sessionId,mapId,{lights:(map.environment?.lights??[]).filter(l=>!lightIds.includes(l.id))});
 })();
 pushUndo(sessionId,'Delete map features',()=>db.transaction(()=>{
  const current=getMap(mapId);if(!current||current.sessionId!==sessionId)throw Error('Map no longer exists.');
  const walls=current.walls??[],lights=current.environment?.lights??[];
  db.prepare('UPDATE maps SET walls=? WHERE id=?').run(JSON.stringify([...walls,...removedWalls.filter(w=>!walls.some(old=>old.id===w.id))]),mapId);
  if(removedLights.length)updateMapEnvironment(sessionId,mapId,{lights:[...lights,...removedLights.filter(l=>!lights.some(old=>old.id===l.id))]});
  for(const t of tokens)if(!db.prepare('SELECT id FROM tokens WHERE id=?').get(t.id))insertRow('tokens',t);
 })());return null;
}

/** Duplicate selected non-door walls and lights in one atomic undoable action. */
export function duplicateMapFeatures(
 sessionId:string,
 mapId:string,
 wallCopies:unknown,
 lightCopies:unknown,
 dx:unknown,
 dy:unknown,
):string|null {
 if(typeof dx!=='number'||typeof dy!=='number'||!Number.isFinite(dx)||!Number.isFinite(dy)||Math.abs(dx)>100_000||Math.abs(dy)>100_000){
  return 'Invalid duplicate offset.';
 }
 const validPairs=(arr:unknown):arr is {sourceId:string;newId:string}[]=>
  Array.isArray(arr)&&arr.length<=2000&&arr.every(x=>x&&typeof x==='object'&&typeof (x as {sourceId?:unknown}).sourceId==='string'&&typeof (x as {newId?:unknown}).newId==='string'&&/^[\w-]{1,80}$/.test((x as {newId:string}).newId));
 const wPairs=wallCopies===undefined?[]:validPairs(wallCopies)?wallCopies:null;
 const lPairs=lightCopies===undefined?[]:validPairs(lightCopies)?lightCopies:null;
 if(!wPairs||!lPairs||(!wPairs.length&&!lPairs.length))return 'Select walls or lights to duplicate.';
 const map=getMap(mapId);if(!map||map.sessionId!==sessionId)return 'Map not found in this campaign.';
 const curWalls=map.walls??[];
 const curLights=map.environment?.lights??[];
 const wallById=new Map(curWalls.map(w=>[w.id,w]));
 const lightById=new Map(curLights.map(l=>[l.id,l]));
 const existingWallIds=new Set(curWalls.map(w=>w.id));
 const existingLightIds=new Set(curLights.map(l=>l.id));

 const addedWalls:MapWall[]=sanitizeWalls(wPairs.flatMap(({sourceId,newId})=>{
  const src=wallById.get(sourceId);
  if(!src||src.door||existingWallIds.has(newId))return [];
  existingWallIds.add(newId);
  const {door:_d,open:_o,tokenId:_t,...clean}=src;
  return [translateWall({...clean,id:newId},dx,dy)];
 }));
 const addedLights:MapEnvironmentLight[]=lPairs.flatMap(({sourceId,newId})=>{
  const src=lightById.get(sourceId);
  if(!src||existingLightIds.has(newId))return [];
  existingLightIds.add(newId);
  return [{...src,id:newId,x:src.x+dx,y:src.y+dy}];
 });
 if(!addedWalls.length&&!addedLights.length)return 'Doors must be cut into a wall; select walls, windows, arches, or lights to duplicate.';

 const addedWallIds=new Set(addedWalls.map(w=>w.id));
 const addedLightIds=new Set(addedLights.map(l=>l.id));
 db.transaction(()=>{
  if(addedWalls.length)db.prepare('UPDATE maps SET walls=? WHERE id=? AND session_id=?').run(JSON.stringify([...curWalls,...addedWalls]),mapId,sessionId);
  if(addedLights.length)updateMapEnvironment(sessionId,mapId,{lights:[...curLights,...addedLights]});
 })();
 pushUndo(sessionId,'Duplicate map features',()=>db.transaction(()=>{
  const cur=getMap(mapId);if(!cur||cur.sessionId!==sessionId)throw Error('Map no longer exists.');
  if(addedWallIds.size)db.prepare('UPDATE maps SET walls=? WHERE id=?').run(JSON.stringify((cur.walls??[]).filter(w=>!addedWallIds.has(w.id))),mapId);
  if(addedLightIds.size)updateMapEnvironment(sessionId,mapId,{lights:(cur.environment?.lights??[]).filter(l=>!addedLightIds.has(l.id))});
 })());
 return null;
}

/** Translate multiple selected walls and lights together in one atomic undoable action. */
export function moveMapFeatures(
 sessionId:string,
 mapId:string,
 wallIds:unknown,
 lightIds:unknown,
 dx:unknown,
 dy:unknown,
):string|null {
 if(typeof dx!=='number'||typeof dy!=='number'||!Number.isFinite(dx)||!Number.isFinite(dy)||Math.abs(dx)>100_000||Math.abs(dy)>100_000){
  return 'Invalid move offset.';
 }
 if(Math.hypot(dx,dy)<1e-6)return null;
 const valid=(ids:unknown):ids is string[]=>Array.isArray(ids)&&ids.length<=10000&&ids.every(id=>typeof id==='string');
 if(!valid(wallIds)||!valid(lightIds)||(!wallIds.length&&!lightIds.length))return null;
 const map=getMap(mapId);if(!map||map.sessionId!==sessionId)return 'Map not found in this campaign.';
 const wSet=new Set(wallIds),lSet=new Set(lightIds);
 const curWalls=map.walls??[],curLights=map.environment?.lights??[];
 const savedWalls=new Map<string,MapWall>();
 const savedDoorTokens:{id:string;x:number;y:number}[]=[];
 const savedLights=new Map<string,MapEnvironmentLight>();

 const nextWalls=curWalls.map(w=>{
  if(!wSet.has(w.id))return w;
  savedWalls.set(w.id,{...w});
  if(w.tokenId){
   const tok=getToken(w.tokenId);
   if(tok)savedDoorTokens.push({id:tok.id,x:tok.x,y:tok.y});
  }
  return translateWall(w,dx,dy);
 });
 const nextLights=curLights.map(l=>{
  if(!lSet.has(l.id))return l;
  savedLights.set(l.id,{...l});
  return {...l,x:l.x+dx,y:l.y+dy};
 });
 if(!savedWalls.size&&!savedLights.size)return null;

 db.transaction(()=>{
  if(savedWalls.size){
   db.prepare('UPDATE maps SET walls=? WHERE id=? AND session_id=?').run(JSON.stringify(nextWalls),mapId,sessionId);
   for(const w of nextWalls)if(wSet.has(w.id)&&w.tokenId)db.prepare('UPDATE tokens SET x=?, y=? WHERE id=? AND map_id=?').run((w.ax+w.bx)/2,(w.ay+w.by)/2,w.tokenId,mapId);
  }
  if(savedLights.size)updateMapEnvironment(sessionId,mapId,{lights:nextLights});
 })();
 pushUndo(sessionId,'Move map features',()=>db.transaction(()=>{
  const cur=getMap(mapId);if(!cur||cur.sessionId!==sessionId)throw Error('Map no longer exists.');
  if(savedWalls.size){
   db.prepare('UPDATE maps SET walls=? WHERE id=?').run(JSON.stringify((cur.walls??[]).map(w=>savedWalls.get(w.id)??w)),mapId);
   for(const t of savedDoorTokens)db.prepare('UPDATE tokens SET x=?, y=? WHERE id=? AND map_id=?').run(t.x,t.y,t.id,mapId);
  }
  if(savedLights.size)updateMapEnvironment(sessionId,mapId,{lights:(cur.environment?.lights??[]).map(l=>savedLights.get(l.id)??l)});
 })());
 return null;
}
