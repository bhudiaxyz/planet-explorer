import * as THREE from "three";
import { Planet, smoothstep } from "./planet";
import { S, CFG } from "../core/config";
import { CurrentPalette } from "../core/palette";
import { Precip } from "./precip";
import { U } from "../render/fx";
import { gpuTier } from "../render/gputier";
const { sky: SKY, atmosphere: ATM, lights: LGT } = CFG;
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
  light = new THREE.DirectionalLight(0xffffff, LGT.sunIntensity);
  moon = new THREE.DirectionalLight(CurrentPalette.moonLight, LGT.moonIntensity);
  ambientLight = new THREE.AmbientLight(CurrentPalette.ambientLight, 0.3);
  bg = new THREE.Color();
  scratchColor = new THREE.Color();
  disc: THREE.Mesh;
  moonDisc: THREE.Mesh;
  stars: THREE.Points;
  nebulae: THREE.Points;
  precip: THREE.Points;
  precipitation: Precip;
  lastPrecipPos: Float32Array;
  prevPrecipPos: Float32Array;
  constructor(
    private scene: THREE.Scene,
    private planet: Planet
  ) {
    const starCount = gpuTier === "low" ? 900 : gpuTier === "medium" ? 1600 : SKY.starCount;
    const precipCount = gpuTier === "low" ? 1200 : gpuTier === "medium" ? 2200 : SKY.precipCount;
    // P4: nebulae are fill-rate expensive on low tier (up to 512×512 per point); only visible
    // at night in clear weather — skipping them entirely has no visible impact at low resolution.
    const nebulaCount = gpuTier === "low" ? 0 : gpuTier === "medium" ? 9 : SKY.nebulaCount;
    this.lastPrecipPos = new Float32Array(precipCount * 3);
    this.prevPrecipPos = new Float32Array(precipCount * 3);
    scene.add(this.light, this.moon, this.ambientLight);
    scene.fog = new THREE.FogExp2(0, SKY.fogDensityBase);
    scene.background = this.bg;
    this.disc = new THREE.Mesh(
      new THREE.SphereGeometry(SKY.sunDiscRadius, 16, 12),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color().setRGB(8, 7, 5.5),
        fog: false,
      })
    );
    const sp = new Float32Array(starCount * 3),
      sv = new THREE.Vector3();
    for (let i = 0; i < starCount; i++)
      sv.randomDirection()
        .multiplyScalar(18000)
        .toArray(sp, i * 3);
    this.stars = new THREE.Points(
      new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(sp, 3)),
      new THREE.PointsMaterial({
        size: SKY.starSize,
        sizeAttenuation: false,
        transparent: true,
        depthWrite: false,
        fog: false,
      })
    );
    this.precipitation = new Precip(precipCount);
    this.precip = this.precipitation.pts;
    this.moonDisc = new THREE.Mesh(
      new THREE.SphereGeometry(SKY.moonDiscRadius, 16, 12),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color().setRGB(1.6, 1.7, 2),
        fog: false,
      })
    );
    // nebula patches at fixed random directions
    const NC = nebulaCount;
    const np = new Float32Array(NC * 3);
    const nc = new Float32Array(NC * 3); // hue tint per patch
    const ns = new Float32Array(NC); // size per patch
    const NEBULA_HUES = [
      [0.6, 0.3, 1.0],
      [0.2, 0.5, 0.9],
      [1.0, 0.4, 0.3],
      [0.3, 0.8, 0.6],
      [0.9, 0.6, 0.2],
      [0.5, 0.3, 0.9],
      [0.2, 0.7, 0.5],
      [0.8, 0.3, 0.5],
      [0.4, 0.6, 1.0],
      [1.0, 0.7, 0.3],
      [0.3, 0.4, 0.8],
      [0.7, 0.2, 0.6],
      [0.2, 0.9, 0.7],
      [0.6, 0.5, 0.2],
    ];
    for (let i = 0; i < NC; i++) {
      new THREE.Vector3()
        .randomDirection()
        .multiplyScalar(17500)
        .toArray(np, i * 3);
      nc[i * 3] = NEBULA_HUES[i][0];
      nc[i * 3 + 1] = NEBULA_HUES[i][1];
      nc[i * 3 + 2] = NEBULA_HUES[i][2];
      ns[i] = 800 + Math.random() * 1200;
    }
    const nebulaOpacity = SKY.nebulaOpacity;
    this.nebulae = new THREE.Points(
      new THREE.BufferGeometry()
        .setAttribute("position", new THREE.BufferAttribute(np, 3))
        .setAttribute("color", new THREE.BufferAttribute(nc, 3))
        .setAttribute("size", new THREE.BufferAttribute(ns, 1)),
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: false,
        uniforms: { uOpacity: { value: 0 } },
        vertexShader: `
attribute vec3 color;
attribute float size;
varying vec3 vCol;
void main() {
  vCol = color;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = clamp(size / -mv.z * projectionMatrix[1][1] * 0.5, 1.0, 512.0);
  gl_Position = projectionMatrix * mv;
}`,
        fragmentShader: `
uniform float uOpacity;
varying vec3 vCol;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = exp(-d * d * 3.5) * uOpacity * ${nebulaOpacity.toFixed(2)};
  gl_FragColor = vec4(vCol * a, a);
}`,
      })
    );
    const dawnMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uDayF: U.uDayF,
        uSun: U.uSun,
      },
      vertexShader: `
varying float vY;
void main() {
  vY          = normalize(position).y;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`,
      fragmentShader: `
uniform float uDayF;
uniform vec3  uSun;
varying float vY;
void main() {
  float band = smoothstep(0.18, 0.0, abs(vY));
  float dusk = smoothstep(0.3,  0.0, abs(uDayF - 0.5));
  vec3  col  = mix(vec3(1.0, 0.28, 0.04), vec3(0.55, 0.25, 0.75), step(0.5, uDayF));
  gl_FragColor = vec4(col, band * dusk * 0.5);
}`,
    });
    const dawnMesh = new THREE.Mesh(
      new THREE.SphereGeometry(SKY.dawnSphereRadius, 32, 12),
      dawnMat
    );
    dawnMesh.renderOrder = 2;
    dawnMesh.frustumCulled = false;
    for (const o of [this.stars, this.nebulae, this.precip, this.disc, this.moonDisc])
      o.frustumCulled = false;
    scene.add(this.disc, this.moonDisc, this.stars, this.precip, dawnMesh);
    if (NC > 0) scene.add(this.nebulae);
  }
  update(dt: number, cam: THREE.Camera, up: THREE.Vector3, alt: number, temp: number) {
    if (!Number.isFinite(alt) || !Number.isFinite(temp)) return;
    const planetRadius = this.planet.radius,
      dayAngle = S.timeOfDay * Math.PI * 2,
      tilt = ATM.tilt;
    S.timeOfDay = (S.timeOfDay + dt / S.dayLength) % 1;
    this.sun.set(
      Math.cos(dayAngle),
      Math.sin(dayAngle) * Math.cos(tilt),
      Math.sin(dayAngle) * Math.sin(tilt)
    );
    const sunElevation = this.sun.dot(up);
    this.dayF = smoothstep(ATM.dayFadeLow, ATM.dayFadeHigh, sunElevation);
    this.space = smoothstep(
      planetRadius * ATM.spaceStartFraction,
      planetRadius * ATM.spaceEndFraction,
      alt
    );
    // weather
    if (S.weather === "auto") {
      if ((this.timer -= dt) < 0) {
        const r = Math.random();
        this.kind = r < 0.5 ? "clear" : r < 0.7 ? "fog" : "precip";
        this.timer = 40 + Math.random() * 70;
      }
    } else this.kind = S.weather;
    const isPrecip = this.kind === "precip" || this.kind === "rain" || this.kind === "snow",
      smoothFactor = 1 - Math.exp(-dt * 0.5);
    this.snow = this.kind === "snow" || (this.kind === "precip" && temp < 0.35);
    this.cloud += ((isPrecip ? 0.85 : this.kind === "fog" ? 0.5 : 0) - this.cloud) * smoothFactor;
    this.fogWeight +=
      ((this.kind === "fog" ? 1 : isPrecip ? 0.35 : 0) - this.fogWeight) * smoothFactor;
    this.precipitationAmount += ((isPrecip ? 1 : 0) - this.precipitationAmount) * smoothFactor;
    // sky colour
    const skyGrey = this.dayF * 0.55 + 0.03;
    this.bg
      .set(CurrentPalette.skyNight)
      .lerp(this.scratchColor.set(CurrentPalette.skyDay), this.dayF)
      .lerp(
        this.scratchColor.set(CurrentPalette.skySunset),
        Math.exp(-((sunElevation / 0.15) ** 2)) * 0.55 * (1 - this.cloud)
      )
      .lerp(this.scratchColor.setRGB(skyGrey, skyGrey, skyGrey * 1.05), this.cloud * 0.8)
      .multiplyScalar(1 - this.space);
    const fog = this.scene.fog as THREE.FogExp2;
    fog.color.copy(this.bg);
    fog.density = (SKY.fogDensityBase + this.fogWeight * SKY.fogDensityPrecip) * (1 - this.space);
    // lights
    this.light.position.copy(this.sun).multiplyScalar(planetRadius * 6);
    this.moon.position.copy(this.sun).multiplyScalar(-planetRadius * 6);
    this.light.color
      .set(CurrentPalette.sunLight)
      .lerp(
        this.scratchColor.set(CurrentPalette.sunsetLight),
        Math.exp(-((sunElevation / 0.15) ** 2)) * 0.8
      );
    this.light.intensity = LGT.sunIntensity * (1 - LGT.sunCloudDim * this.cloud);
    this.moon.color.set(CurrentPalette.moonLight);
    this.ambientLight.color.set(CurrentPalette.ambientLight);
    this.ambientLight.intensity =
      LGT.ambientBase + LGT.ambientDayMul * this.dayF * (1 - this.space);
    // bodies
    const starOp = (1 - this.dayF * (1 - this.space)) * (1 - this.cloud * 0.7);
    (this.stars.material as THREE.PointsMaterial).opacity = starOp;
    this.stars.visible = starOp > 0.01;
    if (starOp > 0.01) {
      this.stars.rotation.y = S.timeOfDay * Math.PI * 2;
      this.nebulae.rotation.y = S.timeOfDay * Math.PI * 2;
    }
    (this.nebulae.material as THREE.ShaderMaterial).uniforms.uOpacity.value = starOp;
    this.nebulae.visible = starOp > 0.01;
    this.disc.position.copy(cam.position).addScaledVector(this.sun, 12000);
    {
      const discVisibility = Math.max(0, 1 - this.cloud / 0.6);
      (this.disc.material as THREE.MeshBasicMaterial).color.setRGB(
        CurrentPalette.sunDisc[0] * discVisibility,
        CurrentPalette.sunDisc[1] * discVisibility,
        CurrentPalette.sunDisc[2] * discVisibility
      );
      this.disc.visible = discVisibility > 0.01;
    }
    {
      const moonVisibility = Math.max(0, 1 - this.dayF * 1.6) * Math.max(0, 1 - this.cloud * 1.2);
      this.moonDisc.position.copy(cam.position).addScaledVector(this.sun, -12000);
      (this.moonDisc.material as THREE.MeshBasicMaterial).color.setRGB(
        CurrentPalette.moonDisc[0] * moonVisibility,
        CurrentPalette.moonDisc[1] * moonVisibility,
        CurrentPalette.moonDisc[2] * moonVisibility
      );
      this.moonDisc.visible = moonVisibility > 0.01;
    }
    this.planet.atmosphere.uniforms.sun.value.copy(this.sun);
    this.planet.atmosphere.uniforms.fade.value = smoothstep(
      planetRadius * 0.03,
      planetRadius * 0.25,
      alt
    );
    this.precipitation.update(cam, up, this.snow, this.precipitationAmount, alt);
  }
}
