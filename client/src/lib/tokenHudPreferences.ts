import { useCallback, useEffect, useState } from 'react';
import { getPlayerId } from '../state/socket';
import { safeSetItem } from './storage';
import type { TokenHpDisplay, TokenLabelDensity } from './tokenCrowdLayout';

export type { TokenHpDisplay, TokenLabelDensity };

const TOKEN_HUD_PREFS_EVENT = 'dnd:token-hud-prefs';

function readLabelDensity(key: string): TokenLabelDensity {
  try {
    const raw = localStorage.getItem(key);
    if (raw === 'full' || raw === 'minimal' || raw === 'smart') return raw;
  } catch {
    /* ignore storage errors */
  }
  return 'smart';
}

function readHpDisplay(key: string): TokenHpDisplay {
  try {
    const raw = localStorage.getItem(key);
    if (raw === 'bar' || raw === 'arc') return raw;
  } catch {
    /* ignore storage errors */
  }
  return 'arc';
}

export function setTokenHudPreferences(patch: {
  labelDensity?: TokenLabelDensity;
  hpDisplay?: TokenHpDisplay;
}) {
  const playerId = getPlayerId();
  if (patch.labelDensity) safeSetItem(`dnd.tokenLabelDensity:${playerId}`, patch.labelDensity);
  if (patch.hpDisplay) safeSetItem(`dnd.tokenHpDisplay:${playerId}`, patch.hpDisplay);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(TOKEN_HUD_PREFS_EVENT));
  }
}

export function useTokenHudPreferences() {
  const playerId = getPlayerId();
  const densityKey = `dnd.tokenLabelDensity:${playerId}`;
  const hpKey = `dnd.tokenHpDisplay:${playerId}`;

  const [labelDensity, setDensityState] = useState<TokenLabelDensity>(() => readLabelDensity(densityKey));
  const [hpDisplay, setHpState] = useState<TokenHpDisplay>(() => readHpDisplay(hpKey));

  useEffect(() => {
    const sync = () => {
      setDensityState(readLabelDensity(densityKey));
      setHpState(readHpDisplay(hpKey));
    };
    window.addEventListener(TOKEN_HUD_PREFS_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(TOKEN_HUD_PREFS_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, [densityKey, hpKey]);

  const setLabelDensity = useCallback(
    (next: TokenLabelDensity) => {
      safeSetItem(densityKey, next);
      setDensityState(next);
      window.dispatchEvent(new Event(TOKEN_HUD_PREFS_EVENT));
    },
    [densityKey],
  );

  const setHpDisplay = useCallback(
    (next: TokenHpDisplay) => {
      safeSetItem(hpKey, next);
      setHpState(next);
      window.dispatchEvent(new Event(TOKEN_HUD_PREFS_EVENT));
    },
    [hpKey],
  );

  return { labelDensity, hpDisplay, setLabelDensity, setHpDisplay };
}
