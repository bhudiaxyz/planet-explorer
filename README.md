# Procedural Planet Explorer

A first-person explorer for a procedurally generated spherical world (Three.js + TypeScript + Vite). Walk, drone, or fly across 13 Solar System planet palettes; terrain, plants, sky, weather and water are all generated at runtime, and most per-pixel / per-vertex work runs on the GPU. A startup scan identifies terrain landmarks (beach, canyon, island, mountain peak and more) and surfaces them as one-tap teleports in a persistent Locations panel.

Works on desktop, laptop, mobile and tablet.

```sh
npm install
npm run dev        # development server
npm run build      # type-check + production bundle
```

**Desktop / laptop:** click to capture the mouse · WASD move · Shift sprint · Space jump / ascend · C descend · F cycle walk → drone → fly · L land · Q/E roll (fly) · M map · G toggle panels · Esc release mouse / close map

**Mobile / tablet:** left thumb joystick · right-side drag to look · ↑ ascend · ↓ descend · ⟲⟳ roll (fly only) · ⚡ sprint · ✈ cycle walk → drone → fly · 🛬 land · 🗺️ map · ☰ toggle panels

## Module map

| Area             | Files                                                | Role                                                                                                                                                    |
| ---------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entry            | `main.ts`                                            | Wires everything and runs the frame loop (movement in ≤33 ms sub-steps).                                                                                |
| Settings         | `settings.ts`, `config.ts`, `gui.ts`                 | User-tweakable settings (including wind sway intensity); engineering constants (LOD bands, chunk size, tree count…); the settings panel and the Locations quick-travel panel.                |
| Terrain function | `noise.ts`, `gpu.ts`                                 | Perlin noise on the CPU **and** the same function in GLSL (permutation table uploaded as a texture), biome colouring, shared vegetation density fields. |
| GPU compute      | `bake.ts`                                            | Render-to-texture helpers: chunk height/normal/colour bakes, bulk point sampling, planet cube maps, small read-backs for collision.                     |
| Planet           | `planet.ts`, `chunks.ts`, `landmarks.ts`, `skyfx.ts` | Coarse planet mesh + cube maps; streamed 1.5 m terrain chunks (pooled, faded, geomorphed); landmarks and floating islands; clouds and sky dome.         |
| Trees            | `forest.ts`, `trees.ts`, `geoutil.ts`                | Clustered tree placement, three-tier LOD, per-tree hue/shape; procedural tree geometry and materials.                                                   |
| Ground cover     | `plants.ts`, `vegetation.ts`, `plantgeo.ts`          | **Plant catalog** (one entry per plant type: geometry tiers + GLSL placement/look snippets) and the GPU scatter that renders it. Ferns and shrubs have a dedicated close-range detail tier for richer geometry at short distances.                        |
| Colour palettes  | `palette.ts`                                         | 13 Solar System planet palettes (biome colours, rock/plant/foliage tints, atmosphere, precipitation). `setPalette()` mutates the live `biomeColors` object so every system picks up the change on next rebuild. |
| Player           | `player.ts`, `collision.ts`, `footprints.ts`         | Walk / drone / fly controller, collision with trees/rocks/shrubs/landmarks, snow footprints.                                                            |
| Locations        | `spots.ts`                                           | Scans the planet surface at startup to find up to 10 terrain archetypes (beach, canyon, island, cliffs, plains, snow field, desert, lagoon, rainforest, mountain peak) plus fixed poles and equatorial waypoints. Results feed the Locations panel. |
| Map              | `map.ts`                                             | Fullscreen equirectangular planet map (M key / 🗺️ button). Baked from the cube-map atlas on first open; gamma-corrected, normal+AO shaded (fixed sun + ambient occlusion from the normal cube map) and saturation-boosted so colours match the in-scene palette. Player position shown as an orange dot updated every frame. |
| Touch input      | `touch.ts`                                           | Virtual nipplejs joystick (left half) + swipe-to-look (right half) + mode-aware action buttons (including 🗺️ map) for mobile/tablet. No-ops on desktop. |
| Atmosphere       | `sky.ts`, `night.ts`, `precip.ts`                    | Sun/moon/weather state, parallax stars and nebulae, aurora, fireflies, GPU rain/snow, galactic band with Great Rift, dawn/dusk horizon band, moisture-gated bioluminescent motes — all colours driven by `CurrentPalette`. |
| Rendering        | `fx.ts`, `postfx.ts`, `aerialfx.ts`, `shadows.ts`   | Shared shader materials and uniforms (`U`); HDR post chain (aerial perspective → bloom) with adaptive resolution; sun and moon shadow rigs with throttled depth-pass updates. |

## Key ideas

- **One terrain function, two implementations.** Walking height, tree placement and all GPU placement use the same noise (`noise.ts` ↔ `gpu.ts`), so what you see is what you stand on.
- **Bake once, sample cheaply.** Chunk heights/normals/colours, plant placement, planet colours/normals (cube maps) and tree candidates are computed on the GPU only when needed, never per frame.
- **No popping.** Ground cover tiers fade in/out at both their outer and inner edges via IGN screen-door dithering; hi/mid tree detail tiers cross-fade smoothly over ~0.4 s as altitude changes; terrain chunks fade and geomorph between LOD levels; shadows, weather, vegetation density and atmosphere all animate instead of switching.
- **Clustering.** `gpu.ts` defines smooth density fields (`forestMask`, `groveMask`, `treeDensity`, `clusterField`). Trees, ferns and mushrooms share `treeDensity` so the understory sits under the forests; shrubs, rocks, flowers, cactus, dead scrub, reeds and tall sedge use their own `clusterField(kind)` patches; grass carpets open, moist, gentle ground.
- **Three movement modes.** Walk hugs the terrain with gravity and collision. Drone flies forward continuously at a set height above the ground — A/D steers, Space/C adjusts hover height, terrain-following smoothly corrects after hills and valleys, L initiates a gradual descent to walk. Fly is free-form with altitude-scaled speed and roll. F cycles between all three; L lands from drone or fly.
- **Spherical world on a flat renderer.** Nothing in Three.js knows the world is a sphere. The player's `up` vector is recalculated from the surface normal each frame; the camera follows suit. All positions are world-space Cartesian; the "ground" is just wherever the terrain function puts it on the unit sphere scaled by radius. No coordinate-system transforms, no seams.
- **GPU scatter: placement texture, not CPU lists.** Each ground-cover tier runs a bake pass (one 8-bit texel per instance cell) that computes elevation, moisture, slope and cluster density in GLSL and writes a reject sentinel or a height value. The vertex shader reads that texel; rejected instances collapse to a degenerate point. The CPU never touches per-instance data after the bake — it only decides when the lattice has moved far enough to re-bake.
- **Shadow texel-snapping.** The ortho shadow frustum is quantised to shadow-map texel steps before being uploaded to the GPU. Without this, sub-texel drift as the camera moves causes every shadow edge to crawl one texel per frame. The snap is ~3 lines in `shadows.ts` and eliminates the artefact entirely.
- **One `needsUpdate` covers all shadow lights.** Three.js `renderer.shadowMap.autoUpdate = false` disables the depth pass. Setting `needsUpdate = true` once per throttle tick (≈30 Hz) re-renders every `castShadow` light in one go — sun and moon share the same budget, and the depth pass never runs on frames where nothing moved.
- **Cube-map planet surface.** The coarse planet mesh used to carry per-vertex colours. That produced a visible triangle grid, seams at cube-face boundaries, and shimmering at altitude as the camera moved. Now colour and normal+AO are baked per pixel (512² per face, full terrain function) into mipmapped cube maps in `bake.ts`. The coarse mesh samples those maps; the result matches the detailed chunks and stays stable from orbit to ground level.
- **Aerial perspective as a post-pass.** `aerialfx.ts` reconstructs linear depth from the depth texture and blends a haze colour (atmosphere scatter by day, deep blue by night) using `exp(-depth * density)`. Because it runs after the scene render, it has no geometry cost and handles transparent objects and particles correctly.
- **Trochoidal water with analytic normals.** `waterFx()` in `fx.ts` superposes three Gerstner wave trains in the vertex shader, computing surface normals analytically rather than by finite difference. Each train's amplitude and frequency are scaled by wind speed so the ocean responds to weather. A player-ripple ring is added as a fourth additive displacement around `uPl`.
- **Instance-local wind bend.** `wind()` hashes the instance world position (extracted directly from `instanceMatrix[3]`) to derive a unique per-tree phase and bend direction. The height term `max(lp.y, 0.0)` means trunks stay fixed while crowns sway — achieved entirely in the vertex shader before `instanceMatrix` is applied by Three.js's `project_vertex`.
- **IGN dithering with uncorrelated offsets.** Both the outer fade (plant appearing at distance) and the inner fade (plant disappearing as a finer tier takes over) use Interleaved Gradient Noise screen-door dithering — but with different seed offsets so the two stipple patterns are uncorrelated. If they shared a seed, inner and outer discard patterns would align and the overlap band would look solid rather than blended.

## Noise and rendering algorithms

- **Permutation table as a texture.** `Noise3` stores its shuffled permutation in a `Uint8Array`. The same 512-entry table is uploaded to the GPU as a `DataTexture` and sampled with `texelFetch` in `pn()`. Every GLSL shader that calls `pn()` produces bit-for-bit the same values as the CPU `Noise3.get()` — player physics, chunk baking and GPU scatter all see the same world.
- **Domain-warped fBm terrain.** `e3()` shifts the sample point by three perpendicular noise calls before the main fBm. Without warping, Perlin fBm produces axis-aligned ridges; with it, terrain tilts, overhangs, and meanders in all directions. The warp amplitude is ~25 % of the base frequency so it deforms without smearing fine detail.
- **Ridged noise for mountains.** The mountain contribution is `(1 - |fbm * 2|)²`, which maps the smooth fBm into sharp ridges at zero-crossings. A separate low-frequency smooth mask (`sm_`) confines the ridges to designated mountain zones, leaving lowlands unaffected.
- **`hs()` — the cheap 3-input hash.** Every per-instance random in the vegetation vertex shader (`h1`–`h7`) comes from a single `fract(dot(fract(vec3 * 0.1031), …))` call. No texture lookup, no integer trickery — just two `fract` and one `dot`, producing visually uncorrelated values per (I, J, face) cell.
- **`basis()` — cube-face frame from a float.** The scatter system encodes which of the 6 cube faces a tile belongs to as a single float constant (`uSC.z`). The vertex shader recovers the face normal and two tangent vectors with a short integer decode (`fc / 2`, `fc % 2`). This gives every tile a consistent local frame for placing instances without branching on face identity at the draw-call level.
- **`sm_()` — smoothstep as a first-class tool.** Rather than using `smoothstep` only for visual fades, the terrain function uses `sm_()` (a remapped smoothstep) everywhere a continuous 0–1 transition is needed: biome blending, mountain masking, beach width, underwater colour depth. The result is that every boundary in the world is a smooth gradient rather than a threshold.

## Adding a plant

1. Add a geometry builder in `plantgeo.ts` (foliage parts use `leaf = true` so the shader supplies the hue).
2. Add one `plant({...})` entry in `plants.ts`: tiers (cell size, radius, LOD band), a `pre` rejection, a `gate`, and a `look` snippet. Nothing else needs editing.

## Performance notes

Frame time is dominated by fill rate; the default render scale is 1.0 and adapts down automatically within 0.5 s of a frame-time spike (panel: _render scale_). Other levers: forest density, the grass tiers in `plants.ts`, and `CFG` in `config.ts` (key knobs: `chunk.budget`, `shadow.half`, `treeLod`).
