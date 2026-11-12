# Planet Explorer — Design & Architecture

Developer reference for the procedural planet explorer. Covers architecture decisions, system internals, and implementation details. For a feature overview see [README.md](README.md).

---

## 1. Source layout

```
src/
├── main.ts               ← entry point, startup sequence, frame loop
├── core/
│   ├── config.ts         ← S (live settings) + CFG (engineering constants) + seed-word state
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
│   ├── life.ts           ← birds, shooting stars, lightning, waterfall mist, butterflies/leaves
│   ├── precip.ts         ← GPU rain / snow
│   ├── river.ts          ← valley tracing, meanders, tributaries, lakes, water shader
│   ├── forest.ts         ← tree placement + LOD
│   ├── trees.ts          ← procedural tree geometry (14 species × 3 tiers)
│   ├── treeutil.ts       ← tree geometry helpers
│   ├── geoutil.ts        ← shared procedural-geometry builders
│   ├── vegetation.ts     ← GPU instanced scatter (reads bake textures)
│   ├── plants.ts         ← 19-kind plant & rock catalog with per-kind GLSL gates
│   ├── plantgeo.ts       ← foliage geometry (grass, flowers, shrubs, …)
│   ├── rockgeo.ts        ← rock geometry (rocks, slabs, frost rocks, cobbles, tors, scree, basalt)
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

### Module map

| Area | Directory / file | Role |
|------|-----------------|------|
| Entry | `main.ts` | Wires everything; runs the startup sequence, rebuilds and frame loop. |
| Core utilities | `core/` | Config constants + seed state (`config`), noise, palettes, seed words, geometry math. |
| GPU tier | `render/gputier.ts` | Classifies the GPU (probed in `main.ts` before renderer creation) as high / medium / low. |
| Rendering | `render/` | Shared uniforms and shaders (`fx`), GPU bake helpers (`bake`), terrain material (`terrain`), post-processing chain (`postfx`, `aerialfx`), sun/moon shadows (`shadows`), tree material (`treemat`). |
| Planet | `world/planet.ts`, `world/chunks.ts` | Coarse planet mesh with cube-map surface; streamed high-detail terrain chunks. |
| Sky & atmosphere | `world/sky.ts`, `world/skyfx.ts`, `world/night.ts`, `world/precip.ts` | Sun/moon/weather state, cloud shell + rainbow, aurora/fireflies/bioluminescence, GPU rain/snow. |
| Ambient life | `world/life.ts` | Bird flocks, shooting stars, lightning, waterfall mist, butterflies & falling leaves. |
| Rivers & lakes | `world/river.ts` | Valley-tracing paths, meanders, tributaries, lakes; single animated water shader. |
| Trees | `world/forest.ts`, `world/trees.ts`, `world/treeutil.ts`, `world/geoutil.ts` | 14 species picked by altitude/climate; clustered placement, three LOD levels, per-tree hue and shape variation. |
| Ground cover | `world/plants.ts`, `world/vegetation.ts`, `world/plantgeo.ts`, `world/rockgeo.ts` | 19 plant and rock kinds with biome/altitude-specific placement gates. |
| Landmarks | `world/landmarks.ts` | 24 landmarks across 8 procedural types, placed at build time. |
| Player | `player/player.ts`, `player/touch.ts`, `world/collision.ts`, `world/footprints.ts` | Walk / drone / fly controller; collision; snow footprints; virtual joystick. |
| Locations | `world/spots.ts` | Terrain beauty-spot scanner; results populate the Locations panel and map. |
| UI | `ui/gui.ts`, `ui/map.ts` | lil-gui settings + Locations panel; fullscreen equirectangular planet map. |

Runtime dependencies: `three`, `lil-gui`, `nipplejs`. Build: Vite + TypeScript (`tsc --noEmit` type-check, then `vite build`; `three` is split into its own chunk).

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
3. Step 1 – terrain     fire: precompileBakes()  ← every terrain-bake shader compiles in parallel
                        await planet.build()
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

- **Shader compile dominates a Windows cold start.** Chrome/Edge on Windows translate WebGL through ANGLE to D3D11, whose HLSL compiler (`fxc`) fully inlines and unrolls the terrain noise: each bake program that evaluates `e3()` takes 2–20 s to compile, against well under a second on GL, Metal or Vulkan. Four measures keep this off the critical path:
  - `precompileBakes()` (`render/bake.ts`) builds a throwaway scene holding every bake material and calls `compileAsync` on it at the start of step 1, with a float render target bound. Three keys programs on the target's colour space, so compiling against the canvas would warm the wrong variants. With `KHR_parallel_shader_compile` the driver compiles them all concurrently while the CPU setup runs.
  - The plant placement bake is a single program for all 19 kinds (runtime `uKind` branch), not one per kind (§6).
  - The visible plant vertex shader includes only `HELPERS_GLSL`, not the whole terrain library it never calls (§6).
  - `renderer.debug.checkShaderErrors` is on only in dev builds. In production it would read each program's info log right after linking, forcing a synchronous wait per program.

  Measured on a Windows D3D11 laptop: cold start fell from 125 s to about 40 s. The octave loop in `fb()` deliberately keeps its constant bound: a runtime bound compiled faster but ran about 20% slower per frame.
- Rivers and scouting start immediately after terrain because `findSpots` can scan terrain in parallel with river generation; it only awaits `riversPromise` at the very end to append river teleport entries.
- `compileAsync` is deferred until after all GPU baking. Baking and compiling both submit GPU work; running them together creates pipeline stalls on tiler GPUs.
- The warm-up calls `postFX.render(0)` rather than a direct `renderer.render()` into a 1×1 target. This pre-compiles all EffectComposer pass shaders (aerial / bloom / output) during the labelled loading step rather than lazily on the first visible frame. It also uploads all geometry and texture buffers to the GPU.
- The animation loop starts **before** the RAF yield. This guarantees the compositor has already been given a fully-rendered frame before the "Click to enter" button is shown, so clicking in is visually instant.

### Rebuilds (new seed / terrain settings)

`rebuild(respawn)` is debounced (120 ms) and **chained** on a single promise: each rebuild runs `planet.build()` → `buildRivers()` → map reset → scatter/collider dirty → respawn or refresh → `findSpots()` only after the previous one finishes. `build()` awaits GPU bakes, so two overlapping rebuilds would otherwise both add terrain and river meshes to the same group. Failures are logged and don't break the chain.

`planet.build()` frees only the materials it created on the previous build (terrain + landmark materials, tracked in `buildMats`). Water, cloud, atmosphere and tree materials are reused across builds and are not freed.

---

## 3. GPU tier detection (`render/gputier.ts`)

### Probe canvas

The probe lives at the top of `main.ts`; `gputier.ts` exports `detectGpuTier(gl)` (classification) and the `gpuTier` value every system reads.

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

**Touch detection** (`isTouchDevice`, exported from `gputier.ts`) uses `matchMedia("(pointer: coarse)")`, i.e. the *primary* pointer. `"ontouchstart" in window` is also true on Windows touchscreen laptops, which used to lose mouse-look and pointer lock and get the joystick UI. Falls back to `ontouchstart` where the media query is unsupported.

**Software rasterisers (checked first):** `swiftshader | llvmpipe | softpipe | software | basic render` → low.

**Apple GPU:**
```
"apple gpu" in renderer string:
  Mac (not touch), WEBGL_compressed_texture_astc → Apple Silicon → high
  Mac (not touch), no ASTC                       → Intel/AMD Mac → medium
  iPad (UA or MacIntel + maxTouchPoints > 1), screen long side ≤ 1112 CSS px → A10–A13 iPad → medium
  iPad, taller screen                            → Air 4+/iPad 10/mini 6/any Pro since 2018 → high
  otherwise (iPhone)                             → medium
```
Every iPad reports "Apple GPU", so the chip is inferred from the display. The legacy form factors (768×1024, 810×1080, 834×1112) are the 2017–2021 A10/A12/A13 iPads, which have iPhone-class GPUs.
Safari reports every Mac GPU as "Apple GPU", including 2017–2020 Intel Macs; only Apple-designed GPUs support ASTC textures. iPadOS 13+ defaults to "Request Desktop Website", so the UA reads `"Macintosh"`; `navigator.platform + maxTouchPoints` detects the spoof.

**HIGH regex:**
```
rtx | rx [5-9]\d{3} | rx (4[78]|5[789])0 | vega [5-9]\d | radeon vii | gtx 1[0-9]{3} | gtx 9[5-9]\d |
arc.{0,8}a[5-9]\d{2} | apple m\d+ | adreno.{0,8}(6[4-9]\d|7\d{2}|8\d{2}|x\d) | xclipse
```
Covers: NVIDIA RTX / GTX 900–1000, AMD RX 5000–9000 (RDNA 1–3) / Polaris RX 470–590 / Vega / Radeon VII, Intel Arc A5xx/A7xx, Apple M-series, Adreno 640–7xx (Galaxy S20 Ultra – S24+, Pixel 5+), Xclipse 920 (Exynos S22 Ultra), Adreno X1-85 (Snapdragon X Elite Copilot+ laptops).

**MEDIUM overrides (checked before LOW catch-all, in order):**
```
mali[-\s]g7\d{2}(?!\d)   → Mali-G710/G715/G720 (Dimensity 9000+ high-end)
mali[-\s]g7[0-9](?!\d)   → Mali-G72 (Galaxy S9 / Note 8, 2017 flagship)
mali[-\s]g6[1-2]\d(?!\d) → Mali-G610/G615 (Dimensity 8000–8300)
adreno.{0,8}61[0-2]      → Adreno 610/612 budget phones → LOW, despite the 6xx number
u?hd.{0,12}6[2-4]\d      → Intel (U)HD 620–640 (2017–2021 laptops; "HD 630" on older drivers)
iris                      → Intel Iris Plus / Iris Xe (MacBook Air 2018–2020, 11th–13th gen)
adreno.{0,8}5[3-9]\d     → Adreno 530/540 (Snapdragon 820/835, Galaxy S7/S8 2016–2017)
```

**LOW catch-all:**
```
(uhd.{0,12}[2-5]\d{2}|hd graphics) | mali[-\s] | adreno.{0,8}[3-5]\d{2} |
videocore | powervr | ge8\d{3} | img bxm | sgx
```

**Fallback** (if `WEBGL_debug_renderer_info` is blocked — Firefox `resistFingerprinting`, privacy browsers):
```ts
return isTouchDevice ? "low" : "medium";
```
Touch = unknown mobile → conservative `low`. Desktop → `medium`, not `high`: a 7-year-old Intel iGPU in a privacy browser would otherwise get 4× MSAA, 320 resolution and far plant tiers. Adaptive resolution still raises sharpness where there is headroom.

`npm run test:tiers` (`scripts/gputier.test.mts`) checks the classifier against real renderer strings: S22 Ultra (Snapdragon and Exynos), iPad in desktop mode, new and legacy-size iPads (screen size per case via an `@WxH` label suffix), Intel and M-series Macs, touchscreen laptops, budget Android, SwiftShader, and a blocked debug extension.

### What each tier gates

| Feature | low | medium | high (mobile) | high (desktop) |
|---|---|---|---|---|
| Terrain resolution | 128 | 160 | 256 | 320 |
| Render scale | 0.60 | 0.75 | ≤ 2.0, capped at 2.4 MP | 1.0 / 1.5 (Retina) |
| Terrain octaves | 4 | 5 | 6 | 6 |
| Camera far plane | 20 000 m | 30 000 m | 40 000 m | 40 000 m |
| MSAA samples | 0 | 2 | 4 | 4 |
| Shadow map size | 256 px | 512 px | 1024 px | 2048 px |
| Shadow PCF radius | 1 | 1 | 2.5 | 2.5 |
| Plant shadows (rocks, shrubs, cactus) | off | off | on | on |
| Water sun glitter | off | off | on | on |
| Bird flocks / shooting-star slots | 1 / 2 | 2 / 4 | 3 / 4 | 3 / 4 |
| Lightning, cascade mist (max falls) | off | on (4) | on (8) | on (8) |
| Butterflies & leaves, sand ripples | off | off | on | on |
| Shadow Hz | 20 | 30 | 30 | 30 |
| Shadow frustum | 65% | 100% | 100% | 100% |
| Aerial haze pass | off | on | on | on |
| Bloom pass | off (skipped) | on | on | on |
| Footprints | off | on | on | on |
| Ground-cover LOD tiers | near only | near + mid | near + mid + far | near + mid + far |
| Plant radius multiplier | 0.50 | 0.65 | 1.0 | 1.0 |
| Tree LOD distance multiplier | 0.45 | 0.65 | 1.0 | 1.3 |
| Detailed-terrain fade (m) | 170–235 | 170–235 | 170–235 | 240–320 |
| Terrain chunks streamed (of 9×9 lattice) | ~37 | ~37 | ~37 | ~45 |
| Forest count multiplier | 0.30 | 0.55 | 0.80 | 0.80 |
| Star count | 900 | 1600 | 2500 | 2500 |
| Rain/snow particle count | 1200 | 2200 | 3500 | 3500 |
| Nebula count | 0 | 9 | 14 | 14 |
| Galactic band points | 140 | 280 | 500 | 500 |
| Firefly count | 50 | 120 | 220 | 220 |
| Bio-mote count | 12 | 28 | 50 | 50 |
| Main rivers / tributaries each | half (min 2) / 1 | 4 / 3 | 4 / 3 | 4 / 3 |
| River trace length | 60% steps | full | full | full |
| River meanders + smoothing | off | on | on | on |
| Lake generation | off | on | on | on |
| Water material | `MeshBasicMaterial` | shader | shader + high-detail | shader + high-detail |

The mobile-high render scale is a pixel budget, `sqrt(2.4 MP / CSS pixels)` clamped to [1, 2]. Phones stay at 2.0. An iPad Pro lands near 1.4 instead of rendering 5.6 MP, which would need about 270 MB for the 4× MSAA HalfFloat scene target alone, enough for iPadOS to kill the tab.

The moon's shadow map is half the size of the sun's on every tier. See §10 for why low tier skips the aerial and bloom passes entirely.

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

### Streamed detail chunks (`world/chunks.ts`)

A (2·CR+1)² = 9×9 lattice of 80×80-cell chunks (1.5 m cells, 120 m per chunk) follows the player on the cube-face lattice. Heights, normals and colour are baked per chunk; the vertex shader only fetches them. The terrain fragment shader dithers chunks out between `chunkFade()` metres (`render/gputier.ts`, 170–235 m, or 240–320 m on high desktop), and the coarse cube-mapped planet shows beyond.

Only chunks that can come within `chunkFade()[1] + 15` m of any point of the centre chunk are built (`inReach`, using the same chord-on-sphere distance as the shader fade). Selection reruns only when the player enters a new centre chunk. The full lattice reaches ~±540 m, so the outer rings used to be baked and vertex-shaded without a fragment surviving. Skipping them roughly halves chunk bake and vertex work on every tier.

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

**Cascades:** each ribbon vertex carries `aSteep`, the bed steepness over ±2 path points (drop / run through `smoothstep(0.08, 0.3)`). Steep reaches flow up to 3.5× faster and churn white across the whole width (two scrolling streak layers), with a little more opacity. The terrain has no cliffs, so a steep reach is a cascade down a slope rather than a vertical drop; spray is added separately (§8a).

**Low tier material:** flat `MeshBasicMaterial` (no shader cost at all).

---

## 6. Ground cover system (`world/vegetation.ts`, `world/plants.ts`)

### Plant catalog pattern

Each of 19 plant and rock kinds is one `plant({...})` call declaring:
- `tiers`: array of `tier(geoFn, cellSize, radius, lodBand, …)` — one per LOD level.
- `gate`: GLSL snippet that returns `REJECT` to veto an instance (e.g. wrong biome).
- `look`: GLSL snippet for per-instance colour/scale variation.
- `pre`: optional early-exit rejection before the gate.

Adding a new plant kind requires only this one entry — nothing else changes.

### Shader program count

Only structural `#if` flags (`KIND`, `DISP`, `PUSH`, `MOSS`) are compiled as `#define` values. All numeric tier parameters (`PMUL`, `CELLSZ`, `WK`, `TSN`, `TO_FULL`, `TO_GONE`, `TI_GONE`, `TI_FULL`, `SCW`, `SCH`, `LEAN`) are passed as uniforms. This means tiers of the same plant kind with the same structural flags share one compiled shader program — unique programs drop from ~55 (19 kinds × up to 3 tiers) to ~19 on high tier.

The visible vertex shader reads placement from the baked texel and never evaluates terrain, so it includes only `HELPERS_GLSL` (`sm_`, `hs`, `basis` and the biome colour uniforms) instead of `TERRAIN_GLSL`. `look` snippets may use only those.

### Placement bake

One texel per instance cell. A bake-pass shader evaluates elevation, moisture, slope and cluster density in GLSL, writing either a height value (accepted) or a sentinel (rejected). **All kinds share one bake program.** `decideGLSL()` emits each kind's `pre` / `gate` / `result` as `if (uKind == k) { … }`, a dynamically uniform branch, rather than `#if KIND==k`, and `placementBakeMaterial()` has no defines. That is one compile instead of one per kind, which matters on Windows (§2). `decide()` has a single exit: `REJECT` sets a flag, later stages are skipped with `if (!rej)`, and one final `return` picks the sentinel or the kind's result. With ~30 early returns in one program, ANGLE's D3D translation warned X4000 ("potentially uninitialized variable"). A parity check against the original per-kind programs (then 15 kinds × 9 lattice patches × 16 384 cells) gave identical output. The vertex shader reads the texel; rejected instances are collapsed to `vec3(0)` — a degenerate point the GPU clips away with zero fill-rate cost.

### LOD bands (`CFG.plantLod`, `CFG.plantRadius`)

Each tier is `[full-size until, gone beyond, inner gone below, inner full above]` metres; the radius is the draw-lattice radius before the tier multiplier (§3).

| Band | Used by | LOD | Radius |
|---|---|---|---|
| `near` / `mid` | grass, ferns, reeds, tall sedge | `[60,90,0,0.5]` / `[74,106,3,14]` | 90 / 104 |
| `flower` | flowers (single tier) | `[65,90,0,0.5]` | 90 |
| `mush` | mushrooms (single tier) | `[30,50,0,0.5]` | 48 |
| `shrub` / `shrubMid` | shrubs, alpine scrub, cactus, dead scrub, cobbles (no far tier) | `[75,110,0,0.5]` / `[70,152,5,22]` | 110 / 160 |
| `rock` / `rockMid` | rocks, rock slabs, frost rocks, boulders, crystals, tors, basalt columns, scree | `[80,140,0,0.5]` / `[70,195,5,22]` | 140 / 210 |
| `far` | third tier of every multi-tier kind | `[90,200,12,36]` | 204 |

Far tiers draw on high tier only; mid tiers on medium and above.

### Rocks by altitude

Rocks share the plant pipeline: each type is a catalog entry with `wind: 0`, `hardy: true` (survives near the snowline) and its own `clusterField` index. The `gate` picks the altitude band, `look` sets size and tint. Geometry lives in `world/rockgeo.ts` and reuses the palette rock colours (`rockWarm`, `rockWarmAlt`, `rockWarmDark`, `rockCool`), so every planet palette works unchanged.

| Kind | # | Elevation `e` | Other conditions | Size | Tiers |
|---|---|---|---|---|---|
| cobbles | 15 | < 0.12, densest below 0.1 | slope < 0.5 | 0.3–0.7 m pebble beds | shrub / shrubMid (no far) |
| rocks | 3 | any, more on slopes and > 0.4 | — | 0.3–1.9 m | rock / rockMid / far |
| rock slabs | 8 | any, more 0.25–0.5 | slope-weighted | flat, 0.2–1.4 m | rock / rockMid / far |
| tors | 16 | 0.14–0.42 | slope < 0.7, rare | stacked blocks ~1.5–8 m tall | rock (8.5 m cell) / rockMid / far |
| basalt columns | 17 | 0.2–0.52 | dry (`m` < 0.25), clustered (`cf²`) | hex prisms ~0.6–5 m | rock (8.5 m cell) / rockMid / far |
| boulders | 13 | > 0.28 | slope-weighted | 1.6–4.8 m | rock (8.5 m cell) / rockMid / far |
| scree | 18 | > 0.3, ramps to 0.5 | density rises with slope (0.2→0.8) | shard fields 0.1–0.5 m | rock / rockMid / far |
| frost rocks | 9 | > 0.38 | — | 0.3–1.6 m angular | rock / rockMid / far |
| crystals | 14 | > 0.22 | `m` < 0.35 | thin spires | rock / rockMid / far |

Large kinds (tors, basalt, boulders) use a doubled 8.5 m cell so the instance lattice stays small for rare placements. Cobbles and scree are not collidable (they're stepped over). Plant collision is currently disabled globally (see `Scatter` in `vegetation.ts`), so `collide` only controls shadow casting.

### Plant shadows

On high tier, the near tier of collidable kinds (rocks, slabs, frost rocks, boulders, tors, basalt columns, shrubs, cactus) casts shadows through a `customDepthMaterial`. It runs the same placement block as the visible shader, injected at `begin_vertex`, because the depth shader includes `beginnormal_vertex` only under `USE_DISPLACEMENTMAP`. Without it, Three's shared depth material draws every instance untransformed, piled at the planet centre: wasted vertex work and no visible shadow. Grass used to be in exactly that state, so it no longer casts at all; thin blades would cost thousands of instances for a barely visible stipple.

### Wind

Each kind has a `wind` weight (uniform `WK`) multiplied by the global `S.windSway`. Rigid kinds — cactus, rocks, crystals — use `wind: 0`.

### Density fields

- `treeDensity(dir)`: shared by trees, ferns and mushrooms — understory follows the forest.
- `clusterField(kind, dir)`: per-species smooth density patch.
- `forestMask`, `groveMask`: broad masks that modulate `treeDensity`.

### IGN dithering — uncorrelated offsets

Both the outer fade (plant appearing at range limit) and inner fade (plant disappearing as a finer tier takes over) use Interleaved Gradient Noise screen-door dithering. The two fades use **different seed offsets**. If they shared a seed, both stipple patterns would align and the overlap band would look solid instead of blended.

---

## 7. Tree system (`world/forest.ts`, `world/trees.ts`)

- **Species (14):** pine, oak, birch, palm, fir, snag, acacia, cypress, willow, mangrove, kapok, baobab, spruce, juniper. Each species function in `trees.ts` builds both the detailed (`q = 1`) and medium (`q = 0.5`) tiers from the same seed, so silhouettes match. `lowGeos()` builds a separate low-poly set. Index order must match across `treeGeos`, `lowGeos`, `getLeafColors()` and the `SP` / `TRUNK` tables in `forest.ts`.
- **Species by altitude** (`pickSpecies`, elevation `e`, temperature `tp`, moisture `m`, smooth `stand` noise so neighbours form stands):

  | Band | Species |
  |---|---|
  | shore `e` < 0.1, warm | mangrove (wet), palm (dry) |
  | warm lowland | baobab / acacia (dry), kapok (humid, `e` < 0.2) |
  | temperate | oak / birch / willow (wet), cypress / birch (drier), pine (cool), spruce on upper cool slopes |
  | `e` 0.3–0.37 or cold | spruce / fir stands |
  | `e` 0.37–0.44 subalpine | juniper krummholz, odd stunted fir |
  | `e` > 0.44 treeline | snag |

  Heights span ~2–4 m (juniper) to ~18–24 m (kapok), before per-tree scale (0.55–1.65, shrinking with altitude) and width/height jitter.
- **Palette slots:** palettes define 10 bark and 10 leaf colours. The four newer species borrow a base slot. Bark is reused directly, and leaf colour is offset in HSL via `EXTRA` in `trees.ts` (kapok ← mangrove, baobab ← acacia, spruce ← fir, juniper ← pine), so palettes need no edits.
- Three LOD tiers: 0 detailed (shadow-casting), 1 medium, 2 low-poly.
- **Distance cross-fade:** tiers blend over `CFG.treeLod = [H0, H1, M0, M1] = [40, 70, 130, 170]` m (scaled by tier, see §3) with strictly complementary IGN screen-door dither: with `a = smoothstep(H0, H1, d)` and `b = smoothstep(M0, M1, d)`, tier 0 keeps `noise ≥ a`, tier 1 keeps `b ≤ noise < a`, tier 2 keeps `noise < b`. No holes, no double coverage, no pops.
- **Static far set:** the low-poly tier holds every tree and is never rebuilt; its vertex shader collapses instances near the camera or on the far side of the planet. Only the detailed (≤ H1 + 15 m) and medium (H0 − 15 … M1 + 15 m) sets are rebuilt as you move, from per-tree matrices composed once and cached.
- **Shader bands follow the tier:** `Forest` writes its tier-scaled `[H0, H1, M0, M1]` into `U.uLod`, so the shader cross-fade and the CPU-filled detailed/medium sets cover the same distances. With the unscaled defaults in the shader, low/medium left a dithered gap where trees thinned out at mid range.
- **Altitude near-mode:** detailed/medium sets are enabled below 380 m and dropped above 420 m (hysteresis), and their strength fades in/out over ~0.4 s (`nearFadeSpeed`).
- Per-tree hue and shape seeded from instance world position for variety.
- The low-poly tier has no wind (never close enough to see sway), which removes sin/cos work from ~1 M vertices per frame.

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

## 8a. Ambient life & sky events (`world/life.ts`)

Everything is GPU-driven: positions come from time + per-instance seeds in the vertex shader, one draw call per effect, and only a few uniforms are set on the CPU each frame. Vertices of hidden instances are moved off-screen in the shader.

| Effect | Tiers | When | Cost |
|---|---|---|---|
| Bird flocks | all (1 / 2 / 3 flocks) | daylight, cloud cover < 0.85, player below 400 m | 3 tris × 7–11 birds per flock |
| Shooting stars | all (2 / 4 slots) | night | 2 tris per slot |
| Lightning | medium, high | heavy rain | 14 segment quads |
| Rainbow | all | after rain, low sun, clearing sky | one term in the sky dome |
| Cascades + mist | medium, high (4 / 8 falls) | always | river shader term + 10 sprites per fall |
| Butterflies & leaves | high | daylight, within 30 m, below 40 m altitude | 2 tris × 160 |
| Sand ripples | high | sand-coloured ground within 120 m | terrain bump term |

Measured on a medium-tier laptop: no change in frame time or vertex count against the previous build.

**Bird flocks.** Each flock runs its own 62 s cycle (staggered by flock index) and is airborne for 40% of it, on about 65% of cycles. When a cycle starts, the CPU latches an anchor for that flock: the player's position, up vector and view direction flattened onto the ground plane. The pass then crosses the view **left→right or right→left** (± the view's right axis, ±15° wobble), 50–140 m in front and 18–45 m up, fixed in the world so walking doesn't drag it along. The flock type comes from the ground under the pass, sampled with the shared terrain functions: coast → gulls (white, wheeling cloud), forest → crows (dark, ragged), open land → geese (grey V). Wings are the two outer vertices of a 3-triangle bird, flapped in the vertex shader.

**Shooting stars.** Each slot has its own 7–19 s period and phase offset, chosen on the CPU and passed as an attribute, so the CPU and the shader agree exactly on cycle boundaries; a `sin()` hash differs between float32 and float64. When a slot's cycle starts, the CPU latches the view direction for it. The meteor starts within ±40° of that direction and 8–30° up (a level gaze sees ±35° vertically), then **crosses the view sideways**, slanting down, over 0.7–1.1 s. Pitfalls fixed along the way:
- The streak quad's across axis flips with travel direction, so the material must be `DoubleSide`; single-sided, half the meteors were back-face culled.
- Widths must be ≥ about 2 px at 9 km, or the streak is sub-pixel.
- The head is kept just above the 0.75 bloom threshold; hotter values bloomed into large soft discs.

**Lightning.** A strike every 4–12 s while `precipitationAmount > 0.7`, 200–600 m ahead and off to one side, on the real ground (`planet.radiusAt`). The bolt is a jagged 14-segment polyline built in the vertex shader from a per-strike seed. It is billboarded toward the camera, HDR-bright so it outshines an overcast sky, and flickers for about 0.35 s. `update()` returns a flash value that `main.ts` applies **after** `sky.update()` (which rebuilds sky, fog and ambient light from scratch each frame), lifting the sky colour and ambient light. The bolt shows alone for about 40 ms before the sky flash, so it reads against the dark storm sky.

**Rainbow** (`world/skyfx.ts`, sky dome). The primary bow sits at 40.4–42.6° from the anti-solar point (red outside), the secondary at 50.2–53.4° (colours reversed, 35% strength), and the sky inside the primary is slightly brighter. Strength = `wet × (1 − precip) × clearing sky × low sun`. `wet` is a slow memory of recent rain: it follows precipitation up instantly and lets go over about 40 s, so the bow lingers as a shower clears, whereas precipitation and cloud themselves clear together within seconds. It needs a sun elevation between about 0.02 and 0.75. Above 42° a real primary bow is below the horizon. Sun height depends on where you stand, so rainbows are local.

**Cascades & mist.** `buildWaterfalls()` scans each river path (skipping the 15% tapers at either end) for drops of ≥ 6 m over ≤ 6 path steps with slope > 0.3, at least 60 m apart. Smaller steps read as rapids hidden in grass. Real worlds get 1–3 per planet. Each gets a mist cloud of soft sprites rising from the foot of the drop; the white water itself is the river shader's `aSteep` term (§5). Built in `planet.buildRivers()` into the planet group, so `build()` disposes them on rebuild.

**Butterflies & falling leaves** (high only). 160 two-triangle "flutterers" in a world-anchored 70 m cell around the player (wrapping with `mod()`, as the fireflies do). Each picks its role from the ground under its home position: warm meadow → butterfly (bright wings flapping, wandering 0.6–2.2 m up); warm forest (`treeDensity`) → leaf (autumn tint, tumbling down from 9 m on a 9 s loop, drifting downwind); anywhere else, or above the snowline → hidden.

**Sand ripples** (high only, `render/fx.ts`, `DUNES` define). Pixels close to the palette's sand colour (`uCs`) within 120 m get long parallel ridges (fixed world wind direction, warped by two noise octaves so they meander and fork). They are fed into the existing derivative bump so they mostly change lighting, plus a slight shade. Other tiers compile exactly the same terrain shader as before.

---

## 9. Water & ocean (`render/fx.ts`)

- 3 Gerstner (trochoidal) wave trains superposed in the vertex shader.
- Surface normals computed analytically per wave train — no finite-difference approximation.
- Wave amplitude and frequency scaled by `uWind` so the ocean responds to weather in real time.
- 4th additive displacement: a player-ripple ring expanding outward from `uPl`.
- **High tier: sun glitter** (`GLITTER` define, so other tiers compile exactly the same shader as before). A very tight Blinn-Phong highlight (`pow(n·h, 900)`) on the detailed wave normal is added as HDR emissive, so bloom turns the brightest facets into sparkles. It fades out beyond about 400 m and with a low sun.

---

## 10. Rendering pipeline (`render/postfx.ts`, `render/aerialfx.ts`, `render/shadows.ts`)

### EffectComposer chain

```
ScenePass           → scene into its own HDR target (HalfFloat, MSAA per tier, DepthTexture), then
                      the NaN/Inf clean shader copies it into the composer buffer
                      (one NaN in a float target smears across the bloom blur)
AerialPass          → aerial haze post-pass    ← skipped on low tier (addPass not called)
UnrealBloomPass     → half-resolution bloom    ← skipped on low tier (addPass not called)
OutputPass          → tone-map + gamma to canvas
```

On low tier, aerial and bloom passes are never added to the composer — `addPass` is not called — so their HalfFloat render targets (~2.5 MB for bloom) are never committed or rendered.

The MSAA sample count of the scene target is tier-gated (0 / 2 / 4). The composer's ping-pong buffers are plain HalfFloat with no MSAA and no depth. The canvas is created with `antialias: false`, since it only ever receives the final full-screen pass.

**Why a dedicated scene target.** `EffectComposer` clones the target it is given for its second buffer, samples and depth texture included. With the old `RenderPass` setup, every post pass wrote into a 4× MSAA target. Worse, the scene alternated between the two buffers every frame (an odd number of swaps), and the full-screen passes overwrote the other buffer's depth with the quad's. The aerial pass therefore read real scene depth one frame and an empty buffer the next, so the haze flickered.

**Sizing.** The composer is built at CSS size and then given `setPixelRatio(pr)` + `setSize(innerWidth, innerHeight)`, so every target, bloom included, follows the render scale from frame zero. Previously the targets stayed at CSS size until the first adaptive change. Low tier rendered about 2.8× its intended pixel count, and Retina/phone high tier rendered at 1× and was upscaled. `ScenePass.setSize` floors the unrounded `width × ratio` the composer passes in.

**NaN/Inf clean pass:** uses a bit test (`floatBitsToUint(c) & 0x7f800000u == 0x7f800000u`) instead of `isnan()` / `isinf()`. ANGLE's D3D compiler on Windows assumes no NaNs and may strip `isnan()` (warning X3577). Output is also clamped to `[0, 32]` before bloom.

### Aerial perspective (`render/aerialfx.ts`)

Reads the depth texture, reconstructs linear depth `z = near * far / (far - d * (far - near))`, blends haze using:
```glsl
float fog = 1.0 - exp(-z * (0.2231 / uFar));
```
`0.2231 ≈ −ln(0.8)` gives ~20% haze at the far plane regardless of draw distance tier. Haze colour is atmosphere scatter tint by day, deep blue by night.

### Adaptive resolution

Pixel ratio range: `[0.5, renderScale]` (renderScale set at startup by tier).
- **Downscale**: reacts within 0.5 s of a frame-time spike (EMA smoothed frame time > 30 ms, α = 0.08). Drops 0.15 per step, minimum 0.5.
- **Useless-downscale guard**: if a downscale did not make frames at least 8% faster, twice in a row, resolution is not the bottleneck. Typical causes are a 30 Hz cap (iOS Low Power Mode, Android battery saver) or CPU load. The loop then undoes the last step and holds that ratio as its floor, instead of sinking to 0.5 for no gain. The floor resets once frames are fast again.
- **Upscale**: waits 3 s of stable frames (< 18.5 ms). Rises 0.1 per step, capped at renderScale.

The asymmetry prevents oscillation: load spikes react quickly; recovery is cautious.

On window resize (e.g. dragging to a lower-DPR monitor) the pending ratio is immediately clamped to `min(devicePixelRatio, renderScale)`; raising it again is left to the adaptive loop.

### Shadows (`render/shadows.ts`)

- `shadowMap.autoUpdate = false`, and `shadow.autoUpdate = false` per light: Three re-renders a light's depth pass only when that light's `shadow.needsUpdate` is set.
- Once per throttle tick, each light is updated only while its own shadow is visible (strength > 0.005). The moon used to be gated by toggling `castShadow`, which recompiled every lit material at dusk and dawn, causing a frame hitch. `castShadow` now stays on for both lights.
- Both lights start with `needsUpdate = true`, so the startup warm-up renders each once. Three allocates a light's shadow map only when it first renders it, and a missing map leaves every lit draw with an empty `sampler2DShadow` (`GL_INVALID_OPERATION`).
- **Shadow texel-snapping**: the frustum centre is quantised to shadow-map texel steps before upload, eliminating sub-texel drift (shadow shimmer) as the camera moves. The step uses each light's *actual* map size. It used to assume 1024² everywhere, so snapping only partly worked on low and medium tiers and for the half-size moon map.
- `normalBias` is 0.4 m for the original 0.23 m texels and scales down with finer maps (0.2 m at 2048²), never up.
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

### Spot scanner (`world/spots.ts`)

`findSpots()` returns, in this order:

1. **Fixed** (8): North/South Pole, Aurora Borealis/Australis, Equator 0°/90°/180°/270°.
2. **Scanned** (12 features × 3 = 36): Beach, Mountain Peak, Canyon, Island, Coastal Cliffs, Open Plains, Snow Field, Desert, Lagoon, Rainforest, Dense Forest, Crystal Field. Each feature has a `score(elev, neighbours, temp, moisture)` function. Random directions are sampled and scored, and the top 3 per feature are kept, at least ~30° apart. If a feature finds fewer than 3, it is padded with jittered fallbacks. Each spot gets a unique name from `SPOT_NAMES`.
3. **Landmarks** (24): offset 8 m sideways from the landmark so you don't spawn inside it.
4. **Rivers**: one per river, at 40% along its path. This is the only part that awaits `riversPromise`.

## 12. Seed system

World seed is a pronounceable word (e.g. `KaliSeron`) stored in the URL as `?seed=KaliSeron`. The seed state lives in `core/config.ts` (not `main.ts`, so `ui/gui.ts` can import it without a circular dependency). `currentSeedWord` is read from the URL or generated by `genSeedWord()`; `hashSeedWord()` converts it to the 32-bit `S.seed` used by all noise functions. `pushSeedUrl(word)` updates both and rewrites the URL with `history.replaceState`. Changing the seed rebuilds the planet in place via `rebuild(respawn = true)` (§2).

---

## 13. Adding a plant kind

1. Add a geometry builder to `world/plantgeo.ts` (foliage) or `world/rockgeo.ts` (rocks).
2. Add one `plant({name, kind, tiers, gate, look})` entry to `world/plants.ts` with an unused `kind` number (also the `clusterField` index). Nothing else needs editing.

## 13a. Adding a tree species

1. Add a species builder `(r, q) => geometry` and a low-poly builder to `world/trees.ts`; append them to `SP` and `lowGeos()`.
2. Append an `EXTRA` leaf-colour entry (or add bark/leaf slots to every palette in `core/palette.ts`).
3. In `world/forest.ts`: add the index to `SP`, a trunk radius to `TRUNK`, and a branch in `pickSpecies()`.

---

## 14. Build & deploy

- `npm run dev`: Vite dev server on port 5173.
- `npm run build`: `tsc --noEmit`, then `vite build` (target `es2020`; `three` goes into its own `three-*.js` chunk).
- Vite `base` is `/planet-explorer/` to match the GitHub Pages path.
- `.github/workflows/deploy-pages.yml` builds on Node 24 with `npm ci` and deploys `dist/` to GitHub Pages on every push to `main` (or when run manually).
