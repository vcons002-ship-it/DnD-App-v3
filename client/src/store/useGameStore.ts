import { create } from 'zustand';
import type { StateSnapshot, Token } from '../../../shared/types';
import {
  createEmptyNormalizedGameState,
  normalizeSnapshot,
  type NormalizedCombatState,
  type NormalizedCreature,
  type NormalizedDoor,
  type NormalizedGameState,
  type NormalizedLight,
  type NormalizedMapVision,
  type NormalizedWall,
} from '../../../shared/gameStoreNormalizer';

export type GameStore = NormalizedGameState & {
  /** Apply a full or delta-stabilized snapshot into the normalized entity store. */
  applySnapshot: (snapshot: StateSnapshot, seq?: number) => void;
  /** Reset the normalized store when leaving a session. */
  reset: () => void;
};

export const useGameStore = create<GameStore>((set) => ({
  ...createEmptyNormalizedGameState(),
  applySnapshot: (snapshot, seq) =>
    set((prev) => ({
      ...normalizeSnapshot(prev, snapshot, seq),
      applySnapshot: prev.applySnapshot,
      reset: prev.reset,
    })),
  reset: () =>
    set((prev) => ({
      ...createEmptyNormalizedGameState(),
      applySnapshot: prev.applySnapshot,
      reset: prev.reset,
    })),
}));

/** Subscribe to whether a session snapshot is loaded without re-rendering on entity updates. */
export const useHasSnapshot = (): boolean => useGameStore((s) => s.hasSnapshot);

/** Subscribe to a single token by ID (only re-renders when that specific token changes). */
export const useToken = (tokenId: string | null | undefined): Token | undefined =>
  useGameStore((s) => (tokenId ? s.tokensById[tokenId] : undefined));

/** Subscribe to a single creature (character or monster) by ID. */
export const useCreature = (creatureId: string | null | undefined): NormalizedCreature | undefined =>
  useGameStore((s) => (creatureId ? s.creaturesById[creatureId] : undefined));

/** Subscribe to a single door by ID. */
export const useDoor = (doorId: string | null | undefined): NormalizedDoor | undefined =>
  useGameStore((s) => (doorId ? s.doorsById[doorId] : undefined));

/** Subscribe to a single point light by ID. */
export const useLight = (lightId: string | null | undefined): NormalizedLight | undefined =>
  useGameStore((s) => (lightId ? s.lightsById[lightId] : undefined));

/** Subscribe to a single wall segment/polyline by ID. */
export const useWall = (wallId: string | null | undefined): NormalizedWall | undefined =>
  useGameStore((s) => (wallId ? s.wallsById[wallId] : undefined));

/** Subscribe to combat round & active turn state. */
export const useCombatState = (): NormalizedCombatState =>
  useGameStore((s) => s.combatState);

/** Subscribe to the ordered list of combatant token IDs in initiative order. */
export const useInitiativeOrder = (): string[] =>
  useGameStore((s) => s.initiativeOrder);

/** Subscribe to per-map vision & fog configuration (including `sharedPartyVision`). */
export const useMapVision = (mapId: string | null | undefined): NormalizedMapVision | undefined =>
  useGameStore((s) => (mapId ? s.mapVisionById[mapId] : undefined));
