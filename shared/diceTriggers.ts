import type {RollReveal} from './types.js';
/** Indices refer to the original damage dice, including critical dice, never riders. */
export function matchingDiceTrigger(
 faces:number[],
 title='Orb can leap!',
 minMatches=2,
 kind?:NonNullable<RollReveal['diceTrigger']>['kind'],
):RollReveal['diceTrigger']{
 const groups=new Map<number,number[]>();
 faces.forEach((face,index)=>{const indices=groups.get(face)??[];indices.push(index);groups.set(face,indices);});
 const matches=[...groups].filter(([,indices])=>indices.length>=Math.max(2,minMatches)).map(([value,indices])=>({value,indices}));
 return matches.length?{...(kind?{kind}:{}),title,detail:'Matching damage dice',diceCount:faces.length,groups:matches}:undefined;
}
export const DICE_TRIGGER_HOLD_MS=1800;

/** Only unreserved bonus capacity can be triggered by these exact maximum faces. */
export function sorcerousDiceTrigger(faces:number[],used:number,limit:number,queued=0):RollReveal['diceTrigger']{
 const maxima=faces.flatMap((value,i)=>value===8?[i]:[]);
 if(!maxima.length)return undefined;
 const eligible=maxima.slice(0,Math.max(0,limit-used-queued));
 return eligible.length?{kind:'burst',title:'Burst!',detail:`+${eligible.length} bonus d8${eligible.length>1?'s':''} triggered`,diceCount:faces.length,groups:[{value:8,indices:eligible}]}:
  {kind:'burst-limit',title:'Burst limit reached',detail:used>=limit?'No bonus dice remaining':'Remaining bonus dice already triggered',diceCount:faces.length,groups:[{value:8,indices:maxima}]};
}

/** Generalized exploding dice trigger for custom spells/weapons (any die size or face). */
export function explodingDiceTrigger(
 faces:number[],
 sides:number[],
 triggerOn:'max'|number,
 used:number,
 limit:number,
 queued=0,
 label='Exploding Dice',
 bonusDice?:string,
):RollReveal['diceTrigger']{
 const hitIndices=faces.flatMap((value,i)=>{
  const target=triggerOn==='max'?(sides[i]??value):triggerOn;
  return value===target?[i]:[];
 });
 if(!hitIndices.length)return undefined;
 const eligible=hitIndices.slice(0,Math.max(0,limit-used-queued));
 const triggerValue=triggerOn==='max'?(sides[eligible[0]??hitIndices[0]]??faces[eligible[0]??hitIndices[0]]??0):triggerOn;
 const bonusLabel=bonusDice?` (${bonusDice})`:'';
 return eligible.length
  ?{kind:'exploding-dice',title:`${label}!`,detail:`+${eligible.length} bonus ${bonusLabel||'die'}${eligible.length>1?'s':''} triggered on ${triggerValue}`,diceCount:faces.length,groups:[{value:triggerValue,indices:eligible}]}
  :{kind:'burst-limit',title:`${label} limit reached`,detail:used>=limit?'Explosion cap reached':'Remaining explosions already queued',diceCount:faces.length,groups:[{value:triggerValue,indices:hitIndices}]};
}
