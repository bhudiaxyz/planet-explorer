import * as THREE from "three";
import { rng } from "./noise";
import { UP, C, N0, add, T, cyl, blob, done } from "./geoutil";

export function grassGeo(blades: number, segs: number, wScale = 1) {
  const pos: number[] = [],
    col: number[] = [],
    nrm: number[] = [],
    idx: number[] = [];
  for (let b = 0; b < blades; b++) {
    const a = b * (6.283 / blades) + 0.3,
      ca = Math.cos(a),
      sa = Math.sin(a),
      ox = Math.cos(a * 2.3) * 0.07,
      oz = Math.sin(a * 1.7) * 0.07,
      h = 0.5 + 0.12 * (b % 4),
      w = 0.045 * wScale,
      bd = 0.14,
      o = pos.length / 3;
    const put = (x: number, y: number, z: number, c: number) => {
      pos.push(ox + x * ca - z * sa, y, oz + x * sa + z * ca);
      col.push(c, c, c);
      nrm.push(-sa, 0, ca); // face-aligned: perpendicular to blade orientation
    };
    for (let s = 0; s < segs; s++) {
      const t = s / segs,
        ww = w * (1 - t * 0.75),
        z = bd * t * t,
        c = 0.35 + 0.4 * t;
      put(-ww, h * t, z, c);
      put(ww, h * t, z, c);
    }
    put(0, h, bd, 1);
    for (let s = 0; s < segs - 1; s++) {
      const i = o + 2 * s;
      idx.push(i, i + 1, i + 2, i + 1, i + 3, i + 2);
    }
    const l = o + 2 * (segs - 1);
    idx.push(l, l + 1, o + 2 * segs);
  }
  return new THREE.BufferGeometry()
    .setAttribute("position", new THREE.Float32BufferAttribute(pos, 3))
    .setAttribute("color", new THREE.Float32BufferAttribute(col, 3))
    .setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3))
    .setIndex(idx);
}

// ---- ground cover geometry. Foliage is neutral-shaded (leaf = true); the vegetation shader supplies a per-plant hue palette. Detailed near geometry + low-poly far geometry.
export function shrubGeo() {
  const p: THREE.BufferGeometry[] = [],
    r = rng(5);
  for (let i = 0; i < 3; i++)
    blob(
      p,
      new THREE.Vector3((r() - 0.5) * 0.7, 0.35, (r() - 0.5) * 0.7),
      0.5 + r() * 0.2,
      N0,
      0.8,
      2,
    );
  return done(p);
}
export function shrubLow() {
  const p: THREE.BufferGeometry[] = [];
  blob(p, new THREE.Vector3(0, 0.4, 0), 0.75, N0, 0.7, 0);
  return done(p);
}
export function flowerGeo() {
  const p: THREE.BufferGeometry[] = [];
  cyl(p, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0.35, 0), 0.015, 0.012, C(0x3f7a30), 6);
  blob(p, new THREE.Vector3(0, 0.38, 0), 0.09, new THREE.Color(1, 1, 1), 0.6, 1);
  return done(p);
}
export function alpineGeo() {
  const p: THREE.BufferGeometry[] = [],
    r = rng(9);
  for (let i = 0; i < 3; i++)
    blob(
      p,
      new THREE.Vector3((r() - 0.5) * 0.7, 0.22, (r() - 0.5) * 0.7),
      0.28 + r() * 0.14,
      N0,
      0.7,
      2,
    );
  return done(p);
}
export function alpineLow() {
  const p: THREE.BufferGeometry[] = [];
  blob(p, new THREE.Vector3(0, 0.25, 0), 0.5, N0, 0.6, 0);
  return done(p);
}
export function fernGeo(n = 6) {
  // ring of arched flat fronds
  const p: THREE.BufferGeometry[] = [],
    r = rng(21);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 6.283 + r() * 0.4,
      dir = new THREE.Vector3(
        Math.cos(a) * 0.85,
        0.55 + r() * 0.2,
        Math.sin(a) * 0.85,
      ).normalize(),
      len = 0.9 + r() * 0.35;
    const m = new THREE.Matrix4().compose(
      dir
        .clone()
        .multiplyScalar(len / 2)
        .add(new THREE.Vector3(0, 0.05, 0)),
      new THREE.Quaternion().setFromUnitVectors(UP, dir),
      new THREE.Vector3(1, 1, 0.3),
    );
    add(
      p,
      new THREE.ConeGeometry(0.14 * Math.sqrt(6 / n), len, 6),
      m,
      N0,
      len / 2,
      false,
      true,
    );
  }
  return done(p);
}
export function mushroomGeo() {
  // two toadstools; cap is neutral (white) so the shader picks red / brown / orange / pale / violet per instance
  const p: THREE.BufferGeometry[] = [];
  // dome profile: center tip → outward curve → rolled rim underside
  const capProfile = [
    new THREE.Vector2(0.0,  0.18),
    new THREE.Vector2(0.06, 0.17),
    new THREE.Vector2(0.12, 0.12),
    new THREE.Vector2(0.17, 0.04),
    new THREE.Vector2(0.18, -0.01),
    new THREE.Vector2(0.14, -0.03),
  ];
  for (let i = 0; i < 2; i++) {
    const x = i ? 0.28 : 0,
      z = i ? -0.12 : 0,
      h = 0.30 + i * 0.10,
      s = 1 - i * 0.3;
    cyl(p, new THREE.Vector3(x, 0, z), new THREE.Vector3(x, h, z), 0.038 * s, 0.028 * s, C(0x9a8f7a), 6);
    const scaled = capProfile.map(v => new THREE.Vector2(v.x * s, v.y * s));
    add(p, new THREE.LatheGeometry(scaled, 8), T(x, h + 0.02 * s, z), new THREE.Color(1, 1, 1), 0.18 * s, false, true);
  }
  return done(p);
}
export function reedGeo(blades = 8) {
  const p: THREE.BufferGeometry[] = [],
    r = rng(11);
  for (let i = 0; i < blades; i++) {
    const h = 1.1 + r() * 0.8,
      a = r() * 6.283,
      rad = r() * 0.18,
      m = new THREE.Matrix4().compose(
        new THREE.Vector3(Math.cos(a) * rad, h / 2, Math.sin(a) * rad),
        new THREE.Quaternion().setFromEuler(
          new THREE.Euler((r() - 0.5) * 0.25, 0, (r() - 0.5) * 0.25),
        ),
        new THREE.Vector3(1, 1, 1),
      );
    add(
      p,
      new THREE.ConeGeometry(0.035 * (8 / blades) ** 0.5, h, 5, 1, true),
      m,
      new THREE.Color().setHSL(0.2 + r() * 0.05, 0.5, 0.3 + r() * 0.08),
      h / 2,
    );
  }
  for (let i = 0; i < (blades > 4 ? 2 : 1); i++)
    cyl(
      p,
      new THREE.Vector3(i * 0.1 - 0.05, 1.3, 0),
      new THREE.Vector3(i * 0.1 - 0.05, 1.55, 0),
      0.05,
      0.05,
      C(0x5a3b1e),
      6,
    );
  return done(p);
}
// very-distant tier: 8-face octahedra (24 vertices)
const tiny = (
  c: THREE.Color,
  y: number,
  sx: number,
  sy: number,
  leaf: boolean,
) => {
  const p: THREE.BufferGeometry[] = [];
  add(
    p,
    new THREE.OctahedronGeometry(1, 0),
    new THREE.Matrix4().compose(
      new THREE.Vector3(0, y, 0),
      new THREE.Quaternion(),
      new THREE.Vector3(sx, sy, sx),
    ),
    c,
    sy,
    true,
    leaf,
  );
  return done(p);
};
export const shrubTiny = () => tiny(N0, 0.4, 0.75, 0.55, true);
export const alpineTiny = () => tiny(N0, 0.25, 0.5, 0.3, true);
