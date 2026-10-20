import * as THREE from "three";
import type { Planet } from "./planet";
import type { Scatter } from "./vegetation";
import { basisFromCode } from "./util";
const V = THREE.Vector3,
  Y = new V(0, 1, 0),
  X = new V(1, 0, 0),
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
  private last = new V(1e9, 0, 0);
  private seen = -1;
  private fl: unknown = null;
  private off = new V();
  private az = new V();
  private tn = new V();
  private tu = new V();
  private tv = new V();
  private P = new V();
  private t1 = new V();
  private t2 = new V();
  constructor(
    private pl: Planet,
    private sc: Scatter,
  ) {}
  private refresh(dir: THREE.Vector3) {
    const R = this.pl.R;
    this.obs.length = 0;
    this.last.copy(dir);
    this.dirty = false;
    this.seen = this.sc.version;
    this.fl = this.pl.forest.L;
    this.pl.forest.collect(dir, 18, this.obs);
    for (const o of this.pl.lm.obs)
      if (o.d.distanceTo(dir) * R < 22) this.obs.push(o);
    for (const l of this.sc.layers)
      if (l.collide && l.pix && l.psnap) this.fromLayer(l, dir);
  }
  private fromLayer(l: any, dir: THREE.Vector3) {
    const R = this.pl.R,
      K = l.K,
      n = 2 * K + 1,
      cell = l.cell,
      pix = l.pix as Float32Array,
      sn = l.psnap;
    basisFromCode(sn.f, this.tn, this.tu, this.tv);
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const o = (y * n + x) * 4;
        if (pix[o] < -5000) continue;
        const h1 = pix[o + 1],
          h2 = pix[o + 2],
          h3 = pix[o + 3];
        this.P.copy(this.tn)
          .multiplyScalar(R)
          .addScaledVector(this.tu, (sn.i + x - K + h1 - 0.5) * cell)
          .addScaledVector(this.tv, (sn.j + y - K + h2 - 0.5) * cell);
        const d = this.P.clone().normalize();
        if (d.distanceTo(dir) * R > 18) continue;
        this.t1.crossVectors(d, Math.abs(d.y) < 0.99 ? Y : X).normalize();
        this.t2.crossVectors(d, this.t1);
        if (l.kind === 3) {
          // rocks: scale s = .3+1.6·h1, yaw from h3 (identical to the vertex shader)
          const s = 0.3 + h1 * 1.6;
          if (s < 0.45) continue; // pebbles are stepped over
          const a = h3 * 6.283,
            ax = this.t1
              .clone()
              .multiplyScalar(Math.cos(a))
              .addScaledVector(this.t2, Math.sin(a));
          this.obs.push({
            d,
            ax,
            rx: 0.95 * s,
            rz: 0.76 * s,
            H: 0.78 * s,
            mode: s < 1.25 ? 1 : 2,
          });
        } else {
          // shrubs: uniform scale .8+1.1·h2
          const s = 0.8 + h2 * 1.1;
          this.obs.push({
            d,
            ax: this.t1.clone(),
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
      this.seen !== this.sc.version ||
      this.fl !== this.pl.forest.L ||
      dir.distanceTo(this.last) * rad > 4
    )
      this.refresh(dir);
    let boost = 0;
    for (let it = 0; it < 2; it++)
      for (const o of this.obs) {
        this.off.copy(dir).sub(o.d).multiplyScalar(rad);
        this.az.crossVectors(o.ax, o.d);
        const lx = this.off.dot(o.ax),
          lz = this.off.dot(this.az),
          rho = Math.hypot(lx / o.rx, lz / o.rz);
        if (o.mode === 2) {
          if (rho < 1) boost = Math.max(boost, domeAt(o.H, rho));
          continue;
        }
        if (o.mode === 1 && feet >= o.H * 0.9) {
          if (rho < 1) boost = Math.max(boost, domeAt(o.H, rho));
          continue;
        }
        const re = Math.hypot(lx / (o.rx + PR), lz / (o.rz + PR));
        if (re < 1) {
          const f = 1 / Math.max(re, 1e-3);
          dir
            .copy(o.d)
            .addScaledVector(o.ax, (lx * f) / rad)
            .addScaledVector(this.az, (lz * f) / rad)
            .normalize();
        }
      }
    return boost;
  }
}
