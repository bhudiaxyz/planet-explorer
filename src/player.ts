import * as THREE from "three";
import { Planet } from "./planet";
import { S } from "./settings";
import { rng } from "./noise";
import type { Collider } from "./collision";
const EYE_HEIGHT = 2.4,
  scratchRight = new THREE.Vector3(),
  scratchStep = new THREE.Vector3(),
  scratchLookAt = new THREE.Vector3(),
  scratchForward = new THREE.Vector3(),
  scratchUp = new THREE.Vector3(),
  scratchMove = new THREE.Vector3(),
  AXIS_X = new THREE.Vector3(1, 0, 0),
  AXIS_Y = new THREE.Vector3(0, 1, 0);
export class Player {
  mode: "walk" | "fly" = "walk";
  dir = new THREE.Vector3(0, 1, 0);
  groundRadius = 0;
  verticalVelocity = 0;
  forward = new THREE.Vector3(1, 0, 0);
  pitch = 0;
  flyPosition = new THREE.Vector3();
  up = new THREE.Vector3(0, 1, 0);
  alt = 0;
  keys = new Set<string>();
  col?: Collider;
  boost = 0;
  constructor(
    private cam: THREE.PerspectiveCamera,
    private planet: Planet,
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
  private isKeyDown(code: string) {
    return this.keys.has(code) ? 1 : 0;
  }
  spawn() {
    const rand = rng(S.seed + 3),
      candidateDir = new THREE.Vector3();
    for (let i = 0; i < 2000; i++) {
      candidateDir.set(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1);
      if (
        candidateDir.lengthSq() > 1 ||
        candidateDir.lengthSq() < 0.01
      )
        continue;
      candidateDir.normalize();
      const e = this.planet.elev(candidateDir);
      if (e > 0.04 && e < 0.25 && this.planet.temp(candidateDir, e) > 0.45)
        break;
    }
    this.mode = "walk";
    this.boost = 0;
    this.dir.copy(candidateDir);
    this.groundRadius = this.planet.radiusAt(candidateDir);
    this.verticalVelocity = 0;
    this.pitch = 0;
    this.forward.crossVectors(candidateDir, AXIS_Y);
  }
  refresh() {
    if (this.mode === "walk")
      this.groundRadius = Math.max(
        this.groundRadius,
        this.planet.radiusAt(this.dir),
      );
  }
  toggle() {
    if (this.mode === "walk") {
      this.flyPosition.copy(this.cam.position);
      this.mode = "fly";
      return;
    }
    this.dir.copy(this.cam.position).normalize();
    this.forward.copy(this.cam.getWorldDirection(scratchForward));
    this.pitch = 0;
    this.verticalVelocity = 0;
    this.groundRadius = Math.min(
      this.cam.position.length() - EYE_HEIGHT,
      this.planet.radiusAt(this.dir) + 25,
    );
    this.mode = "walk";
    this.planet.forest.last.set(1e9, 0, 0); // force tree LOD rebuild at landing position
  }
  private look(dx: number, dy: number) {
    const mouseSensitivity = 0.0022;
    if (this.mode === "walk") {
      this.forward.applyAxisAngle(this.dir, -dx * mouseSensitivity);
      this.pitch = Math.max(
        -1.5,
        Math.min(1.5, this.pitch - dy * mouseSensitivity),
      );
    } else {
      this.cam.rotateY(-dx * mouseSensitivity);
      this.cam.rotateX(-dy * mouseSensitivity);
    }
  }
  // scratch vectors only: no per-frame allocations
  update(dt: number) {
    const camera = this.cam,
      sprint =
        this.isKeyDown("ShiftLeft") || this.isKeyDown("ShiftRight"),
      moveAxis = this.isKeyDown("KeyW") - this.isKeyDown("KeyS"),
      strafeAxis = this.isKeyDown("KeyD") - this.isKeyDown("KeyA");
    if (this.mode === "walk") {
      const up = this.up.copy(this.dir),
        planetRadius = this.planet.radius;
      this.forward.addScaledVector(up, -this.forward.dot(up));
      if (this.forward.lengthSq() < 1e-6)
        this.forward.crossVectors(up, AXIS_X);
      this.forward.normalize();
      const right = scratchRight.crossVectors(this.forward, up),
        isUnderwater = this.planet.radiusAt(this.dir) < planetRadius - 0.5;
      if (moveAxis || strafeAxis) {
        scratchStep
          .set(0, 0, 0)
          .addScaledVector(this.forward, moveAxis)
          .addScaledVector(right, strafeAxis)
          .normalize()
          .multiplyScalar(
            ((sprint ? 20 : 9) *
              (isUnderwater ? 0.5 : 1) *
              dt) /
              this.groundRadius,
          );
        this.dir.add(scratchStep).normalize();
      }
      let groundRadius = this.planet.radiusAt(this.dir),
        boostTarget = 0;
      if (this.col && groundRadius > planetRadius - 0.5) {
        boostTarget = this.col.resolve(
          this.dir,
          this.groundRadius - groundRadius,
          this.groundRadius,
        );
        groundRadius = this.planet.radiusAt(this.dir);
      }
      this.boost =
        boostTarget > this.boost
          ? this.boost + (boostTarget - this.boost) * Math.min(1, dt * 14)
          : boostTarget;
      up.copy(this.dir);
      const floorRadius =
        groundRadius < planetRadius - 0.5
          ? planetRadius - 1.2
          : groundRadius + this.boost;
      this.verticalVelocity -= 28 * dt;
      if (
        this.groundRadius <= floorRadius + 0.05 &&
        this.isKeyDown("Space")
      )
        this.verticalVelocity = 10;
      this.groundRadius += this.verticalVelocity * dt;
      if (this.groundRadius <= floorRadius) {
        this.groundRadius = floorRadius;
        this.verticalVelocity = 0;
      }
      camera.position
        .copy(this.dir)
        .multiplyScalar(this.groundRadius + EYE_HEIGHT);
      camera.up.copy(up);
      scratchLookAt
        .copy(this.forward)
        .multiplyScalar(Math.cos(this.pitch))
        .addScaledVector(up, Math.sin(this.pitch))
        .add(camera.position);
      camera.lookAt(scratchLookAt);
      this.alt = this.groundRadius + EYE_HEIGHT - groundRadius;
    } else {
      camera.updateMatrixWorld();
      const flyPos = this.flyPosition,
        flyForward = camera.getWorldDirection(scratchForward),
        flyRight = scratchRight.setFromMatrixColumn(camera.matrixWorld, 0),
        flyUp = scratchUp.copy(flyPos).normalize();
      const flyAltitude = flyPos.length() - this.planet.radiusAt(flyUp),
        flySpeed =
          Math.max(20, flyAltitude * 1.5) * (sprint ? 4 : 1);
      scratchMove
        .set(0, 0, 0)
        .addScaledVector(flyForward, moveAxis)
        .addScaledVector(flyRight, strafeAxis)
        .addScaledVector(
          flyUp,
          this.isKeyDown("Space") - this.isKeyDown("KeyC"),
        );
      if (scratchMove.lengthSq())
        flyPos.addScaledVector(scratchMove.normalize(), flySpeed * dt);
      camera.rotateZ(
        (this.isKeyDown("KeyE") - this.isKeyDown("KeyQ")) * dt * 1.2,
      );
      flyUp.copy(flyPos).normalize();
      const minRadius = this.planet.radiusAt(flyUp) + 3;
      if (flyPos.length() < minRadius) flyPos.setLength(minRadius);
      camera.position.copy(flyPos);
      this.up.copy(flyUp);
      this.alt = flyPos.length() - this.planet.radiusAt(flyUp);
    }
  }
}
