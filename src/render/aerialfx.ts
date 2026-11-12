import * as THREE from "three";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { U } from "./fx";
import { T } from "./terrain";

/**
 * Aerial haze + (medium/high) dawn/dusk valley mist + (high) ambient occlusion and sun shafts, in one full-screen pass
 * that already reads scene depth. Each extra is a compile-time define, so lower tiers compile exactly the haze-only shader.
 * Built from a ShaderMaterial (not a plain shader object): ShaderPass clones plain uniform objects, which froze the shared
 * U.uSun / U.uDayF at their startup values — the haze colour never followed the day/night cycle.
 */
export class AerialPass {
    pass: ShaderPass;
    readonly uniforms: Record<string, { value: any }>;
    constructor(depthTexture: THREE.DepthTexture, opts: { mist: boolean; ao: boolean; shafts: boolean }) {
        this.uniforms = {
            tDiffuse: { value: null },
            tDepth: { value: depthTexture },
            uNear: { value: 1.0 },
            uFar: { value: 20000.0 },
            uSun: U.uSun,
            uDayF: U.uDayF,
            uR: T.uR,
            uAmp: T.uAmp,
            uCam: { value: new THREE.Vector3() },
            uInvPV: { value: new THREE.Matrix4() },
            uSunUv: { value: new THREE.Vector3(0.5, 0.5, 0) }, // xy = sun screen position, z = on-screen strength
            uTexel: { value: new THREE.Vector2(1 / 1024, 1 / 1024) },
        };
        const defines: Record<string, string> = {};
        if (opts.mist) defines.MIST = "";
        if (opts.ao) defines.AO = "";
        if (opts.shafts) defines.SHAFTS = "";
        const material = new THREE.ShaderMaterial({
            defines,
            uniforms: this.uniforms,
            depthTest: false,
            depthWrite: false,
            vertexShader: `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`,
            fragmentShader: `
uniform sampler2D tDiffuse;
uniform sampler2D tDepth;
uniform float     uNear, uFar, uDayF, uR, uAmp;
uniform vec3      uSun, uCam, uSunUv;
uniform mat4      uInvPV;
uniform vec2      uTexel;
varying vec2      vUv;
float linZ(float d) { return uNear * uFar / (uFar - d * (uFar - uNear)); }
void main() {
  vec4 col = texture2D(tDiffuse, vUv);
  float d  = texture2D(tDepth, vUv).r;
  bool sky = !(d >= 0.0 && d < 0.9999);
#ifdef SHAFTS
  // God rays: march 12 taps from the pixel toward the on-screen sun, counting sky texels (depth = far) as light.
  // Occluders (trees, peaks) leave gaps, which read as shafts. Only runs while the sun is on screen and low-ish.
  vec3 shaft = vec3(0.);
  if (uSunUv.z > 0.01) {
    vec2 st = (uSunUv.xy - vUv) / 12.;
    vec2 p  = vUv;
    float acc = 0., w = 1.;
    for (int i = 0; i < 12; i++) {
      p += st;
      float sd = texture2D(tDepth, clamp(p, 0., 1.)).r;
      acc += (sd >= .9999 ? 1. : 0.) * w;
      w *= .9;
    }
    float fall = 1. - smoothstep(0., .6, distance(vUv, uSunUv.xy));
    shaft = vec3(1., .82, .58) * acc * .045 * fall * uSunUv.z;
  }
#endif
  if (sky) {
#ifdef SHAFTS
    col.rgb += shaft * .5;
#endif
    gl_FragColor = col;
    return;
  }
  float z   = linZ(d);
#ifdef AO
  // Depth-only ambient occlusion: 8 taps on a ring scaled to ~0.6 m in world space (shrinks with distance), counting
  // neighbours that are notably closer to the camera. Fades out past 120 m, where it would only add noise.
  if (z < 120.) {
    float rad = clamp(18. / z, 1.5, 14.);
    float occ = 0.;
    for (int i = 0; i < 8; i++) {
      float a = float(i) * .785 + fract(sin(dot(vUv, vec2(12.9898, 78.233))) * 43758.5) * .785;
      vec2  o = vec2(cos(a), sin(a)) * rad * (float(i % 2) * .5 + .5) * uTexel;
      float dz = z - linZ(texture2D(tDepth, vUv + o).r);
      occ += smoothstep(.05, .5, dz) * (1. - smoothstep(1.5, 4., dz)); // closer by 5 cm–1.5 m; ignore big depth jumps
    }
    col.rgb *= 1. - (occ / 8.) * .45 * (1. - smoothstep(60., 120., z));
  }
#endif
  // Q1: density derived from uFar so ~20% haze at the far plane regardless of draw distance tier.
  float fog = 1.0 - exp(-z * (0.2231 / uFar));
  vec3  day   = mix(vec3(0.72, 0.78, 0.88), vec3(0.85, 0.70, 0.52), uDayF);
  vec3  haze  = mix(vec3(0.05, 0.06, 0.12), day, uDayF);
  vec3  outc  = mix(col.rgb, haze, fog * 0.55);
#ifdef MIST
  // Valley mist at dawn / dusk: reconstruct the pixel's world position and pool fog in low ground (≤ ~18 % of the
  // terrain amplitude above sea level). Strongest when the sun is just above/below the horizon, gone by mid-morning.
  {
    float sunUp = dot(normalize(uCam), uSun);
    float dawn  = (1. - smoothstep(.12, .35, abs(sunUp - .05))) * (1. - smoothstep(400., 900., length(uCam) - uR));
    if (dawn > .01) {
      vec4 wp = uInvPV * vec4(vUv * 2. - 1., d * 2. - 1., 1.);
      wp.xyz /= wp.w;
      float h    = (length(wp.xyz) - uR) / uAmp;                   // height above sea in amplitude units
      float low  = 1. - smoothstep(.02, .18, h);
      float dist = smoothstep(15., 140., distance(wp.xyz, uCam)); // never in the player's face
      vec3  mc   = mix(vec3(.62, .66, .74), vec3(.95, .8, .66), smoothstep(-.05, .1, sunUp));
      outc = mix(outc, mc, low * dist * dawn * .55);
    }
  }
#endif
#ifdef SHAFTS
  outc += shaft;
#endif
  gl_FragColor = vec4(outc, col.a);
}`,
        });
        this.pass = new ShaderPass(material);
    }
    setCamera(near: number, far: number) {
        this.uniforms.uNear.value = near;
        this.uniforms.uFar.value = far;
    }
    private sp = new THREE.Vector3();
    private dir = new THREE.Vector3();
    /** Per-frame camera state for mist (world reconstruction) and shafts (sun screen position). */
    update(camera: THREE.Camera, w: number, h: number) {
        const u = this.uniforms,
            sun = U.uSun.value as THREE.Vector3;
        u.uCam.value.copy(camera.position);
        u.uInvPV.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).invert();
        u.uTexel.value.set(1 / w, 1 / h);
        // sun on screen: project a point far along the sun direction; strength fades with angle off the view axis and
        // as the sun climbs (shafts are a low-sun effect)
        const facing = camera.getWorldDirection(this.dir).dot(sun),
            sunUp = sun.dot(this.dir.copy(camera.position).normalize()),
            s = this.sp.copy(sun).multiplyScalar(5000).add(camera.position).project(camera),
            ss = THREE.MathUtils.smoothstep;
        u.uSunUv.value.set(
            s.x * 0.5 + 0.5,
            s.y * 0.5 + 0.5,
            facing > 0.2 && s.z < 1 ? ss(facing, 0.2, 0.75) * (1 - ss(sunUp, 0.35, 0.7)) * U.uDayF.value : 0
        );
    }
}
