import * as THREE from "three";
import { U, NOISE, CLOUD_GLSL } from "./fx";
import type { Sky } from "./sky";
// Drifting clouds: a planet-anchored shell above the peaks. Density is 3-octave noise advected by wind; self-shadowing comes from a second
// sample toward the sun; sunset tint from the cloud's own sun elevation; distance haze when inside the atmosphere. One cheap fragment shader.
export class CloudShell {
  mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      uCT: U.uCT,
      uCov: U.uCov,
      uSun: U.uSun,
      uN3: U.uN3,
      uCam: { value: new THREE.Vector3() },
      uFog: { value: new THREE.Color() },
      uDay: { value: 1 },
      uSpace: { value: 0 },
    },
    vertexShader: `
varying vec3 vP;
void main() {
  vP = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.);
}`,
    fragmentShader: `
varying vec3 vP;
uniform vec3 uSun, uCam, uFog;
uniform float uDay, uSpace;
${NOISE}
${CLOUD_GLSL}
void main() {
  vec3  d = normalize(vP);
  float c = cdens(d, 3);
  if (c < .01) discard;
  float c2  = cdens(normalize(d + uSun * .025), 2);
  float lit = clamp(1. - (c2 - c) * 2.2, .3, 1.2);
  float su  = dot(d, uSun);
  vec3 sunC = mix(vec3(1., .5, .28), vec3(1.05, 1.02, .98), smoothstep(-.02, .4, su));
  vec3 col  = mix(vec3(.16, .19, .26) * (.25 + .75 * uDay), sunC * lit, smoothstep(-.12, .18, su));
  col += sunC * (1. - smoothstep(0., .4, c)) * .35 * smoothstep(-.1, .3, su);
  float k = smoothstep(140., 520., length(vP - uCam)) * (1. - uSpace);
  col = mix(col, uFog, k);
  gl_FragColor = vec4(col, c * (1. - k));
}`,
  });
  make(R: number) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(R, 96, 64), this.mat);
    m.frustumCulled = false;
    return m;
  }
  update(cam: THREE.Vector3, sky: Sky) {
    const u = this.mat.uniforms;
    u.uCam.value.copy(cam);
    u.uSpace.value = sky.space;
    u.uFog.value.copy(sky.bg);
    u.uDay.value = sky.dayF;
    this.mat.visible = U.uCov.value > 0.1;
  }
}
// Sky gradient + sun halo drawn on a camera-following dome (horizon colour equals the fog colour, so distant terrain melts into it).
export class SkyDome {
  mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    uniforms: {
      uUp: { value: new THREE.Vector3(0, 1, 0) },
      uSun: U.uSun,
      uBg: { value: new THREE.Color() },
      uDay: { value: 1 },
      uSpace: { value: 0 },
      uCloud: { value: 0 },
    },
    vertexShader: `
varying vec3 vD;
void main() {
  vD = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.);
}`,
    fragmentShader: `
varying vec3 vD;
uniform vec3 uUp, uSun, uBg;
uniform float uDay, uSpace, uCloud;
void main() {
  vec3  d   = normalize(vD);
  float h   = dot(d, uUp);
  float s   = max(dot(d, uSun), 0.);
  vec3  col = h < 0. ? uBg : mix(uBg, uBg * .62, smoothstep(0., .65, h));
  col += vec3(.5, .55, .65) * pow(1. - clamp(abs(h), 0., 1.), 6.) * .08 * uDay * (1. - uSpace);
  col += vec3(1., .78, .5) * (pow(s, 64.) * .7 + pow(s, 10.) * .15 + pow(s, 3.) * .04 * (1. - smoothstep(0., .5, h)))
       * uDay * (1. - uCloud) * (1. - uSpace);
  gl_FragColor = vec4(col, 1.);
}`,
  });
  mesh = new THREE.Mesh(new THREE.SphereGeometry(17000, 32, 16), this.mat);
  constructor(scene: THREE.Scene) {
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -100;
    scene.add(this.mesh);
  }
  update(cam: THREE.Vector3, up: THREE.Vector3, sky: Sky) {
    this.mesh.position.copy(cam);
    const u = this.mat.uniforms;
    u.uUp.value.copy(up);
    u.uBg.value.copy(sky.bg);
    u.uDay.value = sky.dayF;
    u.uSpace.value = sky.space;
    u.uCloud.value = Math.min(1, sky.cloud);
  }
}
