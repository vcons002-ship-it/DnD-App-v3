# Performance Benchmark Comparison: `DnD-App-v2` vs. `DnD-App-v3`

Generated: `2026-11-02`
Reproduce with:
```powershell
node --import tsx scripts/performance/benchmark-v2-vs-v3.mts
```
Raw JSON output: [v2-vs-v3-benchmark-2026-11-02.json](v2-vs-v3-benchmark-2026-11-02.json)

---

## 1. State Normalization & Subscriber Isolation
**Workload**: 500 single-token movement ticks on a dungeon map with 60 tokens, 64 walls, 16 lights, and 68 subscribed UI/canvas nodes.

| Metric | `DnD-App-v2` (Monolithic Context) | `DnD-App-v3` (Normalized Store + `Object.is` Selectors) | Improvement |
| --- | ---: | ---: | ---: |
| Total CPU Time (500 ticks) | `33.373 ms` | `7.367 ms` | **4.54x faster** |
| Mean Tick Time | `0.0667 ms` | `0.0147 ms` | **4.54x faster** |
| p95 Tick Time | `0.1035 ms` | `0.0200 ms` | **5.18x faster** |
| p99 Tick Time | `0.2081 ms` | `0.0665 ms` | **3.13x faster** |
| Subscriber Re-evaluations | `34,000` (`68.0` / tick) | `971` (`1.94` / tick) | **97.14% fewer re-renders** |

---

## 2. 2D Vision & Wall Shadow Pass Computation
**Workload**: 160 frames across 4 party origins + 6 stationary light sources (`10` sight/light sources total), alternating token movement and camera/idle ticks across 48, 128, and 256 wall segments.

| Wall Count | `v2` CPU Raycast Polygon (`wallVisibilityPolygon`) Mean / p95 | `v3` GPU 2D Shadow-Volume Stencil Pass (`createGpu2dVisionPass`) Mean / p95 | Wall Buffer Uploads | Stencil Cache Hits | Main-Thread Speedup |
| ---: | ---: | ---: | ---: | ---: | ---: |
| **48 walls** | `2.3175 ms` / `3.2936 ms` | `0.0204 ms` / `0.0960 ms` | `1` | `80 / 160` | **113.6x faster** |
| **128 walls** | `2.5486 ms` / `3.0264 ms` | `0.0116 ms` / `0.0267 ms` | `1` | `80 / 160` | **219.7x faster** |
| **256 walls** | `2.5574 ms` / `2.8393 ms` | `0.0148 ms` / `0.0328 ms` | `1` | `80 / 160` | **172.8x faster** |

---

## 3. Idle Tabletop Frame Budget & Event Burst Coalescing
**Workload**: 10-second idle tabletop period followed by a 200-event (`tokenMove` + `vision`) burst within a single `16.67 ms` animation frame.

| Metric | `DnD-App-v2` (Continuous Loop) | `DnD-App-v3` (`frameloop="demand"`) | Improvement |
| --- | ---: | ---: | ---: |
| Idle Frame Rate | `12–30 FPS` (`~20 FPS` avg) | **`0 FPS`** | **100% idle GPU/CPU savings** |
| Frames Rendered over 10s Idle | `~200 frames` | **`0 frames`** | **`-200` unnecessary frames** |
| RAFs Scheduled for 200-Event Burst | Uncoalesced per-listener updates | **`1 RAF` (`1 frame`)** | **200:1 burst coalescing** |

---

## 4. Declarative Combat Rule Pipeline (`evaluateAttackContext`)
**Workload**: 5,000 full 5e attack evaluations with attacker/target conditions (`Invisible`, `Poisoned`, `Prone`, `Stunned`), cover grades (`half` / `none`), illumination (`darkness` / `bright`), and priority-ordered declarative modifiers (`10 -> 20 -> 30 -> 40`).

| Metric | Value |
| --- | ---: |
| Iterations | `5,000` |
| Total Time | `7.733 ms` |
| Mean Evaluation Time | **`0.0015 ms` (`1.50 µs`)** |
| p95 Evaluation Time | `0.0024 ms` (`2.40 µs`) |
| p99 Evaluation Time | `0.0059 ms` (`5.90 µs`) |
