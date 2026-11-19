/**
 * world/skyfx.ts — cloud shell and sky dome shader meshes
 *
 * Purpose:
 *   The two sky-surface effects that are pure shader meshes: a planet-anchored drifting cloud layer and a
 *   camera-following gradient dome with sun halo and rainbow. Driven by the state held in Sky (sky.ts).
 *
 * Operations:
 *   - CloudShell: ShaderMaterial on a sphere above the peaks. make(R) builds the mesh, update(cam, sky) feeds
 *     camera position, fog colour, day factor and space factor, and hides it when coverage (U.uCov) is low
 *   - SkyDome: BackSide dome (radius 17000) with horizon-matched gradient, sun glow and primary/secondary rainbow.
 *     update(cam, up, sky, dt) moves it to the camera and computes uBow from rain memory, cloud, and sun elevation
 *
 * Usage:
 *   CloudShell is owned by Planet (planet.clouds; mesh built on planet rebuild) and updated per frame from main.ts.
 *   SkyDome is created and updated per frame in main.ts after sky.update().
 *
 * Important:
 *   - Clouds sample shared uniforms (U.uCT, uCov, uSun, uN3) and GLSL (NOISE, CLOUD_GLSL) from render/fx.ts, so
 *     they must stay in step with any other consumer of the same cloud density.
 *   - SkyDome horizon colour equals sky.bg (the fog colour) so distant terrain melts into it; it renders first
 *     (renderOrder -100, no depth test).
 *   - Silver lining is compiled only on the high GPU tier (HI define).
 */
import * as THREE from "three";
import { U, NOISE, CLOUD_GLSL } from "../render/fx";
import type { Sky } from "./sky";
import { gpuTier } from "../render/gputier";
// Drifting clouds: a planet-anchored shell above the peaks. Density is 3-octave noise advected by wind; self-shadowing comes from a second
// sample toward the sun; sunset tint from the cloud's own sun elevation; distance haze when inside the atmosphere. One cheap fragment shader.
export class CloudShell {
    mat = new THREE.ShaderMaterial({
        defines: gpuTier === "high" ? { HI: "" } : {},
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
#ifdef HI
  // silver lining: thin cloud edges near the sun glow with forward-scattered light (camera → cloud → sun alignment)
  float fwd = pow(max(dot(normalize(vP - uCam), uSun), 0.), 6.);
  col += sunC * fwd * (1. - smoothstep(0., .5, c)) * .6 * uDay;
#endif
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
            uBow: { value: 0 },
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
uniform float uDay, uSpace, uCloud, uBow;
void main() {
  vec3  d   = normalize(vD);
  float h   = dot(d, uUp);
  float s   = max(dot(d, uSun), 0.);
  vec3  col = h < 0. ? uBg : mix(uBg, uBg * .62, smoothstep(0., .65, h));
  col += vec3(.5, .55, .65) * pow(1. - clamp(abs(h), 0., 1.), 6.) * .08 * uDay * (1. - uSpace);
  col += vec3(1., .78, .5) * (pow(s, 64.) * .7 + pow(s, 10.) * .15 + pow(s, 3.) * .04 * (1. - smoothstep(0., .5, h)))
       * uDay * (1. - uCloud) * (1. - uSpace);
  // Rainbow: primary bow at 42° from the anti-solar point (red outside, violet inside), a faint secondary at 51° with
  // the colours reversed, and the brighter sky inside the primary. Only above the horizon.
  if (uBow > .002 && h > 0.) {
    float ang = degrees(acos(clamp(dot(d, -uSun), -1., 1.)));
    float t1 = (ang - 40.4) / 2.2, t2 = (ang - 50.2) / 3.2;   // 0..1 across each band
    vec3 bow = vec3(0.);
    if (t1 > 0. && t1 < 1.) bow += clamp(vec3(abs(t1 * 6. - 3.) - 1., 2. - abs(t1 * 6. - 2.), 2. - abs(t1 * 6. - 4.)), 0., 1.)
                                   * sin(t1 * 3.1416);
    if (t2 > 0. && t2 < 1.) bow += clamp(vec3(abs((1. - t2) * 6. - 3.) - 1., 2. - abs((1. - t2) * 6. - 2.), 2. - abs((1. - t2) * 6. - 4.)), 0., 1.)
                                   * sin(t2 * 3.1416) * .35;
    float inside = smoothstep(40.5, 30., ang) * .06;
    col += (bow * .28 + inside) * uBow * smoothstep(0., .08, h);
  }
  gl_FragColor = vec4(col, 1.);
}`,
    });
    mesh = new THREE.Mesh(new THREE.SphereGeometry(17000, 32, 16), this.mat);
    constructor(scene: THREE.Scene) {
        this.mesh.frustumCulled = false;
        this.mesh.renderOrder = -100;
        scene.add(this.mesh);
    }
    private wet = 0;
    update(cam: THREE.Vector3, up: THREE.Vector3, sky: Sky, dt = 0.016) {
        this.mesh.position.copy(cam);
        const u = this.mat.uniforms;
        u.uUp.value.copy(up);
        u.uBg.value.copy(sky.bg);
        u.uDay.value = sky.dayF;
        u.uSpace.value = sky.space;
        u.uCloud.value = Math.min(1, sky.cloud);
        // A rainbow needs rain still in the air, the sun breaking through, and a low sun (bow above the horizon).
        // `wet` remembers recent rain: it follows precipitation up quickly and lets go over ~40 s, so the bow
        // lingers while a shower moves off (precipitation and cloud themselves clear together within seconds).
        const p = sky.precipitationAmount;
        this.wet = p > this.wet ? p : Math.max(p, this.wet - dt / 40);
        const sunEl = sky.sun.dot(up);
        u.uBow.value =
            this.wet *
            (1 - p) * // not while it is still pouring
            Math.max(0, 1 - sky.cloud * 1.6) *
            THREE.MathUtils.smoothstep(sunEl, 0.02, 0.12) *
            (1 - THREE.MathUtils.smoothstep(sunEl, 0.55, 0.75)) *
            (1 - sky.space);
    }
}
