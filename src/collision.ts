import * as THREE from "three";
import type { Planet } from "./planet";
import type { Scatter } from "./vegetation";
import { basisFromCode } from "./utilgeo";
const Y = new THREE.Vector3(0, 1, 0),
  X = new THREE.Vector3(1, 0, 0),
  PR = 0.4; // PR = player radius (m)
// One obstacle = an elliptical footprint (semi-axes rx along ax, rz along ax×d) at unit direction d.
// mode 0: solid pillar (trees, monoliths, tombstones, spire) · mode 1: solid unless the player's feet are above ~its top (small rocks, shrubs: jump onto/over them)
// mode 2: walkable dome (large rocks: walk straight over them). H = height above ground (m).
export type Obs = {
  d: THREE.Vector3;
  ax: THREE.Vector3;
  rx: number;
  rz: number;
  H: number;
  mode: 0 | 1 | 2;
};
export const domeAt = (H: number, rho: number) =>
  (H * (0.3 + Math.sqrt(Math.max(0, 1 - rho * rho)))) / 1.3; // profile of the half-buried ball used for rocks
// Collision with everything the player can see. Trees come from the CPU tree table, landmarks from their builder, and shrubs/rocks from a tiny GPU read-back of the
// near-tier placement texture (so the CPU never re-derives GPU hashes: it reads exactly the plants the shader draws).
export class Collider {
  obs: Obs[] = [];
  dirty = true;
  private last = new THREE.Vector3(1e9, 0, 0);
  private seen = -1;
  private forestSpeciesLists: unknown = null;
  private offset = new THREE.Vector3();
  private azimuthAxis = new THREE.Vector3();
  private basisNormal = new THREE.Vector3();
  private basisTangentU = new THREE.Vector3();
  private basisTangentV = new THREE.Vector3();
  private obstaclePos = new THREE.Vector3();
  private tangent1 = new THREE.Vector3();
  private tangent2 = new THREE.Vector3();
  private scratchD = new THREE.Vector3();
  private scratchAx = new THREE.Vector3();
  constructor(
    private planet: Planet,
    private scatter: Scatter,
  ) {}
  private refresh(dir: THREE.Vector3) {
    const planetRadius = this.planet.radius;
    this.obs.length = 0;
    this.last.copy(dir);
    this.dirty = false;
    this.seen = this.scatter.version;
    this.forestSpeciesLists = this.planet.forest.speciesLists;
    this.planet.forest.collect(dir, 18, this.obs);
    for (const o of this.planet.landmarks.obs)
      if (o.d.distanceTo(dir) * planetRadius < 22) this.obs.push(o);
    for (const layer of this.scatter.layers)
      if (layer.collide && layer.pix && layer.psnap)
        this.fromLayer(layer, dir);
  }
  private fromLayer(layer: any, dir: THREE.Vector3) {
    const planetRadius = this.planet.radius,
      K = layer.K,
      gridWidth = 2 * K + 1,
      cell = layer.cell,
      pix = layer.pix as Float32Array,
      bakeSnapshot = layer.psnap;
    basisFromCode(
      bakeSnapshot.faceCode,
      this.basisNormal,
      this.basisTangentU,
      this.basisTangentV,
    );
    for (let y = 0; y < gridWidth; y++)
      for (let x = 0; x < gridWidth; x++) {
        const pixelOffset = (y * gridWidth + x) * 4;
        if (pix[pixelOffset] < -5000) continue;
        const h1 = pix[pixelOffset + 1],
          h2 = pix[pixelOffset + 2],
          h3 = pix[pixelOffset + 3];
        this.obstaclePos
          .copy(this.basisNormal)
          .multiplyScalar(planetRadius)
          .addScaledVector(
            this.basisTangentU,
            (bakeSnapshot.cellI + x - K + h1 - 0.5) * cell,
          )
          .addScaledVector(
            this.basisTangentV,
            (bakeSnapshot.cellJ + y - K + h2 - 0.5) * cell,
          );
        this.scratchD.copy(this.obstaclePos).normalize();
        if (this.scratchD.distanceToSquared(dir) * planetRadius * planetRadius > 324) continue;
        this.tangent1
          .crossVectors(this.scratchD, Math.abs(this.scratchD.y) < 0.99 ? Y : X)
          .normalize();
        this.tangent2.crossVectors(this.scratchD, this.tangent1);
        if (layer.kind === 3) {
          // rocks: scale s = .3+1.6·h1, yaw from h3 (identical to the vertex shader)
          const s = 0.3 + h1 * 1.6;
          if (s < 0.45) continue; // pebbles are stepped over
          const a = h3 * 6.283;
          this.scratchAx
            .copy(this.tangent1)
            .multiplyScalar(Math.cos(a))
            .addScaledVector(this.tangent2, Math.sin(a));
          this.obs.push({
            d: this.scratchD.clone(),
            ax: this.scratchAx.clone(),
            rx: 0.95 * s,
            rz: 0.76 * s,
            H: 0.78 * s,
            mode: s < 1.25 ? 1 : 2,
          });
        } else {
          // shrubs: uniform scale .8+1.1·h2
          const s = 0.8 + h2 * 1.1;
          this.obs.push({
            d: this.scratchD.clone(),
            ax: this.tangent1.clone(),
            rx: 0.8 * s,
            rz: 0.8 * s,
            H: 0.9 * s,
            mode: 1,
          });
        }
      }
  }
  // Pushes `dir` (the player's unit direction) out of solid obstacles, returns the ground boost (m) from walkable tops. feet = height above terrain.
  resolve(dir: THREE.Vector3, feet: number, rad: number): number {
    if (
      this.dirty ||
      this.seen !== this.scatter.version ||
      this.forestSpeciesLists !== this.planet.forest.speciesLists ||
      dir.distanceTo(this.last) * rad > 4
    )
      this.refresh(dir);
    let boost = 0;
    for (let iteration = 0; iteration < 2; iteration++)
      for (const o of this.obs) {
        this.offset.copy(dir).sub(o.d).multiplyScalar(rad);
        this.azimuthAxis.crossVectors(o.ax, o.d);
        const lx = this.offset.dot(o.ax),
          lz = this.offset.dot(this.azimuthAxis),
          rho = Math.hypot(lx / o.rx, lz / o.rz);
        if (o.mode === 2) {
          if (rho < 1) boost = Math.max(boost, domeAt(o.H, rho));
          continue;
        }
        if (o.mode === 1 && feet >= o.H * 0.9) {
          if (rho < 1) boost = Math.max(boost, domeAt(o.H, rho));
          continue;
        }
        const radialExtent = Math.hypot(lx / (o.rx + PR), lz / (o.rz + PR));
        if (radialExtent < 1) {
          const pushFactor = 1 / Math.max(radialExtent, 1e-3);
          dir
            .copy(o.d)
            .addScaledVector(o.ax, (lx * pushFactor) / rad)
            .addScaledVector(this.azimuthAxis, (lz * pushFactor) / rad)
            .normalize();
        }
      }
    return boost;
  }
}
