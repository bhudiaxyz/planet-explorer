import * as THREE from "three";
const V = THREE.Vector3;
export const sm = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const mk = () => ({ f: 0, n: new V(), u: new V(), v: new V(), i: 0, j: 0 });
export type Frame = ReturnType<typeof mk>;
// Fixed cube-face lattice anchored to the planet (chunks, ground cover and the coarse mesh share it). Pass a scratch `o` to avoid allocations in per-frame code.
export function frame(
  d: THREE.Vector3,
  R: number,
  cell: number,
  o: Frame = mk(),
): Frame {
  const ax = Math.abs(d.x),
    ay = Math.abs(d.y),
    az = Math.abs(d.z);
  let f = 0,
    m = ax;
  if (ay > m) {
    f = 1;
    m = ay;
  }
  if (az > m) f = 2;
  o.f = f;
  o.n
    .set(0, 0, 0)
    .setComponent(f, Math.sign(f === 0 ? d.x : f === 1 ? d.y : d.z));
  if (f === 1) o.u.set(1, 0, 0);
  else o.u.set(0, 1, 0);
  o.v.crossVectors(o.n, o.u);
  const dn = d.dot(o.n);
  o.i = Math.round(((d.dot(o.u) / dn) * R) / cell);
  o.j = Math.round(((d.dot(o.v) / dn) * R) / cell);
  return o;
}

export function basisFromCode(
  code: number,
  n: THREE.Vector3,
  u: THREE.Vector3,
  v: THREE.Vector3,
) {
  const f = (code / 2) | 0;
  n.set(0, 0, 0).setComponent(f, code % 2 === 0 ? 1 : -1);
  if (f === 1) u.set(1, 0, 0);
  else u.set(0, 1, 0);
  v.crossVectors(n, u);
}
