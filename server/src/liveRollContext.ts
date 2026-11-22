// Only populated during a synchronous, rollback-safe command pass.
import type {RollReveal,HiddenRollResult} from '../../shared/types.js';
export type LiveRerollPromptRequest = { label: string; rollTotal: number; diceSummary: string };
let calculationPresenter:((key:string,reveal:RollReveal)=>boolean)|undefined;
export function withLiveCalculationPresenter<T>(present:(key:string,reveal:RollReveal)=>boolean,run:()=>T):T {
 const previous=calculationPresenter;calculationPresenter=present;
 try{return run();}finally{calculationPresenter=previous;}
}
/** Suspend only the presentation; the surrounding command still commits once. */
export function presentLiveCalculation(key:string,reveal:RollReveal){
 if(!active||!calculationPresenter)return false;
 return calculationPresenter(key,reveal);
}
let rerollChoiceProvider:((key:string,info:LiveRerollPromptRequest)=>boolean)|undefined;
export function withLiveRerollChoice<T>(choose:(key:string,info:LiveRerollPromptRequest)=>boolean,run:()=>T):T {
 const previous=rerollChoiceProvider;rerollChoiceProvider=choose;
 try{return run();}finally{rerollChoiceProvider=previous;}
}
export function requestLiveRerollChoice(key:string,info:LiveRerollPromptRequest):boolean {
 if(!active||!rerollChoiceProvider)return false;
 return rerollChoiceProvider(key,info);
}
export const hasLiveRerollChoice=()=>active&&!!rerollChoiceProvider;
export type RollFacing={sessionId:string;attackerTokenId:string;targetTokenId:string};
let facing:RollFacing[]=[];
export const stagedRollFacing=()=>facing.slice();
export function noteRollFacing(value:RollFacing){if(active)facing.push(value);}
let active=false;
let effects:(()=>unknown)[]|null=null;
let resultReveal=false;
let reviewResults:HiddenRollResult[]=[];
export const stagedRollResults=()=>reviewResults.slice();
export function noteRollResult(result:HiddenRollResult){if(active)reviewResults.push(result);}
/** A final snapshot may render the last throw; earlier throws cannot use it.
 *  Auto-failed saves roll no dice and replace the tray with a text card, so
 *  any preceding unmodified throw still needs its full reading hold first. */
export function noteLiveRollReveal(reveal:RollReveal|undefined){
 if(active&&reveal&&!reveal.presentedLive&&!reveal.autoFailReason)resultReveal=true;
}
export function resetLiveRollReveal(){if(active)resultReveal=false;}
export const hasLiveRollReveal=()=>resultReveal;
export const isLiveCommand=()=>active;
export function stageRollEffects<T>(run:()=>T){
 active=true;effects=[];facing=[];resultReveal=false;reviewResults=[];
 try {const value=run();return {value,effects};}
 finally {active=false;effects=null;facing=[];resultReveal=false;reviewResults=[];}
}
export function afterRollCommit(effect:()=>unknown){if(effects){effects.push(effect);return;}return effect();}
