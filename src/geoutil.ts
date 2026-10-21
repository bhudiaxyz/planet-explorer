import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
// Shared procedural-geometry helpers: every plant/tree part is baked into one merged, vertex-coloured, non-indexed geometry.
// Foliage parts carry aLeaf = 1 and a neutral height-AO shade (hue is supplied per tree / per plant); other parts keep their own colour.
export const UP = new THREE.Vector3(0, 1, 0),
  C = (h: number) => new THREE.Color(h);
export const N0 = C(0);
const hh = (x: number, y: number, z: number) => {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
};

// Bake one primitive into the part list. Foliage (leaf = true) gets a neutral height-AO shade; other parts keep their colour. soft = jittered blob with radial normals.
export function add(
  parts: THREE.BufferGeometry[],
  g0: THREE.BufferGeometry,
  m: THREE.Matrix4,
  c: THREE.Color,
  ao = 0,
  soft = false,
  leaf = false,
) {
  const g = g0.index ? g0.toNonIndexed() : g0.clone();
  g.deleteAttribute("uv");
  const p = g.attributes.position,
    n = g.attributes.normal,
    ctr = new THREE.Vector3().setFromMatrixPosition(m),
    col = new Float32Array(p.count * 3),
    t = new THREE.Vector3(),
    cc = new THREE.Color();
  if (soft)
    for (let i = 0; i < p.count; i++) {
      const k = 1 + 0.6 * (hh(p.getX(i), p.getY(i), p.getZ(i)) - 0.5);
      p.setXYZ(i, p.getX(i) * k, p.getY(i) * k, p.getZ(i) * k);
    }
  g.applyMatrix4(m);
  for (let i = 0; i < p.count; i++) {
    if (soft) {
      t.fromBufferAttribute(p, i).sub(ctr).normalize();
      n.setXYZ(i, t.x, t.y, t.z);
    }
    const sh = ao
      ? 0.6 +
        0.55 * Math.min(1, Math.max(0, ((p.getY(i) - ctr.y) / ao) * 0.5 + 0.5))
      : 1;
    if (leaf) cc.setRGB(sh, sh, sh);
    else cc.copy(c).multiplyScalar(sh);
    cc.toArray(col, i * 3);
  }
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  g.setAttribute(
    "aLeaf",
    new THREE.BufferAttribute(new Float32Array(p.count).fill(leaf ? 1 : 0), 1),
  );
  parts.push(g);
}
export const T = (x: number, y: number, z: number) =>
  new THREE.Matrix4().makeTranslation(x, y, z);
export function cyl(
  p: THREE.BufferGeometry[],
  a: THREE.Vector3,
  b: THREE.Vector3,
  r0: number,
  r1: number,
  c: THREE.Color,
  seg = 6,
) {
  const m = new THREE.Matrix4().compose(
    a.clone().add(b).multiplyScalar(0.5),
    new THREE.Quaternion().setFromUnitVectors(UP, b.clone().sub(a).normalize()),
    new THREE.Vector3(1, 1, 1),
  );
  add(p, new THREE.CylinderGeometry(r1, r0, a.distanceTo(b), seg, 1), m, c);
}
export const blob = (
  p: THREE.BufferGeometry[],
  c0: THREE.Vector3,
  r: number,
  c: THREE.Color,
  sy = 0.8,
  det = 1,
  leaf = true,
) =>
  add(
    p,
    new THREE.IcosahedronGeometry(1, det),
    new THREE.Matrix4().compose(
      c0,
      new THREE.Quaternion(),
      new THREE.Vector3(r, r * sy, r),
    ),
    c,
    r * sy,
    true,
    leaf,
  );
export const done = (p: THREE.BufferGeometry[]) => mergeGeometries(p)!;
export function frond(
  p: THREE.BufferGeometry[],
  a: THREE.Vector3,
  b: THREE.Vector3,
  w: number,
  c: THREE.Color,
) {
  const len = a.distanceTo(b),
    m = new THREE.Matrix4().compose(
      a.clone().add(b).multiplyScalar(0.5),
      new THREE.Quaternion().setFromUnitVectors(
        UP,
        b.clone().sub(a).normalize(),
      ),
      new THREE.Vector3(1, 1, 0.28),
    );
  add(p, new THREE.ConeGeometry(w, len, 4), m, c, len / 2, false, true);
}
