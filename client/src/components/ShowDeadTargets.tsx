import {useStore} from '../state/socket';

/** One viewer-local choice shared by attack, spell, heal and stance lists. */
export function ShowDeadTargets() {
  const show = useStore(s => s.showDeadTargets);
  const change = useStore(s => s.setShowDeadTargets);
  return <label className="muted spell-tag" style={{display:'inline-flex',alignItems:'center',gap:4}}>
    <input type="checkbox" checked={show} onChange={event => change(event.target.checked)}/> Show Dead
  </label>;
}

export function ShowHealEnemies() {
  const show = useStore(s => s.showHealEnemies);
  const change = useStore(s => s.setShowHealEnemies);
  return <label className="muted spell-tag" style={{display:'inline-flex',alignItems:'center',gap:4}} title="Include enemy creatures in the heal target list">
    <input type="checkbox" checked={show} onChange={event => change(event.target.checked)}/> Show Enemies
  </label>;
}
