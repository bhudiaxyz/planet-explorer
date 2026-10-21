import * as THREE from "three";
import { CFG } from "./config";
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
  fernGeo,
  mushroomGeo,
} from "./plantgeo";
import { rockGeo, rockLow, rockTiny, rockSlabGeo, rockSlabLow, rockSlabTiny, frostRockGeo, frostRockLow, frostRockTiny } from "./rockgeo";

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
  sh = 1,
): Tier => ({
  geo,
  cell,
  K: Math.ceil(radius / cell),
  pmul: (cell / 0.85) ** 2,
  lod,
  sw,
  sh,
  near: lod === LOD.near,
});
type Def = Pick<PlantSpec, "name" | "kind" | "tiers" | "look" | "gate"> &
  Partial<PlantSpec>;
const plant = (p: Def): PlantSpec => ({
  wind: 0.3,
  dbl: false,
  hardy: false,
  collide: false,
  lean: 0.18,
  disp: false,
  push: false,
  moss: false,
  pre: "",
  result: "return vec4(e*uAmp,h1,h2,h3);",
  ...p,
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
    gate: `pt=pn(d*7.+vec3(11.,0.,0.),1);float gp=sm_(-.45,-.05,m)*(1.-.65*forestMask(d,m))*(1.-sm_(.35,.6,e))*(1.-sm_(.35,.85,sl));
gp=clamp(gp*(.9+.2*sm_(-.3,.3,pt)),0.,1.);if(sl>=.9||h4>=gp)REJECT;`,
    result: "return vec4(e*uAmp,pt,m,h3);",
    look: `sc=vec3(.7+h1*h2*1.2);sc.y*=(1.+step(.9,h7)*.9)*(.75+.7*sm_(-.2,.35,Dv.z));
tint=uCg*(.85+h1*.3)*mix(vec3(1.),vec3(1.28,1.05,.62),sm_(.15,.6,Dv.y)*.75)*mix(vec3(1.),vec3(1.4,1.15,.5),step(.85,h7)*.8);`,
  }),
  plant({
    name: "flowers",
    kind: 1,
    wind: 0.4,
    push: true, // meadow patches in clearings
    tiers: [tier(flowerGeo, 3.4, RAD.flower, LOD.flower)],
    pre: "cf=clusterField(d,1.);if(h5>=.04*PMUL*cf*5.)REJECT;",
    gate: "if(e>=.38||sl>=.5||m<-.2||forestMask(d,m)>.6)REJECT;",
    look: `sc=vec3(.8+h1*.6);float hm=step(.4,min(vColor.r,min(vColor.g,vColor.b)));int pk=int(h3*6.);
vec3 fcol=pk==0?vec3(.9,.9,.88):(pk==1?vec3(.9,.62,.05):(pk==2?vec3(.28,.12,.55):(pk==3?vec3(.85,.25,.4):(pk==4?vec3(.9,.28,.04):vec3(.12,.25,.8)))));
tint=mix(vec3(1.),fcol,hm);`,
  }),
  plant({
    name: "shrubs",
    kind: 2,
    wind: 0.12,
    collide: true,
    lean: 0.35,
    disp: true, // thickets
    tiers: [
      tier(shrubGeo, 4.25, RAD.near, LOD.near),
      tier(shrubLow, 8.5, RAD.mid, LOD.mid),
      tier(shrubTiny, 17, RAD.far, LOD.far, 1.9, 1.9),
    ],
    pre: "cf=clusterField(d,2.);if(h6>=.009*PMUL*cf*4.)REJECT;",
    gate: "if(e>=.3||sl>=.6||m<=-.05)REJECT;",
    look: `sc=vec3(.8+h2*1.1)*vec3(1.,.8+h1*.5,1.);
tint=(h7<.2?vec3(.05,.2,.04):(h7<.4?vec3(.12,.2,.05):(h7<.58?vec3(.04,.18,.14):(h7<.72?vec3(.17,.27,.05):(h7<.86?vec3(.2,.07,.04):(h7<.94?vec3(.3,.2,.04):vec3(.45,.22,.3)))))))*(.75+h2*.5);`,
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
      tier(rockGeo, 4.25, RAD.near, LOD.near),
      tier(rockLow, 8.5, RAD.mid, LOD.mid),
      tier(rockTiny, 17, RAD.far, LOD.far),
    ],
    pre: "cf=clusterField(d,3.);",
    gate: "if(h6<=1.-(.003+sl*.02+sm_(.4,.6,e)*.015)*PMUL*(.2+cf*2.6))REJECT;",
    look: `float s=.3+h1*1.6;sc=vec3(s*(.8+h2*.6),s*(.45+h7*.5),s*(.7+h1*.5));
tint=(h7<.25?vec3(.3,.29,.28):(h7<.5?vec3(.42,.32,.2):(h7<.7?vec3(.16,.16,.19):(h7<.88?vec3(.38,.18,.12):vec3(.5,.5,.55)))))*4.*(.75+h2*.45);`,
  }),
  plant({
    name: "alpine scrub",
    kind: 4,
    wind: 0.15,
    hardy: true,
    lean: 0.35,
    disp: true,
    tiers: [
      tier(alpineGeo, 4.25, RAD.near, LOD.near),
      tier(alpineLow, 8.5, RAD.mid, LOD.mid),
      tier(alpineTiny, 17, RAD.far, LOD.far, 1.8, 1.8),
    ],
    pre: "cf=clusterField(d,4.);if(h6>=.02*PMUL*cf*4.)REJECT;",
    gate: "if(e<.26||sl>=.8)REJECT;",
    look: `sc=vec3(.6+h2*.7);tint=(h7<.3?vec3(.1,.13,.07):(h7<.55?vec3(.16,.14,.08):(h7<.8?vec3(.12,.1,.14):vec3(.2,.18,.15))))*(.8+h2*.4);`,
  }),
  plant({
    name: "reeds",
    kind: 5,
    wind: 0.5,
    push: true, // reed beds along shores
    tiers: [
      tier(() => reedGeo(5), 3.4, RAD.near, LOD.near, 1.3, 1),
      tier(() => reedGeo(3), 6.8, RAD.mid, LOD.mid, 1.8, 1.1),
    ],
    pre: "cf=clusterField(d,5.);if(h6>=.12*PMUL*cf*3.)REJECT;",
    gate: "if(e<-.03||e>=.025||sl>=.35||m<-.25)REJECT;",
    look: "sc=vec3(.8+h1*.7,.8+h2*.9,.8+h1*.7);tint=vec3(.85+h2*.3);",
  }),
  plant({
    name: "ferns",
    kind: 6,
    wind: 0.3,
    push: true, // forest understory: follows the tree density field
    tiers: [
      tier(() => fernGeo(6), 3.4, RAD.near, LOD.near),
      tier(() => fernGeo(3), 3.4, RAD.mid, LOD.mid, 1.5, 1.1),
    ],
    pre: "m0=pn(d*uFreq*2.2+vec3(30.,0.,0.),1);fo=treeDensity(d,m0);if(h6>=.05*PMUL*(.08+fo*2.4))REJECT;",
    gate: "if(m<=0.||e>=.32||sl>=.7)REJECT;",
    look: `sc=vec3(.9+h2*.9,.8+h1*.6,.9+h2*.9);
tint=(h7<.3?vec3(.04,.17,.05):(h7<.6?vec3(.08,.22,.05):(h7<.85?vec3(.03,.14,.1):vec3(.14,.2,.04))))*(.8+h2*.4);`,
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
      tier(rockSlabGeo, 4.25, RAD.near, LOD.near),
      tier(rockSlabLow, 8.5, RAD.mid, LOD.mid),
      tier(rockSlabTiny, 17, RAD.far, LOD.far),
    ],
    pre: "cf=clusterField(d,8.);",
    gate: "if(h6<=1.-(.004+sl*.025+sm_(.25,.5,e)*.018)*PMUL*(.15+cf*2.4))REJECT;",
    look: `float s=.2+h1*1.2;sc=vec3(s*(1.+h2*.4),s*(.12+h7*.2),s*(.9+h1*.3));
tint=(h7<.3?vec3(.45,.32,.18):(h7<.55?vec3(.38,.28,.16):(h7<.78?vec3(.28,.22,.15):(h7<.92?vec3(.52,.38,.22):vec3(.35,.28,.24)))))*4.*(.7+h2*.5);`,
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
      tier(frostRockGeo, 4.25, RAD.near, LOD.near),
      tier(frostRockLow, 8.5, RAD.mid, LOD.mid),
      tier(frostRockTiny, 17, RAD.far, LOD.far),
    ],
    pre: "cf=clusterField(d,9.);",
    gate: "if(e<.38||h6<=1.-(.006+sl*.018+sm_(.38,.58,e)*.02)*PMUL*(.3+cf*2.2))REJECT;",
    look: `float s=.3+h1*1.3;sc=vec3(s*(.8+h2*.5),s*(.55+h7*.6),s*(.75+h1*.4));
tint=(h7<.3?vec3(.55,.58,.62):(h7<.55?vec3(.62,.65,.7):(h7<.78?vec3(.45,.48,.55):(h7<.92?vec3(.7,.72,.75):vec3(.5,.52,.6)))))*3.5*(.8+h2*.35);`,
  }),
  plant({
    name: "mushrooms",
    kind: 7,
    wind: 0.05, // tight clumps on damp forest floor
    tiers: [tier(mushroomGeo, 3.4, RAD.mush, LOD.mush)],
    pre: "m0=pn(d*uFreq*2.2+vec3(30.,0.,0.),1);fo=treeDensity(d,m0);cf=clusterField(d,7.);if(h6>=.035*PMUL*fo*(.2+cf*3.))REJECT;",
    gate: "if(m<=.12||e>=.28||sl>=.5)REJECT;",
    look: `sc=vec3(.7+h1*.8);float hm2=step(.4,min(vColor.r,min(vColor.g,vColor.b)));
vec3 mcol=h7<.3?vec3(.5,.05,.04):(h7<.55?vec3(.25,.12,.06):(h7<.75?vec3(.5,.2,.04):(h7<.9?vec3(.4,.35,.25):vec3(.3,.12,.4))));tint=mix(vec3(1.),mcol,hm2);`,
  }),
];

// ---- GLSL generation: one `#if KIND==k` block per catalog entry
const perKind = (f: "pre" | "gate" | "result" | "look") =>
  PLANTS.filter((p) => p[f])
    .map((p) => `#if KIND==${p.kind}\n${p[f]}\n#endif`)
    .join("\n");
export const lookGLSL = () => perKind("look");
export const decideGLSL = () => `#define REJECT return vec4(-9999.,0.,0.,0.)
vec4 decide(float I,float J,float F){float h1=hs(I,J,F),h2=hs(I,J,F+9.),h3=hs(I,J,F+17.),h4=hs(I,J,F+31.),h5=hs(I,J,F+53.),h6=hs(I,J,F+71.);
vec3 nA,uu,vv;basis(F,nA,uu,vv);vec3 P=nA*uR+uu*(I+h1-.5)*CELLSZ+vv*(J+h2-.5)*CELLSZ,d=normalize(P);
float cf=1.,fo=0.,m0=0.,pt=0.;
${perKind("pre")}
float e=e3(d,true),m=pn(d*uFreq*2.2+vec3(30.,0.,0.),1),tt=1.-1.1*d.y*d.y-1.2*max(e,0.);
#if KIND==5
if(e<-.03||e>.6||tt<uSnow+TSN)REJECT;
#else
if(e<.015||e>.6||tt<uSnow+TSN)REJECT;
#endif
float sl=abs(uR+e3(normalize(P+uu*.8),true)*uAmp-(uR+e*uAmp))/.8;
${perKind("gate")}
${perKind("result")}
return vec4(-9999.,0.,0.,0.);}`;
