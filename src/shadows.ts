import * as THREE from "three";
import { CFG } from "./config";
const X = new THREE.Vector3(1, 0, 0),
  Y = new THREE.Vector3(0, 1, 0);

/**
 * Sun + moon shadow rig. One ortho shadow frustum per light follows the camera, snapped to shadow-texel steps (no crawling) and refreshed at CFG.shadow.hz instead of every frame.
 * `castShadow` stays true for the whole session (toggling it recompiles every material); shadow *intensity* fades in/out instead.
 */
export class Shadows {
  private on = false;
  private timer = 0;
  private hz: number = CFG.shadow.hz;
  private half: number = CFG.shadow.half;
  private strength = 0;
  private moonOn = false;
  private moonStrength = 0;
  private tgt = new THREE.Vector3();
  private right = new THREE.Vector3();
  private up = new THREE.Vector3();
  private moonDir = new THREE.Vector3();
  constructor(
    private renderer: THREE.WebGLRenderer,
    private light: THREE.DirectionalLight,
    private mobileScale = false,
    private moon?: THREE.DirectionalLight,
  ) {
    const { size: rawSize } = CFG.shadow;
    this.half = this.mobileScale ? CFG.shadow.half * 0.65 : CFG.shadow.half;
    const half = this.half;
    const size = this.mobileScale ? rawSize >> 1 : rawSize;
    this.hz = this.mobileScale ? 20 : CFG.shadow.hz;
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
    if (moon) {
      const moonSize = this.mobileScale ? rawSize >> 2 : rawSize >> 1;
      moon.castShadow = true;
      moon.shadow.mapSize.set(moonSize, moonSize);
      Object.assign(moon.shadow.camera, {
        left: -half,
        right: half,
        top: half,
        bottom: -half,
        near: 1,
        far: 700,
      });
      moon.shadow.bias = -0.0004;
      moon.shadow.normalBias = 0.4;
    }
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
    const half = this.half, { size } = CFG.shadow, hz = this.hz,
      tex = (2 * half) / size; // metres per shadow texel
    if (active) {
      this.right.crossVectors(sun, Math.abs(sun.y) < 0.9 ? Y : X).normalize();
      this.up.crossVectors(this.right, sun);
      this.tgt
        .copy(cam)
        .addScaledVector(this.right, -(cam.dot(this.right) % tex))
        .addScaledVector(this.up, -(cam.dot(this.up) % tex));
      this.light.target.position.copy(this.tgt);
      this.light.position.copy(this.tgt).addScaledVector(sun, 300);
    }
    if (this.moon) {
      if (alt < 150) this.moonOn = true;
      else if (alt > 190) this.moonOn = false;
      const moonActive = this.moonOn && dayF < 0.95;
      const moonF = (1 - dayF) * (moonActive ? 1 : 0);
      this.moonStrength += (moonF - this.moonStrength) * Math.min(1, dt * 3);
      this.moon.shadow.intensity = this.moonStrength;
      if (moonActive && this.moonStrength > 0.01) {
        this.moonDir.copy(sun).negate();
        this.right.crossVectors(this.moonDir, Math.abs(this.moonDir.y) < 0.9 ? Y : X).normalize();
        this.up.crossVectors(this.right, this.moonDir);
        this.tgt
          .copy(cam)
          .addScaledVector(this.right, -(cam.dot(this.right) % tex))
          .addScaledVector(this.up, -(cam.dot(this.up) % tex));
        this.moon.target.position.copy(this.tgt);
        this.moon.position.copy(this.tgt).addScaledVector(this.moonDir, 300);
      }
    }
    if ((this.timer += dt) > 1 / hz) {
      this.timer = 0;
      if (this.moon) this.moon.castShadow = this.moonStrength > 0.01;
      this.renderer.shadowMap.needsUpdate = true;
    }
  }
}
