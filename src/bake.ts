import * as THREE from "three";
import { T, TERRAIN_GLSL, BIOME_GLSL } from "./gpu";
import { S } from "./settings";
import { CFG } from "./config";
const CELL = CFG.chunk.cell.toFixed(2);
// GPU "compute" via render-to-texture: the terrain function is evaluated on the GPU once (rebuild / chunk load / lattice move), never per frame.
let R: THREE.WebGLRenderer | null = null;
export const setRenderer = (r: THREE.WebGLRenderer) => {
  R = r;
};
export const canBake = () => !!R && R.extensions.has("EXT_color_buffer_float");
const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
quad.frustumCulled = false;
const qs = new THREE.Scene();
qs.add(quad);
const qc = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
export const makeRT = (w: number, h: number) =>
  new THREE.WebGLRenderTarget(w, h, {
    type: canBake() ? THREE.FloatType : THREE.HalfFloatType,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: false,
    generateMipmaps: false,
  });
function pass(rt: THREE.WebGLRenderTarget, scene: THREE.Scene) {
  const prev = R!.getRenderTarget();
  R!.setRenderTarget(rt);
  R!.render(scene, qc);
  R!.setRenderTarget(prev);
}
export function draw(rt: THREE.WebGLRenderTarget, mat: THREE.Material) {
  quad.material = mat;
  pass(rt, qs);
}
export const QUAD_VS = "void main(){gl_Position=vec4(position.xy,0.,1.);}";
const uCh = { value: new THREE.Vector3() };
const CHFS = `uniform vec3 uCh;${TERRAIN_GLSL}${BIOME_GLSL}
void main(){vec2 L=floor(gl_FragCoord.xy);vec3 nA,uu,vv;basis(uCh.z,nA,uu,vv);vec3 P=nA*uR+uu*(uCh.x+L.x)*${CELL}+vv*(uCh.y+L.y)*${CELL},d0=normalize(P),d1=normalize(P+uu*${CELL}),d2=normalize(P+vv*${CELL});
float e=e3(d0,true);vec3 p0=d0*(uR+e*uAmp),p1=d1*(uR+e3(d1,true)*uAmp),p2=d2*(uR+e3(d2,true)*uAmp),n=normalize(cross(p1-p0,p2-p0));
#ifdef COL
float em=(e3(normalize(P+uu*${CELL}),true)+e3(normalize(P-uu*${CELL}),true)+e3(normalize(P+vv*${CELL}),true)+e3(normalize(P-vv*${CELL}),true))*.25;
float ao=1.-clamp((em-e)*uAmp*1.2,0.,.35)+clamp((e-em)*uAmp*.4,0.,.1);
gl_FragColor=vec4(biome(d0,e,pn(d0*uFreq*2.2+vec3(30.,0.,0.),1),n)*ao,1.);
#else
gl_FragColor=vec4(e,n);
#endif
}`;
const mkCh = (col: boolean) =>
  new THREE.ShaderMaterial({
    defines: col ? { COL: "" } : {},
    uniforms: { ...T, uCh },
    vertexShader: QUAD_VS,
    fragmentShader: CHFS,
  });
const chH = mkCh(false),
  chC = mkCh(true);
// per chunk: rt = (elevation, normal.xyz), rtC = biome colour. Both are sampled by the chunk vertex shader; nothing is evaluated per frame.
export function bakeChunk(
  rt: THREE.WebGLRenderTarget,
  rtC: THREE.WebGLRenderTarget,
  i0: number,
  j0: number,
  face: number,
) {
  uCh.value.set(i0, j0, face);
  draw(rt, chH);
  draw(rtC, chC);
}
const PV = `varying vec4 vO;uniform float uW,uH,uRes,uStep;${TERRAIN_GLSL}${BIOME_GLSL}
#if MODE==4
attribute vec3 nrm;attribute vec2 em;
#endif
float cg(vec3 n,vec3 u,vec3 v,float a,float b){vec3 q=normalize(n+u*(2.*a/uRes-1.)+v*(2.*b/uRes-1.));return uR+e3(q,false)*uAmp-${CFG.chunk.drop.toFixed(1)};}
vec4 comp(vec3 d){
#if MODE==0
return vec4(e3(d,false),pn(d*uFreq*2.2+vec3(30.,0.,0.),1),0.,0.);
#elif MODE==1
float e=e3(d,true),mo=pn(d*uFreq*2.2+vec3(30.,0.,0.),1);vec3 c=cross(d,vec3(0.,1.,0.));if(dot(c,c)<1e-8)c=vec3(1.,0.,0.);vec3 t=normalize(normalize(c)*.01+d);
return vec4(e,mo,treeDensity(d,mo),abs(uR+e3(t,true)*uAmp-(uR+e*uAmp))/(.01*uR));
#elif MODE==3
vec3 c=cross(d,vec3(0.,1.,0.));if(dot(c,c)<1e-8)c=vec3(1.,0.,0.);vec3 t1=normalize(c),t2=cross(d,t1),d1=normalize(d+t1*uStep),d2=normalize(d+t2*uStep);
vec3 p0=d*(uR+e3(d,false)*uAmp),p1=d1*(uR+e3(d1,false)*uAmp),p2=d2*(uR+e3(d2,false)*uAmp),n=normalize(cross(p1-p0,p2-p0));if(dot(n,d)<0.)n=-n;return vec4(n,0.);
#elif MODE==4
return vec4(biome(d,em.x,em.y,nrm),1.);
#elif MODE==5
return vec4(pn(d*uFreq*11.+vec3(0.,0.,77.),1),0.,0.,0.);
#else
vec3 a=abs(d);int f=(a.x>=a.y&&a.x>=a.z)?0:((a.y>=a.z)?1:2);vec3 n=vec3(0.);n[f]=d[f]<0.?-1.:1.;vec3 u=f==1?vec3(1.,0.,0.):vec3(0.,1.,0.),v=cross(n,u);float dn=dot(d,n),N=uRes;
float A=((dot(d,u)/dn+1.)/2.)*N,B=((dot(d,v)/dn+1.)/2.)*N,i=min(N-1.,floor(A)),j=min(N-1.,floor(B)),fa=A-i,fb=B-j,r00=cg(n,u,v,i,j);
float r=fa+fb<=1.?r00+fa*(cg(n,u,v,i+1.,j)-r00)+fb*(cg(n,u,v,i,j+1.)-r00):cg(n,u,v,i+1.,j+1.)+(1.-fa)*(cg(n,u,v,i,j+1.)-cg(n,u,v,i+1.,j+1.))+(1.-fb)*(cg(n,u,v,i+1.,j)-cg(n,u,v,i+1.,j+1.));
return vec4(r,0.,0.,0.);
#endif
}
void main(){float id=float(gl_VertexID),x=mod(id,2048.)+.5,y=floor(id/2048.)+.5;vO=comp(position);gl_PointSize=1.;gl_Position=vec4(x/uW*2.-1.,y/uH*2.-1.,0.,1.);}`;
// Bulk point sampling with read-back. 0: base (elev, moisture) · 1: tree candidates (elev, moisture, tree density, slope) · 2: coarse-mesh radius · 3: base analytic normals · 4: base biome colours · 5: forest stand noise
export function bakePoints(
  dirs: Float32Array,
  mode: number,
  extra?: { nrm: Float32Array; em: Float32Array },
) {
  const n = dirs.length / 3,
    W = 2048,
    H = Math.max(1, Math.ceil(n / W)),
    rt = makeRT(W, H);
  const mat = new THREE.ShaderMaterial({
    defines: { MODE: mode },
    depthTest: false,
    depthWrite: false,
    uniforms: {
      ...T,
      uW: { value: W },
      uH: { value: H },
      uRes: { value: S.resolution },
      uStep: { value: 1.57 / S.resolution },
    },
    vertexShader: PV,
    fragmentShader: "varying vec4 vO;void main(){gl_FragColor=vO;}",
  });
  const g = new THREE.BufferGeometry().setAttribute(
    "position",
    new THREE.BufferAttribute(dirs, 3),
  );
  if (extra) {
    g.setAttribute("nrm", new THREE.BufferAttribute(extra.nrm, 3));
    g.setAttribute("em", new THREE.BufferAttribute(extra.em, 2));
  }
  const p = new THREE.Points(g, mat),
    sc = new THREE.Scene();
  p.frustumCulled = false;
  sc.add(p);
  pass(rt, sc);
  const out = new Float32Array(W * H * 4);
  R!.readRenderTargetPixels(rt, 0, 0, W, H, out);
  rt.dispose();
  mat.dispose();
  g.dispose();
  return out;
}

// small texture read-back for CPU collision (async when the renderer supports it, so there is no pipeline stall)
export function readRT(
  rt: THREE.WebGLRenderTarget,
  w: number,
  h: number,
  cb: (a: Float32Array) => void,
) {
  const buf = new Float32Array(w * h * 4),
    r: any = R;
  if (typeof r.readRenderTargetPixelsAsync === "function")
    r.readRenderTargetPixelsAsync(rt, 0, 0, w, h, buf)
      .then(() => cb(buf))
      .catch(() => {});
  else {
    R!.readRenderTargetPixels(rt, 0, 0, w, h, buf);
    cb(buf);
  }
}

// ---- Planet cube maps. The coarse planet mesh used to carry per-vertex colours/normals, which showed as a triangle grid, cube-face seams, a mismatch with the
// detailed chunks, and shimmering at altitude. Now normal+AO and biome colour are baked per pixel (512² per face, fine terrain function) into mip-mapped cube maps
// and sampled by direction: seamless, trilinear-filtered, identical in character to the chunks. Baked one face per frame (no hitch), then cross-faded in.
const atU = { value: new THREE.Vector2(0, 512) };
const ATFS = `uniform vec2 uAt;uniform samplerCube uSrcN;${TERRAIN_GLSL}${BIOME_GLSL}
vec3 faceDir(float f,vec2 s){if(f<.5)return vec3(1.,-s.y,-s.x);if(f<1.5)return vec3(-1.,-s.y,s.x);if(f<2.5)return vec3(s.x,1.,s.y);if(f<3.5)return vec3(s.x,-1.,-s.y);if(f<4.5)return vec3(s.x,-s.y,1.);return vec3(-s.x,-s.y,-1.);}
void main(){vec2 st=gl_FragCoord.xy/uAt.y*2.-1.;float da=2./uAt.y;vec3 d0=normalize(faceDir(uAt.x,st));
#ifdef COL
vec4 nn=textureLod(uSrcN,d0,0.);float e=e3(d0,true);gl_FragColor=vec4(biome(d0,e,pn(d0*uFreq*2.2+vec3(30.,0.,0.),1),normalize(nn.xyz))*nn.w,e);
#else
vec3 d1=normalize(faceDir(uAt.x,st+vec2(da,0.))),d2=normalize(faceDir(uAt.x,st+vec2(0.,da))),d3=normalize(faceDir(uAt.x,st-vec2(da,0.))),d4=normalize(faceDir(uAt.x,st-vec2(0.,da)));
float e=e3(d0,true),ea=e3(d1,true),eb=e3(d2,true),ec=e3(d3,true),ed=e3(d4,true);
vec3 p0=d0*(uR+e*uAmp),p1=d1*(uR+ea*uAmp),p2=d2*(uR+eb*uAmp),n=normalize(cross(p1-p0,p2-p0));if(dot(n,d0)<0.)n=-n;
float em=(ea+eb+ec+ed)*.25,ao=1.-clamp((em-e)*uAmp*.6,0.,.35)+clamp((e-em)*uAmp*.2,0.,.1);gl_FragColor=vec4(n,ao);
#endif
}`;
const mkAt = (col: boolean) =>
  new THREE.ShaderMaterial({
    defines: col ? { COL: "" } : {},
    uniforms: { ...T, uAt: atU, uSrcN: { value: null as any } },
    vertexShader: QUAD_VS,
    fragmentShader: ATFS,
  });
export class Atlas {
  rtN: THREE.WebGLCubeRenderTarget;
  rtC: THREE.WebGLCubeRenderTarget;
  face = 6;
  private mN = mkAt(false);
  private mC = mkAt(true);
  constructor() {
    const o = {
      type: THREE.HalfFloatType,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    };
    this.rtN = new THREE.WebGLCubeRenderTarget(512, o);
    this.rtC = new THREE.WebGLCubeRenderTarget(512, o);
    this.mC.uniforms.uSrcN.value = this.rtN.texture;
  }
  reset() {
    this.face = 0;
  }
  get done() {
    return this.face >= 6;
  }
  step() {
    if (this.done) return;
    const f = this.face++;
    atU.value.x = f;
    for (const [rt, m] of [
      [this.rtN, this.mN],
      [this.rtC, this.mC],
    ] as [THREE.WebGLCubeRenderTarget, THREE.ShaderMaterial][]) {
      quad.material = m;
      const prev = R!.getRenderTarget();
      R!.setRenderTarget(rt, f);
      R!.render(qs, qc);
      R!.setRenderTarget(prev);
    }
  }
}
