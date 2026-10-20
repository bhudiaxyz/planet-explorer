import * as THREE from "three";
import { CFG } from "./config";
const V = THREE.Vector3,
  X = new V(1, 0, 0),
  Y = new V(0, 1, 0);

/**
 * Sun shadow rig. One ortho shadow frustum follows the camera, snapped to shadow-texel steps (no crawling) and refreshed at CFG.shadow.hz instead of every frame.
 * `castShadow` stays true for the whole session (toggling it recompiles every material); shadow *intensity* fades in/out instead.
 */
export class Shadows {
  private on = false;
  private timer = 0;
  private strength = 0;
  private tgt = new V();
  private right = new V();
  private up = new V();
  constructor(
    private renderer: THREE.WebGLRenderer,
    private light: THREE.DirectionalLight,
  ) {
    const { size, half } = CFG.shadow;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = true;
    light.castShadow = true;
    light.shadow.mapSize.set(size, size);
    Object.assign(light.shadow.camera, {
      left: -half,
      right: half,
      top: half,
      bottom: -half,
      near: 1,
      far: 700,
    });
    light.shadow.bias = -0.0004;
    light.shadow.normalBias = 0.4;
  }
  update(
    dt: number,
    alt: number,
    dayF: number,
    sun: THREE.Vector3,
    cam: THREE.Vector3,
  ) {
    if (alt < 150) this.on = true;
    else if (alt > 190) this.on = false; // hysteresis
    const active = this.on && dayF > 0.05;
    this.strength += ((active ? 1 : 0) - this.strength) * Math.min(1, dt * 3);
    this.light.shadow.intensity = this.strength;
    if (!active) return;
    const { half, size, hz } = CFG.shadow,
      tex = (2 * half) / size; // metres per shadow texel
    this.right.crossVectors(sun, Math.abs(sun.y) < 0.9 ? Y : X).normalize();
    this.up.crossVectors(this.right, sun);
    this.tgt
      .copy(cam)
      .addScaledVector(this.right, -(cam.dot(this.right) % tex))
      .addScaledVector(this.up, -(cam.dot(this.up) % tex));
    this.light.target.position.copy(this.tgt);
    this.light.position.copy(this.tgt).addScaledVector(sun, 300);
    if ((this.timer += dt) > 1 / hz) {
      this.timer = 0;
      this.renderer.shadowMap.needsUpdate = true;
    }
  }
}
