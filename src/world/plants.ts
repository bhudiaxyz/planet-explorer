import * as THREE from "three";
import { CFG } from "../core/config";
import {
    grassGeo,
    shrubGeo,
    shrubLow,
    shrubTiny,
    flowerGeo,
    alpineGeo,
    alpineLow,
    alpineTiny,
    reedGeo,
    reedTiny,
    fernGeo,
    fernTiny,
    mushroomGeo,
    cactusGeo,
    cactusLow,
    cactusTiny,
    deadScrubGeo,
    deadScrubLow,
    deadScrubTiny,
    sedgeGeo,
    sedgeLow,
    sedgeTiny,
} from "./plantgeo";
import {
    crystalGeo,
    crystalLow,
    crystalTiny,
    geodeGeo,
    geodeLow,
    geodeTiny,
    iceCrystalGeo,
    iceCrystalLow,
    iceCrystalTiny,
    emberGeo,
    emberLow,
    emberTiny,
} from "./crystalgeo";
import {
    rockGeo,
    rockLow,
    rockTiny,
    rockSlabGeo,
    rockSlabLow,
    rockSlabTiny,
    frostRockGeo,
    frostRockLow,
    frostRockTiny,
    cobbleGeo,
    cobbleLow,
    torGeo,
    torLow,
    torTiny,
    screeGeo,
    screeLow,
    screeTiny,
    basaltGeo,
    basaltLow,
    basaltTiny,
} from "./rockgeo";

// ============================================================================================================================================
// Plant catalog. Every ground-cover type is ONE entry: its geometry per distance tier, and two GLSL snippets that run on the GPU:
//   pre   – cheap early rejection BEFORE the expensive terrain evaluation (cluster / forest fields only)
//   gate  – final placement test once elevation (e), moisture (m), slope (sl) are known   →  use REJECT to veto the cell
//   look  – per-instance scale (sc) and colour (tint) from hashes h1,h2,h3,h7 and the baked placement texel Dv
// Variables available in snippets: h1..h6 (cell hashes), d (unit direction), e, m, sl, tt, PMUL (cell-area factor), plus the shared fields
// forestMask/groveMask/treeDensity/clusterField (gpu.ts). To add a plant: add geometry in plantgeo.ts and one entry below – nothing else.
// Clustering: cf = clusterField(d, kind) is a smooth 0..1 map of loose patches containing small clumps; probability is scaled by cf so plants form
// groves/patches instead of a uniform scatter. Grass is the exception: it carpets open, moist, gentle ground.
// ============================================================================================================================================
export interface Tier {
    geo: () => THREE.BufferGeometry;
    cell: number;
    K: number;
    pmul: number;
    lod: readonly number[];
    sw: number;
    sh: number;
    near: boolean;
    far: boolean;
}
export interface PlantSpec {
    name: string;
    kind: number;
    wind: number;
    dbl: boolean;
    hardy: boolean;
    collide: boolean;
    lean: number;
    disp: boolean;
    push: boolean;
    moss: boolean;
    /** per-vertex foliage rustle on top of the whole-plant sway (medium/large leafy plants) */
    rustle: boolean;
    pre: string;
    gate: string;
    result: string;
    look: string;
    tiers: Tier[];
}
const LOD = CFG.plantLod,
    RAD = CFG.plantRadius;
// tier radius → instance-disc K; PMUL = (cell/0.85)² converts per-0.85m-cell probabilities to this tier's cell area
const tier = (
    geo: () => THREE.BufferGeometry,
    cell: number,
    radius: number,
    lod: readonly number[],
    sw = 1,
    sh = 1
): Tier => ({
    geo,
    cell,
    K: Math.ceil(radius / cell),
    pmul: (cell / 0.85) ** 2,
    lod,
    sw,
    sh,
    near: false, // set by plant(): the first tier of each kind (see below)
    far: lod === LOD.far,
});
type Def = Pick<PlantSpec, "name" | "kind" | "tiers" | "look" | "gate"> & Partial<PlantSpec>;
const plant = (p: Def): PlantSpec => ({
    wind: 0.3,
    dbl: false,
    hardy: false,
    collide: false,
    lean: 0.18,
    disp: false,
    push: false,
    moss: false,
    rustle: false,
    pre: "",
    result: "return vec4(e*uAmp,h1,h2,h3);",
    ...p,
    // "near" = the kind's closest tier, whatever LOD band it uses. It used to be `lod === LOD.near`, which only the
    // grass/fern/reed band matched — so shrubs, rocks, cactus, boulders… had no near tier: never collidable, absent
    // entirely on low tier (which keeps only near tiers), and excluded from high-tier plant shadows.
    tiers: p.tiers.map((t, i) => ({ ...t, near: i === 0 })),
});

export const PLANTS: PlantSpec[] = [
    plant({
        name: "grass",
        kind: 0,
        wind: 0.35,
        dbl: true,
        push: true,
        tiers: [
            tier(() => grassGeo(4, 2, 1.15), 0.85, RAD.near, LOD.near),
            tier(() => grassGeo(3, 1, 1.8), 1.2, RAD.mid, LOD.mid, 1.45, 1),
            tier(() => grassGeo(2, 1, 1.8), 4.5, RAD.far, LOD.far, 3.8, 1.1),
        ],
        // carpets open, moist, gentle, low ground: full cover on plains/grassland, thinner under forest, patchy on dry or steep terrain
        gate: `
      pt = pn(d * 7. + vec3(11., 0., 0.), 1);
      float gp = sm_(-.35, .0, m)
        * (1. - .65 * forestMask(d, m))
        * (1. - sm_(.35, .6, e))
        * (1. - sm_(.3, .8, sl));
      gp = clamp(gp * (.85 + .2 * sm_(-.3, .3, pt)), 0., .85);
      if (sl >= .9 || h4 >= gp) REJECT;
    `,
        result: "return vec4(e * uAmp, pt, m, h3);",
        look: `
      sc = vec3(.7 + h1 * h2 * 1.2);
      sc.y *= (1. + step(.9, h7) * .9) * (.75 + .7 * sm_(-.2, .35, Dv.z));
      tint = uCg * (.85 + h1 * .3)
        * mix(vec3(1.), vec3(1.28, 1.05, .62), sm_(.15, .6, Dv.y) * .75)
        * mix(vec3(1.), vec3(1.4, 1.15, .5), step(.85, h7) * .8);
      if (h3 > .92) tint = (h2 < .4 ? vec3(.55, .62, .68) : h2 < .7 ? vec3(.48, .28, .12) : vec3(.18, .48, .52)) * (.9 + h1 * .3);
    `,
    }),
    plant({
        name: "flowers",
        kind: 1,
        wind: 0.4,
        push: true, // meadow patches in clearings
        tiers: [tier(flowerGeo, 3.4, RAD.flower, LOD.flower)],
        pre: "cf = clusterField(d, 1.); if (h5 >= .04 * PMUL * cf * 5.) REJECT;",
        gate: "if (e >= .38 || sl >= .5 || m < -.2 || forestMask(d, m) > .6) REJECT;",
        look: `
      sc = vec3(.55 + h2 * .8, .55 + h1 * 1.1, .55 + h2 * .8);
      sc *= 1. + step(.88, h3) * .6;
      // vColor exists only in the visible pass; the shadow-depth pass (collidable kinds, high tier) runs this
      // same code without vertex colours, so the glow mask falls back to 1 there (tint is unused in depth)
#ifdef USE_COLOR
      float hm = step(.4, min(vColor.r, min(vColor.g, vColor.b)));
#else
      float hm = 1.;
#endif
      int pk = int(h3 * 9.);
      vec3 fcol = pk == 0 ? vec3(.9,  .9,  .88)
        : pk == 1 ? vec3(.9,  .62, .05)
        : pk == 2 ? vec3(.28, .12, .55)
        : pk == 3 ? vec3(.85, .25, .4)
        : pk == 4 ? vec3(.9,  .28, .04)
        : pk == 5 ? vec3(.12, .25, .8)
        : pk == 6 ? vec3(.88, .78, .06)
        : pk == 7 ? vec3(.06, .58, .28)
        :           vec3(.9,  .45, .55);
      tint = mix(vec3(1.), fcol, hm);
    `,
    }),
    plant({
        name: "shrubs",
        kind: 2,
        wind: 0.12,
        rustle: true,
        collide: true,
        lean: 0.35,
        disp: true, // thickets
        tiers: [
            tier(shrubGeo, 4.25, RAD.shrub, LOD.shrub),
            tier(shrubLow, 8.5, RAD.shrubMid, LOD.shrubMid),
            tier(shrubTiny, 17, RAD.far, LOD.far, 1.9, 1.9),
        ],
        pre: "cf = clusterField(d, 2.); if (h6 >= .007 * PMUL * cf * 3.5) REJECT;",
        gate: "if (e >= .3 || sl >= .6 || m <= -.05) REJECT;",
        look: `
      float sw = .45 + h2 * 1.4;
      sc = vec3(sw, sw * (.7 + h1 * .8), sw);
      sc *= 1. + step(.9, h1) * .55;
      tint = (h7 < .2  ? vec3(.05, .2,  .04)
            : h7 < .4  ? vec3(.12, .2,  .05)
            : h7 < .58 ? vec3(.04, .18, .14)
            : h7 < .72 ? vec3(.17, .27, .05)
            : h7 < .86 ? vec3(.2,  .07, .04)
            : h7 < .94 ? vec3(.3,  .2,  .04)
            :             vec3(.45, .22, .3))
        * (.65 + h2 * .7);
    `,
    }),
    plant({
        name: "rocks",
        kind: 3,
        wind: 0,
        hardy: true,
        collide: true,
        lean: 0.35,
        disp: true,
        moss: true, // boulder fields
        tiers: [
            tier(rockGeo, 4.25, RAD.rock, LOD.rock),
            tier(rockLow, 8.5, RAD.rockMid, LOD.rockMid),
            tier(rockTiny, 17, RAD.far, LOD.far),
        ],
        pre: "cf = clusterField(d, 3.);",
        gate: "if (h6 <= 1. - (.0016 + sl * .012 + sm_(.4, .6, e) * .009) * PMUL * (.15 + cf * 1.8)) REJECT;",
        look: `
      float s = .3 + h1 * 1.6;
      sc = vec3(s * (.8 + h2 * .6), s * (.45 + h7 * .5), s * (.7 + h1 * .5));
      tint = (h7 < .25 ? vec3(.3,  .29, .28)
            : h7 < .5  ? vec3(.42, .32, .2)
            : h7 < .7  ? vec3(.16, .16, .19)
            : h7 < .88 ? vec3(.38, .18, .12)
            :             vec3(.5,  .5,  .55))
        * 4. * (.75 + h2 * .45);
    `,
    }),
    plant({
        name: "alpine scrub",
        kind: 4,
        wind: 0.15,
        rustle: true,
        hardy: true,
        lean: 0.35,
        disp: true,
        tiers: [
            tier(alpineGeo, 4.25, RAD.shrub, LOD.shrub),
            tier(alpineLow, 8.5, RAD.shrubMid, LOD.shrubMid),
            tier(alpineTiny, 17, RAD.far, LOD.far, 1.8, 1.8),
        ],
        pre: "cf = clusterField(d, 4.); if (h6 >= .024 * PMUL * cf * 3.5) REJECT;",
        gate: "if (e < .26 || sl >= .8) REJECT;",
        look: `
      sc = vec3(.38 + h2 * 1.0, .38 + h1 * 1.2, .38 + h2 * 1.0);
      tint = (h7 < .3  ? vec3(.1,  .13, .07)
            : h7 < .55 ? vec3(.16, .14, .08)
            : h7 < .8  ? vec3(.12, .1,  .14)
            :             vec3(.2,  .18, .15))
        * (.7 + h2 * .6);
    `,
    }),
    plant({
        name: "reeds",
        kind: 5,
        wind: 0.5,
        push: true, // reed beds along shores
        tiers: [
            tier(() => reedGeo(5), 3.4, RAD.near, LOD.near, 1.3, 1),
            tier(() => reedGeo(3), 6.8, RAD.mid, LOD.mid, 1.8, 1.1),
            tier(reedTiny, 17, RAD.far, LOD.far, 1.6, 1.4),
        ],
        pre: "cf = clusterField(d, 5.); if (h6 >= .12 * PMUL * cf * 3.) REJECT;",
        gate: "if (e < -.03 || e >= .025 || sl >= .35 || m < -.25) REJECT;",
        look: `
      sc = vec3(.6 + h2 * .8, .55 + h1 * 1.1, .6 + h2 * .8);
      sc.y *= 1. + step(.82, h3) * 1.0;
      tint = vec3(.75 + h2 * .5);
    `,
    }),
    plant({
        name: "ferns",
        kind: 6,
        wind: 0.3,
        push: true, // forest understory: follows the tree density field
        tiers: [
            tier(() => fernGeo(8), 3.4, RAD.near, LOD.near),
            tier(() => fernGeo(3), 3.4, RAD.mid, LOD.mid, 1.5, 1.1),
            tier(fernTiny, 17, RAD.far, LOD.far, 1.4, 1.2),
        ],
        pre: "m0 = pn(d * uFreq * 2.2 + vec3(30., 0., 0.), 1); fo = treeDensity(d, m0); if (h6 >= .05 * PMUL * (.08 + fo * 2.4)) REJECT;",
        gate: "if (m <= 0. || e >= .44 || sl >= .7) REJECT;",
        look: `
      sc = vec3(.6 + h2 * 1.1, .55 + h1 * 1.1, .6 + h2 * 1.1);
      sc *= 1. + step(.87, h1) * .5;
      tint = (h7 < .3  ? vec3(.04, .17, .05)
            : h7 < .6  ? vec3(.08, .22, .05)
            : h7 < .85 ? vec3(.03, .14, .1)
            :             vec3(.14, .2,  .04))
        * (.7 + h2 * .6);
    `,
    }),
    plant({
        name: "rock slabs",
        kind: 8,
        wind: 0,
        hardy: true,
        collide: true,
        lean: 0.35,
        disp: true,
        tiers: [
            tier(rockSlabGeo, 4.25, RAD.rock, LOD.rock),
            tier(rockSlabLow, 8.5, RAD.rockMid, LOD.rockMid),
            tier(rockSlabTiny, 17, RAD.far, LOD.far),
        ],
        pre: "cf = clusterField(d, 8.);",
        gate: "if (h6 <= 1. - (.002 + sl * .014 + sm_(.25, .5, e) * .010) * PMUL * (.10 + cf * 1.6)) REJECT;",
        look: `
      float s = .2 + h1 * 1.2;
      sc = vec3(s * (1. + h2 * .4), s * (.12 + h7 * .2), s * (.9 + h1 * .3));
      tint = (h7 < .3  ? vec3(.45, .32, .18)
            : h7 < .55 ? vec3(.38, .28, .16)
            : h7 < .78 ? vec3(.28, .22, .15)
            : h7 < .92 ? vec3(.52, .38, .22)
            :             vec3(.35, .28, .24))
        * 4. * (.7 + h2 * .5);
    `,
    }),
    plant({
        name: "frost rocks",
        kind: 9,
        wind: 0,
        hardy: true,
        collide: true,
        lean: 0.2,
        disp: true,
        tiers: [
            tier(frostRockGeo, 4.25, RAD.rock, LOD.rock),
            tier(frostRockLow, 8.5, RAD.rockMid, LOD.rockMid),
            tier(frostRockTiny, 17, RAD.far, LOD.far),
        ],
        pre: "cf = clusterField(d, 9.);",
        gate: "if (e < .38 || h6 <= 1. - (.003 + sl * .010 + sm_(.38, .58, e) * .011) * PMUL * (.20 + cf * 1.4)) REJECT;",
        look: `
      float s = .3 + h1 * 1.3;
      sc = vec3(s * (.8 + h2 * .5), s * (.55 + h7 * .6), s * (.75 + h1 * .4));
      tint = (h7 < .3  ? vec3(.55, .58, .62)
            : h7 < .55 ? vec3(.62, .65, .7)
            : h7 < .78 ? vec3(.45, .48, .55)
            : h7 < .92 ? vec3(.7,  .72, .75)
            :             vec3(.5,  .52, .6))
        * 3.5 * (.8 + h2 * .35);
    `,
    }),
    plant({
        name: "mushrooms",
        kind: 7,
        wind: 0.05, // tight clumps on damp forest floor
        tiers: [tier(mushroomGeo, 3.4, RAD.mush, LOD.mush)],
        pre: "m0 = pn(d * uFreq * 2.2 + vec3(30., 0., 0.), 1); fo = treeDensity(d, m0); cf = clusterField(d, 7.); if (h6 >= .035 * PMUL * fo * (.2 + cf * 3.)) REJECT;",
        gate: "if (m <= .12 || e >= .28 || sl >= .5) REJECT;",
        look: `
      sc = vec3(.45 + h2 * .8, .55 + h1 * 1.1, .45 + h2 * .8);
      sc *= 1. + h3 * 2. * step(.7, h3);
      // vColor exists only in the visible pass; the shadow-depth pass (collidable kinds, high tier) runs this
      // same code without vertex colours, so the glow mask falls back to 1 there (tint is unused in depth)
#ifdef USE_COLOR
      float hm2 = step(.4, min(vColor.r, min(vColor.g, vColor.b)));
#else
      float hm2 = 1.;
#endif
      vec3 mcol = h7 < .18 ? vec3(.5,  .05, .04)
                : h7 < .36 ? vec3(.25, .12, .06)
                : h7 < .52 ? vec3(.5,  .2,  .04)
                : h7 < .66 ? vec3(.4,  .35, .25)
                : h7 < .80 ? vec3(.3,  .12, .4)
                : h7 < .91 ? vec3(.08, .32, .18)
                :             vec3(.6,  .48, .08);
      tint = mix(vec3(1.), mcol, hm2);
    `,
    }),
    plant({
        name: "cactus",
        kind: 10,
        wind: 0,
        hardy: true,
        collide: true,
        lean: 0.08,
        disp: true,
        tiers: [
            tier(cactusGeo, 3.4, RAD.shrub, LOD.shrub),
            tier(cactusLow, 6.8, RAD.shrubMid, LOD.shrubMid, 1.0, 2.0),
            tier(cactusTiny, 17, RAD.far, LOD.far, 1.6, 2.2),
        ],
        pre: "cf = clusterField(d, 10.); if (h6 >= .018 * PMUL * cf * 3.) REJECT;",
        gate: "if (e >= .18 || sl >= .6 || m >= .2) REJECT;",
        look: `
      float sw = .45 + h2 * 1.1;
      sc = vec3(sw * (.8 + h3 * .4), sw * (1.1 + h1 * .9), sw * (.8 + h3 * .4));
      tint = (h7 < .4  ? vec3(.18, .35, .12)
            : h7 < .75 ? vec3(.14, .28, .10)
            :             vec3(.22, .32, .08))
        * (.7 + h2 * .6);
    `,
    }),
    plant({
        name: "dead scrub",
        kind: 11,
        wind: 0.08,
        rustle: true,
        hardy: true,
        lean: 0.25,
        tiers: [
            tier(deadScrubGeo, 3.4, RAD.shrub, LOD.shrub),
            tier(deadScrubLow, 8.5, RAD.shrubMid, LOD.shrubMid, 1.6, 1.6),
            tier(deadScrubTiny, 17, RAD.far, LOD.far, 1.5, 1.5),
        ],
        pre: "cf = clusterField(d, 11.); if (h6 >= .014 * PMUL * cf * 3.5) REJECT;",
        gate: "if (e < .08 || sl >= .75 || m >= .25) REJECT;",
        look: `
      float s = .3 + h1 * 1.4;
      sc = vec3(s * (.7 + h2 * .7), s * (.65 + h3 * .7), s * (.7 + h2 * .7));
      tint = (h7 < .35 ? vec3(.22, .17, .11)
            : h7 < .65 ? vec3(.18, .14, .09)
            : h7 < .88 ? vec3(.28, .20, .12)
            :             vec3(.16, .13, .10))
        * (.7 + h2 * .6);
    `,
    }),
    plant({
        name: "tall sedge",
        kind: 12,
        wind: 0.45,
        push: true,
        lean: 0.22,
        tiers: [
            tier(sedgeGeo, 3.4, RAD.near, LOD.near),
            tier(sedgeLow, 6.8, RAD.mid, LOD.mid, 1.0, 1.6),
            tier(sedgeTiny, 17, RAD.far, LOD.far, 1.2, 1.8),
        ],
        pre: "cf = clusterField(d, 12.); if (h6 >= .08 * PMUL * cf * 3.) REJECT;",
        gate: "if (e < .01 || e >= .06 || sl >= .4 || m < 0.) REJECT;",
        look: `
      sc = vec3(.6 + h2 * .7, .65 + h1 * 1.1, .6 + h2 * .7);
      sc.y *= 1. + step(.85, h3) * .9;
      tint = (h7 < .35 ? vec3(.52, .48, .20)
            : h7 < .65 ? vec3(.38, .45, .16)
            : h7 < .88 ? vec3(.60, .52, .22)
            :             vec3(.42, .38, .14))
        * (.7 + h2 * .6);
    `,
    }),
    plant({
        name: "boulders",
        kind: 13,
        wind: 0,
        hardy: true,
        collide: true,
        lean: 0.12,
        disp: true,
        moss: true,
        tiers: [
            tier(rockGeo, 8.5, RAD.rock, LOD.rock),
            tier(rockLow, 17, RAD.rockMid, LOD.rockMid),
            tier(rockTiny, 34, RAD.far, LOD.far),
        ],
        pre: "cf = clusterField(d, 13.);",
        gate: "if (e < .28 || h6 <= 1. - (.0012 + sl * .010 + sm_(.28, .55, e) * .010) * PMUL * (.16 + cf * 1.1)) REJECT;",
        look: `
      float s = 1.6 + h1 * 3.2;
      sc = vec3(s * (.75 + h2 * .5), s * (.4 + h7 * .45), s * (.65 + h1 * .4));
      tint = (h7 < .3  ? vec3(.32, .30, .28)
            : h7 < .6  ? vec3(.22, .20, .24)
            : h7 < .82 ? vec3(.40, .28, .18)
            :             vec3(.48, .46, .50))
        * 4.2 * (.7 + h2 * .5);
    `,
    }),
    plant({
        name: "crystals",
        kind: 14,
        wind: 0,
        hardy: true,
        lean: 0.05,
        tiers: [
            tier(crystalGeo, 3.4, RAD.rock, LOD.rock),
            tier(crystalLow, 8.5, RAD.rockMid, LOD.rockMid),
            tier(crystalTiny, 17, RAD.far, LOD.far),
        ],
        pre: "cf = clusterField(d, 14.);",
        gate: "if (e < .22 || m >= .35 || h6 <= 1. - (.004 + sm_(.22, .55, e) * .012) * PMUL * (.15 + cf * 2.0)) REJECT;",
        look: `
      float s = .35 + h1 * .7;
      sc = vec3(s * (.18 + h2 * .12), s * (1.2 + h1 * .5), s * (.18 + h2 * .12));
      tint = (h7 < .35 ? vec3(.15, .75, 1.0)
            : h7 < .65 ? vec3(.60, .12, 1.0)
            : h7 < .88 ? vec3(1.0, .35, .08)
            :             vec3(.18, .90, .55))
        * (2.8 + h1 * 1.4);
    `,
    }),
    // ---- rock variety by altitude: cobbles (shore) → tors (uplands) → basalt columns (dry mid/high) → scree (steep high slopes)
    plant({
        name: "cobbles",
        kind: 15,
        wind: 0,
        hardy: true,
        lean: 0.1,
        disp: true,
        moss: true, // shore and riverbed pebble beds; too small to read from far away, so no far tier
        tiers: [tier(cobbleGeo, 3.4, RAD.shrub, LOD.shrub), tier(cobbleLow, 6.8, RAD.shrubMid, LOD.shrubMid)],
        pre: "cf = clusterField(d, 15.);",
        gate: "if (e >= .12 || sl >= .5 || h6 <= 1. - (.006 + (1. - sm_(.02, .1, e)) * .02) * PMUL * (.1 + cf * 2.5)) REJECT;",
        look: `
      float s = .6 + h1 * .9;
      sc = vec3(s, s * (.7 + h7 * .5), s);
      tint = (h7 < .35 ? vec3(.42, .40, .38) : h7 < .7 ? vec3(.36, .30, .24) : vec3(.5, .48, .46))
        * 3.6 * (.75 + h2 * .4);
    `,
    }),
    plant({
        name: "tors",
        kind: 16,
        wind: 0,
        hardy: true,
        collide: true,
        lean: 0.05,
        disp: true,
        moss: true, // rare stacked outcrops, ~1.5–8 m tall, on upland moors
        tiers: [
            tier(torGeo, 8.5, RAD.rock, LOD.rock),
            tier(torLow, 17, RAD.rockMid, LOD.rockMid),
            tier(torTiny, 34, RAD.far, LOD.far),
        ],
        pre: "cf = clusterField(d, 16.);",
        gate: "if (e < .14 || e >= .42 || sl >= .7 || h6 <= 1. - (.0008 + sm_(.14, .3, e) * .004) * PMUL * (.1 + cf * 1.4)) REJECT;",
        look: `
      float s = 1. + h1 * 1.8;
      sc = vec3(s * (.8 + h2 * .4), s * (.6 + h7 * 1.1), s * (.8 + h2 * .4));
      tint = (h7 < .4 ? vec3(.36, .33, .30) : h7 < .75 ? vec3(.30, .28, .27) : vec3(.42, .34, .26))
        * 4. * (.75 + h2 * .4);
    `,
    }),
    plant({
        name: "basalt columns",
        kind: 17,
        wind: 0,
        hardy: true,
        collide: true,
        lean: 0.04, // tight clusters of hex prisms, ~0.6–5 m tall, on dry mid/high ground
        tiers: [
            tier(basaltGeo, 8.5, RAD.rock, LOD.rock),
            tier(basaltLow, 17, RAD.rockMid, LOD.rockMid),
            tier(basaltTiny, 34, RAD.far, LOD.far),
        ],
        pre: "cf = clusterField(d, 17.);",
        gate: "if (e < .2 || e >= .52 || m >= .25 || h6 <= 1. - .003 * PMUL * cf * cf * 3.) REJECT;",
        look: `
      float s = .8 + h1 * 1.2;
      sc = vec3(s, s * (.6 + h7 * 1.6), s);
      tint = (h7 < .5 ? vec3(.18, .18, .20) : vec3(.24, .22, .22)) * 4. * (.8 + h2 * .3);
    `,
    }),
    plant({
        name: "scree",
        kind: 18,
        wind: 0,
        hardy: true,
        lean: 0.4, // shard fields above ~tree line, denser the steeper the slope
        tiers: [
            tier(screeGeo, 4.25, RAD.rock, LOD.rock),
            tier(screeLow, 8.5, RAD.rockMid, LOD.rockMid),
            tier(screeTiny, 17, RAD.far, LOD.far, 1.6, 1),
        ],
        pre: "cf = clusterField(d, 18.);",
        gate: "if (e < .3 || h6 <= 1. - (.002 + sm_(.2, .8, sl) * .03) * sm_(.3, .5, e) * PMUL * (.3 + cf * 1.2)) REJECT;",
        look: `
      sc = vec3(.6 + h1);
      tint = (h7 < .4 ? vec3(.5, .52, .56) : h7 < .75 ? vec3(.4, .4, .42) : vec3(.36, .3, .26))
        * 3.4 * (.75 + h2 * .4);
    `,
    }),
    // ---- crystal variety by climate: geodes (dry mid altitude) · ice crystals (near the snowline) · ember shards (hot,
    // dry lowlands). Glow: the tint multiplies only bright (glowing) vertices — rock shells and charred casings keep their
    // own dark colour (min channel < .4, the same mask the flowers use). Same LOD bands as the original crystals.
    plant({
        name: "crystal geodes",
        kind: 19,
        wind: 0,
        hardy: true,
        collide: true,
        lean: 0.06,
        tiers: [
            tier(geodeGeo, 4.25, RAD.rock, LOD.rock),
            tier(geodeLow, 8.5, RAD.rockMid, LOD.rockMid),
            tier(geodeTiny, 17, RAD.far, LOD.far),
        ],
        pre: "cf = clusterField(d, 19.);",
        gate: "if (e < .16 || e >= .45 || m >= .2 || h6 <= 1. - (.0012 + sm_(.16, .35, e) * .004) * PMUL * (.1 + cf * 1.6)) REJECT;",
        look: `
      float s = .8 + h1 * 1.4;
      sc = vec3(s * (.9 + h2 * .3), s * (.75 + h7 * .5), s * (.9 + h2 * .3));
      // vColor exists only in the visible pass; the shadow-depth pass (collidable kinds, high tier) runs this
      // same code without vertex colours, so the glow mask falls back to 1 there (tint is unused in depth)
#ifdef USE_COLOR
      float gm = step(.4, min(vColor.r, min(vColor.g, vColor.b)));
#else
      float gm = 1.;
#endif
      vec3 gc = h7 < .4 ? vec3(.62, .18, 1.)    // amethyst
              : h7 < .75 ? vec3(1., .72, .12)   // citrine
              :            vec3(.15, 1., .45);  // emerald
      tint = mix(vec3(1.), gc * (2.6 + h1 * 1.2), gm);
    `,
    }),
    plant({
        name: "ice crystals",
        kind: 20,
        wind: 0,
        hardy: true,
        lean: 0.04,
        tiers: [
            tier(iceCrystalGeo, 3.4, RAD.rock, LOD.rock),
            tier(iceCrystalLow, 8.5, RAD.rockMid, LOD.rockMid),
            tier(iceCrystalTiny, 17, RAD.far, LOD.far),
        ],
        pre: "cf = clusterField(d, 20.);",
        // near and just below the snowline (tt is the climate value the snow test uses), on gentle ground
        gate: "if (e < .3 || tt > uSnow + .22 || sl >= .7 || h6 <= 1. - (.003 + sm_(uSnow + .22, uSnow + .02, tt) * .009) * PMUL * (.15 + cf * 1.8)) REJECT;",
        look: `
      float s = .5 + h1 * .9;
      sc = vec3(s * (.8 + h2 * .4), s * (.8 + h7 * .8), s * (.8 + h2 * .4));
      tint = (h7 < .45 ? vec3(.55, .9, 1.)    // pale cyan
            : h7 < .85 ? vec3(.82, .92, 1.)   // white-blue
            :            vec3(.78, .7, 1.))   // faint violet
        * (1.8 + h1 * .9);
    `,
    }),
    plant({
        name: "ember shards",
        kind: 21,
        wind: 0,
        hardy: true,
        lean: 0.3,
        tiers: [
            tier(emberGeo, 3.4, RAD.rock, LOD.rock),
            tier(emberLow, 8.5, RAD.rockMid, LOD.rockMid),
            tier(emberTiny, 17, RAD.far, LOD.far),
        ],
        pre: "cf = clusterField(d, 21.);",
        // hot (low tt-adjusted latitude band), dry lowlands: deserts and volcanic plains
        gate: "if (e < .04 || e >= .3 || m >= -.05 || tt < .62 || h6 <= 1. - (.0035 + sm_(-.05, -.3, m) * .008) * PMUL * (.12 + cf * 2.)) REJECT;",
        look: `
      float s = .6 + h1 * 1.1;
      sc = vec3(s);
      // vColor exists only in the visible pass; the shadow-depth pass (collidable kinds, high tier) runs this
      // same code without vertex colours, so the glow mask falls back to 1 there (tint is unused in depth)
#ifdef USE_COLOR
      float gm = step(.4, min(vColor.r, min(vColor.g, vColor.b)));
#else
      float gm = 1.;
#endif
      vec3 gc = h7 < .45 ? vec3(1., .38, .06)   // orange
              : h7 < .8  ? vec3(1., .14, .05)   // red
              :            vec3(1., .7, .15);   // gold
      tint = mix(vec3(1.), gc * (2.4 + h1 * 1.4), gm);
    `,
    }),
];

// ---- GLSL generation
// `look` runs in each kind's own visible-material program, so it stays a compile-time `#if KIND==k` block.
const perKind = (f: "pre" | "gate" | "result" | "look") =>
    PLANTS.filter((p) => p[f])
        .map((p) => `#if KIND==${p.kind}\n${p[f]}\n#endif`)
        .join("\n");
export const lookGLSL = () => perKind("look");
// Placement bake: ONE program for every kind, dispatched on the uKind uniform (dynamically uniform branch — free on any
// GPU). It used to be one program per kind via #if; each holds two full e3() terrain evaluations, and ANGLE's D3D
// compiler (Windows Chrome/Edge) takes ~2.4 s per copy — 15 copies were ~36 s of a Windows cold start.
const branch = (f: "pre" | "gate") =>
    PLANTS.filter((p) => p[f])
        .map((p) => `if (uKind == ${p.kind}) { ${p[f]} }`)
        .join("\n");
// Results as one expression: a ternary chain over the kinds that override the default result (see decideGLSL below).
const DEFAULT_RESULT = plant({ name: "", kind: -1, tiers: [], look: "", gate: "" }).result;
const resultExpr = (r: string) =>
    r
        .trim()
        .replace(/^return\s+/, "")
        .replace(/;\s*$/, "");
const resultGLSL = () =>
    "return " +
    PLANTS.filter((p) => p.result !== DEFAULT_RESULT)
        .map((p) => `uKind == ${p.kind} ? ${resultExpr(p.result)} : `)
        .join("") +
    resultExpr(DEFAULT_RESULT) +
    ";";
// Single exit: REJECT sets a flag instead of returning. ANGLE rewrites every early return into a conditionally assigned
// result variable, and with ~30 of them in the merged program fxc (Windows) warned X4000 "potentially uninitialized
// variable (f_decide)". Stages after a rejection are skipped with if (!rej), so rejected cells still avoid the e3() work.
export const decideGLSL = () => `uniform float CELLSZ,PMUL,TSN;uniform int uKind;
#define REJECT rej = true
vec4 decide(float I,float J,float F){float h1=hs(I,J,F),h2=hs(I,J,F+9.),h3=hs(I,J,F+17.),h4=hs(I,J,F+31.),h5=hs(I,J,F+53.),h6=hs(I,J,F+71.);
vec3 nA,uu,vv;basis(F,nA,uu,vv);vec3 P=nA*uR+uu*(I+h1-.5)*CELLSZ+vv*(J+h2-.5)*CELLSZ,d=normalize(P);
float cf=1.,fo=0.,m0=0.,pt=0.,e=0.,m=0.,tt=0.,sl=0.;bool rej=false;
${branch("pre")}
if(!rej){
e=e3(d,true);m=pn(d*uFreq*2.2+vec3(30.,0.,0.),1);tt=1.-1.1*d.y*d.y-1.2*max(e,0.);
if(e<(uKind==5?-.03:.015)||e>.6||tt<uSnow+TSN)REJECT;
}
if(!rej){
sl=abs(uR+e3(normalize(P+uu*.8),true)*uAmp-(uR+e*uAmp))/.8;
${branch("gate")}
}
${resultGLSL().replace(/^return /, "return rej ? vec4(-9999.,0.,0.,0.) : ")}}`;
