import * as THREE from "three";
import type { Planet } from "./planet";
import { frame, sm } from "./util";
import { T, TERRAIN_GLSL } from "./gpu";
import { makeRT, draw, QUAD_VS, readRT } from "./bake";
import { U, TINT_GLSL } from "./fx";
import {
  PLANTS,
  type PlantSpec,
  type Tier,
  decideGLSL,
  lookGLSL,
} from "./plants";
const V = THREE.Vector3;

// GPU ground cover. Layer = one plant type at one distance tier. Placement is decided in a bake pass (one texel per instance cell) that reruns only when the
// lattice centre moves; the per-frame vertex shader reads that texel, rebuilds orientation/scale/tint from hashes (catalog `look`), applies wind, lean, player
// push, and collapses rejected cells. Tier lifecycle (no dithering): scale = outer·inner·uVeg, both smoothsteps of the plant's true distance:
//   outer = 1 - smoothstep(TO_FULL, TO_GONE, dist)   a tier GROWS from nothing as you approach its outer limit
//   inner = smoothstep(TI_GONE, TI_FULL, dist)       a tier shrinks away only after the next, more detailed tier is (nearly) full-size
// so every plant is always covered by at least one mesh at its true size, and detail only ever appears by growing.
const DECIDE = decideGLSL();
const BEGIN = `bool kill=dot(aCell,aCell)>uK*uK;vec3 gP=vec3(0.),gN=vec3(0.,1.,0.),tint=vec3(1.);
{vec4 Dv=texelFetch(uP,ivec2(aCell+uK+.5),0);float D=Dv.x;kill=kill||D<-5000.;
if(!kill){float I=uSC.x+aCell.x,J=uSC.y+aCell.y,F=uSC.z,h1=hs(I,J,F),h2=hs(I,J,F+9.),h3=hs(I,J,F+17.),h7=hs(I,J,F+23.);
vec3 nA,uu,vv;basis(F,nA,uu,vv);vec3 d=normalize(nA*uR+uu*(I+h1-.5)*CELLSZ+vv*(J+h2-.5)*CELLSZ),sc=vec3(1.);
${lookGLSL()}
float dist=length(d*(uR+D)-cameraPosition);
sc*=vec3(SCW,SCH,SCW)*((1.-smoothstep(TO_FULL,TO_GONE,dist))*smoothstep(TI_GONE,TI_FULL,dist)*uVeg);
vec3 t1=normalize(cross(d,abs(d.y)<.99?vec3(0.,1.,0.):vec3(1.,0.,0.))),t2=cross(d,t1);float ca=cos(h3*6.283),sa=sin(h3*6.283);
vec3 ax=t1*ca+t2*sa,az=cross(ax,d);
#if DISP
vec3 pp=position+normal*(hs(position.x*9.+I,position.y*9.+J,position.z*9.+F)-.5)*.22;
#else
vec3 pp=position;
#endif
vec3 u2=normalize(d+(ax*(h1-.5)+az*(h2-.5))*LEAN),lp=pp*sc;float y=max(lp.y,0.),a=uWind*WK*y*y,ph=I*.11+J*.13;
gP=d*(uR+D-.03)+ax*lp.x+u2*lp.y+az*lp.z+(ax*sin(uTime*1.6+ph+y*.3)+az*cos(uTime*1.3+ph*1.3+y*.2))*a;
#if PUSH
{vec3 tp=d*(uR+D)-uPl,pr=tp-d*dot(tp,d);float pu=1.-smoothstep(.3,1.5,length(tp));gP+=normalize(pr+d*.001)*pu*y*.5-d*pu*lp.y*.3;}
#endif
gN=normalize(ax*normal.x+u2*normal.y+az*normal.z);
#if MOSS
tint=mix(tint,vec3(.32,.77,.25),smoothstep(.6,.95,clamp(dot(gN,d),0.,1.))*step(.55,h1)*.7);
#endif
}}
vec3 objectNormal=gN;
#ifdef USE_COLOR
vColor.rgb*=tint;
#endif`;

class Layer {
  uSC = { value: new V() };
  mesh: THREE.Mesh;
  rt: THREE.WebGLRenderTarget;
  bake: THREE.ShaderMaterial;
  readonly kind: number;
  readonly cell: number;
  readonly K: number;
  readonly near: boolean;
  fr = frame(new V(0, 1, 0), 1, 1);
  lf = -1;
  li = 0;
  lj = 0; // last baked lattice (face, i, j)
  collide = false;
  pix: Float32Array | null = null;
  psnap: { i: number; j: number; f: number } | null = null;
  onData?: () => void;
  private seq = 0;
  private acc = 0;
  constructor(spec: PlantSpec, tier: Tier) {
    this.kind = spec.kind;
    this.cell = tier.cell;
    this.K = tier.K;
    this.near = tier.near;
    const geo = tier.geo(),
      K = tier.K,
      n = 2 * K + 1;
    const g = new THREE.InstancedBufferGeometry();
    if (geo.index) g.setIndex(geo.index);
    for (const k in geo.attributes) g.setAttribute(k, geo.attributes[k]);
    const cells: number[] = [];
    for (let y = -K; y <= K; y++)
      for (let x = -K; x <= K; x++)
        if (x * x + y * y <= K * K) cells.push(x, y); // only cells inside the disc are instanced
    g.setAttribute(
      "aCell",
      new THREE.InstancedBufferAttribute(new Float32Array(cells), 2),
    );
    g.instanceCount = cells.length / 2;
    const [of, og, ig, if_] = tier.lod,
      f = (v: number) => v.toFixed(2);
    const defines = {
      KIND: spec.kind,
      PMUL: tier.pmul.toFixed(1),
      CELLSZ: f(tier.cell),
      WK: spec.wind.toFixed(3),
      TSN: spec.hardy ? ".02" : ".14",
      TO_FULL: of.toFixed(1),
      TO_GONE: og.toFixed(1),
      TI_GONE: ig.toFixed(1),
      TI_FULL: if_.toFixed(1),
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
      fragmentShader: `uniform vec3 uSC;uniform float uK;${TERRAIN_GLSL}
${DECIDE}
void main(){vec2 L=floor(gl_FragCoord.xy)-vec2(uK);gl_FragColor=decide(uSC.x+L.x,uSC.y+L.y,uSC.z);}`,
    });
    const m = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 1,
      side: spec.dbl ? THREE.DoubleSide : THREE.FrontSide,
    });
    m.defines = defines;
    m.onBeforeCompile = (s) => {
      Object.assign(s.uniforms, T, {
        uTime: U.uTime,
        uWind: U.uWind,
        uVeg: U.uVeg,
        uPl: U.uPl,
        uSun: U.uSun,
        uDayF: U.uDayF,
        uSC: this.uSC,
        uK,
        uP: { value: this.rt.texture },
      });
      s.vertexShader = s.vertexShader
        .replace(
          "#include <common>",
          `#include <common>\nattribute vec2 aCell;uniform vec3 uSC,uPl;uniform float uK,uTime,uWind,uVeg;uniform sampler2D uP;\n${TERRAIN_GLSL}`,
        )
        .replace("#include <beginnormal_vertex>", BEGIN)
        .replace("#include <begin_vertex>", "vec3 transformed=gP;")
        .replace(
          "#include <project_vertex>",
          "#include <project_vertex>\nif(kill)gl_Position=vec4(2.,2.,2.,1.);",
        );
      s.fragmentShader = s.fragmentShader
        .replace(
          "#include <common>",
          "#include <common>\nuniform vec3 uSun;uniform float uDayF;",
        )
        .replace(
          "#include <emissivemap_fragment>",
          `#include <emissivemap_fragment>\n{vec3 sv=normalize((viewMatrix*vec4(uSun,0.)).xyz);float tr=pow(clamp(dot(-normalize(vViewPosition),sv),0.,1.),3.)*uDayF;totalEmissiveRadiance+=diffuseColor.rgb*tr*${spec.kind === 0 ? ".9" : ".3"};}\n${TINT_GLSL}`,
        );
    };
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
  }
  /** Rebakes placement when the lattice centre moved. Returns true if a bake happened (so the caller can budget bakes per frame). */
  update(d: THREE.Vector3, R: number, allow = true): boolean {
    const fr = frame(d, R, this.cell, this.fr);
    if (fr.f === this.lf && fr.i === this.li && fr.j === this.lj) return false;
    if (!allow) return false;
    this.lf = fr.f;
    this.li = fr.i;
    this.lj = fr.j;
    const code = fr.f * 2 + (fr.n.getComponent(fr.f) < 0 ? 1 : 0);
    this.uSC.value.set(fr.i, fr.j, code);
    draw(this.rt, this.bake);
    if (this.collide) {
      // tiny async read-back so the CPU collider sees exactly the plants the shader draws
      const sn = { i: fr.i, j: fr.j, f: code },
        my = ++this.seq,
        n = 2 * this.K + 1;
      readRT(this.rt, n, n, (a) => {
        if (my < this.acc) return;
        this.acc = my;
        this.pix = a;
        this.psnap = sn;
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
  private rr = 0;
  constructor(private pl: Planet) {
    for (const spec of PLANTS)
      for (const tier of spec.tiers) {
        const l = new Layer(spec, tier);
        if (spec.collide && tier.near) {
          l.collide = true;
          l.onData = () => this.version++;
        }
        this.layers.push(l);
        this.group.add(l.mesh);
      }
  }
  update(d: THREE.Vector3, alt: number) {
    U.uVeg.value = 1 - sm(150, 250, alt);
    this.group.visible = alt < 255;
    if (this.dirty) {
      this.layers.forEach((l) => (l.lf = -1));
      this.dirty = false;
    }
    if (alt >= 255) return;
    let budget = 4;
    const n = this.layers.length,
      s = this.rr;
    this.rr = (this.rr + 1) % n; // at most 4 placement bakes per frame, round-robin
    for (let i = 0; i < n; i++)
      if (this.layers[(s + i) % n].update(d, this.pl.R, budget > 0)) budget--;
  }
}
