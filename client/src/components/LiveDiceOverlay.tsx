import {NaturalTwentyCelebration} from './NaturalTwentyCelebration';
import type {RollReveal} from '../../../shared/types';
import {DIE_REVEAL_STAGGER_MS,DRUK_EXPLOSION_AFTER_TOTAL_MS,DICE_TOSS_ANTICIPATION_MS} from '../../../shared/dicePresentationTiming';
import {diceFlightPoint,diceFlightKeyframes,DIE_FLASH_MS,DIE_REVEAL_MS} from '../lib/diceFlightPosition';
import {useEffect,useLayoutEffect,useRef,useState,type CSSProperties,type ReactNode} from 'react';
import {useStore} from '../state/socket';
import {diceThemeForRoll} from '../../../shared/diceThemes';
import type {LiveDiceFrame} from '../../../shared/liveDiceTypes';
import {LIVE_DICE_PRESENTATION_RATE} from '../../../shared/liveDiceTypes';
import {dieResultEmphasis,dieResultTier,dieResultLabel,type Toss} from '../lib/diceTrayTypes';
import {liveDieResult} from '../../../shared/liveDieResult';
import './PhysicsDiceTray.css';
import {createDiceSound,rollingSpeeds} from '../lib/diceSfx';
import {metresPerUnitFor} from '../../../shared/diceImpacts';
import {liveNaturalCritical,liveNaturalTwenty} from '../lib/diceFinaleTiming';
import {playCritical} from '../lib/sfx';
import {DICE_TABLE_PAN_MS} from '../lib/diceTableCamera';
import {saveRollHeading} from '../lib/saveRollHeading';
import {ThreeDie,DiceThemeContext} from './ThreeDie';
import {useDiceRendering,reportDiceGraphicsFailure} from '../lib/useDiceRendering';
import {useLegacyMode} from '../lib/useEnvironmentQuality';
import {diceTableBackgroundSync,drawPrewarmedDiceBoard} from '../lib/diceBoardAssets';
import {computeDiceResultsLayout} from '../lib/diceResultsLayout';

/** Render authoritative poses with a short interpolation buffer. No local physics,
 * face reassignment, trajectory retry, or client-generated result. */
export function LiveDiceOverlay({frame,result,onSkip,impactReady=false,compact=false,title,rollId,revealKind,resultHeader,diceTrigger,explosionMs,hiddenReview}: {
 frame:LiveDiceFrame;result?:ReactNode;hiddenReview?:ReactNode;onSkip:()=>void;impactReady?:boolean;compact?:boolean;title?:string;rollId?:string;revealKind?:string;resultHeader?:{attacker:string;target?:string};diceTrigger?:RollReveal['diceTrigger'];explosionMs?:number;
}){
 const {mode:diceMode}=useDiceRendering(),legacy=useLegacyMode(),twoDimensional=diceMode==='2d';
 const pendingStart=!!frame.awaitingStart&&frame.elapsed===0;
 const pendingReroll=!!frame.rerollPrompt&&!frame.rerollPrompt.readOnly;
 const waitingRerollOffer=!frame.rerollPrompt&&!!frame.rerollOfferLabel&&!result&&!compact;
 const hiddenPrivate=useStore(s=>s.snapshot?.role==='dm'&&s.snapshot.hideDmRolls);
 const reviewRef=useRef(hiddenReview);reviewRef.current=hiddenReview;
 const pendingRerollRef=useRef(pendingReroll);pendingRerollRef.current=pendingReroll;
 const rerollClickGuardUntil=useRef(0);
 const [submittedRerollId,setSubmittedRerollId]=useState<string|null>(null);
 const skip=()=>{if(!reviewRef.current&&!pendingStart&&!pendingRerollRef.current&&performance.now()>=rerollClickGuardUntil.current)onSkip();};
 const handleRerollChoice=(reroll:boolean)=>{
  const prompt=frame.rerollPrompt;
  if(!prompt||prompt.readOnly||submittedRerollId===prompt.id)return;
  setSubmittedRerollId(prompt.id);
  rerollClickGuardUntil.current=performance.now()+500;
  useStore.getState().chooseDiceReroll(prompt.id,reroll);
 };
 const [started,setStarted]=useState('');
 const naturalCritical=liveNaturalCritical(frame),naturalTwenty=liveNaturalTwenty(frame),criticalPlayed=useRef<string>();
 useEffect(()=>{if((naturalCritical||naturalTwenty)&&criticalPlayed.current!==frame.id){criticalPlayed.current=frame.id;playCritical();}},[naturalCritical,naturalTwenty,frame.id]);
 const finale=useRef<{id:string;deadline:number|null}>({id:frame.id,deadline:null});
 if(finale.current.id!==frame.id)finale.current={id:frame.id,deadline:null};
 if(frame.resultHoldMs!==undefined&&finale.current.deadline===null)finale.current.deadline=performance.now()+DRUK_EXPLOSION_AFTER_TOTAL_MS;
 if(explosionMs!==undefined&&finale.current.deadline===null)finale.current.deadline=performance.now()+explosionMs;
 const links=useRef<SVGSVGElement>(null),triggerRef=useRef(diceTrigger);
 triggerRef.current=diceTrigger;
 const hasSavageResolution=!!frame.discardedDice?.some(Boolean);
 const rolePillRoles=new Set(['savage-crit','floored','exploded','lucky-reroll','rider']);
 const roleLabelFallback=(role?:string)=>role==='savage-crit'?'Savage Attacks':role==='floored'?'Floored':role==='exploded'?'Exploded':role==='lucky-reroll'?'Lucky Reroll':role==='rider'?'Bonus Die':'';
 const triggerColors=diceTrigger?.kind==='savage-attacker'?['#ffbe55']:diceTrigger?.kind==='savage-attacks'?['#ff9e2c']:diceTrigger?.kind==='halfling-lucky'?['#5cf29c']:diceTrigger?.kind==='dice-floor'?['#38e2d8']:diceTrigger?.kind==='weapon-trigger'?['#ff7d45']:diceTrigger?.kind?['#e3b0ff']:['#89f3ff','#e3b0ff','#ffe296','#b0ffcf'];
 const burstSources=[...new Set([...(diceTrigger?.kind==='burst'?diceTrigger.groups.flatMap(g=>g.indices):[]),...(frame.burstLinks??[]).map(link=>link.from)])];
 const rerollSources=[...new Set([...(diceTrigger?.kind==='savage-attacker'&&!hasSavageResolution?diceTrigger.groups.flatMap(g=>g.indices):[]),...(frame.rerollLinks??[]).map(link=>link.from)])];
 const rerollAccent=frame.trayBanner?.tone==='lucky'?'#5cf29c':'#ffbe55';
 const savageCritIndices=frame.dieRoles?frame.dieRoles.flatMap((role,i)=>role==='savage-crit'&&!frame.discardedDice?.[i]&&frame.values[i]!==null?[i]:[]):[];
 const hasTriggerRings=!!frame.done&&!!diceTrigger&&diceTrigger.kind!=='savage-attacks'&&!(diceTrigger.kind==='savage-attacker'&&hasSavageResolution);
 const triggerGroup=(i:number)=>{
  if(diceTrigger?.kind==='savage-attacker'&&hasSavageResolution)return -1;
  return diceTrigger?.groups.findIndex(group=>group.indices.includes(i))??-1;
 };
 useEffect(()=>{
  const onKey=(event:KeyboardEvent)=>{if(event.key==='Escape')skip();};
  window.addEventListener('keydown',onKey);
  return()=>window.removeEventListener('keydown',onKey);
 },[skip]);
 const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
 const canvas=useRef<HTMLCanvasElement>(null),root=useRef<HTMLDivElement>(null),card=useRef<HTMLDivElement>(null);
 const [resultSpace,setResultSpace]=useState({width:800,height:500});
 useLayoutEffect(()=>{
  const node=root.current;if(!node)return;
  const observer=new ResizeObserver(()=>setResultSpace(previous=>{
   const width=node.clientWidth,height=node.clientHeight;
   return width===previous.width&&height===previous.height?previous:{width,height};
  }));
  observer.observe(node);return()=>observer.disconnect();
 },[]);
 const hasDieBadges=!!frame.dieLabels?.some(Boolean)||!!frame.dieRoles?.some(r=>rolePillRoles.has(r))||hasSavageResolution;
 const resultsLayout=computeDiceResultsLayout({width:resultSpace.width,height:resultSpace.height,count:frame.sides.length,hasDieBadges,hasSaveDice:!!frame.saveDice});
 const resultLayout={'--dice-result-columns':resultsLayout.columns,'--dice-result-rows':resultsLayout.rows,
  '--dice-results-height':`${resultsLayout.resultsHeight}px`,'--dice-result-col-max':`${resultsLayout.colMaxWidth}px`,
  '--dice-result-number-size':`${resultsLayout.numberSize}px`,'--dice-result-label-size':`${resultsLayout.labelSize}px`,
  '--dice-result-badge-size':`${resultsLayout.badgeSize}px`} as CSSProperties;
 const outgoing=useRef<HTMLCanvasElement>(null),previousId=useRef(frame.id),previousTheme=useRef(diceThemeForRoll(frame.className,frame.dmDice,frame.affinity,frame.diceTheme).id),handoffDuration=useRef(180),swappingTray=useRef(false);
 const dmPan=useRef(0);
 useLayoutEffect(()=>{
  const node=card.current;if(!node)return;
  const changed=previousId.current!==frame.id;
  const nextTheme=diceThemeForRoll(frame.className,frame.dmDice,frame.affinity,frame.diceTheme).id;
  if(changed){
   swappingTray.current=nextTheme!==previousTheme.current;
   const wasDm=previousTheme.current.startsWith('dm-'),nextDm=nextTheme.startsWith('dm-');
   dmPan.current=wasDm===nextDm?0:nextDm?1:-1;
   handoffDuration.current=dmPan.current?DICE_TABLE_PAN_MS:swappingTray.current?360:180;
   previousTheme.current=nextTheme;
  }
  if(changed&&canvas.current){canvas.current.dataset.physicsElapsed='0';canvas.current.dataset.rollPower='[]';canvas.current.dataset.explosionAt='';canvas.current.dataset.tossAnticipationAt='';}
  if(changed&&swappingTray.current&&canvas.current&&outgoing.current&&!reduced){
   // Copy once per throw, never per frame. Keep the old rendered artwork while
   // the next material prepares, then crossfade into the actual incoming tray.
   const from=canvas.current,to=outgoing.current;
   to.width=from.width;to.height=from.height;
   to.getContext('2d')?.drawImage(from,0,0);
   to.getAnimations().forEach(animation=>animation.cancel());
   to.style.opacity='1';to.dataset.phase='waiting';
  }
  if(!twoDimensional&&canvas.current&&!result&&!frame.done){
   drawPrewarmedDiceBoard(canvas.current,nextTheme,legacy?1:Math.min(2,devicePixelRatio||1));
  }
  previousId.current=frame.id;

 },[frame.id,compact,!!result,reduced,twoDimensional,legacy]);
 const boxes=useRef<(HTMLSpanElement|null)[]>([]),flights=useRef<(HTMLSpanElement|null)[]>([]);
 const saveLabels=useRef<(HTMLSpanElement|null)[]>([]);
 const roleLabels=useRef<(HTMLSpanElement|null)[]>([]);
 const [arrived,setArrived]=useState<number[]>([]),[failed,setFailed]=useState(false),[prepared,setPrepared]=useState(false);
 const [bonusesShown,setBonusesShown]=useState(false);
 if(frame.saveDice&&frame.done&&bonusesShown&&finale.current.deadline===null)finale.current.deadline=performance.now()+DRUK_EXPLOSION_AFTER_TOTAL_MS;
 useEffect(()=>{
   setBonusesShown(false);
   if(!frame.saveDice||!frame.done||(!failed&&arrived.length<frame.sides.length))return;
   const timer=setTimeout(()=>setBonusesShown(true),550);return()=>clearTimeout(timer);
 },[frame.id,frame.done,arrived.length,failed]);
 const theme=diceThemeForRoll(frame.className,frame.dmDice,frame.affinity,frame.diceTheme);
 const dieThemes=frame.diceArt?.map(art=>diceThemeForRoll(art.className,art.dmDice));
 const viewer=useStore.getState(),character=viewer.snapshot?.characters.find(c=>c.name===frame.roller);
 const own=viewer.snapshot?.role==='dm'?(frame.roller==='DM'||!!character&&!character.claimedBy):character?.claimedBy===viewer.socket?.id;
 const frames=useRef<{at:number;frame:LiveDiceFrame}[]>([]);
 // Dice sounds for this roll: the server publishes each frame's real strikes.
 // The canvas draws ~80 ms behind the newest frame and physics runs at the
 // presentation rate, so each strike is scheduled to land with its picture.
 const sound=useRef<{id:string;count:number;player:ReturnType<typeof createDiceSound>}>();
 useEffect(()=>()=>{sound.current?.player.stop();},[]);
 useEffect(()=>{
  if(sound.current?.id!==frame.id||sound.current.count!==frame.sides.length){sound.current?.player.stop();sound.current={id:frame.id,count:frame.sides.length,player:createDiceSound(frame.sides)};}
  const player=sound.current.player,previous=frames.current.at(-1)?.frame;
  const viewer=useStore.getState(),character=viewer.snapshot?.characters.find(c=>c.name===frame.roller);
  const own=viewer.snapshot?.role==='dm'?(frame.roller==='DM'||!!character&&!character.claimedBy):character?.claimedBy===viewer.socket?.id;
  if(frame.impacts?.length)player.impacts(own?frame.impacts:frame.impacts.map(i=>({...i,x:-i.x})),
   i=>.08+(i.t-frame.elapsed)/LIVE_DICE_PRESENTATION_RATE);
  if(previous?.id===frame.id&&frame.elapsed>previous.elapsed&&!frame.rerolls.some((n,i)=>n!==previous.rerolls[i]))
   player.rolling(rollingSpeeds(previous.poses,frame.poses,frame.elapsed-previous.elapsed,frame.radius,metresPerUnitFor(frame.radius)));
  if(frame.done)player.stop();
 },[frame]);
 useEffect(()=>{
  const list=frames.current,at=performance.now();if(list[0]?.frame.id!==frame.id)list.length=0;
  // The initial pose predates graphics preparation. Anchor it to actual launch,
  // otherwise interpolation stretches the first spin across the loading delay.
  if(frame.elapsed>0&&list.length&&list.every(f=>f.frame.elapsed===0))
   list.forEach(f=>{f.at=at-frame.elapsed*1000/LIVE_DICE_PRESENTATION_RATE;});
  list.push({at,frame});if(list.length>12)list.shift();
 },[frame]);
 useEffect(()=>{
  if(!twoDimensional)return;
  if(!frame.done){setArrived(frame.values.flatMap((v,i)=>v!==null?[i]:[]));return;}
  const timer=setTimeout(()=>setArrived(frame.sides.map((_,i)=>i)),reduced?0:360);
  return()=>clearTimeout(timer);
 },[twoDimensional,frame.id,frame.done,frame.sides.length,reduced]);
 useEffect(()=>{
  let stopped=false,raf=0,renderer:ReturnType<typeof import('../lib/diceTrayRenderer').createTrayRenderer>|undefined;
  let lease:ReturnType<typeof import('../lib/diceTrayRenderer').acquireLiveTrayRenderer>|undefined,initializationDone=false;
  // Revisiting an earlier completed throw for its arithmetic does not replay
  // number flights that the viewer already watched during the live roll.
  setArrived(result?frame.sides.map((_,i)=>i):[]);setFailed(false);setPrepared(false);
  if(twoDimensional){setPrepared(true);useStore.getState().socket?.emit('dice:ready',{id:frame.id});return;}
  const animations:Animation[]=[];const launched=new Map<number,number>();let finalTrayDrawn=false,readySent=false,handoffPainted=false,handoffReady=false,zoomStartedAt:number|undefined,anticipationStartedAt:number|undefined,resultsStartedAt:number|undefined,firstRevealIndex=0;
  const viewPose=(poses:number[])=>own?poses:poses.map((v,i)=>{
    // Same physical world viewed from the other side of the table.
    const offset=i-i%7;
    return i%7===0||i%7===1?-v:i%7===3?-poses[offset+4]:i%7===4?poses[offset+3]:i%7===5?poses[offset+6]:i%7===6?-poses[offset+5]:v;
  });
  const capacity=frame.plannedDice?.length??frame.burstCapacity??frame.sides.length;
  const toss:Toss={settleTimes:[],wallHits:0,frames:new Float32Array(capacity*14),frameCount:2,step:1,radius:frame.radius,trayScale:frame.trayScale,topFaces:Array(capacity).fill(0),duration:1};
  void (async()=>{
   const module=await import('../lib/diceTrayRenderer');
   // Reuse the selected material warmup without holding this throw behind
   // another character's unrelated background preparation.
   await Promise.all([...new Set([theme.id,...(dieThemes?.map(t=>t.id)??[])])].map(id=>module.waitForDiceGraphics(id)));
   await module.prepareDiceTableTexture();
   if(stopped)return;
   const surface=root.current!.querySelector<HTMLElement>('.dice-tray-stage')!;
   surface.style.backgroundImage=`url("${module.diceTableBackground()}")`;
   surface.dataset.surface='plain-wood';
   root.current!.dataset.dicePreloaded=String(module.diceGraphicsPreloaded(theme.id));
   const art=await module.loadTrayTexture(theme.id);
   if(stopped){art?.dispose();return;}
   const context=JSON.stringify(['crossfade',viewer.snapshot?.sessionCode,viewer.snapshot?.map?.id,viewer.snapshot?.role,viewer.socket?.id]);
   lease=module.acquireLiveTrayRenderer(context,Array.from({length:capacity},(_,index)=>{const planned=frame.plannedDice?.[index];return {sides:planned?.sides??frame.sides[index]??8,value:1,index,set:planned?.set??frame.sets[index]??0,crit:planned?.critical??frame.critical[index]??false,tens:frame.percentile[index]==='tens',ones:frame.percentile[index]==='ones'};}),toss,theme,art,dieThemes);
   renderer=lease.value;root.current!.dataset.rendererReused=String(lease.reused);
   const node=canvas.current!,ctx=node.getContext('2d')!;
   node.dataset.trayFootprint=JSON.stringify(renderer.trayFootprint());
   node.dataset.trayScale=String(frame.trayScale??1);
   node.dataset.diceRadius=String(frame.radius);
   const width=node.clientWidth||600;
   await Promise.all([
    reduced?Promise.resolve():renderer.prepare(width,width*10.2/15.2,Math.min(2,devicePixelRatio||1),()=>!stopped),
    ...Array.from(root.current!.parentElement!.getAnimations()).map(a=>a.finished.catch(()=>{})),
   ]);
   if(stopped)return;
   setPrepared(true);
   let lastDraw=-Infinity;
   const draw=(now:number)=>{
    if(stopped)return;
    if(legacy&&now-lastDraw<1000/30){raf=requestAnimationFrame(draw);return;}lastDraw=now;
    const list=frames.current,target=now-80;
    let a=list[0],b=list[list.length-1];
    for(let i=1;i<list.length;i++){if(list[i].at>=target){a=list[i-1];b=list[i];break;}a=list[i];}
    if(a&&b){
     // A reroll is an intentional new throw, not interpolation through the floor.
     const reset=b.frame.rerolls.some((n,i)=>n!==a.frame.rerolls[i]);
     const oldPose=reset?b.frame.poses:a.frame.poses;
     toss.frames.set(viewPose(b.frame.poses),0);toss.frames.set(viewPose(oldPose),0);
     toss.frames.set(viewPose(b.frame.poses),capacity*7);
      // Initial poses belong outside the tray; do not show a motionless die
      // hanging over the rim while the new tray is being introduced.
      renderer!.setActiveCount(b.frame.elapsed>0?b.frame.sides.length:0);
      renderer!.setResults(b.frame.values);
      renderer!.setExplosionTime(finale.current.deadline);
     if(zoomStartedAt===undefined)zoomStartedAt=now;
     if(!b.frame.done){resultsStartedAt=undefined;finalTrayDrawn=false;}
     const alpha=reset||a===b?1:Math.max(0,Math.min(1,(target-a.at)/(b.at-a.at)));
     const width=node.clientWidth||600,height=width*10.2/15.2,dpr=legacy?1:Math.min(2,devicePixelRatio||1);
     if(node.width!==Math.round(width*dpr)){node.width=Math.round(width*dpr);node.height=Math.round(height*dpr);}
     const activeTrigger=triggerRef.current;
     const hasCustomRings=!!b.frame.dieRoles?.some(r=>rolePillRoles.has(r))||!!b.frame.discardedDice?.some(Boolean);
     const hasActiveTriggerRings=!!b.frame.done&&!!activeTrigger?.groups.length&&activeTrigger.kind!=='savage-attacks'&&!(activeTrigger.kind==='savage-attacker'&&!!b.frame.discardedDice?.some(Boolean));
     if(hasCustomRings||hasActiveTriggerRings){
      const hasDiscarded=!!b.frame.discardedDice?.some(Boolean);
      const ringColors=b.frame.sides.map((_,i)=>{
       if(b.frame.values[i]===null)return null;
       if(b.frame.discardedDice?.[i]||(b.frame.done&&b.frame.mode&&b.frame.kept!==undefined&&b.frame.sets[i]!==b.frame.kept))return 0xff5365;
       const role=b.frame.dieRoles?.[i];
       if(role==='savage-crit')return 0xff9e2c;
       if(role==='floored')return 0x38e2d8;
       if(role==='exploded')return 0xd47eff;
       if(role==='lucky-reroll')return 0x5cf29c;
       if(role==='rider')return 0xff7d45;
       if(hasDiscarded||(b.frame.done&&b.frame.mode))return 0x39ef87;
       if(hasActiveTriggerRings){
        const g=activeTrigger!.groups.findIndex(grp=>grp.indices.includes(i));
        if(g>=0)return Number.parseInt(triggerColors[g%triggerColors.length].slice(1),16);
       }
       return null;
      });
      renderer!.setDieRings(ringColors);
      renderer!.setKeptSet(undefined);
     }else{
      renderer!.setDieRings(undefined);
      renderer!.setKeptSet(b.frame.done?b.frame.kept:undefined);
     }
     const finalWasDrawn=finalTrayDrawn;
     if(!reduced){
       // Settled poses stay fixed, but resin, lightning, motes and lava remain
       // live while numbers fly and during the final reading hold.
        try{renderer!.draw(ctx,width,height,dpr,alpha,now);}catch{reportDiceGraphicsFailure();return;}
        node.dataset.rollPower=JSON.stringify(renderer!.powerStates().map(p=>({classArt:p.classArt,known:p.known,strength:+p.strength.toFixed(2),maximum:p.maximum,particles:p.particles,broken:p.broken,shudder:p.shudder,pools:p.pools})));
       node.dataset.physicsElapsed=String(a.frame.elapsed+(b.frame.elapsed-a.frame.elapsed)*alpha);
       node.dataset.renderTime=String(now);
       node.dataset.explosionAt=String(finale.current.deadline??'');
       finalTrayDrawn=b.frame.done&&alpha===1;
       const svg=links.current;
       if(svg){
         const valid=(i:number)=>i>=0&&i<b.frame.sides.length;
         const indices=new Set([
          ...(b.frame.done&&!diceTrigger?.kind?activeTrigger?.groups.flatMap(g=>g.indices)??[]:[]),
          ...(b.frame.burstLinks??[]).flatMap(link=>[link.from,link.to]),
          ...(b.frame.rerollLinks??[]).flatMap(link=>[link.from,link.to]),
          ...(b.frame.dieRoles?b.frame.dieRoles.flatMap((role,i)=>rolePillRoles.has(role)&&!b.frame.discardedDice?.[i]&&b.frame.values[i]!==null?[i]:[]):[]),
         ].filter(valid));
         const points=new Map([...indices].map(i=>{const p=renderer!.numberPosition(i);return [i,{x:p.x*1000,y:p.y*1000*10.2/15.2}] as const;}));
         // Do not draw a tether outside the box: it appears as the child enters the bed.
         svg.querySelectorAll<SVGGElement>('[data-burst-child],[data-reroll-child]').forEach(el=>{const i=Number(el.dataset.burstChild??el.dataset.rerollChild),scale=b.frame.trayScale??1,inside=valid(i)&&Math.abs(b.frame.poses[i*7])<=7*scale&&Math.abs(b.frame.poses[i*7+1])<=4.5*scale;el.style.opacity=inside?'1':'0';el.dataset.childEntered=String(inside);});
         const geometry=[...points.values()].map(p=>`${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(';');
         const layoutKey=geometry+'|'+svg.querySelectorAll('[data-burst-source],[data-reroll-source],[data-savage-crit-source],[data-trigger-die],[data-from]').length;
         if(svg.dataset.layoutKey!==layoutKey){
           svg.dataset.layoutKey=layoutKey;svg.dataset.geometry=geometry;svg.style.visibility=points.size?'visible':'hidden';
           svg.querySelectorAll<SVGGElement>('[data-burst-source],[data-reroll-source],[data-savage-crit-source]').forEach(el=>{const p=points.get(Number(el.dataset.burstSource??el.dataset.rerollSource??el.dataset.savageCritSource));if(p)el.setAttribute('transform',`translate(${p.x} ${p.y})`);});
           svg.querySelectorAll<SVGCircleElement>('[data-trigger-die]').forEach(el=>{const p=points.get(Number(el.dataset.triggerDie));if(p){el.setAttribute('cx',String(p.x));el.setAttribute('cy',String(p.y));}});
           svg.querySelectorAll<SVGPathElement>('[data-from]').forEach(el=>{const a=points.get(Number(el.dataset.from)),b=points.get(Number(el.dataset.to));if(a&&b){const midX=(a.x+b.x)/2,midY=(a.y+b.y)/2-Math.min(80,Math.hypot(a.x-b.x,a.y-b.y)*.2);el.setAttribute('d',`M ${a.x} ${a.y} Q ${midX} ${midY} ${b.x} ${b.y}`);}});
         }
       }
     }
     if(b.frame.saveDice){
       const rect=root.current!.getBoundingClientRect(),c=node.getBoundingClientRect();
       saveLabels.current.forEach((el,i)=>{if(!el)return;const p=renderer!.numberPosition(i),pos=diceFlightPoint(rect,root.current!.clientWidth,c.left+p.x*c.width,c.top+p.y*c.height);el.style.left=`${pos.x}px`;el.style.top=`${pos.y-25}px`;});
     }
     if(roleLabels.current.some(Boolean)){
       const rect=root.current!.getBoundingClientRect(),c=node.getBoundingClientRect(),scale=b.frame.trayScale??1;
       roleLabels.current.forEach((el,i)=>{
        if(!el)return;
        const settled=i<b.frame.sides.length&&b.frame.values[i]!==null;
        const inside=settled&&Math.abs(b.frame.poses[i*7])<=7*scale&&Math.abs(b.frame.poses[i*7+1])<=4.5*scale;
        if(!inside){el.dataset.positioned='false';return;}
        const p=renderer!.numberPosition(i),pos=diceFlightPoint(rect,root.current!.clientWidth,c.left+p.x*c.width,c.top+p.y*c.height);
        el.style.left=`${Math.max(48,Math.min(root.current!.clientWidth-48,pos.x))}px`;
        el.style.top=`${Math.max(26,pos.y-26)}px`;
        el.dataset.positioned='true';
       });
     }
     if(!handoffPainted){
      handoffPainted=true;
      const cover=outgoing.current;
      if(!reduced&&cover?.dataset.phase==='waiting'){
       cover.dataset.phase='crossfading';cover.dataset.startedAt=String(now);
       cover.dataset.kind=dmPan.current?'dm-pan':'tray-swap';
       cover.dataset.direction=dmPan.current>0?'to-dm':'from-dm';
       // Move two prepared images across the plain wood, keeping the window,
       // physical camera, face projection and result clocks unchanged. No
       // second scene or per-frame snapshot is needed during the pan.
       const distance=dmPan.current*118;
       const fade=cover.animate(dmPan.current?
        [{opacity:1,transform:'translateY(0)'},{opacity:1,transform:`translateY(${distance}%)`}]:
        [{opacity:1,transform:'translateX(0)'},{opacity:0,transform:'translateX(-14px)'}],
        {duration:handoffDuration.current,easing:'cubic-bezier(.4,0,.2,1)',fill:'forwards'});animations.push(fade);
       animations.push(node.animate(dmPan.current?
        [{opacity:1,transform:`translateY(${-distance}%)`},{opacity:1,transform:'none'}]:
        [{opacity:0,transform:'translateX(14px)'},{opacity:1,transform:'none'}],
        {duration:handoffDuration.current,easing:'cubic-bezier(.4,0,.2,1)'}));
       fade.finished.then(()=>{if(!stopped){cover.style.opacity='0';cover.dataset.phase='idle';handoffReady=true;}}).catch(()=>{});
      }else if(cover){cover.style.opacity='0';cover.dataset.kind='same-tray';cover.dataset.phase='preparing';}
     }
     if(!swappingTray.current||reduced){handoffReady=now-zoomStartedAt>=handoffDuration.current||reduced;if(handoffReady&&outgoing.current)outgoing.current.dataset.phase='idle';}
     // Finish the handoff, then leave a short visible beat before release.
     // The server waits for this acknowledgement, so no live motion is skipped.
     if(handoffReady&&anticipationStartedAt===undefined){anticipationStartedAt=now;node.dataset.tossAnticipationAt=String(now);}
     if(!readySent&&anticipationStartedAt!==undefined&&(reduced||now-anticipationStartedAt>=DICE_TOSS_ANTICIPATION_MS)){
       readySent=true;useStore.getState().socket?.emit('dice:ready',{id:frame.id});
     }
     if(!result&&b.frame.done&&(finalWasDrawn||reduced)){
       // Start on the frame AFTER the final WebGL draw has painted. Otherwise
       // GPU work can consume the flash and make every stagger launch at once.
       if(resultsStartedAt===undefined){resultsStartedAt=now;firstRevealIndex=b.frame.values.findIndex((_,i)=>!launched.has(i));}
       const elapsedSinceDone=now-resultsStartedAt;
       launched.forEach((at,i)=>{const flight=flights.current[i];if(flight?.dataset.phase==='flash'&&now-at>=DIE_FLASH_MS)flight.dataset.phase='flying';});
       b.frame.values.forEach((_,i)=>{
         if(launched.has(i)||elapsedSinceDone<(i-firstRevealIndex)*DIE_REVEAL_STAGGER_MS)return;
         launched.set(i,now);
         const flight=flights.current[i],box=boxes.current[i];
         if(reduced||!flight||!box){setArrived(old=>[...old,i]);return;}
         const rect=root.current!.getBoundingClientRect(),c=node.getBoundingClientRect(),dest=box.querySelector('strong')!.getBoundingClientRect(),p=renderer!.numberPosition(i);
         const source=diceFlightPoint(rect,root.current!.clientWidth,c.left+p.x*c.width,c.top+p.y*c.height);
         const destination=diceFlightPoint(rect,root.current!.clientWidth,dest.left+dest.width/2,dest.top+dest.height/2);
         const {x:sx,y:sy}=source,{x:tx,y:ty}=destination;
         flight.dataset.faceScreenX=String(c.left+p.x*c.width);flight.dataset.faceScreenY=String(c.top+p.y*c.height);
         const keyframes=diceFlightKeyframes(sx,sy,tx,ty,dieResultEmphasis(liveDieResult(b.frame,i)));
         flight.dataset.boxScreenX=String(dest.left+dest.width/2);flight.dataset.boxScreenY=String(dest.top+dest.height/2);
         flight.dataset.phase='flash';
         const animation=flight.animate(keyframes,{duration:DIE_REVEAL_MS,easing:'linear'});
         animations.push(animation);animation.finished.then(()=>{if(!stopped)setArrived(old=>[...old,i]);}).catch(()=>{});
       });
     }
    }
    raf=requestAnimationFrame(draw);
   };raf=requestAnimationFrame(draw);
  })().catch(()=>{if(!stopped){setFailed(true);reportDiceGraphicsFailure();useStore.getState().socket?.emit('dice:ready',{id:frame.id});}}).finally(()=>{initializationDone=true;if(stopped)lease?.release();});
  return()=>{stopped=true;cancelAnimationFrame(raf);animations.forEach(a=>a.cancel());if(initializationDone)lease?.release();};
 },[frame.id,twoDimensional,legacy]);
 const value=(i:number)=>{const v=frame.values[i];return v===null?'?':frame.percentile[i]==='tens'?String((v-1)*10).padStart(2,'0'):frame.percentile[i]==='ones'?v-1:v;};
 const tier=(i:number)=>dieResultTier(liveDieResult(frame,i));
 const saveResult=(i:number)=>{
   const save=frame.saveDice?.[i];if(!save||!frame.done||(!arrived.includes(i)&&!failed))return undefined;
   const indices=frame.saveDice!.flatMap((s,j)=>s.group===save.group?[j]:[]);
   const faces=indices.map(j=>frame.values[j]??0);
   if(save.rollKind==='damage'){
     const sum=faces.reduce((a,b)=>a+b,0),modifier=save.modifier??0,total=sum+modifier;
     const calcParts=[faces.join(' + '),...(modifier?[`${modifier>=0?'+':'−'} ${Math.abs(modifier)}`]:[])];
     const calculation=save.hideModifiers?'':calcParts.length>1||faces.length>1?`${calcParts.join(' ')} = ${total}`:`${total}`;
     const dmgLabel=save.damageType?`${total} ${save.damageType}`:`${total} dmg`;
     return {calculation,outcome:bonusesShown?(save.crit?`CRIT ${dmgLabel}`:dmgLabel):save.hideModifiers?'Resolving…':'Adding bonuses…'};
   }
   const face=save.mode==='dis'?Math.min(...faces):Math.max(...faces);
   if(indices.length>1&&i!==indices[faces.indexOf(face)])return {calculation:'',outcome:'Discarded'};
   const modifier=save.modifier??0,total=face+modifier;return {calculation:save.hideModifiers?'':`${face} ${modifier>=0?'+':'−'} ${Math.abs(modifier)} = ${total}`,outcome:bonusesShown?(save.rollKind==='initiative'?save.hideModifiers?'Initiative rolled':`Initiative ${total}`:(save.outcome??(!save.autoFail&&save.dc!==undefined&&total>=save.dc?'pass':'fail')).toUpperCase()):save.hideModifiers?'Resolving…':'Adding bonuses…'};
 };
 const saveBonus=(i:number)=>{
   const result=saveResult(i),save=frame.saveDice![i],visible=!!result;
   if(save.rollKind==='damage'&&frame.saveDice!.findIndex(s=>s.group===save.group)!==i)return null;
   return <span className="tray-save-outcome" data-outcome={result?.outcome} data-bonus-phase={visible?(bonusesShown?'complete':'adding'):'waiting'}>
     <span className="tray-save-summary"><span className="tray-save-name" title={save.label}>{save.label}</span><b>{result?.outcome||'\u00a0'}</b></span>
     {!save.hideModifiers&&<>{(save.rollKind!=='damage'||!!save.modifier)&&<small>{save.rollKind==='initiative'?'Initiative bonus':save.rollKind==='attack'?'Attack bonus':save.rollKind==='damage'?'Damage bonus':'Save bonus'} <em>{visible?`${(save.modifier??0)>=0?'+':'−'}${Math.abs(save.modifier??0)}`:'\u00a0'}</em></small>}
     <span className="tray-save-equation">{bonusesShown?result?.calculation:'\u00a0'}</span></>}
     {bonusesShown&&result?.outcome!=='Discarded'&&(save.passEffect||save.failEffect)&&<small>{result?.outcome==='PASS'?save.passEffect:save.failEffect}</small>}
   </span>;
 };
 const saveVerdict=(i:number)=>{
   const outcome=saveResult(i)?.outcome;
   return outcome==='Adding bonuses…'?'Adding…':outcome??'Rolling…';
 };
 const resultStyle=(i:number)=>{
  const strength=dieResultEmphasis(liveDieResult(frame,i));
  return {'--roll-strength':strength,'--arrival-scale':1.12+strength*.5,'--arrival-glow':`${5+Math.pow(strength,3)*28}px`} as CSSProperties;
 };
 const dieBoxResult=(i:number)=>{
  if(hasSavageResolution&&frame.discardedDice?.[i])return 'discarded';
  if(frame.done&&frame.mode&&frame.kept!==undefined&&frame.sets[i]!==frame.kept)return 'discarded';
  if(frame.dieRoles?.[i]==='savage-crit')return frame.values[i]!==null?'savage-crit':'rolling';
  if(hasSavageResolution&&frame.discardedDice)return 'kept';
  if(frame.done&&frame.mode)return 'kept';
  return 'rolling';
 };
 const dieBoxBadge=(i:number):{text:string;tone:'kept'|'discarded'|'savage-crit'|'floored'|'exploded'|'lucky-reroll'|'rider'|'info'}|null=>{
  if(!hasDieBadges)return null;
  const role=frame.dieRoles?.[i];
  const customLabel=frame.dieLabels?.[i];
  if(hasSavageResolution&&frame.discardedDice?.[i])return {text:customLabel||'Discarded',tone:'discarded'};
  if(frame.done&&frame.mode&&frame.kept!==undefined&&frame.sets[i]!==frame.kept)return {text:customLabel?`${customLabel} (dropped)`:'Discarded',tone:'discarded'};
  if(role&&rolePillRoles.has(role))return {text:customLabel||roleLabelFallback(role),tone:role as 'savage-crit'|'floored'|'exploded'|'lucky-reroll'|'rider'};
  if(hasSavageResolution&&frame.discardedDice)return {text:customLabel||'Kept',tone:'kept'};
  if(customLabel)return {text:customLabel,tone:'info'};
  return null;
 };
 const dieBoxHeader=(side:number,i:number)=>frame.percentile[i]?`d100 ${frame.percentile[i]}`:frame.critical[i]&&frame.dieRoles?.[i]!=='savage-crit'?`d${side} \u00b7 CRIT`:`d${side}`;
 const flyingTone=(i:number)=>{
  if(hasSavageResolution&&frame.discardedDice?.[i])return 'discarded';
  if(frame.done&&frame.mode&&frame.kept!==undefined&&frame.sets[i]!==frame.kept)return 'discarded';
  if(frame.dieRoles?.[i]==='savage-crit')return 'savage-crit';
  if(frame.critical[i])return 'critical';
  if(hasSavageResolution&&frame.discardedDice)return 'kept';
  if(frame.done&&frame.mode)return 'kept';
  return 'normal';
 };
 const hasSvgOverlay=(hasTriggerRings&&!diceTrigger?.kind&&(diceTrigger?.groups.length??0)>0)||!!frame.burstLinks?.length||!!frame.rerollLinks?.length||savageCritIndices.length>0;
 const isSavageTrigger=diceTrigger?.kind==='savage-attacker'||diceTrigger?.kind==='savage-attacks'||diceTrigger?.kind==='halfling-lucky'||diceTrigger?.kind==='die-reroll'||diceTrigger?.kind==='dice-floor'||diceTrigger?.kind==='weapon-trigger'||(diceTrigger?.groups.length===0);
 const target=resultHeader?resultHeader.target:frame.target;
 const heading=saveRollHeading(frame,title??frame.label,resultHeader?.attacker);
 const prewarmedWoodBg=!twoDimensional?diceTableBackgroundSync():'';
 return <div className={`roll-reveal-backdrop${compact?' is-impact':''}`} data-live-dice={result||compact?undefined:'true'} data-live-calculation={frame.calculation?'true':undefined} data-result-hold-ms={frame.resultHoldMs} data-private-roll={hiddenPrivate||undefined} data-reviewing={!!hiddenReview} data-awaiting-start={pendingStart||undefined} data-dice-presentation={result?'result':'live'} data-roll-id={frame.id}><div ref={card} className={`roll-reveal${naturalCritical?' roll-reveal-crit':''}`} data-roll-id={rollId??frame.id} data-reveal-kind={revealKind} data-dice-theme={theme.id} data-impact-ready={impactReady} role="status" aria-label="Live dice roll" onClick={skip} title={hiddenReview||pendingStart||pendingReroll?undefined:"Click or tap to skip animation"}>
  <div className="roll-reveal-title" role="heading" aria-level={2} title={heading}>{heading}</div>
  <div className="roll-reveal-who">{frame.saveDice&&!frame.saveDice[0]?.rollKind?'Triggered by ':''}{frame.attacker??resultHeader?.attacker??frame.roller}{target&&<span className="rr-arrow"> &rarr; {target}</span>}{!!frame.advantageReasons?.length&&<span className={`rr-adv-reason is-${frame.advantageState??frame.mode??'straight'}`}> &middot; {(frame.advantageState??frame.mode)==='adv'?'Advantage':(frame.advantageState??frame.mode)==='dis'?'Disadvantage':'Straight (adv + dis)'}: {frame.advantageReasons.join(', ')}</span>}</div>
  {naturalTwenty&&!compact&&!hiddenReview&&<NaturalTwentyCelebration key={frame.id}/>}
  {naturalCritical&&!compact&&!hiddenReview&&<div className="roll-reveal-outcome tray-natural-critical" role="status" aria-label="Roll result">CRITICAL HIT!</div>}
  <div ref={root} className="physics-dice-tray" style={resultLayout} data-renderer={twoDimensional?'2d':'3d'} data-compact-results={resultsLayout.compact||undefined} data-dense-results={resultsLayout.dense||undefined} data-status={frame.done?'settled':'rolling'} data-theme={theme.id} data-entry-side={own?'bottom':'top'} data-mode={frame.mode} data-material={twoDimensional?'canvas2d':failed?'unavailable':!prepared?'loading':theme.id==='sorcerer'?'volumetric-glass':theme.id==='fighter'?'obsidian-gold':theme.id==='ranger'?'forest-resin':theme.id.startsWith('dm-')?'purple-resin':theme.id} role="group" aria-label="Live dice tray">
   <div className="dice-tray-viewport"><div className="dice-tray-stage" data-surface={prewarmedWoodBg?'plain-wood':undefined} style={prewarmedWoodBg?{backgroundImage:`url("${prewarmedWoodBg}")`}:undefined}>
   {twoDimensional&&<div className="dice-2d-animation" data-testid="dice-2d-animation">{frame.sides.slice(0,24).map((sides,i)=>{const badge=dieBoxBadge(i);const dispVal=frame.values[i]===null?1:frame.percentile[i]==='tens'?(frame.values[i]!-1)*10:frame.percentile[i]==='ones'?frame.values[i]!-1:(frame.dieAdjustedValues?.[i]??frame.values[i]!);const dieEl=<DiceThemeContext.Provider key={hasDieBadges?undefined:`${frame.id}:${i}`} value={dieThemes?.[i]??theme}><ThreeDie big={frame.sides.length<=2} sides={sides} value={dispVal} percentilePart={frame.percentile[i]??undefined} rolling={frame.values[i]===null&&!pendingStart} crit={frame.critical[i]}/></DiceThemeContext.Provider>;return hasDieBadges?<div key={`${frame.id}:${i}`} className="dice-2d-slot" data-result={dieBoxResult(i)} data-role={frame.dieRoles?.[i]}>{dieEl}{badge&&<small className="tray-die-badge" data-badge-tone={badge.tone}>{badge.text}</small>}</div>:dieEl;})}{frame.sides.length>24&&<span>+{frame.sides.length-24} dice shown in the results</span>}</div>}
   <canvas className="dice-tray-canvas" ref={canvas} aria-label={result?'Settled dice':'Server dice rolling live'}/>
   <canvas className="dice-tray-transition" ref={outgoing} data-phase="idle" aria-hidden="true"/>
   {frame.burstProgress&&!result&&!compact&&<div className="tray-burst-progress" data-burst-used={frame.burstProgress.used} data-burst-limit={frame.burstProgress.limit}>Bonus dice: <strong>{frame.burstProgress.used} of {frame.burstProgress.limit}</strong></div>}
   {frame.trayBanner&&!compact&&<div className="tray-savage-banner" data-tray-banner={frame.trayBanner.tone}><strong>{frame.trayBanner.title}</strong><span>{frame.trayBanner.detail}</span></div>}
   {hasSvgOverlay&&!compact&&!reduced&&<svg ref={links} className="tray-trigger-links" viewBox="0 0 1000 671.0526" aria-hidden="true">
    <defs>
     <radialGradient id={`burst-glow-${frame.id}`}><stop offset="0" stopColor="#fff0ff"/><stop offset=".2" stopColor="#e8a1ff"/><stop offset=".5" stopColor="#b335ff" stopOpacity=".85"/><stop offset="1" stopColor="#8614ed" stopOpacity="0"/></radialGradient>
     <marker id={`burst-arrow-${frame.id}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 Z" style={{fill:'#e3b0ff',stroke:'none'}}/></marker>
     <radialGradient id={`reroll-glow-${frame.id}`}><stop offset="0" stopColor={frame.trayBanner?.tone==='lucky'?'#ecfff4':'#fff8dc'}/><stop offset=".22" stopColor={rerollAccent}/><stop offset=".52" stopColor={frame.trayBanner?.tone==='lucky'?'#16a34a':'#f59e0b'} stopOpacity=".82"/><stop offset="1" stopColor={frame.trayBanner?.tone==='lucky'?'#065f46':'#b45309'} stopOpacity="0"/></radialGradient>
     <marker id={`reroll-arrow-${frame.id}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 Z" style={{fill:rerollAccent,stroke:'none'}}/></marker>
     <radialGradient id={`savage-crit-glow-${frame.id}`}><stop offset="0" stopColor="#fff4d6"/><stop offset=".22" stopColor="#ffad3b"/><stop offset=".55" stopColor="#e8590c" stopOpacity=".85"/><stop offset="1" stopColor="#9a1b0c" stopOpacity="0"/></radialGradient>
    </defs>
    {(frame.done?diceTrigger?.groups??[]:[]).map((group,g)=><g key={g} style={{color:triggerColors[g%triggerColors.length]}}>
     {!diceTrigger?.kind&&group.indices.slice(1).map((i,j)=><g key={i}>{['aura','core','spark'].map(part=><path key={part} className={`tray-trigger-${part}`} data-from={group.indices[j]} data-to={i}/>)}</g>)}
    </g>)}
    {burstSources.map(i=><g key={`source-${i}`} className="tray-burst-source" data-burst-source={i} style={{color:'#d584ff'}}>
     <circle className="tray-burst-bloom" r="68" style={{fill:`url(#burst-glow-${frame.id})`,stroke:'none'}}/>
     <circle className="tray-burst-shockwave" r="28"/>
     <circle className="tray-burst-shockwave is-second" r="28"/>
    </g>)}
    {frame.burstLinks?.map(link=><g key={link.to} style={{color:'#e3b0ff'}} data-burst-parent={link.from} data-burst-child={link.to}>{['aura','core','spark'].map(part=><path key={part} className={`tray-trigger-${part}`} data-from={link.from} data-to={link.to} markerEnd={part==='core'?`url(#burst-arrow-${frame.id})`:undefined}/>)}</g>)}
    {rerollSources.map(i=><g key={`reroll-source-${i}`} className="tray-reroll-source" data-reroll-source={i} style={{color:rerollAccent}}>
     <circle className="tray-burst-bloom" r="62" style={{fill:`url(#reroll-glow-${frame.id})`,stroke:'none'}}/>
     <circle className="tray-reroll-shockwave" r="28"/>
     <circle className="tray-reroll-shockwave is-second" r="28"/>
    </g>)}
    {frame.rerollLinks?.map(link=><g key={`reroll-${link.from}-${link.to}`} style={{color:rerollAccent}} data-reroll-parent={link.from} data-reroll-child={link.to}>{['aura','core','spark'].map(part=><path key={part} className={`tray-trigger-${part}`} data-from={link.from} data-to={link.to} markerEnd={part==='core'?`url(#reroll-arrow-${frame.id})`:undefined}/>)}</g>)}
    {savageCritIndices.map(i=><g key={`savage-crit-${i}`} className="tray-savage-crit-source" data-savage-crit-source={i} style={{color:'#ff9e2c'}}>
     <circle className="tray-burst-bloom" r="70" style={{fill:`url(#savage-crit-glow-${frame.id})`,stroke:'none'}}/>
     <circle className="tray-savage-crit-shockwave" r="30"/>
     <circle className="tray-savage-crit-shockwave is-second" r="30"/>
    </g>)}
   </svg>}
   </div></div>
   {frame.saveDice&&<div className="tray-save-labels" aria-hidden="true">{frame.saveDice.map((save,i)=><span key={i} ref={el=>{saveLabels.current[i]=el;}} className="tray-save-label">{save.label}{save.mode?` ${save.mode.toUpperCase()}`:''}</span>)}</div>}
   {!compact&&!twoDimensional&&!reduced&&frame.dieRoles?.some((role,i)=>rolePillRoles.has(role)&&!frame.discardedDice?.[i])&&<div className="tray-role-labels" aria-hidden="true">{frame.sides.map((_,i)=>{const role=frame.dieRoles?.[i];return role&&rolePillRoles.has(role)&&!frame.discardedDice?.[i]?<span key={i} ref={el=>{roleLabels.current[i]=el;}} className={`tray-die-role-label is-${role}`} data-role-label-die={i}>{frame.dieLabels?.[i]||roleLabelFallback(role)}</span>:null;})}</div>}
   {reduced&&<div className="dice-tray-status">{frame.done?'Dice settled':'Live roll in progress'}</div>}
   <div className="tray-number-flights" aria-hidden="true">{frame.sides.map((_,i)=><span key={i} ref={el=>{flights.current[i]=el;}} style={resultStyle(i)} data-die-id={i} data-set={frame.sets[i]} data-strength={tier(i)} data-tone={flyingTone(i)} className={`tray-flying-number${frame.critical[i]?' critical':''}`}><span className="tray-number-flash"/>{value(i)}</span>)}</div>
   <div className="dice-tray-results">{frame.sides.map((side,i)=>{const badge=dieBoxBadge(i);const boxResult=dieBoxResult(i);const showTrigger=triggerGroup(i)>=0;const settledFace=arrived.includes(i)||failed;const adj=frame.dieAdjustedValues?.[i];const hasFloor=settledFace&&adj!=null&&frame.values[i]!==null&&adj!==frame.values[i];const maxLabel=settledFace?dieResultLabel(liveDieResult(frame,i)):'';const ariaVal=settledFace?(hasFloor?`${value(i)} to ${adj}`:value(i)):'rolling';return <span ref={el=>{boxes.current[i]=el;}} className={`tray-die-result${frame.critical[i]?' critical':''}`} data-die-id={i} data-role={frame.dieRoles?.[i]} data-trigger={showTrigger?'matched':undefined} data-trigger-group={showTrigger?triggerGroup(i):undefined} data-sides={side} data-value={adj??frame.values[i]??undefined} data-set={frame.sets[i]} data-result={boxResult} data-critical={!!frame.critical[i]} data-theme={dieThemes?.[i]?.id??theme.id} data-orientation={settledFace?'settled':'rolling'} aria-label={`${dieBoxHeader(side,i)}: ${ariaVal}${badge?`, ${badge.text}`:''}`} data-filled={settledFace} data-strength={tier(i)} style={{...resultStyle(i),...(showTrigger?{'--trigger-color':triggerColors[triggerGroup(i)%triggerColors.length]}:{}),...(frame.done&&frame.mode?{borderColor:frame.sets[i]===frame.kept?'#39ef87':'#ff5365',boxShadow:`0 0 6px ${frame.sets[i]===frame.kept?'#39ef87':'#ff5365'}`} : {})}} key={i}>{frame.saveDice?.[i]&&<small className="tray-save-name" title={frame.saveDice[i].label}>{frame.saveDice[i].label}</small>}{dieBoxHeader(side,i)}<strong>{settledFace?(hasFloor?<><span className="tray-die-floor-raw">{value(i)}</span><span className="tray-die-floor-arrow">{"\u2192"}</span>{adj}</>:value(i)):'?'}</strong>{badge&&<small className="tray-die-badge" data-badge-tone={badge.tone}>{badge.text}</small>}{!frame.saveDice?.[i]&&(!badge||!!maxLabel)&&<small className="tray-max-label" style={{visibility:!!maxLabel?'visible':'hidden'}} aria-hidden={!maxLabel}>{maxLabel}</small>}{frame.saveDice?.[i]&&<span className="tray-save-verdict" data-outcome={saveResult(i)?.outcome}>{saveVerdict(i)}</span>}{frame.rerolls[i]>0&&<small className="tray-reroll-count" title={`Rerolled ${frame.rerolls[i]} times`}>{"\u21bb"}{frame.rerolls[i]}</small>}</span>;})}</div>
  </div>
  <div className="tray-result-panel" onClick={pendingReroll||waitingRerollOffer?e=>e.stopPropagation():undefined}>
  {!hiddenReview&&!pendingStart&&frame.saveDice&&<div className="tray-save-details" aria-label={frame.saveDice[0]?.rollKind==='initiative'?'Initiative results':'Saving throw results'}>{frame.saveDice.map((_,i)=><span key={i}>{saveBonus(i)}</span>)}</div>}
  {!hiddenReview&&!pendingStart&&(frame.rerollPrompt||waitingRerollOffer)&&<div className={`tray-reroll-prompt${waitingRerollOffer?' is-waiting':''}`} role="region" aria-label={`${frame.rerollPrompt?.label??frame.rerollOfferLabel} reroll option`} onPointerDown={e=>e.stopPropagation()} onClick={e=>e.stopPropagation()}>
   {waitingRerollOffer?<>
    <div className="tray-reroll-info"><strong>{frame.rerollOfferLabel}</strong><span>Waiting for dice to settle…</span></div>
    <div className="tray-reroll-actions"><button type="button" className="tray-reroll-btn is-reroll" disabled>Reroll ({frame.rerollOfferLabel})</button></div>
   </>:frame.rerollPrompt!.readOnly?<>
    <div className="tray-reroll-info"><strong>{frame.rerollPrompt!.label}</strong><span>{frame.attacker??frame.roller} rolled {frame.rerollPrompt!.rollTotal} ({frame.rerollPrompt!.diceSummary}) — deciding whether to reroll…</span></div>
   </>:<>
    <div className="tray-reroll-info"><strong>{frame.rerollPrompt!.label}</strong><span>Rolled <b>{frame.rerollPrompt!.rollTotal}</b> on {frame.rerollPrompt!.diceSummary} · once per turn</span></div>
    <div className="tray-reroll-actions">
     <button type="button" className="tray-reroll-btn is-reroll" disabled={submittedRerollId===frame.rerollPrompt!.id} onClick={e=>{e.stopPropagation();handleRerollChoice(true);}}>Reroll ({frame.rerollPrompt!.label})</button>
     <button type="button" className="tray-reroll-btn is-keep" disabled={submittedRerollId===frame.rerollPrompt!.id} onClick={e=>{e.stopPropagation();handleRerollChoice(false);}}>Keep {frame.rerollPrompt!.rollTotal}</button>
    </div>
   </>}
  </div>}
  {!hiddenReview&&!pendingStart&&!frame.rerollPrompt&&!waitingRerollOffer&&diceTrigger&&!compact&&<div className="tray-trigger-result" role="status" data-dice-trigger={diceTrigger.kind??'matched'}><strong>{diceTrigger.title}</strong><span>{isSavageTrigger?diceTrigger.detail:<>{diceTrigger.detail}: {diceTrigger.groups.map((group,g)=><em key={g} style={{color:triggerColors[g%triggerColors.length]}}>{group.indices.length} {group.indices.length===1?'die':'dice'} showing {group.value}</em>)}</>}</span></div>}
  {hiddenReview??(!pendingStart&&result&&<div className="tray-roll-result">{result}</div>)}
  </div>
  <div className="live-dice-footer"><span className="muted">{result?'':!prepared&&!failed?'Loading dice…':pendingReroll?'Choose reroll or keep':frame.done?'Dice settled':frame.rerolls.some(n=>n>0)?'Rerolling unreadable dice...':'Rolling...'}</span>{!hiddenReview&&!pendingStart&&!pendingReroll&&<button type="button" onClick={event=>{event.stopPropagation();skip();}} aria-label="Skip roll animation">Skip</button>}</div>
 </div>{pendingStart&&<section className="private-save-prompt" role="region" aria-label="Saving throw needed" onClick={e=>e.stopPropagation()}>
  <span className="hidden-roll-private">DM ONLY</span>
  <h2>Saving throw needed</h2>
  <p>{heading}</p>
  <button className="btn primary" disabled={started===frame.id} onClick={()=>{setStarted(frame.id);useStore.getState().socket?.emit('dice:begin',{id:frame.id});}}>{started===frame.id?'Starting saving throw...':'Roll saving throw'}</button>
  <small>Roll privately, then accept or reroll the result.</small>
 </section>}</div>;
}
