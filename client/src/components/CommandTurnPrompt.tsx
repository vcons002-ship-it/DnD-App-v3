import {useRef,useState} from 'react';
import {commandInstruction,isStandardCommand} from '../../../shared/commandSpell';
import {useStore} from '../state/socket';

export function CommandTurnPrompt(){
  const snapshot=useStore(s=>s.snapshot),socket=useStore(s=>s.socket),busy=useStore(s=>!!s.liveDice||!!s.rollFx);
  if(!snapshot||busy)return null;
  const token=snapshot.tokens.find(t=>t.id===snapshot.activeTurnTokenId);
  const e=token&&(token.kind==='pc'?snapshot.characters.find(c=>c.id===token.refId):snapshot.monsters.find(m=>m.id===token.refId));
  const c=e?.conditions.find(c=>c.combatEffect?.spell==='Command'&&c.combatEffect.commandStarted&&!c.combatEffect.commandResolved);
  if(!token||!e||!c||snapshot.role!=='dm'&&(token.kind!=='pc'||!('claimedBy'in e)||e.claimedBy!==socket?.id))return null;
  const word=c.combatEffect!.commandWord!,custom=!isStandardCommand(word);
  return <div className="riposte-prompt" role="region" aria-label="Command turn reminder">
    <strong>{e.name} · Command: {word}</strong><span>{commandInstruction(word)}</span>
    <small>Ends after this turn. {custom?'Custom command: DM adjudication.':'Resolve this instruction, then end the turn.'}</small>
    {(!custom||snapshot.role==='dm')&&<button className="btn" onClick={()=>socket?.emit('spell:commandResolve',{kind:token.kind,refId:token.refId,conditionId:c.id})}>Mark command resolved</button>}
  </div>;
}

export function DeathSaveTurnPrompt(){
  const snapshot=useStore(s=>s.snapshot),socket=useStore(s=>s.socket),busy=useStore(s=>!!s.liveDice||!!s.rollFx);
  const rollDeathSave=useStore(s=>s.rollDeathSave);
  const [dismissedKey,setDismissedKey]=useState<string|null>(null);
  const baseline=useRef<{key:string;s:number;f:number}|null>(null);
  if(!snapshot||!snapshot.round)return null;
  const token=snapshot.tokens.find(t=>t.id===snapshot.activeTurnTokenId);
  const ch=token?.kind==='pc'?snapshot.characters.find(c=>c.id===token.refId):undefined;
  if(!token||!ch||ch.curHp>0||ch.deathSaves.successes>=3||ch.deathSaves.failures>=3)return null;
  if(snapshot.role!=='dm'&&ch.claimedBy!==socket?.id)return null;
  const turnKey=`${snapshot.sessionCode}:${snapshot.activeMapId}:${snapshot.round}:${snapshot.activeTurnTokenId}`;
  if(baseline.current?.key!==turnKey)baseline.current={key:turnKey,s:ch.deathSaves.successes,f:ch.deathSaves.failures};
  if(busy||dismissedKey===turnKey||ch.deathSaves.successes!==baseline.current.s||ch.deathSaves.failures!==baseline.current.f)return null;
  const pip=(n:number)=>'●'.repeat(n)+'○'.repeat(Math.max(0,3-n));
  return <div className="riposte-prompt death-save-turn-prompt" role="dialog" aria-label="Death saving throw">
    <strong>{ch.name} — Death Saving Throw</strong>
    <span>Your turn starts at 0 HP. Roll a d20 (10+ succeeds, 1 = 2 failures, 20 = regain 1 HP).</span>
    <small>Successes {pip(ch.deathSaves.successes)} · Failures {pip(ch.deathSaves.failures)}</small>
    <div>
      <button className="btn" onClick={()=>{setDismissedKey(turnKey);rollDeathSave(ch.id);}}>🎲 Roll death save</button>
      <button className="btn" onClick={()=>setDismissedKey(turnKey)}>Dismiss</button>
    </div>
  </div>;
}
