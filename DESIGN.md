# Planet Explorer — Design & Architecture

Developer reference for the procedural planet explorer. Covers architecture decisions, system internals, and implementation details. For a feature overview see [README.md](README.md).

---

## 1. Source layout

```
src/
├── main.ts               ← entry point, startup sequence, frame loop
├── core/
│   ├── config.ts         ← S (live settings) + CFG (engineering constants)
│   ├── noise.ts          ← CPU Perlin noise (shared permutation table with GPU)
│   ├── palette.ts        ← 13 Solar System planet palettes
│   ├── names.ts          ← pronounceable seed-word generator
│   ├── util.ts           ← general utilities (RNG, hashing)
│   └── utilgeo.ts        ← geometry math (smoothstep, frame, spherical helpers)
├── render/
│   ├── gputier.ts        ← GPU probe → high / medium / low tier
│   ├── fx.ts             ← shared GLSL uniforms, terrain/water shader helpers
│   ├── bake.ts           ← render-to-texture helpers (heights, normals, colours, scatter)
│   ├── terrain.ts        ← terrain ShaderMaterial and GLSL function
│   ├── treemat.ts        ← tree ShaderMaterial
│   ├── postfx.ts         ← EffectComposer chain + adaptive resolution
│   ├── aerialfx.ts       ← aerial haze post-pass
│   └── shadows.ts        ← sun / moon shadow rigs
├── world/
│   ├── planet.ts         ← coarse mesh, cube-map bake, river integration
│   ├── chunks.ts         ← streamed high-detail terrain chunks
│   ├── sky.ts            ← sun / moon cycle, weather state
│   ├── skyfx.ts          ← cloud shell shader
│   ├── night.ts          ← aurora, fireflies, bioluminescent motes, galactic band
│   ├── precip.ts         ← GPU rain / snow
│   ├── river.ts          ← valley tracing, meanders, tributaries, lakes, water shader
│   ├── forest.ts         ← tree placement + LOD
│   ├── trees.ts          ← procedural tree geometry
│   ├── treeutil.ts       ← tree geometry helpers
│   ├── geoutil.ts        ← shared procedural-geometry builders
│   ├── vegetation.ts     ← GPU instanced scatter (reads bake textures)
│   ├── plants.ts         ← 15-kind plant catalog with per-kind GLSL gates
│   ├── plantgeo.ts       ← foliage geometry (grass, flowers, shrubs, …)
│   ├── rockgeo.ts        ← rock / crystal geometry
│   ├── landmarks.ts      ← 8 procedural landmark types
│   ├── footprints.ts     ← snow footprint trail
│   ├── collision.ts      ← terrain + scatter collision
│   └── spots.ts          ← terrain beauty-spot scanner
├── player/
│   ├── player.ts         ← walk / drone / fly controller
│   └── touch.ts          ← virtual joystick + swipe-look
└── ui/
    ├── gui.ts            ← lil-gui settings panel + Locations panel
    └── map.ts            ← fullscreen equirectangular planet map
```

**Key architectural decisions:**

- **Shared terrain function.** `noise.ts` (CPU) and `terrain.ts` (GLSL) implement the same `e3()` domain-warped fBm using the same permutation table. Walking physics, collision, river tracing and GPU rendering all see the same world — no approximation seams.
- **Bake-once pattern.** Heavy GPU work (chunk heights/normals/colours, plant placement, planet cube maps) is rendered to textures on first need and sampled cheaply every frame thereafter.
- **GPU scatter.** Each plant LOD tier bakes a placement texture once; the vertex shader reads it and collapses rejected instances to a degenerate point. The CPU never touches per-instance data after bake.
- **Tier-first renderer setup.** GPU tier is detected before the `WebGLRenderer` is created, so `antialias`, pixel ratio and all quality knobs are correct from frame zero.

---

## 2. Startup sequence

```
main.ts (async IIFE):

1. GPU probe            (sync, before renderer creation)
2. Renderer + camera    (sync)
3. Step 1 – terrain     await planet.build()
   → fire: riversPromise = planet.buildRivers()   ← runs concurrently with step 4
   → fire: spotsPromise  = findSpots(planet, riversPromise)
4. Step 2 – world       await: player, sky, scatter, shadows, postFX …
5. Step 3 – scouting    await spotsPromise   (rivers + spot scan both land here)
6. Step 4 – shaders     await renderer.compileAsync(scene, camera)
7. Step 5 – warm-up     postFX.render(0)  — uploads geometry/textures + compiles composer passes
8. Start RAF loop       renderer.setAnimationLoop(…)
9. await one RAF        ensures first visible frame is rendered before splash shows
10. showSplash()
```

**Why this order:**

- Rivers and scouting start immediately after terrain because `findSpots` can scan terrain in parallel with river generation; it only awaits `riversPromise` at the very end to append river teleport entries.
- `compileAsync` is deferred until after all GPU baking. Baking and compiling both submit GPU work; running them together creates pipeline stalls on tiler GPUs.
- The warm-up calls `postFX.render(0)` rather than a direct `renderer.render()` into a 1×1 target. This pre-compiles all EffectComposer pass shaders (aerial / bloom / output) during the labelled loading step rather than lazily on the first visible frame. It also uploads all geometry and texture buffers to the GPU.
- The animation loop starts **before** the RAF yield. This guarantees the compositor has already been given a fully-rendered frame before the "Click to enter" button is shown, so clicking in is visually instant.

---

## 3. GPU tier detection (`render/gputier.ts`)

### Probe canvas

```ts
const probe = document.createElement("canvas");   // never appended to DOM
const ctxOpts = { powerPreference: "high-performance" };
const gl = probe.getContext("webgl2", ctxOpts) ?? probe.getContext("webgl", ctxOpts);
// … detect …
(gl.getExtension("WEBGL_lose_context"))?.loseContext();  // free context slot immediately
```

`powerPreference: "high-performance"` is passed so dual-GPU laptops probe the discrete GPU — matching what the main renderer will use. Browsers enforce a hard limit (~16) on live WebGL contexts; the probe is destroyed via `WEBGL_lose_context` immediately after detection.

### Renderer string matching

`WEBGL_debug_renderer_info` exposes the raw GPU renderer string (e.g. `"ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 Direct3D11 vs_5_0 ps_5_0, D3D11)"`). Tests run in order; the first match wins.

**Apple GPU (checked first):**
```
"apple gpu" in renderer string:
  no touch events           → M-series Mac           → high
  platform=MacIntel + maxTouchPoints > 1  → iPadOS 13+ (UA spoofed) → high
  otherwise (iPhone)        → medium
```
iPadOS 13+ defaults to "Request Desktop Website", so the UA reads `"Macintosh"`. `navigator.platform + maxTouchPoints` detects the spoof — Macs never have touch points.

**HIGH regex:**
```
rtx | rx [5-9]\d{3} | vega [5-9]\d | radeon vii | gtx 1[0-9]{3} | gtx 9[5-9]\d |
arc.{0,8}a[5-9]\d{2} | apple m\d+ | adreno.{0,8}(6[4-9]\d|7\d{2}|x\d) | xclipse
```
Covers: NVIDIA RTX / GTX 900–1000, AMD RX 5000–9000 (RDNA 1–3) / Vega / Radeon VII, Intel Arc A5xx/A7xx, Apple M-series, Adreno 640–7xx (Galaxy S20 Ultra – S24+, Pixel 5+), Xclipse 920 (Exynos S22 Ultra), Adreno X1-85 (Snapdragon X Elite Copilot+ laptops).

**MEDIUM overrides (checked before LOW catch-all, in order):**
```
mali[-\s]g7\d{2}(?!\d)   → Mali-G710/G715/G720 (Dimensity 9000+ high-end)
mali[-\s]g7[0-9](?!\d)   → Mali-G72 (Galaxy S9 / Note 8, 2017 flagship)
uhd.{0,12}6\d{2}         → Intel UHD 620/630 (2018–2021 laptops)
iris                      → Intel Iris Plus / Iris Xe (MacBook Air 2018–2020, 11th–13th gen)
adreno.{0,8}5[3-9]\d     → Adreno 530/540 (Snapdragon 820/835, Galaxy S7/S8 2016–2017)
```

**LOW catch-all:**
```
(uhd.{0,12}[2-5]\d{2}|hd graphics) | mali[-\s] | adreno.{0,8}[3-5]\d{2} |
videocore | powervr g[67] | sgx
```

**Fallback** (if `WEBGL_debug_renderer_info` is blocked — Firefox `resistFingerprinting`, privacy browsers):
```ts
return "ontouchstart" in window ? "low" : "high";
```
Touch = unknown mobile → conservative `low`. No touch = unknown desktop → optimistic `high`. This avoids penalising an iPad Pro or desktop browser that has privacy mode enabled.

### What each tier gates

| Feature | low | medium | high (mobile) | high (desktop) |
|---|---|---|---|---|
| Terrain resolution | 128 | 160 | 256 | 320 |
| Render scale | 0.60 | 0.75 | 2.0 (DPR cap) | 1.0 / 1.5 (Retina) |
| Terrain octaves | 4 | 5 | 6 | 6 |
| Camera far plane | 20 000 m | 30 000 m | 40 000 m | 40 000 m |
| MSAA samples | 0 | 2 | 4 | 4 |
| Shadow map size | 256 px | 512 px | 1024 px | 1024 px |
| Shadow Hz | 20 | 30 | 60 | 60 |
| Shadow frustum | 65% | 100% | 100% | 100% |
| Aerial haze pass | off | on | on | on |
| Bloom pass | off (skipped) | on | on | on |
| Footprints | off | on | on | on |
| Plant radius multiplier | 0.50 | 0.65 | 1.0 | 1.0 |
| Forest count multiplier | 0.30 | 0.55 | 0.80 | 0.80 |
| Nebula count | 0 | 9 | 14 | 14 |
| Firefly count | 50 | 120 | 220 | 220 |
| Bio-mote count | 12 | 28 | 50 | 50 |
| River meanders | off | on | on | on |
| Lake generation | off | on | on | on |

**Note on bloom:** On low tier the `UnrealBloomPass` is never added to the EffectComposer — `addPass` is skipped entirely, not just `bloom.enabled = false`. `UnrealBloomPass` allocates ~2.5 MB of HalfFloat render targets on construction; skipping `addPass` means those allocations never happen.

---

## 4. Terrain system (`render/terrain.ts`, `core/noise.ts`, `render/bake.ts`)

### Noise parity

`Noise3` (CPU, `core/noise.ts`) and `pn()` (GLSL, `render/terrain.ts`) use the same 512-entry permutation table. The table is uploaded as a `DataTexture` and sampled with `texelFetch`. Every shader that calls `pn()` produces bit-for-bit the same values as the CPU `Noise3.get()`, so walking physics, river tracing and GPU scatter all inhabit the same world.

### Terrain function `e3()`

Domain-warped fBm:
1. Sample three perpendicular noise calls to compute a warp offset (~25% of base frequency).
2. Shift the sample point by that offset.
3. Run standard fBm on the shifted point.

Without warping, Perlin fBm produces axis-aligned ridges. The warp makes terrain tilt, overhang and meander without smearing fine detail.

### Mountain ridges

Mountain contribution: `(1 - |fbm * 2|)²`

This maps smooth fBm zero-crossings into sharp ridge peaks. A low-frequency smooth mask (`sm_()`) confines ridges to designated mountain zones, leaving lowlands and ocean floors unaffected.

### `sm_()` — smoothstep as a biome tool

Rather than only using `smoothstep` for visual fades, the terrain function uses `sm_()` everywhere a continuous biome transition is needed: beach width, biome blending, underwater colour depth, mountain masking. Every boundary in the world is a gradient, not a threshold.

### `hs()` hash

Per-instance randoms in vegetation shaders:
```glsl
fract(dot(fract(vec3 * 0.1031), vec3(…)))
```
Two `fract` and one `dot` — no texture lookup, no integer trickery. Produces visually uncorrelated values per `(I, J, face)` grid cell.

### `basis()` — cube-face frame from a float

The GPU scatter system encodes cube face identity as a single float constant `uSC.z`. The vertex shader recovers face normal + two tangents via `fc / 2` and `fc % 2` integer decode. One consistent local frame per tile, no per-face branching in the draw call.

### Cube-map planet surface

The coarse planet mesh uses cube maps (512² per face, mipmapped) baked once from the full terrain function. The bake renders elevation/moisture, normals and biome colours to three separate render targets via `bakePoints()`, reading results back to the CPU for vertex attribute upload. This replaces an older per-vertex colour approach that produced a visible triangle grid and shimmer as the camera moved. The cube map matches the detail chunks at all altitudes because both sample the same `e3()` function.

Two bake passes run in parallel at the start of `planet.build()` — elevation/moisture (`mode 0`) and normals (`mode 3`) — since they are independent. The colour pass (`mode 4`) runs after, as it requires the normal readback as input.

---

## 5. River & lake generation (`world/river.ts`)

### Path tracing

`_tracePath()` runs a greedy gradient descent on the height field:
- At each step, sample 8 neighbours equally spaced around the current position.
- Pick the neighbour with the lowest elevation score. A small momentum bonus (proportional to `1 - dot(neighbour, prevDir)`) prevents zigzag on flat terrain.
- Stop when elevation ≤ 0 (sea level) or `maxSteps` is reached.

`_tracePathToTarget()` (used for tributaries) blends downhill gradient with a pull toward the junction point: `score = elevation * 0.7 + distToTarget * 0.3`.

### Archetypes

| Archetype | Width scale | Meander scale | Probability |
|---|---|---|---|
| `stream` | 0.38× | 0.25× | 1/5 |
| `river` | 1.0× | 1.0× | 3/5 |
| `wide` | 1.45× | 1.90× | 1/5 |

### Tributaries

Each main river spawns up to `cfg.tributaries` tributaries (1 on low tier). Junction points are spread evenly across 20–65% of the main path to avoid clustering. The tributary source is found by stepping upstream and sideways from the junction (15–30° angle, alternating sides). Tributaries are narrower (55% of main width) and less meandering (70% of main meander scale).

### Smoothing (medium / high tier only)

1. **Sinusoidal meander displacement:** Two overlapping frequencies — primary (arc-length based) and secondary at `1.4–2.0×` primary (random per river) — produce irregular natural bends. Amplitude envelope: `sin(s·π)^0.7 × (0.7 + 0.3·sin(noise))` fades in at the source and out at the mouth.
2. **Chaikin corner-cutting:** 3 rounds for streams, 2 rounds for river/wide — replaces each segment at ¼ and ¾, preserving source and mouth endpoints.

On low tier both steps are skipped (saves CPU and memory).

### Source taper (geometry)

```ts
const taper = Math.min(t / 0.15, 1) * (t > 0.85 ? (1 - t) / 0.15 : 1);
const width = (widthStart + (widthEnd - widthStart) * t²) * taper * scale;
```

Width tapers to zero at the source tip (first 15%) and at the mouth (last 15%), widening quadratically in between.

### Proximity filter

After all paths are generated:
- **Main rivers**: rejected if more than 50% of points are within 16 m² of an already-accepted main river.
- **Tributaries**: rejected if more than 40% overlap any accepted path.

Uses `distanceToSquared` with early-exit — no `sqrt` in the inner loop.

### Lake generation (medium / high tier only)

- Up to 2 lakes per planet.
- Placement: elevation 0.005–0.07, moisture ≥ 0.45, minimum 120 m from existing rivers and other lakes.
- Shape: elliptical disc, radius 50–120 m, aspect 0.55–1.45. Perimeter vertices are noise-displaced (`sin(angle * 4 + noise) * r * 0.12`) for organic edges rather than a perfect ellipse.

### Shader

**Rivers:** `vUv.y` runs 0→1 along the flow direction. `fract(vUv.y - uTime * flowSpeed)` drives flow animation. `flowSpeed` varies between 0.9 (streams) and 0.2 (wide rivers). Cross-river speed variation: `flowSpeed *= isLake ? 1.0 : 1.0 + edgeMask * 0.4` — edges flow slightly faster than the centre.

**Lakes:** `vUv.x` runs 0.5 (centre) → 1.0 (edge). `fract((vUv.x - 0.5) * 7.0 - uTime * 0.5)` produces expanding concentric ripple rings.

**Low tier material:** flat `MeshBasicMaterial` (no shader cost at all).

---

## 6. Ground cover system (`world/vegetation.ts`, `world/plants.ts`)

### Plant catalog pattern

Each of 15 plant kinds is one `plant({...})` call declaring:
- `tiers`: array of `tier(geoFn, cellSize, radius, lodBand, …)` — one per LOD level.
- `gate`: GLSL snippet that returns `REJECT` to veto an instance (e.g. wrong biome).
- `look`: GLSL snippet for per-instance colour/scale variation.
- `pre`: optional early-exit rejection before the gate.

Adding a new plant kind requires only this one entry — nothing else changes.

### Shader program count

Only structural `#if` flags (`KIND`, `DISP`, `PUSH`, `MOSS`) are compiled as `#define` values. All numeric tier parameters (`PMUL`, `CELLSZ`, `WK`, `TSN`, `TO_FULL`, `TO_GONE`, `TI_GONE`, `TI_FULL`, `SCW`, `SCH`, `LEAN`) are passed as uniforms. This means tiers of the same plant kind with the same structural flags share one compiled shader program — unique programs drop from ~45 (15 kinds × 3 tiers) to ~15 on high tier.

### Placement bake

One 8-bit texel per instance cell. A bake-pass shader evaluates elevation, moisture, slope and cluster density in GLSL, writing either a height value (accepted) or a sentinel (rejected). The vertex shader reads the texel; rejected instances are collapsed to `vec3(0)` — a degenerate point the GPU clips away with zero fill-rate cost.

### Density fields

- `treeDensity(dir)`: shared by trees, ferns and mushrooms — understory follows the forest.
- `clusterField(kind, dir)`: per-species smooth density patch.
- `forestMask`, `groveMask`: broad masks that modulate `treeDensity`.

### IGN dithering — uncorrelated offsets

Both the outer fade (plant appearing at range limit) and inner fade (plant disappearing as a finer tier takes over) use Interleaved Gradient Noise screen-door dithering. The two fades use **different seed offsets**. If they shared a seed, both stipple patterns would align and the overlap band would look solid instead of blended.

---

## 7. Tree system (`world/forest.ts`, `world/trees.ts`)

- Three LOD tiers: hi-poly close, mid-poly mid-altitude, low-poly billboard-like at distance.
- LOD levels cross-fade over ~0.4 s as altitude changes — no discrete pop.
- Per-tree hue and shape seeded from instance world position for variety.

**Instance-local wind bend:** The wind function hashes the tree's world position (from `instanceMatrix[3]`) to derive a unique phase and bend direction per tree. The height term `max(lp.y, 0.0)` ensures only the upper mesh deforms — trunks stay fixed, crowns sway. Computed entirely in the vertex shader.

---

## 8. Night systems (`world/night.ts`)

### Aurora

- Geometry: `IcosahedronGeometry(16000, 2)`, `BackSide`, additive blending, `frustumCulled = false`. Subdivision 2 on all tiers — fragment-shader driven; extra vertices only add VS cost.
- **Parented to camera:** `camera.add(aurora.mesh)` instead of `scene.add`. The mesh follows the camera at zero cost — no per-frame `position.copy` + matrix recompose.
- Fragment shader: elevation `e = dot(vD, uUp)`, azimuth warped by two noise calls, curtain intensity `c = pow(|sin(az*2 + warp)|, 3)`, altitude gate `b = smoothstep(0.04, 0.22, e) * (1 - smoothstep(0.4, 0.75, e))`, high-frequency vertical ray `n(az*40, e*3 - uT*0.5)`.
- Colour: `e < 0.15` → red/orange → green; `e ≥ 0.15` → green → purple.
- Intensity gate: `uAmt = night × smoothstep(0.1, 0.45, |player.up.y|)` — polar latitude.

### Fireflies

- Count: 50 / 120 / 220 by tier.
- 80 m cube anchored to camera, wrapping via `mod()`.
- Vertex shader samples terrain (fine=false — saves 3 noise evals per mote per frame) to hover each mote above the surface.
- Visible condition: `intensity > 0.02 || dayF > 0.1`. Gates: night × altitude × no heavy rain.

### Bioluminescent motes

- Count: 12 / 28 / 50 by tier.
- Vertex shader evaluates moisture (gate: 0.2–0.45) and land flag — dry or high-altitude cells get `gl_PointSize = 0`.
- Colour: `coolCol = mix(teal, blue, moisture)`, then `mix(coolCol, orange, warmth * 0.65)` where `warmth = 1 - |d.y|` (equatorial factor).

---

## 9. Water & ocean (`render/fx.ts`)

- 3 Gerstner (trochoidal) wave trains superposed in the vertex shader.
- Surface normals computed analytically per wave train — no finite-difference approximation.
- Wave amplitude and frequency scaled by `uWind` so the ocean responds to weather in real time.
- 4th additive displacement: a player-ripple ring expanding outward from `uPl`.

---

## 10. Rendering pipeline (`render/postfx.ts`, `render/aerialfx.ts`, `render/shadows.ts`)

### EffectComposer chain

```
RenderPass          → scene to HDR render target (HalfFloatType + DepthTexture)
ShaderPass (clean)  → clamp NaN/Inf pixels (one NaN in a float target smears across bloom blur)
AerialPass          → aerial haze post-pass    ← skipped on low tier (addPass not called)
UnrealBloomPass     → half-resolution bloom    ← skipped on low tier (addPass not called)
OutputPass          → tone-map + gamma to canvas
```

On low tier, aerial and bloom passes are never added to the composer — `addPass` is not called. `UnrealBloomPass` allocates ~2.5 MB of HalfFloat render targets on construction even when disabled; skipping `addPass` entirely avoids that allocation.

### Aerial perspective (`render/aerialfx.ts`)

Reads the depth texture, reconstructs linear depth `z = near * far / (far - d * (far - near))`, blends haze using:
```glsl
float fog = 1.0 - exp(-z * (0.2231 / uFar));
```
`0.2231 ≈ −ln(0.8)` gives ~20% haze at the far plane regardless of draw distance tier. Haze colour is atmosphere scatter tint by day, deep blue by night.

### Adaptive resolution

Pixel ratio range: `[0.5, renderScale]` (renderScale set at startup by tier).
- **Downscale**: reacts within 0.5 s of a frame-time spike (EMA smoothed frame time > 33 ms, α = 0.08). Drops 0.15 per step, minimum 0.5.
- **Upscale**: waits 3 s of stable frames (< 18.5 ms). Rises 0.1 per step, capped at renderScale.

The asymmetry prevents oscillation: load spikes react quickly; recovery is cautious.

### Shadows (`render/shadows.ts`)

- `shadowMap.autoUpdate = false` — Three.js does not automatically re-render the depth pass.
- `needsUpdate = true` once per throttle tick — but **only** when `sunStrength > 0.005 || moonStrength > 0.005`. When shadows are invisible (deep night or deep space) the depth pass is skipped entirely.
- **Shadow texel-snapping**: the frustum centre is quantised to shadow-map texel steps before upload, eliminating sub-texel drift (shadow shimmer) as the camera moves.
- Shadow frustum half-extent: 65% of full size on `low` tier.

---

## 11. Settings & Locations panels (`ui/gui.ts`)

### Settings panel (right side)

Built with lil-gui. Starts collapsed (`gui.close()`) — opens on G or user click.

**Item order:** New world → Palette → Terrain folder → Biomes folder → Sky & weather folder → Walk/drone/fly cycle → Land.

**G key** toggles both the settings panel and the Locations panel together.

### Locations panel (left side)

Created only when `spots.length > 0`. Positioning:
```ts
position: "fixed", top: "78px", left: "10px", zIndex: "49"
```
`z-index: 49` places it below the loading splash (`z-index: 50`). The panel fades in naturally as the splash transitions to `opacity: 0` on entry — no visible grey band during loading.

**Structure:** ungrouped spots render flat; grouped spots (landmarks, rivers) go into collapsible subfolders that start closed.

**Touch:** `--widget-height: 44px`, `maxHeight: calc(100dvh - 90px)`, hidden by default — shown via the ☰ HUD button.

---

## 12. Seed system

World seed is a pronounceable word (e.g. `KaliSeron`) stored in the URL as `?seed=KaliSeron`. `hashSeedWord()` converts it to a 32-bit integer used by all noise functions. Changing the seed rebuilds the planet in place via `rebuild(respawn = true)`.

---

## 13. Adding a plant kind

1. Add a geometry builder to `world/plantgeo.ts` (foliage) or `world/rockgeo.ts` (rocks).
2. Add one `plant({name, tiers, gate, look})` entry to `world/plants.ts`. Nothing else needs editing.
