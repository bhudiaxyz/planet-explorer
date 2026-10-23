import * as THREE from "three";
import type { Planet } from "./planet";
import { LANDMARK_ICON, LANDMARK_NAMES } from "./landmarks";
import { rng } from "./noise";
import { S } from "./settings";

export type Spot = { name: string; icon: string; dir: THREE.Vector3; group?: string };

// Scan N random surface points and score each against 10 terrain archetypes.
export function findSpots(planet: Planet): Spot[] {
  const SCAN = 10000;
  const rand = rng(S.seed ^ 0xdeadbeef);
  const tmp = new THREE.Vector3();
  const perp = new THREE.Vector3();
  const nbr = new THREE.Vector3();

  type Feature = {
    name: string;
    icon: string;
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

  for (let i = 0; i < SCAN; i++) {
    tmp.set(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1);
    if (tmp.lengthSq() > 1 || tmp.lengthSq() < 0.01) continue;
    tmp.normalize();
    const e = planet.elev(tmp);
    const t = planet.temp(tmp, e);
    const m = planet.moistureAt(tmp);
    const nbrs = getNeighbors(tmp);
    for (const f of features) {
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
      } else {
        const closest = f.candidates.reduce((best, c) =>
          c.dir.angleTo(tmp) < best.dir.angleTo(tmp) ? c : best);
        if (s > closest.score) { closest.score = s; closest.dir = tmp.clone(); }
      }
    }
  }

  const fixed: Spot[] = [
    { name: "North Pole", icon: "⛄", dir: new THREE.Vector3(0, 1, 0) },
    { name: "Aurora Borealis", icon: "🌌", dir: new THREE.Vector3(0.34, 0.94, 0).normalize() },
    { name: "South Pole", icon: "🦭", dir: new THREE.Vector3(0, -1, 0) },
    { name: "Aurora Australis", icon: "🌌", dir: new THREE.Vector3(0.34, -0.94, 0).normalize() },
    { name: "Equator 0°",   icon: "⬆️", dir: new THREE.Vector3(1, 0, 0).normalize() },
    { name: "Equator 90°",  icon: "➡️", dir: new THREE.Vector3(0, 0, 1).normalize() },
    { name: "Equator 180°", icon: "⬇️", dir: new THREE.Vector3(-1, 0, 0).normalize() },
    { name: "Equator 270°", icon: "⬅️", dir: new THREE.Vector3(0, 0, -1).normalize() },
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

  const nameOffset = Math.floor(rand() * LANDMARK_NAMES.length);
  let nameIdx = 0;
  const scanned = features.flatMap(f => {
    f.candidates.sort((a, b) => b.score - a.score);
    return f.candidates.map(c => ({
      name: LANDMARK_NAMES[(nameOffset + nameIdx++) % LANDMARK_NAMES.length],
      icon: f.icon,
      dir: c.dir,
      group: f.name,
    }));
  });

  return [...fixed, ...scanned, ...landmarks];
}
