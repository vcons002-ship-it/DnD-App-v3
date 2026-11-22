import { useEffect, useState } from 'react';
import { spellAreaFor } from '../../../shared/spellAreas';
import {
  effectiveSheetAbility,
  isMultiTargetSpell,
  spellDamageTypeChoices,
  spellInstanceCount,
  spellMaxTargets,
} from '../../../shared/spellExecution';
import { useStore } from '../state/socket';
import './chromatic-orb.css';

/** One-click prompt for free weapon-triggered spells that need area placement, ray targets, or element choice. */
export function TriggeredSpellPrompt() {
  const snapshot = useStore((s) => s.snapshot);
  const rollFx = useStore((s) => s.rollFx);
  const liveDice = useStore((s) => s.liveDice);
  const combatTriggeredSpell = useStore((s) => s.combatTriggeredSpell);
  const startAreaCast = useStore((s) => s.startAreaCast);
  const startRayCast = useStore((s) => s.startRayCast);
  const [dmgChoice, setDmgChoice] = useState<string>('');

  const match = (() => {
    const rolls = [...(snapshot?.rollLog ?? [])].reverse();
    for (const r of rolls) {
      if (r.pending && !r.pending.done) continue;
      const offer = (r.triggeredSpells ?? []).find(
        (o) =>
          !o.used &&
          !o.dismissed &&
          (snapshot?.role !== 'dm' || r.roller === 'DM' || o.attacker.kind === 'monster'),
      );
      if (offer) return { entry: r, offer };
    }
    return null;
  })();

  const ready = !!match && (!rollFx || !!rollFx.impactReady) && !liveDice;
  const offer = match?.offer;
  const damageChoices = offer ? spellDamageTypeChoices(offer.ability, offer.castLevel) : [];

  useEffect(() => {
    if (!offer) {
      setDmgChoice('');
      return;
    }
    const choices = spellDamageTypeChoices(offer.ability, offer.castLevel);
    setDmgChoice(offer.damageType ?? choices[0] ?? '');
  }, [offer?.id]);

  if (!ready || !snapshot || !match || !offer) return null;
  const { entry } = match;
  const selectedDmg = offer.damageType ?? (damageChoices.length ? (dmgChoice || damageChoices[0]) : undefined);
  const areaSpec = spellAreaFor(offer.ability, offer.castLevel);
  const multiTarget = !areaSpec && isMultiTargetSpell(offer.ability, offer.castLevel);
  const levelLabel = offer.castLevel && offer.castLevel > 0 ? `Level ${offer.castLevel}` : (offer.ability.level === 0 ? 'Cantrip' : '');

  const handleCast = () => {
    if (rollFx?.impactReady) useStore.getState().dismissRollFx();
    if (areaSpec) {
      startAreaCast({
        name: offer.ability.name,
        spec: areaSpec,
        payload: {
          kind: offer.attacker.kind,
          refId: offer.attacker.refId,
          abilityId: offer.ability.id,
          castLevel: offer.castLevel,
          ...(selectedDmg ? { damageType: selectedDmg } : {}),
        },
        triggeredSpell: { rollId: entry.id, offerId: offer.id, ...(selectedDmg ? { damageType: selectedDmg } : {}) },
      });
      return;
    }
    if (multiTarget) {
      const exec = effectiveSheetAbility(offer.ability, offer.castLevel);
      const caster = offer.attacker.kind === 'pc'
        ? snapshot.characters.find((c) => c.id === offer.attacker.refId)
        : snapshot.monsters.find((m) => m.id === offer.attacker.refId);
      const casterLevel = caster && 'level' in caster ? caster.level : undefined;
      const instances = Math.max(
        1,
        (exec.roll ? spellInstanceCount(exec.roll, offer.castLevel, casterLevel) : 0) ||
          (exec.roll ? spellMaxTargets(exec.roll, offer.castLevel, offer.ability.level) : undefined) ||
          2,
      );
      const distinct = exec.roll?.kind !== 'attack' && exec.roll?.kind !== 'damage';
      const rangeMatch = /\b(\d+)\s*(?:ft|feet)\b/i.exec(offer.ability.meta ?? '') ??
        /\b(\d+)\s*(?:ft|feet)\b/i.exec(offer.ability.description ?? '');
      startRayCast({
        name: offer.ability.name,
        instances,
        minTargets: distinct ? 1 : instances,
        distinct,
        allowSelf: exec.roll?.kind === 'heal',
        rangeFt: rangeMatch ? Number(rangeMatch[1]) : 120,
        kind: exec.roll?.kind === 'attack' ? 'rays' : exec.roll?.kind === 'damage' ? 'missiles' : 'targets',
        damageType: selectedDmg ?? exec.roll?.damageType,
        payload: {
          kind: offer.attacker.kind,
          refId: offer.attacker.refId,
          abilityId: offer.ability.id,
          castLevel: offer.castLevel,
          ...(selectedDmg ? { damageType: selectedDmg } : {}),
        },
        triggeredSpell: { rollId: entry.id, offerId: offer.id, ...(selectedDmg ? { damageType: selectedDmg } : {}) },
      });
      return;
    }
    combatTriggeredSpell({
      rollId: entry.id,
      offerId: offer.id,
      targetTokenId: offer.targetMode === 'self' ? offer.attacker.tokenId : offer.target.tokenId,
      ...(selectedDmg ? { damageType: selectedDmg } : {}),
    });
  };

  return (
    <section className="orb-prompt" aria-label="Triggered weapon spell" aria-live="polite">
      <strong>
        {offer.sourceName} · {offer.ability.name}
      </strong>
      <p>
        Triggered by {offer.weaponName}
        {levelLabel ? ` · ${levelLabel}` : ''} · Free cast · no spell slot
      </p>
      {damageChoices.length > 0 && !offer.damageType && (
        <label style={{ display: 'block', fontSize: 13, marginBottom: 10 }}>
          Element{' '}
          <select value={dmgChoice} onChange={(e) => setDmgChoice(e.target.value)}>
            {damageChoices.map((dt) => (
              <option key={dt} value={dt}>
                {dt}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="orb-targets">
        <button type="button" className="btn" onClick={handleCast}>
          {areaSpec ? `Place ${offer.ability.name}` : multiTarget ? `Aim ${offer.ability.name}` : `Cast ${offer.ability.name}`}
        </button>
      </div>
      <button
        type="button"
        className="btn orb-end"
        onClick={() => combatTriggeredSpell({ rollId: entry.id, offerId: offer.id, dismiss: true })}
      >
        Skip
      </button>
    </section>
  );
}
