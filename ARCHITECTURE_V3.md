# DnD-App-v3 — Architecture & Modernization Blueprint

`DnD-App-v3` is the next-generation evolution of `DnD-App-v2`, preserving 100% of `v2`'s visual identity, D&D 5e rules, 3D miniature & dice catalogs, and DM/Player UX while replacing the multi-engine rendering and monolithic state bottlenecks with a unified, hardware-scalable architecture.

---

## Core Design Goals

1. **Runs Effortlessly on Old Laptops (`Integrated / Laptop Mode`)**
   - Single-framebuffer viewport rendering with **on-demand frame scheduling (`frameloop="demand"`)** — `0 FPS` / `0% GPU` when the tabletop is idle (`client/src/canvas/demandFrameScheduler.ts`).
   - Hardware 2D shadow-fan / stencil visibility (`< 0.2 ms` on integrated Intel HD/UHD GPUs) replacing CPU polygon boolean clipping (`Clipper`), SVG path string DOM serialization, and per-frame offscreen canvas texture uploads (`shared/visionStencilGeometry.ts`, `client/src/canvas/gpu2dVisionPass.ts`).
   - Automatic VRAM & asset budget tiering: integrated GPUs use crisp 2D token sprites or decimated (`<= 5k` triangle) meshes and capped texture atlases (`<= 2048×2048`), with built-in `webglcontextlost` / `webglcontextrestored` recovery (`shared/graphicsQuality.ts`, `shared/webglRecoveryState.ts`, `client/src/canvas/webglContextRecovery.ts`).
2. **Scales Up to High-End Gaming PCs (`Ultra Tabletop Mode`)**
   - Full 3D `.glb` hero and monster miniatures, dynamic point-light shadows, atmospheric mist shaders, and physics-driven 3D dice in the same unified scene coordinates (`client/src/canvas/MiniatureLayer.tsx`).
3. **Fine-Grained Reactive State & Typed Action Bus**
   - Normalized Zustand entity stores (`shared/gameStoreNormalizer.ts`, `client/src/store/useGameStore.ts`) keyed by entity ID (`tokensById`, `creaturesById`, `doorsById`, `lightsById`, `wallsById`, `pingsById`, `spellEffectsById`, `combatState`, `initiativeOrder`, `mapVisionById`) so moving a single token only re-renders that token's subscriber—never the entire React tree.
   - Versioned, deterministic action patches (`{ seq, domain, action, patch, timestamp }`) over Socket.IO (`server/src/routers/actionBus.ts`) backed by SQLite (`server/data/game.db`).
4. **Declarative Rule & Condition Engine**
   - Shared `RuleModifier` / `evaluateAttackContext` pipeline across `shared/ruleModifiers.ts`, `shared/conditionEffects.ts`, and `server/src/combat.ts` so every condition, stance, weapon mastery, cover grade, and lighting rule automatically powers pre-roll UI badges, live dice prompts, and server combat logs from one source of truth.

---

## 4-Phase Implementation Status (Completed)

### Phase 1 — Normalized Client Store & Fine-Grained Selectors ✅
- Implemented normalized Zustand store (`client/src/store/useGameStore.ts` & `shared/gameStoreNormalizer.ts`) keyed by entity ID (`creaturesById`, `charactersById`, `monstersById`, `tokensById`, `mapsById`, `doorsById`, `lightsById`, `wallsById`, `pingsById`, `spellEffectsById`) plus per-map vision/fog state (`sharedPartyVision`, `explorationMode`, `mapVisionEnabled`, `tokenVisionEnabled`).
- Bridged incoming Socket.IO `state` and `stateDelta` frames in `client/src/state/socket.ts` into atomic store updates so React HUD panels (`TopToolbar`, `PlayerRoute`, `DmRoute`, and the bottom-left compact `CarriedLanternControl`) subscribe only to the exact slices they display.
- Decomposed server action handling into modular domain routers (`server/src/routers/movementRouter.ts`, `combatRouter.ts`, `mapAuthoringRouter.ts`, `libraryRouter.ts`, `actionBus.ts`), including `fog:setPartyVision` and per-character vs. shared party exploration memory isolation.

### Phase 2 — Unified Single-Pass Viewport & GPU 2D Shadow Visibility ✅
- Implemented GPU 2D wall-segment & closed-door shadow/stencil visibility (`shared/visionStencilGeometry.ts`, `client/src/canvas/gpu2dVisionPass.ts`) and on-demand frame scheduling (`client/src/canvas/demandFrameScheduler.ts`):
  - Wall & closed-door segments upload as a compact vertex buffer only when map geometry changes.
  - Token vision (darkvision, devil's sight, blindsight, truesight), per-map party vs. personal vision (`sharedPartyVision` & single-PC vision cache reuse), and point lights render in a fast 2D pass with zero main-thread stalls.
  - Strict layer ordering (`VIEWPORT_LAYER_Z_INDEX`) guarantees `ManualFog` and map decals (`mapImages`) always composite above local darkvision/lit-color grading across all hardware tiers.
- Added lightweight GPU-transformed (`translate3d`) HTML token HUD overlay (`shared/tokenHudProjection.ts`, `client/src/canvas/TokenHtmlHudOverlay.tsx`) wired into `client/src/canvas/MapStage.tsx`.

### Phase 3 — Automatic Hardware Tiering & Context Recovery ✅
- Unified the startup hardware benchmark (`classifyHardwareBenchmark` & `graphicsBudget` in `shared/graphicsQuality.ts`) with strict per-tier budgets:
  - **Tier 1 (`Laptop / Battery Saver`)**: On-demand rendering (`frameloop: 'demand'`), 2D token coins / decimated (`<= 5k` triangle) meshes, stencil vision (`stencil2d`), capped `2048px` map texture resolution.
  - **Tier 2 (`Balanced`)**: 3D battlefield LOD miniatures (`<= 25k` triangles), dynamic vision & lighting (`dynamic2d`), 60 FPS during active movement/dice rolls.
  - **Tier 3 (`Ultra`)**: High-detail hero meshes (`<= 100k` triangles), soft point-light shadows (`ultra3d`), animated spell shaders, and full 3D dice physics.
- Added automatic `webglcontextlost` / `webglcontextrestored` recovery (`shared/webglRecoveryState.ts`, `client/src/canvas/webglContextRecovery.ts`, `client/src/canvas/MiniatureLayer.tsx`) so laptop sleep/wake cycles never blank the tabletop.

### Phase 4 — Declarative Combat Pipeline & Undo/Replay Journal ✅
- Expanded `shared/conditionEffects.ts` and `shared/ruleModifiers.ts` into a declarative `RuleModifier` registry covering conditions, stances, cover (`none` / `half` / `three-quarters` / `total`), illumination (`bright` / `dim` / `darkness` / `magical-darkness` + darkvision/devil's sight/blindsight/truesight), and class features (`Pack Tactics`).
- Persisted structured combat & movement events in SQLite (`server/src/eventJournal.ts`) to support instant multi-step DM undo/redo (`undoJournalEvent`, `redoJournalEvent`) and combat round replay (`replayCombatRound`).
