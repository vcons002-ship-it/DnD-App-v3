# DnD-App-v3 — Architecture & Modernization Blueprint

`DnD-App-v3` is the next-generation evolution of `DnD-App-v2`, preserving 100% of `v2`'s visual identity, D&D 5e rules, 3D miniature & dice catalogs, and DM/Player UX while replacing the multi-engine rendering and monolithic state bottlenecks with a unified, hardware-scalable architecture.

---

## Core Design Goals

1. **Runs Effortlessly on Old Laptops (`Integrated / Laptop Mode`)**
   - Single-framebuffer viewport rendering with **on-demand frame scheduling (`frameloop="demand"`)** — `0 FPS` / `0% GPU` when the tabletop is idle.
   - Hardware 2D shadow-fan / stencil visibility (`< 0.2 ms` on integrated Intel HD/UHD GPUs) replacing CPU polygon boolean clipping (`Clipper`), SVG path string DOM serialization, and per-frame offscreen canvas texture uploads.
   - Automatic VRAM & asset budget tiering: integrated GPUs use crisp 2D token sprites or decimated (`< 5k` triangle) meshes and capped texture atlases (`<= 2048×2048`), with built-in `webglcontextlost` / `webglcontextrestored` recovery.
2. **Scales Up to High-End Gaming PCs (`Ultra Tabletop Mode`)**
   - Full 3D `.glb` hero and monster miniatures, dynamic point-light shadows, atmospheric mist shaders, and physics-driven 3D dice in the same unified scene coordinates.
3. **Fine-Grained Reactive State & Typed Action Bus**
   - Normalized Zustand entity stores (`tokensById`, `doorsById`, `lightsById`, `wallsById`, `combatState`, `initiativeOrder`) so moving a single token only re-renders that token's subscriber—never the entire React tree.
   - Versioned, deterministic action patches (`{ seq, action, patch }`) over Socket.IO backed by SQLite (`server/data/game.db`).
4. **Declarative Rule & Condition Engine**
   - Shared `RuleModifier` / `evaluateAttackContext` pipeline across `shared/` and `server/` so every condition, stance, weapon mastery, cover grade, and lighting rule automatically powers pre-roll UI badges, live dice prompts, and server combat logs from one source of truth.

---

## 4-Phase Implementation Roadmap

### Phase 1 — Normalized Client Store & Fine-Grained Selectors
- Introduce normalized Zustand stores (`client/src/store/useGameStore.ts`) keyed by entity ID (`creaturesById`, `doorsById`, `lightsById`, `pingsById`, `SpellEffectsById`).
- Bridge incoming Socket.IO `state` and `stateDelta` frames into atomic store updates so React HUD panels (`TopToolbar`, `PlayerRoute`, `DmRoute`, `InitiativeStrip`) subscribe only to the exact slices they display.
- Decompose `server/src/socketHandlers.ts` and `server/src/sessions.ts` into domain routers (`movementRouter`, `combatRouter`, `mapAuthoringRouter`, `libraryRouter`).

### Phase 2 — Unified Single-Pass Viewport & GPU 2D Shadow Visibility
- Consolidate the stacked Konva `<canvas>` layers, `PlayerVisionOverlay` SVG DOM paths, and auxiliary WebGL overlays into a unified, single-camera scene graph.
- Replace CPU polygon-union fog/vision masks with a GPU 2D wall-segment shadow/stencil pass:
  - Wall & closed-door segments upload as a compact vertex buffer only when map geometry changes.
  - Token vision (darkvision, devil's sight, blindsight, truesight) and point lights render directly in a fast 2D fragment/stencil pass during movement and camera zoom with zero main-thread stalls.
- Render crisp token HUD pills (HP bars, death-save pips, condition badges, measurement readouts) in a lightweight GPU-transformed (`translate3d`) HTML overlay layer.

### Phase 3 — Automatic Hardware Tiering & Context Recovery
- Unify the startup hardware benchmark with strict per-tier budgets:
  - **Tier 1 (`Laptop / Battery Saver`)**: On-demand rendering, 2D token coins / baked miniature sprites, stencil vision, capped `2048px` map texture resolution.
  - **Tier 2 (`Balanced`)**: 3D battlefield LOD miniatures, dynamic vision & lighting, 60 FPS during active movement/dice rolls.
  - **Tier 3 (`Ultra`)**: High-detail hero meshes, soft point-light shadows, animated spell shaders, and full 3D dice physics.
- Add automatic `webglcontextlost` / `webglcontextrestored` recovery so laptop sleep/wake cycles never blank the tabletop.

### Phase 4 — Declarative Combat Pipeline & Undo/Replay Journal
- Expand `shared/src/conditionEffects.ts` and `server/src/combat*.ts` into a declarative `RuleModifier` registry covering conditions, stances, cover, illumination, and class features.
- Persist structured combat & movement events in SQLite (`game.db`) to support instant multi-step DM undo/redo and combat round replay.
