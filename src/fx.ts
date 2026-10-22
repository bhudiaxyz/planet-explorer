import * as THREE from "three";
import { T, TERRAIN_GLSL, BIOME_GLSL } from "./gpu";
import { CFG } from "./config";
import { CurrentPalette } from "./palette";
const CELL = CFG.chunk.cell.toFixed(2),
  SKIRT = CFG.chunk.skirt.toFixed(1);
// uGLod = ground-cover LOD (near tier grows 28→12 m, far tier shrinks away 11→5 m)
// 64³ random-byte texture: value noise = one trilinear fetch at a smoothstepped position (same look as the old 8-hash lattice noise, ~8× cheaper per call)
const N3 = 64,
  d3 = new Uint8Array(N3 * N3 * N3);
let noiseRngState = 12345;
for (let i = 0; i < d3.length; i++) {
  noiseRngState = (Math.imul(noiseRngState, 1664525) + 1013904223) | 0;
  d3[i] = noiseRngState >>> 24;
}
const tex3 = new THREE.Data3DTexture(d3, N3, N3, N3);
tex3.format = THREE.RedFormat;
tex3.type = THREE.UnsignedByteType;
tex3.minFilter = tex3.magFilter = THREE.LinearFilter;
tex3.wrapS = tex3.wrapT = tex3.wrapR = THREE.RepeatWrapping;
tex3.unpackAlignment = 1;
tex3.needsUpdate = true;
export const U = {
  uTime: { value: 0 },
  uWind: { value: 1 },
  uSway: { value: 1 },
  uFade: { value: 1 },
  uVeg: { value: 1 },
  uSun: { value: new THREE.Vector3(1, 0, 0) },
  uDayF: { value: 1 },
  uCT: { value: 0 },
  uCov: { value: 0.4 },
  uCloudR: { value: 820 },
  uSky: { value: new THREE.Color(CurrentPalette.atmosphereScatter) },
  uLod: { value: new THREE.Vector4(...CFG.treeLod) },
uOn: { value: 0 },
  uNight: { value: 0 },
  uN3: { value: tex3 },
  uAtOn: { value: 0 },
  uCubeN: { value: null as THREE.Texture | null },
  uCubeC: { value: null as THREE.Texture | null },
  uRect: { value: new THREE.Vector4() },
  uN: { value: new THREE.Vector3() },
  uU: { value: new THREE.Vector3() },
  uV: { value: new THREE.Vector3() },
  uPl: { value: new THREE.Vector3(1e6, 0, 0) },
  uFoot: {
    value: Array.from({ length: 48 }, () => new THREE.Vector4(0, 0, 0, 0)),
  },
};
export const NOISE = `
uniform sampler3D uN3;
float h3(vec3 p) {
  vec3 q = fract(p * .1031);
  q += dot(q, q.zyx + 31.32);
  return fract((q.x + q.y) * q.z);
}
float vn(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3. - 2. * f);
  return texture(uN3, (i + f + .5) * .015625).r;
}`;
type P = THREE.WebGLProgramParametersWithUniforms;
export const IGN = `
float ign(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(.06711056, .00583715))));
}`;
// drifting cloud density on the unit sphere (shared by the cloud shell and the terrain's cloud shadows)
export const CLOUD_GLSL = `
uniform float uCT, uCov;
float cdens(vec3 d, int oct) {
  vec3  p = d * 5. + vec3(uCT * .03, uCT * .011, uCT * .017);
  float f = vn(p) * .55 + vn(p * 2.3 + vec3(3.7, 1.2, 8.1)) * .3;
  f += oct > 2 ? vn(p * 5.1 + vec3(9.1, 4.4, 2.2)) * .15 : .075;
  f = (f - .5) * 1.9 + .5;
  return smoothstep(1. - uCov, 1. - uCov + .22, f);
}`;
// Abstract light tint for foliage/rocks: lit sides warm toward the sun (golden at low sun), cool silver-blue under moonlight, plus a coloured rim glow.
export const TINT_GLSL = `{
  vec3  sv  = normalize((viewMatrix * vec4(uSun, 0.)).xyz);
  vec3  vw  = normalize(vViewPosition);
  float ls  = clamp(dot(normal,  sv), 0., 1.) * smoothstep(0., .25, uDayF);
  float lm  = clamp(dot(normal, -sv), 0., 1.) * (1. - smoothstep(0., .35, uDayF));
  float rim = pow(1. - clamp(dot(normal, vw), 0., 1.), 3.);
  vec3  stc = mix(vec3(1., .97, .9), vec3(1., .6, .3), 1. - smoothstep(.25, .8, uDayF));
  vec3  mtc = vec3(.5, .66, 1.);
  diffuseColor.rgb *= mix(vec3(1.), stc, .3 * ls) * mix(vec3(1.), mtc * 1.5, .45 * lm);
  totalEmissiveRadiance += diffuseColor.rgb * (stc * ls * .18 + mtc * lm * .3) * rim;
}`;
const VW = (s: P) =>
  (s.vertexShader = s.vertexShader
    .replace("#include <common>", "#include <common>\nvarying vec3 vWp;")
    .replace(
      "#include <begin_vertex>",
      "#include <begin_vertex>\nvWp=(modelMatrix*vec4(position,1.)).xyz;",
    ));
const bind = (shaderParams: P, uniformKeys: string[]) =>
  uniformKeys.forEach((k) => (shaderParams.uniforms[k] = (U as any)[k]));
// Terrain on the GPU. Chunks (GPU_H) are flat lattice grids displaced in the vertex shader (height, normals, skirts); the coarse mesh carries
// per-vertex elevation/moisture. Biome colour, grain, bump, shoreline foam and snow footprints are all evaluated per pixel.
const BEGIN = `
#ifdef GPU_H
vec4 H    = texelFetch(uH, ivec2(aL + .5), 0);
vec3 gN   = H.yzw, nA, uu, vv;
basis(uCh.z, nA, uu, vv);
vec3 d0   = normalize(nA * uR + uu * (uCh.x + aL.x) * ${CELL} + vv * (uCh.y + aL.y) * ${CELL});
vec3 p0   = d0 * (uR + H.x * uAmp);
vec3 vcol = texelFetch(uC, ivec2(aL + .5), 0).rgb;
vec2 od   = mod(aL, 2.);
if (uMorph > 0. && od.x + od.y > 0.) {
  vec3 tg = (od.x > .5 && od.y > .5)
    ? (cpos(aL + vec2( 1., -1.), nA, uu, vv) + cpos(aL + vec2(-1.,  1.), nA, uu, vv)) * .5
    : (od.x > .5
      ? (cpos(aL + vec2( 1.,  0.), nA, uu, vv) + cpos(aL - vec2( 1.,  0.), nA, uu, vv)) * .5
      : (cpos(aL + vec2( 0.,  1.), nA, uu, vv) + cpos(aL - vec2( 0.,  1.), nA, uu, vv)) * .5);
  p0 = mix(p0, tg, uMorph);
}
vec3 gP = p0 * (1. - aS * ${SKIRT} / length(p0));
#else
vec3 gN = normal, gP = position;
#ifdef BASE_COL
vec3 vcol = aCol;
#else
vec3 vcol = biome(normalize(gP), aE, aM, gN);
#endif
#endif
vC = vcol;
vec3 objectNormal = gN;`;
export function terrainMat(
  cut: boolean,
  gpu = false,
  extraUniforms: Record<string, { value: any }> = {},
  baked = false,
) {
  const m = new THREE.MeshStandardMaterial({
    roughness: 0.95,
    side: gpu ? THREE.DoubleSide : THREE.FrontSide,
  });
  if (gpu) (m as any).defines = { GPU_H: "" };
  else if (baked) (m as any).defines = { BASE_COL: "" };
  m.customProgramCacheKey = () =>
    (cut ? "c" : "n") + (gpu ? "g" : "b") + (baked ? "k" : "");
  m.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, U, T, extraUniforms);
    s.vertexShader = s.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
varying vec3 vWp,vC;
${TERRAIN_GLSL}
#if !defined(GPU_H) && !defined(BASE_COL)
${BIOME_GLSL}
#endif
#ifdef GPU_H
attribute vec2 aL;attribute float aS;uniform sampler2D uH,uC;uniform vec3 uCh;uniform float uMorph;
vec3 cpos(vec2 L,vec3 nA,vec3 uu,vec3 vv){return normalize(nA*uR+uu*(uCh.x+L.x)*${CELL}+vv*(uCh.y+L.y)*${CELL})*(uR+texelFetch(uH,ivec2(L+.5),0).x*uAmp);}
#elif defined(BASE_COL)
attribute vec3 aCol;
#else
attribute float aE,aM;
#endif`,
      )
      .replace("#include <beginnormal_vertex>", BEGIN)
      .replace(
        "#include <begin_vertex>",
        "vec3 transformed=gP;vWp=(modelMatrix*vec4(transformed,1.)).xyz;",
      );
    s.fragmentShader = s.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
varying vec3 vWp,vC;uniform float uTime,uOn,uR,uFade;uniform vec4 uRect,uFoot[48];uniform vec3 uN,uU,uV,uPl,uSun;uniform float uDayF,uCloudR,uAtOn;uniform samplerCube uCubeN,uCubeC;
${NOISE}${IGN}${CLOUD_GLSL}`,
      )
      .replace(
        "#include <roughnessmap_fragment>",
        "#include <roughnessmap_fragment>\nroughnessFactor=mix(roughnessFactor,.22,smoothstep(.12,.25,vC.b-vC.r));",
      ) // glazed ice is glossy
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
#ifdef GPU_H
{
  float vis = min(uFade, 1. - smoothstep(170., 235., distance(normalize(vWp), normalize(cameraPosition)) * uR));
  if (vis < 1. && ign(gl_FragCoord.xy) > vis) discard;
}
#endif
diffuseColor.rgb = vC;
#ifndef GPU_H
vec4 atN = vec4(0.);
if (uAtOn > 0.) {
  vec3 atD = normalize(vWp);
  atN = texture(uCubeN, atD);
  diffuseColor.rgb = mix(diffuseColor.rgb, texture(uCubeC, atD).rgb, uAtOn);
}
#endif
${cut ? `if (uOn > .5) {
  float dn = dot(vWp, uN);
  if (dn > 0.) {
    float a = dot(vWp, uU) / dn * uR / 1.5;
    float b = dot(vWp, uV) / dn * uR / 1.5;
    if (a > uRect.x && a < uRect.y && b > uRect.z && b < uRect.w) discard;
  }
}` : ""}
float snowF = smoothstep(.72, .88, min(diffuseColor.r, min(diffuseColor.g, diffuseColor.b)));
float dd = length(vViewPosition), gn;
{
  float w1 = 1. - smoothstep(150., 500., dd);
  float w2 = 1. - smoothstep( 60., 220., dd);
  float w3 = 1. - smoothstep( 25.,  90., dd);
  gn = .5 * mix(.5, w1 > 0. ? vn(vWp *  .7) : .5, w1)
     + .3 * mix(.5, w2 > 0. ? vn(vWp * 2.9) : .5, w2)
     + .2 * mix(.5, w3 > 0. ? vn(vWp * 11.) : .5, w3);
  gn = mix(gn, .5, max(snowF * .85, smoothstep(.12, .25, vC.b - vC.r) * .7));
}
diffuseColor.rgb *= .78 + .45 * gn;
vec3  nn  = normalize(vWp);
float sd0 = dot(nn, uSun);
if (uCov > .05 && dd < 500. && uDayF > .02 && sd0 > 0.) {
  vec3 sp = normalize(vWp + uSun * ((uCloudR - length(vWp)) / max(sd0, .15)));
  diffuseColor.rgb *= 1. - .4 * cdens(sp, 2) * uDayF * smoothstep(0., .3, sd0);
}
if (snowF > .5 && dd < 40. && uDayF > .1)
  diffuseColor.rgb += step(.992, h3(floor(vWp * 45.))) * .9 * uDayF * smoothstep(0., .2, sd0);
float hh = length(vWp) - uR;
if (abs(hh) < 1.3) {
  float fo = smoothstep(.45, 0., abs(hh - .1 - .3 * sin(uTime * .8 + vn(vWp * .4) * 6.)))
           * smoothstep(-.9, -.2, hh) * (1. - smoothstep(.3, .9, hh));
  fo *= .5 + .5 * vn(vWp * 3. + uTime * .3);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.95), fo * .85);
}
float fp = 0.;
if (distance(vWp, uPl) < 26.) {
  for (int i = 0; i < 48; i++)
    fp = max(fp, smoothstep(.38, .12, distance(vWp, uFoot[i].xyz)) * uFoot[i].w);
}
fp *= snowF;
diffuseColor.rgb *= 1. - .4 * fp;
gn -= fp * .9;`,
      )
      .replace(
        "#include <normal_fragment_maps>",
        `#include <normal_fragment_maps>
#ifndef GPU_H
if (uAtOn > 0.)
  normal = normalize(mix(normal, normalize((viewMatrix * vec4(normalize(atN.xyz), 0.)).xyz), uAtOn));
#endif
{
  vec3  dx  = dFdx(-vViewPosition), dy = dFdy(-vViewPosition);
  vec3  r1  = cross(dy, normal), r2 = cross(normal, dx);
  float det = dot(dx, r1);
  normal = normalize(abs(det) * normal
         - .06 * (1. - smoothstep(60., 160., dd)) * sign(det) * (dFdx(gn) * r1 + dFdy(gn) * r2));
}`,
      );
  };
  return m;
}
export function wind<T extends THREE.Material>(m: T, k: number): T {
  m.onBeforeCompile = (s) => {
    bind(s, ["uTime", "uWind"]);
    s.vertexShader = s.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nuniform float uTime,uWind;",
      )
      .replace(
        "#include <begin_vertex>",
        `
vec3 iPos = vec3(
  instanceMatrix[3][0],
  instanceMatrix[3][1],
  instanceMatrix[3][2]
);
float _ph  = fract(dot(fract(iPos.xz * 0.1031), iPos.xz + 0.1030)) * 6.2832;
float _amt = uWind * ${k.toFixed(4)} * sin(uTime * 1.1 + _ph);
float _bx  = cos(_ph + 1.2),
      _bz  = sin(_ph + 1.2);
vec3 lp    = position;
float _h   = max(lp.y, 0.0);
lp.x      += _bx * _amt * _h;
lp.z      += _bz * _amt * _h;
vec3 transformed = lp;
`,
      );
  };
  return m;
}
// Water: five travelling wave trains (analytic normals, wind-scaled, small trains fade with distance), whitecap foam on crests, sky Fresnel.
export function waterFx(m: THREE.MeshStandardMaterial) {
  m.onBeforeCompile = (s) => {
    bind(s, [
      "uTime",
      "uWind",
      "uSky",
      "uSun",
      "uDayF",
      "uCubeC",
      "uAtOn",
      "uN3",
    ]);
    s.uniforms.uAmp = T.uAmp;
    s.uniforms.uPl = U.uPl;
    VW(s);
    s.vertexShader = "uniform vec3 uPl, uSun;\nuniform float uTime, uWind;\n" + s.vertexShader;
    s.vertexShader = s.vertexShader.replace(
      "#include <begin_vertex>",
      `
vec3 transformed  = position;

// world position for wave sampling
vec3 wp = (modelMatrix * vec4(position, 1.0)).xyz;

// three Gerstner components: amplitude, frequency, speed, direction angle
float wAmp  = uWind * 0.7;
float t     = uTime;
vec2  d0    = normalize(uSun.xz + vec2(0.001));
vec2  d1    = vec2(-d0.y,  d0.x);
vec2  d2    = normalize(d0 + d1 * 0.5);
float phi0  = dot(d0, wp.xz) * 0.012 + t * 1.2;
float phi1  = dot(d1, wp.xz) * 0.018 + t * 0.9;
float phi2  = dot(d2, wp.xz) * 0.025 + t * 1.5;
float disp  = wAmp * (cos(phi0) * 0.8 + cos(phi1) * 0.5 + cos(phi2) * 0.3);
transformed += normalize(position) * disp;

// player ripple ring
float pdist = length(wp - uPl);
float ripple = sin(pdist * 2.5 - t * 5.0)
             * exp(-pdist * 0.12)
             * 0.35 * uWind;
transformed += normalize(position) * ripple;
`,
    );
    s.fragmentShader = s.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\nvarying vec3 vWp;uniform float uTime,uWind,uDayF,uAtOn,uAmp;uniform vec3 uSky,uSun;uniform samplerCube uCubeC;\n" +
          NOISE,
      )
      .replace(
        "#include <normal_fragment_maps>",
        `#include <normal_fragment_maps>
{
  vec3  nW = normalize(vWp), w = vWp;
  float dd = length(vViewPosition);
  float fa = 1. - smoothstep(50., 260., dd);
  float t  = uTime;
  float A  = .35 + .4 * min(uWind, 2.);

  // domain-warp the sample position to break tiling
  vec2 wd = vec2(vn(w * .06 + t * .005 + vec3(0., 3., 0.)),
                 vn(w * .07 - t * .004 + vec3(5., 0., 2.))) * 9.;
  vec3 ww = w + vec3(wd.x, 0., wd.y);

  // five travelling wave trains (analytic surface gradient + crest accumulator)
  vec3  k1 = normalize(vec3( .8,  .2,  .6));
  vec3  k2 = normalize(vec3(-.5,  .7,  .5));
  vec3  k3 = normalize(vec3( .3, -.6,  .74));
  vec3  k4 = normalize(vec3(-.9,  .1, -.4));
  vec3  k5 = normalize(vec3( .1,  .9, -.5));
  float p1 = dot(ww, k1) * .22 + t * .9;
  float p2 = dot(ww, k2) * .37 + t * 1.1;
  float p3 = dot(ww, k3) * .61 - t * 1.5;
  vec3  g  = k1 * cos(p1) * .12 + k2 * cos(p2) * .148 + k3 * cos(p3) * .17 * (.4 + .6 * fa);
  float cr = (sin(p1) * .55 + sin(p2) * .4 + sin(p3) * .25) * A;
  if (fa > .01) {
    float p4 = dot(ww, k4) * .97 + t * 1.9;
    float p5 = dot(ww, k5) * 1.7  - t * 2.6;
    g  += k4 * cos(p4) * .175 * fa + k5 * cos(p5) * .17 * fa;
    cr += (sin(p4) * .22 + sin(p5) * .19) * A * fa;
    vec3  k6 = normalize(vec3( .58, -.28, -.76));
    vec3  k7 = normalize(vec3(-.18,  .52,  .84));
    float p6 = dot(ww, k6) * .53  + t * 2.1;
    float p7 = dot(ww, k7) * 1.23 - t * 1.7;
    g  += k6 * cos(p6) * .09 * fa + k7 * cos(p7) * .08 * fa;
    cr += (sin(p6) * .15 + sin(p7) * .13) * A * fa;
  }

  // project gradient onto sphere surface → perturb normal
  g *= .35 * A;
  g -= nW * dot(g, nW);
  normal = normalize((viewMatrix * vec4(normalize(nW - g), 0.)).xyz);

  // whitecap foam on crests
  float crest = smoothstep(.55, 1.1, cr + (vn(w * .8 + t * .2) * .25
              + vn(w * 1.37 + t * .15 + vec3(5.7, 0., 2.3)) * .17) - .1)
              * smoothstep(.2, 1., uWind);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.92, .96, 1.), crest * .8);
  diffuseColor.a   = mix(diffuseColor.a,   1.,                 crest);

  // depth-based water colour and shore foam (needs atlas depth channel)
  if (uAtOn > .5) {
    float dep = max(-texture(uCubeC, normalize(vWp)).a * uAmp, 0.);
    float sh  = 1. - smoothstep(0., 7., dep);
    float dp  = smoothstep(2., 45., dep);
    vec3  wc  = mix(vec3(.07, .5, .52), vec3(.02, .1, .28), dp);
    wc *= mix(vec3(1.), vec3(.88, 1.12, 1.),
              vn(vWp * .018) * .6 + vn(vWp * .031 + vec3(3.3, 0., 1.7)) * .4);
    diffuseColor.rgb = mix(diffuseColor.rgb, wc,  .55);
    diffuseColor.a   = mix(diffuseColor.a,   .28, sh * (1. - crest));
    float shore = clamp((1. - smoothstep(0., 1.1, dep))
                * (.55 + .45 * sin(dep * 7. - uTime * 1.6
                   + (vn(vWp * .6) * .62 + vn(vWp * 1.09 + vec3(7.3, 0., 2.1)) * .38) * 5.)),
                  0., 1.);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.95, .98, 1.), shore * .6);
    diffuseColor.a   = mix(diffuseColor.a,   .9,                 shore * .6);
  }

  // sky Fresnel
  float fr = pow(1. - clamp(dot(normal, normalize(vViewPosition)), 0., 1.), 4.);
  diffuseColor.rgb = mix(diffuseColor.rgb, uSky * (.55 + .5 * uDayF), fr * .6);
}`,
      );
  };
}
