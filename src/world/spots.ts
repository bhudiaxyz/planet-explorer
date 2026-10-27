import * as THREE from "three";
import type { Planet } from "./planet";
import { LANDMARK_ICON } from "./landmarks";
import { SPOT_NAMES } from "../core/names";
import { rng } from "../core/noise";
import { S } from "../core/config";
import { treeDensityCPU } from "./treeutil";

export type Spot = { name: string; icon: string; dir: THREE.Vector3; group?: string };

const yield_ = () => new Promise<void>((r) => setTimeout(r));

// ---- Feature type & pool -------------------------------------------------------

export type Feature = {
  name: string;
  icon: string;
  needsNeighbours?: boolean; // false = score uses only e/t/m, skip the 8 elev neighbour fetch
  score: (e: number, nbrs: number[], t: number, m: number) => number;
  candidates: { score: number; dir: THREE.Vector3 }[];
};

// Defined at module level so we don't rebuild the array on every findSpots call.
// candidates[] is reset to [] at the top of findSpots.
const FEATURES: Omit<Feature, "candidates">[] = [
  {
    name: "Beach",
    icon: "🏖️",
    score: (e, nbrs) => {
      if (e < 0.003 || e > 0.042) return 0;
      const nWater = nbrs.filter((n) => n < 0).length;
      return nWater >= 1 ? 1 - Math.abs(e - 0.02) * 20 + nWater * 0.15 : 0;
    },
  },
  {
    name: "Mountain Peak",
    icon: "🏔️",
    score: (e, nbrs) => {
      if (e < 0.35) return 0;
      return nbrs.every((n) => n < e) ? e : 0;
    },
  },
  {
    name: "Canyon",
    icon: "🏜️",
    score: (e, nbrs) => {
      if (e < 0.02 || e > 0.18) return 0;
      const mean = nbrs.reduce((a, b) => a + b, 0) / nbrs.length;
      const rise = mean - e;
      return rise > 0.08 ? rise : 0;
    },
  },
  {
    name: "Island",
    icon: "🏝️",
    score: (e, nbrs) => {
      if (e < 0.02 || e > 0.35) return 0;
      const nWater = nbrs.filter((n) => n < 0).length;
      return nWater >= 6 ? nWater - 5 + e : 0;
    },
  },
  {
    name: "Coastal Cliffs",
    icon: "🌊",
    score: (e, nbrs) => {
      if (e < 0.12 || e > 0.55) return 0;
      const nWater = nbrs.filter((n) => n < 0).length;
      return nWater >= 1 && nWater <= 4 ? e * nWater : 0;
    },
  },
  {
    name: "Open Plains",
    icon: "🌿",
    score: (e, nbrs, _t, m) => {
      if (e < 0.05 || e > 0.2) return 0;
      const mean = nbrs.reduce((a, b) => a + b, 0) / nbrs.length;
      const variance = nbrs.reduce((a, b) => a + (b - mean) ** 2, 0) / nbrs.length;
      const nWater = nbrs.filter((n) => n < 0).length;
      return nWater === 0 && variance < 0.0008 && m > 0.4 ? 1 - variance * 1000 : 0;
    },
  },
  {
    name: "Snow Field",
    icon: "❄️",
    score: (e, nbrs, t) => {
      if (e < 0.15 || t > 0.1) return 0;
      const mean = nbrs.reduce((a, b) => a + b, 0) / nbrs.length;
      const variance = nbrs.reduce((a, b) => a + (b - mean) ** 2, 0) / nbrs.length;
      return variance < 0.002 ? e - t * 0.5 : 0;
    },
  },
  {
    name: "Desert",
    icon: "☀️",
    score: (e, nbrs, t, m) => {
      if (e < 0.03 || e > 0.2 || t < 0.55 || m > 0.3) return 0;
      const mean = nbrs.reduce((a, b) => a + b, 0) / nbrs.length;
      const variance = nbrs.reduce((a, b) => a + (b - mean) ** 2, 0) / nbrs.length;
      return variance < 0.003 ? t + (0.3 - m) : 0;
    },
  },
  {
    name: "Lagoon",
    icon: "🐠",
    score: (e, nbrs) => {
      if (e > -0.01 || e < -0.08) return 0;
      const nLand = nbrs.filter((n) => n > 0).length;
      return nLand >= 5 ? nLand - 4 - Math.abs(e) * 5 : 0;
    },
  },
  {
    name: "Rainforest",
    icon: "🌴",
    score: (e, nbrs, t, m) => {
      if (e < 0.04 || e > 0.2 || t < 0.5 || m < 0.6) return 0;
      const nWater = nbrs.filter((n) => n < 0).length;
      return nWater === 0 ? t + m : 0;
    },
  },
  {
    name: "Dense Forest",
    icon: "🌲",
    needsNeighbours: false,
    score: (e, _nbrs, t, m) => {
      if (e < 0.05 || e > 0.35 || t < 0.15 || t > 0.6 || m < 0.55) return 0;
      // tmp is the current sample direction — captured via closure from findSpots
      const td = treeDensityCPU(_planet!, _tmp, m);
      return td > 0.3 ? td : 0;
    },
  },
  {
    name: "Crystal Field",
    icon: "💎",
    needsNeighbours: false,
    score: (e, _nbrs, _t, m) => {
      if (e < 0.25 || e > 0.65 || m >= 0.32) return 0;
      return (e - 0.25) * 2.5 * (0.32 - m) * 3.0;
    },
  },
];

// Closure vars set by findSpots so Dense Forest score can access planet + current sample dir
let _planet: Planet | null = null;
let _tmp = new THREE.Vector3();

// ---- Neighbour sampling --------------------------------------------------------

// Module-level scratch to avoid allocs inside getNeighbors
const _gnPerp = new THREE.Vector3();
const _gnNbr = new THREE.Vector3();

function getNeighbors(dir: THREE.Vector3, planet: Planet): number[] {
  _gnPerp.set(dir.y, -dir.x, 0);
  if (_gnPerp.lengthSq() < 0.01) _gnPerp.set(0, dir.z, -dir.y);
  _gnPerp.normalize();
  const results: number[] = [];
  for (let i = 0; i < 8; i++) {
    _gnNbr
      .copy(_gnPerp)
      .applyAxisAngle(dir, (i / 8) * Math.PI * 2)
      .multiplyScalar(0.07)
      .add(dir)
      .normalize();
    results.push(planet.elev(_gnNbr));
  }
  return results;
}

// ---- Main scan -----------------------------------------------------------------

// Scan N random surface points and score each against terrain archetypes.
// riversReady: optional promise that resolves when planet.riverSystem is populated.
// Pass it to run scanning concurrently with river generation; spots awaits it only at the end.
export async function findSpots(planet: Planet, riversReady?: Promise<void>): Promise<Spot[]> {
  const SCAN = 4000;
  const rand = rng(S.seed ^ 0xdeadbeef);

  // Set closure vars for Dense Forest scorer
  _planet = planet;
  if (!(_tmp instanceof THREE.Vector3)) _tmp = new THREE.Vector3();

  // Reset candidate lists from any previous call
  const features: Feature[] = FEATURES.map((f) => ({ ...f, candidates: [] }));

  let unsatisfied = features.length;
  let lastYield = performance.now();
  for (let i = 0; i < SCAN && unsatisfied > 0; i++) {
    const now = performance.now();
    if (now - lastYield >= 4) {
      await yield_();
      lastYield = performance.now();
    }
    _tmp.set(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1);
    if (_tmp.lengthSq() > 1 || _tmp.lengthSq() < 0.01) continue;
    _tmp.normalize();
    const e = planet.elev(_tmp);
    const t = planet.temp(_tmp, e);
    const m = planet.moistureAt(_tmp);
    const wantNbrs = features.some((f) => f.candidates.length < 3 && f.needsNeighbours !== false);
    const nbrs = wantNbrs ? getNeighbors(_tmp, planet) : [];
    for (const f of features) {
      if (f.candidates.length >= 3) continue;
      const s = f.score(e, nbrs, t, m);
      if (s <= 0) continue;
      const MIN_ANG = 0.52; // ~30°
      const far = f.candidates.every((c) => c.dir.angleTo(_tmp) > MIN_ANG);
      if (far) {
        f.candidates.push({ score: s, dir: _tmp.clone() });
        if (f.candidates.length > 3) {
          f.candidates.sort((a, b) => b.score - a.score);
          f.candidates.length = 3;
        }
        if (f.candidates.length === 3) unsatisfied--;
      } else {
        const closest = f.candidates.reduce((best, c) =>
          c.dir.angleTo(_tmp) < best.dir.angleTo(_tmp) ? c : best
        );
        if (s > closest.score) {
          closest.score = s;
          closest.dir = _tmp.clone();
        }
      }
    }
  }

  // Fill any feature short of 3 candidates — rescan then guaranteed clone fallback.
  for (const f of features) {
    if (f.candidates.length >= 3) continue;
    if (f.candidates.length > 0) {
      let rescanYield = performance.now();
      for (let i = 0; i < 3000 && f.candidates.length < 3; i++) {
        const now = performance.now();
        if (now - rescanYield >= 4) {
          await yield_();
          rescanYield = performance.now();
        }
        _tmp.set(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1);
        if (_tmp.lengthSq() > 1 || _tmp.lengthSq() < 0.01) continue;
        _tmp.normalize();
        const e = planet.elev(_tmp),
          t = planet.temp(_tmp, e),
          m = planet.moistureAt(_tmp);
        const s = f.score(e, f.needsNeighbours !== false ? getNeighbors(_tmp, planet) : [], t, m);
        if (s > 0 && f.candidates.every((c) => c.dir.angleTo(_tmp) > 0.05))
          f.candidates.push({ score: s, dir: _tmp.clone() });
      }
    }
    while (f.candidates.length < 3) {
      const offset = new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize();
      const base =
        f.candidates[0]?.dir ?? new THREE.Vector3(rand() * 2 - 1, 0, rand() * 2 - 1).normalize();
      f.candidates.push({
        score: 0.1,
        dir: base.clone().addScaledVector(offset, 0.08).normalize(),
      });
    }
  }

  const fixed: Spot[] = [
    { name: "North Pole", icon: "⛄", dir: new THREE.Vector3(0, 1, 0), group: "Fixed" },
    {
      name: "Aurora Borealis",
      icon: "🌌",
      dir: new THREE.Vector3(0.34, 0.94, 0).normalize(),
      group: "Fixed",
    },
    { name: "South Pole", icon: "🦭", dir: new THREE.Vector3(0, -1, 0), group: "Fixed" },
    {
      name: "Aurora Australis",
      icon: "🌌",
      dir: new THREE.Vector3(0.34, -0.94, 0).normalize(),
      group: "Fixed",
    },
    { name: "Equator 0°", icon: "⬆️", dir: new THREE.Vector3(1, 0, 0).normalize(), group: "Fixed" },
    {
      name: "Equator 90°",
      icon: "➡️",
      dir: new THREE.Vector3(0, 0, 1).normalize(),
      group: "Fixed",
    },
    {
      name: "Equator 180°",
      icon: "⬇️",
      dir: new THREE.Vector3(-1, 0, 0).normalize(),
      group: "Fixed",
    },
    {
      name: "Equator 270°",
      icon: "⬅️",
      dir: new THREE.Vector3(0, 0, -1).normalize(),
      group: "Fixed",
    },
  ];

  const landmarks: Spot[] = planet.landmarks.list.map((lm) => {
    const d = lm.pos.clone().normalize();
    const side = new THREE.Vector3(0, 1, 0).cross(d);
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
    side.normalize();
    d.addScaledVector(side, 8 / S.radius).normalize();
    return { name: lm.label, icon: LANDMARK_ICON[lm.name] ?? "📍", dir: d, group: lm.name };
  });

  const usedNames = new Set(landmarks.map((s) => s.name));
  const nameOffset = Math.floor(rand() * SPOT_NAMES.length);
  let nameIdx = 0;
  const scanned = features.flatMap((f) => {
    f.candidates.sort((a, b) => b.score - a.score);
    return f.candidates.map((c) => {
      let name: string;
      let tries = 0;
      do {
        name = SPOT_NAMES[(nameOffset + nameIdx++) % SPOT_NAMES.length];
        tries++;
      } while (usedNames.has(name) && tries < SPOT_NAMES.length);
      usedNames.add(name);
      return { name, icon: f.icon, dir: c.dir, group: f.name };
    });
  });

  if (riversReady) await riversReady;
  const rs = planet.riverSystem;
  const rivers: Spot[] = (rs?.paths ?? []).map((path, i) => ({
    name: rs!.names[i],
    icon: "🏞️",
    dir: path[Math.floor(path.length * 0.4)].clone().normalize(),
    group: "Rivers",
  }));

  return [...fixed, ...scanned, ...landmarks, ...rivers];
}
