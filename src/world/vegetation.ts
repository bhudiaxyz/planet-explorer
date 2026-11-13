import * as THREE from "three";
import type { Planet } from "./planet";
import { frame, smoothstep } from "../core/utilgeo";
import { gpuTier, plantRadiusMul } from "../render/gputier";
import { T, TERRAIN_GLSL, HELPERS_GLSL } from "../render/terrain";
import { makeRT, draw, QUAD_VS, readRT } from "../render/bake";
import { U, TINT_GLSL, IGN } from "../render/fx";
import { CFG } from "../core/config";
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
float snV = 0., gust = 0.;
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
    // GUSTS (all tiers): broad bands of stronger wind sweep across the ground along the wind direction; plants inside
    // a band lean further (gust is shared with the grass look snippet, which brightens them as their blades tilt to the sun)
    float gustP = dot(vec2(dot(d, t1), dot(d, t2)), wDir) * uR * .055 - uTime * 1.4;
    gust = smoothstep(.55, 1., sin(gustP) * .5 + .5 + (hs(floor(gustP / 6.283), F, 3.) - .5) * .6) * min(uWind, 2.);
    wave += gust * WK * y * y * .9 * uSway;
#if RUSTLE
    // medium/large plants (shrubs, scrub): foliage churns a little per vertex on top of the whole-plant sway, growing
    // toward the top. One sin per vertex; only kinds with RUSTLE (wind > 0, not grass/reeds, which already wave).
    {
      float rr = sin(uTime * 2.6 + dot(pp, vec3(4.1, 2.3, 3.7)) + ph * 3.) * min(y * .5, 1.) * WK * uWind * .5 * uSway;
      lp += vec3(rr, rr * .3, -rr * .8) * .25;
    }
#endif
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
#if STONE > 0
    {
      // per-vertex shade variety on top of the kind's tint. Model-space position (pp) so the pattern rides with the
      // instance; h1 / h2 seed it per instance, so neighbours sharing a mesh still differ. Sum-of-sines patches: no
      // texture and no noise library in this shader.
      vec3  sq = pp * 1.7 + vec3(h1 * 37., h2 * 23., h1 * 11. + h2 * 7.);
      float sa = sin(sq.x * 1.3 + sin(sq.y * 1.9 + sq.z)) * sin(sq.z * 1.1 + sin(sq.x * .8));
      float sb = sin(sq.y * 2.3 + sq.x * .7) * .5 + .5;
      float up = clamp(normal.y * .5 + .5, 0., 1.);
#if STONE == 1
      // rocks: mineral banding (layered along local height) and mottled patches, warmer ↔ cooler, lighter ↔ darker;
      // up-facing tops bleached by sun and rain, the base darkened by soil and damp
      float band = sin(pp.y * 7. + sa * 1.6 + h2 * 6.283) * .5 + .5;
      tint *= mix(vec3(1.08, 1.02, .9), vec3(.9, .96, 1.08), sb) * (.8 + .32 * band) * (.88 + .18 * (sa * .5 + .5));
      tint *= mix(.82, 1.1, up) * (.78 + .22 * smoothstep(-.05, .45, pp.y));
#else
      // shrubs / small plants: gentle yellow-green ↔ blue-green patches, lighter tops, darker shaded base
      tint *= mix(vec3(1.06, 1.04, .88), vec3(.92, 1., 1.08), sb) * (.88 + .2 * (sa * .5 + .5));
      tint *= mix(.86, 1.08, up) * (.8 + .2 * smoothstep(0., .6, pp.y));
#endif
    }
#endif
    // snow caps near the snowline on hardy kinds (rocks, scrub, cactus…): same climate test as terrain and trees,
    // upward-facing surfaces only. Applied after the vertex colour below, as a blend toward the palette snow colour.
    snV = (1. - smoothstep(uSnow + uSnowFall * .28 - .02, uSnow + uSnowFall * .28 + .16, 1. - 1.1 * d.y * d.y - 1.2 * max(D / uAmp, 0.)))
        * smoothstep(.35, .8, dot(gN, d)) * TSNOW * .85;
  }
}
vec3 objectNormal = gN;
#ifdef USE_COLOR
vColor.rgb *= tint;
vColor.rgb = mix(vColor.rgb, uCw * .95, snV);
#endif`;

const PLACEMENT_FS = `
uniform vec3 uSC;
uniform float uK;
${TERRAIN_GLSL}
${DECIDE}

void main() {
  vec2 L = floor(gl_FragCoord.xy) - vec2(uK);
  gl_FragColor = decide(uSC.x + L.x, uSC.y + L.y, uSC.z);
}`;
/** Placement bake material. No defines: every kind and tier shares one program (kind picked by uKind, see decideGLSL),
 *  so precompileBakes() can warm it with a throwaway instance before any Layer exists. */
export const placementBakeMaterial = (uniforms: Record<string, THREE.IUniform> = {}) =>
    new THREE.ShaderMaterial({ uniforms, vertexShader: QUAD_VS, fragmentShader: PLACEMENT_FS });

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
    // Sparse layers draw only accepted cells (see compact()); dense ones (grass, flowers…) draw the whole disc.
    readonly sparse: boolean;
    private fullCells: Float32Array;
    private fullCount: number;
    private cellAttr: THREE.InstancedBufferAttribute;
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
        for (let y = -K; y <= K; y++) for (let x = -K; x <= K; x++) if (x * x + y * y <= K * K) cells.push(x, y); // only cells inside the disc are instanced
        this.fullCells = new Float32Array(cells);
        this.fullCount = cells.length / 2;
        // the attribute buffer is sized for the full disc once; compact() rewrites a prefix and shrinks instanceCount
        this.cellAttr = new THREE.InstancedBufferAttribute(new Float32Array(cells), 2);
        this.cellAttr.setUsage(THREE.DynamicDrawUsage);
        g.setAttribute("aCell", this.cellAttr);
        g.instanceCount = this.fullCount;
        // Most kinds are <1% occupied, yet every disc cell ran the full mesh through the vertex shader before being
        // collapsed — ~60% of all scene vertices. Near tiers are compacted to accepted cells from the bake readback
        // (compact() keeps the full disc when it would not halve the draw). Grass is dense everywhere: no readback.
        this.sparse = tier.near && spec.kind !== 0;
        // Scale LOD distances with the disc radius so the fade band always fits inside the disc.
        // Without this, a 0.8× disc on medium GPU ends at ~128 m while outerGone stays at 152 m,
        // creating a dead zone that causes a visible edge-pop.
        const lodMul = plantRadiusMul();
        const [outerFull, outerGone, innerGone, innerFull] = tier.lod.map((v) => v * lodMul);
        // Only structural (#if) flags stay as defines — uniform tiers of the same KIND/DISP/PUSH/MOSS
        // share one compiled shader program instead of one per tier (~45 → ~15 unique programs).
        const defines = {
            KIND: spec.kind,
            DISP: spec.disp ? 1 : 0,
            PUSH: spec.push ? 1 : 0,
            MOSS: spec.moss ? 1 : 0,
            RUSTLE: spec.rustle ? 1 : 0,
            STONE: spec.shade,
        };
        const numUniforms = {
            PMUL: { value: tier.pmul },
            CELLSZ: { value: tier.cell },
            WK: { value: spec.wind },
            TSN: { value: spec.hardy ? 0.02 : 0.14 },
            TO_FULL: { value: outerFull },
            TO_GONE: { value: outerGone },
            TI_GONE: { value: innerGone },
            TI_FULL: { value: innerFull },
            SCW: { value: tier.sw },
            SCH: { value: tier.sh },
            LEAN: { value: spec.lean },
            TSNOW: { value: spec.hardy ? 1 : 0 },
        };
        this.rt = makeRT(n, n);
        const uK = { value: K };
        this.bake = placementBakeMaterial({
            ...T,
            uSC: this.uSC,
            uK,
            uKind: { value: spec.kind },
            ...numUniforms,
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
                uSnowFall: U.uSnowFall,
                uPl: U.uPl,
                uSun: U.uSun,
                uDayF: U.uDayF,
                uSC: this.uSC,
                uK,
                uP: { value: this.rt.texture },
                ...numUniforms,
            });
            shaderParams.vertexShader = shaderParams.vertexShader
                .replace(
                    "#include <common>",
                    `#include <common>\nattribute vec2 aCell;uniform vec3 uSC,uPl,uSun;uniform float uK,uTime,uWind,uSway,uVeg,CELLSZ,WK,TO_FULL,TO_GONE,TI_GONE,TI_FULL,SCW,SCH,LEAN,TSNOW,uAmp,uSnow,uSnowFall;uniform sampler2D uP;varying float vOuterF,vInnerF;\n${HELPERS_GLSL}`
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
        // Shadow casting needs a depth material running the same placement code, otherwise three's shared
        // depth material draws every instance untransformed (all piled at the planet centre: pure waste, no
        // visible shadow). Only solid, near-tier kinds cast — on high tier, where the shadow map is big
        // enough for them to read. Grass stays off: thousands of thin blades for a barely-visible stipple.
        this.mesh.castShadow = spec.collide && tier.near && gpuTier === "high";
        if (this.mesh.castShadow) {
            const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
            (depth as any).defines = defines;
            depth.onBeforeCompile = (s) => {
                Object.assign(s.uniforms, T, {
                    uTime: U.uTime,
                    uWind: U.uWind,
                    uSway: U.uSway,
                    uVeg: U.uVeg,
                    uSnowFall: U.uSnowFall,
                    uPl: U.uPl,
                    uSun: U.uSun,
                    uSC: this.uSC,
                    uK,
                    uP: { value: this.rt.texture },
                    ...numUniforms,
                });
                // depth.glsl only includes <beginnormal_vertex> under USE_DISPLACEMENTMAP, so the placement
                // block goes in at <begin_vertex>; `normal` is still a built-in attribute there.
                s.vertexShader = s.vertexShader
                    .replace(
                        "#include <common>",
                        `#include <common>\nattribute vec2 aCell;uniform vec3 uSC,uPl,uSun;uniform float uK,uTime,uWind,uSway,uVeg,CELLSZ,WK,TO_FULL,TO_GONE,TI_GONE,TI_FULL,SCW,SCH,LEAN,TSNOW,uAmp,uSnow,uSnowFall;uniform sampler2D uP;float vOuterF,vInnerF;\n${HELPERS_GLSL}`
                    )
                    .replace(
                        "#include <begin_vertex>",
                        BEGIN.replace("vec3 objectNormal = gN;", "") + "\nvec3 transformed=gP;"
                    )
                    .replace(
                        "#include <project_vertex>",
                        "#include <project_vertex>\nif(kill)gl_Position=vec4(2.,2.,2.,1.);"
                    );
            };
            this.mesh.customDepthMaterial = depth;
        }
    }
    /** Rebakes placement when the lattice centre moved. Returns true if a bake happened (so the caller can budget bakes per frame). */
    update(playerDirection: THREE.Vector3, planetRadius: number, allowBake = true): boolean {
        const fr = frame(playerDirection, planetRadius, this.cell, this.scratchFrame);
        if (fr.face === this.lastFace && fr.cellI === this.lastCellI && fr.cellJ === this.lastCellJ) return false;
        if (!allowBake) return false;
        this.lastFace = fr.face;
        this.lastCellI = fr.cellI;
        this.lastCellJ = fr.cellJ;
        const faceCode = fr.face * 2 + (fr.normal.getComponent(fr.face) < 0 ? 1 : 0);
        this.uSC.value.set(fr.cellI, fr.cellJ, faceCode);
        draw(this.rt, this.bake);
        // the compact list holds offsets for the *previous* lattice centre: draw the whole disc until this bake's readback
        // arrives (a frame or two), so cells never point at the wrong texels
        if (this.sparse) this.useFull();
        if (this.collide || this.sparse) {
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
                // only the newest bake's data matches the texture the shader is sampling now
                if (this.sparse && sequenceId === this.seq) this.compact(a);
                if (!this.collide) return;
                this.pix = a;
                this.psnap = bakeSnapshot;
                this.onData?.();
            });
        }
        return true;
    }
    private useFull() {
        if (
            this.mesh.geometry instanceof THREE.InstancedBufferGeometry &&
            this.mesh.geometry.instanceCount !== this.fullCount
        ) {
            (this.cellAttr.array as Float32Array).set(this.fullCells);
            this.cellAttr.clearUpdateRanges();
            this.cellAttr.needsUpdate = true;
            this.mesh.geometry.instanceCount = this.fullCount;
        }
    }
    /** Keep only disc cells the bake accepted (texel.x > -5000); same cells, same texels, so rendering is identical. */
    private compact(pix: Float32Array) {
        const K = this.K,
            n = 2 * K + 1,
            src = this.fullCells,
            dst = this.cellAttr.array as Float32Array;
        let w = 0;
        for (let i = 0; i < this.fullCount; i++) {
            const x = src[i * 2],
                y = src[i * 2 + 1];
            if (pix[((y + K) * n + (x + K)) * 4] > -5000) {
                dst[w * 2] = x;
                dst[w * 2 + 1] = y;
                w++;
            }
        }
        if (w * 2 > this.fullCount) {
            // dense patch (e.g. a reed bed): compaction would not halve the draw; restore the full list it overwrote
            dst.set(src);
            w = this.fullCount;
            this.cellAttr.clearUpdateRanges();
        } else {
            this.cellAttr.clearUpdateRanges();
            this.cellAttr.addUpdateRange(0, Math.max(2, w * 2));
        }
        this.cellAttr.needsUpdate = true;
        (this.mesh.geometry as THREE.InstancedBufferGeometry).instanceCount = w;
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
                // ponytail: plant collision stays off, as it has been since release (tier.near was never true for
                // collidable kinds, so this branch never ran). collision.ts fromLayer's shapes no longer match the
                // `look` scales (shrub 0.8+1.1·h2 vs drawn 0.45+1.4·h2; rocks ignore the per-axis h2/h7 factors), so
                // enabling it would add invisible walls. Re-enable by fixing fromLayer per kind, then dropping `false &&`.
                if (false && spec.collide && tier.near) {
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
    update(playerDirection: THREE.Vector3, alt: number) {
        U.uVeg.value = 1 - smoothstep(CFG.vegetation.altFadeStart, CFG.vegetation.altFadeEnd, alt);
        this.group.visible = alt < CFG.vegetation.altCullAbove;
        // P6: fixed per-tier budget avoids the inverse dt scaling where a struggling GPU (low fps)
        // gets a doubled budget and stresses itself further. The round-robin spreads bakes across frames.
        let budget = gpuTier === "low" ? 2 : gpuTier === "medium" ? 3 : 4;
        if (this.dirty) {
            this.layers.forEach((l) => (l.lastFace = -1));
            this.dirty = false;
            budget = gpuTier === "low" ? 14 : gpuTier === "medium" ? 20 : this.layers.length;
        }
        if (alt >= 255) return;
        const n = this.layers.length;
        const s = this.roundRobinIndex;
        for (let i = 0; i < n; i++)
            if (this.layers[(s + i) % n].update(playerDirection, this.pl.radius, budget > 0)) budget--;
        // P10: increment after the loop so layer s is processed first (highest priority this frame).
        this.roundRobinIndex = (s + 1) % n;
    }
}
