import * as THREE from "three";
import { Planet } from "./planet";
import { S } from "./settings";
import { rng } from "./noise";
import type { Collider } from "./collision";
const V = THREE.Vector3,
  EYE = 2.4,
  tR = new V(),
  tS = new V(),
  tL = new V(),
  tF = new V(),
  tU = new V(),
  tM = new V(),
  X = new V(1, 0, 0),
  Y = new V(0, 1, 0);
export class Player {
  mode: "walk" | "fly" = "walk";
  dir = new V(0, 1, 0);
  rad = 0;
  vy = 0;
  fwd = new V(1, 0, 0);
  pitch = 0;
  fpos = new V();
  up = new V(0, 1, 0);
  alt = 0;
  keys = new Set<string>();
  col?: Collider;
  boost = 0;
  constructor(
    private cam: THREE.PerspectiveCamera,
    private pl: Planet,
    dom: HTMLElement,
  ) {
    dom.addEventListener("click", () => dom.requestPointerLock());
    addEventListener("keydown", (e) => {
      this.keys.add(e.code);
      if (e.code === "KeyF" && !e.repeat) this.toggle();
      if (e.code === "Space") e.preventDefault();
    });
    addEventListener("keyup", (e) => this.keys.delete(e.code));
    addEventListener("mousemove", (e) => {
      if (document.pointerLockElement === dom)
        this.look(e.movementX, e.movementY);
    });
  }
  private k(c: string) {
    return this.keys.has(c) ? 1 : 0;
  }
  spawn() {
    const r = rng(S.seed + 3),
      d = new V();
    for (let i = 0; i < 2000; i++) {
      d.set(r() * 2 - 1, r() * 2 - 1, r() * 2 - 1);
      if (d.lengthSq() > 1 || d.lengthSq() < 0.01) continue;
      d.normalize();
      const e = this.pl.elev(d);
      if (e > 0.04 && e < 0.25 && this.pl.temp(d, e) > 0.45) break;
    }
    this.mode = "walk";
    this.boost = 0;
    this.dir.copy(d);
    this.rad = this.pl.radiusAt(d);
    this.vy = 0;
    this.pitch = 0;
    this.fwd.crossVectors(d, Y);
  }
  refresh() {
    if (this.mode === "walk")
      this.rad = Math.max(this.rad, this.pl.radiusAt(this.dir));
  }
  toggle() {
    if (this.mode === "walk") {
      this.fpos.copy(this.cam.position);
      this.mode = "fly";
      return;
    }
    this.dir.copy(this.cam.position).normalize();
    this.fwd.copy(this.cam.getWorldDirection(tF));
    this.pitch = 0;
    this.vy = 0;
    this.rad = Math.min(
      this.cam.position.length() - EYE,
      this.pl.radiusAt(this.dir) + 25,
    );
    this.mode = "walk";
  }
  private look(dx: number, dy: number) {
    const s = 0.0022;
    if (this.mode === "walk") {
      this.fwd.applyAxisAngle(this.dir, -dx * s);
      this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch - dy * s));
    } else {
      this.cam.rotateY(-dx * s);
      this.cam.rotateX(-dy * s);
    }
  }
  // scratch vectors only: no per-frame allocations
  update(dt: number) {
    const c = this.cam,
      sprint = this.k("ShiftLeft") || this.k("ShiftRight"),
      mv = this.k("KeyW") - this.k("KeyS"),
      st = this.k("KeyD") - this.k("KeyA");
    if (this.mode === "walk") {
      const up = this.up.copy(this.dir),
        W = this.pl.R;
      this.fwd.addScaledVector(up, -this.fwd.dot(up));
      if (this.fwd.lengthSq() < 1e-6) this.fwd.crossVectors(up, X);
      this.fwd.normalize();
      const right = tR.crossVectors(this.fwd, up),
        swim0 = this.pl.radiusAt(this.dir) < W - 0.5;
      if (mv || st) {
        tS.set(0, 0, 0)
          .addScaledVector(this.fwd, mv)
          .addScaledVector(right, st)
          .normalize()
          .multiplyScalar(
            ((sprint ? 20 : 9) * (swim0 ? 0.5 : 1) * dt) / this.rad,
          );
        this.dir.add(tS).normalize();
      }
      let g = this.pl.radiusAt(this.dir),
        bt = 0;
      if (this.col && g > W - 0.5) {
        bt = this.col.resolve(this.dir, this.rad - g, this.rad);
        g = this.pl.radiusAt(this.dir);
      }
      this.boost =
        bt > this.boost
          ? this.boost + (bt - this.boost) * Math.min(1, dt * 14)
          : bt;
      up.copy(this.dir);
      const floor = g < W - 0.5 ? W - 1.2 : g + this.boost;
      this.vy -= 28 * dt;
      if (this.rad <= floor + 0.05 && this.k("Space")) this.vy = 10;
      this.rad += this.vy * dt;
      if (this.rad <= floor) {
        this.rad = floor;
        this.vy = 0;
      }
      c.position.copy(this.dir).multiplyScalar(this.rad + EYE);
      c.up.copy(up);
      tL.copy(this.fwd)
        .multiplyScalar(Math.cos(this.pitch))
        .addScaledVector(up, Math.sin(this.pitch))
        .add(c.position);
      c.lookAt(tL);
      this.alt = this.rad + EYE - g;
    } else {
      c.updateMatrixWorld();
      const p = this.fpos,
        f = c.getWorldDirection(tF),
        r = tR.setFromMatrixColumn(c.matrixWorld, 0),
        u = tU.copy(p).normalize();
      const alt = p.length() - this.pl.radiusAt(u),
        sp = Math.max(20, alt * 1.5) * (sprint ? 4 : 1);
      tM.set(0, 0, 0)
        .addScaledVector(f, mv)
        .addScaledVector(r, st)
        .addScaledVector(u, this.k("Space") - this.k("KeyC"));
      if (tM.lengthSq()) p.addScaledVector(tM.normalize(), sp * dt);
      c.rotateZ((this.k("KeyE") - this.k("KeyQ")) * dt * 1.2);
      u.copy(p).normalize();
      const min = this.pl.radiusAt(u) + 3;
      if (p.length() < min) p.setLength(min);
      c.position.copy(p);
      this.up.copy(u);
      this.alt = p.length() - this.pl.radiusAt(u);
    }
  }
}
