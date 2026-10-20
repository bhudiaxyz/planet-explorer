import * as THREE from "three";
import { rng } from "./noise";
import { wind, U, IGN, TINT_GLSL } from "./fx";
import { T as TU } from "./gpu";
import { V, C, N0, add, T, cyl, blob, done, frond } from "./geoutil";

// Three tree tiers (0 detailed · 1 medium · 2 low-poly) cross-fade with strictly complementary screen-door dither over uLod = (H0,H1,M0,M1) metres:
// tier0 keeps noise ≥ a, tier1 keeps b ≤ noise < a, tier2 keeps noise < b  (a = smoothstep(H0,H1,d) ≥ b = smoothstep(M0,M1,d)) → no holes, no double coverage, no pops.
// Foliage vertices carry aLeaf = 1 and a NEUTRAL shaded colour; the per-tree hue comes from instanceColor (autumn, blossom, drought, species…). Trunks (aLeaf = 0) ignore it.
// The low-poly tier has no wind (it is never close enough to see sway), which removes the sin/cos work from ~1 M vertices per frame.
function treeMat(tier: number) {
  const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.85,
    }),
    m = tier === 2 ? mat : wind(mat, 0.002),
    base = tier === 2 ? null : (m.onBeforeCompile as any);
  const keep =
    tier === 0
      ? "if(lodN<lodA)discard;"
      : tier === 1
        ? "if(lodN>=lodA||lodN<lodB)discard;"
        : "if(lodN>=lodB)discard;";
  const cull =
    tier === 2
      ? "vec3 wpL=(modelMatrix*instanceMatrix*vec4(transformed,1.)).xyz;float crL=length(cameraPosition);if(vLd<uLod.z-20.||dot(normalize(wpL),cameraPosition/crL)<length(wpL)/crL-.06)gl_Position=vec4(2.,2.,2.,1.);"
      : "";
  m.customProgramCacheKey = () => "tree" + tier;
  m.onBeforeCompile = (s: any, r: any) => {
    if (base) base(s, r);
    s.uniforms.uLod = U.uLod;
    s.uniforms.uSun = U.uSun;
    s.uniforms.uDayF = U.uDayF;
    s.uniforms.uSnow = TU.uSnow;
    s.uniforms.uAmp = TU.uAmp;
    s.uniforms.uR = TU.uR;
    s.uniforms.uCw = TU.uCw;
    s.vertexShader = s.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nvarying float vLd;varying vec3 vWt;uniform vec4 uLod;attribute float aLeaf;",
      )
      .replace(
        "#include <color_vertex>",
        "#include <color_vertex>\nvColor.rgb=color*mix(vec3(1.),instanceColor,aLeaf);",
      )
      .replace(
        "#include <project_vertex>",
        "#include <project_vertex>\nvWt=(modelMatrix*instanceMatrix*vec4(transformed,1.)).xyz;vLd=length(vWt-cameraPosition);" +
          cull,
      );
    s.fragmentShader = s.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\nvarying float vLd;varying vec3 vWt;uniform vec4 uLod;uniform vec3 uSun,uCw;uniform float uDayF,uSnow,uAmp,uR;" +
          IGN,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>\nfloat lodA=smoothstep(uLod.x,uLod.y,vLd),lodB=smoothstep(uLod.z,uLod.w,vLd),lodN=ign(gl_FragCoord.xy);${keep}`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        "#include <emissivemap_fragment>\n{vec3 sv=normalize((viewMatrix*vec4(uSun,0.)).xyz);float tr=pow(clamp(dot(-normalize(vViewPosition),sv),0.,1.),3.)*(1.-clamp(dot(normal,sv),0.,1.))*uDayF;totalEmissiveRadiance+=diffuseColor.rgb*tr*.55;vec3 nw=normalize(vWt);float tt=1.-1.1*nw.y*nw.y-1.2*max((length(vWt)-uR)/uAmp,0.),sn=1.-smoothstep(uSnow-.02,uSnow+.16,tt),upf=smoothstep(.15,.7,dot(normal,(viewMatrix*vec4(nw,0.)).xyz));diffuseColor.rgb=mix(diffuseColor.rgb,uCw*.95,sn*upf*.85);}\n" +
          TINT_GLSL,
      );
  };
  return m;
}
export const treeMats = [0, 1, 2].map(treeMat);

// ---- species builders; q = 1 detailed tier, q = 0.5 medium tier (same seed → same height/lean, so tiers match in silhouette). Foliage hue comes from LEAF × per-tree variation.
function pine(r: () => number, q: number) {
  const hq = q > 0.7,
    p: THREE.BufferGeometry[] = [],
    h = 11 + r() * 4;
  cyl(
    p,
    new V(0, 0, 0),
    new V(0, h * 0.92, 0),
    0.5,
    0.1,
    C(0x4a3524),
    hq ? 6 : 5,
  );
  const n = hq ? 6 : 4;
  for (let i = 0; i < n; i++) {
    const ch = h * (hq ? 0.3 : 0.38),
      rad = 3.4 * (1 - (i / n) * 0.82) * (0.9 + 0.2 * r()),
      y = h * (0.2 + (hq ? 0.14 : 0.2) * i);
    add(
      p,
      new THREE.ConeGeometry(rad, ch, hq ? 9 : 6),
      T(0, y + ch / 2, 0),
      N0,
      ch / 2,
      false,
      true,
    );
  }
  return done(p);
}
function oak(r: () => number, q: number) {
  const hq = q > 0.7,
    det = hq ? 1 : 0,
    p: THREE.BufferGeometry[] = [],
    h = 4.5 + r() * 2,
    bark = C(0x5b4430);
  cyl(
    p,
    new V(0, 0, 0),
    new V(0.3 * (r() - 0.5), h * 0.6, 0.3 * (r() - 0.5)),
    0.7,
    0.45,
    bark,
  );
  cyl(p, new V(0, h * 0.6, 0), new V(0, h, 0), 0.45, 0.2, bark);
  const nb = hq ? 5 : 3;
  for (let k = 0; k < nb; k++) {
    const a = k * (6.283 / nb) + r(),
      b = new V(0, h * (0.55 + 0.4 * r()), 0),
      tip = b
        .clone()
        .add(
          new V(Math.cos(a), 0.55, Math.sin(a))
            .normalize()
            .multiplyScalar(2.4 + r() * 1.5),
        );
    cyl(p, b, tip, 0.3, 0.1, bark);
    blob(p, tip.add(new V(0, 0.8, 0)), 2.2 + r() * 0.9, N0, 0.8, det);
  }
  blob(p, new V(0, h + 1.6, 0), 3.3, N0, 0.8, det);
  blob(p, new V(0, h + 0.2, 0), 2.6, N0, 0.8, det);
  return done(p);
}
function birch(r: () => number, q: number) {
  const hq = q > 0.7,
    det = hq ? 1 : 0,
    p: THREE.BufferGeometry[] = [],
    h = 8 + r() * 3,
    bark = C(0xe4e0d2);
  cyl(
    p,
    new V(0, 0, 0),
    new V(0.2 * (r() - 0.5), h, 0.2 * (r() - 0.5)),
    0.28,
    0.09,
    bark,
  );
  const nb = hq ? 4 : 2;
  for (let k = 0; k < nb; k++) {
    const a = k * (6.4 / nb) + r(),
      b = new V(0, h * (0.5 + 0.4 * r()), 0),
      tip = b
        .clone()
        .add(
          new V(Math.cos(a), 0.8, Math.sin(a)).normalize().multiplyScalar(1.8),
        );
    cyl(p, b, tip, 0.12, 0.04, bark);
    blob(p, tip, 1.3 + r() * 0.6, N0, 0.9, det);
  }
  blob(p, new V(0, h + 0.5, 0), 1.9, N0, 1.1, det);
  return done(p);
}
function palm(r: () => number, q: number) {
  const hq = q > 0.7,
    p: THREE.BufferGeometry[] = [],
    h = 8 + r() * 4,
    bark = C(0x8a7355),
    lean = (r() - 0.5) * 4;
  let prev = new V(0, 0, 0);
  const ns = hq ? 4 : 2;
  for (let i = 1; i <= ns; i++) {
    const t = i / ns,
      cur = new V(lean * t * t, h * t, 0);
    cyl(p, prev, cur, 0.5 - ((i - 1) / ns) * 0.28, 0.5 - (i / ns) * 0.28, bark);
    prev = cur;
  }
  const nf = hq ? 9 : 6;
  for (let k = 0; k < nf; k++) {
    const a = (k / nf) * 6.283 + r() * 0.3,
      d = new V(Math.cos(a), 0, Math.sin(a)),
      m1 = prev
        .clone()
        .addScaledVector(d, 1.8)
        .add(new V(0, 0.9, 0)),
      tip = m1
        .clone()
        .addScaledVector(d, 1.8)
        .add(new V(0, -1.1, 0));
    frond(p, prev, m1, 0.5, N0);
    frond(p, m1, tip, 0.42, N0);
  }
  if (hq)
    for (let k = 0; k < 3; k++)
      blob(
        p,
        prev.clone().add(new V((r() - 0.5) * 0.8, -0.4, (r() - 0.5) * 0.8)),
        0.28,
        C(0x5a3b1e),
        1,
        0,
        false,
      );
  return done(p);
}
function fir(r: () => number, q: number) {
  const hq = q > 0.7,
    p: THREE.BufferGeometry[] = [],
    h = 15 + r() * 5;
  cyl(
    p,
    new V(0, 0, 0),
    new V(0, h * 0.95, 0),
    0.45,
    0.1,
    C(0x3e2e22),
    hq ? 6 : 5,
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
      true,
    );
  }
  return done(p);
}
function dead(r: () => number, q: number) {
  const hq = q > 0.7,
    p: THREE.BufferGeometry[] = [],
    h = 6 + r() * 3,
    bark = C(0x6a645a);
  cyl(p, new V(0, 0, 0), new V(0.2, h, 0.1), 0.45, 0.12, bark);
  const nb = hq ? 6 : 3;
  for (let k = 0; k < nb; k++) {
    const a = k * (6.3 / nb) + r(),
      b = new V(0.1, h * (0.4 + 0.55 * r()), 0.05),
      t1 = b
        .clone()
        .add(
          new V(Math.cos(a), 0.7, Math.sin(a))
            .normalize()
            .multiplyScalar(2 + r() * 1.5),
        );
    cyl(p, b, t1, 0.18, 0.05, bark);
    if (hq)
      cyl(
        p,
        t1,
        t1
          .clone()
          .add(
            new V(Math.cos(a + 0.8), 0.8, Math.sin(a + 0.8))
              .normalize()
              .multiplyScalar(1.1),
          ),
        0.06,
        0.02,
        bark,
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
    bark = C(0x6b5440),
    lean = (r() - 0.5) * 1.6;
  cyl(p, new V(0, 0, 0), new V(lean * 0.5, h * 0.6, 0), 0.55, 0.32, bark);
  cyl(p, new V(lean * 0.5, h * 0.6, 0), new V(lean, h, 0), 0.32, 0.18, bark);
  const nb = hq ? 4 : 2;
  for (let k = 0; k < nb; k++) {
    const a = k * (6.283 / nb) + r(),
      d = 1.8 + r() * 1.4;
    blob(
      p,
      new V(lean + Math.cos(a) * d, h + 0.2 + r() * 0.5, Math.sin(a) * d),
      2.8 + r(),
      N0,
      0.28,
      det,
    );
  }
  blob(p, new V(lean, h + 0.7, 0), 3.6, N0, 0.3, det);
  return done(p);
}
function cypress(r: () => number, q: number) {
  // tall narrow spindle (drier mid-zone)
  const hq = q > 0.7,
    p: THREE.BufferGeometry[] = [],
    h = 12 + r() * 5;
  cyl(
    p,
    new V(0, 0, 0),
    new V(0, h * 0.25, 0),
    0.4,
    0.25,
    C(0x4a3a2c),
    hq ? 6 : 4,
  );
  add(
    p,
    new THREE.ConeGeometry(1.9, h * 0.95, hq ? 8 : 6),
    T(0, h * 0.725, 0),
    N0,
    h * 0.475,
    false,
    true,
  );
  if (hq) {
    blob(p, new V(0, h * 0.45, 0), 1.6, N0, 1.9, 0);
    blob(p, new V(0, h * 0.7, 0), 1.2, N0, 2.2, 0);
  }
  return done(p);
}
const SP = [pine, oak, birch, palm, fir, dead, acacia, cypress]; // species index: pine 0 · oak 1 · birch 2 · palm 3 · fir 4 · snag 5 · acacia 6 · cypress 7 (one geometry each; variety comes from per-tree scale/tilt/hue)
export const treeGeos = (seed: number, q = 1) =>
  SP.map((f, i) => f(rng(seed + 55 + i * 31), q));
// base foliage colour per species (HSL in the working space); Forest multiplies in seasonal / blossom / drought variation per tree
export const LEAF = [
  [0.36, 0.45, 0.2],
  [0.27, 0.5, 0.28],
  [0.2, 0.55, 0.39],
  [0.27, 0.55, 0.27],
  [0.43, 0.38, 0.16],
  [0, 0, 0.5],
  [0.2, 0.5, 0.3],
  [0.4, 0.4, 0.13],
].map(([h, s, l]) => new THREE.Color().setHSL(h, s, l));

// ---- low-poly distance tier (a few dozen triangles)
const lowPine = (r: () => number) => {
  const p: THREE.BufferGeometry[] = [],
    h = 11 + r() * 4;
  cyl(p, new V(0, 0, 0), new V(0, h * 0.5, 0), 0.5, 0.3, C(0x4a3524), 3);
  add(
    p,
    new THREE.ConeGeometry(3.2, h * 0.6, 6),
    T(0, h * 0.4, 0),
    N0,
    h * 0.3,
    false,
    true,
  );
  add(
    p,
    new THREE.ConeGeometry(2, h * 0.45, 6),
    T(0, h * 0.75, 0),
    N0,
    h * 0.2,
    false,
    true,
  );
  return done(p);
};
const lowBlob = (r: () => number, h0: number, rad: number) => {
  const p: THREE.BufferGeometry[] = [],
    h = h0 + r() * 2;
  cyl(p, new V(0, 0, 0), new V(0, h, 0), 0.5, 0.25, C(0x6b5a45), 3);
  blob(p, new V(0, h + rad * 0.5, 0), rad, N0, 0.85, 0);
  return done(p);
};
const lowPalm = (r: () => number) => {
  const p: THREE.BufferGeometry[] = [],
    h = 8 + r() * 4;
  cyl(p, new V(0, 0, 0), new V(1.5, h, 0), 0.5, 0.25, C(0x8a7355), 3);
  add(
    p,
    new THREE.CylinderGeometry(3.6, 0.4, 0.9, 6),
    T(1.5, h + 0.3, 0),
    N0,
    0.45,
    false,
    true,
  );
  return done(p);
};
const lowFir = (r: () => number) => {
  const p: THREE.BufferGeometry[] = [],
    h = 15 + r() * 5;
  cyl(p, new V(0, 0, 0), new V(0, h * 0.5, 0), 0.45, 0.25, C(0x3e2e22), 3);
  add(
    p,
    new THREE.ConeGeometry(2.7, h * 0.7, 6),
    T(0, h * 0.45, 0),
    N0,
    h * 0.35,
    false,
    true,
  );
  add(
    p,
    new THREE.ConeGeometry(1.5, h * 0.4, 6),
    T(0, h * 0.78, 0),
    N0,
    h * 0.2,
    false,
    true,
  );
  return done(p);
};
const lowDead = (r: () => number) => {
  const p: THREE.BufferGeometry[] = [],
    h = 6 + r() * 3,
    bark = C(0x6a645a);
  cyl(p, new V(0, 0, 0), new V(0.2, h, 0.1), 0.45, 0.12, bark, 3);
  cyl(p, new V(0.1, h * 0.6, 0), new V(2, h * 0.9, 0.5), 0.18, 0.05, bark, 3);
  cyl(p, new V(0.1, h * 0.7, 0), new V(-1.8, h, -0.4), 0.16, 0.05, bark, 3);
  return done(p);
};
const lowAcacia = (r: () => number) => {
  const p: THREE.BufferGeometry[] = [],
    h = 5 + r() * 2.5;
  cyl(p, new V(0, 0, 0), new V(0.5, h, 0), 0.5, 0.2, C(0x6b5440), 3);
  blob(p, new V(0.5, h + 0.6, 0), 4.2, N0, 0.3, 0);
  return done(p);
};
const lowCypress = (r: () => number) => {
  const p: THREE.BufferGeometry[] = [],
    h = 12 + r() * 5;
  cyl(p, new V(0, 0, 0), new V(0, h * 0.25, 0), 0.4, 0.25, C(0x4a3a2c), 3);
  add(
    p,
    new THREE.ConeGeometry(1.9, h * 0.95, 5),
    T(0, h * 0.725, 0),
    N0,
    h * 0.475,
    false,
    true,
  );
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
  ];
};
