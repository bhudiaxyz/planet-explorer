import * as THREE from "three";
import { U } from "./fx";
import { S } from "./settings";
import type { Player } from "./player";
import type { Planet } from "./planet";
const FOOTPRINT_COUNT = 48;

/** Snow footprints: a ring buffer of N prints (uniform array read by the terrain shader) that fade over 90 s. Also publishes the player's foot position (grass bends away). */
export class Footprints {
  private ages = new Array(FOOTPRINT_COUNT).fill(1e9);
  private last = new THREE.Vector3(1e9, 0, 0);
  private next = 0;
  private side = 1;
  private scratchPos = new THREE.Vector3();
  private scratchRight = new THREE.Vector3();
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
    const playerPos = this.scratchPos.copy(pl.dir).multiplyScalar(pl.groundRadius);
    U.uPl.value.copy(playerPos);
    if (pl.verticalVelocity !== 0 || playerPos.distanceTo(this.last) <= 0.9)
      return;
    const elevation = this.planet.elev(pl.dir);
    this.last.copy(playerPos);
    if (
      elevation > 0 &&
      this.planet.temp(pl.dir, elevation) < S.snowline + 0.02
    ) {
      // only in snow, alternating left/right foot every ~0.9 m
      this.side = -this.side;
      const footPos = this.scratchRight
        .crossVectors(pl.forward, pl.dir)
        .multiplyScalar(0.18 * this.side)
        .add(playerPos);
      U.uFoot.value[this.next].set(footPos.x, footPos.y, footPos.z, 1);
      this.ages[this.next] = 0;
      this.next = (this.next + 1) % FOOTPRINT_COUNT;
    }
  }
}
