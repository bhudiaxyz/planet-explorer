# Procedural Planet Explorer

A first-person explorer for a procedurally generated spherical world (Three.js + TypeScript + Vite). Walk or fly across 13 Solar System planet palettes; terrain, plants, sky, weather and water are all generated at runtime, and most per-pixel / per-vertex work runs on the GPU.

Works on desktop, laptop, mobile and tablet.

```sh
npm install
npm run dev        # development server
npm run build      # type-check + production bundle
```

**Desktop / laptop:** click to capture the mouse · WASD move · Shift sprint · Space jump / ascend · C descend (fly) · F walk⇄fly · Q/E roll (fly) · G toggle panel · Esc release mouse

**Mobile / tablet:** left thumb joystick to move · right-side drag to look · ↑ ascend · ↓ descend · ⟲⟳ roll (fly) · ⚡ sprint · ✈ walk⇄fly · ☰ toggle panel

## Module map

| Area             | Files                                                | Role                                                                                                                                                    |
| ---------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entry            | `main.ts`                                            | Wires everything and runs the frame loop (movement in ≤33 ms sub-steps).                                                                                |
| Settings         | `settings.ts`, `config.ts`, `gui.ts`                 | User-tweakable settings; engineering constants (LOD bands, chunk size, tree count…); the settings panel.                                                |
| Terrain function | `noise.ts`, `gpu.ts`                                 | Perlin noise on the CPU **and** the same function in GLSL (permutation table uploaded as a texture), biome colouring, shared vegetation density fields. |
| GPU compute      | `bake.ts`                                            | Render-to-texture helpers: chunk height/normal/colour bakes, bulk point sampling, planet cube maps, small read-backs for collision.                     |
| Planet           | `planet.ts`, `chunks.ts`, `landmarks.ts`, `skyfx.ts` | Coarse planet mesh + cube maps; streamed 1.5 m terrain chunks (pooled, faded, geomorphed); landmarks and floating islands; clouds and sky dome.         |
| Trees            | `forest.ts`, `trees.ts`, `geoutil.ts`                | Clustered tree placement, three-tier LOD, per-tree hue/shape; procedural tree geometry and materials.                                                   |
| Ground cover     | `plants.ts`, `vegetation.ts`, `plantgeo.ts`          | **Plant catalog** (one entry per plant type: geometry tiers + GLSL placement/look snippets) and the GPU scatter that renders it.                        |
| Colour palettes  | `palette.ts`                                         | 13 Solar System planet palettes (biome colours, rock/plant/foliage tints, atmosphere, precipitation). `setPalette()` mutates the live `biomeColors` object so every system picks up the change on next rebuild. |
| Player           | `player.ts`, `collision.ts`, `footprints.ts`         | Walk/fly controller, collision with trees/rocks/shrubs/landmarks, snow footprints.                                                                      |
| Touch input      | `touch.ts`                                           | Virtual nipplejs joystick (left half) + swipe-to-look (right half) + action buttons for mobile/tablet. No-ops on desktop.                              |
| Atmosphere       | `sky.ts`, `night.ts`, `precip.ts`                    | Sun/moon/weather state, parallax stars and nebulae, aurora, fireflies, GPU rain/snow — all colours driven by `CurrentPalette`.                          |
| Rendering        | `fx.ts`, `postfx.ts`, `shadows.ts`                   | Shared shader materials and uniforms; HDR post chain with adaptive resolution; sun and moon shadow rigs with throttled depth-pass updates.              |

## Key ideas

- **One terrain function, two implementations.** Walking height, tree placement and all GPU placement use the same noise (`noise.ts` ↔ `gpu.ts`), so what you see is what you stand on.
- **Bake once, sample cheaply.** Chunk heights/normals/colours, plant placement, planet colours/normals (cube maps) and tree candidates are computed on the GPU only when needed, never per frame.
- **No popping.** Ground cover tiers fade in/out at both their outer and inner edges via IGN screen-door dithering; hi/mid tree detail tiers cross-fade smoothly over ~0.4 s as altitude changes; terrain chunks fade and geomorph between LOD levels; shadows, weather, vegetation density and atmosphere all animate instead of switching.
- **Clustering.** `gpu.ts` defines smooth density fields (`forestMask`, `groveMask`, `treeDensity`, `clusterField`). Trees, ferns and mushrooms share `treeDensity` so the understory sits under the forests; shrubs, rocks, flowers, cactus, dead scrub, reeds and tall sedge use their own `clusterField(kind)` patches; grass carpets open, moist, gentle ground.

## Adding a plant

1. Add a geometry builder in `plantgeo.ts` (foliage parts use `leaf = true` so the shader supplies the hue).
2. Add one `plant({...})` entry in `plants.ts`: tiers (cell size, radius, LOD band), a `pre` rejection, a `gate`, and a `look` snippet. Nothing else needs editing.

## Performance notes

Frame time is dominated by fill rate; the default render scale is 1.0 and adapts down automatically within 0.5 s of a frame-time spike (panel: _render scale_). Other levers: forest density, the grass tiers in `plants.ts`, and `CFG` in `config.ts` (key knobs: `chunk.budget`, `shadow.half`, `treeLod`).
