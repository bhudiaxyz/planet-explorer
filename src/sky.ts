import * as THREE from "three";
import { Planet, smoothstep } from "./planet";
import { S } from "./settings";
import { CurrentPalette } from "./palette";
import { Precip } from "./precip";
const PRECIP_COUNT = 3500;
export class Sky {
  sun = new THREE.Vector3(1, 0, 0);
  dayF = 1;
  space = 0;
  cloud = 0;
  fogWeight = 0;
  precipitationAmount = 0;
  kind = "clear";
  timer = 0;
  snow = false;
  light = new THREE.DirectionalLight(0xffffff, 3);
  moon = new THREE.DirectionalLight(CurrentPalette.moonLight, 0.12);
  ambientLight = new THREE.AmbientLight(CurrentPalette.ambientLight, 0.3);
  bg = new THREE.Color();
  scratchColor = new THREE.Color();
  disc: THREE.Mesh;
  moonDisc: THREE.Mesh;
  stars: THREE.Points;
  precip: THREE.Points;
  precipitation: Precip;
  lastPrecipPos = new Float32Array(PRECIP_COUNT * 3);
  prevPrecipPos = new Float32Array(PRECIP_COUNT * 3);
  constructor(
    private scene: THREE.Scene,
    private planet: Planet,
  ) {
    scene.add(this.light, this.moon, this.ambientLight);
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
      new THREE.Vector3()
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
    this.precipitation = new Precip();
    this.precip = this.precipitation.pts;
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
    const planetRadius = this.planet.radius,
      dayAngle = S.timeOfDay * Math.PI * 2,
      tilt = 0.41;
    S.timeOfDay = (S.timeOfDay + dt / S.dayLength) % 1;
    this.sun.set(
      Math.cos(dayAngle),
      Math.sin(dayAngle) * Math.cos(tilt),
      Math.sin(dayAngle) * Math.sin(tilt),
    );
    const sunElevation = this.sun.dot(up);
    this.dayF = smoothstep(-0.12, 0.25, sunElevation);
    this.space = smoothstep(planetRadius * 0.08, planetRadius * 0.5, alt);
    // weather
    if (S.weather === "auto") {
      if ((this.timer -= dt) < 0) {
        const r = Math.random();
        this.kind = r < 0.5 ? "clear" : r < 0.7 ? "fog" : "precip";
        this.timer = 40 + Math.random() * 70;
      }
    } else this.kind = S.weather;
    const isPrecip =
        this.kind === "precip" || this.kind === "rain" || this.kind === "snow",
      smoothFactor = 1 - Math.exp(-dt * 0.5);
    this.snow =
      this.kind === "snow" || (this.kind === "precip" && temp < 0.35);
    this.cloud +=
      ((isPrecip ? 0.85 : this.kind === "fog" ? 0.5 : 0) - this.cloud) *
      smoothFactor;
    this.fogWeight +=
      ((this.kind === "fog" ? 1 : isPrecip ? 0.35 : 0) - this.fogWeight) *
      smoothFactor;
    this.precipitationAmount +=
      ((isPrecip ? 1 : 0) - this.precipitationAmount) * smoothFactor;
    // sky colour
    const skyGrey = this.dayF * 0.55 + 0.03;
    this.bg
      .set(CurrentPalette.skyNight)
      .lerp(this.scratchColor.set(CurrentPalette.skyDay), this.dayF)
      .lerp(
        this.scratchColor.set(CurrentPalette.skySunset),
        Math.exp(-((sunElevation / 0.15) ** 2)) *
          0.55 *
          (1 - this.cloud),
      )
      .lerp(
        this.scratchColor.setRGB(skyGrey, skyGrey, skyGrey * 1.05),
        this.cloud * 0.8,
      )
      .multiplyScalar(1 - this.space);
    const fog = this.scene.fog as THREE.FogExp2;
    fog.color.copy(this.bg);
    fog.density = (0.0009 + this.fogWeight * 0.012) * (1 - this.space);
    // lights
    this.light.position.copy(this.sun).multiplyScalar(planetRadius * 6);
    this.moon.position.copy(this.sun).multiplyScalar(-planetRadius * 6);
    this.light.color
      .set(CurrentPalette.sunLight)
      .lerp(
        this.scratchColor.set(CurrentPalette.sunsetLight),
        Math.exp(-((sunElevation / 0.15) ** 2)) * 0.8,
      );
    this.light.intensity = 3 * (1 - 0.55 * this.cloud);
    this.ambientLight.intensity =
      0.05 + 0.25 * this.dayF * (1 - this.space);
    // bodies
    this.stars.position.copy(cam.position);
    (this.stars.material as THREE.PointsMaterial).opacity =
      (1 - this.dayF * (1 - this.space)) * (1 - this.cloud * 0.7);
    this.stars.visible =
      (this.stars.material as THREE.PointsMaterial).opacity > 0.01;
    this.disc.position
      .copy(cam.position)
      .addScaledVector(this.sun, 12000);
    {
      const discVisibility = Math.max(0, 1 - this.cloud / 0.6);
      (this.disc.material as THREE.MeshBasicMaterial).color.setRGB(
        CurrentPalette.sunDisc[0] * discVisibility,
        CurrentPalette.sunDisc[1] * discVisibility,
        CurrentPalette.sunDisc[2] * discVisibility,
      );
      this.disc.visible = discVisibility > 0.01;
    }
    {
      const moonVisibility =
        Math.max(0, 1 - this.dayF * 1.6) *
        Math.max(0, 1 - this.cloud * 1.2);
      this.moonDisc.position
        .copy(cam.position)
        .addScaledVector(this.sun, -12000);
      (this.moonDisc.material as THREE.MeshBasicMaterial).color.setRGB(
        CurrentPalette.moonDisc[0] * moonVisibility,
        CurrentPalette.moonDisc[1] * moonVisibility,
        CurrentPalette.moonDisc[2] * moonVisibility,
      );
      this.moonDisc.visible = moonVisibility > 0.01;
    }
    this.planet.atmosphere.uniforms.sun.value.copy(this.sun);
    this.planet.atmosphere.uniforms.fade.value = smoothstep(
      planetRadius * 0.03,
      planetRadius * 0.25,
      alt,
    );
    this.precipitation.update(cam, up, this.snow, this.precipitationAmount, alt);
  }
}
