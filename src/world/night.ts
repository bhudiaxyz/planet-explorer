import * as THREE from "three";
import { T, TERRAIN_GLSL } from "../render/terrain";
import { U } from "../render/fx";
import { gpuTier } from "../render/gputier";
const scratchForwardAxis = new THREE.Vector3(),
  AXIS_X = new THREE.Vector3(1, 0, 0),
  AXIS_Z = new THREE.Vector3(0, 0, 1);
const NOISE_GLSL = `
float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float n(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3. - 2. * f);
  return mix(mix(h(i), h(i + vec2(1, 0)), f.x),
             mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y);
}`;
// Aurora: additive curtain shell around the camera, strongest at night near the poles.
export class Aurora {
  mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.BackSide,
    uniforms: {
      uT: { value: 0 },
      uAmt: { value: 0 },
      uUp: { value: new THREE.Vector3(0, 1, 0) },
      uR: { value: new THREE.Vector3(1, 0, 0) },
      uF: { value: new THREE.Vector3(0, 0, 1) },
    },
    vertexShader: `
varying vec3 vD;
void main() {
  vD = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.);
}`,
    fragmentShader: `
uniform float uT, uAmt;
uniform vec3 uUp, uR, uF;
varying vec3 vD;
${NOISE_GLSL}
void main() {
  float e = dot(vD, uUp);
  if (uAmt < .01) discard;
  float az  = atan(dot(vD, uR), dot(vD, uF) + 1e-5);
  float w   = n(vec2(az * 3. + uT * .05, uT * .1)) * 2. + n(vec2(az * 9., uT * .3));
  float c   = pow(abs(sin(az * 2. + w + uT * .15)), 3.);
  float b   = smoothstep(.04, .22, e) * (1. - smoothstep(.4, .75, e));
  float ray = n(vec2(az * 40., e * 3. - uT * .5));
  float I   = c * b * (.5 + .7 * ray) * uAmt;
  vec3  col = e < 0.15
    ? mix(vec3(.9, .2, .05), vec3(.15, 1., .5), e / 0.15)
    : mix(vec3(.15, 1., .5), vec3(.6, .25, .9), smoothstep(.15, .6, e));
  gl_FragColor = vec4(col * I, I);
}`,
  });
  // Q3: level 2 on all tiers — aurora is purely fragment-shader driven; extra vertices only add VS cost.
  mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(16000, 2), this.mat);
  private readonly _parented: boolean;
  // P8: pass camera to parent the shell to it, eliminating the per-frame position copy and matrix recompose.
  constructor(scene: THREE.Scene, camera?: THREE.Camera) {
    this.mesh.frustumCulled = false;
    if (camera) {
      camera.add(this.mesh);
      this._parented = true;
    } else {
      scene.add(this.mesh);
      this._parented = false;
    }
  }
  update(
    cameraPosition: THREE.Vector3,
    upDirection: THREE.Vector3,
    intensity: number,
    time: number
  ) {
    this.mesh.visible = intensity > 0.01;
    if (!this.mesh.visible) return;
    if (!this._parented) this.mesh.position.copy(cameraPosition);
    const uniforms = this.mat.uniforms,
      forwardAxis = scratchForwardAxis
        .crossVectors(upDirection, Math.abs(upDirection.x) < 0.9 ? AXIS_X : AXIS_Z)
        .normalize();
    uniforms.uT.value = time;
    uniforms.uAmt.value = intensity;
    uniforms.uUp.value.copy(upDirection);
    uniforms.uF.value.copy(forwardAxis);
    uniforms.uR.value.crossVectors(forwardAxis, upDirection);
  }
}
// Fireflies: fully GPU. Seeds wrap in a world-anchored 80 m cube around the camera; the vertex shader samples the terrain function to hover each mote above the ground.
export class Fireflies {
  pts: THREE.Points;
  mat: THREE.ShaderMaterial;
  constructor(scene: THREE.Scene, _pl?: unknown) {
    const FIREFLY_COUNT = gpuTier === "low" ? 50 : gpuTier === "medium" ? 120 : 220;
    const seedData = new Float32Array(FIREFLY_COUNT * 4);
    for (let i = 0; i < seedData.length; i++) seedData[i] = Math.random();
    const g = new THREE.BufferGeometry()
      .setAttribute("position", new THREE.BufferAttribute(new Float32Array(FIREFLY_COUNT * 3), 3))
      .setAttribute("sd", new THREE.BufferAttribute(seedData, 4));
    this.mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        ...T,
        uT: { value: 0 },
        uAmt: { value: 0 },
        uDay: { value: 0 },
        uPx: { value: 140 },
        uCam: { value: new THREE.Vector3() },
      },
      vertexShader: `
attribute vec4 sd;
uniform float uT, uAmt, uDay, uPx;
uniform vec3 uCam;
varying float vA, vDayness;
${TERRAIN_GLSL}
void main() {
  vec3 p = uCam + (mod(sd.xyz * 80. - uCam, 80.) - 40.)
         + vec3(sin(uT * .7 + sd.x * 30.), cos(uT * .6 + sd.y * 30.), sin(uT * .5 + sd.z * 30.)) * .8;
  vec3  d  = normalize(p);
  // P9: fine=false saves 3 noise evaluations per firefly per frame; <1 m height difference, imperceptible.
  vec3  w  = d * (uR + e3(d, false) * uAmp + .4 + sd.w * 2.4 + sin(uT * .6 + sd.w * 40.) * .4);
  float ph = .5 + .5 * sin(uT * 2. + sd.w * 6.283);
  float amt = max(uAmt, uDay * .07);
  vA = ph * amt * (1. - smoothstep(25., 40., distance(w, uCam)));
  vDayness = clamp(uDay * 8., 0., 1.);
  vec4 mv = modelViewMatrix * vec4(w, 1.);
  gl_PointSize = min(uPx * (.4 + .4 * ph) / -mv.z, 64.);
  gl_Position = projectionMatrix * mv;
}`,
      fragmentShader: `
varying float vA, vDayness;
void main() {
  float d = length(gl_PointCoord - .5);
  vec3 col = mix(vec3(.8, 1., .4), vec3(.95, .88, .72), vDayness);
  gl_FragColor = vec4(col, smoothstep(.5, 0., d) * vA * 3.);
}`,
    });
    this.pts = new THREE.Points(g, this.mat);
    this.pts.frustumCulled = false;
    scene.add(this.pts);
  }
  update(
    _deltaTime: number,
    time: number,
    cameraPosition: THREE.Vector3,
    intensity: number,
    dayF = 0
  ) {
    this.mat.uniforms.uT.value = time;
    this.mat.uniforms.uAmt.value = intensity;
    this.mat.uniforms.uDay.value = dayF;
    this.mat.uniforms.uCam.value.copy(cameraPosition);
    this.pts.visible = intensity > 0.02 || dayF > 0.1;
  }
}
export class Bioluminescence {
  pts: THREE.Points;
  mat: THREE.ShaderMaterial;
  constructor(scene: THREE.Scene) {
    const BIO_COUNT = gpuTier === "low" ? 12 : gpuTier === "medium" ? 28 : 50;
    const sd = new Float32Array(BIO_COUNT * 4);
    for (let i = 0; i < sd.length; i++) sd[i] = Math.random();
    const geo = new THREE.BufferGeometry()
      .setAttribute("position", new THREE.BufferAttribute(new Float32Array(BIO_COUNT * 3), 3))
      .setAttribute("sd", new THREE.BufferAttribute(sd, 4));
    this.mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { ...T, uT: { value: 0 }, uCam: { value: new THREE.Vector3() }, uNight: U.uNight },
      vertexShader: `
${TERRAIN_GLSL}
attribute vec4   sd;
uniform   vec3   uCam;
uniform   float  uT, uNight;
varying   float  vPulse, vMoist, vWarm;
void main() {
  vec3  cell  = fract(uCam / 60.0 + sd.xyz - 0.5) * 60.0 - 30.0 + uCam;
  vec3  d     = normalize(cell);
  float elev  = e3(d, true);
  float moist = 0.5 + 0.5 * pn(d * uFreq * 2.2 + vec3(30., 0., 0.), 1);
  float land  = step(0.0, elev);
  float ok    = land * smoothstep(0.2, 0.45, moist) * (1.0 - smoothstep(0.72, 0.85, moist));
  float r     = length(uCam) + elev * uAmp + 0.25;
  vec3  wpos  = d * r;
  wpos.x     += sin(uT * 0.4 + sd.x * 6.28) * 0.4;
  wpos.y     += sin(uT * 0.3 + sd.y * 6.28) * 0.3;
  wpos.z     += cos(uT * 0.35 + sd.z * 6.28) * 0.4;
  vPulse      = fract(sd.w + uT * 0.06);
  vMoist      = moist * ok;
  vWarm       = 1.0 - abs(d.y);
  vec4 mv     = modelViewMatrix * vec4(wpos, 1.0);
  gl_Position  = projectionMatrix * mv;
  gl_PointSize = min(mix(3.5, 7.0, sd.x) * (1.0 / -mv.z) * 550.0 * uNight * ok, 96.0);
}`,
      fragmentShader: `
uniform float uNight;
varying float vPulse, vMoist, vWarm;
void main() {
  float r     = length(gl_PointCoord - 0.5) * 2.0;
  if (r > 1.0) discard;
  float pulse = 0.5 + 0.5 * sin(vPulse * 6.28);
  vec3  coolCol = mix(vec3(0.08, 0.88, 0.42), vec3(0.15, 0.45, 1.0), vMoist);
  vec3  col   = mix(coolCol, vec3(1.0, 0.55, 0.08), vWarm * 0.65);
  gl_FragColor = vec4(col * 1.4, (1.0 - r * r) * 1.8 * pulse * uNight * vMoist);
}`,
    });
    this.pts = new THREE.Points(geo, this.mat);
    this.pts.frustumCulled = false;
    scene.add(this.pts);
  }
  update(dt: number, cameraPosition: THREE.Vector3) {
    this.mat.uniforms.uT.value += dt;
    this.mat.uniforms.uCam.value.copy(cameraPosition);
  }
}
export class GalacticBand {
  mesh: THREE.Points;
  constructor(scene: THREE.Scene) {
    const BAND_COUNT = gpuTier === "low" ? 140 : gpuTier === "medium" ? 280 : 500;
    const pos = new Float32Array(BAND_COUNT * 3);
    const gal = new Float32Array(BAND_COUNT); // 0 = galactic core, 1 = anti-core
    for (let i = 0; i < BAND_COUNT; i++) {
      const lon = (i / BAND_COUNT) * Math.PI * 2;
      const lat = (Math.random() - 0.5) * 0.22;
      const r = 999;
      pos[i * 3] = r * Math.cos(lat) * Math.cos(lon);
      pos[i * 3 + 1] = r * Math.sin(lat);
      pos[i * 3 + 2] = r * Math.cos(lat) * Math.sin(lon);
      gal[i] = Math.abs(lon - Math.PI) / Math.PI;
    }
    const geo = new THREE.BufferGeometry()
      .setAttribute("position", new THREE.BufferAttribute(pos, 3))
      .setAttribute("aGal", new THREE.BufferAttribute(gal, 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uOpacity: U.uNight },
      vertexShader: `
attribute float aGal;
varying  float vGal, vLat;
void main() {
  vGal      = aGal;
  vLat      = abs(position.y / length(position));
  float core = 1.0 - vGal;
  gl_PointSize = mix(1.5, 3.5, core * core);
  gl_Position  = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`,
      fragmentShader: `
uniform float uOpacity;
varying float vGal, vLat;
void main() {
  float r = length(gl_PointCoord - 0.5) * 2.0;
  if (r > 1.0) discard;
  float core = 1.0 - vGal;
  // Great Rift: dark absorption lane near galactic equator in the inner half
  float rift = smoothstep(0.06, 0.02, vLat) * smoothstep(0.6, 0.3, vGal);
  vec3  col  = mix(vec3(0.55, 0.65, 1.0), vec3(1.0, 0.88, 0.65), core * core);
  float a    = (1.0 - r * r) * mix(0.22, 0.8, core) * (1.0 - rift * 0.8);
  gl_FragColor = vec4(col, a * uOpacity);
}`,
    });
    this.mesh = new THREE.Points(geo, mat);
    this.mesh.renderOrder = 1;
    scene.add(this.mesh);
  }
}
