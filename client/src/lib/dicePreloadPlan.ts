import {diceThemeForRoll,type DiceTheme} from '../../../shared/diceThemes';

/** Start at session entry, before a character is claimed; prioritize that
 * character once known. A bounded theme list avoids warming a whole catalog. */
export function dicePreloadPlan(classes:readonly string[],ownClass:string|undefined,dm:boolean):DiceTheme[]{
 const dmTheme=diceThemeForRoll('',true);
 const candidates=dm?[
  dmTheme,
  ...classes.map(name=>diceThemeForRoll(name)),
 ]:[
  ...(ownClass===undefined?[]:[diceThemeForRoll(ownClass)]),
  ...classes.map(name=>diceThemeForRoll(name)),
 ];
 const unique=[...new Map(candidates.map(theme=>[theme.id,theme])).values()].slice(0,dm?5:4);
 if(!unique.some(theme=>theme.id===dmTheme.id))unique.push(dmTheme);
 return unique;
}
