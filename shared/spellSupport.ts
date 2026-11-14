import {partySpell} from './partySpells.js';
import {advancedSpell} from './advancedSpells.js';
import {isCommandSpell} from './commandSpell.js';
import {linkedSpellProfile} from './linkedSpells.js';
import {spellAreaFor} from './spellAreas.js';
import type { SheetAbility, SpellCustomEffect } from './types.js';
import { abilityKey, hitFeature, markSpell } from './hitFeatures.js';
import { combatSpell, type CombatSpellKey } from './combatSpells.js';
import { effectiveSheetAbility, hasActiveCustomEffect, isCanonicalAidProfile, isCanonicalArmorOfAgathysProfile, isCanonicalBlessOrBaneProfile, isCanonicalHasteProfile } from './spellExecution.js';
import { matchesRevisedSpell2024, spellRevision2024For } from './spellRevisions.js';

export type SpellCombatSupport = {
  status: 'ready' | 'partial' | 'manual';
  label: string;
  automated: string[];
  manual: string[];
  /** Record a cast, but never run an incomplete catalogue damage/heal roll. */
  manualCastOnly: boolean;
};
type SpellInput = Pick<SheetAbility, 'name' | 'type'> & Partial<SheetAbility>;

/** This is a runtime capability audit, not a claim that every printed rule is
 * enforced. No saved sheet is migrated. A custom/authored roll keeps its own
 * behavior and is labelled unreviewed. Review against the 2024 Free Rules:
 * https://www.dndbeyond.com/sources/dnd/br-2024/spell-descriptions */
const MANUAL_ROLLS: Record<string, string> = {
  'false life': 'Temporary HP are not healing; set temporary HP manually using the spell rules.',
  aid: 'Increase maximum and current HP for up to three targets manually; this is not ordinary healing.',
  'armor of agathys': 'Set temporary HP and resolve the conditional retaliation manually.',
  'true strike': 'Resolve the weapon attack with the casting ability and its additional damage manually.',
  'poison spray': 'The saved catalogue uses a save; the 2024 spell requires a ranged spell attack.',
  'inflict wounds': 'The saved catalogue uses a spell attack; the 2024 spell requires a Constitution save and different damage.',
  'sorcerous burst': 'Choose a permitted damage type and resolve bonus dice on maximum faces manually; the catalogue roll is incomplete.',
  'witch bolt': 'Resolve the 2024 initial damage and repeat-use damage manually; the catalogue uses an older formula.',
  'ray of enfeeblement': 'Resolve the 2024 saving throw and weakening effect manually; the catalogue uses an older attack.',
  contagion: 'Resolve the 2024 saving throws and disease effects manually; the catalogue uses an older attack.',
  'ice knife': 'Resolve the attack and the separate nearby-creature explosion save/damage manually.',
  'ice storm': 'The corrected description lists both damage pools; roll and apply Bludgeoning and Cold separately with their own resistances.',
  'flame strike': 'The corrected description lists both damage pools; roll and apply Fire and Radiant separately with their own resistances.',
  'meteor swarm': 'Roll and apply Fire and Bludgeoning separately and avoid counting overlapping areas twice.',
  'prismatic spray': 'Resolve the randomly selected ray and its individual effect manually.',
  'prismatic wall': 'Resolve each layer and its distinct damage, save, or condition manually.',
  'storm of vengeance': 'Resolve the round-specific damage types and effects manually.',
  'mass cure wounds': 'Resolve the 2024 healing pool and all chosen targets manually; the catalogue formula is older.',
  'mass heal': 'Allocate the fixed healing pool among targets manually; this is not a single-target heal with a casting bonus.',
  'prayer of healing': 'Resolve the Short Rest and healing for all chosen targets manually; a single-target healing roll does not complete this spell.',
  'conjure animals': 'The summon button represents older rules; resolve the 2024 spirit-area effect manually.',
  'conjure woodland beings': 'The summon button represents older rules; resolve the 2024 spirit-area effect manually.',
  'elemental weapon': 'Apply the weapon attack bonus and extra damage to its attacks manually, rather than casting a damage roll.',
  'bestow curse': 'Choose the curse, resolve its save, and apply its ongoing effect manually, rather than casting its optional damage rider.',
  'fire shield': 'Apply its resistance and conditional retaliation manually, rather than casting a damage roll.',
  geas: 'Apply the control effect and conditional damage manually, rather than dealing damage when cast.',
  'circle of death': 'Resolve the 2024 damage dice and scaling manually; the catalogue uses older d6s instead of d8s.',
  weird: 'Resolve the 2024 initial damage, fear, and recurring damage manually; the catalogue uses an older formula.',
  'wind wall': 'Resolve the 2024 initial damage and wall effects manually; the catalogue damage is incomplete.',
  'blade barrier': 'Resolve Force damage and repeated area entry/exposure manually; the catalogue uses the older damage type.',
  dream: 'Resolve the dream interaction and conditional nightmare damage manually; damage is not dealt immediately on casting.',
  earthquake: 'Resolve the terrain, fissures, and conditional falling-structure damage manually; damage is not dealt to every target on casting.',
  'mordenkainen\'s sword': 'Resolve the 2024 attack damage with its casting modifier and repeat-use actions manually; the catalogue uses an older formula.',
  'flame blade': 'Resolve the weapon-like attack, casting-modifier damage, and upcast scaling manually; the catalogue roll is incomplete.',
  'spiritual weapon': 'Resolve the floating weapon, casting-modifier damage, upcast scaling, concentration, and repeat attacks manually; the catalogue placeholder/roll is incomplete.',
  'glyph of warding': 'Place the glyph and choose its trigger and effect manually; its damage is not dealt immediately when the glyph is created.',
  feeblemind: 'This older spell entry combines immediate damage and the mental-effect save incorrectly; resolve the chosen rules version manually.',
  'hunger of hadar': 'Resolve the automatic Cold damage and conditional Acid damage separately on their turn triggers; the catalogue omits Cold and incorrectly defaults to half Acid damage on a successful save.',
};

// Recognize the shipped incomplete formula, not every homebrew spell with the
// same name. Saved edits to these roll fields retain their authored behavior.
// Tuple: level, kind, dice, scaleDice, damageType, save.
const UNSAFE_SHAPES: Record<string, [number, string, string, string?, string?, string?]> = {
  'poison spray': [0, 'save', '1d12', '1d12', 'poison', 'CON'],
  'sorcerous burst': [0, 'attack', '1d8', '1d8', 'force'],
  'true strike': [0, 'attack', '1d6', '1d6', 'radiant'],
  'armor of agathys': [1, 'damage', '5', '5', 'cold'],
  'false life': [1, 'heal', '1d4+4', '', 'healing'],
  'ice knife': [1, 'attack', '1d10', '', 'piercing'],
  'inflict wounds': [1, 'attack', '3d10', '1d10', 'necrotic'],
  'witch bolt': [1, 'attack', '1d12', '1d12', 'lightning'],
  aid: [2, 'heal', '5', '5', 'healing'],
  'branding smite': [2, 'damage', '2d6', '1d6', 'radiant'],
  'prayer of healing': [2, 'heal', '2d8', '1d8', 'healing'],
  'ray of enfeeblement': [2, 'attack', '0', '', 'necrotic'],
  'bestow curse': [3, 'damage', '1d8', '', 'necrotic'],
  'elemental weapon': [3, 'damage', '1d4'],
  'fire shield': [4, 'damage', '2d8', '', 'fire'],
  'ice storm': [4, 'save', '2d8', '1d8', 'bludgeoning', 'DEX'],
  contagion: [5, 'attack', '0', '', 'poison'],
  'flame strike': [5, 'save', '4d6', '1d6', 'fire', 'DEX'],
  geas: [5, 'damage', '5d10', '', 'psychic'],
  'mass cure wounds': [5, 'heal', '3d8', '1d8', 'healing'],
  'prismatic spray': [7, 'save', '10d6', '', '', 'DEX'],
  'mass heal': [9, 'heal', '700', '', 'healing'],
  'meteor swarm': [9, 'save', '40d6', '', 'fire', 'DEX'],
  'prismatic wall': [9, 'save', '10d6', '', '', 'DEX'],
  'storm of vengeance': [9, 'save', '2d6', '', 'thunder', 'CON'],
  'circle of death': [6, 'save', '8d6', '2d6', 'necrotic', 'CON'],
  weird: [9, 'save', '4d10', '', 'psychic', 'WIS'],
  'wind wall': [3, 'save', '3d8', '', 'bludgeoning', 'STR'],
  'blade barrier': [6, 'save', '6d10', '', 'slashing', 'DEX'],
  dream: [5, 'save', '3d6', '', 'psychic', 'WIS'],
  earthquake: [8, 'save', '5d6', '', 'bludgeoning', 'DEX'],
  'mordenkainen\'s sword': [7, 'attack', '3d10', '', 'force'],
  'flame blade': [2, 'attack', '3d6', '', 'fire'],
  'spiritual weapon': [2, 'attack', '1d8', '', 'force'],
  'glyph of warding': [3, 'save', '5d8', '1d8', '', 'DEX'],
  feeblemind: [8, 'save', '4d6', '', 'psychic', 'INT'],
  'hunger of hadar': [3, 'save', '2d6', '', 'acid', 'DEX'],
};

function isEditedUnsafeRoll(ability: SheetAbility, key: string): boolean {
  const shape = UNSAFE_SHAPES[key];
  const roll = ability.roll;
  if (!shape || !roll) return false;
  return ability.level !== shape[0] || roll.kind !== shape[1] || formula(roll.dice) !== shape[2] ||
    formula(roll.scaleDice) !== (shape[3] ?? '') || (roll.damageType ?? '').trim().toLowerCase() !== (shape[4] ?? '') ||
    (roll.save ?? '').trim().toUpperCase() !== (shape[5] ?? '');
}

const DETAILS: Record<string, string[]> = {
  'hypnotic pattern': ['Apply Charmed/Incapacitated and remove them when the spell ends or its wake-up conditions occur.'],
  command: ['Choose a command and resolve its behavior on the next turn after a failed save.'],
  'chill touch': ['Prevent healing for the stated duration; the app does not enforce that rider or its range.'],
  'ray of frost': ['Apply and expire the speed reduction.'],
  'shocking grasp': ['Apply the reaction restriction until the next turn.'],
  'guiding bolt': ['Apply and consume advantage on the next attack against the target.'],
  'ray of sickness': ['Apply and expire the poison effect using the chosen rules version.'],
  'thunderwave': ['Move failed-save targets away and resolve loose objects.'],
  'dissonant whispers': ['Resolve the target reaction and movement.'],
  'disintegrate': ['Resolve the destruction effect if the damage reduces the target to 0 HP.'],
  'finger of death': ['Resolve any undead-creation effect after a kill.'],
  'mass healing word': ['Choose eligible creatures within range; the app enforces six distinct recipients, not range or line of sight.'],
  'mass cure wounds': ['Choose up to six eligible creatures inside the spell area; area placement and range remain DM adjudication.'],
  'witch bolt': ['Resolve later Bonus Action damage, the link, range, and Total Cover manually; Cast starts a new spell and may spend another slot.'],
  'sorcerous burst': ['Resolve extra dice from maximum faces manually, including the casting-modifier bonus-die limit.'],
  'wind wall': ['Place the wall and adjudicate gases, flying creatures, and projectile blocking manually.'],
  weird: ['Apply Frightened and resolve later saves, recurring damage, and effect cleanup manually.'],
  'ray of enfeeblement': ['Apply the success/failure weakening effects and their repeat saves manually.'],
  contagion: ['Apply Poisoned, the chosen save disadvantage, repeat saves, and the lasting disease effect manually.'],
  'spiritual weapon': ['Place and move the weapon, and resolve later Bonus Action attacks without recasting or spending another slot.'],
  blight: ['Resolve automatic save failure for plant creatures and the noncreature-plant effect manually.'],
  'vampiric touch': ['Heal the caster for half the Necrotic damage actually taken by the target.'],
  'phantasmal killer': ['Apply ability-check and attack disadvantage, repeat end-of-turn saves/damage, and end the spell on a successful save.'],
  'melf\'s acid arrow': ['Apply half initial damage on a miss and the later Acid damage; the app handles only ordinary hit damage.'],
  'spirit guardians': ['Choose the eligible damage type, halve affected creature speeds, and handle area/turn triggers and once-per-turn eligibility.'],
  sunbeam: ['Apply and expire blindness and resolve later beams without casting the spell again.'],
  sunburst: ['Apply blindness and resolve its later saves/duration.'],
  regenerate: ['Track recurring healing, duration, and regrowth after the initial heal.'],
  'hunter\'s mark': ['Track the non-damage benefits and eligible target/range rules.'],
  hex: ['Choose the affected ability when marking the target and check eligibility/duration with the DM.'],
};
const REPEATED = new Set(['flaming sphere', 'moonbeam', 'call lightning', 'spirit guardians', 'cloudkill',
  'wall of fire', 'insect plague', 'blade barrier', 'sunbeam', 'wall of ice', 'wall of thorns',
  'incendiary cloud', 'cloud of daggers', 'heat metal', 'spike growth', 'flame blade',
  'vampiric touch', 'mordenkainen\'s sword', 'hunger of hadar', 'guardian of faith']);
// These names have reviewed core combat paths. Situational adjudication remains
// the DM's job; unknown/custom rolls never earn this label by having dice alone.
const COMBAT_SPELL_AUTOMATED: Record<CombatSpellKey, { desc: string; summary: string }> = {
  'shield of faith': {
    desc: 'Target ally within 60 ft gains +2 AC while concentrating (10-minute duration cleanup).',
    summary: 'Buff (+2 AC) · 1 ally (60 ft)',
  },
  'mage armor': {
    desc: 'Unarmored target gains base AC 13 + DEX modifier (8-hour duration cleanup).',
    summary: 'Buff (AC 13 + DEX) · 1 unarmored ally',
  },
  blur: {
    desc: 'Attackers relying on sight (without Blindsight/Truesight) have Disadvantage on attack rolls against the caster while concentrating.',
    summary: 'Buff (sight atk dis) · self',
  },
  'see invisibility': {
    desc: 'Caster perceives Invisible tokens within line of sight and map walls (1-hour duration cleanup).',
    summary: 'Buff (see Invisible) · self',
  },
  'greater invisibility': {
    desc: 'Touched target gains Invisible while concentrating without breaking on attacks, damage, or spellcasts.',
    summary: 'Buff (Invisible on atk/cast) · 1 ally',
  },
  heroism: {
    desc: 'Touched creatures (+1 per slot above 1st) become immune to Frightened and gain temporary HP equal to your spellcasting modifier (min 1) on cast and at turn start while concentrating.',
    summary: 'Buff (+mod temp HP/turn, Frightened immune) · 1 ally (+1/lvl)',
  },
  'protection from poison': {
    desc: 'Removes Poisoned conditions on cast and grants Poison damage resistance for 1 hour (with save-advantage reminder text and 1-hour cleanup).',
    summary: 'Buff (Poison res + cure Poisoned) · 1 ally',
  },
  'lesser restoration': {
    desc: 'Touched creature loses the chosen condition (Blinded, Deafened, Paralyzed, or Poisoned).',
    summary: 'Cure Blinded / Deafened / Paralyzed / Poisoned · 1 ally',
  },
  'greater restoration': {
    desc: 'Touched creature loses the selected or active debuff (Harm max-HP reduction, Petrified, Charmed, Curse/attunement, or -1 Exhaustion level).',
    summary: 'Cure Charm / Petrified / -1 Exhaustion / max HP / Curse · 1 ally',
  },
  'spare the dying': {
    desc: 'Stabilizes a living creature at 0 HP within level-scaled range (15/30/60/120 ft) without spending a slot.',
    summary: 'Stabilize 0 HP (15–120 ft) · 1 target',
  },
  revivify: {
    desc: 'Revives a creature at 0 HP with 1 HP and clears dead/stabilized markers on a touched creature.',
    summary: 'Revive 0 HP to 1 HP · 1 ally',
  },
  'death ward': {
    desc: 'Touched creature drops to 1 HP instead of 0 HP the first time damage would reduce it to 0 HP (consumed on trigger, 8-hour duration).',
    summary: 'Ward (drop to 1 HP instead of 0 once) · 1 ally',
  },
};

const READY: Record<string, { level: number; kind: string; dice: string; scale?: string }> = {
  'eldritch blast': { level: 0, kind: 'attack', dice: '1d10' },
  'chromatic orb': { level: 1, kind: 'attack', dice: '3d8', scale: '1d8' },
  'magic missile': { level: 1, kind: 'damage', dice: '1d4+1' },
  'scorching ray': { level: 2, kind: 'attack', dice: '2d6' },
  'cure wounds': { level: 1, kind: 'heal', dice: '2d8', scale: '2d8' },
  'healing word': { level: 1, kind: 'heal', dice: '2d4', scale: '2d4' },
  'sacred flame': { level: 0, kind: 'save', dice: '1d8', scale: '1d8' },
  'vicious mockery': { level: 0, kind: 'save', dice: '1d6', scale: '1d6' },
  'arms of hadar': { level: 1, kind: 'save', dice: '2d6', scale: '1d6' },
  harm: { level: 6, kind: 'save', dice: '14d6' },
  heal: { level: 6, kind: 'heal', dice: '70', scale: '10' },
  'poison spray': { level: 0, kind: 'attack', dice: '1d12', scale: '1d12' },
  'inflict wounds': { level: 1, kind: 'save', dice: '2d10', scale: '1d10' },
  'false life': { level: 1, kind: 'heal', dice: '2d4+4', scale: '5' },
};
const formula = (value: string | undefined) => (value ?? '').replace(/\s/g, '').toLowerCase();
function reviewedExtras(key: string, a: SheetAbility): boolean {
  const r = a.roll!;
  if (r.baseLevel !== a.level) return false;
  switch (key) {
    case 'eldritch blast': return r.damageType === 'force' && r.instances === 1 && r.scaleInstances === 1 && r.instanceScaling === 'cantrip';
    case 'chromatic orb': return !r.damageType && [...(r.damageTypeChoices ?? [])].sort().join(',') === 'acid,cold,fire,lightning,poison,thunder';
    case 'magic missile': return r.damageType === 'force' && r.instances === 3 && r.scaleInstances === 1 && !r.instanceScaling;
    case 'scorching ray': return r.damageType === 'fire' && r.instances === 3 && r.scaleInstances === 1 && !r.instanceScaling;
    case 'cure wounds': case 'healing word': return r.damageType === 'healing' && (!r.healingBonus || r.healingBonus === 'spellcasting') && (!r.healTarget || r.healTarget === 'selected');
    case 'sacred flame': return r.damageType === 'radiant' && r.save === 'DEX' && r.saveDamage === 'none' && r.targetMode === 'single';
    case 'vicious mockery': return r.damageType === 'psychic' && r.save === 'WIS' && r.saveDamage === 'none' && r.targetMode === 'single';
    case 'arms of hadar': return r.damageType === 'necrotic' && r.save === 'STR' && r.saveDamage === 'half' && r.targetMode === 'multiple';
    case 'harm': return r.damageType === 'necrotic' && r.save === 'CON' && r.saveDamage === 'half' && r.targetMode === 'single';
    case 'heal': return (!r.damageType || r.damageType === 'healing') && (!r.healingBonus || r.healingBonus === 'none') && !r.healingMode && (!r.healTarget || r.healTarget === 'selected') && (!r.targetMode || r.targetMode === 'single');
    case 'poison spray': case 'inflict wounds': case 'false life': return matchesRevisedSpell2024(a);
    default: return false;
  }
}

export function spellCombatSupport(input: SpellInput): SpellCombatSupport | null {
  if (input.type !== 'spell') return null;
  const ability: SheetAbility = { id: 'support-audit', description: '', ...input };
  const key = abilityKey(ability);
  const advanced=advancedSpell(ability);
  if(advanced){
    const descriptions={invisibility:'Touch targets, upcast recipients, translucent party/DM figures, hostile sight filtering, advantage/disadvantage, per-target attack/damage/cast breaking, concentration and expiry.', 'spike growth':'Measured persistent 20 ft radius; path-clipped movement damage with cumulative 5 ft thresholds, Piercing defenses, concentration and expiry.','dispel magic':'Choose a visible creature, object, or tracked spell area within 120 ft. Lower-level spells end automatically; higher levels use spellcasting checks. Linked effects clean up.',counterspell:'Pre-resolution cast interruption, visible opposing caster within 60 ft, Constitution save, reaction and slot spending; interrupted cast preserves its slot.'};
    return {status:'partial',label:'Partial',automated:[descriptions[advanced]],manual:[advanced==='dispel magic'?'Untracked legacy effects, homebrew magic, and spell-specific exceptions require DM adjudication.':advanced==='spike growth'?'Camouflaged hazard discovery and available movement budgets are DM-adjudicated.':advanced==='counterspell'?'Nested counterspells and casting without perceptible components are table-adjudicated.':'Willingness, detection by sound, and unusual senses are DM-adjudicated.'],manualCastOnly:false};
  }
  const party=partySpell(ability);
  if(party){
    const descriptions:Record<string,string>={shield:'Post-hit reaction choice, slot/reaction spending, +5 AC through the next turn, triggering-hit recheck and Magic Missile immunity.', 'misty step':'Choose and confirm a visible, unoccupied destination within 30 feet; teleport without walking through intervening walls.', 'hypnotic pattern':'Measured cube and grouped Wisdom saves; linked Charmed/Incapacitated, speed zero, wake-up on damage or an action, concentration and expiry cleanup.', 'pass without trace':'Choose recipients; moving 30-foot emanation grants +10 Stealth only while inside, with concentration and duration cleanup.'};
    return {status:'ready',label:'Combat ready',automated:[descriptions[party]],manual:[],manualCastOnly:false};
  }
  const linked=linkedSpellProfile(ability);
  if(isCommandSpell(ability))return {status:'partial',label:'Partial',automated:['Command choice, upcast target limits, Wisdom saves, next-turn effects, Halt restrictions, Grovel Prone, and turn-end cleanup.'],manual:['Movement routes and dropped items; optional custom words are DM-adjudicated.'],manualCastOnly:false};
  if (isCanonicalAidProfile(ability)) {
    return {
      status: 'partial',
      label: 'Partial',
      automated: [
        'Cast record and spell-slot bookkeeping.',
        'Increases maximum and current HP for up to three chosen creatures (+5 per slot above 2nd) and restores maximum HP when the Aid condition ends.',
      ],
      manual: ['8-hour duration across rests or scene changes remains DM-managed.'],
      manualCastOnly: false,
    };
  }
  if (isCanonicalArmorOfAgathysProfile(ability)) {
    return {
      status: 'ready',
      label: 'Combat ready',
      automated: [
        'Cast record and spell-slot bookkeeping.',
        'Grants 5 temporary HP per slot level (replacing smaller pools) and deals 5 Cold damage per slot level back to melee attackers while Armor of Agathys temporary HP remain.',
      ],
      manual: [],
      manualCastOnly: false,
    };
  }
  const blessOrBane = isCanonicalBlessOrBaneProfile(ability);
  if (blessOrBane) {
    return {
      status: 'ready',
      label: 'Combat ready',
      automated: [
        'Cast record, spell-slot bookkeeping, and concentration tracking.',
        blessOrBane === 'bless'
          ? 'Buffs up to 3 creatures (+1 per slot above 1st) with +1d4 on attack rolls and saving throws (including concentration and death saves) while active.'
          : 'Requires CHA saves for up to 3 creatures (+1 per slot above 1st); failed saves apply -1d4 on attack rolls and saving throws (including concentration and death saves) while active.',
      ],
      manual: [],
      manualCastOnly: false,
    };
  }
  const combat = combatSpell(ability);
  if (combat) {
    const automated = ['Cast record and spell-slot bookkeeping.'];
    if (combat === 'shield of faith' || combat === 'blur' || combat === 'greater invisibility' || combat === 'heroism') {
      automated.push('Concentration tracking.');
    }
    automated.push(COMBAT_SPELL_AUTOMATED[combat].desc);
    return { status: 'ready', label: 'Combat ready', automated, manual: [], manualCastOnly: false };
  }
  if(linked) {
    const automated:Record<string,string>={
      'mirror image':'Three translucent copies of the caster; per-hit duplicate checks, removal, sight exceptions, and one-minute expiry.',
      'sorcerous burst':'Chosen damage type, cantrip/critical dice, and recursive maximum-face bonus dice capped by the casting modifier.',
      'ice knife':'Piercing attack, then a Cold explosion on hit or miss, with one damage roll and grouped nearby-creature saves.',
      "melf's acid arrow":'Initial Acid damage, half initial damage on a miss, and one delayed damage roll at target turn end after a hit.',
      'vampiric touch':'Melee spell attack, critical damage, healing from defended Necrotic damage, and concentration-linked repeat attacks.',
      'hold monster':'Initial and turn-end Wisdom saves, Paralysis and action restrictions, upcast targets, and concentration cleanup; Undead are eligible.',
      'phantasmal killer':'Initial damage/save, attack/check disadvantage on failure, and turn-end saves before recurring damage.',
      'heat metal':'Initial/repeated Fire damage, Constitution saves, heated-item penalties and a drop control, linked to concentration.',
      'witch bolt':'Initial spell attack and subsequent Bonus Action damage, even after a miss; range/Total Cover break the link.',
      'spiritual weapon':'Summoned floating weapon, 20-foot movement, 5-foot reach, initial and repeat Bonus Action attacks, upcasting, and concentration cleanup.',
      'flame blade':'Create the blade, then use its repeat Magic action attacks with casting-modifier damage and concentration.',
      'call lightning':'Initial/repeated 5-foot bursts, one Lightning damage pool followed by grouped Dexterity saves, and concentration.',
      'ice storm':'Separate Bludgeoning/Cold pools, upcasting, per-type defenses, and one combined HP application per creature.',
      'flame strike':'Separate Fire/Radiant pools, upcasting both, per-type defenses, and one combined HP application per creature.',
      'meteor swarm':'Separate Fire/Bludgeoning pools, per-type defenses, and prevention of duplicate damage to a creature in overlapping areas.',
      'guiding bolt':'Radiant spell attack and next-attack advantage, consumed by that attack or expired at the end of the caster next turn.',
      'ray of frost':'Cold spell attack and live speed reduction until the caster next turn.',
      'ray of sickness':'Poison damage and Poisoned on a hit, without an extra save; expires at the end of the caster next turn.',
      'chill touch':'Melee d10 spell attack, cantrip scaling, and healing prevention through the end of the caster next turn.',
      'shocking grasp':'Lightning spell attack and a timed no-Opportunity-Attacks condition; other actions/reactions remain available.',
    };
    const limitations:Record<string,string>={
      'spiritual weapon':'Summons beside the selected target; the DM can reposition the force for unusual placement or terrain.',
      'flame blade':'Blade appearance and its continuous light are table-managed.',
      'heat metal':'Select an eligible manufactured metal object; the DM adjudicates whether it can be dropped or armor must be removed.',
      'call lightning':'Place the measured strike; adjudicate cloud space and the existing-storm bonus.',
      'ice storm':'Track temporary difficult terrain; cylinder targeting, grouped saves, and typed damage are automatic.',
      'flame strike':'Cylinder targeting, grouped saves, and typed damage are automatic; adjudicate unusual terrain or elevation.',
      'meteor swarm':'Sphere targeting avoids duplicate hits; adjudicate object/terrain effects.',
      'shocking grasp':'Opportunity attacks are table-managed; the condition indicates that they cannot be made.',
    };
    return {status:'partial',label:'Partial',automated:[automated[key]??'Linked spell rolls and effects.'],
      manual:[limitations[key]??'Range, targeting eligibility, and situational rules remain table adjudication.'],manualCastOnly:false};
  }
  const effective = effectiveSheetAbility(ability);
  const revised = matchesRevisedSpell2024(effective);
  const authored = ability.source === 'custom' || ability.executionProfile === 'manual' ||
    (!revised && (isEditedUnsafeRoll(ability, key) || !!(ability.roll && spellRevision2024For(ability))));
  const automated = ['Cast record and spell-slot bookkeeping.'];
  if(spellAreaFor(ability))automated.push('Measured area placement and combat-footprint targeting; supported initial effects use one labelled group of saving throws.');
  const manual: string[] = [];
  if (effective.tags?.some(tag => tag.toLowerCase() === 'concentration')) automated.push('Concentration tracking.');
  const result = (status: SpellCombatSupport['status'], manualCastOnly = false): SpellCombatSupport => ({
    status, label: status === 'ready' ? 'Combat ready' : status === 'partial' ? 'Partial' : 'Manual',
    automated, manual, manualCastOnly,
  });
  if (!authored && MANUAL_ROLLS[key] && !(revised && effective.roll)) {
    manual.push(MANUAL_ROLLS[key], 'Automatic effect rolls are disabled for this entry; record the cast and resolve its effect with the DM.');
    return result('manual', true);
  }
  if (authored) {
    const customSummary = formatCustomEffectSummary(effective.roll?.customEffect);
    if (effective.roll) automated.push('The saved custom roll and its configured target/damage behavior.');
    if (customSummary) automated.push(`Custom condition/effect: ${customSummary}.`);
    if (effective.smite) automated.push('Post-hit option, slot spending, typed damage, critical dice, and damage reveal.');
    if (effective.summon) automated.push('Place the configured friendly summon placeholder; stat blocks, duration, and commands remain manual.');
    manual.push('Custom or explicitly authored mechanics have not been verified against the spell rules. Review effects, targets, and duration with the DM.');
    const hasAutomated = Boolean(effective.roll || effective.summon || effective.smite);
    return result(hasAutomated ? 'partial' : 'manual', !hasAutomated);
  }
  if (effective.smite) {
    automated.push('Post-hit option, slot spending, typed damage, critical dice, and damage reveal.');
    if (key === 'divine smite' && ability.level === 1 && formula(effective.smite.dice) === '2d8' &&
        formula(effective.smite.scaleDice) === '1d8' && effective.smite.damageType === 'radiant' &&
        formula(effective.smite.bonusVs?.dice) === '1d8' &&
        [...(effective.smite.bonusVs?.creatureTypes ?? [])].sort().join(',') === 'fiend,undead') return result('ready');
    manual.push('Review the configured smite damage and eligibility with the DM; this is not the reviewed Divine Smite profile.');
    return result('partial');
  }
  if (hitFeature(ability)) {
    automated.push('Post-hit spell choice, damage/save flow, and supported linked conditions.');
    manual.push('Check eligibility, duration, and later-turn effects with the DM; not every ongoing rule is automated.');
    return result('partial');
  }
  if (markSpell(ability)) {
    automated.push('Target mark, concentration, attack damage rider including critical dice, and move-mark offer after a kill.');
    if (key === 'hex') automated.push('Ability-check disadvantage for the selected Hex ability.');
    manual.push(...DETAILS[key]);
    return result('partial');
  }
  if (key === 'haste') {
    if (isCanonicalHasteProfile(ability)) {
      automated.push('Linked target buff: +2 AC, doubled speed, Dexterity-save advantage, one limited extra action per turn, and ending lethargy through the target’s next turn.');
      return result('ready');
    }
    manual.push('This edited Haste entry uses its configured roll; automatic Haste benefits require the reviewed buff profile.');
    return result('partial');
  }
  if (key === 'hold person' && ability.level === 2 && effective.roll?.kind === 'save' &&
      effective.roll.save === 'WIS' && (!effective.roll.dice || formula(effective.roll.dice) === '0')) {
    automated.push('Humanoid eligibility, upcast target limit, paralysis with action/movement restrictions on a failed save, end-of-turn repeat saves, and concentration-linked cleanup.');
    return result('ready');
  }
  if (!ability.roll && effective.roll?.kind === 'save' && (!effective.roll.dice || formula(effective.roll.dice) === '0')) {
    if (key === 'faerie fire' && ability.level === 1 && effective.roll.save === 'DEX') {
      automated.push('Measured 20-ft cube, grouped Dexterity saves, Faerie Fire outline granting attack advantage and blocking Invisible benefits, and concentration-linked cleanup.');
      return result('ready');
    }
    if (key === 'entangle' && ability.level === 1 && effective.roll.save === 'STR') {
      automated.push('Measured 20-ft square, grouped Strength saves applying Restrained on failure (speed 0, attack disadvantage, attack advantage against, DEX save disadvantage), and concentration-linked cleanup.');
      return result('ready');
    }
    if (key === 'slow' && ability.level === 3 && effective.roll.save === 'WIS') {
      automated.push('Up to 6 chosen targets within 120 ft, Wisdom saves applying Slow (-2 AC & DEX saves, halved speed, no reactions, turn-end repeat saves), and concentration-linked cleanup.');
      return result('ready');
    }
    if (key === 'blindness/deafness' && ability.level === 2 && effective.roll.save === 'CON') {
      automated.push('Blinded or Deafened condition choice, upcast extra-target limit, Constitution saves, Blinded attack/sight penalties, and turn-end repeat saves.');
      return result('ready');
    }
    if (key === "tasha's hideous laughter" && ability.level === 1 && effective.roll.save === 'WIS') {
      automated.push('Upcast target limit, Wisdom saves applying Tasha’s Hideous Laughter (cascading Prone & Incapacitated), turn-end repeat saves, Advantage repeat saves triggered on taking damage, and concentration-linked cleanup.');
      return result('ready');
    }
  }
  if (effective.summon) {
    automated.push('Place a friendly summon token on the map.');
    manual.push('Summoned stat blocks, commands, duration, and removal are manual; the placed token is a placeholder, not a complete summoned creature.');
    if (effective.roll) manual.push('Use the spell\'s configured attack separately; confirm its damage bonus and upcast rules.');
    return result('partial');
  }
  if (!effective.roll) {
    manual.push('Resolve the described effect, choices, duration, and any checks with the DM. The app records the cast but does not automate this effect.');
    return result('manual', true);
  }
  const roll = effective.roll;
  if (roll.kind === 'attack') automated.push('Spell attack, hit/critical result, and subsequent damage roll.');
  else if (roll.kind === 'heal') automated.push(roll.healingMode === 'temporary'
    ? 'Temporary-HP roll, upcast scaling, and larger-pool replacement without healing.'
    : roll.targetMode === 'multiple' ? 'One healing roll plus casting modifier, applied once to each chosen creature up to the target limit.'
      : 'Initial healing roll and selected-target HP application.');
  else if (roll.kind === 'save') automated.push('Initial saving throw, labelled result, and configured save damage.');
  else automated.push('Configured damage roll and target application.');
  if (roll.scaleDice || roll.scaleInstances) automated.push('Configured level/upcast scaling.');
  manual.push(...(DETAILS[key] ?? []));
  if (REPEATED.has(key)) manual.push('Recurring damage and repeat-use actions are manual. The Cast action is a fresh casting and may spend another slot.');
  const reviewed = READY[key];
  const matchesReviewed = reviewed && ability.level === reviewed.level && roll.kind === reviewed.kind &&
    formula(roll.dice) === reviewed.dice && formula(roll.scaleDice) === (reviewed.scale ?? '') && reviewedExtras(key, effective);
  if (matchesReviewed) {
    if (key === 'vicious mockery') automated.push('Applies Disadvantage on the target’s next attack roll on a failed save (consumed on that attack or cleared at the end of its next turn).');
    if (key === 'arms of hadar') automated.push('Prevents reactions until the start of the target’s next turn on a failed save.');
    if (key === 'harm') automated.push('Reduces the target’s maximum HP by the necrotic damage taken on a failed save (minimum max HP 1), cured by Greater Restoration or a Long Rest.');
    if (key === 'heal') automated.push('Fixed healing without adding casting modifier, plus curing Blinded, Deafened, and Poisoned on the target.');
  }
  if (!matchesReviewed && !manual.length) manual.push('Area/target eligibility, additional effects, and duration need DM adjudication; only the configured roll is automated.');
  return result(matchesReviewed && !manual.length ? 'ready' : 'partial');
}

/** Concise single-line summary of a manually configured `customEffect`. */
export function formatCustomEffectSummary(ce?: SpellCustomEffect): string | undefined {
  if (!hasActiveCustomEffect(ce) || !ce) return undefined;
  const parts: string[] = [];
  if (ce.conditionLabel?.trim()) {
    const extras: string[] = [];
    if (ce.baseAc !== undefined) extras.push(`AC ${ce.baseAc}${ce.baseAcAddsDex ? '+DEX' : ''}`);
    if (ce.acBonus) extras.push(`${ce.acBonus > 0 ? '+' : ''}${ce.acBonus} AC`);
    if (ce.attackBonusDice) extras.push(`${/^[+-]/.test(ce.attackBonusDice.trim()) ? ce.attackBonusDice.trim() : `+${ce.attackBonusDice.trim()}`} atk`);
    if (ce.saveBonusDice) extras.push(`${/^[+-]/.test(ce.saveBonusDice.trim()) ? ce.saveBonusDice.trim() : `+${ce.saveBonusDice.trim()}`} save`);
    if (ce.attackBonus) extras.push(`${ce.attackBonus > 0 ? '+' : ''}${ce.attackBonus} atk`);
    if (ce.saveBonus) extras.push(`${ce.saveBonus > 0 ? '+' : ''}${ce.saveBonus} save`);
    if (ce.speedBonus) extras.push(`+${ce.speedBonus}ft speed`);
    if (ce.speedReduction) extras.push(`-${ce.speedReduction}ft speed`);
    if (ce.slow) extras.push('half speed');
    if (ce.zeroSpeed) extras.push('speed 0');
    if (ce.tempHpPerTurn) extras.push(`+${ce.tempHpPerTurn} THP/turn`);
    if (ce.repeatDamage?.trim()) extras.push(`${ce.repeatDamage.trim()}${ce.repeatDamageType ? ` ${ce.repeatDamageType}` : ''}/turn`);
    if (ce.repeatSave) extras.push(`repeat ${ce.repeatSave.toUpperCase()} save`);
    if (ce.resistDamageTypes?.length) extras.push(`resist ${ce.resistDamageTypes.join('/')}`);
    if (ce.immuneConditions?.length) extras.push(`immune ${ce.immuneConditions.join('/')}`);
    parts.push(extras.length ? `${ce.conditionLabel.trim()} (${extras.join(', ')})` : ce.conditionLabel.trim());
  }
  if (ce.cureConditions?.length) {
    parts.push(`cures ${ce.cureConditions.join(', ')}`);
  }
  return parts.join(' · ') || undefined;
}

export type SpellCastSummary = {
  text: string;
  /** True when casting only records the slot/area without an automated roll or effect. */
  needsEdit: boolean;
};

function formatArea(area: NonNullable<ReturnType<typeof spellAreaFor>>): string {
  const count = area.count && area.count > 1 ? ` ×${area.count}` : '';
  const size = area.sizeFt >= 5280 && area.sizeFt % 5280 === 0 ? `${area.sizeFt / 5280}mi` : `${area.sizeFt}ft`;
  return `${size} ${area.kind}${count}`;
}

const UPCAST_EXTRA_TARGET_SPELLS = new Set([
  'hold person', 'command', 'hold monster', 'banishment', 'charm person',
  'blindness/deafness', "tasha's hideous laughter", 'fly', 'invisibility',
]);

/** Compact, human-readable summary of a spell's current cast mechanics (dice, save/attack/heal, targeting) for the spellbook window. */
export function spellCastSummary(input: SpellInput): SpellCastSummary | null {
  const ability: SheetAbility = { id: 'cast-summary', description: '', ...input };
  if (ability.type !== 'spell' && !markSpell(ability) && !hitFeature(ability)) return null;
  const key = abilityKey(ability);
  const advanced = advancedSpell(ability);
  if (advanced === 'invisibility') return { text: 'Touch buff · Invisible · 1 ally (+1/lvl)', needsEdit: false };
  if (advanced === 'spike growth') return { text: '2d4 piercing/5ft · 20ft sphere', needsEdit: false };
  if (advanced === 'dispel magic') return { text: 'Dispel effect · 1 target/area', needsEdit: false };
  if (advanced === 'counterspell') return { text: 'Reaction · CON save · 1 target', needsEdit: false };

  const party = partySpell(ability);
  if (party === 'shield') return { text: 'Reaction · +5 AC · self', needsEdit: false };
  if (party === 'misty step') return { text: 'Teleport 30ft · self', needsEdit: false };
  if (party === 'pass without trace') return { text: '+10 Stealth · 30ft emanation', needsEdit: false };
  if (party === 'hypnotic pattern') return { text: 'WIS save · 30ft cube', needsEdit: false };

  if (isCommandSpell(ability)) return { text: 'WIS save · command · 1 target (+1/lvl)', needsEdit: false };

  const linked = linkedSpellProfile(ability);
  if (linked) {
    if (key === 'mirror image') return { text: '3 duplicates · self', needsEdit: false };
    if (key === 'ice knife') return { text: 'Attack 1d10 piercing + DEX save 2d6 cold · 1 target + 5ft', needsEdit: false };
    if (key === 'ice storm') return { text: 'DEX save (half) · 2d8 bludg + 4d6 cold · 20ft cylinder', needsEdit: false };
    if (key === 'flame strike') return { text: 'DEX save (half) · 4d6 fire + 4d6 radiant · 10ft cylinder', needsEdit: false };
    if (key === 'meteor swarm') return { text: 'DEX save (half) · 20d6 fire + 20d6 bludg · 40ft sphere ×4', needsEdit: false };
    if (key === 'spiritual weapon') return { text: 'Summon + Attack 1d8+mod (+1d8/lvl) force · 1 target', needsEdit: false };
    if (key === 'flame blade') return { text: 'Blade · Attack 3d6+mod (+1d6/lvl) fire · 1 target', needsEdit: false };
  }

  const effective = effectiveSheetAbility(ability);
  const support = spellCombatSupport(ability);

  if (effective.smite) {
    const smite = effective.smite;
    const scale = smite.scaleDice ? ` (+${smite.scaleDice}/lvl)` : '';
    return { text: `On-hit smite · ${smite.dice}${scale} ${smite.damageType} · 1 target`, needsEdit: false };
  }
  const hf = hitFeature(ability);
  if (hf) {
    if (hf === 'hail of thorns') return { text: 'On-hit · DEX save (half) · 1d10 (+1d10/lvl) piercing · 5ft sphere', needsEdit: false };
    if (hf === 'searing smite') return { text: 'On-hit · 1d6 (+1d6/lvl) fire · 1 target', needsEdit: false };
    if (hf === 'thunderous smite') return { text: 'On-hit · 2d6 thunder + STR save · 1 target', needsEdit: false };
    if (hf === 'wrathful smite') return { text: 'On-hit · 1d6 psychic + WIS save · 1 target', needsEdit: false };
    if (hf === 'ensnaring strike') return { text: 'On-hit · STR save · 1d6 (+1d6/lvl) piercing · 1 target', needsEdit: false };
    if (hf === 'branding smite') return { text: 'On-hit · 2d6 (+1d6/lvl) radiant + blocks invisibility · 1 target', needsEdit: false };
    return { text: 'On-hit rider · 1 target', needsEdit: false };
  }
  const mark = markSpell(ability);
  if (mark) return { text: `Bonus mark · +1d6 ${mark} on hit · 1 target`, needsEdit: false };
  if (isCanonicalHasteProfile(ability)) return { text: 'Buff (+2 AC, 2× speed) · 1 ally', needsEdit: false };
  if (isCanonicalAidProfile(ability)) return { text: 'Buff (+5 max & cur HP, +5/lvl) · up to 3 allies', needsEdit: false };
  if (isCanonicalArmorOfAgathysProfile(ability)) return { text: 'Temp HP 5 (+5/lvl) + cold ward · self', needsEdit: false };
  const blessOrBane = isCanonicalBlessOrBaneProfile(ability);
  if (blessOrBane === 'bless') return { text: 'Buff (+1d4 atk/save) · up to 3 allies (+1/lvl)', needsEdit: false };
  if (blessOrBane === 'bane') return { text: 'Debuff (-1d4 atk/save · CHA save) · up to 3 targets (+1/lvl)', needsEdit: false };
  const combat = combatSpell(ability);
  if (combat) return { text: COMBAT_SPELL_AUTOMATED[combat].summary, needsEdit: false };

  if (support?.manualCastOnly) {
    const area = spellAreaFor(effective);
    return { text: area ? `No roll · ${formatArea(area)}` : 'No roll · cast only', needsEdit: true };
  }
  if (effective.summon) {
    return { text: `Summon token (${effective.summon.name?.trim() || ability.name})`, needsEdit: false };
  }
  if (!effective.roll) {
    const area = spellAreaFor(effective);
    return { text: area ? `No roll · ${formatArea(area)}` : 'No roll · cast only', needsEdit: true };
  }

  const roll = effective.roll;
  const dice = (roll.dice ?? '').trim();
  const hasDice = Boolean(dice && dice !== '0');
  const isCantrip = (effective.level ?? 0) === 0;
  const scalePart = roll.scaleDice ? (isCantrip ? ' (cantrip scale)' : ` (+${roll.scaleDice}/lvl)`) : '';
  const instancesPart = roll.instanceScaling === 'cantrip'
    ? ' ×1–4'
    : roll.instances && roll.instances > 1
      ? ` ×${roll.instances}${roll.scaleInstances ? ` (+${roll.scaleInstances}/lvl)` : ''}`
      : '';
  const dmgType = roll.damageType && roll.damageType !== 'healing'
    ? ` ${roll.damageType}`
    : roll.damageTypeChoices?.length
      ? ' choice type'
      : '';
  const explicitSingle = ability.roll?.targetMode === 'single';
  const area = explicitSingle ? undefined : spellAreaFor(effective);
  const upcastTargets = !explicitSingle && !roll.targetMode && UPCAST_EXTRA_TARGET_SPELLS.has(key);
  const customSummary = formatCustomEffectSummary(roll.customEffect);
  const customTargetCount = roll.maxTargets !== undefined || roll.scaleTargets !== undefined
    ? `${roll.maxTargets ?? 1} target${(roll.maxTargets ?? 1) === 1 ? '' : 's'}${roll.scaleTargets ? ` (+${roll.scaleTargets}/lvl)` : ''}`
    : undefined;
  const targetPart = roll.customEffect?.target === 'self'
    ? 'self'
    : area
      ? formatArea(area)
      : customTargetCount
        ? (roll.customEffect?.target === 'ally' ? customTargetCount.replace(/target/, 'ally') : customTargetCount)
        : roll.kind === 'heal'
          ? roll.healTarget === 'self'
            ? 'self'
            : roll.targetMode === 'multiple'
              ? 'multi-target'
              : '1 ally'
          : (roll.instances && roll.instances > 1) || roll.instanceScaling === 'cantrip' || roll.targetMode === 'multiple'
            ? 'multi-target'
            : upcastTargets
              ? '1 target (+1/lvl)'
              : '1 target';
  const effectSuffix = customSummary ? ` · ${customSummary}` : '';

  if (roll.kind === 'attack') {
    const mod = roll.damageBonus === 'spellcasting' ? '+mod' : '';
    const rangeTag = roll.attackRange === 'melee' ? 'Melee attack' : roll.attackRange === 'ranged' ? 'Ranged attack' : 'Attack';
    const body = hasDice ? `${dice}${mod}${scalePart}${dmgType}${instancesPart}` : 'no dmg';
    return { text: `${rangeTag} · ${body}${effectSuffix} · ${targetPart}`, needsEdit: !hasDice && !customSummary };
  }
  if (roll.kind === 'save') {
    const saveName = `${(roll.save ?? 'DEX').toUpperCase()}${roll.dc ? ` DC ${roll.dc}` : ''} save`;
    if (!hasDice) return { text: `${saveName} · ${customSummary || 'no dmg'} · ${targetPart}`, needsEdit: false };
    const onSave = (roll.saveDamage ?? 'half') === 'half' ? ' (half)' : ' (negates)';
    return { text: `${saveName}${onSave} · ${dice}${scalePart}${dmgType}${instancesPart}${effectSuffix} · ${targetPart}`, needsEdit: false };
  }
  if (roll.kind === 'heal') {
    if (!hasDice) {
      if (customSummary) return { text: `Effect · ${customSummary} · ${targetPart}`, needsEdit: false };
      return { text: `No roll · ${targetPart}`, needsEdit: true };
    }
    const prefix = roll.healingMode === 'temporary' ? 'Temp HP' : 'Heal';
    const mod = roll.healingMode === 'temporary' || roll.healingBonus === 'none'
      ? ''
      : roll.healingBonus === 'fighterLevel'
        ? '+lvl'
        : '+mod';
    const scale = roll.scaleDice ? ` (+${roll.scaleDice}/lvl)` : '';
    return { text: `${prefix} ${dice}${mod}${scale}${effectSuffix} · ${targetPart}`, needsEdit: false };
  }
  if (!hasDice) {
    if (customSummary) return { text: `${customSummary} · ${targetPart}`, needsEdit: false };
    return { text: area ? `No roll · ${formatArea(area)}` : 'No roll · cast only', needsEdit: true };
  }
  return { text: `Damage · ${dice}${scalePart}${dmgType}${instancesPart}${effectSuffix} · ${targetPart}`, needsEdit: false };
}
