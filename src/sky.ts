import * as THREE from "three";
import { Planet, sm } from "./planet";
import { S } from "./settings";
import { Precip } from "./precip";
const V = THREE.Vector3,
  P = 3500;
export class Sky {
  sun = new V(1, 0, 0);
  dayF = 1;
  space = 0;
  cloud = 0;
  fogW = 0;
  pAmt = 0;
  kind = "clear";
  timer = 0;
  snow = false;
  light = new THREE.DirectionalLight(0xffffff, 3);
  moon = new THREE.DirectionalLight(0x6f86c8, 0.12);
  amb = new THREE.AmbientLight(0x9ab0e0, 0.3);
  bg = new THREE.Color();
  c = new THREE.Color();
  disc: THREE.Mesh;
  moonDisc: THREE.Mesh;
  stars: THREE.Points;
  precip: THREE.Points;
  fx: Precip;
  lp = new Float32Array(P * 3);
  pp = new Float32Array(P * 3);
  constructor(
    private scene: THREE.Scene,
    private pl: Planet,
  ) {
    scene.add(this.light, this.moon, this.amb);
    scene.fog = new THREE.FogExp2(0, 0.001);
    scene.background = this.bg;
    this.disc = new THREE.Mesh(
      new THREE.SphereGeometry(450, 16, 12),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color().setRGB(8, 7, 5.5),
        fog: false,
      }),
    );
    const sp = new Float32Array(7500);
    for (let i = 0; i < 2500; i++)
      new V()
        .randomDirection()
        .multiplyScalar(18000)
        .toArray(sp, i * 3);
    this.stars = new THREE.Points(
      new THREE.BufferGeometry().setAttribute(
        "position",
        new THREE.BufferAttribute(sp, 3),
      ),
      new THREE.PointsMaterial({
        size: 1.6,
        sizeAttenuation: false,
        transparent: true,
        depthWrite: false,
        fog: false,
      }),
    );
    this.fx = new Precip();
    this.precip = this.fx.pts;
    this.moonDisc = new THREE.Mesh(
      new THREE.SphereGeometry(300, 16, 12),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color().setRGB(1.6, 1.7, 2),
        fog: false,
      }),
    );
    for (const o of [this.stars, this.precip, this.disc, this.moonDisc])
      o.frustumCulled = false;
    scene.add(this.disc, this.moonDisc, this.stars, this.precip);
  }
  update(
    dt: number,
    cam: THREE.Camera,
    up: THREE.Vector3,
    alt: number,
    temp: number,
  ) {
    if (!Number.isFinite(alt) || !Number.isFinite(temp)) return;
    const R = this.pl.R,
      a = S.timeOfDay * Math.PI * 2,
      tilt = 0.41;
    S.timeOfDay = (S.timeOfDay + dt / S.dayLength) % 1;
    this.sun.set(
      Math.cos(a),
      Math.sin(a) * Math.cos(tilt),
      Math.sin(a) * Math.sin(tilt),
    );
    const el = this.sun.dot(up);
    this.dayF = sm(-0.12, 0.25, el);
    this.space = sm(R * 0.08, R * 0.5, alt);
    // weather
    if (S.weather === "auto") {
      if ((this.timer -= dt) < 0) {
        const r = Math.random();
        this.kind = r < 0.5 ? "clear" : r < 0.7 ? "fog" : "precip";
        this.timer = 40 + Math.random() * 70;
      }
    } else this.kind = S.weather;
    const pr =
        this.kind === "precip" || this.kind === "rain" || this.kind === "snow",
      k = 1 - Math.exp(-dt * 0.5);
    this.snow = this.kind === "snow" || (this.kind === "precip" && temp < 0.35);
    this.cloud +=
      ((pr ? 0.85 : this.kind === "fog" ? 0.5 : 0) - this.cloud) * k;
    this.fogW += ((this.kind === "fog" ? 1 : pr ? 0.35 : 0) - this.fogW) * k;
    this.pAmt += ((pr ? 1 : 0) - this.pAmt) * k;
    // sky colour
    const g = this.dayF * 0.55 + 0.03;
    this.bg
      .set(0x03050d)
      .lerp(this.c.set(0x5b9bdc), this.dayF)
      .lerp(
        this.c.set(0xff8a4a),
        Math.exp(-((el / 0.15) ** 2)) * 0.55 * (1 - this.cloud),
      )
      .lerp(this.c.setRGB(g, g, g * 1.05), this.cloud * 0.8)
      .multiplyScalar(1 - this.space);
    const f = this.scene.fog as THREE.FogExp2;
    f.color.copy(this.bg);
    f.density = (0.0009 + this.fogW * 0.012) * (1 - this.space);
    // lights
    this.light.position.copy(this.sun).multiplyScalar(R * 6);
    this.moon.position.copy(this.sun).multiplyScalar(-R * 6);
    this.light.color
      .set(0xfff4e0)
      .lerp(this.c.set(0xff9040), Math.exp(-((el / 0.15) ** 2)) * 0.8);
    this.light.intensity = 3 * (1 - 0.55 * this.cloud);
    this.amb.intensity = 0.05 + 0.25 * this.dayF * (1 - this.space);
    // bodies
    this.stars.position.copy(cam.position);
    (this.stars.material as THREE.PointsMaterial).opacity =
      (1 - this.dayF * (1 - this.space)) * (1 - this.cloud * 0.7);
    this.stars.visible =
      (this.stars.material as THREE.PointsMaterial).opacity > 0.01;
    this.disc.position.copy(cam.position).addScaledVector(this.sun, 12000);
    {
      const k = Math.max(0, 1 - this.cloud / 0.6);
      (this.disc.material as THREE.MeshBasicMaterial).color.setRGB(
        8 * k,
        7 * k,
        5.5 * k,
      );
      this.disc.visible = k > 0.01;
    }
    {
      const k =
        Math.max(0, 1 - this.dayF * 1.6) * Math.max(0, 1 - this.cloud * 1.2);
      this.moonDisc.position
        .copy(cam.position)
        .addScaledVector(this.sun, -12000);
      (this.moonDisc.material as THREE.MeshBasicMaterial).color.setRGB(
        1.6 * k,
        1.7 * k,
        2 * k,
      );
      this.moonDisc.visible = k > 0.01;
    }
    this.pl.atmo.uniforms.sun.value.copy(this.sun);
    this.pl.atmo.uniforms.fade.value = sm(R * 0.03, R * 0.25, alt);
    this.fx.update(cam, up, this.snow, this.pAmt, alt);
  }
}
