import * as THREE from "three";
import type { Planet } from "./planet";
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
    best: number;
    dir: THREE.Vector3 | null;
  };

  const features: Feature[] = [
    {
      name: "Beach", icon: "🏖️",
      score: (e, nbrs) => {
        if (e < 0.003 || e > 0.042) return 0;
        const nWater = nbrs.filter(n => n < 0).length;
        return nWater >= 1 ? 1 - Math.abs(e - 0.02) * 20 + nWater * 0.15 : 0;
      },
      best: 0, dir: null,
    },
    {
      name: "Mountain Peak", icon: "🏔️",
      score: (e, nbrs) => {
        if (e < 0.35) return 0;
        return nbrs.every(n => n < e) ? e : 0;
      },
      best: 0, dir: null,
    },
    {
      name: "Canyon", icon: "🏜️",
      score: (e, nbrs) => {
        if (e < 0.02 || e > 0.18) return 0;
        const mean = nbrs.reduce((a, b) => a + b, 0) / nbrs.length;
        const rise = mean - e;
        return rise > 0.08 ? rise : 0;
      },
      best: 0, dir: null,
    },
    {
      name: "Island", icon: "🏝️",
      score: (e, nbrs) => {
        if (e < 0.02 || e > 0.35) return 0;
        const nWater = nbrs.filter(n => n < 0).length;
        return nWater >= 6 ? nWater - 5 + e : 0;
      },
      best: 0, dir: null,
    },
    {
      name: "Coastal Cliffs", icon: "🌊",
      score: (e, nbrs) => {
        if (e < 0.12 || e > 0.55) return 0;
        const nWater = nbrs.filter(n => n < 0).length;
        return nWater >= 1 && nWater <= 4 ? e * nWater : 0;
      },
      best: 0, dir: null,
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
      best: 0, dir: null,
    },
    {
      name: "Snow Field", icon: "❄️",
      score: (e, nbrs, t) => {
        if (e < 0.15 || t > 0.1) return 0;
        const mean = nbrs.reduce((a, b) => a + b, 0) / nbrs.length;
        const variance = nbrs.reduce((a, b) => a + (b - mean) ** 2, 0) / nbrs.length;
        return variance < 0.002 ? e - t * 0.5 : 0;
      },
      best: 0, dir: null,
    },
    {
      name: "Desert", icon: "☀️",
      score: (e, nbrs, t, m) => {
        if (e < 0.03 || e > 0.2 || t < 0.55 || m > 0.3) return 0;
        const mean = nbrs.reduce((a, b) => a + b, 0) / nbrs.length;
        const variance = nbrs.reduce((a, b) => a + (b - mean) ** 2, 0) / nbrs.length;
        return variance < 0.003 ? t + (0.3 - m) : 0;
      },
      best: 0, dir: null,
    },
    {
      name: "Lagoon", icon: "🐠",
      score: (e, nbrs) => {
        if (e > -0.01 || e < -0.08) return 0;
        const nLand = nbrs.filter(n => n > 0).length;
        return nLand >= 5 ? nLand - 4 - Math.abs(e) * 5 : 0;
      },
      best: 0, dir: null,
    },
    {
      name: "Rainforest", icon: "🌴",
      score: (e, nbrs, t, m) => {
        if (e < 0.04 || e > 0.2 || t < 0.5 || m < 0.6) return 0;
        const nWater = nbrs.filter(n => n < 0).length;
        return nWater === 0 ? t + m : 0;
      },
      best: 0, dir: null,
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
      if (s > f.best) { f.best = s; f.dir = tmp.clone(); }
    }
  }

  const fixed: Spot[] = [
    { name: "North Pole", icon: "⛄", dir: new THREE.Vector3(0, 1, 0) },
    { name: "South Pole", icon: "🦭", dir: new THREE.Vector3(0, -1, 0) },
    { name: "Equator 0°",   icon: "⬆️", dir: new THREE.Vector3(1, 0, 0).normalize() },
    { name: "Equator 90°",  icon: "➡️", dir: new THREE.Vector3(0, 0, 1).normalize() },
    { name: "Equator 180°", icon: "⬇️", dir: new THREE.Vector3(-1, 0, 0).normalize() },
    { name: "Equator 270°", icon: "⬅️", dir: new THREE.Vector3(0, 0, -1).normalize() },
  ];

  const landmarkIcons: Record<string, string> = {
    "monolith ring":   "🗿",
    "twisted spire":   "⛰️",
    "tombstone field": "🪦",
    "floating island": "🏝️",
  };
  const landmarks: Spot[] = planet.landmarks.list.map(lm => ({
    name: lm.label,
    icon: landmarkIcons[lm.name] ?? "📍",
    dir: lm.pos.clone().normalize(),
    group: lm.name,
  }));

  const scanned = features
    .filter(f => f.dir !== null)
    .map(f => ({ name: f.name, icon: f.icon, dir: f.dir! }));

  return [...fixed, ...landmarks, ...scanned];
}
