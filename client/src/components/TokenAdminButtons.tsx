import type { Token } from '../../../shared/types';
import { useStore } from '../state/socket';

/**
 * Shared DM token actions (duplicate / hide / hide role-badge / delete) with one
 * canonical set of handlers + labels, so the right-click FloatingMenu
 * (`variant="menu"`) and the right-side SelectedTokenPanel (`variant="panel"`)
 * can't drift. The role-badge toggle applies to `roleBadgeTargets` (defaults to
 * this token) so the panel can target a whole multi-selection. `onAfter` lets the
 * menu close itself after an action.
 */
export function TokenAdminButtons({
  token,
  variant,
  roleBadgeTargets,
  onAfter,
}: {
  token: Token;
  variant: 'menu' | 'panel';
  roleBadgeTargets?: string[];
  onAfter?: () => void;
}) {
  const duplicateToken = useStore((s) => s.duplicateToken);
  const setTokenHidden = useStore((s) => s.setTokenHidden);
  const setTokensHideCombatRole = useStore((s) => s.setTokensHideCombatRole);
  const deleteToken = useStore((s) => s.deleteToken);
  const speakAs = useStore((s) => s.speakAs);
  const teleportingTokenIds = useStore((s) => s.teleportingTokenIds);
  const setTeleportingTokens = useStore((s) => s.setTeleportingTokens);
  const menu = variant === 'menu';
  const run = (fn: () => void) => () => {
    fn();
    onAfter?.();
  };
  const badgeTargets = roleBadgeTargets ?? [token.id];
  const teleporting = teleportingTokenIds.includes(token.id);
  const cls = (active?: boolean, danger?: boolean) =>
    menu
      ? `floating-menu-item${danger ? ' danger' : ''}`
      : `btn${danger ? ' red delete-token' : ''}${active ? ' on' : ''}`;

  return (
    <>
      <button
        className={cls(teleporting)}
        onClick={run(() => setTeleportingTokens(teleporting ? [] : badgeTargets))}
        title="Place token at a new spot without exploring the path in between (or hold Alt while dragging)"
      >
        ✦ {teleporting ? 'Cancel teleport' : 'Teleport token'}
      </button>
      <button
        className={cls()}
        onClick={run(() => duplicateToken(token.id))}
        title="Drop an identical, independently-tracked copy of this token"
      >
        ⧉ Duplicate token
      </button>
      <button
        className={cls(token.isHidden)}
        onClick={run(() => setTokenHidden(token.id, !token.isHidden))}
        title="Hidden tokens are not shown to players"
      >
        {token.isHidden ? '🙈 Show to players' : 'Hide from players'}
      </button>
      <button
        className={cls(token.hideCombatRole)}
        onClick={run(() => setTokensHideCombatRole(badgeTargets, !token.hideCombatRole))}
        title="Hide the role badge from everyone"
      >
        {token.hideCombatRole ? '◎ Show role badge' : '◎ Hide role badge'}
      </button>
      {token.kind !== 'pc' && (
        <button
          className={cls()}
          onClick={run(() => speakAs(token.id))}
          title="Have this creature say an AI-generated line (floats over its token)"
        >
          💬 Speak (AI)
        </button>
      )}
      <button className={cls(false, true)} onClick={run(() => deleteToken(token.id))}>
        ✕ Delete token
      </button>
    </>
  );
}
