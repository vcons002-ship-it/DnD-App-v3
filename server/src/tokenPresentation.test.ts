import {describe,it,expect} from 'vitest';
import {TokenPresentation} from '../../client/src/canvas/tokenPresentation.js';
import {createPlayerVision,visionContains,visionLit,visionShowsAffinity} from '../../shared/playerVision.js';
import type {StateSnapshot,Token} from '../../shared/types.js';
import type {ExploredTerrain} from '../../shared/exploration.js';

const oldMemory:ExploredTerrain=[[[[420,600],[650,600],[650,900],[420,900],[420,600]]]];
const newMemory:ExploredTerrain=[...oldMemory,[[[600,330],[1400,330],[1400,600],[600,600],[600,330]]]];
function snapshot(y=650,shared=false,dark=false):StateSnapshot {
  const map={id:'dungeon',gridSizePx:50,feetPerSquare:5,mapFogEnabled:false,tokenFogEnabled:false,
    environment:{enabled:dark,lighting:'dungeon',heavyDarkness:dark,lights:[]},
    walls:[{id:'wall',kind:'rectangle',ax:650,ay:600,bx:1430,by:630}]};
  const tokens=[{id:'varis',refId:'varis-sheet',kind:'pc',x:600,y,carriedLantern:true},
    {id:'druk',refId:'druk-sheet',kind:'pc',x:500,y:800},
    ...(y===650?[]:[{id:'goblin',refId:'goblin-sheet',kind:'monster',x:1050,y:550,sharedSightOnly:shared}])] as Token[];
  const result={role:'player',map,tokens,exploredTerrain:y===650?oldMemory:newMemory} as unknown as StateSnapshot;
  result.playerVision=createPlayerVision(result.map,tokens,new Set([shared?'druk-sheet':'varis-sheet']));
  return result;
}

describe('movement-aligned reveal presentation',()=>{
  it('snaps an in-progress move immediately when reduced motion is selected on the same snapshot',()=>{
    const p=new TokenPresentation();p.sync(snapshot(),10,1000);
    const next=snapshot(550);p.sync(next,10,1001);expect(p.moving()).toBe(true);
    p.sync(next,10,1050,true);expect(p.moving()).toBe(false);expect(p.position('varis')).toEqual({x:600,y:550});
  });
  it('reuses stationary personal and party vision instead of rebuilding them for an idle clock',()=>{
    const p=new TokenPresentation();p.sync(snapshot(),10,1000);
    const personal=p.personalVision(),party=p.partyVision();
    p.advance(1200);p.advance(1400);
    expect(p.personalVision()).toBe(personal);expect(p.partyVision()).toBe(party);
  });
  it.each([false,true])('waits for the displayed scout to clear the wall (darkness=%s)',dark=>{
    const p=new TokenPresentation();p.sync(snapshot(650,false,dark),10,1000);
    p.sync(snapshot(550,false,dark),10,1001);
    expect(p.position('varis')).toEqual({x:600,y:650});
    expect(visionContains(p.personalVision(),1050,550)).toBe(false);
    expect(p.explored()).toBe(oldMemory);
    p.advance(1120);expect(visionContains(p.personalVision(),1050,550)).toBe(false);
    p.advance(1180);expect(visionContains(p.personalVision(),1050,550)).toBe(true);
    if(dark)expect(visionLit(p.personalVision(),1050,550)).toBe(false);
    expect(p.explored()).toBe(oldMemory);
    p.advance(1281);expect(p.position('varis')).toEqual({x:600,y:550});
    expect(p.explored()).toBe(newMemory);
  });
  it('also delays the distant observer shared reveal, while leaving personal sight blocked',()=>{
    const p=new TokenPresentation();p.sync(snapshot(650,true),10,1000);p.sync(snapshot(550,true),10,1001);
    expect(visionContains(p.partyVision(),1050,550)).toBe(false);
    p.advance(1180);expect(visionContains(p.partyVision(),1050,550)).toBe(true);
    expect(visionContains(p.personalVision(),1050,550)).toBe(false);
  });
  it('does not restart movement on model readiness or an unrelated snapshot; redirects from the displayed pose',()=>{
    const p=new TokenPresentation();p.sync(snapshot(),10,1000);p.sync(snapshot(550),10,1001);p.advance(1141);
    const half=p.position('varis')!;expect(half.y).toBe(600);
    p.sync(snapshot(550),10,1141);expect(p.position('varis')).toEqual(half);
    p.sync(snapshot(800),10,1141);expect(p.position('varis')).toEqual(half);
    p.advance(1500);expect(p.position('varis')!.y).toBe(800);
  });
  it('immediately removes revoked tokens and clears memory, even during movement',()=>{
    const p=new TokenPresentation();p.sync(snapshot(),10,1000);p.sync(snapshot(550),10,1001);
    const next=snapshot(550);next.tokens=next.tokens.filter(t=>t.id!=='goblin');next.exploredTerrain=[];
    p.sync(next,10,1050);expect(p.position('goblin')).toBeUndefined();expect(p.explored()).toEqual([]);
  });
  it.each(['sharing','reset'])('replaces nonempty memory immediately when %s changes during movement',change=>{
    const p=new TokenPresentation();p.sync(snapshot(),10,1000);p.sync(snapshot(550),10,1001);
    const next=snapshot(550);next.exploredTerrain=[newMemory[1]];
    if(change==='sharing')next.map={...next.map!,sharedPartyVision:false};else next.explorationEpoch=1;
    p.sync(next,10,1050);expect(p.moving()).toBe(true);expect(p.explored()).toBe(next.exploredTerrain);
  });
  it('resets on map switches and applies reduced motion without delayed sight',()=>{
    const p=new TokenPresentation();p.sync(snapshot(),10,1000);p.sync(snapshot(550),10,1001,true);
    expect(p.moving()).toBe(false);expect(p.position('varis')!.y).toBe(550);expect(p.explored()).toBe(newMemory);
    const next=snapshot();next.map={...next.map!,id:'other'};p.sync(next,10,1002);
    expect(p.moving()).toBe(false);expect(p.position('varis')!.y).toBe(650);expect(p.explored()).toBe(oldMemory);
  });
  it('shows affinity mid-walk in heavy darkness when passing an enemy with a carried lantern even if endpoints are out of view',()=>{
    const corridorMap={id:'corridor',gridSizePx:50,feetPerSquare:5,mapFogEnabled:false,tokenFogEnabled:false,
      environment:{enabled:true,lighting:'dungeon' as const,heavyDarkness:true,lights:[]},walls:[]};
    const build=(x:number,withEnemy:boolean,shared=false)=>{
      const tokens=[{id:'varis',refId:'varis-sheet',kind:'pc' as const,x,y:600,widthFt:5,carriedLantern:true},
        ...(withEnemy?[{id:'goblin',refId:'goblin-sheet',kind:'monster' as const,x:900,y:600,widthFt:5,sharedSightOnly:shared}]:[])] as Token[];
      const s={role:'player',map:corridorMap,tokens,exploredTerrain:[]} as unknown as StateSnapshot;
      s.playerVision=createPlayerVision(s.map,tokens,new Set(['varis-sheet']));
      return s;
    };
    const p=new TokenPresentation();
    p.sync(build(100,false),10,1000);
    const end=build(1700,false);
    // Mid-walk membership frame has endpoint playerVision (x=1700) plus the passing goblin in tokens.
    const midFrame={...build(1700,true),playerVision:end.playerVision};
    p.sync(midFrame,10,1001,false,{id:'walk',start:1001,durationMs:400,moves:{varis:{from:{x:100,y:600},to:{x:1700,y:600}}}});
    expect(visionShowsAffinity(p.personalVision(),900,600,25)).toBe(false);
    p.advance(1201);
    expect(p.position('varis')!.x).toBe(900);
    expect(visionShowsAffinity(p.personalVision(),900,600,25)).toBe(true);
    p.advance(1402);
    expect(p.position('varis')!.x).toBe(1700);
    expect(visionShowsAffinity(p.personalVision(),900,600,25)).toBe(false);
  });
  it('shows affinity mid-walk in dim light without a lantern when passing within darkvision range',()=>{
    const corridorMap={id:'dim-corridor',gridSizePx:50,feetPerSquare:5,mapFogEnabled:false,tokenFogEnabled:false,
      environment:{enabled:true,lighting:'dungeon' as const,heavyDarkness:false,lights:[]},walls:[]};
    const build=(x:number)=>{
      const tokens=[{id:'varis',refId:'varis-sheet',kind:'pc' as const,x,y:600,widthFt:5,carriedLantern:false},
        {id:'goblin',refId:'goblin-sheet',kind:'monster' as const,x:900,y:600,widthFt:5}] as Token[];
      const s={role:'player',map:corridorMap,tokens,exploredTerrain:[]} as unknown as StateSnapshot;
      s.playerVision=createPlayerVision(s.map,tokens,new Set(['varis-sheet']));
      return s;
    };
    const p=new TokenPresentation();
    p.sync(build(100),10,1000);
    p.sync(build(1700),10,1001,false,{id:'dim-walk',start:1001,durationMs:400,moves:{varis:{from:{x:100,y:600},to:{x:1700,y:600}}}});
    expect(visionShowsAffinity(p.personalVision(),900,600,25)).toBe(false);
    p.advance(1201);
    expect(visionShowsAffinity(p.personalVision(),900,600,25)).toBe(true);
    p.advance(1402);
    expect(visionShowsAffinity(p.personalVision(),900,600,25)).toBe(false);
  });
  it('discovers carried lanterns on units only temporarily visible mid-walk when excluded from endpoint playerVision.lights',()=>{
    const roomMap={id:'lantern-alcove',gridSizePx:50,feetPerSquare:5,mapFogEnabled:false,tokenFogEnabled:false,
      environment:{enabled:true,lighting:'dungeon' as const,heavyDarkness:true,lights:[]},
      walls:[
        {id:'w-left',kind:'rectangle' as const,ax:700,ay:200,bx:700,by:550},
        {id:'w-right',kind:'rectangle' as const,ax:1100,ay:200,bx:1100,by:550},
      ]};
    const startTokens=[{id:'scout',refId:'scout-sheet',kind:'pc' as const,x:300,y:600,widthFt:5}] as Token[];
    const endTokens=[{id:'scout',refId:'scout-sheet',kind:'pc' as const,x:1500,y:600,widthFt:5}] as Token[];
    const midTokens=[
      {id:'scout',refId:'scout-sheet',kind:'pc' as const,x:1500,y:600,widthFt:5},
      {id:'ally',refId:'ally-sheet',kind:'pc' as const,x:900,y:300,widthFt:5,carriedLantern:true},
      {id:'enemy',refId:'goblin-sheet',kind:'monster' as const,x:950,y:300,widthFt:5},
    ] as Token[];
    const start={role:'player',map:roomMap,tokens:startTokens,exploredTerrain:[],
      playerVision:createPlayerVision(roomMap as any,startTokens,new Set(['scout-sheet']))} as unknown as StateSnapshot;
    const endVision=createPlayerVision(roomMap as any,[...endTokens,midTokens[1]],new Set(['scout-sheet']))!;
    expect(endVision.lights).toEqual([]);
    const midFrame={role:'player',map:roomMap,tokens:midTokens,exploredTerrain:[],playerVision:endVision} as unknown as StateSnapshot;
    const p=new TokenPresentation();
    p.sync(start,10,1000);
    p.sync(midFrame,10,1001,false,{id:'alcove-walk',start:1001,durationMs:400,moves:{scout:{from:{x:300,y:600},to:{x:1500,y:600}}}});
    expect(visionShowsAffinity(p.personalVision(),950,300,25)).toBe(false);
    p.advance(1201);
    expect(p.position('scout')!.x).toBe(900);
    expect(p.personalVision()?.lights.some(l=>l.id==='ally'&&l.carried)).toBe(true);
    expect(visionShowsAffinity(p.personalVision(),950,300,25)).toBe(true);
    p.advance(1402);
    expect(p.position('scout')!.x).toBe(1500);
    expect(p.personalVision()?.lights.some(l=>l.id==='ally')).toBe(false);
    expect(visionShowsAffinity(p.personalVision(),950,300,25)).toBe(false);
  });
});
