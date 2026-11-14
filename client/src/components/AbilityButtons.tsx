import {advancedSpell} from '../../../shared/advancedSpells';
import {tokenDistanceFt} from '../../../shared/distance';
import {partySpell} from '../../../shared/partySpells';
import {COMMAND_WORDS,commandWord,commandInstruction,isCommandSpell} from '../../../shared/commandSpell';
import {linkedSpellProfile,spellKey} from '../../../shared/linkedSpells';
import {spellAreaFor} from '../../../shared/spellAreas';
import { hitFeature, markSpell, abilityKey } from '../../../shared/hitFeatures';
import {
  combatSpell,
  isSelfCombatSpell,
  isAllyTouchOrBuffSpell,
  LESSER_RESTORATION_CONDITIONS,
  GREATER_RESTORATION_CONDITIONS,
  BLINDNESS_DEAFNESS_CHOICES,
} from '../../../shared/combatSpells';
import { Fragment, useState } from 'react';
import type {
  Character,
  Monster,
  SheetAbility,
  TokenKind,
  AbilityRollPayload,
} from '../../../shared/types';
import {
  ROLL_ICON,
  confirmConcentration,
  spellBaseLevel,
  upcastable,
  isCastSpell,spellCastCost,spellCastRestriction,spellSlotBaseLevel,
} from '../lib/spellcasting';
import { useStore } from '../state/socket';
import { effectiveRecharge } from '../../../shared/monsterAttacks';
import { RechargeChip } from './RechargeChip';
import { isCanonicalAidProfile, isCanonicalBlessOrBaneProfile, isCanonicalHasteProfile, effectiveSheetAbility, hasActiveCustomEffect, isMultiTargetSpell, spellDamageTypeChoices } from '../../../shared/spellExecution';
import { ACTION_SHORT_BADGE, inferAbilityActionCost } from '../../../shared/spellPrep';
import { spellSlotOptions, selectSpellSlot, type SpellSlotPool } from '../../../shared/spellSlotPools';
import { spellCombatSupport, formatCustomEffectSummary } from '../../../shared/spellSupport';

import { spellActionBlock } from '../../../shared/spellBuffs';

const manualRiderNote = (ability: SheetAbility): string | undefined => {
  const name = ability.name.replace(/[\u2018\u2019]/g, "'").trim().toLowerCase();
  return !markSpell(ability) && ability.type === 'spell' && ability.roll?.kind === 'damage' && (name === 'ensnaring strike' || name === "hunter's mark")
    ? 'Legacy damage-only action: this button casts and spends a spell slot, but does not implement the spell’s on-hit/ongoing effects. Resolve follow-up damage manually without recasting.'
    : undefined;
};

/**
 * Shared list of rollable-ability buttons (attack/save/damage/heal) fired at a
 * chosen target. Used by the right panel's Combat section (`variant="inline"`,
 * with an upcast level select) and the right-click floating menu
 * (`variant="menu"`) so the two surfaces can't drift — the WeaponButtons
 * pattern. The caller filters the list (permissions + `roll` presence); attack
 * rolls resolve to-hit vs the target's AC. Single-target saves use the selected
 * token; area spells and separate rays use the shared targeting dock. Heals
 * restore the selected ally (or explicitly self-targeted feature) on cast.
 */
export function AbilityButtons({
  abilities,
  kind,
  caster,
  targetTokenId,
  healTargetId,
  buffTargetId,
  variant = 'inline',
  onAfter,
}: {
  abilities: SheetAbility[];
  kind: TokenKind;
  caster: Character | Monster;
  targetTokenId?: string;
  healTargetId?: string;
  buffTargetId?: string;
  variant?: 'menu' | 'inline';
  onAfter?: () => void;
}) {
  const snapshot=useStore(s=>s.snapshot);
  const [dispelAbility,setDispelAbility]=useState<SheetAbility|null>(null);
  const [dispelChoice,setDispelChoice]=useState('');
  const [invisAbility,setInvisAbility]=useState<SheetAbility|null>(null);
  const [invisTargets,setInvisTargets]=useState<string[]>([]);
  const rollAbility = useStore((s) => s.rollAbility);
  const summonCast=useStore(s=>s.summonCast),notify=useStore(s=>s.notify);
  const consumeAdvantage = useStore((s) => s.consumeAdvantage);
  const [hexAbility,setHexAbility] = useState('STR');
  const [castLevel, setCastLevel] = useState<Record<string, number>>({});
  const [slotPools,setSlotPools]=useState<Record<string,SpellSlotPool>>({});
  // Per-cast choice only: never persists a change to the authored spell.
  const [castDamageTypes, setCastDamageTypes] = useState<Record<string, string>>({});
  const [spellChoices, setSpellChoices] = useState<Record<string, string>>({});
  const damageChoice = (abilityId: string, choices: string[]) => {
    const chosen = castDamageTypes[`${caster.id}:${abilityId}`];
    return choices.includes(chosen) ? chosen : choices[0];
  };
  const choiceValue = (abilityId: string, choices: readonly string[]) => {
    const chosen = spellChoices[`${caster.id}:${abilityId}`];
    return chosen && choices.includes(chosen) ? chosen : choices[0];
  };
  const spellChoiceOptions = (a: SheetAbility, manualCast: boolean): readonly string[] => {
    const cSpell = combatSpell(a);
    if (cSpell === 'lesser restoration') return LESSER_RESTORATION_CONDITIONS;
    if (cSpell === 'greater restoration') return GREATER_RESTORATION_CONDITIONS;
    if (!manualCast && a.type === 'spell' && a.source !== 'custom' && a.executionProfile !== 'manual' && abilityKey(a) === 'blindness/deafness' && !a.roll) {
      return BLINDNESS_DEAFNESS_CHOICES;
    }
    return [];
  };
  const menu = variant === 'menu';
  const customWords=useStore(s=>s.snapshot?.commandCustomWords??true);
  const [commandAbility,setCommandAbility]=useState<SheetAbility|null>(null);
  const [chosenCommand,setChosenCommand]=useState('Halt');
  const [customWord,setCustomWord]=useState('');
  const selection=(a:SheetAbility)=>spellCastCost(caster,a,castLevel[a.id],slotPools[a.id]);
  const costText=(a:SheetAbility)=>selection(a).label;

  const cast = async (a: SheetAbility, word?:string,ids?:string[],dispelTarget?:AbilityRollPayload['dispelTarget']) => {
    const cost=selection(a);
    if(isCastSpell(a)&&(cost.unavailable||spellCastRestriction(a))){notify(spellCastRestriction(a)??`No ${cost.label.toLowerCase()} remaining for ${a.name}.`);return;}
    if(advancedSpell(a)==='dispel magic'&&!dispelTarget){setDispelAbility(a);setDispelChoice(targetTokenId??snapshot?.tokens.find(t=>t.kind===kind&&t.refId===caster.id)?.id??'');return;}
    if(advancedSpell(a)==='invisibility'&&!ids){
      setInvisAbility(a);const me=snapshot?.tokens.find(t=>t.kind===kind&&t.refId===caster.id);setInvisTargets(me?[me.id]:[]);return;
    }
    if(isCommandSpell(a)&&!word){setCommandAbility(a);setChosenCommand('Halt');return;}
    if (!await confirmConcentration(caster, a)) return;
    const level = upcastable(a) ? cost.level : undefined;
    const execution = effectiveSheetAbility(a, level);
    const manualCast = !!spellCombatSupport(a)?.manualCastOnly;
    const choiceOpts = spellChoiceOptions(a, manualCast);
    const cSpell = combatSpell(a);
    const nonTargetedRoll = execution.roll?.kind !== 'attack' && execution.roll?.kind !== 'save';
    const selfCustom = nonTargetedRoll && isSelfCombatSpell(a);
    const allyBuff = isCanonicalHasteProfile(a) || (nonTargetedRoll && isAllyTouchOrBuffSpell(a));
    const isUpcastHeroism = cSpell === 'heroism' && (level ?? 1) > 1;
    if(execution.summon&&!manualCast){
      const map=snapshot?.map;if(!map){notify('Choose an active map before summoning.');return;}
      const g=map.gridSizePx||50,me=snapshot.tokens.find(t=>t.kind===kind&&t.refId===caster.id);
      const anchor=a.name.toLowerCase()==='spiritual weapon'?snapshot.tokens.find(t=>t.id===targetTokenId)??me:me;
      const reach=5*g/(map.feetPerSquare||5);
      summonCast({kind,refId:caster.id,abilityId:a.id,mapId:map.id,x:anchor?anchor.x-reach:g*2,y:anchor?.y??g*2,castLevel:level,slotPool:cost.slot?.pool});
      notify(`Cast requested: ${a.name} · ${cost.label}. The server records the cast and places the summon.`);onAfter?.();return;
    }
    rollAbility({
      kind,
      refId: caster.id,
      abilityId: a.id,
      commandWord: word ?? (choiceOpts.length ? choiceValue(a.id, choiceOpts) : undefined),
      dispelTarget,
      targetTokenIds:ids,
      castLevel: level,
      // A pool only when the player picked one, or for an upcastable spell at its
      // real cast level. Otherwise the server chooses — a level-0 lookup here
      // would always favour Pact Magic (e.g. legacy Divine Smite on a
      // Paladin/Warlock spending the pact slot while ordinary slots remain).
      slotPool: slotPools[a.id] ?? (level !== undefined ? cost.slot?.pool : undefined),
      damageType: markSpell(a)==='necrotic'?hexAbility:damageChoice(a.id, spellDamageTypeChoices(a, level)),
      // Advantage only affects the d20 of an attack roll; it comes from the
      // caster's shared toggle and is consumed when the attack fires.
      advantage: !manualCast && (execution.roll?.kind === 'attack'||advancedSpell(a)==='dispel magic') && !(linkedSpellProfile(a)&&spellKey(a.name)==='flame blade') ? consumeAdvantage(caster.id) : undefined,
      targetTokenId: dispelTarget ? undefined : ids ? ids[0] : (linkedSpellProfile(a)&&['mirror image','flame blade'].includes(spellKey(a.name))) || selfCustom || (isUpcastHeroism && !menu) ? undefined : allyBuff ? (buffTargetId ?? healTargetId ?? targetTokenId) : manualCast ? targetTokenId : execution.roll?.kind === 'heal' ? healTargetId
        : isMultiTargetSpell(a, level) ? undefined : targetTokenId,
    });
    if(isCastSpell(a)&&!useStore.getState().areaCast&&!useStore.getState().teleportCast&&!useStore.getState().rayCast)notify(`Cast requested: ${a.name} · ${cost.label}. Check the cast record and slot counter for confirmation.`);
    onAfter?.();
  };

  const invisRequested=invisAbility ? selection(invisAbility).level : 2;
  const invisLevel=invisAbility&&'spellSlots'in caster ? selectSpellSlot(caster,invisRequested,slotPools[invisAbility.id])?.level??invisRequested : invisRequested;
  const visibleAbilities = abilities.filter((a,idx,arr)=>!hitFeature(a)&&(!markSpell(a)||arr.findIndex(x=>markSpell(x)&&abilityKey(x)===abilityKey(a)&&(x.sourceClass??'')===(a.sourceClass??''))===idx));
  const hasActionItems = !menu && visibleAbilities.some(a => { const c = inferAbilityActionCost(a); return c === 'action' || c === 'other'; });
  const hasBonusItems = !menu && visibleAbilities.some(a => inferAbilityActionCost(a) === 'bonus');
  const hasReactionItems = !menu && visibleAbilities.some(a => inferAbilityActionCost(a) === 'reaction');
  const showActionGroups = !menu && [hasActionItems, hasBonusItems, hasReactionItems].filter(Boolean).length >= 2;
  const orderedAbilities = showActionGroups
    ? [
        ...visibleAbilities.filter(a => { const c = inferAbilityActionCost(a); return c === 'action' || c === 'other'; }),
        ...visibleAbilities.filter(a => inferAbilityActionCost(a) === 'bonus'),
        ...visibleAbilities.filter(a => inferAbilityActionCost(a) === 'reaction'),
      ]
    : visibleAbilities;
  let lastGroup: 'action' | 'bonus' | 'reaction' | null = null;
  return (
    <>
      {dispelAbility&&<div className="spell-target-dock" role="region" aria-label="Dispel Magic target">
        <strong>Dispel Magic ? choose one target</strong>
        <small>Within 120 ft. Spells up to your casting level end automatically; higher spells require a spellcasting ability check.</small>
        <select aria-label="Dispel target" value={dispelChoice} onChange={e=>setDispelChoice(e.target.value)}>
          <option value="">Choose creature, object or spell area</option>
          {snapshot?.tokens.filter(t=>!t.sharedSightOnly&&!t.partiallyRevealed).map(t=>{const e=t.kind==='pc'?snapshot.characters.find(c=>c.id===t.refId):snapshot.monsters.find(m=>m.id===t.refId);return <option key={t.id} value={t.id}>{e?.name??'Creature'}{t.revealTag?` ${t.revealTag}`:''}</option>;})}
          {snapshot?.measurements.filter(m=>m.spellName==='Spike Growth').map(m=><option key={m.id} value={`effect:${m.id}`}>Spike Growth area</option>)}
        </select>
        <button className="btn" disabled={!dispelChoice||selection(dispelAbility).unavailable} onClick={()=>{const target=dispelChoice.startsWith('effect:')?{effectId:dispelChoice.slice(7),mapId:snapshot!.map!.id}:{tokenId:dispelChoice};cast(dispelAbility,undefined,undefined,target);setDispelAbility(null);}}>Cast Dispel Magic · {costText(dispelAbility)}</button>
        <button className="btn" onClick={()=>setDispelAbility(null)}>Cancel</button>
      </div>}
      {invisAbility&&<div className="spell-target-dock" role="region" aria-label="Invisibility targets">
        <strong>Invisibility ? choose willing creatures to touch</strong>
        <small>Within 5 ft ? up to {invisLevel-1} targets ? concentration</small>
        {snapshot?.tokens.filter(t=>{
          const me=snapshot.tokens.find(t=>t.kind===kind&&t.refId===caster.id);
          const e=t.kind==='pc'?snapshot.characters.find(c=>c.id===t.refId):snapshot.monsters.find(m=>m.id===t.refId);
          return me&&e&&(!('curHp'in e)||e.curHp>0)&&(!('objectKind'in e)||!e.objectKind)&&(!('disposition'in e)||e.disposition==='friendly')&&!t.sharedSightOnly&&!t.partiallyRevealed&&tokenDistanceFt(me,t,snapshot.map)<=5;
        }).map(t=>{const e=t.kind==='pc'?snapshot.characters.find(c=>c.id===t.refId):snapshot.monsters.find(m=>m.id===t.refId);return <label key={t.id}><input type="checkbox" checked={invisTargets.includes(t.id)} onChange={event=>setInvisTargets(ids=>event.target.checked?[...ids,t.id]:ids.filter(id=>id!==t.id))}/>{e?.name}</label>;})}
        <button className="btn" disabled={!invisTargets.length||invisTargets.length>invisLevel-1||selection(invisAbility).unavailable} onClick={()=>{cast(invisAbility,undefined,invisTargets);setInvisAbility(null);}}>Cast Invisibility · {costText(invisAbility)}</button>
        <button className="btn" onClick={()=>setInvisAbility(null)}>Cancel</button>
      </div>}
      {orderedAbilities.map((a) => {
        const rawActionCost = inferAbilityActionCost(a);
        const groupBucket: 'action' | 'bonus' | 'reaction' = rawActionCost === 'bonus' ? 'bonus' : rawActionCost === 'reaction' ? 'reaction' : 'action';
        const showHeader = showActionGroups && groupBucket !== lastGroup;
        lastGroup = groupBucket;
        const cost=selection(a),spell=isCastSpell(a),restriction=spell?spellCastRestriction(a):undefined;
        const level = upcastable(a) ? cost.level : undefined;
        const base=spellSlotBaseLevel(a);
        const levels='spellSlots'in caster&&(slotPools[a.id]??cost.slot?.pool)==='pact'?spellSlotOptions(caster,base).filter(o=>o.pool==='pact').map(o=>o.level):Array.from({length:10-base},(_,i)=>base+i);
        const execution = effectiveSheetAbility(a, level);
        const support = spellCombatSupport(a);
        const manualCast = !!support?.manualCastOnly;
        const damageTypes = manualCast ? [] : spellDamageTypeChoices(a, level);
        const multiple = isMultiTargetSpell(a, level);
        const hasRollDice = !!execution.roll?.dice?.trim() && execution.roll.dice.trim() !== '0';
        const saveOnly = execution.roll?.kind === 'save' && !hasRollDice;
        const nonTargetedRoll = execution.roll?.kind !== 'attack' && execution.roll?.kind !== 'save';
        const selfSpell=(linkedSpellProfile(a)&&['mirror image','flame blade'].includes(spellKey(a.name))) || (nonTargetedRoll && isSelfCombatSpell(a));
        const area=spellAreaFor(a,level);
        const summon=!!execution.summon&&!manualCast;
        const cSpell = combatSpell(a);
        const allyBuff = isCanonicalHasteProfile(a) || (nonTargetedRoll && isAllyTouchOrBuffSpell(a));
        const needsRequiredTarget = isCanonicalHasteProfile(a) || cSpell === 'spare the dying' || cSpell === 'revivify';
        const choiceOpts = spellChoiceOptions(a, manualCast);

        const choosing=dispelAbility?.id===a.id||invisAbility?.id===a.id||commandAbility?.id===a.id;

        const customFxNote = hasActiveCustomEffect(execution.roll?.customEffect)
          ? formatCustomEffectSummary(execution.roll?.customEffect)
          : undefined;
        const combatWorkflow = cSpell === 'shield of faith' ? 'Apply +2 AC while concentrating (defaults to self if no ally is selected).'
          : cSpell === 'mage armor' ? 'Set base AC to 13 + DEX for an unarmored creature for 8 hours (defaults to self).'
          : cSpell === 'blur' ? 'Impose disadvantage on attackers without Blindsight or Truesight while concentrating.'
          : cSpell === 'see invisibility' ? 'See invisible creatures and objects within 120 ft for 1 hour.'
          : cSpell === 'greater invisibility' ? 'Turn a touched creature invisible without breaking on attacks or spell casts while concentrating.'
          : cSpell === 'heroism' ? ((level ?? 1) > 1 ? 'Choose up to cast-level allies within 5 ft for Frightened immunity and temporary HP each turn.' : 'Grant Frightened immunity and casting-mod temporary HP each turn while concentrating (defaults to self).')
          : cSpell === 'protection from poison' ? 'Neutralize Poisoned and grant Poison resistance (plus poison-save advantage) for 1 hour.'
          : cSpell === 'lesser restoration' ? 'Cure the chosen condition (Blinded, Deafened, Paralyzed, or Poisoned).'
          : cSpell === 'greater restoration' ? 'Cure Charm, Petrified, 1 Exhaustion level, Harm max-HP loss, or other debilitating effects.'
          : cSpell === 'spare the dying' ? 'Stabilize a living creature at 0 HP within range.'
          : cSpell === 'revivify' ? 'Revive a dead creature with 1 hit point.'
          : cSpell === 'death ward' ? 'Prevent lethal damage once by dropping to 1 HP instead.'
          : customFxNote;
        const workflow = area ? 'Place the measured spell area, review affected bases, then confirm. Saves roll together; damage applies automatically. Ongoing or manual effects stay with the DM.' : combatWorkflow ? combatWorkflow : isCanonicalAidProfile(a) ? 'Choose up to three creatures within 30 ft to gain +5 maximum and current HP (+5/lvl).' : isCanonicalBlessOrBaneProfile(a) ? 'Choose up to three creatures within 30 ft (+1/lvl) on the map.' : selfSpell ? spellKey(a.name)==='mirror image' ? 'Create three duplicates of yourself.' : 'Create the blade, then attack using its Active spell actions button.' : manualCast ? 'Record this casting and spend its spell slot; resolve its effects manually.' : multiple
          ? execution.roll?.kind === 'attack' ? 'Cast once, then choose a target for each separate spell attack.' : saveOnly ? 'Cast, then choose targets to roll saving throws.' : 'Roll once, then apply to targets on the map.'
          : execution.roll?.healTarget === 'self' ? 'Restore your own health.'
            : saveOnly ? 'Cast and force the selected target to roll its saving throw.' : 'Cast at the selected target.';
        // A spent limited-use action stays clickable (the DM decides), but reads as spent.
        const spent = !!effectiveRecharge(a)?.spent;
        const btn = (
          <button
            key={menu ? a.id : 'btn'}
            className={`${menu ? 'btn tiny fm-spell-attack' : 'btn tiny attack-row'}${spell || a.type === 'spell' ? ' spell-attack-btn' : ' ability-attack-btn'}${spent ? ' recharge-spent' : ''}`}
            title={[restriction, a.description || 'Ability', workflow, support?.manual.length ? `You handle: ${support.manual.join('; ')}` : '', manualRiderNote(a), spent ? 'Spent — ready it from its ⟳ chip after a successful recharge roll.' : ''].filter(Boolean).join('\n')}
            disabled={!!spellActionBlock(caster) || !!restriction || spell&&cost.unavailable || (!summon&&!isCommandSpell(a)&&!area && !manualCast && !menu && !selfSpell && !['invisibility','dispel magic'].includes(advancedSpell(a)??'') && !['misty step','pass without trace'].includes(partySpell(a)??'') && !multiple && !(cSpell === 'heroism' && (level ?? 1) > 1) && (allyBuff ? (needsRequiredTarget && !(buffTargetId ?? healTargetId ?? targetTokenId)) : execution.roll?.kind === 'heal' ? execution.roll.healTarget !== 'self' && !healTargetId : !targetTokenId))}
            onClick={() => cast(a)}
          >
            <span>
              {spell?'Cast':execution.roll?ROLL_ICON[execution.roll.kind]:'Use'} {a.name}{spell?` · ${cost.label}${a.prepared===false&&(a.level??0)>0?' (not prepared)':''}`:''}{menu && spent ? ' (spent)' : ''}
            </span>
            {!menu && rawActionCost !== 'other' && (
              <span className={`ability-cost-badge is-${rawActionCost}`} aria-hidden="true" title={rawActionCost === 'bonus' ? 'Bonus Action' : rawActionCost === 'reaction' ? 'Reaction' : 'Action'}>
                {ACTION_SHORT_BADGE[rawActionCost]}
              </span>
            )}
          </button>
        );
        const damageTypeSelect = damageTypes.length > 0 && (
          <select
            className="spell-level spell-damage-type"
            aria-label={`${a.name} damage type`}
            title={`Damage type for ${a.name} — this cast only; the saved spell is unchanged`}
            value={damageChoice(a.id, damageTypes)}
            onChange={(e) => setCastDamageTypes((current) => ({
              ...current, [`${caster.id}:${a.id}`]: e.target.value,
            }))}
          >
            {damageTypes.map((damageType) => (
              <option key={damageType} value={damageType}>
                {damageType.charAt(0).toUpperCase() + damageType.slice(1)}
              </option>
            ))}
          </select>
        );
        const choiceSelect = choiceOpts.length > 0 && (
          <select
            className="spell-level spell-choice"
            aria-label={`${a.name} effect`}
            title={`Choose effect for ${a.name} — this cast only`}
            value={choiceValue(a.id, choiceOpts)}
            onChange={(e) => setSpellChoices((current) => ({
              ...current, [`${caster.id}:${a.id}`]: e.target.value,
            }))}
          >
            {choiceOpts.map((choice) => (
              <option key={choice} value={choice}>{choice}</option>
            ))}
          </select>
        );
        return (
          <Fragment key={a.id}>
            {showHeader && (
              <div className={`ability-group-header is-${groupBucket}`}>
                {groupBucket === 'bonus' ? '⚡ Bonus Actions' : groupBucket === 'reaction' ? '↩ Reactions' : '● Actions'}
              </div>
            )}
            <div className={`combat-ability-row${spell || a.type === 'spell' ? ' is-spell' : ' is-ability'}${damageTypeSelect || choiceSelect || abilityKey(a) === 'hex' || upcastable(a) ? ' has-options' : ''}`}>
              {choosing?null:btn}
              <RechargeChip ability={a} kind={kind} refId={caster.id} />
              {(damageTypeSelect || choiceSelect || abilityKey(a) === 'hex' || upcastable(a)) && <span className="combat-ability-options-tag" aria-hidden="true">{upcastable(a) && !damageTypeSelect && !choiceSelect && abilityKey(a) !== 'hex' ? '↳ Slot' : '↳'}</span>}{damageTypeSelect}{choiceSelect}
              {abilityKey(a)==='hex'&&<select aria-label="Hex ability checks" value={hexAbility} onChange={e=>setHexAbility(e.target.value)}>{['STR','DEX','CON','INT','WIS','CHA'].map(k=><option key={k}>{k}</option>)}</select>}
              {upcastable(a) && (
                <select
                  className="spell-level"
                  value={level}
                  aria-label={`${a.name} cast level`}
                  title="Cast at level (upcast)"
                  onChange={(e) =>
                    setCastLevel((c) => ({ ...c, [a.id]: Number(e.target.value) }))
                  }
                >
                  {levels.map((v) => {
                    return (
                      <option key={v} value={v}>
                        Level {v}{kind==='pc'&&'spellSlots'in caster?` · ${selectSpellSlot(caster,v,slotPools[a.id]??cost.slot?.pool)?.remaining??0} remaining`:''}
                      </option>
                    );
                  })}
                </select>
              )}
              {kind==='pc'&&'spellSlots' in caster&&Object.keys(caster.spellSlots).some(k=>/^P[1-5]$/.test(k))&&upcastable(a)&&
                <select aria-label={`${a.name} slot pool`} value={slotPools[a.id]??selectSpellSlot(caster,level??spellBaseLevel(a))?.pool??'spellcasting'}
                  onChange={e=>{
                    const pool=e.target.value as SpellSlotPool;setSlotPools(p=>({...p,[a.id]:pool}));
                    const option=spellSlotOptions(caster,spellBaseLevel(a)).find(o=>o.pool===pool&&o.remaining>0);
                    if(option)setCastLevel(p=>({...p,[a.id]:option.level}));
                  }}>
                  <option value="spellcasting">Spellcasting</option><option value="pact">Pact Magic</option>
                </select>}
            </div>
          </Fragment>
        );
      })}
      {commandAbility&&<div className="modal-backdrop" onClick={()=>setCommandAbility(null)}><div className="modal" role="dialog" aria-label="Choose Command" onClick={e=>e.stopPropagation()}>
        <div className="modal-head"><h3>Command</h3><button className="btn tiny" onClick={()=>setCommandAbility(null)}>Cancel</button></div>
        <p>Choose one word. Failed Wisdom saves make the target obey on its next turn.</p>
        <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>{COMMAND_WORDS.map(word=><button className={`btn ${chosenCommand===word?'active':''}`} key={word} aria-pressed={chosenCommand===word} onClick={()=>setChosenCommand(word)}>{word}</button>)}
          {customWords&&<button className="btn" aria-pressed={chosenCommand==='Custom'} onClick={()=>setChosenCommand('Custom')}>Custom word</button>}</div>
        <p>{commandInstruction(chosenCommand)}</p>
        {chosenCommand==='Custom'&&<label>One word <input aria-label="Custom Command word" maxLength={32} value={customWord} onChange={e=>setCustomWord(e.target.value)}/><small>The DM interprets and resolves this command.</small></label>}
        <button className="btn" disabled={selection(commandAbility).unavailable||chosenCommand==='Custom'&&!commandWord(customWord)} onClick={()=>{const a=commandAbility;setCommandAbility(null);cast(a,chosenCommand==='Custom'?commandWord(customWord):chosenCommand);}}>Cast Command · {costText(commandAbility)}</button>
      </div></div>}
    </>
  );
}
