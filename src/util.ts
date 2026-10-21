import * as THREE from "three";
export const smoothstep = (edge0: number, edge1: number, value: number) => {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};
const makeFrame = () => ({
  face: 0,
  normal: new THREE.Vector3(),
  tangentU: new THREE.Vector3(),
  tangentV: new THREE.Vector3(),
  cellI: 0,
  cellJ: 0,
});
export type Frame = ReturnType<typeof makeFrame>;
// Fixed cube-face lattice anchored to the planet (chunks, ground cover and the coarse mesh share it). Pass a scratch frame to avoid allocations in per-frame code.
export function frame(
  direction: THREE.Vector3,
  radius: number,
  cellSize: number,
  scratch: Frame = makeFrame(),
): Frame {
  const ax = Math.abs(direction.x),
    ay = Math.abs(direction.y),
    az = Math.abs(direction.z);
  let f = 0,
    m = ax;
  if (ay > m) {
    f = 1;
    m = ay;
  }
  if (az > m) f = 2;
  scratch.face = f;
  scratch.normal
    .set(0, 0, 0)
    .setComponent(
      f,
      Math.sign(f === 0 ? direction.x : f === 1 ? direction.y : direction.z),
    );
  if (f === 1) scratch.tangentU.set(1, 0, 0);
  else scratch.tangentU.set(0, 1, 0);
  scratch.tangentV.crossVectors(scratch.normal, scratch.tangentU);
  const dn = direction.dot(scratch.normal);
  scratch.cellI = Math.round(
    ((direction.dot(scratch.tangentU) / dn) * radius) / cellSize,
  );
  scratch.cellJ = Math.round(
    ((direction.dot(scratch.tangentV) / dn) * radius) / cellSize,
  );
  return scratch;
}

export function basisFromCode(
  code: number,
  normal: THREE.Vector3,
  tangentU: THREE.Vector3,
  tangentV: THREE.Vector3,
) {
  const f = (code / 2) | 0;
  normal.set(0, 0, 0).setComponent(f, code % 2 === 0 ? 1 : -1);
  if (f === 1) tangentU.set(1, 0, 0);
  else tangentU.set(0, 1, 0);
  tangentV.crossVectors(normal, tangentU);
}
