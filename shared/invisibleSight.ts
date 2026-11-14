import type {Condition,CreatureAbility} from './types.js';
export function isBlindCondition(conditions:readonly {label:string;isConcentration?:boolean}[]|undefined):boolean{
  return !!conditions?.some(c=>!c.isConcentration&&/^blind(?:ed)?$/i.test(c.label.trim()));
}
export function seesInvisible(e:{conditions:readonly Condition[];abilities?:readonly CreatureAbility[]},distanceFt:number){
  if(isBlindCondition(e.conditions))return false;
  if(e.conditions.some(c=>/^see invisibility|^truesight$/i.test(c.label)))return true;
  const traits=(e.abilities??[]).map(a=>`${a.name} ${a.description}`).join(' ');
  return [...traits.matchAll(/(?:blindsight|truesight)\s*:?\s*(\d+)\s*(?:ft|feet)/ig)].some(m=>distanceFt<=Number(m[1]));
}
export function ignoresBlur(e:{conditions:readonly Condition[];abilities?:readonly CreatureAbility[]},distanceFt:number){
  if(isBlindCondition(e.conditions))return true;
  if(e.conditions.some(c=>/^truesight$/i.test(c.label)))return true;
  const traits=(e.abilities??[]).map(a=>`${a.name} ${a.description}`).join(' ');
  return [...traits.matchAll(/(?:blindsight|truesight)\s*:?\s*(\d+)\s*(?:ft|feet)/ig)].some(m=>distanceFt<=Number(m[1]));
}
