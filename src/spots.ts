import * as THREE from "three";
import type { Planet } from "./planet";
import { LANDMARK_ICON } from "./landmarks";
import { SPOT_NAMES } from "./landmarknames";
import { rng } from "./noise";
import { S } from "./config";
import { treeDensityCPU } from "./treeutil";

export type Spot = { name: string; icon: string; dir: THREE.Vector3; group?: string };

const yield_ = () => new Promise<void>(r => setTimeout(r));

// Scan N random surface points and score each against terrain archetypes.
// riversReady: optional promise that resolves when planet.riverSystem is populated.
// Pass it to run scanning concurrently with river generation; spots awaits it only at the end.
export async function findSpots(planet: Planet, riversReady?: Promise<void>): Promise<Spot[]> {
  const SCAN = 4000;
  const rand = rng(S.seed ^ 0xdeadbeef);
  const tmp = new THREE.Vector3();
  const perp = new THREE.Vector3();
  const nbr = new THREE.Vector3();

  type Feature = {
    name: string;
    icon: string;
    needsNeighbours?: boolean; // false = score uses only e/t/m, skip the 8 elev neighbour fetch
    score: (e: number, nbrs: number[], t: number, m: number) => number;
    candidates: { score: number; dir: THREE.Vector3 }[];
  };

  const features: Feature[] = [
    {
      name: "Beach", icon: "🏖️",
      score: (e, nbrs) => {
        if (e < 0.003 || e > 0.042) return 0;
        const nWater = nbrs.filter(n => n < 0).length;
        return nWater >= 1 ? 1 - Math.abs(e - 0.02) * 20 + nWater * 0.15 : 0;
      },
      candidates: [],
    },
    {
      name: "Mountain Peak", icon: "🏔️",
      score: (e, nbrs) => {
        if (e < 0.35) return 0;
        return nbrs.every(n => n < e) ? e : 0;
      },
      candidates: [],
    },
    {
      name: "Canyon", icon: "🏜️",
      score: (e, nbrs) => {
        if (e < 0.02 || e > 0.18) return 0;
        const mean = nbrs.reduce((a, b) => a + b, 0) / nbrs.length;
        const rise = mean - e;
        return rise > 0.08 ? rise : 0;
      },
      candidates: [],
    },
    {
      name: "Island", icon: "🏝️",
      score: (e, nbrs) => {
        if (e < 0.02 || e > 0.35) return 0;
        const nWater = nbrs.filter(n => n < 0).length;
        return nWater >= 6 ? nWater - 5 + e : 0;
      },
      candidates: [],
    },
    {
      name: "Coastal Cliffs", icon: "🌊",
      score: (e, nbrs) => {
        if (e < 0.12 || e > 0.55) return 0;
        const nWater = nbrs.filter(n => n < 0).length;
        return nWater >= 1 && nWater <= 4 ? e * nWater : 0;
      },
      candidates: [],
    },
    {
      name: "Open Plains", icon: "🌿",
      score: (e, nbrs, _t, m) => {
        if (e < 0.05 || e > 0.2) return 0;
        const mean = nbrs.reduce((a, b) => a + b, 0) / nbrs.length;
        const variance = nbrs.reduce((a, b) => a + (b - mean) ** 2, 0) / nbrs.length;
        const nWater = nbrs.filter(n => n < 0).length;
        return nWater === 0 && variance < 0.0008 && m > 0.4 ? 1 - variance * 1000 : 0;
      },
      candidates: [],
    },
    {
      name: "Snow Field", icon: "❄️",
      score: (e, nbrs, t) => {
        if (e < 0.15 || t > 0.1) return 0;
        const mean = nbrs.reduce((a, b) => a + b, 0) / nbrs.length;
        const variance = nbrs.reduce((a, b) => a + (b - mean) ** 2, 0) / nbrs.length;
        return variance < 0.002 ? e - t * 0.5 : 0;
      },
      candidates: [],
    },
    {
      name: "Desert", icon: "☀️",
      score: (e, nbrs, t, m) => {
        if (e < 0.03 || e > 0.2 || t < 0.55 || m > 0.3) return 0;
        const mean = nbrs.reduce((a, b) => a + b, 0) / nbrs.length;
        const variance = nbrs.reduce((a, b) => a + (b - mean) ** 2, 0) / nbrs.length;
        return variance < 0.003 ? t + (0.3 - m) : 0;
      },
      candidates: [],
    },
    {
      name: "Lagoon", icon: "🐠",
      score: (e, nbrs) => {
        if (e > -0.01 || e < -0.08) return 0;
        const nLand = nbrs.filter(n => n > 0).length;
        return nLand >= 5 ? nLand - 4 - Math.abs(e) * 5 : 0;
      },
      candidates: [],
    },
    {
      name: "Rainforest", icon: "🌴",
      score: (e, nbrs, t, m) => {
        if (e < 0.04 || e > 0.2 || t < 0.5 || m < 0.6) return 0;
        const nWater = nbrs.filter(n => n < 0).length;
        return nWater === 0 ? t + m : 0;
      },
      candidates: [],
    },
    {
      name: "Dense Forest", icon: "🌲",
      needsNeighbours: false,
      score: (e, _nbrs, t, m) => {
        if (e < 0.05 || e > 0.35 || t < 0.15 || t > 0.6 || m < 0.55) return 0;
        const td = treeDensityCPU(planet, tmp, m);
        return td > 0.3 ? td : 0;
      },
      candidates: [],
    },
    {
      name: "Crystal Field", icon: "💎",
      needsNeighbours: false,
      score: (e, _nbrs, _t, m) => {
        if (e < 0.25 || e > 0.65 || m >= 0.32) return 0;
        // score rises with elevation and dryness — same conditions as the crystal scatter gate
        return (e - 0.25) * 2.5 * (0.32 - m) * 3.0;
      },
      candidates: [],
    },
  ];

  const getNeighbors = (dir: THREE.Vector3): number[] => {
    perp.set(dir.y, -dir.x, 0);
    if (perp.lengthSq() < 0.01) perp.set(0, dir.z, -dir.y);
    perp.normalize();
    const results: number[] = [];
    for (let i = 0; i < 8; i++) {
      nbr.copy(perp)
        .applyAxisAngle(dir, (i / 8) * Math.PI * 2)
        .multiplyScalar(0.07)
        .add(dir)
        .normalize();
      results.push(planet.elev(nbr));
    }
    return results;
  };

  let unsatisfied = features.length;
  let lastYield = performance.now();
  for (let i = 0; i < SCAN && unsatisfied > 0; i++) {
    const now = performance.now();
    if (now - lastYield >= 4) { await yield_(); lastYield = performance.now(); }
    tmp.set(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1);
    if (tmp.lengthSq() > 1 || tmp.lengthSq() < 0.01) continue;
    tmp.normalize();
    const e = planet.elev(tmp);
    const t = planet.temp(tmp, e);
    const m = planet.moistureAt(tmp);
    // only fetch neighbours when at least one unsatisfied feature needs them
    const wantNbrs = features.some(f => f.candidates.length < 3 && f.needsNeighbours !== false);
    const nbrs = wantNbrs ? getNeighbors(tmp) : [];
    for (const f of features) {
      if (f.candidates.length >= 3) continue;
      const s = f.score(e, nbrs, t, m);
      if (s <= 0) continue;
      // keep candidate if it's far enough (>30°) from all existing ones, or better than the worst
      const MIN_ANG = 0.52; // ~30°
      const far = f.candidates.every(c => c.dir.angleTo(tmp) > MIN_ANG);
      if (far) {
        f.candidates.push({ score: s, dir: tmp.clone() });
        if (f.candidates.length > 3) {
          f.candidates.sort((a, b) => b.score - a.score);
          f.candidates.length = 3;
        }
        if (f.candidates.length === 3) unsatisfied--;
      } else {
        const closest = f.candidates.reduce((best, c) =>
          c.dir.angleTo(tmp) < best.dir.angleTo(tmp) ? c : best);
        if (s > closest.score) { closest.score = s; closest.dir = tmp.clone(); }
      }
    }
  }

  // Fill any feature short of 3 candidates — rescan then guaranteed clone fallback.
  // Skip the full 3000-iteration rescan for features with 0 candidates: they don't exist on
  // this planet and every iteration would be wasted work (→ 5-10 s on slow mobile).
  for (const f of features) {
    if (f.candidates.length >= 3) continue;
    if (f.candidates.length > 0) {
      let rescanYield = performance.now();
      for (let i = 0; i < 3000 && f.candidates.length < 3; i++) {
        const now = performance.now();
        if (now - rescanYield >= 4) { await yield_(); rescanYield = performance.now(); }
        tmp.set(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1);
        if (tmp.lengthSq() > 1 || tmp.lengthSq() < 0.01) continue;
        tmp.normalize();
        const e = planet.elev(tmp), t = planet.temp(tmp, e), m = planet.moistureAt(tmp);
        const s = f.score(e, getNeighbors(tmp), t, m);
        if (s > 0 && f.candidates.every(c => c.dir.angleTo(tmp) > 0.05))
          f.candidates.push({ score: s, dir: tmp.clone() });
      }
    }
    while (f.candidates.length < 3) {
      const offset = new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize();
      const base = f.candidates[0]?.dir ?? new THREE.Vector3(rand() * 2 - 1, 0, rand() * 2 - 1).normalize();
      f.candidates.push({ score: 0.1, dir: base.clone().addScaledVector(offset, 0.08).normalize() });
    }
  }

  const fixed: Spot[] = [
    { name: "North Pole",      icon: "⛄",  dir: new THREE.Vector3(0, 1, 0),              group: "Fixed" },
    { name: "Aurora Borealis", icon: "🌌",  dir: new THREE.Vector3(0.34, 0.94, 0).normalize(),  group: "Fixed" },
    { name: "South Pole",      icon: "🦭",  dir: new THREE.Vector3(0, -1, 0),             group: "Fixed" },
    { name: "Aurora Australis",icon: "🌌",  dir: new THREE.Vector3(0.34, -0.94, 0).normalize(), group: "Fixed" },
    { name: "Equator 0°",      icon: "⬆️", dir: new THREE.Vector3(1, 0, 0).normalize(),   group: "Fixed" },
    { name: "Equator 90°",     icon: "➡️", dir: new THREE.Vector3(0, 0, 1).normalize(),   group: "Fixed" },
    { name: "Equator 180°",    icon: "⬇️", dir: new THREE.Vector3(-1, 0, 0).normalize(),  group: "Fixed" },
    { name: "Equator 270°",    icon: "⬅️", dir: new THREE.Vector3(0, 0, -1).normalize(),  group: "Fixed" },
  ];

  const landmarks: Spot[] = planet.landmarks.list.map(lm => {
    const d = lm.pos.clone().normalize();
    const side = new THREE.Vector3(0, 1, 0).cross(d);
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
    side.normalize();
    // offset ~8 m away so the player doesn't spawn inside the landmark
    d.addScaledVector(side, 8 / S.radius).normalize();
    return { name: lm.label, icon: LANDMARK_ICON[lm.name] ?? "📍", dir: d, group: lm.name };
  });

  const usedNames = new Set(landmarks.map(s => s.name));
  const nameOffset = Math.floor(rand() * SPOT_NAMES.length);
  let nameIdx = 0;
  const scanned = features.flatMap(f => {
    f.candidates.sort((a, b) => b.score - a.score);
    return f.candidates.map(c => {
      let name: string;
      do { name = SPOT_NAMES[(nameOffset + nameIdx++) % SPOT_NAMES.length]; }
      while (usedNames.has(name));
      usedNames.add(name);
      return { name, icon: f.icon, dir: c.dir, group: f.name };
    });
  });

  // Wait for rivers before reading planet.riverSystem — allows rivers and the scan above to
  // run in parallel when the caller passes a riversReady promise.
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
