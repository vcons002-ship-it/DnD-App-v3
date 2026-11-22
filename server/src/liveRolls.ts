import {liveDiceResultWaitMs,liveCalculationWaitMs,LIVE_DICE_RESULT_HOLD_MS,LIVE_PRESENTATION_SYNC_MS,hasDrukMaximum} from '../../shared/dicePresentationTiming.js';
import {randomInt,randomUUID} from 'node:crypto';
import {createLiveWorld} from '../../shared/liveDicePhysics.js';
import {withDiceSource,rollDice,type PhysicalDiceInfo,type WeaponTrayInfo} from '../../shared/dice.js';
import {db} from './db.js';
import {checkpointHpFx,faceTokenToward} from './sessions.js';
import {checkpointReactions} from './reactions.js';
import {stageRollEffects,stagedRollFacing,stagedRollResults,withLiveCalculationPresenter,withLiveRerollChoice,resetLiveRollReveal,hasLiveRollReveal,type LiveRerollPromptRequest,type RollFacing} from './liveRollContext.js';
import type {RollReveal,HiddenRollResult,HiddenRollDice,HiddenRollDecision} from '../../shared/types.js';
import type {LiveDiceFrame,LiveDieRole,LiveTrayBanner} from '../../shared/liveDiceTypes.js';
import {LIVE_DICE_PRESENTATION_RATE} from '../../shared/liveDiceTypes.js';
import {explodingDiceTrigger,matchingDiceTrigger,sorcerousDiceTrigger} from '../../shared/diceTriggers.js';

class NeedDice extends Error {constructor(public sides:number[],public info:PhysicalDiceInfo,public facing:RollFacing[]){super('Waiting for physical dice');}}
class NeedCalculation extends Error {constructor(public key:string,public reveal:RollReveal){super('Waiting for roll calculation');}}
class NeedRerollChoice extends Error {constructor(public key:string,public info:LiveRerollPromptRequest){super('Waiting for reroll decision');}}
class NeedReading extends Error {}
class NeedApproval extends Error {constructor(public results:HiddenRollResult[]){super('Waiting for DM approval');}}
/** Every hidden rolled result waits for approval before its effects are committed. */
export function hiddenRollNeedsApproval(results:HiddenRollResult[]){
 return results.length>0;
}
const queues=new Map<string,Promise<void>>();
export const rollInProgress=(sid:string)=>queues.has(sid);
export function enqueueRoll(sid:string,run:()=>Promise<void>|void,onError:(e:unknown)=>void){
 const previous=queues.get(sid)??Promise.resolve();
 const task=previous.then(run).catch(onError);
 queues.set(sid,task);void task.finally(()=>{if(queues.get(sid)===task)queues.delete(sid);});
}
export class UnsupportedPhysicalDice extends Error {}

export function keptPhysicalSet(values:number[],info:PhysicalDiceInfo):number|undefined {
  if (!info.advantage) return undefined;
  const half=values.length/2;
  const totals=[values.slice(0,half),values.slice(half)].map(faces=>
    withDiceSource(()=>faces,()=>rollDice(info.expr)!.total));
  return info.advantage==='adv' ? (totals[0]>=totals[1]?0:1) : (totals[0]<=totals[1]?0:1);
}

type BurstTray={world:ReturnType<typeof createLiveWorld>;id:string;seq:number;sides:number[];critical:boolean[];dieRoles?:LiveDieRole[];dieLabels?:(string|null)[];capacity:number;parents:number[];links:{from:number;to:number}[]};
type WeaponTray={world:ReturnType<typeof createLiveWorld>;worldCapacity:number;id:string;seq:number;plannedDice:{sides:number;set:number;critical?:boolean}[];sides:number[];sets:number[];critical:boolean[];dieRoles:LiveDieRole[];dieLabels:(string|null)[];dieAdjustedValues?:(number|null)[];links:{from:number;to:number}[];burstLinks:{from:number;to:number}[];setCount:number;baseCount?:number;extraWeaponCritCount?:number;hasReroll:boolean;interactiveReroll?:boolean;hasExtraCrit:boolean;hasCustomExtraCrit?:boolean;rerollLabel:string;extraCritLabel:string;extraCritLabels?:string[];extraCritSides?:number;damageExpr:string;crit:boolean;firstTotal?:number;secondTotal?:number;keptSet?:number;discardedDice?:boolean[];minFace?:{value:number;label:string};luckyLabel?:string;luckyAdvantage?:'adv'|'dis'};
type LiveRollMeta={burstTray?:{current?:BurstTray};weaponTray?:{current?:WeaponTray};label:string;roller:string;className:string;attacker?:string;diceTheme?:'gold';dmDice?:boolean;affinity?:'friendly'|'neutral'|'enemy';requireSaveStart?:boolean;saveDiceArt?:(target:NonNullable<PhysicalDiceInfo['target']>)=>import('../../shared/diceThemes.js').SaveDiceArt;configureDice?:(info:PhysicalDiceInfo)=>Partial<LiveRollMeta>;ready?:(id:string,awaitStart?:boolean)=>Promise<void>;waitForPresentation?:(id:string,ms:number)=>Promise<void>;chooseReroll?:(id:string,info:LiveRerollPromptRequest,promptId:string)=>Promise<boolean>;onFacing?:()=>void;deferFacing?:boolean;review?:(results:HiddenRollResult[],dice:HiddenRollDice[],manual:boolean)=>Promise<boolean|HiddenRollDecision>};

export async function physicalFaces(
  sides:number[], publish:(frame:LiveDiceFrame)=>void,
  meta:LiveRollMeta, seed=randomInt(0,0xffffffff), info?:PhysicalDiceInfo,
) {
  if(sides.some(s=>![4,6,8,10,12,20,100].includes(s)))
    throw new UnsupportedPhysicalDice('Live rolls support d4, d6, d8, d10, d12, d20 and d100. Choose one of these dice.');
  const {ready,onFacing,waitForPresentation,chooseReroll,burstTray,weaponTray,review,deferFacing,requireSaveStart,configureDice,saveDiceArt,...displayMeta}=meta;
  const awaitStart=!!requireSaveStart&&(!!info?.saveDice?.some(d=>!d.rollKind)||/\bsav(?:e|ing throw)\b/i.test(info?.label??meta.label));
  if(typeof info?.triggerRule==='object'&&burstTray)return burstFaces(sides,publish,meta,seed,info);
  if(info?.weaponTray&&weaponTray&&info.weaponTray.plannedDice.length<=40&&info.weaponTray.plannedDice.every(d=>[4,6,8,10,12,20].includes(d.sides))){
    const cur=weaponTray.current;
    const wt=info.weaponTray;
    const fitsExisting=wt.phase==='initial'||(!!cur&&cur.sides.length+sides.length<=cur.worldCapacity&&sides.every((s,i)=>cur.plannedDice[cur.sides.length+i]===undefined||cur.plannedDice[cur.sides.length+i].sides===s));
    if(fitsExisting)return weaponTrayFaces(sides,publish,meta,seed,info);
  }
  // A caster initiates these commands, but the saved creatures own the dice.
  // Batches containing NPC saves use the shared DM tray rather than the caster.
  if(info?.saveDice?.some(save=>!save.rollKind&&save.target.kind==='monster')){
    displayMeta.dmDice=true;displayMeta.className='';displayMeta.affinity=undefined;
  }
  const singleSave=info?.target&&/\bsav(?:e|ing throw)\b/i.test(info.label??meta.label)?info.target:undefined;
  if(singleSave&&saveDiceArt)Object.assign(displayMeta,saveDiceArt(singleSave));
  const result:number[]=[];
  // Bound each live world to forty physical bodies; keep percentile pairs together.
  for(let offset=0;offset<sides.length;) {
    const logical:number[]=[]; let count=0;
    while(offset+logical.length<sides.length) {
      const side=sides[offset+logical.length], next=side===100?2:1;
      const save=info?.saveDice?.[offset+logical.length];
      if(save&&info?.saveDice&&count>0&&info.saveDice[offset+logical.length-1]?.group!==save.group){
        const groupSize=info.saveDice.slice(offset+logical.length).findIndex(d=>d.group!==save.group);
        if(count+(groupSize<0?info.saveDice.length-offset-logical.length:groupSize)>40)break;
      }
      if(count+next>40) break;
      logical.push(side); count+=next;
    }
    const diceArt=info?.saveDice?.some(d=>!d.rollKind||d.rollKind==='initiative')&&saveDiceArt?logical.flatMap((side,i)=>Array.from({length:side===100?2:1},()=>saveDiceArt(info.saveDice![offset+i].target))):undefined;
    const expanded=logical.flatMap(s=>s===100?[10,10]:[s]);
    const world=createLiveWorld(expanded.map((sides,index)=>({sides,value:1,index,set:0})),seed+offset,'bottom');
    const id=randomUUID(); let seq=0;
    const sets=logical.flatMap((s,i)=>Array(s===100?2:1).fill(info?.advantage && offset+i>=sides.length/2?1:0));
    const critical=logical.flatMap((s,i)=>Array(s===100?2:1).fill(!!info?.criticalDice?.[offset+i] || !!info?.critical || info?.criticalFrom!==undefined && offset+i>=info.criticalFrom));
    const percentile:('tens'|'ones'|null)[]=logical.flatMap(s=>s===100?['tens','ones'] as const:[null]);
    const decode=(values:number[])=>{
      let i=0;
      return logical.map(side=>{
        if(side!==100) return values[i++];
        const tens=values[i++]-1, ones=values[i++]-1;
        return tens*10+ones||100;
      });
    };
    const emit=()=>{
      const state=world.snapshot();
      const kept=state.done&&info?.advantage&&offset+logical.length===sides.length
        ? keptPhysicalSet([...result,...decode(state.values as number[])],info) : undefined;
      const impacts=world.drainImpacts();
      // Announce on settlement, before the reading hold and command commit.
      // Orb pools fit one tray; never treat a partial chunk as the whole spell.
      const burst=typeof info?.triggerRule==='object'?info.triggerRule:undefined;
      const diceTrigger=state.done&&offset===0&&logical.length===sides.length
        ?info?.triggerRule==='orb-matches'?matchingDiceTrigger(state.values as number[]):burst?sorcerousDiceTrigger(state.values as number[],burst.used,burst.limit,burst.queued):undefined:undefined;
      const standaloneMeta={
        ...(info?.trayBanner?{trayBanner:info.trayBanner}:{}),
        ...(info?.dieRole?{dieRoles:expanded.map(()=>info.dieRole!)}:{}),
        ...(info?.dieLabel?{dieLabels:expanded.map(()=>info.dieLabel!)}:{}),
      };
      publish({...state,...(awaitStart&&state.elapsed===0?{awaitingStart:true}:{}),...(burst?{burstProgress:{used:burst.used,limit:burst.limit}}:{}),...(diceTrigger?{diceTrigger}:{}),poses:state.poses.map(v=>Math.round(v*10000)/10000),...(impacts.length?{impacts}:{}),id,seq:seq++,sides:expanded,sets,critical,percentile,mode:info?.advantage,...(info?.advantageReasons?.length?{advantageReasons:info.advantageReasons,advantageState:info.advantageState??info.advantage??'straight'}:{}),kept,...(info?.saveDice?{dieOffset:offset}:{}),...displayMeta,...(diceArt?{diceArt}:{}),...standaloneMeta});
      return state;
    };
    const prepared=ready?.(id,awaitStart);
    emit();
    await prepared;
    const values=await new Promise<number[]>((resolve,reject)=>{
      let last=performance.now(),credit=0;
      const timer=setInterval(()=>{
        try {
          const now=performance.now(); credit+=Math.min(.1,(now-last)/1000)*LIVE_DICE_PRESENTATION_RATE; last=now;
          while(credit>=1/120) {
            world.advance(1/120); credit-=1/120;
            if(world.snapshot().done) break;
          }
          const state=emit();
          if(state.done) { clearInterval(timer); resolve(state.values as number[]); }
        } catch(e) { clearInterval(timer); reject(e); }
      },1000/30);
    });
    // Allow the visible face-to-result animation to finish before publishing damage.
    const readingMs=liveDiceResultWaitMs(expanded.length, !!info?.saveDice);
    if(waitForPresentation)await waitForPresentation(id,readingMs);
    else await new Promise(resolve=>setTimeout(resolve,readingMs));
    result.push(...decode(values)); offset+=logical.length;
  }
  return result;
}
/** Sorcerous Burst & generalized Exploding Dice continue in one authoritative world and tray. */
async function burstFaces(sides:number[],publish:(frame:LiveDiceFrame)=>void,meta:LiveRollMeta,seed:number,info:PhysicalDiceInfo){
 const burst=info.triggerRule;if(typeof burst!=='object')throw new Error('Missing burst rule');
 const isCustom=burst.kind==='exploding-dice';
 const customLabel=burst.label||'Exploding Dice';
 const {ready,onFacing,waitForPresentation,chooseReroll,burstTray,weaponTray,review,deferFacing,requireSaveStart,configureDice,saveDiceArt,...display}=meta;
 let tray=burstTray!.current;
 if(burst.used===0){
  const capacity=Math.min(40,sides.length+burst.limit);
  const critical=sides.map((_,i)=>!!info.criticalDice?.[i]||!!info.critical||info.criticalFrom!==undefined&&i>=info.criticalFrom);
  tray={world:createLiveWorld(sides.map((sides,index)=>({sides,value:1,index,set:0})),seed,'bottom',capacity),id:randomUUID(),seq:0,sides:[...sides],critical,
   ...(isCustom?{dieRoles:critical.map((c):LiveDieRole=>c?'crit':'base'),dieLabels:critical.map(c=>c?'CRIT':null)}:{}),
   capacity,parents:[],links:[]};
  burstTray!.current=tray;
 }
 if(!tray)throw new Error('Missing original burst tray');
 const start=burst.used===0?0:tray.sides.length;
 if(start){
  if((!isCustom&&sides.some(side=>side!==8))||sides.length>tray.parents.length)throw new Error('Missing triggering burst dice');
  const parents=tray.parents.splice(0,sides.length);
  parents.forEach((from,i)=>tray.links.push({from,to:start+i}));
  tray.world.appendDice(sides.map((sides,i)=>({sides,value:1,index:start+i,set:0})));
  tray.sides.push(...sides);tray.critical.push(...sides.map(()=>false));
  if(tray.dieRoles)tray.dieRoles.push(...sides.map(()=>'exploded' as const));
  if(tray.dieLabels)tray.dieLabels.push(...sides.map(()=>customLabel));
 }
 const current=tray;
 const emit=()=>{
  const state=current.world.snapshot(),faces=state.values.slice(start) as number[];
  const triggerSides=current.sides.slice(start);
  const trigger=state.done
    ?isCustom
      ?explodingDiceTrigger(faces,triggerSides,burst.triggerFace??'max',burst.used,burst.limit,burst.queued,customLabel)
      :sorcerousDiceTrigger(faces,burst.used,burst.limit,burst.queued)
    :undefined;
  const impacts=current.world.drainImpacts();
  const customExtras=isCustom?{
    ...(current.dieRoles?{dieRoles:[...current.dieRoles]}:{}),
    ...(current.dieLabels?{dieLabels:[...current.dieLabels]}:{}),
    ...(start>0?{trayBanner:{title:customLabel,detail:state.done?`Exploded +${sides.length} (${faces.join(' + ')})`:`Exploding +${sides.length} bonus dice\u2026`,tone:'explode' as const}}
      :state.done&&trigger&&trigger.kind==='exploding-dice'?{trayBanner:{title:customLabel,detail:trigger.detail,tone:'explode' as const}}:{}),
  }:{};
  publish({...state,...display,id:current.id,seq:current.seq++,sides:[...current.sides],sets:current.sides.map(()=>0),critical:[...current.critical],percentile:current.sides.map(()=>null),burstCapacity:current.capacity,burstLinks:[...current.links],burstProgress:{used:burst.used,limit:burst.limit},...customExtras,...(trigger?{diceTrigger:{...trigger,groups:trigger.groups.map(g=>({...g,indices:g.indices.map(i=>i+start)}))}}:{}),...(impacts.length?{impacts}:{})});
  return state;
 };
 const prepared=start?undefined:ready?.(current.id);emit();await prepared;
 const faces=await new Promise<number[]>((resolve,reject)=>{
  let last=performance.now(),credit=0;
  const timer=setInterval(()=>{try{
   const now=performance.now();credit+=Math.min(.1,(now-last)/1000)*LIVE_DICE_PRESENTATION_RATE;last=now;
   while(credit>=1/120){current.world.advance(1/120);credit-=1/120;if(current.world.snapshot().done)break;}
   const state=emit();if(state.done){clearInterval(timer);resolve(state.values.slice(start) as number[]);}
  }catch(e){clearInterval(timer);reject(e);}},1000/30);
 });
 if(!isCustom || burst.recursive!==false){
  const trigFace=burst.triggerFace;
  faces.forEach((face,i)=>{const want=trigFace??current.sides[start+i];if(face===want)current.parents.push(start+i);});
 }
 // Bursting dice need time to show the link before the next live dice enter.
 const readingMs=liveDiceResultWaitMs(faces.length,false,true);
 if(waitForPresentation)await waitForPresentation(current.id,readingMs);else await new Promise(resolve=>setTimeout(resolve,readingMs));
 return faces;
}
/** Savage Attacker, Savage Attacks, Halfling Lucky, floors, rerolls & riders continue inside one tray. */
async function weaponTrayFaces(sides:number[],publish:(frame:LiveDiceFrame)=>void,meta:LiveRollMeta,seed:number,info:PhysicalDiceInfo){
 const wt:WeaponTrayInfo|undefined=info.weaponTray;
 if(!wt)throw new Error('Missing weapon tray metadata');
 const {ready,onFacing,waitForPresentation,chooseReroll,burstTray,weaponTray,review,deferFacing,requireSaveStart,configureDice,saveDiceArt,...display}=meta;
 const rerollLabel=wt.rerollLabel||'Savage Attacker';
 const extraCritLabel=wt.extraCritLabel||'Savage Attacks';
 let tray=weaponTray!.current;
 let start=0;
 if(wt.phase==='initial'){
  const isLucky=!!wt.luckyLabel;
  const worldCapacity=Math.min(40,Math.max(wt.plannedDice.length,sides.length));
  if(isLucky){
   const sets=sides.map((_,i)=>i);
   const critical=sides.map(()=>false);
   tray={
    world:createLiveWorld(sides.map((s,index)=>({sides:s,value:1,index,set:sets[index]})),seed,'bottom',worldCapacity),
    worldCapacity,id:randomUUID(),seq:0,plannedDice:wt.plannedDice,sides:[...sides],sets,critical,
    dieRoles:sides.map(()=>'base'),dieLabels:sides.map(()=>null),links:[],burstLinks:[],
    setCount:sides.length,hasReroll:false,hasExtraCrit:false,rerollLabel,extraCritLabel,
    damageExpr:wt.damageExpr,crit:false,luckyLabel:wt.luckyLabel,luckyAdvantage:info.advantage,
   };
  }else{
   const extraWepCount=wt.extraWeaponCritCount??0;
   const critEnd=Math.max(0,wt.setCount-extraWepCount);
   const baseCount=wt.baseCount??(wt.crit?Math.floor(critEnd/2):critEnd);
   const combinedExtra=!wt.hasReroll&&wt.hasExtraCrit;
   const sets=sides.map((_,i)=>combinedExtra&&i>=critEnd?2:0);
   const critical=sides.map((_,i)=>i>=baseCount);
   const dieRoles:LiveDieRole[]=sides.map((_,i)=>i>=critEnd?'savage-crit':i>=baseCount?'crit':'base');
   const dieLabels:(string|null)[]=sides.map((_,i)=>{
    if(i>=critEnd){
     const lbl=wt.extraCritLabels?.[i-critEnd]??extraCritLabel;
     return wt.hasReroll&&!wt.interactiveReroll&&i<wt.setCount?`Roll 1 \u00b7 ${lbl}`:lbl;
    }
    if(wt.hasReroll&&!wt.interactiveReroll)return i>=baseCount?'Roll 1 \u00b7 CRIT':'Roll 1';
    return i>=baseCount?'CRIT':null;
   });
   const hasCustomExtraCrit=(wt.extraCritLabels?.length??0)>extraWepCount;
   tray={
    world:createLiveWorld(sides.map((s,index)=>({sides:s,value:1,index,set:sets[index]})),seed,'bottom',worldCapacity),
    worldCapacity,id:randomUUID(),seq:0,plannedDice:wt.plannedDice,sides:[...sides],sets,critical,dieRoles,dieLabels,links:[],burstLinks:[],
    setCount:wt.setCount,baseCount,extraWeaponCritCount:extraWepCount,hasReroll:wt.hasReroll,interactiveReroll:wt.interactiveReroll,
    hasExtraCrit:wt.hasExtraCrit,hasCustomExtraCrit,rerollLabel,extraCritLabel,extraCritLabels:wt.extraCritLabels,
    extraCritSides:wt.extraCritSides,damageExpr:wt.damageExpr,crit:wt.crit,minFace:wt.minFace,
   };
  }
  weaponTray!.current=tray;
 }else{
  if(!tray)throw new Error('Missing original weapon tray');
  start=tray.sides.length;
  if(wt.phase==='lucky-reroll'){
   const srcIdx=wt.luckySourceIndex??0;
   const luckyLabel=wt.luckyLabel??tray.luckyLabel??'Halfling Lucky';
   const inheritedSet=tray.sets[srcIdx]??0;
   tray.links.push({from:srcIdx,to:start});
   tray.discardedDice??=Array(start).fill(false);
   tray.discardedDice[srcIdx]=true;
   tray.discardedDice.push(false);
   tray.dieRoles[srcIdx]='base';
   tray.dieLabels[srcIdx]='Rolled 1';
   tray.world.appendDice(sides.map((s,i)=>({sides:s,value:1,index:start+i,set:inheritedSet})));
   tray.sides.push(...sides);tray.sets.push(...sides.map(()=>inheritedSet));tray.critical.push(...sides.map(()=>false));
   tray.dieRoles.push('lucky-reroll');tray.dieLabels.push(luckyLabel);
  }else if(wt.phase==='savage-reroll'){
   const extraWepCount=tray.extraWeaponCritCount??0;
   const critEnd=Math.max(0,tray.setCount-extraWepCount);
   const baseCount=tray.baseCount??(tray.crit?Math.floor(critEnd/2):critEnd);
   for(let i=0;i<tray.setCount&&i<tray.dieLabels.length;i++){
    if(tray.dieRoles[i]==='floored')continue;
    if(i>=critEnd){
     const lbl=tray.extraCritLabels?.[i-critEnd]??tray.extraCritLabel;
     tray.dieLabels[i]=`Roll 1 \u00b7 ${lbl}`;
    }else{
     tray.dieLabels[i]=i>=baseCount?'Roll 1 \u00b7 CRIT':'Roll 1';
    }
   }
   const newCritical=sides.map((_,i)=>i>=baseCount);
   const newRoles:LiveDieRole[]=sides.map((_,i)=>i>=critEnd?'savage-crit':i>=baseCount?'reroll-crit':'reroll');
   const newLabels=sides.map((_,i)=>i>=critEnd?(tray!.extraCritLabels?.[i-critEnd]??tray!.extraCritLabel):i>=baseCount?'Reroll \u00b7 CRIT':'Reroll');
   sides.forEach((_,i)=>tray!.links.push({from:i,to:start+i}));
   tray.world.appendDice(sides.map((s,i)=>({sides:s,value:1,index:start+i,set:1})));
   tray.sides.push(...sides);tray.sets.push(...sides.map(()=>1));tray.critical.push(...newCritical);tray.dieRoles.push(...newRoles);tray.dieLabels.push(...newLabels);
   if(tray.dieAdjustedValues)tray.dieAdjustedValues.push(...sides.map(()=>null));
  }else if(wt.phase==='die-reroll'){
   const sources=wt.rerollSourceIndices??[];
   sources.forEach((from,i)=>tray!.links.push({from,to:start+i}));
   const newCritical=sources.map(idx=>!!tray!.critical[idx]);
   const newRoles:LiveDieRole[]=newCritical.map(c=>c?'reroll-crit':'reroll');
   const newLabels=sources.map((_,i)=>`${wt.rerollLabel??rerollLabel}`);
   tray.world.appendDice(sides.map((s,i)=>({sides:s,value:1,index:start+i,set:1})));
   tray.sides.push(...sides);tray.sets.push(...sides.map(()=>1));tray.critical.push(...newCritical);tray.dieRoles.push(...newRoles);tray.dieLabels.push(...newLabels);
   if(tray.discardedDice)tray.discardedDice.push(...sides.map(()=>false));
   if(tray.dieAdjustedValues)tray.dieAdjustedValues.push(...sides.map(()=>null));
  }else if(wt.phase==='explode'){
   const parents=wt.explodeParentIndices??[];
   parents.forEach((from,i)=>tray!.burstLinks.push({from,to:start+i}));
   const newCritical=parents.map(idx=>!!tray!.critical[idx]);
   tray.world.appendDice(sides.map((s,i)=>({sides:s,value:1,index:start+i,set:2})));
   tray.sides.push(...sides);tray.sets.push(...sides.map(()=>2));tray.critical.push(...newCritical);
   tray.dieRoles.push(...sides.map(()=>'exploded' as const));tray.dieLabels.push(...sides.map(()=>wt.explodeLabel||'Exploding'));
   if(tray.discardedDice)tray.discardedDice.push(...sides.map(()=>false));
   if(tray.dieAdjustedValues)tray.dieAdjustedValues.push(...sides.map(()=>null));
  }else if(wt.phase==='rider'){
   tray.world.appendDice(sides.map((s,i)=>({sides:s,value:1,index:start+i,set:2})));
   tray.sides.push(...sides);tray.sets.push(...sides.map(()=>2));tray.critical.push(...sides.map(()=>false));
   tray.dieRoles.push(...sides.map(()=>'rider' as const));tray.dieLabels.push(...sides.map(()=>wt.riderLabel||'Bonus Damage'));
   if(tray.discardedDice)tray.discardedDice.push(...sides.map(()=>false));
   if(tray.dieAdjustedValues)tray.dieAdjustedValues.push(...sides.map(()=>null));
  }else{
   tray.world.appendDice(sides.map((s,i)=>({sides:s,value:1,index:start+i,set:2})));
   tray.sides.push(...sides);tray.sets.push(...sides.map(()=>2));tray.critical.push(...sides.map(()=>true));
   tray.dieRoles.push(...sides.map(()=>'savage-crit' as const));
   tray.dieLabels.push(...sides.map((_,i)=>wt.extraCritLabels?.[i]??tray!.extraCritLabel));
   if(tray.discardedDice)tray.discardedDice.push(...sides.map(()=>false));
   if(tray.dieAdjustedValues)tray.dieAdjustedValues.push(...sides.map(()=>null));
  }
 }
 const current=tray;
 const effectiveAt=(values:(number|null)[],i:number)=>current.dieAdjustedValues?.[i]??values[i]??0;
 const sumSlice=(values:(number|null)[],from:number,count:number)=>values.slice(from,from+count).reduce<number>((sum,_,idx)=>sum+effectiveAt(values,from+idx),0);
 const applyFloor=(values:(number|null)[],indices:number[])=>{
  const min=current.minFace;
  if(!min||min.value<2)return [] as {index:number;raw:number;eff:number}[];
  current.dieAdjustedValues??=current.sides.map(()=>null);
  while(current.dieAdjustedValues.length<current.sides.length)current.dieAdjustedValues.push(null);
  const adjusted:{index:number;raw:number;eff:number}[]=[];
  for(const i of indices){
   const raw=values[i];
   if(raw!==null&&raw<min.value){
    current.dieAdjustedValues[i]=min.value;
    current.dieRoles[i]='floored';
    current.dieLabels[i]=`${min.label} (${raw}\u2192${min.value})`;
    adjusted.push({index:i,raw,eff:min.value});
   }
  }
  return adjusted;
 };
 const emit=()=>{
  const state=current.world.snapshot(),faces=state.values.slice(start) as number[];
  const impacts=current.world.drainImpacts();
  let trayBanner:LiveTrayBanner|undefined;
  let diceTrigger:RollReveal['diceTrigger']|undefined;
  let luckyAdvKept:number|undefined;
  if(wt.phase==='initial'&&current.luckyLabel){
   if(state.done){
    const oneIndex=state.values.findIndex(v=>v===1);
    if(oneIndex>=0){
     trayBanner={title:current.luckyLabel,detail:'Rolled natural 1 \u2014 rerolling d20\u2026',tone:'lucky'};
     diceTrigger={kind:'halfling-lucky',title:`${current.luckyLabel}!`,detail:'Natural 1 \u2014 rerolling d20 automatically',diceCount:current.sides.length,groups:[{value:1,indices:[oneIndex]}]};
    }else if(info.advantage&&state.values.length>=2){
     const [a,b]=state.values as number[];
     luckyAdvKept=info.advantage==='adv'?(a>=b?0:1):(a<=b?0:1);
    }
   }
  }else if(wt.phase==='initial'){
   const floored=state.done?applyFloor(state.values,current.sides.map((_,i)=>i)):[];
   if(!current.hasReroll&&current.hasExtraCrit){
    const extraIndices=current.sides.flatMap((_,i)=>current.dieRoles[i]==='savage-crit'?[i]:[]);
    const extraCount=extraIndices.length,extraSides=current.extraCritSides??current.sides[extraIndices[0]??current.sides.length-1];
    if(state.done){
     const extraFaces=extraIndices.map(i=>effectiveAt(state.values,i));
     const floorNote=floored.length?` \u00b7 ${current.minFace!.label} raised ${floored.map(f=>`${f.raw}\u2192${f.eff}`).join(', ')}`:'';
     trayBanner={title:current.extraCritLabel,detail:`+${extraCount}d${extraSides} extra crit ${extraCount===1?'die':'dice'} (${extraFaces.join(', ')})${floorNote}`,tone:'savage-crit'};
     diceTrigger={kind:'savage-attacks',title:`${current.extraCritLabel}!`,detail:`Added +${extraCount}d${extraSides} extra crit ${extraCount===1?'die':'dice'} (${extraFaces.join(', ')}) on critical hit`,diceCount:current.sides.length,groups:[{value:extraFaces.reduce((a,b)=>a+b,0),indices:extraIndices}]};
    }else{
     trayBanner={title:current.extraCritLabel,detail:`+${extraCount}d${extraSides} extra crit ${extraCount===1?'die':'dice'} included`,tone:'savage-crit'};
    }
   }else if(wt.minFace&&!current.hasReroll){
    if(state.done&&floored.length){
     trayBanner={title:wt.minFace.label,detail:`Minimum die floor ${wt.minFace.value}: ${floored.map(f=>`${f.raw}\u2192${f.eff}`).join(', ')}`,tone:'floor'};
     diceTrigger={kind:'dice-floor',title:wt.minFace.label,detail:`Raised ${floored.map(f=>`${f.raw}\u2192${f.eff}`).join(', ')}`,diceCount:current.sides.length,groups:[{value:wt.minFace.value,indices:floored.map(f=>f.index)}]};
    }else if(wt.bannerOverride){
     trayBanner=wt.bannerOverride;
    }
   }else if(!current.hasReroll&&wt.bannerOverride){
    trayBanner=wt.bannerOverride;
   }else if(current.interactiveReroll){
    const extraWepCount=current.extraWeaponCritCount??0;
    if(state.done&&floored.length){
     trayBanner={title:current.minFace!.label,detail:`Minimum die floor ${current.minFace!.value}: ${floored.map(f=>`${f.raw}\u2192${f.eff}`).join(', ')}`,tone:'floor'};
     diceTrigger={kind:'dice-floor',title:current.minFace!.label,detail:`Raised ${floored.map(f=>`${f.raw}\u2192${f.eff}`).join(', ')}`,diceCount:current.sides.length,groups:[{value:current.minFace!.value,indices:floored.map(f=>f.index)}]};
    }else if(extraWepCount>0){
     const extraIndices=current.sides.flatMap((_,i)=>current.dieRoles[i]==='savage-crit'?[i]:[]);
     const extraSides=current.extraCritSides??current.sides[extraIndices[0]??current.sides.length-1];
     if(state.done){
      const extraFaces=extraIndices.map(i=>effectiveAt(state.values,i));
      trayBanner={title:current.extraCritLabel,detail:`+${extraWepCount}d${extraSides} extra crit ${extraWepCount===1?'die':'dice'} (${extraFaces.join(', ')})`,tone:'savage-crit'};
      diceTrigger={kind:'savage-attacks',title:`${current.extraCritLabel}!`,detail:`Added +${extraWepCount}d${extraSides} extra crit ${extraWepCount===1?'die':'dice'} (${extraFaces.join(', ')}) on critical hit`,diceCount:current.sides.length,groups:[{value:extraFaces.reduce((a,b)=>a+b,0),indices:extraIndices}]};
     }else{
      trayBanner={title:current.extraCritLabel,detail:`+${extraWepCount}d${extraSides} extra crit ${extraWepCount===1?'die':'dice'} included`,tone:'savage-crit'};
     }
    }else if(wt.bannerOverride){
     trayBanner=wt.bannerOverride;
    }
   }else{
    const exprDesc=`${current.damageExpr}${current.crit?' (crit)':''}`;
    if(state.done){
     const firstTotal=sumSlice(state.values,0,current.setCount);
     current.firstTotal=firstTotal;
     const rerollVerb=wt.rerollMode==='die-lte'?`rerolling dice \u2264${wt.rerollMaxFace??2}`:'rerolling to keep higher';
     trayBanner={title:current.rerollLabel,detail:`Roll 1: ${firstTotal} \u2014 ${rerollVerb}`,tone:wt.rerollMode==='die-lte'?'reroll':current.hasExtraCrit?'savage-both':'savage-reroll'};
     diceTrigger={kind:'savage-attacker',title:`${current.rerollLabel}!`,detail:`Rolled ${firstTotal} on ${exprDesc}`,diceCount:current.setCount,groups:[{value:firstTotal,indices:Array.from({length:current.setCount},(_,i)=>i)}]};
    }else{
     trayBanner={title:current.rerollLabel,detail:`Rolling ${exprDesc} \u2014 will apply ${current.rerollLabel}`,tone:wt.rerollMode==='die-lte'?'reroll':current.hasExtraCrit?'savage-both':'savage-reroll'};
    }
   }
  }else if(wt.phase==='lucky-reroll'){
   const srcIdx=wt.luckySourceIndex??0;
   const luckyTitle=wt.luckyLabel??current.luckyLabel??'Halfling Lucky';
   if(state.done){
    const newFace=state.values[start] as number;
    const luckyAdv=info.advantage??current.luckyAdvantage;
    if(luckyAdv){
     const activePerSet=new Map<number,number>();
     current.sets.forEach((s,i)=>{if(!current.discardedDice?.[i]&&state.values[i]!==null)activePerSet.set(s,state.values[i] as number);});
     const s0=activePerSet.get(0)??0,s1=activePerSet.get(1)??0;
     luckyAdvKept=luckyAdv==='adv'?(s0>=s1?0:1):(s0<=s1?0:1);
    }
    trayBanner={title:luckyTitle,detail:`Rerolled natural 1 \u2192 ${newFace}`,tone:'lucky'};
    diceTrigger={kind:'halfling-lucky',title:`${luckyTitle}!`,detail:`Natural 1 replaced by ${newFace}`,diceCount:current.sides.length,groups:[{value:newFace,indices:[start]}]};
   }else{
    trayBanner={title:luckyTitle,detail:'Natural 1 \u2014 rolling replacement d20\u2026',tone:'lucky'};
   }
  }else if(wt.phase==='savage-reroll'){
   if(state.done)applyFloor(state.values,Array.from({length:current.setCount},(_,i)=>start+i));
   const firstTotal=current.firstTotal??sumSlice(state.values,0,current.setCount);
   const extraWepCount=current.extraWeaponCritCount??0;
   const critEnd=Math.max(0,current.setCount-extraWepCount);
   if(state.done){
    const secondTotal=sumSlice(state.values,start,current.setCount);
    current.secondTotal=secondTotal;
    const keptSet=wt.rerollKeep==='new'?1:(secondTotal>firstTotal?1:0);
    current.keptSet=keptSet;
    current.discardedDice=current.sets.map(s=>s!==keptSet);
    for(let k=0;k<extraWepCount;k++){
     const lbl=current.extraCritLabels?.[k]??current.extraCritLabel;
     const w1Idx=critEnd+k,w2Idx=start+critEnd+k;
     if(current.dieRoles[w1Idx]!=='floored')current.dieLabels[w1Idx]=keptSet===0?lbl:`Roll 1 \u00b7 ${lbl}`;
     if(current.dieRoles[w2Idx]!=='floored')current.dieLabels[w2Idx]=keptSet===1?lbl:`Reroll \u00b7 ${lbl}`;
    }
    const summary=wt.rerollKeep==='new'?`Used reroll (${secondTotal} vs ${firstTotal})`:secondTotal>firstTotal?`Kept reroll (${secondTotal} vs ${firstTotal})`:secondTotal<firstTotal?`Kept original (${firstTotal} vs ${secondTotal})`:`Tied (${firstTotal} vs ${secondTotal}) \u2014 kept Roll 1`;
    const extraCount=extraWepCount||(wt.extraCritDiceSides?.length||1),extraSides=current.extraCritSides??0;
    const bannerTitle=extraWepCount>0?`${current.rerollLabel} & ${current.extraCritLabel}`:current.rerollLabel;
    const bannerDetail=extraWepCount>0?`${summary} \u00b7 incl. +${extraWepCount}d${extraSides} ${current.extraCritLabel}`:current.hasCustomExtraCrit?`${summary} \u00b7 adding +${extraCount}d${extraSides} ${current.extraCritLabel}`:summary;
    trayBanner={title:bannerTitle,detail:bannerDetail,tone:(extraWepCount>0||current.hasCustomExtraCrit)?'savage-both':'savage-reroll'};
    diceTrigger={kind:'savage-attacker',title:`${current.rerollLabel}: ${summary}`,detail:extraWepCount>0?`Rerolled ${firstTotal} \u2192 ${secondTotal} (including +${extraWepCount}d${extraSides} ${current.extraCritLabel}); kept higher set`:current.hasCustomExtraCrit?`Rerolled ${firstTotal} \u2192 ${secondTotal}; keeping ${keptSet===1?'reroll':'original'}, now rolling +${extraCount}d${extraSides} ${current.extraCritLabel}`:`Rolled ${firstTotal}, rerolled ${secondTotal} \u2014 kept higher weapon damage`,diceCount:current.sides.length,groups:[{value:wt.rerollKeep==='new'?secondTotal:Math.max(firstTotal,secondTotal),indices:current.sets.flatMap((s,i)=>s===keptSet?[i]:[])}]};
   }else{
    trayBanner={title:current.rerollLabel,detail:`Roll 1: ${firstTotal} \u2014 rolling reroll\u2026`,tone:current.hasExtraCrit?'savage-both':'savage-reroll'};
   }
  }else if(wt.phase==='die-reroll'){
   const sources=wt.rerollSourceIndices??[];
   const label=wt.rerollLabel||current.rerollLabel;
   if(state.done){
    applyFloor(state.values,Array.from({length:sides.length},(_,i)=>start+i));
    current.discardedDice=current.sides.map(()=>false);
    const changes:string[]=[];
    const keptIndices:number[]=[];
    sources.forEach((origIdx,k)=>{
     const newIdx=start+k;
     const origEff=effectiveAt(state.values,origIdx),newEff=effectiveAt(state.values,newIdx);
     if(wt.rerollKeep==='new'||newEff>origEff){
      current.discardedDice![origIdx]=true;keptIndices.push(newIdx);changes.push(`${origEff}\u2192${newEff}`);
     }else{
      current.discardedDice![newIdx]=true;keptIndices.push(origIdx);changes.push(`${origEff}\u2192${newEff} (kept ${origEff})`);
     }
    });
    trayBanner={title:label,detail:`Rerolled ${changes.join(', ')}`,tone:'reroll'};
    diceTrigger={kind:'die-reroll',title:`${label}!`,detail:`Rerolled ${changes.join(', ')}`,diceCount:current.sides.length,groups:[{value:keptIndices.reduce((s,idx)=>s+effectiveAt(state.values,idx),0),indices:keptIndices}]};
   }else{
    trayBanner={title:label,detail:`Rerolling ${sources.length} low ${sources.length===1?'die':'dice'}\u2026`,tone:'reroll'};
   }
  }else if(wt.phase==='explode'){
   const label=wt.explodeLabel||'Exploding Dice';
   if(state.done){
    const totalAdded=faces.reduce((a,b)=>a+b,0);
    const addedIndices=sides.map((_,i)=>start+i);
    trayBanner=wt.bannerOverride??{title:label,detail:`Exploded +${sides.length} bonus ${sides.length===1?'die':'dice'} (${faces.join(' + ')} = ${totalAdded})`,tone:'explode'};
    diceTrigger={kind:'exploding-dice',title:`${label}!`,detail:`Added +${sides.length} exploding ${sides.length===1?'die':'dice'} (+${totalAdded})`,diceCount:current.sides.length,groups:[{value:totalAdded,indices:addedIndices}]};
   }else{
    trayBanner={title:label,detail:`Rolling +${sides.length} exploding bonus ${sides.length===1?'die':'dice'}\u2026`,tone:'explode'};
   }
  }else if(wt.phase==='rider'){
   const label=wt.riderLabel||'Triggered Bonus';
   if(state.done){
    const totalAdded=faces.reduce((a,b)=>a+b,0);
    const addedIndices=sides.map((_,i)=>start+i);
    trayBanner=wt.bannerOverride??{title:label,detail:wt.riderDetail||`+${sides.length} bonus ${sides.length===1?'die':'dice'} (${faces.join(' + ')} = ${totalAdded})`,tone:'rider'};
    diceTrigger={kind:'weapon-trigger',title:`${label}!`,detail:wt.riderDetail||`Added ${faces.join(' + ')} (+${totalAdded})`,diceCount:current.sides.length,groups:[{value:totalAdded,indices:addedIndices}]};
   }else{
    trayBanner={title:label,detail:`Rolling ${wt.riderDetail||'bonus damage dice'}\u2026`,tone:'rider'};
   }
  }else{
   const firstTotal=current.firstTotal??0,secondTotal=current.secondTotal??0;
   const rerollSummary=secondTotal>firstTotal?`kept ${secondTotal} vs ${firstTotal}`:secondTotal<firstTotal?`kept ${firstTotal} vs ${secondTotal}`:`tied ${firstTotal} vs ${secondTotal}`;
   const extraIndices=sides.map((_,i)=>start+i);
   const extraSides=current.extraCritSides??sides[0];
   if(state.done){
    applyFloor(state.values,extraIndices);
    const extraFaces=extraIndices.map(i=>effectiveAt(state.values,i));
    const extraSum=extraFaces.reduce((a,b)=>a+b,0);
    const prefix=current.hasReroll?`${rerollSummary} \u00b7 `:'';
    const title=current.hasReroll?`${current.rerollLabel} & ${current.extraCritLabel}`:current.extraCritLabel;
    trayBanner={title,detail:`${prefix}+${sides.length}d${extraSides} crit ${sides.length===1?'die':'dice'} (${extraFaces.join(' + ')} = ${extraSum})`,tone:current.hasReroll?'savage-both':'savage-crit'};
    diceTrigger={kind:'savage-attacks',title:`${current.extraCritLabel}!`,detail:`Added +${sides.length}d${extraSides} extra crit ${sides.length===1?'die':'dice'} (${extraFaces.join(', ')})`,diceCount:current.sides.length,groups:[{value:extraSum,indices:extraIndices}]};
   }else{
    const title=current.hasReroll?`${current.rerollLabel} & ${current.extraCritLabel}`:current.extraCritLabel;
    trayBanner={title,detail:`rolling +${sides.length}d${extraSides} ${current.extraCritLabel}\u2026`,tone:current.hasReroll?'savage-both':'savage-crit'};
   }
  }
  const shouldSuppressLuckyMeta=wt.phase==='initial'&&!!current.luckyLabel&&!trayBanner;
  publish({
   ...state,
   poses:state.poses.map(v=>Math.round(v*10000)/10000),
   ...display,
   id:current.id,
   seq:current.seq++,
   sides:[...current.sides],
   sets:[...current.sets],
   critical:[...current.critical],
   percentile:current.sides.map(()=>null),
   plannedDice:current.plannedDice,
   ...(shouldSuppressLuckyMeta?{}:{dieRoles:[...current.dieRoles],dieLabels:[...current.dieLabels]}),
   ...(current.dieAdjustedValues?{dieAdjustedValues:[...current.dieAdjustedValues]}:{}),
   ...(current.links.length?{rerollLinks:[...current.links]}:{}),
   ...(current.burstLinks.length?{burstLinks:[...current.burstLinks]}:{}),
   ...(current.keptSet!==undefined?{kept:current.keptSet}:luckyAdvKept!==undefined?{kept:luckyAdvKept}:{}),
   ...((info.advantage??current.luckyAdvantage)&&current.luckyLabel?{mode:info.advantage??current.luckyAdvantage,...(info.advantageReasons?.length?{advantageReasons:info.advantageReasons,advantageState:info.advantageState??info.advantage??current.luckyAdvantage}:{})}:{}),
   ...(current.discardedDice?{discardedDice:[...current.discardedDice]}:{}),
   ...(trayBanner?{trayBanner}:{}),
   ...(diceTrigger?{diceTrigger}:{}),
   ...(wt.phase==='initial'&&current.interactiveReroll?{rerollOfferLabel:current.rerollLabel}:{}),
   ...(impacts.length?{impacts}:{}),
  });
  return state;
 };
 const prepared=start?undefined:ready?.(current.id);emit();await prepared;
 const faces=await new Promise<number[]>((resolve,reject)=>{
  let last=performance.now(),credit=0;
  const timer=setInterval(()=>{try{
   const now=performance.now();credit+=Math.min(.1,(now-last)/1000)*LIVE_DICE_PRESENTATION_RATE;last=now;
   while(credit>=1/120){current.world.advance(1/120);credit-=1/120;if(current.world.snapshot().done)break;}
   const state=emit();if(state.done){clearInterval(timer);resolve(state.values.slice(start) as number[]);}
  }catch(e){clearInterval(timer);reject(e);}},1000/30);
 });
 const luckyNeedsNextWave=wt.phase==='initial'&&!!current.luckyLabel&&faces.some(v=>v===1);
 const hasNextWave=luckyNeedsNextWave||Boolean(wt.hasNextWave)||(wt.phase==='initial'&&current.hasReroll&&!current.interactiveReroll)||(wt.phase==='savage-reroll'&&!!current.hasCustomExtraCrit);
 const readingMs=liveDiceResultWaitMs(faces.length,false,hasNextWave);
 if(waitForPresentation)await waitForPresentation(current.id,readingMs);else await new Promise(resolve=>setTimeout(resolve,readingMs));
 return faces;
}
/** Each synchronous pass is atomic. An unresolved die suspends the command,
 * rolls back DB/transient effects, and resumes with the actual settled faces.
 * No transaction or database lock is held while the physics runs. */
export async function runLiveCommand(run:()=>void,publish:(f:LiveDiceFrame,info?:PhysicalDiceInfo)=>void,meta:LiveRollMeta,roll=physicalFaces){
 meta={...meta,burstTray:{},weaponTray:{}};
 const tape:{sides:number[];faces:number[];info:PhysicalDiceInfo}[]=[];
 const startedSaveSteps=new Set<number>();
 let waitForPresentation=meta.waitForPresentation;
 let manual=false;
 const calculated=new Set<string>(),rerollDecisions=new Map<string,boolean>();let lastFrame:LiveDiceFrame|undefined,lastInfo:PhysicalDiceInfo|undefined,approved=false,approvedResults:string|undefined;
 const needsReading=()=>!!lastFrame?.done&&!lastFrame.calculation&&lastFrame.resultHoldMs===undefined&&!lastInfo?.saveDice&&!lastFrame.burstProgress;
 const holdResult=async()=>{
  if(!needsReading())return;
  lastFrame={...lastFrame!,seq:lastFrame!.seq+1,resultHoldMs:LIVE_DICE_RESULT_HOLD_MS};
  publish(lastFrame,lastInfo);
  if(waitForPresentation)await waitForPresentation(lastFrame.id,LIVE_DICE_RESULT_HOLD_MS+LIVE_PRESENTATION_SYNC_MS);
  else if(roll===physicalFaces)await new Promise(resolve=>setTimeout(resolve,LIVE_DICE_RESULT_HOLD_MS+LIVE_PRESENTATION_SYNC_MS));
 };
 for(;;){
  let cursor=0;const undoHp=checkpointHpFx(),undoReactions=checkpointReactions();
  try{
   const runWithDice=()=>withDiceSource((sides,info)=>{
    if(!sides.length)return [];
    const recorded=tape[cursor++];
    if(!recorded)throw new NeedDice(sides,info,stagedRollFacing());
    if(recorded.sides.join(',')!==sides.join(','))throw new Error('Roll context changed before completion');
    if(cursor===tape.length)resetLiveRollReveal();
    return recorded.faces.slice();
   },()=>{run();if(cursor!==tape.length)throw new Error('Roll context changed before completion');
    // A rider may have no final reveal (the combined hit was already shown).
    // Roll back before waiting, just as for explicit calculation stages.
    if(needsReading()&&!hasLiveRollReveal())throw new NeedReading();
    // Save log rows store damage applied in `total`, including zero for control
    // spells. The review edits the save, so use its actual check total instead.
    const results=stagedRollResults().map(result=>result.reveal?.kind==='check'&&typeof result.reveal.attackTotal==='number'
      ?{...result,total:result.reveal.attackTotal}:result);
    if(meta.review&&!approved&&hiddenRollNeedsApproval(results))throw new NeedApproval(results);
    if(approved&&JSON.stringify(results)!==approvedResults)throw new Error('The hidden roll context changed. Nothing was applied; roll again to review the new result.');
   });
   const pass=db.transaction(()=>stageRollEffects(()=>withLiveCalculationPresenter((key,reveal)=>{
    if(!lastFrame)return false;
    if(!calculated.has(key))throw new NeedCalculation(key,reveal);
    return true;
   },()=>meta.chooseReroll?withLiveRerollChoice((key,info)=>{
    if(rerollDecisions.has(key))return rerollDecisions.get(key)!;
    throw new NeedRerollChoice(key,info);
   },runWithDice):runWithDice())))();
   for(const effect of pass.effects)await effect();return;
  }catch(e){
   undoHp();undoReactions();
   if(e instanceof NeedApproval){
    // The transaction has already rolled back: no HP, resources, conditions,
    // roll history or network effects exist until the DM confirms this result.
    const mixed=e.results.some(r=>r.reveal?.kind==='attack'||r.reveal?.kind==='damage');
    const hasChecks=e.results.some(result=>result.reveal?.kind==='check');
    const hasAttacks=e.results.some(result=>result.reveal?.kind==='attack');
    let dice:HiddenRollDice[]=tape.flatMap((entry,index)=>!mixed||!hasChecks||hasAttacks||/sav(?:e|ing)|check/i.test(entry.info.label??'')||entry.info.saveDice?.some(d=>d.rollKind!=='initiative')?[{index,expr:entry.info.expr,sides:entry.sides,faces:entry.faces}]:[]);
    const checks=e.results.filter(r=>(r.reveal?.kind==='check'||r.reveal?.kind==='attack')&&typeof r.reveal.d20==='number');
    dice=dice.map(plan=>{
      const saves=tape[plan.index].info.saveDice;
      if(!saves)return plan;
      return {...plan,labels:saves.map((save,i)=>{
        const result=checks.find(r=>r.reveal?.visibilityTarget?.kind===save.target.kind&&r.reveal.visibilityTarget.refId===save.target.refId);
        const name=result?.reveal?.attacker??`Saving throw ${i+1}`;
        const die=saves.slice(0,i+1).filter(s=>s.group===save.group).length;
        return `${name}${save.mode?` · ${save.mode==='adv'?'advantage':'disadvantage'} die ${die}`:''}`;
      })};
    });
    if(dice.length===1&&checks.length===1&&dice[0].sides.every(s=>s===20)&&dice[0].sides.length<=2)
      dice=[{...dice[0],bonus:checks[0].total-checks[0].reveal!.d20!,total:checks[0].total}];
    const answer=await meta.review!(e.results,dice,manual);
    const decision=typeof answer==='boolean'?{action:answer?'apply' as const:'discard' as const}:answer;
    if(decision.action==='discard')return;
    if(decision.action==='reroll'||decision.action==='manual'){
      if(!dice.length)continue;
      if(decision.action==='manual'){
        if(!Array.isArray(decision.faces)||decision.faces.length!==dice.length||new Set(decision.faces.map(f=>f.index)).size!==dice.length)throw new Error('Invalid manual roll results');
        for(const input of decision.faces){
          const plan=dice.find(d=>d.index===input.index);
          if(!plan||!Array.isArray(input.values)||input.values.length!==plan.sides.length||input.values.some((v,i)=>!Number.isInteger(v)||v<1||v>plan.sides[i]))throw new Error('Invalid manual die result');
        }
        for(const input of decision.faces)tape[input.index].faces=input.values.slice();
        tape.splice(dice.at(-1)!.index+1);
        manual=true;
      }else{
        // Preserve completed attack/damage throws before this pending step.
        tape.splice(dice[0].index);manual=false;
      }
      calculated.clear();rerollDecisions.clear();lastFrame=undefined;lastInfo=undefined;meta.burstTray={};meta.weaponTray={};
      continue;
    }
    approvedResults=JSON.stringify(e.results);approved=true;continue;
   }
   if(e instanceof NeedReading){await holdResult();continue;}
   if(e instanceof NeedRerollChoice){
    let decision=false;
    if(lastFrame&&meta.chooseReroll){
     const promptId=randomUUID();
     lastFrame={...lastFrame,seq:lastFrame.seq+1,rerollOfferLabel:undefined,rerollPrompt:{id:promptId,...e.info}};
     if(meta.weaponTray?.current?.id===lastFrame.id)meta.weaponTray.current.seq=Math.max(meta.weaponTray.current.seq,lastFrame.seq+1);
     publish(lastFrame,lastInfo);
     decision=await meta.chooseReroll(lastFrame.id,e.info,promptId);
     if(lastFrame){
      lastFrame={...lastFrame,seq:lastFrame.seq+1,rerollPrompt:undefined};
      if(meta.weaponTray?.current?.id===lastFrame.id)meta.weaponTray.current.seq=Math.max(meta.weaponTray.current.seq,lastFrame.seq+1);
      publish(lastFrame,lastInfo);
     }
    }
    rerollDecisions.set(e.key,decision);continue;
   }
   if(e instanceof NeedCalculation){
    if(lastFrame){
     lastFrame={...lastFrame,seq:lastFrame.seq+1,calculation:{...e.reveal,physical:true}};
     if(meta.burstTray?.current?.id===lastFrame.id)meta.burstTray.current.seq=Math.max(meta.burstTray.current.seq,lastFrame.seq+1);
     if(meta.weaponTray?.current?.id===lastFrame.id)meta.weaponTray.current.seq=Math.max(meta.weaponTray.current.seq,lastFrame.seq+1);
     publish(lastFrame,lastInfo);
     const ms=liveCalculationWaitMs(e.reveal.damageMods?.length??0,hasDrukMaximum(lastFrame));
     if(waitForPresentation)await waitForPresentation(lastFrame.id,ms);
     else if(roll===physicalFaces)await new Promise(resolve=>setTimeout(resolve,ms));
    }
    calculated.add(e.key);continue;
   }
   if(!(e instanceof NeedDice))throw e;
   // Never replace an unmodified throw with a save/rider before it was read,
   // unless this throw appends directly into the same weapon tray (whose
   // previous wave already completed its reading hold).
   const continuesWeaponTray=!!e.info.weaponTray&&e.info.weaponTray.phase!=='initial';
   if(!continuesWeaponTray)await holdResult();
   // The validated roll is about to start. Persist only its presentation turn;
   // HP, slots and dice outcomes remain rolled back until the command commits.
   let turned=false;
   if(!meta.deferFacing)for(const facing of e.facing)turned=faceTokenToward(facing.sessionId,facing.attackerTokenId,facing.targetTokenId)||turned;
   if(turned)meta.onFacing?.();
   const step=tape.length;
   const stepMeta={...meta,...meta.configureDice?.(e.info)};
   waitForPresentation=stepMeta.waitForPresentation;
   const faces=await roll(e.sides,frame=>{lastFrame=frame;lastInfo=e.info;publish(frame,e.info);},{...stepMeta,requireSaveStart:stepMeta.requireSaveStart&&!startedSaveSteps.has(step),...(e.info.label?{label:e.info.label}:{})},undefined,e.info);
   startedSaveSteps.add(step); // Reject & reroll starts the same step directly.
   tape.push({sides:e.sides,info:e.info,faces});
  }
 }
}
