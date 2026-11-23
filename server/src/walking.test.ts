import path from 'node:path';
import sharp from 'sharp';
import {afterAll,it,expect} from 'vitest';
import {config} from './config.js';
import {renderedSnapshot} from './renderedSnapshot.js';
import {renderAssetFor} from './renderAssets.js';
import {createSession,createMap,createCharacter,claimCharacter,createToken,setActiveMap,updateMapEnvironment,moveToken,listMaps,createMonsterTemplate,instantiateMonster,setFogLayer,setFogRevealed,setTokenHidden,setExplorationMode,setTokenLantern} from './sessions.js';
import {buildSnapshot} from './visibility.js';
import {recordWalkingMove,walkingRoute} from './walking.js';
import {prepareLegacyMotion} from './legacyMotion.js';
import {resetExploration} from './exploration.js';
import {editMapWalls} from './mapWalls.js';
import {visibilityWorkers} from './visibilityWorkers.js';
import type {ExploredTerrain} from '../../shared/exploration.js';
import {tokenMoveDuration} from '../../client/src/canvas/tokenMotion.js';
import {TokenPresentation} from '../../client/src/canvas/tokenPresentation.js';
afterAll(()=>visibilityWorkers.close());
function contains(shape:ExploredTerrain|undefined,x:number,y:number){const ring=(r:[number,number][])=>{let yes=false;for(let i=0,j=r.length-1;i<r.length;j=i++){const [a,b]=r[i],[c,d]=r[j];if((b>y)!==(d>y)&&x<(c-a)*(y-b)/(d-b)+a)yes=!yes;}return yes;};return shape?.some(p=>ring(p[0])&&!p.slice(1).some(ring))??false;}
function fixture(){
 const session=createSession('Walking route test'),map=createMap(session.id,{name:'Dark corridor'}),pc=createCharacter(session.id,{name:'Walker'});claimCharacter(pc.id,'walker');
 const token=createToken({mapId:map.id,kind:'pc',refId:pc.id,x:100,y:100});setActiveMap(session.id,map.id);updateMapEnvironment(session.id,map.id,{enabled:true,heavyDarkness:true,lighting:'dungeon',lights:[]});
 const snapshot=()=>buildSnapshot(session.id,'player',null,'walker')!;
 return {session,map:listMaps(session.id).find(m=>m.id===map.id)!,token,snapshot};
}
it('remembers the middle of one long accepted walk and preserves history after returning',async()=>{
 const f=fixture();f.snapshot();const moved=moveToken(f.token.id,2100,100,true)!;await recordWalkingMove(f.token,moved,true);
 expect(contains(f.snapshot().exploredTerrain,1100,100)).toBe(true);expect(walkingRoute(moved.id)?.samples).toBe(81);
 const back=moveToken(moved.id,100,100,true)!;await recordWalkingMove(moved,back,true);expect(contains(f.snapshot().exploredTerrain,2100,100)).toBe(true);
});
it('does not explore a relocation, a DM wall crossing or a hidden token path',async()=>{
 for(const kind of ['relocate','wall','hidden']){
  const f=fixture();f.snapshot();if(kind==='wall')editMapWalls(f.session.id,f.map.id,{add:{id:'barrier',ax:1000,ay:-5000,bx:1000,by:5000}});
  const source=kind==='hidden'?{...f.token,isHidden:true}:f.token,moved=moveToken(f.token.id,2100,100)!;
  await recordWalkingMove(source,{...moved,isHidden:source.isHidden},true,kind==='relocate');
  expect(contains(f.snapshot().exploredTerrain,1100,100)).toBe(false);
 }
});
it.each([false,true])('animates doorway moves without exploring across closed walls (membershipOnly=%s)',async(membershipOnly)=>{
 // 1. DM moves a token through an open doorway where its collision radius grazes the jamb (y=106 near jamb at y=100, radius=10px).
 const openDoor=fixture();
 editMapWalls(openDoor.session.id,openDoor.map.id,{add:{id:'jamb-top',ax:200,ay:0,bx:200,by:100}});
 editMapWalls(openDoor.session.id,openDoor.map.id,{add:{id:'jamb-bot',ax:200,ay:150,bx:200,by:400}});
 const startNearJamb=moveToken(openDoor.token.id,100,106)!;
 const beforeDoor=openDoor.snapshot(),throughDoor=moveToken(openDoor.token.id,300,106)!;
 await recordWalkingMove(startNearJamb,throughDoor,true);
 const afterDoor=openDoor.snapshot();
 expect(walkingRoute(throughDoor.id)?.crossedWall).toBeUndefined();
 expect(contains(afterDoor.exploredTerrain,200,106)).toBe(true);
 const doorPlan=await prepareLegacyMotion('walker-door',beforeDoor,afterDoor,undefined,{membershipOnly});
 expect(doorPlan?.frames).toHaveLength(13);
 expect(doorPlan?.moves[throughDoor.id]).toEqual({from:{x:100,y:106},to:{x:300,y:106}});
 expect(doorPlan?.frames[0].tokens?.find(t=>t.id===throughDoor.id)).toBeUndefined();
 // 2. Subsequent move starting within 1ft (6px < 10px radius) of a wall still records a route and animates.
 editMapWalls(openDoor.session.id,openDoor.map.id,{add:{id:'hall-wall',ax:250,ay:100,bx:500,by:100}});
 const beforeParallel=openDoor.snapshot(),parallelMove=moveToken(openDoor.token.id,450,106)!;
 await recordWalkingMove(throughDoor,parallelMove,true);
 const afterParallel=openDoor.snapshot();
 const parallelPlan=await prepareLegacyMotion('walker-door',beforeParallel,afterParallel,undefined,{membershipOnly});
 expect(parallelPlan?.frames).toHaveLength(13);
 // 3. DM moves a token across a solid wall: does not explore intermediate rooms, but still produces a 13-frame motion plan.
 const walled=fixture();
 editMapWalls(walled.session.id,walled.map.id,{add:{id:'wall-a',ax:600,ay:-5000,bx:600,by:5000}});
 editMapWalls(walled.session.id,walled.map.id,{add:{id:'wall-b',ax:1600,ay:-5000,bx:1600,by:5000}});
 const beforeWall=walled.snapshot(),acrossWall=moveToken(walled.token.id,2100,100)!;
 await recordWalkingMove(walled.token,acrossWall,true);
 const afterWall=walled.snapshot();
 expect(walkingRoute(acrossWall.id)?.crossedWall).toBe(true);
 expect(contains(afterWall.exploredTerrain,1100,100)).toBe(false);
 const wallPlan=await prepareLegacyMotion('walker-wall',beforeWall,afterWall,undefined,{membershipOnly});
 expect(wallPlan?.frames).toHaveLength(13);
 expect(wallPlan?.moves[acrossWall.id]).toEqual({from:{x:100,y:100},to:{x:2100,y:100}});
});
it('a reset invalidates an in-flight worker history write',async()=>{
 const f=fixture();f.snapshot();const moved=moveToken(f.token.id,2100,100,true)!,pending=recordWalkingMove(f.token,moved,true);resetExploration(f.session.id,f.map.id);await pending;
 expect(contains(f.snapshot().exploredTerrain,1100,100)).toBe(false);
});
it('DM preview can remain read-only',async()=>{
 const f=fixture();f.snapshot();const moved=moveToken(f.token.id,2100,100,true)!;await recordWalkingMove(f.token,moved,false);
 expect(contains(f.snapshot().exploredTerrain,1100,100)).toBe(false);
});
it('manual map fog restricts the entire walking history',async()=>{
 const f=fixture();setFogLayer(f.map.id,'map',true);setFogRevealed(f.map.id,'map',['22,2']);
 const moved=moveToken(f.token.id,2100,100,true)!;await recordWalkingMove(f.token,moved,true);
 const s=f.snapshot();expect(contains(s.exploredTerrain,1110,110)).toBe(true);expect(contains(s.exploredTerrain,1050,110)).toBe(false);
});
it('motion has bounded intermediate frames and never animates a relocation or reset',async()=>{
 const f=fixture(),before=f.snapshot(),moved=moveToken(f.token.id,300,100,true)!;await recordWalkingMove(f.token,moved,true);
 const after=f.snapshot();
 // No vision case verifies route/membership without needing raster credentials.
 const a={...before,playerVision:undefined},b={...after,playerVision:undefined};
 const plan=await prepareLegacyMotion('walking-test',a,b);expect(plan?.frames).toHaveLength(13);expect(plan?.frames.map(f=>f.at)).toEqual(Array.from({length:13},(_,i)=>i/12));
 expect(plan?.durationMs).toBe(tokenMoveDuration(200,10));
 expect(plan?.moves[moved.id]).toEqual({from:{x:100,y:100},to:{x:300,y:100}});
 expect(await prepareLegacyMotion('walking-test',a,{...b,explorationEpoch:99})).toBeUndefined();
 await recordWalkingMove(f.token,moved,true,true);expect(await prepareLegacyMotion('walking-test',a,b)).toBeUndefined();
});
it('authorizes transient midpoint creatures, redacts stats and still excludes manual fog and hidden figures',async()=>{
 const f=fixture(),monster=instantiateMonster(createMonsterTemplate(f.session.id,{name:'Passing Goblin',maxHp:7}).id)!;
 const enemy=createToken({mapId:f.map.id,kind:'monster',refId:monster.id,x:1100,y:100});
 const before=f.snapshot(),moved=moveToken(f.token.id,2100,100,true)!;await recordWalkingMove(f.token,moved,true);const after=f.snapshot();
 expect(before.tokens.some(t=>t.id===enemy.id)).toBe(false);
 expect(after.tokens.some(t=>t.id===enemy.id&&!t.revealedOnly)).toBe(false);
 expect(after.tokens.find(t=>t.id===enemy.id)).toMatchObject({sharedSightOnly:true,revealedOnly:true});
 const plan=await prepareLegacyMotion('walker',before,after),mid=plan?.frames[6];
 expect(mid?.tokens?.some(t=>t.id===enemy.id&&!t.sharedSightOnly&&!t.revealedOnly)).toBe(true);
 expect((mid?.monsters??after.monsters).find(m=>m.id===enemy.refId)).not.toHaveProperty('curHp');
 expect(plan?.frames[0].tokenIds).not.toContain(enemy.id);
 setFogLayer(f.map.id,'tokens',true);setFogRevealed(f.map.id,'tokens',[]);
 // Both snapshots use the restricted map so this exercises intermediate shaping.
 const restricted={...before,map:f.snapshot().map},restrictedAfter=f.snapshot();
 const hidden=await prepareLegacyMotion('walker',restricted,restrictedAfter);expect(hidden?.frames[6].tokenIds).not.toContain(enemy.id);
});
it('presentation shares the server motion clock, redirects smoothly mid-walk, and snaps on cancellation/reduced motion',()=>{
 const f=fixture(),a=f.snapshot(),b={...a,tokens:a.tokens.map(t=>({...t,x:t.x+200}))},p=new TokenPresentation();p.sync(a,10,0,true);
 const token=b.tokens[0],playback={id:'move',start:100,durationMs:400,moves:{[token.id]:{from:{x:100,y:100},to:{x:300,y:100}}}};
 p.sync(b,10,100,false,playback);expect(p.position(token.id)?.x).toBe(100);expect(p.facing(token.id,0)).toBeCloseTo(Math.PI/2,5);p.advance(300);expect(p.position(token.id)?.x).toBe(200);
 // Starting a second playback mid-walk redirects from the current position (200) instead of jumping to 300.
 const c={...b,tokens:b.tokens.map(t=>({...t,x:500}))},playback2={id:'move-2',start:300,durationMs:400,moves:{[token.id]:{from:{x:300,y:100},to:{x:500,y:100}}}};
 p.sync(c,10,300,false,playback2);expect(p.position(token.id)?.x).toBe(200);p.advance(500);expect(p.position(token.id)?.x).toBe(350);
 p.sync(c,10,510,true);expect(p.position(token.id)?.x).toBe(500);expect(p.moving()).toBe(false);
});
it('retains vector geometry across rendered snapshots and recomputes first motion frame geometry when stripped',async()=>{
 const f=fixture();
 await sharp({create:{width:500,height:500,channels:4,background:{r:80,g:90,b:100,alpha:1}}}).png().toFile(path.join(config.uploadsDir,'motion-strip-test.png'));
 const rawBefore={...f.snapshot(),map:{...f.snapshot().map!,imagePath:'/uploads/motion-strip-test.png'}};
 const beforeGeometry=await visibilityWorkers.run({mapId:f.map.id,vision:rawBefore.playerVision!,wallFog:true,explored:rawBefore.exploredTerrain,tokens:rawBefore.tokens});
 const deliveredBefore=await renderedSnapshot('walker-stripped',{...rawBefore,legacyGeometry:beforeGeometry},true);
 expect(deliveredBefore.visionRaster).toBeUndefined();
 expect(deliveredBefore.terrainRaster).toBeUndefined();
 expect(deliveredBefore.legacyGeometry?.near.length).toBeGreaterThan(0);
 const strippedBefore={...deliveredBefore,legacyGeometry:{...beforeGeometry,sight:[],near:[],lights:[],memory:[]}};
 const moved=moveToken(f.token.id,300,100,true)!;await recordWalkingMove(f.token,moved,true);
 const rawAfter={...f.snapshot(),map:{...f.snapshot().map!,imagePath:'/uploads/motion-strip-test.png'}};
 const afterGeometry=await visibilityWorkers.run({mapId:f.map.id,vision:rawAfter.playerVision!,wallFog:true,explored:rawAfter.exploredTerrain,tokens:rawAfter.tokens});
 const plan=await prepareLegacyMotion('walker-stripped',strippedBefore,{...rawAfter,legacyGeometry:afterGeometry});
 expect(plan?.atlas).toBeUndefined();
 expect(plan?.frames[0].legacyGeometry?.near).toEqual(beforeGeometry.near);
 expect(plan?.frames.at(-1)?.legacyGeometry?.near).toEqual(afterGeometry.near);
});

it('lightweight movement keeps departing creatures and authorizes midpoint-only creatures without raster work',async()=>{
 const f=fixture(),monster=instantiateMonster(createMonsterTemplate(f.session.id,{name:'Route guard',maxHp:7}).id)!;
 const near=createToken({mapId:f.map.id,kind:'monster',refId:monster.id,x:400,y:100});
 const middle=createToken({mapId:f.map.id,kind:'monster',refId:monster.id,x:1100,y:100});
 const secret=createToken({mapId:f.map.id,kind:'monster',refId:monster.id,x:1100,y:120});setTokenHidden(secret.id,true);
 const before=f.snapshot(),moved=moveToken(f.token.id,2100,100,true)!;await recordWalkingMove(f.token,moved,true);const after=f.snapshot();
 const jobs=visibilityWorkers.metrics.jobs;
 const plan=await prepareLegacyMotion('walker',before,after,undefined,{membershipOnly:true});
 expect(plan?.membershipOnly).toBe(true);expect(visibilityWorkers.metrics.jobs).toBe(jobs);
 expect(plan?.frames[0].tokenIds).toContain(near.id);expect(plan?.frames[6].tokenIds).toContain(middle.id);
 expect(plan?.frames.every(frame=>!frame.tokenIds.includes(secret.id))).toBe(true);
 expect(after.tokens.find(t=>t.id===near.id)?.revealedOnly).toBe(true);
 expect(after.tokens.find(t=>t.id===middle.id)?.revealedOnly).toBe(true);
 expect(plan?.frames.every(frame=>!frame.legacyGeometry&&!frame.tokenSprites&&!frame.visionRaster)).toBe(true);
 expect((plan?.frames[6].monsters??after.monsters).find(m=>m.id===middle.refId)).not.toHaveProperty('curHp');
 setFogLayer(f.map.id,'tokens',true);setFogRevealed(f.map.id,'tokens',[]);
 const restricted=f.snapshot();const hidden=await prepareLegacyMotion('walker',{...before,map:restricted.map},restricted,undefined,{membershipOnly:true});
 expect(hidden?.frames[6].tokenIds).not.toContain(middle.id);
 setFogLayer(f.map.id,'tokens',false);setExplorationMode(f.session.id,f.map.id,'off');
 await recordWalkingMove(f.token,moved,true);
 const afterOff=f.snapshot(),beforeOff={...before,map:afterOff.map,explorationEpoch:afterOff.explorationEpoch};
 const planOff=await prepareLegacyMotion('walker',beforeOff,afterOff,undefined,{membershipOnly:true});
 expect(planOff?.frames[0].tokenIds).toContain(near.id);expect(planOff?.frames[6].tokenIds).toContain(middle.id);
 expect(planOff?.frames.at(-1)?.tokenIds).not.toContain(near.id);expect(planOff?.frames.at(-1)?.tokenIds).not.toContain(middle.id);
 expect(await prepareLegacyMotion('walker',{...before,playerVision:undefined},{...after,playerVision:undefined},undefined,{membershipOnly:true})).toBeUndefined();
});
it('populates legacyGeometry.affinity at midpoint in heavy darkness with a lantern and in dim light when endpoints omit it',async()=>{
 const f=fixture(),monster=instantiateMonster(createMonsterTemplate(f.session.id,{name:'Corridor guard',maxHp:7}).id)!;
 const enemy=createToken({mapId:f.map.id,kind:'monster',refId:monster.id,x:1100,y:100});
 // 1. Heavy darkness + carried lantern passing by enemy.
 setTokenLantern(f.token.id,true);
 const beforeHeavy=f.snapshot(),movedHeavy=moveToken(f.token.id,2100,100,true)!;
 await recordWalkingMove(f.token,movedHeavy,true);
 const afterHeavy=f.snapshot();
 const beforeHeavyGeo=await visibilityWorkers.run({mapId:f.map.id,vision:beforeHeavy.playerVision!,wallFog:true,explored:beforeHeavy.exploredTerrain,tokens:beforeHeavy.tokens});
 const afterHeavyGeo=await visibilityWorkers.run({mapId:f.map.id,vision:afterHeavy.playerVision!,wallFog:true,explored:afterHeavy.exploredTerrain,tokens:afterHeavy.tokens});
 const heavyPlan=await prepareLegacyMotion('walker-affinity-heavy',{...beforeHeavy,legacyGeometry:beforeHeavyGeo},{...afterHeavy,legacyGeometry:afterHeavyGeo});
 expect(afterHeavyGeo.affinity).not.toContain(enemy.id);
 expect(heavyPlan?.frames[0].legacyGeometry?.affinity).not.toContain(enemy.id);
 expect(heavyPlan?.frames[6].legacyGeometry?.affinity).toContain(enemy.id);
 expect(heavyPlan?.frames.at(-1)?.legacyGeometry?.affinity).not.toContain(enemy.id);
 // 2. Dim light without lantern passing within darkvision range.
 setTokenLantern(f.token.id,false);
 updateMapEnvironment(f.session.id,f.map.id,{enabled:true,heavyDarkness:false,lighting:'dungeon',lights:[]});
 const startDim=moveToken(f.token.id,100,100,true)!;
 const beforeDim=f.snapshot(),movedDim=moveToken(f.token.id,2100,100,true)!;
 await recordWalkingMove(startDim,movedDim,true);
 const afterDim=f.snapshot();
 const beforeDimGeo=await visibilityWorkers.run({mapId:f.map.id,vision:beforeDim.playerVision!,wallFog:true,explored:beforeDim.exploredTerrain,tokens:beforeDim.tokens});
 const afterDimGeo=await visibilityWorkers.run({mapId:f.map.id,vision:afterDim.playerVision!,wallFog:true,explored:afterDim.exploredTerrain,tokens:afterDim.tokens});
 const dimPlan=await prepareLegacyMotion('walker-affinity-dim',{...beforeDim,legacyGeometry:beforeDimGeo},{...afterDim,legacyGeometry:afterDimGeo});
 expect(afterDimGeo.affinity).not.toContain(enemy.id);
 expect(dimPlan?.frames[0].legacyGeometry?.affinity).not.toContain(enemy.id);
 expect(dimPlan?.frames[6].legacyGeometry?.affinity).toContain(enemy.id);
 expect(dimPlan?.frames.at(-1)?.legacyGeometry?.affinity).not.toContain(enemy.id);
});
it.each([false,true])('animates a token moving outside darkvision without leaking unseen destination (membershipOnly=%s)',async(membershipOnly)=>{
 for(const mode of ['remembered','off'] as const){
  const f=fixture();setExplorationMode(f.session.id,f.map.id,mode);
  const monster=instantiateMonster(createMonsterTemplate(f.session.id,{name:'Night Prowler',maxHp:7}).id)!;
  const enemy=createToken({mapId:f.map.id,kind:'monster',refId:monster.id,x:400,y:100});
  const before=f.snapshot();
  const shortMove=moveToken(enemy.id,900,100)!;await recordWalkingMove(enemy,shortMove,true);const afterShort=f.snapshot();
  expect(afterShort.tokens.some(t=>t.id===enemy.id)).toBe(false);
  const shortPlan=await prepareLegacyMotion('depart-short',before,afterShort,undefined,{membershipOnly});
  expect(shortPlan?.frames).toHaveLength(13);
  expect(shortPlan?.moves[enemy.id].from).toEqual({x:400,y:100});
  expect(shortPlan?.moves[enemy.id].to.y).toBe(100);
  expect(shortPlan?.moves[enemy.id].to.x).toBeGreaterThan(722);
  expect(shortPlan?.moves[enemy.id].to.x).toBeLessThan(740);

  // Moving much farther past darkvision along the same ray produces the exact same clipped exit and duration.
  const f2=fixture();setExplorationMode(f2.session.id,f2.map.id,mode);
  const m2=instantiateMonster(createMonsterTemplate(f2.session.id,{name:'Night Prowler',maxHp:7}).id)!;
  const enemy2=createToken({mapId:f2.map.id,kind:'monster',refId:m2.id,x:400,y:100});
  const beforeFar=f2.snapshot();
  const farMove=moveToken(enemy2.id,2400,100)!;await recordWalkingMove(enemy2,farMove,true);const afterFar=f2.snapshot();
  const farPlan=await prepareLegacyMotion('depart-far',beforeFar,afterFar,undefined,{membershipOnly});
  expect(farPlan?.frames).toHaveLength(13);
  expect(farPlan?.moves[enemy2.id].to).toEqual(shortPlan?.moves[enemy.id].to);
  expect(farPlan?.durationMs).toBe(shortPlan?.durationMs);
  expect(shortPlan?.durationMs).toBe(tokenMoveDuration(Math.hypot(shortPlan!.moves[enemy.id].to.x-400,0),10));
  expect(JSON.stringify(farPlan)).not.toContain('2400');
  expect(farPlan?.frames[0].tokenIds).toContain(enemy2.id);
  expect(farPlan?.frames[0].tokens?.find(t=>t.id===enemy2.id)?.partiallyRevealed).toBeUndefined();
  expect(farPlan?.frames.some(frame=>frame.tokens?.some(t=>t.id===enemy2.id&&t.partiallyRevealed))).toBe(true);
  expect(farPlan?.frames.at(-1)?.tokenIds).not.toContain(enemy2.id);
 }

 // Relocate, explicit hide, and wall-crossing departures must still snap immediately.
 const reloc=fixture(),relocMon=instantiateMonster(createMonsterTemplate(reloc.session.id,{name:'Blinker',maxHp:7}).id)!;
 const relocTok=createToken({mapId:reloc.map.id,kind:'monster',refId:relocMon.id,x:400,y:100});
 const beforeReloc=reloc.snapshot(),relocMoved=moveToken(relocTok.id,2400,100,false,true)!;await recordWalkingMove(relocTok,relocMoved,true,true);
 expect(await prepareLegacyMotion('depart-reloc',beforeReloc,reloc.snapshot(),undefined,{membershipOnly})).toBeUndefined();

 const hid=fixture(),hidMon=instantiateMonster(createMonsterTemplate(hid.session.id,{name:'Sneaker',maxHp:7}).id)!;
 const hidTok=createToken({mapId:hid.map.id,kind:'monster',refId:hidMon.id,x:400,y:100});
 const beforeHid=hid.snapshot(),hidMoved=moveToken(hidTok.id,2400,100)!;setTokenHidden(hidTok.id,true);
 await recordWalkingMove(hidTok,{...hidMoved,isHidden:true},true);
 expect(await prepareLegacyMotion('depart-hid',beforeHid,hid.snapshot(),undefined,{membershipOnly})).toBeUndefined();

 const walled=fixture(),wallMon=instantiateMonster(createMonsterTemplate(walled.session.id,{name:'Phaser',maxHp:7}).id)!;
 const wallTok=createToken({mapId:walled.map.id,kind:'monster',refId:wallMon.id,x:400,y:100});
 editMapWalls(walled.session.id,walled.map.id,{add:{id:'solid',ax:600,ay:-500,bx:600,by:500}});
 const beforeWalled=walled.snapshot(),wallMoved=moveToken(wallTok.id,2400,100)!;
 await recordWalkingMove(wallTok,wallMoved,true);
 expect(await prepareLegacyMotion('depart-wall',beforeWalled,walled.snapshot(),undefined,{membershipOnly})).toBeUndefined();
});
it.each([false,true])('animates party PCs entering or leaving revealedOnly distance while snapping remembered monster ghosts (membershipOnly=%s)',async(membershipOnly)=>{
 const f=fixture(),ally=createCharacter(f.session.id,{name:'Scout'});claimCharacter(ally.id,'ally');
 const allyTok=createToken({mapId:f.map.id,kind:'pc',refId:ally.id,x:400,y:200});
 const before=f.snapshot();
 const movedAlly=moveToken(allyTok.id,1000,200,true)!;await recordWalkingMove(allyTok,movedAlly,true);
 const afterAlly=f.snapshot();
 expect(afterAlly.tokens.find(t=>t.id===allyTok.id)).toMatchObject({sharedSightOnly:true,revealedOnly:true});
 const pcPlan=await prepareLegacyMotion('walker-ally',before,afterAlly,undefined,{membershipOnly});
 expect(pcPlan?.frames).toHaveLength(13);
 expect(pcPlan?.moves[allyTok.id]).toEqual({from:{x:400,y:200},to:{x:1000,y:200}});

 // Now move walker away so enemy becomes a remembered revealedOnly ghost, then relocate walker + enemy back together: ghost must snap.
 const fGhost=fixture(),gm=instantiateMonster(createMonsterTemplate(fGhost.session.id,{name:'Ghost',maxHp:7}).id)!;
 const ge=createToken({mapId:fGhost.map.id,kind:'monster',refId:gm.id,x:400,y:100});
 const movedPcAway=moveToken(fGhost.token.id,-1000,100,true)!;await recordWalkingMove(fGhost.token,movedPcAway,true);
 const beforeGhost=fGhost.snapshot();
 expect(beforeGhost.tokens.find(t=>t.id===ge.id)?.revealedOnly).toBe(true);
 const movedGe=moveToken(ge.id,-900,100)!;await recordWalkingMove(ge,movedGe,true);
 expect(await prepareLegacyMotion('walker-ghost',beforeGhost,fGhost.snapshot(),undefined,{membershipOnly})).toBeUndefined();
});
