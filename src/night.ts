import * as THREE from "three";
import { T, TERRAIN_GLSL } from "./gpu";
import { U } from "./fx";
const FIREFLY_COUNT = 320,
  scratchForwardAxis = new THREE.Vector3(),
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
  if (e < .05 || uAmt < .01) discard;
  float az  = atan(dot(vD, uR), dot(vD, uF) + 1e-5);
  float w   = n(vec2(az * 3. + uT * .05, uT * .1)) * 2. + n(vec2(az * 9., uT * .3));
  float c   = pow(abs(sin(az * 2. + w + uT * .15)), 3.);
  float b   = smoothstep(.08, .22, e) * (1. - smoothstep(.4, .75, e));
  float ray = n(vec2(az * 40., e * 3. - uT * .5));
  float I   = c * b * (.5 + .7 * ray) * uAmt * 1.6;
  vec3  col = mix(vec3(.15, 1., .5), vec3(.6, .25, .9), smoothstep(.2, .6, e));
  gl_FragColor = vec4(col * I, I);
}`,
  });
  mesh = new THREE.Mesh(
    new THREE.SphereGeometry(16000, 32, 16),
    this.mat,
  );
  constructor(scene: THREE.Scene) {
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }
  update(
    cameraPosition: THREE.Vector3,
    upDirection: THREE.Vector3,
    intensity: number,
    time: number,
  ) {
    this.mesh.visible = intensity > 0.01;
    if (!this.mesh.visible) return;
    this.mesh.position.copy(cameraPosition);
    const uniforms = this.mat.uniforms,
      forwardAxis = scratchForwardAxis
        .crossVectors(
          upDirection,
          Math.abs(upDirection.x) < 0.9 ? AXIS_X : AXIS_Z,
        )
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
    const seedData = new Float32Array(FIREFLY_COUNT * 4);
    for (let i = 0; i < seedData.length; i++) seedData[i] = Math.random();
    const g = new THREE.BufferGeometry()
      .setAttribute(
        "position",
        new THREE.BufferAttribute(new Float32Array(FIREFLY_COUNT * 3), 3),
      )
      .setAttribute("sd", new THREE.BufferAttribute(seedData, 4));
    this.mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        ...T,
        uT: { value: 0 },
        uAmt: { value: 0 },
        uPx: { value: 140 },
        uCam: { value: new THREE.Vector3() },
      },
      vertexShader: `
attribute vec4 sd;
uniform float uT, uAmt, uPx;
uniform vec3 uCam;
varying float vA;
${TERRAIN_GLSL}
void main() {
  vec3 p = uCam + (mod(sd.xyz * 80. - uCam, 80.) - 40.)
         + vec3(sin(uT * .7 + sd.x * 30.), cos(uT * .6 + sd.y * 30.), sin(uT * .5 + sd.z * 30.)) * .8;
  vec3  d  = normalize(p);
  vec3  w  = d * (uR + e3(d, true) * uAmp + .4 + sd.w * 2.4 + sin(uT * .6 + sd.w * 40.) * .4);
  float ph = .5 + .5 * sin(uT * 2. + sd.w * 6.283);
  vA = ph * uAmt * (1. - smoothstep(25., 40., distance(w, uCam)));
  vec4 mv = modelViewMatrix * vec4(w, 1.);
  gl_PointSize = min(uPx * (.6 + .6 * ph) / -mv.z, 64.);
  gl_Position = projectionMatrix * mv;
}`,
      fragmentShader: `
varying float vA;
void main() {
  float d = length(gl_PointCoord - .5);
  gl_FragColor = vec4(.8, 1., .4, smoothstep(.5, 0., d) * vA * 3.);
}`,
    });
    this.pts = new THREE.Points(g, this.mat);
    this.pts.frustumCulled = false;
    scene.add(this.pts);
  }
  update(_deltaTime: number, time: number, cameraPosition: THREE.Vector3, intensity: number) {
    this.mat.uniforms.uT.value = time;
    this.mat.uniforms.uAmt.value = intensity;
    this.mat.uniforms.uCam.value.copy(cameraPosition);
    this.pts.visible = intensity > 0.02;
  }
}
const BAND_COUNT = 600;
export class GalacticBand {
  mesh: THREE.Points;
  constructor(scene: THREE.Scene) {
    const pos = new Float32Array(BAND_COUNT * 3);
    const gal = new Float32Array(BAND_COUNT); // 0 = galactic core, 1 = anti-core
    for (let i = 0; i < BAND_COUNT; i++) {
      const lon = (i / BAND_COUNT) * Math.PI * 2;
      const lat = (Math.random() - 0.5) * 0.22;
      const r   = 999;
      pos[i * 3]     = r * Math.cos(lat) * Math.cos(lon);
      pos[i * 3 + 1] = r * Math.sin(lat);
      pos[i * 3 + 2] = r * Math.cos(lat) * Math.sin(lon);
      gal[i] = Math.abs(lon - Math.PI) / Math.PI;
    }
    const geo = new THREE.BufferGeometry()
      .setAttribute("position", new THREE.BufferAttribute(pos, 3))
      .setAttribute("aGal",     new THREE.BufferAttribute(gal, 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite:  false,
      blending:    THREE.AdditiveBlending,
      uniforms:    { uOpacity: U.uNight },
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
