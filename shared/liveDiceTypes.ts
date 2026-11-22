export type LiveDieRole =
  | 'base'
  | 'crit'
  | 'reroll'
  | 'reroll-crit'
  | 'savage-crit'
  | 'lucky-reroll'
  | 'floored'
  | 'exploded'
  | 'rider';
export type LiveTrayBanner = {
  title: string;
  detail: string;
  tone: 'savage-reroll' | 'savage-crit' | 'savage-both' | 'lucky' | 'floor' | 'explode' | 'rider' | 'reroll';
};
export type LiveRerollPrompt = {
  id: string;
  label: string;
  rollTotal: number;
  diceSummary: string;
  readOnly?: boolean;
};
export type LiveDiceFrame = {
 /** Confirmed dice-dependent effect, published on the first settled frame. */
 diceTrigger?:import('./types.js').RollReveal['diceTrigger'];
 /** Extra d8s already rolled and their per-cast limit; excludes base/crit dice. */
 /** Reserved capacity and parent-to-child indices for one continuous Burst tray. */
 burstCapacity?:number;burstLinks?:{from:number;to:number}[];
 burstProgress?:{used:number;limit:number};
 /** Pre-planned continuous weapon/rule tray metadata (Savage Attacker, Savage Attacks, Halfling Lucky, floors, rerolls, explosions, riders). */
 plannedDice?:{sides:number;set:number;critical?:boolean}[];
 rerollLinks?:{from:number;to:number}[];
 dieRoles?:LiveDieRole[];
 dieLabels?:(string|null)[];
 /** Effective post-floor die face when a minimum face rule raised a rolled die (e.g. GWF 1→3). */
 dieAdjustedValues?:(number|null)[];
 discardedDice?:boolean[];
 trayBanner?:LiveTrayBanner;
 /** Interactive tray decision (e.g. Savage Attacker reroll button after Wave 1 settles). */
 rerollPrompt?:LiveRerollPrompt;
 /** Label shown in disabled tray action bar while eligible Wave 1 dice are still tumbling. */
 rerollOfferLabel?:string;
 /** Calculation presented on this settled throw before the next throw starts. */
 calculation?:import('./types.js').RollReveal;
 /** Server-held reading/effects phase for a throw with no calculation card. */
 resultHoldMs?:number;
 id:string;seq:number;label:string;roller:string;className:string;attacker?:string;
 /** The initiating DM starts this private save from its automatic prompt. */
 awaitingStart?:boolean;
 target?:string;
 /** Offset is used only by the server to match a chunk to private save metadata. */
 dieOffset?:number;
 /** Per physical die; filtered with poses/results before transmission. */
 diceArt?:import('./diceThemes.js').SaveDiceArt[];
 saveDice?:{rollKind?:'initiative'|'attack'|'damage';label:string;name?:string;modifier?:number;dc?:number;group:string;mode?:'adv'|'dis';autoFail?:boolean;passEffect?:string;failEffect?:string;hideModifiers?:boolean;outcome?:'pass'|'fail'|'hit'|'miss'|'crit';crit?:boolean;damageType?:string}[];
 /** Appearance only; gold ability dice are not critical dice. */
 diceTheme?:'gold';
 dmDice?:boolean;affinity?:'friendly'|'neutral'|'enemy';
 mode?:'adv'|'dis';advantageState?:'adv'|'dis'|'straight';advantageReasons?:string[];sets:number[];critical:boolean[];percentile:('tens'|'ones'|null)[];kept?:number;
 sides:number[];radius:number;trayScale?:number;poses:number[];values:(number|null)[];rerolls:number[];
 elapsed:number;done:boolean;
 /** Collisions since the previous frame (physics seconds) — the dice sounds. */
 impacts?:import('./diceImpacts.js').DiceImpact[];
};
/** Shared presentation cadence; physics still advances live with fixed steps. */
export const LIVE_DICE_PRESENTATION_RATE=.75;
/** Wall-clock wait per throw, including the slower presentation cadence. */
export const LIVE_DICE_REROLL_WAIT_SECONDS=4;
