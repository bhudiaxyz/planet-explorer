import * as THREE from "three";
import type { Planet } from "./planet";
import { frame, smoothstep } from "./utilgeo";
import { gpuTier, plantRadiusMul } from "./gputier";
import { T, TERRAIN_GLSL } from "./terrain";
import { makeRT, draw, QUAD_VS, readRT } from "./bake";
import { U, TINT_GLSL, IGN } from "./fx";
import { CFG } from "./config";
import { PLANTS, type PlantSpec, type Tier, decideGLSL, lookGLSL } from "./plants";

// GPU ground cover. Layer = one plant type at one distance tier. Placement is decided in a bake pass (one texel per instance cell) that reruns only when the
// lattice centre moves; the per-frame vertex shader reads that texel, rebuilds orientation/scale/tint from hashes (catalog `look`), applies wind, lean, player
// push, and collapses rejected cells. Tier lifecycle: both outer and inner transitions use IGN screen-space dithering (no scale change, no growing/shrinking):
//   outer: vOuterF = 1 - smoothstep(TO_FULL, TO_GONE, dist)  — fragment discards if ign(coord)     > vOuterF  (plants fade in at full size from outer edge)
//   inner: vInnerF =     smoothstep(TI_GONE, TI_FULL, dist)  — fragment discards if ign(coord+off) > vInnerF  (plants fade out at full size when finer tier takes over)
// The two noise offsets are uncorrelated so inner and outer stipples don't align.
const DECIDE = decideGLSL();
const BEGIN = `
bool kill = dot(aCell, aCell) > uK * uK;
vec3  gP   = vec3(0.), gN = vec3(0., 1., 0.), tint = vec3(1.);
vOuterF = 1.;
vInnerF = 1.;
{
  vec4  Dv = texelFetch(uP, ivec2(aCell + uK + .5), 0);
  float D  = Dv.x;
  kill = kill || D < -5000.;
  if (!kill) {
    float I  = uSC.x + aCell.x, J = uSC.y + aCell.y, F = uSC.z;
    float h1 = hs(I, J, F), h2 = hs(I, J, F + 9.), h3 = hs(I, J, F + 17.), h7 = hs(I, J, F + 23.);
    vec3  nA, uu, vv;
    basis(F, nA, uu, vv);
    vec3  d  = normalize(nA * uR + uu * (I + h1 - .5) * CELLSZ + vv * (J + h2 - .5) * CELLSZ);
    vec3  sc = vec3(1.);
${lookGLSL()}
    float dist = length(d * (uR + D) - cameraPosition);
    vOuterF = 1. - smoothstep(TO_FULL, TO_GONE, dist);
    vOuterF = min(vOuterF, smoothstep(uK * CELLSZ, uK * CELLSZ - 8., length(aCell) * CELLSZ));
    if (vOuterF <= 0.) kill = true;
    vInnerF = smoothstep(TI_GONE, TI_FULL, dist);
    if (vInnerF <= 0.) kill = true;
    sc *= vec3(SCW, SCH, SCW) * uVeg;
    vec3  t1 = normalize(cross(d, abs(d.y) < .99 ? vec3(0., 1., 0.) : vec3(1., 0., 0.)));
    vec3  t2 = cross(d, t1);
    float ca = cos(h3 * 6.283), sa = sin(h3 * 6.283);
    vec3  ax = t1 * ca + t2 * sa, az = cross(ax, d);
#if DISP
    vec3 pp = position + normal * (hs(position.x * 9. + I, position.y * 9. + J, position.z * 9. + F) - .5) * .22;
#else
    vec3 pp = position;
#endif
    vec3  u2 = normalize(d + (ax * (h1 - .5) + az * (h2 - .5)) * LEAN);
    vec3  lp = pp * sc;
    float y    = max(lp.y, 0.),
          a    = uWind * WK * y * y,
          ph   = I * .11 + J * .13;
    vec2  wDir = normalize(uSun.xz + vec2(0.001));
    float wave = sin(uTime * 1.8 + dot(vec2(ax.x, az.x) * 4.0, wDir) + ph * .5)
               * uWind * WK * y * y * 0.7 * uSway;
    gP = d * (uR + D - .03) + ax * lp.x + u2 * lp.y + az * lp.z
       + (ax * sin(uTime * 1.6 + ph + y * .3) + az * cos(uTime * 1.3 + ph * 1.3 + y * .2)) * a
       + (ax * wDir.x + az * wDir.y) * wave;
#if PUSH
    {
      vec3  tp = d * (uR + D) - uPl;
      vec3  pr = tp - d * dot(tp, d);
      float pu = 1. - smoothstep(.3, 1.5, length(tp));
      gP += normalize(pr + d * .001) * pu * y * .5 - d * pu * lp.y * .3;
    }
#endif
    gN = normalize(ax * normal.x + u2 * normal.y + az * normal.z);
#if MOSS
    tint = mix(tint, vec3(.32, .77, .25), smoothstep(.6, .95, clamp(dot(gN, d), 0., 1.)) * step(.55, h1) * .7);
#endif
  }
}
vec3 objectNormal = gN;
#ifdef USE_COLOR
vColor.rgb *= tint;
#endif`;

class Layer {
  uSC = { value: new THREE.Vector3() };
  mesh: THREE.Mesh;
  rt: THREE.WebGLRenderTarget;
  bake: THREE.ShaderMaterial;
  readonly kind: number;
  readonly cell: number;
  readonly K: number;
  readonly near: boolean;
  scratchFrame = frame(new THREE.Vector3(0, 1, 0), 1, 1);
  lastFace = -1;
  lastCellI = 0;
  lastCellJ = 0; // last baked lattice (face, i, j)
  collide = false;
  pix: Float32Array | null = null;
  psnap: { cellI: number; cellJ: number; faceCode: number } | null = null;
  onData?: () => void;
  private seq = 0;
  private acc = 0;
  constructor(spec: PlantSpec, tier: Tier) {
    this.kind = spec.kind;
    this.cell = tier.cell;
    this.K = Math.ceil(tier.K * plantRadiusMul());
    this.near = tier.near;
    const geo = tier.geo(),
      K = this.K,
      n = 2 * K + 1;
    const g = new THREE.InstancedBufferGeometry();
    if (geo.index) g.setIndex(geo.index);
    for (const k in geo.attributes) g.setAttribute(k, geo.attributes[k]);
    const cells: number[] = [];
    for (let y = -K; y <= K; y++)
      for (let x = -K; x <= K; x++) if (x * x + y * y <= K * K) cells.push(x, y); // only cells inside the disc are instanced
    g.setAttribute("aCell", new THREE.InstancedBufferAttribute(new Float32Array(cells), 2));
    g.instanceCount = cells.length / 2;
    // Scale LOD distances with the disc radius so the fade band always fits inside the disc.
    // Without this, a 0.8× disc on medium GPU ends at ~128 m while outerGone stays at 152 m,
    // creating a dead zone that causes a visible edge-pop.
    const lodMul = plantRadiusMul();
    const [outerFull, outerGone, innerGone, innerFull] = tier.lod.map((v) => v * lodMul),
      f = (v: number) => v.toFixed(2);
    const defines = {
      KIND: spec.kind,
      PMUL: tier.pmul.toFixed(1),
      CELLSZ: f(tier.cell),
      WK: spec.wind.toFixed(3),
      TSN: spec.hardy ? ".02" : ".14",
      TO_FULL: outerFull.toFixed(1),
      TO_GONE: outerGone.toFixed(1),
      TI_GONE: innerGone.toFixed(1),
      TI_FULL: innerFull.toFixed(1),
      SCW: f(tier.sw),
      SCH: f(tier.sh),
      LEAN: f(spec.lean),
      DISP: spec.disp ? 1 : 0,
      PUSH: spec.push ? 1 : 0,
      MOSS: spec.moss ? 1 : 0,
    };
    this.rt = makeRT(n, n);
    const uK = { value: K };
    this.bake = new THREE.ShaderMaterial({
      defines,
      uniforms: { ...T, uSC: this.uSC, uK },
      vertexShader: QUAD_VS,
      fragmentShader: `
uniform vec3 uSC;
uniform float uK;
${TERRAIN_GLSL}
${DECIDE}

void main() {
  vec2 L = floor(gl_FragCoord.xy) - vec2(uK);
  gl_FragColor = decide(uSC.x + L.x, uSC.y + L.y, uSC.z);
}`,
    });
    const m = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 1,
      side: spec.dbl ? THREE.DoubleSide : THREE.FrontSide,
    });
    (m as any).defines = defines;
    m.onBeforeCompile = (shaderParams) => {
      Object.assign(shaderParams.uniforms, T, {
        uTime: U.uTime,
        uWind: U.uWind,
        uSway: U.uSway,
        uVeg: U.uVeg,
        uPl: U.uPl,
        uSun: U.uSun,
        uDayF: U.uDayF,
        uSC: this.uSC,
        uK,
        uP: { value: this.rt.texture },
      });
      shaderParams.vertexShader = shaderParams.vertexShader
        .replace(
          "#include <common>",
          `#include <common>\nattribute vec2 aCell;uniform vec3 uSC,uPl,uSun;uniform float uK,uTime,uWind,uSway,uVeg;uniform sampler2D uP;varying float vOuterF,vInnerF;\n${TERRAIN_GLSL}`
        )
        .replace("#include <beginnormal_vertex>", BEGIN)
        .replace("#include <begin_vertex>", "vec3 transformed=gP;")
        .replace(
          "#include <project_vertex>",
          "#include <project_vertex>\nif(kill)gl_Position=vec4(2.,2.,2.,1.);"
        );
      shaderParams.fragmentShader = shaderParams.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>\nuniform vec3 uSun;uniform float uDayF;varying float vOuterF,vInnerF;\n${IGN}`
        )
        .replace(
          "#include <alphatest_fragment>",
          "#include <alphatest_fragment>\nif(vOuterF<1.&&ign(gl_FragCoord.xy)>vOuterF)discard;\nif(vInnerF<1.&&ign(gl_FragCoord.xy+vec2(17.,31.))>vInnerF)discard;"
        )
        .replace(
          "#include <emissivemap_fragment>",
          `#include <emissivemap_fragment>\n{vec3 sv=normalize((viewMatrix*vec4(uSun,0.)).xyz);float tr=pow(clamp(dot(-normalize(vViewPosition),sv),0.,1.),3.)*uDayF;totalEmissiveRadiance+=diffuseColor.rgb*tr*${spec.kind === 0 ? ".9" : ".3"};}\n${TINT_GLSL}`
        );
    };
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = spec.kind === 0; // only large-form plants cast shadows
  }
  /** Rebakes placement when the lattice centre moved. Returns true if a bake happened (so the caller can budget bakes per frame). */
  update(playerDirection: THREE.Vector3, planetRadius: number, allowBake = true): boolean {
    const fr = frame(playerDirection, planetRadius, this.cell, this.scratchFrame);
    if (fr.face === this.lastFace && fr.cellI === this.lastCellI && fr.cellJ === this.lastCellJ)
      return false;
    if (!allowBake) return false;
    this.lastFace = fr.face;
    this.lastCellI = fr.cellI;
    this.lastCellJ = fr.cellJ;
    const faceCode = fr.face * 2 + (fr.normal.getComponent(fr.face) < 0 ? 1 : 0);
    this.uSC.value.set(fr.cellI, fr.cellJ, faceCode);
    draw(this.rt, this.bake);
    if (this.collide) {
      // tiny async read-back so the CPU collider sees exactly the plants the shader draws
      const bakeSnapshot = {
          cellI: fr.cellI,
          cellJ: fr.cellJ,
          faceCode,
        },
        sequenceId = ++this.seq,
        n = 2 * this.K + 1;
      readRT(this.rt, n, n, (a) => {
        if (sequenceId < this.acc) return;
        this.acc = sequenceId;
        this.pix = a;
        this.psnap = bakeSnapshot;
        this.onData?.();
      });
    }
    return true;
  }
}

export class Scatter {
  group = new THREE.Group();
  dirty = true;
  version = 0;
  layers: Layer[] = [];
  private roundRobinIndex = 0;
  constructor(private pl: Planet) {
    for (const spec of PLANTS)
      for (const tier of spec.tiers) {
        if (tier.far && gpuTier !== "high") continue; // far tiers: high GPU only
        if (!tier.near && gpuTier === "low") continue; // mid tiers: medium+ only
        const l = new Layer(spec, tier);
        if (spec.collide && tier.near) {
          l.collide = true;
          l.onData = () => this.version++;
        }
        this.layers.push(l);
        this.group.add(l.mesh);
      }
  }
  /** Invalidate all layer placement caches — call when palette changes to rebake vertex colours. */
  rebuild() {
    this.dirty = true;
  }
  update(playerDirection: THREE.Vector3, alt: number, dt = 0.016) {
    U.uVeg.value = 1 - smoothstep(CFG.vegetation.altFadeStart, CFG.vegetation.altFadeEnd, alt);
    this.group.visible = alt < CFG.vegetation.altCullAbove;
    let budget =
      gpuTier === "low"
        ? Math.max(2, Math.round(2 * dt * 60))
        : Math.max(2, Math.round(4 * dt * 60));
    if (this.dirty) {
      this.layers.forEach((l) => (l.lastFace = -1));
      this.dirty = false;
      budget = gpuTier === "low" ? 14 : gpuTier === "medium" ? 20 : this.layers.length;
    }
    if (alt >= 255) return;
    const n = this.layers.length;
    const s = this.roundRobinIndex;
    this.roundRobinIndex = (s + 1) % n; // at most 4 placement bakes per frame, round-robin
    for (let i = 0; i < n; i++)
      if (this.layers[(s + i) % n].update(playerDirection, this.pl.radius, budget > 0)) budget--;
  }
}
