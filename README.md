# Procedural Planet Explorer

A first-person explorer for a procedurally generated spherical world (Three.js + TypeScript + Vite). Walk, drone, or fly across 13 Solar System planet palettes; terrain, plants, sky, weather, water and rivers are all generated at runtime entirely on the GPU. Rivers trace valleys from high ground to sea, tapering into headwater streams — some branch into tributaries, some meander across the landscape, some pool into lakes. A startup scan identifies up to 30 terrain beauty spots (beach, canyon, island, mountain peak and more) and 24 procedural landmarks (monolith rings, twisted spires, tombstone fields, floating islands, stone arches, crashed ships, basalt pillar fields and impact craters), all surfaced as one-tap teleports in a persistent Locations panel. Named rivers appear there too. Worlds are identified by a pronounceable seed word in the URL (e.g. `?seed=KaliSeron`). Quality adapts automatically to the device GPU across three tiers — high, medium and low.

Inspired by **Beyond Fable** [https://github.com/xikhar/beyond-fable] and **threejs-procedural-planets** [https://github.com/dgreenheck/threejs-procedural-planets].

The ground cover spans 15 plant kinds across three size tiers (small: grass/flowers/ferns/reeds/mushrooms/tall sedge; medium: shrubs/alpine scrub/cactus/dead scrub; large: rocks/rock slabs/frost rocks/boulders/crystals) so small plants never share fade distances with large ones. Cactus and dead scrub appear in desert regions; crystals cluster on high dry ground in alien-palette worlds; boulders gather on steep slopes. At night, fireflies drift above humid terrain; bioluminescent motes glow teal-to-blue near the poles and warm orange near the equator along coastlines and wet lowlands. Animated auroras shimmer at high latitudes after dark.

Works on desktop, laptop, mobile and tablet.

```sh
npm install
npm run dev        # development server
npm run build      # type-check + production bundle
```

**Desktop / laptop:** click to capture the mouse · WASD move · Shift sprint · Space jump / ascend · C descend · F cycle walk → drone → fly · L land · Q/E roll (fly) · M map · G toggle panels · Esc release mouse / close map

**Mobile / tablet:** left thumb joystick · right-side drag to look · ↑ ascend · ↓ descend · ⟲⟳ roll (fly only) · ⚡ sprint · ✈ cycle walk → drone → fly · 🛬 land · 🗺️ map · ☰ toggle panels

## Module map

| Area             | Files                                                     | Role                                                                                                                                                                     |
| ---------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Entry            | `main.ts`                                                 | Wires everything and runs the frame loop.                                                                                                                                |
| GPU tier         | `gputier.ts`                                              | Detects GPU capability at startup and assigns a quality tier (high / medium / low) that controls render resolution, shadow quality, draw distance, effects and footprints. |
| Settings         | `config.ts`, `gui.ts`                                     | User-tweakable settings; engineering constants; the settings panel and Locations quick-travel panel.                                                                     |
| Terrain          | `noise.ts`, `gpu.ts`                                      | Shared noise function used by both CPU physics and GPU rendering so what you see matches what you stand on. Biome colouring and vegetation density fields live here too.  |
| GPU compute      | `bake.ts`                                                 | Renders terrain heights, normals, colours and plant placement to textures once, then samples them cheaply every frame.                                                   |
| Planet           | `planet.ts`, `chunks.ts`, `landmarks.ts`, `skyfx.ts`     | Coarse planet mesh; streamed high-detail terrain chunks; 8 landmark types; clouds and sky dome.                                                                          |
| Trees            | `forest.ts`, `trees.ts`, `treeutil.ts`, `geoutil.ts`     | Clustered tree placement with three LOD levels; per-tree hue and shape variation.                                                                                        |
| Ground cover     | `plants.ts`, `vegetation.ts`, `plantgeo.ts`, `rockgeo.ts`| 15 plant kinds with biome-specific placement rules. Each kind declares its own geometry, LOD distances and placement conditions — adding a new kind requires editing only `plants.ts`. |
| Colour palettes  | `palette.ts`                                             | 13 Solar System planet palettes (biome colours, rock/plant/foliage tints, atmosphere, precipitation).                                                                   |
| Player           | `player.ts`, `collision.ts`, `footprints.ts`             | Walk / drone / fly controller, collision with terrain features, snow footprints.                                                                                         |
| Rivers & lakes   | `river.ts`                                               | River paths that follow valleys to the sea, with stream/river/wide width variants, tributaries, smooth meanders and optional terminating lakes. Distance-based LOD fades detail as you move away. |
| Locations        | `spots.ts`                                               | Scans the planet at startup for terrain archetypes (beach, canyon, island, cliffs, plains, snow field, desert, lagoon, rainforest, mountain peak) and named rivers. Results appear in the Locations panel. |
| Map              | `map.ts`                                                 | Fullscreen equirectangular planet map (M / 🗺️). Baked from the planet surface on first open; shows player position, compass, landmark icons and beauty-spot pins.       |
| Touch input      | `touch.ts`                                               | Virtual joystick and swipe-to-look for mobile/tablet. No-ops on desktop.                                                                                                 |
| Atmosphere       | `sky.ts`, `night.ts`, `precip.ts`                        | Sun/moon cycle, weather, stars, nebulae, GPU rain/snow, galactic band, dawn/dusk horizon. **Aurora**: animated curtain effect at high latitudes, strongest at night near the poles; colour sweeps red/orange at the horizon through green to purple overhead. **Fireflies** and **bioluminescent motes** are separate night systems with distinct colours and placement rules. All colours driven by the active palette. |
| Rendering        | `fx.ts`, `postfx.ts`, `aerialfx.ts`, `shadows.ts`       | HDR pipeline, aerial haze, bloom, adaptive resolution, sun and moon shadows.                                                                                             |

## Key ideas

- **GPU tier detection.** The GPU is probed before the renderer is created so the correct quality settings (resolution, anti-aliasing, shadow size, draw distance, effects) are applied from the very first frame. Quality also adapts dynamically at runtime — resolution drops within half a second of a frame-rate spike and recovers cautiously once the frame rate is stable again.

- **Rivers, streams and lakes.** Paths follow the steepest downhill direction on the height field until they reach sea level or merge with an existing river. Three width archetypes (stream, river, wide) produce variety; some rivers grow tributaries, some meander, and some terminate in lakes rather than the sea. A proximity filter prevents rivers from overlapping. Rivers and lakes share a single water shader with distance-based LOD.

- **One terrain function, two implementations.** The same noise function runs on the CPU for physics and collision, and on the GPU for rendering and scatter. What you see is exactly what you stand on — no seams, no approximations.

- **Bake once, sample cheaply.** Terrain heights, normals, colours, plant placement and planet surface appearance are rendered to textures when needed and sampled every frame. No geometry or heavy computation runs per frame.

- **No popping.** Everything fades rather than switches: ground cover fades in and out at both edges of its draw range, tree detail levels cross-fade as altitude changes, terrain chunks geomorph between LOD levels, and shadows, weather and atmosphere all animate continuously.

- **Clustering.** Smooth density fields control where each plant kind appears. Trees and mushrooms share a forest density field so the understory sits under the canopy; other kinds use per-species cluster fields. Cactus and dead scrub appear only in dry, low-lying desert; crystals appear on high, arid peaks; boulders and rocks cluster on steep slopes; reeds and tall sedge fringe shorelines.

- **Three movement modes.** Walk hugs the terrain with gravity and collision. Drone flies forward at a set height, terrain-following after hills and valleys, landing gradually on L. Fly is free-form with altitude-scaled speed and roll. F cycles between all three.

- **Spherical world on a flat renderer.** Nothing in Three.js knows the world is a sphere. The player's up vector follows the surface normal each frame; all positions are plain 3D Cartesian coordinates. No special coordinate transforms, no seams.

- **GPU scatter.** Each plant type bakes its placement data to a texture once; the GPU uses it to position every instance without any CPU involvement after the bake. Rejected instances cost nothing — they never reach the rasteriser.

- **Aurora as a single draw call.** The aurora is a large translucent shell centred on the camera. All curtain bands, vertical ray structure and time animation are generated entirely on the GPU — one mesh, one draw call, no per-ray geometry. Intensity scales with night darkness and polar latitude.

- **Two distinct night-light systems.** Fireflies drift above humid terrain around the camera, green-yellow in colour, and disappear in rain. Bioluminescent motes float along coastlines and wet lowlands, staying on damp ground; their colour shifts from teal-blue at the poles to warm orange near the equator.

- **Trochoidal water.** The ocean surface uses three overlapping wave trains with analytically computed normals. Wave size scales with wind speed so the ocean responds to weather. A fourth wave ring ripples outward from the player.

- **Instance-local wind bend.** Each tree's wind sway direction and phase are derived from its world position so neighbouring trees sway differently. Trunks stay fixed while crowns sway — computed entirely on the GPU with no per-tree CPU work.

## Performance notes

Quality is assigned at startup by GPU tier and adapts dynamically at runtime. The *render scale* slider in the settings panel overrides the upper limit. Other levers: forest density, grass density (in the Biomes panel), and advanced constants in `config.ts`.

Startup runs five steps: terrain → world setup → scouting → shader compile → ready. Scouting runs concurrently with world setup; shader compilation is deferred until all GPU baking is done. The frame loop starts before the "Click to enter" prompt so the first visible frame is already rendered when you click.
