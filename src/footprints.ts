import * as THREE from "three";
import { U } from "./fx";
import { S } from "./settings";
import type { Player } from "./player";
import type { Planet } from "./planet";
const V = THREE.Vector3,
  N = 48;

/** Snow footprints: a ring buffer of N prints (uniform array read by the terrain shader) that fade over 90 s. Also publishes the player's foot position (grass bends away). */
export class Footprints {
  private ages = new Array(N).fill(1e9);
  private last = new V(1e9, 0, 0);
  private next = 0;
  private side = 1;
  private p = new V();
  private r = new V();
  constructor(
    private player: Player,
    private planet: Planet,
  ) {}
  update(dt: number) {
    U.uFoot.value.forEach((f, i) => {
      this.ages[i] += dt;
      f.w = Math.max(0, 1 - this.ages[i] / 90);
    });
    const pl = this.player;
    if (pl.mode !== "walk") {
      U.uPl.value.set(1e6, 0, 0);
      return;
    }
    const p = this.p.copy(pl.dir).multiplyScalar(pl.rad);
    U.uPl.value.copy(p);
    if (pl.vy !== 0 || p.distanceTo(this.last) <= 0.9) return;
    const e = this.planet.elev(pl.dir);
    this.last.copy(p);
    if (e > 0 && this.planet.temp(pl.dir, e) < S.snowline + 0.02) {
      // only in snow, alternating left/right foot every ~0.9 m
      this.side = -this.side;
      const q = this.r
        .crossVectors(pl.fwd, pl.dir)
        .multiplyScalar(0.18 * this.side)
        .add(p);
      U.uFoot.value[this.next].set(q.x, q.y, q.z, 1);
      this.ages[this.next] = 0;
      this.next = (this.next + 1) % N;
    }
  }
}
