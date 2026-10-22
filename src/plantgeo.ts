import * as THREE from "three";
import { rng } from "./noise";
import { CurrentPalette } from "./palette";
import { UP, N0, add, T, cyl, blob, done } from "./geoutil";

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
  cyl(p, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0.35, 0), 0.015, 0.012, new THREE.Color(CurrentPalette.plantStem), 6);
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
    cyl(p, new THREE.Vector3(x, 0, z), new THREE.Vector3(x, h, z), 0.038 * s, 0.028 * s, new THREE.Color(CurrentPalette.cactusSkin), 6);
    const scaled = capProfile.map(v => new THREE.Vector2(v.x * s, v.y * s));
    add(p, new THREE.LatheGeometry(scaled, 8), T(x, h + 0.02 * s, z), new THREE.Color(1, 1, 1), 0.18 * s, false, true);
  }
  return done(p);
}

export function cactusGeo() {
  const p: THREE.BufferGeometry[] = [];
  const skin = new THREE.Color(CurrentPalette.cactusSkin);
  const base = new THREE.Color(CurrentPalette.cactusBase);
  // main trunk: base 0 → top 0.9, tapered
  cyl(p, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0.9, 0), 0.10, 0.07, skin, 6);
  // left arm: from trunk mid, angled outward then upward
  cyl(p, new THREE.Vector3(0, 0.45, 0), new THREE.Vector3(-0.28, 0.45, 0), 0.055, 0.055, skin, 5);
  cyl(p, new THREE.Vector3(-0.28, 0.45, 0), new THREE.Vector3(-0.28, 0.75, 0), 0.055, 0.04, skin, 5);
  // right arm: opposite side, slightly higher
  cyl(p, new THREE.Vector3(0, 0.55, 0), new THREE.Vector3(0.26, 0.55, 0), 0.05, 0.05, skin, 5);
  cyl(p, new THREE.Vector3(0.26, 0.55, 0), new THREE.Vector3(0.26, 0.82, 0), 0.05, 0.035, skin, 5);
  // base collar
  cyl(p, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0.06, 0), 0.13, 0.11, base, 6);
  return done(p);
}

export function cactusLow() {
  const p: THREE.BufferGeometry[] = [];
  blob(p, new THREE.Vector3(0, 0.45, 0), 0.28, N0, 1.6, 0);
  return done(p);
}

export function deadScrubGeo() {
  const p: THREE.BufferGeometry[] = [];
  const wood = new THREE.Color(0.18, 0.14, 0.10);
  const r = rng(37);
  // central trunk
  cyl(p, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0.55, 0), 0.035, 0.022, wood, 5);
  // 5 bare branches at random upward angles
  const angles = [0, 1.26, 2.51, 3.77, 5.03];
  for (let i = 0; i < 5; i++) {
    const a = angles[i] + r() * 0.5;
    const tilt = 0.35 + r() * 0.3; // outward lean
    const len = 0.35 + r() * 0.25;
    const bx = Math.cos(a) * tilt * len;
    const bz = Math.sin(a) * tilt * len;
    const by = Math.sqrt(len * len - bx * bx - bz * bz);
    const base = new THREE.Vector3(0, 0.38 + r() * 0.15, 0);
    const tip = base.clone().add(new THREE.Vector3(bx, by, bz));
    cyl(p, base, tip, 0.018, 0.008, wood, 4);
  }
  return done(p);
}

export function deadScrubLow() {
  const p: THREE.BufferGeometry[] = [];
  add(
    p,
    new THREE.OctahedronGeometry(1, 0),
    new THREE.Matrix4().compose(
      new THREE.Vector3(0, 0.35, 0),
      new THREE.Quaternion(),
      new THREE.Vector3(0.45, 0.38, 0.45),
    ),
    new THREE.Color(0.18, 0.14, 0.10),
    0.38,
    false,
    false,
  );
  return done(p);
}

export function sedgeGeo() {
  const p: THREE.BufferGeometry[] = [];
  const r = rng(43);
  const straw = new THREE.Color(0.55, 0.52, 0.22);
  const green = new THREE.Color(0.22, 0.38, 0.12);
  const stemCount = 7;
  for (let i = 0; i < stemCount; i++) {
    const a = (i / stemCount) * 6.283 + r() * 0.3;
    const rad = 0.04 + r() * 0.07;
    const h = 1.2 + r() * 0.6;
    const ox = Math.cos(a) * rad;
    const oz = Math.sin(a) * rad;
    const tx = Math.cos(a) * (rad + 0.12 + r() * 0.08);
    const tz = Math.sin(a) * (rad + 0.12 + r() * 0.08);
    const col = r() > 0.5 ? straw : green;
    cyl(
      p,
      new THREE.Vector3(ox, 0, oz),
      new THREE.Vector3(tx, h, tz),
      0.012,
      0.006,
      col,
      4,
    );
  }
  return done(p);
}

export function sedgeLow() {
  const p: THREE.BufferGeometry[] = [];
  // two crossed flat quads suggest a tuft silhouette cheaply
  for (let i = 0; i < 2; i++) {
    const a = i * 1.5708; // 0 and 90 degrees
    add(
      p,
      new THREE.PlaneGeometry(0.38, 1.4),
      new THREE.Matrix4().compose(
        new THREE.Vector3(0, 0.7, 0),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, a, 0)),
        new THREE.Vector3(1, 1, 1),
      ),
      new THREE.Color(0.45, 0.42, 0.18),
      0.7,
      false,
      true,
    );
  }
  return done(p);
}

export const cactusTiny = () => tiny(N0, 0.45, 0.22, 0.7, false);
export const deadScrubTiny = () => tiny(new THREE.Color(0.18, 0.14, 0.10), 0.35, 0.4, 0.35, false);
export const sedgeTiny = () => tiny(N0, 0.7, 0.18, 1.0, true);

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
      new THREE.Color(CurrentPalette.cactusBase),
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
