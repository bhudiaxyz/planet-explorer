# Rivers — Design Spec
**Date:** 2026-10-25  
**Status:** Approved for implementation

---

## Overview

Add procedurally generated river networks to the planet. Each planet seed produces 4 main rivers with 2 tributaries each (~10 total paths) flowing from high-moisture highlands down to sea level. Visual quality scales with GPU tier so the feature works across all target devices.

---

## Files

| File | Change |
|---|---|
| `src/river.ts` | NEW — `RiverSystem` class (path gen, geometry, material) |
| `src/planet.ts` | MODIFY — construct/dispose `RiverSystem` in `build()` |
| `src/config.ts` | MODIFY — add `river` config block |

Vegetation exclusion deferred to v2 (rivers are 2–9 m wide; visual overlap with grass is minor at shipping quality).

---

## Config (`src/config.ts`)

```typescript
river: {
  count: 4,               // main rivers per planet
  tributaries: 2,         // tributaries per main river
  sourceMinElev: 0.25,    // minimum elevation unit for source selection
  sourceMinMoisture: 0.15,// minimum moisture for source selection
  minSourceSpacing: 40,   // degrees — prevents clustering
  stepSize: 6,            // metres per gradient-descent step
  maxSteps: 180,          // max steps before path is abandoned
  widthStart: 2,          // ribbon width (metres) at source
  widthEnd: 9,            // ribbon width (metres) at mouth
  surfaceOffset: 0.3,     // metres above terrain along sphere normal
} as const
```

---

## Path Generation (`RiverSystem`)

### Source selection
Use the planet's seeded `rng` for reproducibility. Sample random sphere directions, filter for:
- `planet.elevationAt(x,y,z) > CFG.river.sourceMinElev`
- `planet.moistureAt(dir) > CFG.river.sourceMinMoisture`
- Angular distance ≥ `minSourceSpacing` degrees from all accepted sources

Repeat until `count` main sources are found (max 500 attempts).

### Gradient descent
From each source, iterate up to `maxSteps`:
1. Sample 8 neighbours at `stepSize` metres on the sphere surface (N/NE/E/SE/S/SW/W/NW)
2. Move to the neighbour with lowest `elevationAt`
3. Stop if: elevation ≤ `S.seaLevel`, no lower neighbour exists (flat/basin), or max steps reached

### Tributaries
For each main river, generate `tributaries` tributary paths:
1. Pick a junction point at 30–50% along the main path (seeded random)
2. Offset 20° perpendicular on the sphere surface, find nearest qualifying high-elevation point
3. Trace gradient descent toward the junction point
4. Ribbons simply overlap at the join — no mesh merging

---

## Geometry

All paths merged into a **single `BufferGeometry`**, one draw call.

Per path (N points → N−1 quads):
- **Width**: `lerp(widthStart, widthEnd, i / N)` — widens toward mouth
- **Position**: sphere surface + `surfaceOffset` metres along outward normal — avoids z-fighting with terrain
- **UVs**: `u ∈ [0,1]` across ribbon width, `v = cumulative arc length` — ensures flow speed looks uniform regardless of step density
- **Normals**: sphere outward normal at each point

**Scale**: ~12 paths × 150 points × 2 verts ≈ 3 600 vertices, ~7 000 triangles. Negligible on all devices.

---

## Material

### Low tier (`MeshBasicMaterial`)
```typescript
new THREE.MeshBasicMaterial({
  color: 0x4a7a9b,
  transparent: true,
  opacity: 0.7,
  depthWrite: false,
  side: THREE.DoubleSide,
})
```
Zero shader compile cost.

### Medium / High tier (`ShaderMaterial`)
Single compile, tier-controlled via uniform.

**Uniforms:** `uTime` (from `U.uTime` in `fx.ts`), Three.js built-ins (`cameraPosition`, `normalMatrix`).

**Vertex shader:** passes `vUv`, `vWorldNormal`, `vWorldPos` through. No vertex displacement — position is pre-baked in geometry.

**Fragment shader:**
- **Base colour**: deep teal `#1a4a6a`, slightly darker at ribbon edges (`u < 0.1 || u > 0.9`) to suggest depth
- **Flow**: scroll `vUv.y` by `uTime * 0.4` for constant downstream motion
- **Fresnel**: `pow(1.0 - dot(normalize(cameraPosition - vWorldPos), vWorldNormal), 2.5)` → edge highlight
- **High tier only** (controlled by `uHighDetail` uniform bool):
  - Ripple: `sin(vUv.y * 8.0 + uTime * 2.0) * 0.02` normal perturbation
  - Foam streak: extra brightness where `u < 0.12 || u > 0.88`

`transparent: true`, `depthWrite: false`, `side: THREE.DoubleSide`.

---

## Integration — `planet.ts`

Inside `build()`, after terrain geometry is built:

```typescript
this.riverSystem?.dispose();
this.riverSystem = new RiverSystem(this);
this.group.add(this.riverSystem.mesh);
```

`RiverSystem.dispose()`:
```typescript
dispose() {
  this.mesh.geometry.dispose();
  (this.mesh.material as THREE.Material).dispose();
  this.mesh.removeFromParent();
}
```

`uTime` is already ticked globally via `U.uTime` in the frame loop — no per-frame changes needed in `main.ts`.

---

## Cross-Platform Safety

| Device | GPU Tier | River rendering |
|---|---|---|
| iPhone 12–15, older Android | low | `MeshBasicMaterial` — no shader |
| Samsung S22+, iPhone 15 Pro, iPad, MacBook Intel | medium | `ShaderMaterial` — flow + Fresnel |
| MacBook M1+, NVIDIA/AMD discrete | high | Above + ripple + foam |

- One `ShaderMaterial` compile for medium+high — fits within existing `compileAsync` step
- `MeshBasicMaterial` for low — zero compile cost
- Geometry: ~7 000 triangles — negligible on all targets
- No new textures, no new render passes, no extra uniforms beyond `uTime`

---

## Out of Scope (v1)

- Vegetation exclusion mask (grass/reeds grow through river — acceptable for v1)
- River sound
- River flow affecting player physics
- Dynamic flood / drought simulation
