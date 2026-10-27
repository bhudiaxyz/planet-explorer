import * as THREE from "three";
import { rng } from "../core/noise";
import { CurrentPalette } from "../core/palette";
import { T, add, done } from "./geoutil";

export function rockGeo() {
  const p: THREE.BufferGeometry[] = [];
  add(
    p,
    new THREE.IcosahedronGeometry(1, 2),
    T(0, 0.3, 0),
    new THREE.Color(CurrentPalette.rockWarm),
    1,
    true
  );
  return done(p);
}
export function rockLow() {
  const p: THREE.BufferGeometry[] = [];
  add(
    p,
    new THREE.IcosahedronGeometry(1, 0),
    T(0, 0.3, 0),
    new THREE.Color(CurrentPalette.rockWarm),
    1,
    true
  );
  return done(p);
}
// Flat layered slabs — warm ochre/tan palette, biased to mid-altitude rocky slopes
export function rockSlabGeo() {
  const p: THREE.BufferGeometry[] = [],
    r = rng(37);
  // Large flat slab
  add(
    p,
    new THREE.IcosahedronGeometry(1, 2),
    new THREE.Matrix4().compose(
      new THREE.Vector3(0, 0.12, 0),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, r() * 6.28, (r() - 0.5) * 0.25)),
      new THREE.Vector3(1.15, 0.2, 1.0)
    ),
    new THREE.Color(CurrentPalette.rockWarmAlt),
    0.22,
    true
  );
  // Smaller angled piece resting on top
  add(
    p,
    new THREE.IcosahedronGeometry(1, 1),
    new THREE.Matrix4().compose(
      new THREE.Vector3(0.35, 0.3, -0.15),
      new THREE.Quaternion().setFromEuler(
        new THREE.Euler((r() - 0.5) * 0.5, r() * 6.28, (r() - 0.5) * 0.4)
      ),
      new THREE.Vector3(0.48, 0.36, 0.42)
    ),
    new THREE.Color(CurrentPalette.rockWarmDark),
    0.38,
    true
  );
  return done(p);
}
export function rockSlabLow() {
  const p: THREE.BufferGeometry[] = [];
  add(
    p,
    new THREE.IcosahedronGeometry(1, 0),
    new THREE.Matrix4().compose(
      new THREE.Vector3(0, 0.12, 0),
      new THREE.Quaternion(),
      new THREE.Vector3(1.1, 0.22, 1.0)
    ),
    new THREE.Color(CurrentPalette.rockWarmAlt),
    0.22,
    true
  );
  return done(p);
}

// Angular pale rocks near the snowline — cool grey/blue-grey palette, high altitude only
export function frostRockGeo() {
  const p: THREE.BufferGeometry[] = [],
    r = rng(53);
  for (let i = 0; i < 2; i++) {
    const s = i === 0 ? 0.85 : 0.52;
    add(
      p,
      new THREE.IcosahedronGeometry(1, 1), // det=1 stays angular after jitter
      new THREE.Matrix4().compose(
        new THREE.Vector3(i * 0.4 - 0.2, s * 0.55 + i * 0.1, i * 0.15 - 0.08),
        new THREE.Quaternion().setFromEuler(
          new THREE.Euler((r() - 0.5) * 0.5, r() * 6.28, (r() - 0.5) * 0.6)
        ),
        new THREE.Vector3(s, s * 0.9, s * 0.8)
      ),
      new THREE.Color(CurrentPalette.rockCool),
      s * 0.9,
      true
    );
  }
  return done(p);
}
export function frostRockLow() {
  const p: THREE.BufferGeometry[] = [];
  add(
    p,
    new THREE.IcosahedronGeometry(1, 0),
    T(0, 0.45, 0),
    new THREE.Color(CurrentPalette.rockCool),
    0.85,
    true
  );
  return done(p);
}

const tinyRock = (c: THREE.Color, y: number, sx: number, sy: number) => {
  const p: THREE.BufferGeometry[] = [];
  add(
    p,
    new THREE.OctahedronGeometry(1, 0),
    new THREE.Matrix4().compose(
      new THREE.Vector3(0, y, 0),
      new THREE.Quaternion(),
      new THREE.Vector3(sx, sy, sx)
    ),
    c,
    sy,
    true,
    false
  );
  return done(p);
};
export const rockSlabTiny = () =>
  tinyRock(new THREE.Color(CurrentPalette.rockWarmAlt), 0.12, 1.1, 0.22);
export const frostRockTiny = () =>
  tinyRock(new THREE.Color(CurrentPalette.rockCool), 0.45, 0.85, 0.75);

export const rockTiny = () => tinyRock(new THREE.Color(CurrentPalette.rockWarm), 0.3, 1, 0.8);
