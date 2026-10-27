# Planet Explorer — Design & Architecture

Developer reference for the procedural planet explorer. Covers architecture decisions, system internals, and implementation details. For a feature overview see [README.md](README.md).

---

## 1. Architecture overview

```
index.html
└── main.ts              ← entry point, frame loop, startup sequence
    ├── gputier.ts        ← probe → detect tier before renderer is created
    ├── config.ts         ← S (live settings) + CFG (engineering constants)
    ├── planet.ts         ← owns terrain chunks, cube maps, river system
    │   ├── noise.ts      ← CPU noise (shared with GPU via permutation texture)
    │   ├── gpu.ts        ← GLSL terrain function + density fields
    │   ├── bake.ts       ← render-to-texture helpers (heights, normals, colours)
    │   ├── chunks.ts     ← streamed LOD terrain patches
    │   ├── landmarks.ts  ← procedural landmark types
    │   └── river.ts      ← river/stream/lake generation and mesh
    ├── sky.ts            ← sun/moon/weather state
    ├── night.ts          ← aurora, fireflies, bioluminescent motes, galactic band
    ├── precip.ts         ← GPU rain/snow
    ├── player.ts         ← walk/drone/fly controller
    ├── collision.ts      ← terrain + scatter collision
    ├── vegetation.ts     ← GPU instanced scatter (reads from bake.ts)
    ├── plants.ts         ← plant kind catalog
    ├── plantgeo.ts       ← foliage geometry builders
    ├── rockgeo.ts        ← rock/boulder/crystal geometry builders
    ├── forest.ts         ← tree placement + LOD
    ├── trees.ts          ← procedural tree geometry
    ├── postfx.ts         ← EffectComposer chain + adaptive resolution
    ├── aerialfx.ts       ← aerial haze post-pass
    ├── shadows.ts        ← sun/moon shadow rigs
    ├── spots.ts          ← terrain beauty-spot scanner
    ├── map.ts            ← equirectangular planet map overlay
    ├── gui.ts            ← lil-gui settings + locations panel
    └── touch.ts          ← virtual joystick + swipe-look
```

**Key architectural decisions:**

- **Shared terrain function.** `noise.ts` (CPU) and `gpu.ts` (GLSL) implement the same `e3()` domain-warped fBm. Walking physics, collision, river tracing and GPU rendering all see the same world — no approximation seams.
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
7. Step 5 – warm-up     render one off-screen frame (uploads geometry/textures)
8. Start RAF loop       renderer.setAnimationLoop(…)
9. await one RAF        ensures first visible frame is rendered before splash shows
10. showSplash()
```

**Why this order:**

- Rivers and scouting start immediately after terrain because `findSpots` can scan terrain in parallel with river generation; it only awaits `riversPromise` at the very end to append river teleport entries.
- `compileAsync` is deferred until after all GPU baking. Baking and compiling both submit GPU work; running them together creates pipeline stalls on tiler GPUs. Deferring compile until baking is done avoids competing for the GPU queue.
- The warm-up frame renders to a 1×1 off-screen target — this uploads all geometry buffers and textures to the GPU so the first on-screen frame has no driver-side stall.
- The animation loop starts **before** the RAF yield. This guarantees the compositor has already been given a fully-rendered frame before the "Click to enter" button is shown, so clicking in is visually instant.

---

## 3. GPU tier detection (`gputier.ts`)

### Probe canvas

```ts
const probe = document.createElement("canvas");   // never appended to DOM
const gl = probe.getContext("webgl2") ?? probe.getContext("webgl");
// … detect …
(gl.getExtension("WEBGL_lose_context"))?.loseContext();  // free context slot immediately
```

Browsers enforce a hard limit (~16) on live WebGL contexts. The probe is created, used, then immediately destroyed via `WEBGL_lose_context` so it doesn't consume a context slot for the lifetime of the session.

### Renderer string matching

`WEBGL_debug_renderer_info` exposes the raw GPU renderer string (e.g. `"ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 Direct3D11 vs_5_0 ps_5_0, D3D11)"`). This is lowercased and tested against regexes:

**HIGH:**
```
rtx | rx [5-9]\d{3} | vega [5-9]\d | radeon vii | gtx 1[0-9]{3} | gtx 9[5-9]\d |
arc.{0,8}a[5-9]\d{2} | apple m\d+ | adreno.{0,8}(6[5-9]\d|7\d{2}|x\d) | xclipse
```
Covers: NVIDIA RTX, AMD RX 5000–9000 (RDNA 1–3), Intel Arc A5xx/A7xx, Apple M-series, Adreno 650–7xx (Galaxy S21+–S24+, Pixel 6+), Xclipse 920 (Exynos S22 Ultra), Adreno X1-85 (Snapdragon X Elite Copilot+ laptops).

**Apple GPU special case (checked before HIGH regex):**
- `"apple gpu"` in renderer string → check for touch:
  - No touch events → M-series Mac → `high`
  - `navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1` → iPadOS 13+ (UA spoofs desktop) → `high`
  - Otherwise (iPhone) → `medium`

**MEDIUM overrides (before LOW catch-all):**
- `mali[-\s]g7\d{2}` — Mali-G710/G715/G720 (Dimensity 9000+)
- `mali[-\s]g7[0-9]` — Mali-G72 (2017 flagships like Galaxy S9)
- `uhd.{0,12}6\d{2}` — Intel UHD 6xx (2018–2021 laptops)
- `iris plus` — Intel Iris Plus (MacBook Air/Pro 2018–2020)

**LOW:**
```
(uhd.{0,12}[2-5]\d{2}|hd graphics) | mali[-\s] | adreno.{0,8}[3-5]\d{2} |
videocore | powervr g[67] | sgx
```

**Fallback:** if `WEBGL_debug_renderer_info` is blocked (Firefox `resistFingerprinting`, privacy browsers) → `medium`. Defaulting to `low` would penalise an iPad Pro in privacy mode; `medium` is the safer guess.

### What each tier gates

| Feature | low | medium | high |
|---|---|---|---|
| Resolution (terrain) | 128 | 160 | 256 |
| Render scale | 0.60 | 0.75 | 1.5 (desktop) / 2.0 (mobile) |
| Terrain octaves | 4 | 5 | 6 (default) |
| Camera far plane | 20 000 m | 30 000 m | 40 000 m |
| MSAA samples | 0 | 2 | 4 |
| Bloom | off | on | on |
| Footprints | off | on | on |
| Shadow map size | 25% | 50% | 100% |
| Shadow Hz | 20 | 30 | 60 |
| Shadow frustum | 65% | 100% | 100% |
| Plant radius multiplier | 0.50 | 0.65 | 1.0 |
| River count / steps | ½ cfg | full | full |
| Lake generation | off | on | on |
| River meanders | off | Chaikin+sine | Chaikin+sine |
| Firefly count | 50 | 120 | 220 |
| Bio-mote count | 12 | 28 | 50 |
| Aurora subdivisions | 2 | 3 | 3 |
| River material | flat colour | animated shader | animated shader + foam |

---

## 4. Terrain system (`noise.ts`, `gpu.ts`, `bake.ts`)

### Noise parity

`Noise3` (CPU, `noise.ts`) and `pn()` (GLSL, `gpu.ts`) use the same 512-entry permutation table. The table is uploaded as a `DataTexture` and sampled with `texelFetch`. Every shader that calls `pn()` produces bit-for-bit the same values as the CPU `Noise3.get()`, so walking physics, river tracing and GPU scatter all inhabit the same world.

### Terrain function `e3()`

Domain-warped fBm:
1. Sample three perpendicular noise calls to compute a warp offset (~25% of base frequency).
2. Shift the sample point by that offset.
3. Run standard fBm on the shifted point.

Without warping, Perlin fBm produces axis-aligned ridges. The warp makes terrain tilt, overhang and meander without smearing fine detail.

### Mountain ridges

Mountain contribution: `(1 - |fbm * 2|)²`

This maps the smooth fBm zero-crossings into sharp ridge peaks. A low-frequency smooth mask (`sm_()`) confines ridges to designated mountain zones, leaving lowlands and ocean floors unaffected.

### `sm_()` — smoothstep as a biome tool

Rather than only using `smoothstep` for visual fades, the terrain function uses `sm_()` (a remapped smoothstep returning 0–1) everywhere a continuous biome transition is needed: beach width, biome blending, underwater colour depth, mountain masking. Every boundary in the world is a gradient, not a threshold.

### `hs()` hash

Per-instance randoms in vegetation shaders:
```glsl
fract(dot(fract(vec3 * 0.1031), vec3(…)))
```
Two `fract` and one `dot` — no texture lookup, no integer trickery. Produces visually uncorrelated values per `(I, J, face)` grid cell.

### `basis()` — cube-face frame from a float

The GPU scatter system encodes cube face identity as a single float constant `uSC.z`. The vertex shader recovers face normal + two tangents via `fc / 2` and `fc % 2` integer decode. One consistent local frame per tile, no per-face branching in the draw call.

### Cube-map planet surface

The coarse planet mesh uses cube maps (512² per face, mipmapped) for colour and normal+AO, baked once from the full terrain function. This replaces an older per-vertex colour approach that produced a visible triangle grid, seams at cube-face boundaries, and shimmering as the camera moved. The cube map matches the detail chunks at all altitudes.

---

## 5. River & lake generation (`river.ts`)

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

### Smoothing

On `medium`/`high` tier only:
1. Sinusoidal meander displacement: two overlapping frequencies (primary + secondary at 1.7× primary) produce irregular natural bends. Amplitude increases toward the mouth. Envelope fades in at the source (first 20% of path) and out at the mouth (last 15%).
2. Two rounds of Chaikin corner-cutting: replaces each segment midpoints with points at ¼ and ¾, preserving source and mouth.

On `low` tier both steps are skipped (saves CPU and memory).

### Source taper (geometry)

```ts
const taper = Math.min(t / 0.15, 1) * (t > 0.85 ? (1 - t) / 0.15 : 1);
const width = (widthStart + (widthEnd - widthStart) * t²) * taper * scale;
```

Width tapers to zero at the source tip (first 15%) and at the mouth (last 15%), widening quadratically in between.

### Proximity filter

After all paths are generated:
- **Main rivers**: a path is rejected if more than 50% of its points are within 16 m² of an already-accepted main river.
- **Tributaries**: stricter — rejected if more than 40% overlap any accepted path (main or tributary).

Uses `distanceToSquared` with early-exit — no `sqrt` in the inner loop.

### Lake generation (skipped on `low` tier)

- Up to 2 lakes per planet.
- Placement criteria: elevation 0.005–0.07, moisture ≥ 0.45, minimum 120 m from existing rivers and other lakes.
- Shape: `radius` 50–120 m, random `aspect` 0.55–1.45 (ellipse distortion).

### Lake geometry

Disc fan, 48 segments. UV encoding:
- Centre vertex: `uv = (0.5, 2.0)`
- Perimeter vertices: `uv = (1.0, 2.0)`

`vUv.y > 1.5` in the fragment shader branches between lake and river behaviour — a single draw call handles both.

### Shader

**Rivers:** `vUv.y` runs 0→1 along the flow direction. UV-scroll `fract(vUv.y - uTime * flowSpeed)` drives the flow animation. `flowSpeed` varies between 0.9 (streams) and 0.2 (wide rivers).

**Lakes:** `vUv.x` runs 0.5 (centre) → 1.0 (edge). UV pattern `fract((vUv.x - 0.5) * 7.0 - uTime * 0.5)` produces expanding concentric ripple rings.

**LOD:**
- Lake fragments discarded if camera distance > 700 m.
- Foam gate (`uHighDetail > 0.5`) skipped if lake distance > 150 m.
- Lake shore fade: `(1 - smoothstep(0.75, 1.0, vUv.x)) × (1 - smoothstep(500, 700, lakeDist))`.

**Low tier material:** flat `MeshBasicMaterial` (no shader cost at all).

---

## 6. Ground cover system

### Plant catalog pattern (`plants.ts`)

Each of 15 plant kinds is one `plant({...})` call declaring:
- `tiers`: array of `tier(geoFn, cellSize, radius, lodBand, …)` — one per LOD level.
- `gate`: GLSL snippet that returns `true` to reject an instance (e.g. wrong biome).
- `look`: GLSL snippet for per-instance colour/scale variation.
- `pre`: optional early-exit rejection before the gate (elevation quick-check).

Adding a new plant kind requires only this one entry — nothing else changes.

### LOD band sets (`config.ts`)

Three band sets, each with its own cell size and fade distances:
- **near** (grass-scale): cell ≈ 0.85–4.5, tight fade distances.
- **shrub** (medium): cell ≈ 4.25–17, wider fades.
- **rock** (large): cell ≈ 4.25–34, furthest fades (boulders at 8.5–34).

Sizes never compete because each set has its own independently configured `plantLod` / `plantRadius` pair in `config.ts`.

### Placement bake

One 8-bit texel per instance cell. A bake-pass shader evaluates elevation, moisture, slope and cluster density in GLSL, writing either a height value (accepted) or a sentinel (rejected). The vertex shader reads the texel; rejected instances are collapsed to `vec3(0)` — a degenerate point that the GPU clips away with zero fill-rate cost. The CPU never iterates per-instance data after bake.

### Density fields (`gpu.ts`)

- `treeDensity(dir)`: shared by trees, ferns and mushrooms — understory follows the forest.
- `clusterField(kind, dir)`: per-species smooth density patch. Each plant kind has its own characteristic cluster scale and shape.
- `forestMask`, `groveMask`: broad masks that modulate `treeDensity`.

### Plant-specific placement gates

| Plant | Gate condition |
|---|---|
| Grass | Open ground, moist, gentle slope |
| Flowers | Similar to grass, narrower moisture band |
| Ferns | High `treeDensity`, moisture |
| Reeds | Shoreline elevation band (e: −0.03 to 0.025) |
| Mushrooms | High `treeDensity` (damp forest floor) |
| Shrubs | Moderate slope, moisture |
| Alpine scrub | High elevation, exposed |
| Cactus | Moisture < 0.2, elevation < 0.18 (low-lying desert) |
| Dead scrub | Similar to cactus, drier |
| Tall sedge | Shoreline/wetland fringe (e: 0.01 to 0.06) |
| Rocks | Steep slope, cluster field |
| Rock slabs | Moderate slope, lower elevation than rocks |
| Frost rocks | High elevation, cold biome |
| Boulders | Steep slope (cell size 2× rocks — appear further apart) |
| Crystals | High elevation + low moisture (alien-palette worlds) |

### IGN dithering — uncorrelated offsets

Both the outer fade (plant appearing at range limit) and inner fade (plant disappearing as a finer tier takes over) use Interleaved Gradient Noise screen-door dithering. The two fades use **different seed offsets**. If they shared a seed, both stipple patterns would align and the overlap band would look solid instead of blended.

### Geometry files

- `plantgeo.ts`: foliage geometry (grass, flowers, ferns, reeds, shrubs, alpine scrub, cactus, dead scrub, tall sedge, mushrooms). Parts marked `leaf = true` get per-leaf hue from the shader.
- `rockgeo.ts`: rock, rock slab, frost rock, boulder and crystal geometry. Separate file because rocks use a different shading path (no `leaf` tint, different normal handling).

---

## 7. Tree system (`forest.ts`, `trees.ts`)

- Three LOD tiers: hi-poly close, mid-poly mid-altitude, low-poly billboard-like at distance.
- LOD levels cross-fade over ~0.4 s as altitude changes — no discrete pop.
- Per-tree hue and shape seeded from instance world position for variety.

**Instance-local wind bend:**
The wind function hashes the tree's world position (extracted from `instanceMatrix[3]`) to derive a unique phase and bend direction per tree. The height term `max(lp.y, 0.0)` ensures only the upper part of the mesh deforms — trunks stay fixed, crowns sway. Computed entirely in the vertex shader before Three.js applies `instanceMatrix`.

---

## 8. Night systems (`night.ts`)

### Aurora

- Geometry: `IcosahedronGeometry(16000, subdivision)` centred on camera each frame, `BackSide`, additive blending, `frustumCulled = false`. Subdivision: 2 on `low`, 3 on `medium`/`high`.
- Vertex shader: passes normalized position as `vD` (view direction vector).
- Fragment shader:
  - `e = dot(vD, uUp)` — elevation relative to player's up vector (0 = horizon, 1 = zenith).
  - `az = atan(dot(vD, uR), dot(vD, uF))` — azimuth around the player's local frame.
  - Two noise calls: `n(az*3 + uT*0.05, uT*0.1)*2 + n(az*9, uT*0.3)` warps azimuth for curtain bands.
  - `c = pow(|sin(az*2 + warp + uT*0.15)|, 3)` — curtain intensity.
  - `b = smoothstep(0.04, 0.22, e) * (1 - smoothstep(0.4, 0.75, e))` — altitude gate (horizon band).
  - `ray = n(az*40, e*3 - uT*0.5)` — high-frequency vertical ray texture.
  - Colour: `e < 0.15` → `mix(red/orange, green, e/0.15)`; `e ≥ 0.15` → `mix(green, purple, smoothstep(0.15, 0.6, e))`.
  - Intensity gate: `uAmt = night × smoothstep(0.1, 0.45, |player.up.y|)` — polar latitude.

### Fireflies

- Count: 50 / 120 / 220 by tier.
- 80 m cube anchored to camera, wrapping via `mod()` so motes appear continuous.
- Vertex shader samples the terrain function to hover each mote above the surface. Sinusoidal drift per mote with per-seed phase.
- Additive `gl_PointSize` points; colour: `mix(green-yellow, warm-white, dayF*8)`.
- Visible condition: `intensity > 0.02 || dayF > 0.1`. Gates: night × altitude × no heavy rain.

### Bioluminescent motes

- Count: 12 / 28 / 50 by tier.
- 60 m grid anchored to camera.
- Vertex shader evaluates moisture (gate: 0.2–0.45) and land flag (`step(0.0, elev)`) — dry or high-altitude cells get `gl_PointSize = 0`.
- Slow sinusoidal drift (amplitude ~0.3–0.4 m, vs ~0.8 m for fireflies).
- Colour: `coolCol = mix(teal, blue, moisture)`, then `mix(coolCol, orange, warmth * 0.65)` where `warmth = 1 - |d.y|` (equatorial factor).
- `gl_PointSize` scaled by `uNight` — invisible in daylight.

---

## 9. Water & ocean (`fx.ts`)

- 3 Gerstner (trochoidal) wave trains superposed in the vertex shader.
- Surface normals computed analytically per wave train — no finite-difference approximation needed.
- Wave amplitude and frequency scaled by `uWind` uniform so the ocean responds to weather changes in real time.
- 4th additive displacement: a player-ripple ring expanding outward from `uPl` (player world position).

---

## 10. Rendering pipeline

### EffectComposer chain (`postfx.ts`)

```
RenderPass          → scene to HDR render target (HalfFloatType + DepthTexture)
ShaderPass (clean)  → clamp NaN/Inf pixels (one NaN in a float target smears across bloom blur)
AerialPass          → aerial haze post-pass (aerialfx.ts)
UnrealBloomPass     → half-resolution bloom (disabled on low tier)
OutputPass          → tone-map + gamma to canvas
```

### HDR render target

`HalfFloatType` for the colour target. MSAA samples: 0 (low) / 2 (medium) / 4 (high). A `DepthTexture` is attached so `AerialPass` can reconstruct linear depth without a second geometry pass.

### Aerial perspective (`aerialfx.ts`)

Reads the depth texture, reconstructs linear depth, blends haze using `exp(-depth * density)`. Haze colour is atmosphere scatter tint by day, deep blue by night. Runs as a post-pass so it handles transparent objects and particles correctly with no geometry cost.

### Adaptive resolution (`postfx.ts`)

Pixel ratio range: `[0.5, renderScale]` (renderScale set at startup by tier).
- Downscale: reacts within 0.5 s of a frame-time spike (smoothed frame time > 33 ms). Drops 0.15 per step, minimum 0.5.
- Upscale: waits 3 s of stable frames (< 18.5 ms) before recovering. Rises 0.1 per step, capped at renderScale.

The asymmetry prevents oscillation: load spikes (descent into dense terrain) react quickly; the renderer doesn't ping-pong near the threshold.

### Shadows (`shadows.ts`)

- `shadowMap.autoUpdate = false` — Three.js does not automatically re-render the depth pass.
- `needsUpdate = true` once per throttle tick: 20 Hz (low) / 30 Hz (medium) / 60 Hz (high). Sun and moon share the same `needsUpdate` call — both shadow maps update together, both benefit from the same budget.
- **Shadow texel-snapping**: before uploading the ortho frustum to the GPU, the frustum centre is quantised to shadow-map texel steps:
  ```ts
  target -= right * (cam.dot(right) % texelSize);
  target -= up    * (cam.dot(up)    % texelSize);
  ```
  Without this, sub-texel drift as the camera moves causes every shadow edge to crawl one texel per frame (shadow shimmer). The snap eliminates the artefact with ~3 lines of code.
- Shadow frustum half-extent: 65% of full size on `low` tier to reduce depth-pass cost on small shadow maps.

---

## 11. Settings & Locations panels (`gui.ts`)

### Settings panel (right side)

Created by `new GUI({ title: "Planet settings", … })` using lil-gui. lil-gui sets `z-index: 1001` on `.lil-gui.root` by default, so it renders above all page content including the loading splash.

**Startup state:** `gui.close()` is called immediately after creation — the panel starts collapsed to its title bar and must be opened by the user (or via G).

**Item order** (top to bottom as rendered):
1. 🎲 New random world — picks a random seed + weather, rebuilds
2. 🪐 Planet palette — dropdown over 13 palettes; triggers rebuild + vegetation refresh
3. **Terrain** folder — seed word, radius, resolution, amplitude, frequency, octaves, persistence, lacunarity, mountains, seaLevel
4. **Biomes** folder — forest density, snowline, per-biome colour pickers (sand/grass/forest/rock/snow/water)
5. **Sky & weather** folder — timeOfDay (live), dayLength, wind, windSway, cloudiness, renderScale, weather; `touchLookSensitivity` added on touch devices only
6. Cycle walk / drone / fly (F)
7. Land (L)

**G key** toggles both the settings panel and the Locations panel together (shows if hidden, hides if shown).

### Locations panel (left side)

Created only when `spots.length > 0`. Width: 110 px (desktop) / 120 px (touch).

**Positioning:**
```ts
position: "fixed", top: "78px", left: "10px", zIndex: "49"
```
`z-index: 49` places it **below** the loading splash (`z-index: 50`). The panel is invisible while the splash is opaque and fades in naturally as the splash transitions to `opacity: 0` on entry. This prevents a visible grey band on the left during the loading screen.

**Structure:** ungrouped spots (fixed poles, terrain features) render flat; grouped spots (landmark types, rivers) go into collapsible subfolders that start closed.

**Touch:** panel width 120 px, `--widget-height: 44px`, `maxHeight: calc(100dvh - 90px)`, `overflowY: auto`, and hidden by default (`locs.hide()`). The ☰ button in the HUD shows/hides it.

---

## 12. Adding a plant kind

1. Add a geometry builder to `plantgeo.ts` (foliage) or `rockgeo.ts` (rocks). Mark leaf faces `leaf = true` if the shader should tint them.
2. Add one `plant({name, tiers, gate, look})` entry to `plants.ts`. Nothing else needs editing.

## 12. Seed system

World seed is a pronounceable word (e.g. `KaliSeron`) stored in the URL as `?seed=KaliSeron`. `hashSeedWord()` converts it to a 32-bit integer used by all noise functions. Changing the seed rebuilds the planet in place via `rebuild(respawn = true)`.
