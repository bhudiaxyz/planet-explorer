# Procedural Planet Explorer

A first-person explorer for a procedurally generated polygonal planet, balancing realism and abstraction. Walk, fly and drift across a living world — terrain that reads as geology, weather that shifts, rivers that follow valleys, plants that cluster where conditions suit them — without the fidelity cost of photorealism.

Everything is generated at runtime from a single pronounceable seed word in the URL (e.g. `?seed=KaliSeron`), and runs in the browser on desktop, laptop, phone and tablet.

**Live demo:** [bhudiaxyz.github.io/planet-explorer](https://bhudiaxyz.github.io/planet-explorer/)

Inspired by **Beyond Fable** and **threejs-procedural-planets**.

## Highlights

- **Whole planet from one seed.** Terrain, biomes, plants, sky, weather, water and rivers, all generated on the GPU.
- **13 Solar System palettes.** From Earth to Mercury and out to Pluto and Haumea, each palette gives the world its own look.
- **Rivers, streams and lakes.** They follow valleys from high ground to the sea, branch into tributaries, meander, and pool into lakes.
- **Rich ground cover.** 19 kinds of plants and rocks, from shore cobbles and upland tors to basalt columns and scree fields, each growing where the altitude and climate suit it.
- **Forests that change with altitude.** 14 tree species, from mangroves and kapok giants on tropical coasts to spruce, wind-bent juniper and bare snags at the treeline. Up close, broadleaf crowns are covered in polygonal leaves.
- **A world that moves in the wind.** Tree crowns and shrubs sway and rustle, leaves flutter and palm fronds bob, more strongly as the wind picks up.
- **Weather you can see on the ground.** Rain leaves the ground glossy and dark until it dries, snow settles on rocks near the snowline, and mist pools in valleys at dawn and dusk.
- **Extra polish on capable PCs.** Contact shadows (ambient occlusion), sun shafts through trees and around peaks, and longer-range shadows.
- **Living sky.** Day/night cycle, clouds, rain and snow, aurora at the poles, fireflies, glowing coastlines and a galactic band at night.
- **Wind-driven ocean.** Waves grow and shrink with the weather, and the water takes its colour from the planet's palette: deep warm blues on Earth, the planet's own tones elsewhere. The map matches.
- **Living shorelines.** Waves sharpen into crests, break into foam as they reach the shallows, and wash up the beach, leaving dark wet sand behind; at sunset the crests glow where light shines through them.
- **Places to visit.** A Locations panel offers one-tap teleports to beauty spots (beaches, canyons, peaks, lagoons…), 24 procedural landmarks and named rivers.
- **Seamless detail.** Plants, trees and terrain blend in and out smoothly, so nothing visibly pops in.
- **Runs on most hardware.** Quality is matched to the device GPU at startup (high / medium / low), and resolution keeps adjusting while you play. Supports devices up to ~7 years old.

## Running

```sh
npm install
npm run dev        # development server
npm run build      # type-check + production bundle
```

Pushes to `main` deploy automatically to GitHub Pages.

## Controls

**Desktop / laptop:** click to capture the mouse · WASD move · Shift sprint · Space jump / ascend · C descend · F cycle walk → drone → fly · L land · Q/E roll (fly) · M map · G toggle panels · Esc release mouse / close map

**Mobile / tablet:** left thumb joystick · right-side drag to look · ↑ ascend · ↓ descend · ⟲⟳ roll (fly only) · ⚡ sprint · ✈ cycle walk → drone → fly · 🛬 land · 🗺️ map · ☰ toggle panels

## Further reading

Architecture, system internals and implementation details are in [DESIGN.md](DESIGN.md).

## Licence

MIT — see [LICENSE](LICENSE).
