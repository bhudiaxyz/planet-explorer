# Procedural Planet Explorer

A first-person explorer for a procedurally generated polygonal world, aiming for a balance of realism and abstraction. The goal is a living, believable planet you can walk, fly and drift across — terrain that reads as geology, weather that shifts, rivers that follow valleys, plants that cluster where the conditions suit them — without the fidelity cost of photorealism. Everything is generated at runtime from a single seed: terrain, plants, sky, weather, water and rivers, all computed on the GPU. Choose from 13 Solar System colour palettes to set the world's look and feel. Rivers trace valleys from high ground to sea, tapering into headwater streams — some branch into tributaries, some meander across the landscape, some pool into lakes. A startup scan identifies up to 30 terrain beauty spots (beach, canyon, island, mountain peak and more) and 24 procedural landmarks, all surfaced as one-tap teleports in a persistent Locations panel. Named rivers appear there too. Worlds are identified by a pronounceable seed word in the URL (e.g. `?seed=KaliSeron`). Quality adapts automatically to the device GPU across three tiers — high, medium and low — and adjusts dynamically at runtime.

Inspired by **Beyond Fable** and **threejs-procedural-planets**.

```sh
npm install
npm run dev        # development server
npm run build      # type-check + production bundle
```

**Desktop / laptop:** click to capture the mouse · WASD move · Shift sprint · Space jump / ascend · C descend · F cycle walk → drone → fly · L land · Q/E roll (fly) · M map · G toggle panels · Esc release mouse / close map

**Mobile / tablet:** left thumb joystick · right-side drag to look · ↑ ascend · ↓ descend · ⟲⟳ roll (fly only) · ⚡ sprint · ✈ cycle walk → drone → fly · 🛬 land · 🗺️ map · ☰ toggle panels

Works on desktop, laptop, mobile (Android / iOS) and tablet. Supports devices up to ~7 years old via GPU-tier detection.

## Highlights

- **One terrain function, two implementations.** The same noise runs on the CPU (physics, collision, river tracing) and the GPU (rendering, scatter). What you see is exactly what you stand on.
- **GPU scatter.** 15 plant kinds across three size bands. Placement is baked to a texture once; the vertex shader positions every instance with no CPU work per frame.
- **Rivers, streams and lakes.** Gradient descent traces paths down the height field. Three archetypes (stream / river / wide), optional tributaries, sinusoidal meanders with arc-length frequency and noise envelope, and noise-displaced lake perimeters.
- **No popping.** Ground cover fades at both edges of its draw range using IGN screen-door dithering. Tree LOD levels cross-fade as altitude changes. Shadows, weather and atmosphere all animate continuously.
- **Adaptive resolution.** Pixel ratio drops within 0.5 s of a frame-time spike and recovers cautiously once the frame rate is stable — no user input needed.
- **GPU tier detection.** The GPU is probed before the renderer is created so anti-aliasing, resolution, shadow quality and effects are correct from frame zero. Handles dual-GPU laptops, M-series Macs, iPadOS UA spoofing, and privacy-mode browsers.
- **Night systems.** Aurora (polar curtain, one draw call), fireflies (drift above humid terrain), bioluminescent motes (coastline glow, colour shifts with latitude), galactic band.
- **Trochoidal ocean.** Three overlapping Gerstner wave trains with analytic normals; wave size scales with wind speed.

## Module map

| Area | Directory / file | Role |
|------|-----------------|------|
| Entry | `main.ts` | Wires everything; runs the startup sequence and frame loop. |
| Core utilities | `core/` | Config constants, noise, palette, seed utilities, geometry math. |
| GPU tier | `render/gputier.ts` | Probes GPU before renderer creation; assigns high / medium / low tier. |
| Rendering | `render/` | Shared uniforms and shaders (`fx`), GPU bake helpers (`bake`), terrain material (`terrain`), post-processing chain (`postfx`, `aerialfx`), sun/moon shadows (`shadows`), tree material (`treemat`). |
| Planet | `world/planet.ts`, `world/chunks.ts` | Coarse planet mesh with cube-map surface; streamed high-detail terrain chunks. |
| Sky & atmosphere | `world/sky.ts`, `world/skyfx.ts`, `world/night.ts`, `world/precip.ts` | Sun/moon/weather state, cloud shell, aurora/fireflies/bioluminescence, GPU rain/snow. |
| Rivers & lakes | `world/river.ts` | Valley-tracing paths, meanders, tributaries, lakes; single animated water shader. |
| Trees | `world/forest.ts`, `world/trees.ts`, `world/treeutil.ts`, `world/geoutil.ts` | Clustered placement, three LOD levels, per-tree hue and shape variation. |
| Ground cover | `world/plants.ts`, `world/vegetation.ts`, `world/plantgeo.ts`, `world/rockgeo.ts` | 15 plant kinds with biome-specific placement gates. |
| Landmarks | `world/landmarks.ts` | 8 procedural landmark types placed at startup. |
| Player | `player/player.ts`, `player/touch.ts`, `world/collision.ts`, `world/footprints.ts` | Walk / drone / fly controller; collision; snow footprints; virtual joystick. |
| Locations | `world/spots.ts` | Terrain beauty-spot scanner; results populate the Locations panel. |
| UI | `ui/gui.ts`, `ui/map.ts` | lil-gui settings + Locations panel; fullscreen equirectangular planet map. |
