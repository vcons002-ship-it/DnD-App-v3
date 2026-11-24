import {randomUUID} from 'node:crypto';
import {cutDoorAcrossWalls} from './wallPolygonDoor.js';
import {eraseWallArea} from './wallErase.js';
import {db} from './db.js';
import {insertRow} from './backup.js';
import {pushUndo} from './undo.js';
import {getMap,listTokens,getToken,getMonster,createWallDoorObject,setCondition,clearCondition,setTokenHidden,updateMonster} from './sessions.js';
import {sanitizeWalls,distanceToWall,wallCollisionRadiusFt,type MapWall,type WallEdit} from '../../shared/mapWalls.js';

/** Incremental edits preserve segments added by another DM window. */
export function editMapWalls(sessionId:string,mapId:string,edit:WallEdit,opts:{recordUndo?:boolean}={}):string|null {
  const map=getMap(mapId);
  if(!map||map.sessionId!==sessionId)return 'Map not found in this campaign.';
  const prevWalls=map.walls??[];
  let walls=prevWalls;
  let undoLabel:string|null=null;
  let undoFn:(()=>void)|null=null;

  if(edit.door){
    if(walls.some(w=>w.id===edit.door!.id))return null;
    const next=cutDoorAcrossWalls(walls,edit.door);
    if(!next)return 'Drag along an existing wall to set the door width.';
    let token=edit.door.tokenId?getToken(edit.door.tokenId):null;
    if(edit.door.tokenId&&(!token||token.mapId!==mapId||token.kind!=='monster'||getMonster(token.refId)?.objectKind!=='door'||walls.some(w=>w.tokenId===token!.id)))return 'Select an unattached door object on this map.';
    const prevTokenPos=token?{id:token.id,x:token.x,y:token.y}:null;
    const door=next.find(w=>w.door&&w.id===edit.door!.id)!;
    const createdAutoToken=!token;
    token??=createWallDoorObject(sessionId,mapId,(door.ax+door.bx)/2,(door.ay+door.by)/2);
    const createdTokenId=createdAutoToken?token.id:null;
    const createdMonsterId=createdAutoToken?token.refId:null;
    door.tokenId=token.id;
    db.prepare('UPDATE tokens SET x=?, y=? WHERE id=?').run((door.ax+door.bx)/2,(door.ay+door.by)/2,token.id);
    door.open=!!getMonster(token.refId)?.conditions.some(c=>c.label.toLowerCase()==='open');
    walls=next;
    if(opts.recordUndo){
      const prevIds=new Set(prevWalls.map(w=>w.id)),nextIds=new Set(next.map(w=>w.id));
      const removed=prevWalls.filter(w=>!nextIds.has(w.id));
      const addedIds=new Set(next.filter(w=>!prevIds.has(w.id)).map(w=>w.id));
      undoLabel='Cut door';
      undoFn=()=>db.transaction(()=>{
        const cur=getMap(mapId);if(!cur||cur.sessionId!==sessionId)throw Error('Map no longer exists.');
        const kept=(cur.walls??[]).filter(w=>!addedIds.has(w.id));
        db.prepare('UPDATE maps SET walls=? WHERE id=?').run(JSON.stringify([...kept,...removed.filter(r=>!kept.some(k=>k.id===r.id))]),mapId);
        if(createdTokenId)db.prepare('DELETE FROM tokens WHERE id=? AND map_id=?').run(createdTokenId,mapId);
        if(createdMonsterId)db.prepare('DELETE FROM monsters WHERE id=? AND session_id=?').run(createdMonsterId,sessionId);
        if(prevTokenPos)db.prepare('UPDATE tokens SET x=?, y=? WHERE id=? AND map_id=?').run(prevTokenPos.x,prevTokenPos.y,prevTokenPos.id,mapId);
      })();
    }
  }else if(edit.eraseArea!==undefined){
    try{
      const rawNext=eraseWallArea(walls,edit.eraseArea);
      const next=sanitizeWalls(rawNext);
      walls=next;
      if(opts.recordUndo&&JSON.stringify(prevWalls)!==JSON.stringify(next)){
        const nextById=new Map(next.map(w=>[w.id,JSON.stringify(w)]));
        const changedPrev=prevWalls.filter(w=>nextById.get(w.id)!==JSON.stringify(w));
        const prevById=new Map(prevWalls.map(w=>[w.id,JSON.stringify(w)]));
        const addedOrModifiedIds=new Set(next.filter(w=>prevById.get(w.id)!==JSON.stringify(w)).map(w=>w.id));
        undoLabel='Erase wall section';
        undoFn=()=>{
          const cur=getMap(mapId);if(!cur||cur.sessionId!==sessionId)throw Error('Map no longer exists.');
          const kept=(cur.walls??[]).filter(w=>!addedOrModifiedIds.has(w.id));
          db.prepare('UPDATE maps SET walls=? WHERE id=?').run(JSON.stringify([...kept,...changedPrev.filter(r=>!kept.some(k=>k.id===r.id))]),mapId);
        };
      }
    }catch(error){return error instanceof Error?error.message:'Unable to erase that wall section.';}
  }else if(edit.update!==undefined){
    const old=walls.find(w=>w.id===edit.update!.id);
    if(!old)return 'Wall not found.';
    // Transforming geometry must not change lock state or detach the door object.
    const [wall]=sanitizeWalls([{...edit.update,door:old.door,open:old.open,tokenId:old.tokenId,window:old.window,arch:old.arch}]);
    if(!wall)return 'Invalid wall shape.';
    const prevTok=old.tokenId?getToken(old.tokenId):null;
    const next=walls.map(w=>w.id===old.id?wall:w);
    if(old.tokenId)db.prepare('UPDATE tokens SET x=?, y=? WHERE id=? AND map_id=?').run((wall.ax+wall.bx)/2,(wall.ay+wall.by)/2,old.tokenId,mapId);
    walls=next;
    if(opts.recordUndo&&JSON.stringify(old)!==JSON.stringify(wall)){
      const savedOld={...old},savedTok=prevTok?{id:prevTok.id,x:prevTok.x,y:prevTok.y}:null;
      undoLabel='Edit wall';
      undoFn=()=>db.transaction(()=>{
        const cur=getMap(mapId);if(!cur||cur.sessionId!==sessionId)throw Error('Map no longer exists.');
        db.prepare('UPDATE maps SET walls=? WHERE id=?').run(JSON.stringify((cur.walls??[]).map(w=>w.id===savedOld.id?savedOld:w)),mapId);
        if(savedTok)db.prepare('UPDATE tokens SET x=?, y=? WHERE id=? AND map_id=?').run(savedTok.x,savedTok.y,savedTok.id,mapId);
      })();
    }
  }else if(edit.add!==undefined){
    const [wall]=sanitizeWalls([edit.add]);
    if(!wall)return 'Draw a wall with a visible length and thickness.';
    if(walls.some(w=>w.id===wall.id))return null; // A retried edit is idempotent.
    walls=[...walls,wall];
    if(opts.recordUndo){
      const addedId=wall.id;
      undoLabel='Add wall';
      undoFn=()=>{
        const cur=getMap(mapId);if(!cur||cur.sessionId!==sessionId)throw Error('Map no longer exists.');
        db.prepare('UPDATE maps SET walls=? WHERE id=?').run(JSON.stringify((cur.walls??[]).filter(w=>w.id!==addedId)),mapId);
      };
    }
  }else if(typeof edit.removeId==='string'){
    const removed=walls.find(w=>w.id===edit.removeId);
    const removedTokRow=removed?.tokenId?(db.prepare('SELECT * FROM tokens WHERE id=? AND map_id=?').get(removed.tokenId,mapId) as Record<string,unknown>|undefined):undefined;
    walls=walls.filter(w=>w.id!==edit.removeId);
    if(removedTokRow)db.prepare('DELETE FROM tokens WHERE id=? AND map_id=?').run(removedTokRow.id,mapId);
    if(opts.recordUndo&&removed){
      undoLabel='Delete wall';
      undoFn=()=>db.transaction(()=>{
        const cur=getMap(mapId);if(!cur||cur.sessionId!==sessionId)throw Error('Map no longer exists.');
        const curWalls=cur.walls??[];
        if(!curWalls.some(w=>w.id===removed.id)){
          db.prepare('UPDATE maps SET walls=? WHERE id=?').run(JSON.stringify([...curWalls,removed]),mapId);
        }
        if(removedTokRow&&!db.prepare('SELECT id FROM tokens WHERE id=?').get(removedTokRow.id))insertRow('tokens',removedTokRow);
      })();
    }
  }else if(edit.barrierType!==undefined){
    const {wallIds,kind}=edit.barrierType;
    if(!Array.isArray(wallIds)||!['wall','window','arch'].includes(kind))return 'Choose wall, window, or arch.';
    const targetSet=new Set(wallIds.filter((id):id is string=>typeof id==='string'));
    const savedPrev=new Map<string,MapWall>();
    const converted=walls.map(w=>{
      if(w.door||!targetSet.has(w.id))return w;
      savedPrev.set(w.id,{...w});
      const minThick=!w.kind&&!(w.thickness)?{thickness:6}:{};
      if(kind==='window')return {...w,...minThick,window:true,arch:undefined};
      if(kind==='arch')return {...w,...minThick,window:undefined,arch:true};
      return {...w,window:undefined,arch:undefined};
    });
    if(!savedPrev.size)return null;
    const next=sanitizeWalls(converted);
    walls=next;
    if(opts.recordUndo&&JSON.stringify(prevWalls)!==JSON.stringify(next)){
      undoLabel='Convert barrier type';
      undoFn=()=>{
        const cur=getMap(mapId);if(!cur||cur.sessionId!==sessionId)throw Error('Map no longer exists.');
        db.prepare('UPDATE maps SET walls=? WHERE id=?').run(JSON.stringify((cur.walls??[]).map(w=>savedPrev.get(w.id)??w)),mapId);
      };
    }
  }else if(edit.doorState!==undefined){
    const {doorIds,open,locked,hidden,objectDc}=edit.doorState;
    if(!Array.isArray(doorIds)||!doorIds.length)return 'Select at least one door.';
    const targetSet=new Set(doorIds.filter((id):id is string=>typeof id==='string'));
    const matching=walls.filter(w=>w.door&&targetSet.has(w.id));
    if(!matching.length)return 'Door not found.';
    const savedDoors=new Map<string,MapWall>();
    const savedTokens:{id:string;hidden:boolean}[]=[];
    const savedMonsters:{id:string;conditionsJson:string;objectDc:number|null}[]=[];
    const createdTokenIds:string[]=[];
    const createdMonsterIds:string[]=[];
    const next=walls.map(w=>{
      if(!w.door||!targetSet.has(w.id))return w;
      savedDoors.set(w.id,{...w});
      let tok=w.tokenId?getToken(w.tokenId):null;
      if(!tok){
        tok=createWallDoorObject(sessionId,mapId,(w.ax+w.bx)/2,(w.ay+w.by)/2);
        createdTokenIds.push(tok.id);
        createdMonsterIds.push(tok.refId);
      }else{
        savedTokens.push({id:tok.id,hidden:tok.isHidden});
      }
      const obj=getMonster(tok.refId);
      if(obj&&!createdMonsterIds.includes(obj.id)){
        savedMonsters.push({id:obj.id,conditionsJson:JSON.stringify(obj.conditions),objectDc:obj.objectDc??null});
      }
      let nextOpen=!!w.open;
      if(typeof open==='boolean'){
        nextOpen=open;
        if(obj){
          const curOpen=obj.conditions.find(c=>c.label.toLowerCase()==='open');
          if(open&&!curOpen)setCondition('monster',obj.id,{id:randomUUID(),label:'Open',aura:'green',isConcentration:false});
          else if(!open&&curOpen)clearCondition('monster',obj.id,curOpen.id);
        }
      }
      if(typeof locked==='boolean'&&obj){
        const curLocked=obj.conditions.find(c=>c.label.toLowerCase()==='locked');
        if(locked&&!curLocked)setCondition('monster',obj.id,{id:randomUUID(),label:'Locked',aura:'red',isConcentration:false});
        else if(!locked&&curLocked)clearCondition('monster',obj.id,curLocked.id);
      }
      if(typeof hidden==='boolean')setTokenHidden(tok.id,hidden);
      if(typeof objectDc==='number'&&Number.isFinite(objectDc)&&obj){
        updateMonster(obj.id,{objectDc:Math.max(1,Math.min(40,Math.round(objectDc)))});
      }
      return {...w,open:nextOpen,tokenId:tok.id};
    });
    walls=next;
    if(opts.recordUndo){
      undoLabel='Edit door';
      undoFn=()=>db.transaction(()=>{
        const cur=getMap(mapId);if(!cur||cur.sessionId!==sessionId)throw Error('Map no longer exists.');
        db.prepare('UPDATE maps SET walls=? WHERE id=?').run(JSON.stringify((cur.walls??[]).map(w=>savedDoors.get(w.id)??w)),mapId);
        for(const t of savedTokens)setTokenHidden(t.id,t.hidden);
        for(const m of savedMonsters)db.prepare('UPDATE monsters SET conditions=?, object_dc=? WHERE id=? AND session_id=?').run(m.conditionsJson,m.objectDc,m.id,sessionId);
        for(const tid of createdTokenIds)db.prepare('DELETE FROM tokens WHERE id=? AND map_id=?').run(tid,mapId);
        for(const mid of createdMonsterIds)db.prepare('DELETE FROM monsters WHERE id=? AND session_id=?').run(mid,sessionId);
      })();
    }
  }
  else return 'Choose a wall to add or erase.';
  db.prepare('UPDATE maps SET walls = ? WHERE id = ? AND session_id = ?').run(JSON.stringify(walls),mapId,sessionId);
  if(undoLabel&&undoFn)pushUndo(sessionId,undoLabel,undoFn);
  return null;
}


export function setWallDoor(sessionId:string,mapId:string,doorId:string,open:boolean):string|null {
 const map=getMap(mapId);
 if(!map||map.sessionId!==sessionId)return 'Map not found in this campaign.';
 const door=map.walls?.find(w=>w.id===doorId&&w.door);
 if(!door)return 'Door not found.';
 const token=door.tokenId?getToken(door.tokenId):null,obj=token?getMonster(token.refId):null;
 if(open&&obj?.conditions.some(c=>c.label.toLowerCase()==='locked'))return 'The door is locked. Unlock it first.';
 if(!open&&door.open&&listTokens(mapId).some(t=>!map.walls?.some(w=>w.tokenId===t.id)&&distanceToWall(t,door)<wallCollisionRadiusFt(t.widthFt)*map.gridSizePx/map.feetPerSquare))return 'Move the token clear of the doorway before closing it.';
 if(obj){
  const existing=obj.conditions.find(c=>c.label.toLowerCase()==='open');
  if(open&&!existing)setCondition('monster',obj.id,{id:randomUUID(),label:'Open',aura:'green',isConcentration:false});
  else if(!open&&existing)clearCondition('monster',obj.id,existing.id);
 }
 const walls=(map.walls??[]).map(w=>w.id===doorId?{...w,open}:w);
 db.prepare('UPDATE maps SET walls = ? WHERE id = ? AND session_id = ?').run(JSON.stringify(walls),mapId,sessionId);
 return null;
}
