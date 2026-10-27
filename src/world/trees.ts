import * as THREE from "three";
import { rng } from "../core/noise";
import { CurrentPalette } from "../core/palette";
import { N0, add, T, cyl, blob, done, frond } from "./geoutil";
export { treeMats } from "../render/treemat";

// ---- species builders; q = 1 detailed tier, q = 0.5 medium tier (same seed → same height/lean, so tiers match in silhouette). Foliage hue comes from LEAF × per-tree variation.
function pine(r: () => number, q: number) {
  const hq = q > 0.7,
    p: THREE.BufferGeometry[] = [],
    h = 11 + r() * 4;
  cyl(
    p,
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, h * 0.92, 0),
    0.5,
    0.1,
    new THREE.Color(CurrentPalette.treeBark[0]),
    hq ? 6 : 5
  );
  const n = hq ? 8 : 4; // extra whorls at HQ for a denser layered silhouette
  for (let i = 0; i < n; i++) {
    const ch = h * (hq ? 0.28 : 0.38),
      rad = 3.4 * (1 - (i / n) * 0.84) * (0.9 + 0.2 * r()),
      y = h * (0.15 + (hq ? 0.11 : 0.2) * i);
    add(
      p,
      new THREE.ConeGeometry(rad, ch, hq ? 9 : 6),
      T(0, y + ch / 2, 0),
      N0,
      ch / 2,
      false,
      true
    );
  }
  return done(p);
}
function oak(r: () => number, q: number) {
  const hq = q > 0.7,
    det = hq ? 1 : 0,
    p: THREE.BufferGeometry[] = [],
    h = 4.5 + r() * 2,
    bark = new THREE.Color(CurrentPalette.treeBark[1]);
  cyl(
    p,
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0.3 * (r() - 0.5), h * 0.6, 0.3 * (r() - 0.5)),
    0.7,
    0.45,
    bark
  );
  cyl(p, new THREE.Vector3(0, h * 0.6, 0), new THREE.Vector3(0, h, 0), 0.45, 0.2, bark);
  const nb = hq ? 5 : 3;
  for (let k = 0; k < nb; k++) {
    const a = k * (6.283 / nb) + r(),
      b = new THREE.Vector3(0, h * (0.55 + 0.4 * r()), 0),
      tip = b
        .clone()
        .add(
          new THREE.Vector3(Math.cos(a), 0.55, Math.sin(a))
            .normalize()
            .multiplyScalar(2.4 + r() * 1.5)
        );
    cyl(p, b, tip, 0.3, 0.1, bark);
    blob(p, tip.clone().add(new THREE.Vector3(0, 0.8, 0)), 2.2 + r() * 0.9, N0, 0.8, det);
    // secondary sub-clusters at HQ for denser, more naturalistic crown
    if (hq) {
      const a2 = a + 0.6 + r() * 0.4,
        d2 = tip
          .clone()
          .add(
            new THREE.Vector3(
              Math.cos(a2) * (1.0 + r() * 0.5),
              0.4 + r() * 0.3,
              Math.sin(a2) * (1.0 + r() * 0.5)
            )
          );
      blob(p, d2, 1.3 + r() * 0.5, N0, 0.85, det);
    }
  }
  blob(p, new THREE.Vector3(0, h + 1.6, 0), 3.3, N0, 0.8, det);
  blob(p, new THREE.Vector3(0, h + 0.2, 0), 2.6, N0, 0.8, det);
  if (hq) blob(p, new THREE.Vector3((r() - 0.5) * 2, h + 0.8, (r() - 0.5) * 2), 2.0, N0, 0.75, det);
  return done(p);
}
function birch(r: () => number, q: number) {
  const hq = q > 0.7,
    det = hq ? 1 : 0,
    p: THREE.BufferGeometry[] = [],
    h = 8 + r() * 3,
    bark = new THREE.Color(CurrentPalette.treeBark[2]);
  cyl(
    p,
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0.2 * (r() - 0.5), h, 0.2 * (r() - 0.5)),
    0.28,
    0.09,
    bark
  );
  const nb = hq ? 5 : 2;
  for (let k = 0; k < nb; k++) {
    const a = k * (6.4 / nb) + r(),
      b = new THREE.Vector3(0, h * (0.45 + 0.45 * r()), 0),
      tip = b
        .clone()
        .add(
          new THREE.Vector3(Math.cos(a), 0.8, Math.sin(a))
            .normalize()
            .multiplyScalar(1.8 + r() * 0.6)
        );
    cyl(p, b, tip, 0.12, 0.04, bark);
    blob(p, tip, 1.3 + r() * 0.6, N0, 0.9, det);
    // mid-crown spray at HQ: secondary branch cluster fills the inner canopy
    if (hq && r() > 0.3) {
      const a2 = a + 0.4,
        b2 = new THREE.Vector3(0, h * (0.55 + 0.3 * r()), 0),
        tip2 = b2
          .clone()
          .add(
            new THREE.Vector3(Math.cos(a2), 0.6, Math.sin(a2))
              .normalize()
              .multiplyScalar(1.2 + r() * 0.4)
          );
      cyl(p, b2, tip2, 0.08, 0.03, bark);
      blob(p, tip2, 1.0 + r() * 0.4, N0, 0.95, det);
    }
  }
  blob(p, new THREE.Vector3(0, h + 0.5, 0), 1.9, N0, 1.1, det);
  if (hq)
    blob(p, new THREE.Vector3((r() - 0.5) * 0.8, h + 0.0, (r() - 0.5) * 0.8), 1.5, N0, 1.0, det);
  return done(p);
}
function palm(r: () => number, q: number) {
  const hq = q > 0.7,
    p: THREE.BufferGeometry[] = [],
    h = 8 + r() * 4,
    bark = new THREE.Color(CurrentPalette.treeBark[3]),
    lean = (r() - 0.5) * 4;
  let prev = new THREE.Vector3(0, 0, 0);
  const ns = hq ? 4 : 2;
  for (let i = 1; i <= ns; i++) {
    const t = i / ns,
      cur = new THREE.Vector3(lean * t * t, h * t, 0);
    cyl(p, prev, cur, 0.5 - ((i - 1) / ns) * 0.28, 0.5 - (i / ns) * 0.28, bark);
    prev = cur;
  }
  const nf = hq ? 9 : 6;
  for (let k = 0; k < nf; k++) {
    const a = (k / nf) * 6.283 + r() * 0.3,
      d = new THREE.Vector3(Math.cos(a), 0, Math.sin(a)),
      m1 = prev
        .clone()
        .addScaledVector(d, 1.8)
        .add(new THREE.Vector3(0, 0.9, 0)),
      tip = m1
        .clone()
        .addScaledVector(d, 1.8)
        .add(new THREE.Vector3(0, -1.1, 0));
    frond(p, prev, m1, 0.5, N0);
    frond(p, m1, tip, 0.42, N0);
  }
  if (hq)
    for (let k = 0; k < 3; k++)
      blob(
        p,
        prev.clone().add(new THREE.Vector3((r() - 0.5) * 0.8, -0.4, (r() - 0.5) * 0.8)),
        0.28,
        new THREE.Color(CurrentPalette.cactusBase),
        1,
        0,
        false
      );
  return done(p);
}
function fir(r: () => number, q: number) {
  const hq = q > 0.7,
    p: THREE.BufferGeometry[] = [],
    h = 15 + r() * 5;
  cyl(
    p,
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, h * 0.95, 0),
    0.45,
    0.1,
    new THREE.Color(CurrentPalette.treeBark[4]),
    hq ? 6 : 5
  );
  const n = hq ? 9 : 6;
  for (let i = 0; i < n; i++) {
    const ch = h * (hq ? 0.22 : 0.3),
      rad = 2.7 * (1 - (i / n) * 0.88) * (0.9 + 0.2 * r()),
      y = h * (0.1 + (hq ? 0.093 : 0.14) * i);
    add(
      p,
      new THREE.ConeGeometry(rad, ch, hq ? 8 : 6),
      T(0, y + ch / 2, 0),
      N0,
      ch / 2,
      false,
      true
    );
  }
  return done(p);
}
function dead(r: () => number, q: number) {
  const hq = q > 0.7,
    p: THREE.BufferGeometry[] = [],
    h = 6 + r() * 3,
    bark = new THREE.Color(CurrentPalette.treeBark[5]);
  cyl(p, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.2, h, 0.1), 0.45, 0.12, bark);
  const nb = hq ? 6 : 3;
  for (let k = 0; k < nb; k++) {
    const a = k * (6.3 / nb) + r(),
      b = new THREE.Vector3(0.1, h * (0.4 + 0.55 * r()), 0.05),
      t1 = b
        .clone()
        .add(
          new THREE.Vector3(Math.cos(a), 0.7, Math.sin(a)).normalize().multiplyScalar(2 + r() * 1.5)
        );
    cyl(p, b, t1, 0.18, 0.05, bark);
    if (hq)
      cyl(
        p,
        t1,
        t1
          .clone()
          .add(
            new THREE.Vector3(Math.cos(a + 0.8), 0.8, Math.sin(a + 0.8))
              .normalize()
              .multiplyScalar(1.1)
          ),
        0.06,
        0.02,
        bark
      );
  }
  return done(p);
}
function acacia(r: () => number, q: number) {
  // flat umbrella crown on a leaning trunk (dry warm lowlands)
  const hq = q > 0.7,
    det = hq ? 1 : 0,
    p: THREE.BufferGeometry[] = [],
    h = 5 + r() * 2.5,
    bark = new THREE.Color(CurrentPalette.treeBark[6]),
    lean = (r() - 0.5) * 1.6;
  cyl(p, new THREE.Vector3(0, 0, 0), new THREE.Vector3(lean * 0.5, h * 0.6, 0), 0.55, 0.32, bark);
  cyl(
    p,
    new THREE.Vector3(lean * 0.5, h * 0.6, 0),
    new THREE.Vector3(lean, h, 0),
    0.32,
    0.18,
    bark
  );
  const nb = hq ? 4 : 2;
  for (let k = 0; k < nb; k++) {
    const a = k * (6.283 / nb) + r(),
      d = 1.8 + r() * 1.4;
    blob(
      p,
      new THREE.Vector3(lean + Math.cos(a) * d, h + 0.2 + r() * 0.5, Math.sin(a) * d),
      2.8 + r(),
      N0,
      0.28,
      det
    );
  }
  blob(p, new THREE.Vector3(lean, h + 0.7, 0), 3.6, N0, 0.3, det);
  return done(p);
}
function cypress(r: () => number, q: number) {
  // tall narrow spindle (drier mid-zone)
  const hq = q > 0.7,
    p: THREE.BufferGeometry[] = [],
    h = 12 + r() * 5;
  cyl(
    p,
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, h * 0.25, 0),
    0.4,
    0.25,
    new THREE.Color(CurrentPalette.treeBark[7]),
    hq ? 6 : 4
  );
  add(
    p,
    new THREE.ConeGeometry(1.9, h * 0.95, hq ? 8 : 6),
    T(0, h * 0.725, 0),
    N0,
    h * 0.475,
    false,
    true
  );
  if (hq) {
    blob(p, new THREE.Vector3(0, h * 0.45, 0), 1.6, N0, 1.9, 0);
    blob(p, new THREE.Vector3(0, h * 0.7, 0), 1.2, N0, 2.2, 0);
  }
  return done(p);
}
function willow(r: () => number, q: number) {
  // weeping silhouette: drooping branches with elongated blob clusters at tips
  const hq = q > 0.7,
    det = hq ? 1 : 0,
    p: THREE.BufferGeometry[] = [],
    h = 7 + r() * 3,
    bark = new THREE.Color(CurrentPalette.treeBark[8]),
    lean = (r() - 0.5) * 0.8;
  const mid = new THREE.Vector3(lean * 0.3, h * 0.55, 0),
    top = new THREE.Vector3(lean * 0.6, h * 0.85, 0);
  cyl(p, new THREE.Vector3(0, 0, 0), mid, 0.5, 0.32, bark, hq ? 6 : 4);
  cyl(p, mid, top, 0.32, 0.16, bark, hq ? 5 : 4);
  blob(p, new THREE.Vector3(lean * 0.65, h * 0.92, 0), 2.6, N0, 0.75, det);
  const nb = hq ? 5 : 3;
  for (let k = 0; k < nb; k++) {
    const a = (k / nb) * 6.283 + r() * 0.5,
      d = new THREE.Vector3(Math.cos(a), 0, Math.sin(a)),
      base = new THREE.Vector3(lean * 0.4, h * 0.72, 0),
      elbow = base
        .clone()
        .addScaledVector(d, 2.2 + r() * 0.8)
        .add(new THREE.Vector3(0, 1.0 + r() * 0.3, 0)),
      tip = elbow
        .clone()
        .addScaledVector(d, 1.0 + r() * 0.4)
        .add(new THREE.Vector3(0, -2.5 - r() * 0.8, 0));
    cyl(p, base, elbow, 0.1, 0.06, bark, hq ? 4 : 3);
    cyl(p, elbow, tip, 0.06, 0.02, bark, hq ? 4 : 3);
    blob(p, tip, 1.3 + r() * 0.4, N0, 1.4, det); // sy > 1: elongated droop blob
  }
  return done(p);
}
function mangrove(r: () => number, q: number) {
  // arched stilt roots converging to a junction; dense round tropical crown
  const hq = q > 0.7,
    det = hq ? 1 : 0,
    p: THREE.BufferGeometry[] = [],
    h = 4.5 + r() * 2,
    bark = new THREE.Color(CurrentPalette.treeBark[9]);
  const junction = new THREE.Vector3(0, h * 0.6, 0);
  const nroots = hq ? 4 : 3;
  for (let k = 0; k < nroots; k++) {
    const a = (k / nroots) * 6.283 + r() * 0.4,
      spread = 1.4 + r() * 0.5,
      ground = new THREE.Vector3(Math.cos(a) * spread, 0, Math.sin(a) * spread),
      arch = ground
        .clone()
        .add(junction)
        .multiplyScalar(0.5)
        .add(new THREE.Vector3(0, 0.7, 0));
    cyl(p, ground, arch, 0.1, 0.09, bark, hq ? 5 : 3);
    cyl(p, arch, junction, 0.09, 0.13, bark, hq ? 5 : 3);
  }
  cyl(p, junction, new THREE.Vector3(0, h, 0), 0.2, 0.1, bark, hq ? 5 : 3);
  blob(p, new THREE.Vector3(0, h + 1.4, 0), 2.8, N0, 0.72, det);
  if (hq) {
    blob(p, new THREE.Vector3(1.1, h + 0.7, 0.6), 1.7, N0, 0.68, det);
    blob(p, new THREE.Vector3(-0.9, h + 0.5, -0.7), 1.5, N0, 0.68, det);
  }
  return done(p);
}
const SP = [pine, oak, birch, palm, fir, dead, acacia, cypress, willow, mangrove]; // species index: pine 0 · oak 1 · birch 2 · palm 3 · fir 4 · snag 5 · acacia 6 · cypress 7 · willow 8 · mangrove 9
export const treeGeos = (seed: number, q = 1) => SP.map((f, i) => f(rng(seed + 55 + i * 31), q));
// base foliage colour per species (HSL in the working space); Forest multiplies in seasonal / blossom / drought variation per tree
export const getLeafColors = () =>
  CurrentPalette.treeLeavesHSL.map(([h, s, l]) => new THREE.Color().setHSL(h, s, l));

// ---- low-poly distance tier (a few dozen triangles)
const lowPine = (r: () => number) => {
  const p: THREE.BufferGeometry[] = [],
    h = 11 + r() * 4;
  cyl(
    p,
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, h * 0.5, 0),
    0.5,
    0.3,
    new THREE.Color(CurrentPalette.treeBark[0]),
    3
  );
  add(p, new THREE.ConeGeometry(3.2, h * 0.6, 6), T(0, h * 0.4, 0), N0, h * 0.3, false, true);
  add(p, new THREE.ConeGeometry(2, h * 0.45, 6), T(0, h * 0.75, 0), N0, h * 0.2, false, true);
  return done(p);
};
const lowBlob = (r: () => number, h0: number, rad: number) => {
  const p: THREE.BufferGeometry[] = [],
    h = h0 + r() * 2;
  cyl(
    p,
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, h, 0),
    0.5,
    0.25,
    new THREE.Color(CurrentPalette.treeBarkLow),
    3
  );
  blob(p, new THREE.Vector3(0, h + rad * 0.5, 0), rad, N0, 0.85, 0);
  return done(p);
};
const lowPalm = (r: () => number) => {
  const p: THREE.BufferGeometry[] = [],
    h = 8 + r() * 4;
  cyl(
    p,
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(1.5, h, 0),
    0.5,
    0.25,
    new THREE.Color(CurrentPalette.treeBark[3]),
    3
  );
  add(p, new THREE.CylinderGeometry(3.6, 0.4, 0.9, 6), T(1.5, h + 0.3, 0), N0, 0.45, false, true);
  return done(p);
};
const lowFir = (r: () => number) => {
  const p: THREE.BufferGeometry[] = [],
    h = 15 + r() * 5;
  cyl(
    p,
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, h * 0.5, 0),
    0.45,
    0.25,
    new THREE.Color(CurrentPalette.treeBark[4]),
    3
  );
  add(p, new THREE.ConeGeometry(2.7, h * 0.7, 6), T(0, h * 0.45, 0), N0, h * 0.35, false, true);
  add(p, new THREE.ConeGeometry(1.5, h * 0.4, 6), T(0, h * 0.78, 0), N0, h * 0.2, false, true);
  return done(p);
};
const lowDead = (r: () => number) => {
  const p: THREE.BufferGeometry[] = [],
    h = 6 + r() * 3,
    bark = new THREE.Color(CurrentPalette.treeBark[5]);
  cyl(p, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.2, h, 0.1), 0.45, 0.12, bark, 3);
  cyl(
    p,
    new THREE.Vector3(0.1, h * 0.6, 0),
    new THREE.Vector3(2, h * 0.9, 0.5),
    0.18,
    0.05,
    bark,
    3
  );
  cyl(p, new THREE.Vector3(0.1, h * 0.7, 0), new THREE.Vector3(-1.8, h, -0.4), 0.16, 0.05, bark, 3);
  return done(p);
};
const lowAcacia = (r: () => number) => {
  const p: THREE.BufferGeometry[] = [],
    h = 5 + r() * 2.5;
  cyl(
    p,
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0.5, h, 0),
    0.5,
    0.2,
    new THREE.Color(CurrentPalette.treeBark[6]),
    3
  );
  blob(p, new THREE.Vector3(0.5, h + 0.6, 0), 4.2, N0, 0.3, 0);
  return done(p);
};
const lowCypress = (r: () => number) => {
  const p: THREE.BufferGeometry[] = [],
    h = 12 + r() * 5;
  cyl(
    p,
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, h * 0.25, 0),
    0.4,
    0.25,
    new THREE.Color(CurrentPalette.treeBark[7]),
    3
  );
  add(p, new THREE.ConeGeometry(1.9, h * 0.95, 5), T(0, h * 0.725, 0), N0, h * 0.475, false, true);
  return done(p);
};
const lowWillow = (r: () => number) => {
  const p: THREE.BufferGeometry[] = [],
    h = 7 + r() * 3;
  cyl(
    p,
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0.3, h * 0.85, 0),
    0.5,
    0.18,
    new THREE.Color(CurrentPalette.treeBark[8]),
    3
  );
  blob(p, new THREE.Vector3(0.3, h * 0.88, 0), 3.2, N0, 0.88, 0); // wide, slightly drooping crown silhouette
  return done(p);
};
const lowMangrove = (r: () => number) => {
  const p: THREE.BufferGeometry[] = [],
    h = 4.5 + r() * 2,
    bark = new THREE.Color(CurrentPalette.treeBark[9]);
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * 6.283;
    cyl(
      p,
      new THREE.Vector3(Math.cos(a) * 1.4, 0, Math.sin(a) * 1.4),
      new THREE.Vector3(0, h * 0.6, 0),
      0.1,
      0.15,
      bark,
      3
    );
  }
  cyl(p, new THREE.Vector3(0, h * 0.6, 0), new THREE.Vector3(0, h, 0), 0.18, 0.1, bark, 3);
  blob(p, new THREE.Vector3(0, h + 1.2, 0), 3.0, N0, 0.7, 0);
  return done(p);
};
export const lowGeos = (seed: number) => {
  const r = rng(seed + 56);
  return [
    lowPine(r),
    lowBlob(r, 4.5, 3.8),
    lowBlob(r, 8, 2.2),
    lowPalm(r),
    lowFir(r),
    lowDead(r),
    lowAcacia(r),
    lowCypress(r),
    lowWillow(r),
    lowMangrove(r),
  ];
};
