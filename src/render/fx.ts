import * as THREE from "three";
import { gpuTier, chunkFade } from "./gputier";
import { T, TERRAIN_GLSL, BIOME_GLSL } from "./terrain";
import { CFG, WATER_DEBUG } from "../core/config";
import { CurrentPalette } from "../core/palette";

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
    uWet: { value: 0 }, // 0 dry … 1 soaked: rises with rain, dries over ~1 min (main.ts)
    // 0 … 1 while it snows (main.ts): extra snow cover spreading below the snowline. Drawing only — placement keeps
    // using uSnow, so ground cover never re-bakes or pops as snow builds up.
    uSnowFall: { value: 0 },
    // palette water colour (shallow-water shade). Planet points this at the ocean material's own .color, so palette
    // swaps and the GUI picker update ocean, rivers and map together. Deep water = uWater × WATER_DEEP (shader).
    uWater: { value: new THREE.Color(0x1a3d78) },
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
/** Deep-water shade as a multiple of the palette water colour. Keeps red ≈ blue so the depths stay a warm navy
 *  (Earth #1a3d78 → ~#0c184a) instead of cold indigo; green drops most, so it never drifts teal. */
export const WATER_DEEP = "vec3(.36, .2, .36)";

/** Shore surf, shared by the water and terrain shaders so breaking bands and the wet line move together.
 *  Waves run shoreward: phase = 1.6·depth + 1.3·t, warped by low-frequency noise so crests bend along the coast. */
export const SURF_GLSL = `
float surfPhase(vec3 w, float depth, float t) {
  return depth * 1.6 + t * 1.3 + (vn(w * .045) * .7 + vn(w * .11 + vec3(4.1, 0., 2.7)) * .3) * 9.;
}
`;
/** Final water grade, applied after fog (linear colour: the scene target is linear, tone-mapped later). Keeps water a rich,
 *  palette-hued blue whatever lightened it: sky reflection, sun sheen, the ACES curve, haze or weather fog.
 *  keep = 1 where water should stay white (foam, crests, ice, glitter). target = linear palette water colour. */
export const WATER_GRADE_GLSL = `
vec3 waterGrade(vec3 c, vec3 target, float keep) {
  vec3  W    = vec3(.299, .587, .114);
  float l    = dot(c, W);
  // hue: re-tint to the palette water hue at this pixel's own brightness (lighter / darker detail survives)
  vec3  hued = target * (l / max(dot(target, W), 1e-3));
  // richness: cap the brightness water may reach, so a grey wash can't lift it to pale
  hued = min(hued, target * 1.9 + .04);
  // saturation: push away from grey
  hued = mix(vec3(dot(hued, W)), hued, 1.25);
  return mix(c, clamp(hued, 0., 1.), .62 * (1. - keep));
}
`;
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
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvWp=(modelMatrix*vec4(position,1.)).xyz;"));
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
    baked = false
) {
    const m = new THREE.MeshStandardMaterial({
        roughness: 0.95,
        side: gpu ? THREE.DoubleSide : THREE.FrontSide,
    });
    if (gpu) (m as any).defines = { GPU_H: "" };
    else if (baked) (m as any).defines = { BASE_COL: "" };
    if (gpuTier === "high") (m as any).defines = { ...((m as any).defines ?? {}), DUNES: "" };
    if (gpuTier !== "low") (m as any).defines = { ...((m as any).defines ?? {}), WET: "" }; // low: identical shader to before
    m.customProgramCacheKey = () =>
        (cut ? "c" : "n") +
        (gpu ? "g" : "b") +
        (baked ? "k" : "") +
        (gpuTier === "high" ? "d" : "") +
        (gpuTier !== "low" ? "w" : "");
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
#endif`
            )
            .replace("#include <beginnormal_vertex>", BEGIN)
            .replace("#include <begin_vertex>", "vec3 transformed=gP;vWp=(modelMatrix*vec4(transformed,1.)).xyz;");
        s.fragmentShader = s.fragmentShader
            .replace(
                "#include <common>",
                `#include <common>
varying vec3 vWp,vC;float swashWet = 0.,puddle = 0.;uniform vec3 uSky,uCw;uniform float uTime,uWind,uOn,uR,uFade,uWet,uSnowFall,uSnow,uAmp;uniform vec4 uRect,uFoot[48];uniform vec3 uN,uU,uV,uPl,uSun;uniform float uDayF,uCloudR,uAtOn;uniform samplerCube uCubeN,uCubeC;
#ifdef DUNES
uniform vec3 uCs;
#endif
${NOISE}${SURF_GLSL}${IGN}${CLOUD_GLSL}`
            )
            .replace(
                "#include <roughnessmap_fragment>",
                `#include <roughnessmap_fragment>
roughnessFactor=mix(roughnessFactor,.22,smoothstep(.12,.25,vC.b-vC.r));
#ifdef WET
// rain-soaked ground: glossier and darker; snow-white pixels keep their own look. Swash-wet sand (shore) is glossy too.
float wetF = max(uWet * (1. - smoothstep(.72, .85, min(vC.r, min(vC.g, vC.b)))), swashWet * .9);
roughnessFactor = mix(roughnessFactor, .38, wetF * .8);
roughnessFactor = mix(roughnessFactor, .06, puddle);
diffuseColor.rgb *= 1. - wetF * .28;
#endif`
            ) // glazed ice is glossy
            .replace(
                "#include <color_fragment>",
                `#include <color_fragment>
#ifdef GPU_H
{
  float vis = min(uFade, 1. - smoothstep(${chunkFade()[0].toFixed(1)}, ${chunkFade()[1].toFixed(1)}, distance(normalize(vWp), normalize(cameraPosition)) * uR));
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
${
    cut
        ? `if (uOn > .5) {
  float dn = dot(vWp, uN);
  if (dn > 0.) {
    float a = dot(vWp, uU) / dn * uR / 1.5;
    float b = dot(vWp, uV) / dn * uR / 1.5;
    if (a > uRect.x && a < uRect.y && b > uRect.z && b < uRect.w) discard;
  }
}`
        : ""
}
// world-space geometric normal from screen derivatives of vWp, oriented away from the planet centre (used by snowfall
// and puddles to find up-facing / flat ground). Needs only vWp, which this shader declares itself.
vec3 geoN = normalize(cross(dFdx(vWp), dFdy(vWp)));
if (dot(geoN, vWp) < 0.) geoN = -geoN;
// SNOWFALL (all tiers): while it snows, a white cover spreads below the snowline on upward-facing ground. The biome
// colour is baked at build time, so this is a live overlay; applied before snowF, so the existing snow sparkle, glow
// and footprints pick it up automatically.
if (uSnowFall > .01) {
  vec3  sfD = normalize(vWp);
  float sfT = 1. - 1.1 * sfD.y * sfD.y - 1.2 * max((length(vWp) - uR) / uAmp, 0.);
  float sfC = (1. - smoothstep(uSnow + uSnowFall * .28 - .04, uSnow + uSnowFall * .28 + .06, sfT))
            * smoothstep(.55, .85, dot(geoN, sfD))
            * uSnowFall * (.75 + .25 * vn(vWp * .35));
  diffuseColor.rgb = mix(diffuseColor.rgb, uCw, clamp(sfC, 0., 1.));
}
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
#ifdef WET
// CAUSTICS (medium/high): sunlight focused by surface ripples dances on the shallow seabed (0.4–5 m deep), seen
// through the part-transparent shallows. Two drifting cell-noise layers; their min sharpens into bright webs.
{
  float cdep = uR - length(vWp);
  if (cdep > .4 && cdep < 5. && uDayF > .05) {
    // finer cells, and the two layers multiplied (not min'd) so only their crossings glint: min() traced long,
    // near-continuous white bands across whole sandbanks
    vec3  cq  = vWp * 1.1;
    float c1  = 1. - clamp(abs(vn(cq + vec3(uTime * .35, 0., uTime * .21)) - .5) * 7., 0., 1.);
    float c2  = 1. - clamp(abs(vn(cq * 1.37 + vec3(-uTime * .27, 1.7, uTime * .31)) - .5) * 7., 0., 1.);
    float web = pow(c1 * c2, 3.);
    float fall = smoothstep(.4, 1., cdep) * (1. - smoothstep(2.5, 5., cdep)) * (1. - smoothstep(30., 70., length(vViewPosition)));
    diffuseColor.rgb += uSky * web * fall * uDayF * .22; // sky-lit (follows time of day), faint
  }
}
// PUDDLES (medium/high): after rain, flat low dips (noise-shaped, gentle slopes, not sand / snow) hold water that
// mirrors the sky. Darkens and smooths here; the roughness and normal blocks below make them glossy and flat.
{
  float pFlat = smoothstep(.93, .985, dot(geoN, normalize(vWp)));
  float pDip  = smoothstep(.56, .66, vn(vWp * .16) * .7 + vn(vWp * .41 + vec3(2.3, 0., 5.1)) * .3);
  puddle = uWet * pFlat * pDip * (1. - smoothstep(.68, .8, min(vC.r, min(vC.g, vC.b))))
         * step(.4, length(vWp) - uR) * (1. - smoothstep(60., 140., length(vViewPosition)));
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * .45 + uSky * .35 * (.4 + .6 * uDayF), puddle * .85);
}
#endif
float dune = 0.;
#ifdef DUNES
// High tier: wind ripples on sand. (uCs = palette sand colour, from T.) Pixels close to the palette's sand colour, within 120 m, get long parallel ridges
// (fixed world wind direction, warped by noise so they meander and fork). Mostly lighting: fed to the bump below.
{
  float sandF = (1. - smoothstep(.06, .16, distance(diffuseColor.rgb, uCs))) * (1. - smoothstep(60., 120., dd)) * (1. - snowF);
  if (sandF > .01) {
    vec3 wdir = normalize(vec3(.83, .21, .52));
    float warp = vn(vWp * .09) * 9. + vn(vWp * .31) * 2.;
    float ph = dot(vWp, wdir) * 2.3 + warp;
    dune = (pow(abs(sin(ph)), 3.) - .35) * sandF;  // sharp crests, soft troughs
  }
}
#endif
diffuseColor.rgb *= .78 + .45 * gn + dune * .08;
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
#ifdef WET
  // swash: each breaking wave (same surfPhase as the water) runs up the beach and drains back. The wet sand behind
  // its edge is darker and glossier (fed to the roughness below), and the leading edge carries a thin foam line.
  float sp    = surfPhase(vWp, 0., uTime);
  float run   = .25 + .35 * (.5 + .5 * sin(sp)) * (.7 + .3 * min(uWind, 1.5)); // how far up (m) this wave reaches
  float wetB  = (1. - smoothstep(run - .08, run + .12, hh)) * smoothstep(-.6, -.1, hh);
  diffuseColor.rgb *= 1. - wetB * .32;
  swashWet = wetB;
  float fo = smoothstep(.09, 0., abs(hh - run)) * smoothstep(-.2, .05, hh)
           * (.55 + .45 * vn(vWp * 3.4 + uTime * .3));
#else
  float fo = smoothstep(.45, 0., abs(hh - .1 - .3 * sin(uTime * .8 + vn(vWp * .4) * 6.)))
           * smoothstep(-.9, -.2, hh) * (1. - smoothstep(.3, .9, hh));
  fo *= .5 + .5 * vn(vWp * 3. + uTime * .3);
#endif
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.95), fo * .85);
}
float fp = 0.;
// fp is multiplied by snowF below, so skip the 48-footprint loop off snow (it ran for every pixel within 26 m —
// the busiest pixels on screen — on grass, rock and sand too, where it always contributed 0)
if (snowF > 0. && distance(vWp, uPl) < 26.) {
  for (int i = 0; i < 48; i++)
    fp = max(fp, smoothstep(.38, .12, distance(vWp, uFoot[i].xyz)) * uFoot[i].w);
}
fp *= snowF;
diffuseColor.rgb *= 1. - .4 * fp;
gn -= fp * .9;`
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
         - .06 * (1. - smoothstep(60., 160., dd)) * sign(det) * (dFdx(gn + dune * .9) * r1 + dFdy(gn + dune * .9) * r2));
}`
            )
            .replace(
                "#include <emissivemap_fragment>",
                `#include <emissivemap_fragment>
if (snowF > .05 && uDayF > .05) {
  vec3  sv      = normalize((viewMatrix * vec4(uSun, 0.)).xyz);
  float facing  = clamp(dot(normal, sv), 0., 1.);
  // broad diffuse glow — sun-lit snow radiates blue-white fill light
  totalEmissiveRadiance += vec3(.82, .88, 1.) * snowF * facing * .3 * uDayF;
  // soft specular glint for the reflective sheen
  vec3  eyeDir  = normalize(vViewPosition);
  vec3  halfV   = normalize(sv + eyeDir);
  float spec    = pow(max(dot(normal, halfV), 0.), 12.) * facing;
  totalEmissiveRadiance += vec3(.92, .96, 1.) * spec * snowF * .55 * uDayF;
}`
            );
    };
    return m;
}
export function wind<T extends THREE.Material>(m: T, k: number): T {
    m.onBeforeCompile = (s) => {
        bind(s, ["uTime", "uWind"]);
        s.vertexShader = s.vertexShader
            .replace("#include <common>", "#include <common>\nuniform float uTime,uWind;")
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
// whole-tree bend, growing with height² so the trunk base stays planted and the crown leans most
// (~8–10 cm at a 10 m crown in normal wind; it used to be linear and ~2 cm, too small to read)
float _h   = max(lp.y, 0.0);
float _bend = _amt * _h * (1. + _h * .35);
lp.x      += _bx * _bend;
lp.z      += _bz * _bend;
#ifdef CANOPY_SWAY
// canopy rustle: every foliage vertex (aLeaf ≥ 1: blobs, cones, fronds, leaves) drifts a little out of step with its
// neighbours (phase from its own position), so the crown churns instead of moving as one rigid block. Grows with
// height in the crown and with wind; bark (aLeaf = 0) never moves. One sin per vertex, near tiers only.
if (aLeaf > .5) {
  float rs = (.035 + .06 * min(uWind, 2.)) * min(_h * .12, 1.);
  float ru = sin(uTime * 2.1 + dot(position, vec3(.9, .6, .7)) + _ph);
  lp += vec3(ru, ru * .3, -ru * .7) * rs;
}
#endif
#ifdef LEAF_FLUTTER
// polygonal leaf blades (aLeaf 1 at the stem → 2 at the tip) flicker about their stem: fast, small, out of step with
// their neighbours (phase from the vertex position), stronger in a strong wind. Bark and canopy blobs have aLeaf ≤ 1.
if (aLeaf > 1.001 && aLeaf < 2.) {
  float fl = (aLeaf - 1.) * (.05 + .07 * min(uWind, 2.)) * sin(uTime * 7.3 + dot(position, vec3(3.1, 1.7, 2.3)) + _ph);
  lp += vec3(fl, fl * .6, -fl * .8);
}
#endif
#ifdef FROND_SWAY
// palm fronds (aLeaf 2 at the base → 3 at the tip): slow vertical bob growing toward the tip (squared, so the frond
// bends rather than tilting rigidly), plus a little twist; each frond out of step via its azimuth around the crown
if (aLeaf >= 2.) {
  float fw = aLeaf - 2.;
  float az = atan(position.z, position.x);
  float bob = fw * fw * (.12 + .22 * min(uWind, 2.)) * sin(uTime * 2.3 + az * 3. + _ph);
  lp.y += bob;
  lp.xz += vec2(-sin(az), cos(az)) * bob * .35;
}
#endif
vec3 transformed = lp;
`
            );
    };
    return m;
}
// Water: five travelling wave trains (analytic normals, wind-scaled, small trains fade with distance), whitecap foam on crests, sky Fresnel.
export function waterFx(m: THREE.MeshStandardMaterial) {
    // GLITTER + WAVE_SSS: high · SURF (sharp crests, breaking shore waves): medium and high · low: unchanged shader
    (m as any).defines = {
        ...(gpuTier === "high" ? { GLITTER: "", WAVE_SSS: "" } : {}),
        ...(gpuTier !== "low" ? { SURF: "" } : {}),
        ...(WATER_DEBUG ? { WATER_DEBUG: String(WATER_DEBUG) } : {}),
    };
    m.onBeforeCompile = (s) => {
        bind(s, ["uTime", "uWind", "uSky", "uSun", "uDayF", "uCubeC", "uAtOn", "uN3", "uWater"]);
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
`
        );
        s.fragmentShader = s.fragmentShader
            .replace(
                "#include <common>",
                "#include <common>\nvarying vec3 vWp;uniform float uTime,uWind,uDayF,uAtOn,uAmp;uniform vec3 uSky,uSun,uWater;uniform samplerCube uCubeC;float waterKeep = 0.;vec3 dbgSurface = vec3(0.);\n" +
                    NOISE +
                    SURF_GLSL +
                    WATER_GRADE_GLSL
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

#ifdef SURF
  // sharper crests: steepen the normal where the summed crest field is high and flatten it in the troughs, giving a
  // pointed-crest / round-trough profile (as real deep-water waves have) instead of soft sine swell
  g *= 1. + .55 * smoothstep(-.2, .9, cr) - .25 * smoothstep(.2, -.7, cr);
#endif
  // project gradient onto sphere surface → perturb normal
  g *= .35 * A;
  g -= nW * dot(g, nW);
  normal = normalize((viewMatrix * vec4(normalize(nW - g), 0.)).xyz);

  // whitecap foam on crests
  float crest = smoothstep(.55, 1.1, cr + (vn(w * .8 + t * .2) * .25
              + vn(w * 1.37 + t * .15 + vec3(5.7, 0., 2.3)) * .17) - .1)
              * smoothstep(.2, 1., uWind);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.92, .96, 1.), crest * .8);
  waterKeep = max(waterKeep, crest);
  diffuseColor.a   = mix(diffuseColor.a,   1.,                 crest);

  // depth-based water colour and shore foam (needs atlas depth channel)
  if (uAtOn > .5) {
    float dep = max(-texture(uCubeC, normalize(vWp)).a * uAmp, 0.);
    float sh  = 1. - smoothstep(0., 7., dep);
    float dp  = smoothstep(2., 45., dep);
    // palette water colour in the shallows → a darker, more saturated shade of it in the depths (Earth: rich blue →
    // deep ultramarine; other planets get their own water hue)
    vec3  wc  = mix(uWater, uWater * ${WATER_DEEP}, dp);
    // gentle large-scale variation: patches a little darker / richer, in the water's own hue (no hue shift)
    wc *= mix(1., .82, vn(vWp * .018) * .6 + vn(vWp * .031 + vec3(3.3, 0., 1.7)) * .4);
    // lit compensation: the sun (intensity 3) and the ACES curve brighten and desaturate the paint colour, so the sea's
    // surface takes ~78 % of it to land on the palette blue as seen. Ocean only: the map draws uWater unlit and is unchanged.
    diffuseColor.rgb = mix(diffuseColor.rgb, wc * .78,  .9);
    // shallows let a little seabed through (was 28 % opaque: sand under blue read as pale teal); open sea is opaque
    diffuseColor.a   = mix(mix(diffuseColor.a, .95, dp), .62, sh * (1. - crest));
#ifdef SURF
    // breaking waves: crests run shoreward through the shallows (< ~4 m), sharpening into a narrow foam front that
    // leaves a fading foam wake behind it; broken up by noise so the line frays like real surf
    float ph   = surfPhase(vWp, dep, uTime);
    float wv   = fract(ph / 6.2832);                                  // 0 → 1 across one wave period
    float zone = (1. - smoothstep(.3, 4., dep)) * smoothstep(.0, .25, dep);
    float front = smoothstep(.86, .97, wv) * (1. - smoothstep(.97, 1., wv)); // the breaking crest
    float wake  = (1. - smoothstep(.0, .35, wv)) * .55;                     // foam left behind as it passes
    float fray  = smoothstep(.25, .7, vn(vWp * 1.9 + vec3(uTime * .4, 0., 0.)) * .65 + vn(vWp * 4.3) * .35);
    float shore = clamp((front + wake) * zone * (.45 + .55 * fray) * (.6 + .4 * min(uWind, 1.5)), 0., 1.);
    // the very edge (< 0.3 m) is always a thin lapping foam line
    shore = max(shore, (1. - smoothstep(0., .3, dep)) * (.5 + .5 * sin(uTime * 2.2 + vn(vWp * .8) * 8.)) * .7);
#else
    float shore = clamp((1. - smoothstep(0., 1.1, dep))
                * (.55 + .45 * sin(dep * 7. - uTime * 1.6
                   + (vn(vWp * .6) * .62 + vn(vWp * 1.09 + vec3(7.3, 0., 2.1)) * .38) * 5.)),
                  0., 1.);
#endif
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.95, .98, 1.), shore * .6);
    waterKeep = max(waterKeep, shore);
    diffuseColor.a   = mix(diffuseColor.a,   .9,                 shore * .6);
  }

  // icy tint near poles — abs(nW.y) ≈ 1 at poles, 0 at equator. Starts ~50° latitude (was ~27°, which paled most oceans).
  float icy = smoothstep(0.75, 0.92, abs(nW.y));
  // ice: a pale version of the palette water colour (was a fixed cyan, which ignored the palette and read teal)
  diffuseColor.rgb = mix(diffuseColor.rgb, mix(uWater, vec3(.85), .7), icy * .65);
  waterKeep = max(waterKeep, icy);
  diffuseColor.a   = mix(diffuseColor.a,   .9,                   icy * .55);

  // sky Fresnel
  float fr = pow(1. - clamp(dot(normal, normalize(vViewPosition)), 0., 1.), 4.);
  // sky reflection at grazing angles, tinted by the water's own hue so a pale sky doesn't wash the sea out
  vec3 tintW = uWater / max(max(uWater.r, uWater.g), max(uWater.b, 1e-3)); // palette hue, normalised to max 1
  diffuseColor.rgb = mix(diffuseColor.rgb, uSky * mix(vec3(1.), tintW, .6) * (.45 + .4 * uDayF), fr * .35);
  dbgSurface = diffuseColor.rgb;
}`
            )
            .replace(
                "#include <fog_fragment>",
                `#ifdef USE_FOG
  {
    // water takes half the scene fog: a dark sea loses its colour in mist far faster than lighter land
    float fd = fogDensity * .5;
    float fogFactor = 1.0 - exp(- fd * fd * vFogDepth * vFogDepth);
    gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, fogFactor);
  }
#endif
// the scene renders into PostFX's linear, non-tone-mapped target (Three tone-maps / converts only when drawing to the
// screen), so this colour is linear: grade against linear uWater. A display-space target greyed it further.
gl_FragColor.rgb = waterGrade(gl_FragColor.rgb, uWater, waterKeep);
#if defined(WATER_DEBUG) && WATER_DEBUG == 1
gl_FragColor = vec4(1., 0., 1., 1.);
#elif defined(WATER_DEBUG) && WATER_DEBUG == 2
gl_FragColor.a = 1.;
#elif defined(WATER_DEBUG) && WATER_DEBUG == 3
gl_FragColor = vec4(dbgSurface, 1.);
#elif defined(WATER_DEBUG) && WATER_DEBUG == 5
gl_FragColor = vec4(uAtOn > .5 ? vec3(0., 1., 0.) : vec3(1., 0., 0.), 1.);
#endif`
            )
            .replace(
                "#include <emissivemap_fragment>",
                `#include <emissivemap_fragment>
#ifdef GLITTER
// high tier: sun glitter — a very tight highlight on the detailed wave normal, emitted in HDR so bloom turns the
// brightest facets into sparkles. Fades with distance (normal detail is gone past ~260 m) and with low sun.
{
  vec3  sv = normalize((viewMatrix * vec4(uSun, 0.)).xyz);
  vec3  hv = normalize(sv + normalize(vViewPosition));
  float sp = pow(max(dot(normal, hv), 0.), 900.);
  float up = smoothstep(-.02, .12, dot(normalize(vWp), uSun));
  totalEmissiveRadiance += vec3(1., .93, .8) * sp * 14. * up * uDayF * (1. - smoothstep(80., 400., length(vViewPosition)));
  waterKeep = max(waterKeep, clamp(sp * 6., 0., 1.)); // glitter sparkles stay white
  // MOON GLITTER: the moon sits opposite the sun here (sky.ts), so its glint is the same highlight on -uSun, cool and
  // dimmer, at night only
  vec3  mv = -sv;
  vec3  hm = normalize(mv + normalize(vViewPosition));
  float mp = pow(max(dot(normal, hm), 0.), 700.);
  float mu = smoothstep(-.02, .12, dot(normalize(vWp), -uSun));
  totalEmissiveRadiance += vec3(.72, .8, 1.) * mp * 4.5 * mu * (1. - uDayF) * (1. - smoothstep(80., 400., length(vViewPosition)));
}
#endif
#ifdef WAVE_SSS
// high tier: light through the wave crests. Looking toward a low sun, the thin tops of the swell glow with a lighter,
// more saturated tint of the palette water colour (as sunlit wave crests do), strongest at grazing view angles.
{
  vec3  sv   = normalize((viewMatrix * vec4(uSun, 0.)).xyz);
  float back = pow(clamp(dot(-normalize(vViewPosition), sv), 0., 1.), 4.);
  float lowS = 1. - smoothstep(.15, .55, dot(normalize(vWp), uSun));
  float thin = smoothstep(.0, .6, 1. - abs(normal.z));                 // tilted facets = wave flanks
  totalEmissiveRadiance += min(uWater * 3.5 + vec3(.0, .04, .05), vec3(1.)) * back * lowS * thin * .35 * uDayF
                         * (1. - smoothstep(60., 300., length(vViewPosition)));
}
#endif`
            );
    };
}
