import * as THREE from "three";
import { Planet } from "./planet";
import { S } from "./config";
import { rng } from "./noise";
import type { Collider } from "./collision";
import { isTouchDevice } from "./touch";
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
  mode: "walk" | "fly" | "drone" = "walk";
  dir = new THREE.Vector3(0, 1, 0);
  groundRadius = 0;
  verticalVelocity = 0;
  forward = new THREE.Vector3(1, 0, 0);
  pitch = 0;
  flyPosition = new THREE.Vector3();
  dronePosition = new THREE.Vector3();
  droneHoverHeight = 15;
  landing = false;
  up = new THREE.Vector3(0, 1, 0);
  alt = 0;
  keys = new Set<string>();
  col?: Collider;
  boost = 0;
  // touch virtual input — set by touch.ts
  touchMove = 0;
  touchStrafe = 0;
  touchJump = false;
  touchSprint = false;
  touchDescend = false;
  touchRollLeft = false;
  touchRollRight = false;
  constructor(
    private cam: THREE.PerspectiveCamera,
    private planet: Planet,
    dom: HTMLElement,
  ) {
    if (!isTouchDevice) {
      dom.addEventListener("click", () => dom.requestPointerLock());
      addEventListener("mousemove", (e) => {
        if (document.pointerLockElement === dom)
          this.look(e.movementX, e.movementY);
      });
    }
    addEventListener("keydown", (e) => {
      this.keys.add(e.code);
      if (e.code === "KeyF" && !e.repeat) this.toggle();
      if (e.code === "KeyL" && !e.repeat && this.mode !== "walk") this.land();
      if (e.code === "Space") e.preventDefault();
    });
    addEventListener("keyup", (e) => this.keys.delete(e.code));
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
    if (this.forward.lengthSq() < 1e-6) this.forward.crossVectors(candidateDir, AXIS_X);
    this.forward.normalize();
  }
  warpTo(dir: THREE.Vector3) {
    this.mode = "walk";
    this.boost = 0;
    this.dir.copy(dir);
    this.groundRadius = this.planet.radiusAt(dir);
    this.verticalVelocity = 0;
    this.pitch = 0;
    this.forward.crossVectors(dir, AXIS_Y);
    if (this.forward.lengthSq() < 1e-6) this.forward.crossVectors(dir, AXIS_X);
    this.forward.normalize();
    this.planet.forest.last.set(1e9, 0, 0);
    if (this.col) this.col.dirty = true;
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
      // walk → drone: lift off at current position
      this.dronePosition.copy(this.dir).multiplyScalar(this.groundRadius + EYE_HEIGHT);
      this.droneHoverHeight = 15;
      this.mode = "drone";
      return;
    }
    if (this.mode === "drone") {
      // drone → fly: hand position to fly mode
      this.flyPosition.copy(this.dronePosition);
      this.mode = "fly";
      return;
    }
    // fly → walk: drop from current altitude, gravity handles the descent
    this.dir.copy(this.cam.position).normalize();
    this.forward.copy(this.cam.getWorldDirection(scratchForward));
    this.forward.addScaledVector(this.dir, -this.forward.dot(this.dir));
    if (this.forward.lengthSq() < 1e-6) this.forward.crossVectors(this.dir, AXIS_X);
    if (this.forward.lengthSq() < 1e-6) this.forward.crossVectors(this.dir, AXIS_Y);
    this.forward.normalize();
    this.pitch = 0;
    this.verticalVelocity = -30;
    this.groundRadius = this.cam.position.length() - EYE_HEIGHT;
    this.mode = "walk";
    this.planet.forest.last.set(1e9, 0, 0);
  }
  land() {
    if (this.mode === "fly") {
      // transition into drone so terrain-following takes over for the descent
      this.dronePosition.copy(this.flyPosition);
      const up = this.dronePosition.clone().normalize();
      this.droneHoverHeight = this.dronePosition.length() - this.planet.radiusAt(up);
      this.forward.copy(this.cam.getWorldDirection(scratchForward));
      this.forward.addScaledVector(up, -this.forward.dot(up));
      if (this.forward.lengthSq() < 1e-6) this.forward.crossVectors(up, AXIS_X);
      if (this.forward.lengthSq() < 1e-6) this.forward.crossVectors(up, AXIS_Y);
      this.forward.normalize();
      this.pitch = 0;
      this.mode = "drone";
    }
    this.landing = true;
  }
  private snapToGround() {
    this.dir.copy(this.dronePosition).normalize();
    this.forward.copy(this.cam.getWorldDirection(scratchForward));
    this.forward.addScaledVector(this.dir, -this.forward.dot(this.dir));
    if (this.forward.lengthSq() < 1e-6) this.forward.crossVectors(this.dir, AXIS_X);
    if (this.forward.lengthSq() < 1e-6) this.forward.crossVectors(this.dir, AXIS_Y);
    this.forward.normalize();
    this.pitch = 0;
    this.verticalVelocity = 0;
    this.groundRadius = this.planet.radiusAt(this.dir);
    this.landing = false;
    this.mode = "walk";
    this.planet.forest.last.set(1e9, 0, 0);
    if (this.col) this.col.dirty = true;
  }
  look(dx: number, dy: number) {
    const mouseSensitivity = 0.0022;
    if (this.mode === "walk" || this.mode === "drone") {
      this.forward.applyAxisAngle(this.up, -dx * mouseSensitivity);
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
        this.touchSprint || this.isKeyDown("ShiftLeft") || this.isKeyDown("ShiftRight"),
      moveAxis   = this.touchMove   + this.isKeyDown("KeyW") - this.isKeyDown("KeyS"),
      strafeAxis = this.touchStrafe + this.isKeyDown("KeyD") - this.isKeyDown("KeyA");
    if (this.mode === "walk") {
      if (this.groundRadius < 1) return;
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
        (this.touchJump || this.isKeyDown("Space"))
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
    } else if (this.mode === "drone") {
      const dronePos = this.dronePosition;
      const droneUp = this.up.copy(dronePos).normalize();

      // project forward onto tangent plane; guard against alignment with up (poles)
      this.forward.addScaledVector(droneUp, -this.forward.dot(droneUp));
      if (this.forward.lengthSq() < 1e-6) this.forward.crossVectors(droneUp, AXIS_X);
      if (this.forward.lengthSq() < 1e-6) this.forward.crossVectors(droneUp, AXIS_Y);
      this.forward.normalize();

      const speed = sprint ? 40 : 15;

      // A/D steers (yaws forward around up); always advance forward
      this.forward.applyAxisAngle(droneUp, -strafeAxis * dt * 1.4).normalize();
      dronePos.addScaledVector(this.forward, speed * dt);

      // Space/C adjusts target hover height (suppressed while landing)
      if (this.landing) {
        const ascend = (this.touchJump ? 1 : 0) + this.isKeyDown("Space");
        if (ascend) { this.landing = false; } // abort landing if player pulls up
        else { this.droneHoverHeight = Math.max(0, this.droneHoverHeight - 8 * dt); }
      } else {
        const vInput = (this.touchJump ? 1 : 0) - (this.touchDescend ? 1 : 0)
          + this.isKeyDown("Space") - this.isKeyDown("KeyC");
        this.droneHoverHeight = Math.max(3, this.droneHoverHeight + vInput * speed * dt);
      }

      // re-derive up after horizontal move (direction may have shifted)
      droneUp.copy(dronePos).normalize();
      const terrainR = this.planet.radiusAt(droneUp);
      const targetR  = terrainR + this.droneHoverHeight;
      const currentR = dronePos.length();
      // smooth terrain-following; faster correction when below target
      const t = currentR < targetR ? Math.min(1, dt * 6) : Math.min(1, dt * 3);
      dronePos.setLength(currentR + (targetR - currentR) * t);
      if (!this.landing && dronePos.length() < terrainR + 3) dronePos.setLength(terrainR + 3);
      if (this.landing && dronePos.length() <= terrainR + EYE_HEIGHT + 0.3) {
        this.snapToGround();
        return;
      }

      camera.position.copy(dronePos);
      camera.up.copy(droneUp);
      scratchLookAt
        .copy(this.forward)
        .multiplyScalar(Math.cos(this.pitch))
        .addScaledVector(droneUp, Math.sin(this.pitch))
        .add(dronePos);
      camera.lookAt(scratchLookAt);
      this.alt = dronePos.length() - terrainR;
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
          (this.touchJump ? 1 : 0) - (this.touchDescend ? 1 : 0) + this.isKeyDown("Space") - this.isKeyDown("KeyC"),
        );
      if (scratchMove.lengthSq())
        flyPos.addScaledVector(scratchMove.normalize(), flySpeed * dt);
      camera.rotateZ(
        (this.isKeyDown("KeyE") + (this.touchRollRight ? 1 : 0) - this.isKeyDown("KeyQ") - (this.touchRollLeft ? 1 : 0)) * dt * 1.2,
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
