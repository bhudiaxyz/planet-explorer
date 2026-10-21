import * as THREE from "three";
import { T, TERRAIN_GLSL, BIOME_GLSL } from "./gpu";
import { S } from "./settings";
import { CFG } from "./config";
const CELL = CFG.chunk.cell.toFixed(2);
// GPU "compute" via render-to-texture: the terrain function is evaluated on the GPU once (rebuild / chunk load / lattice move), never per frame.
let renderer: THREE.WebGLRenderer | null = null;
export const setRenderer = (r: THREE.WebGLRenderer) => {
  renderer = r;
};
export const canBake = () =>
  !!renderer && renderer.extensions.has("EXT_color_buffer_float");
const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
quad.frustumCulled = false;
const quadScene = new THREE.Scene();
quadScene.add(quad);
const quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
export const makeRT = (w: number, h: number) =>
  new THREE.WebGLRenderTarget(w, h, {
    type: canBake() ? THREE.FloatType : THREE.HalfFloatType,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: false,
    generateMipmaps: false,
  });
function renderToTarget(
  rt: THREE.WebGLRenderTarget,
  scene: THREE.Scene,
) {
  const prev = renderer!.getRenderTarget();
  renderer!.setRenderTarget(rt);
  renderer!.render(scene, quadCamera);
  renderer!.setRenderTarget(prev);
}
export function draw(rt: THREE.WebGLRenderTarget, mat: THREE.Material) {
  quad.material = mat;
  renderToTarget(rt, quadScene);
}
export const QUAD_VS = "void main(){gl_Position=vec4(position.xy,0.,1.);}";
const uCh = { value: new THREE.Vector3() };
const CHFS = `
uniform vec3 uCh;
${TERRAIN_GLSL}
${BIOME_GLSL}
void main() {
  vec2 L = floor(gl_FragCoord.xy);
  vec3 nA, uu, vv;
  basis(uCh.z, nA, uu, vv);
  vec3  P  = nA * uR + uu * (uCh.x + L.x) * ${CELL} + vv * (uCh.y + L.y) * ${CELL};
  vec3  d0 = normalize(P);
  vec3  d1 = normalize(P + uu * ${CELL});
  vec3  d2 = normalize(P + vv * ${CELL});
  float e  = e3(d0, true);
  vec3  p0 = d0 * (uR + e            * uAmp);
  vec3  p1 = d1 * (uR + e3(d1, true) * uAmp);
  vec3  p2 = d2 * (uR + e3(d2, true) * uAmp);
  vec3  n  = normalize(cross(p1 - p0, p2 - p0));
#ifdef COL
  float em = (e3(normalize(P + uu * ${CELL}), true) + e3(normalize(P - uu * ${CELL}), true)
            + e3(normalize(P + vv * ${CELL}), true) + e3(normalize(P - vv * ${CELL}), true)) * .25;
  float ao = 1. - clamp((em - e) * uAmp * 1.2, 0., .35) + clamp((e - em) * uAmp * .4, 0., .1);
  gl_FragColor = vec4(biome(d0, e, pn(d0 * uFreq * 2.2 + vec3(30., 0., 0.), 1), n) * ao, 1.);
#else
  gl_FragColor = vec4(e, n);
#endif
}`;
const makeChunkMat = (isColor: boolean) =>
  new THREE.ShaderMaterial({
    defines: isColor ? { COL: "" } : {},
    uniforms: { ...T, uCh },
    vertexShader: QUAD_VS,
    fragmentShader: CHFS,
  });
const chunkNormalMat = makeChunkMat(false),
  chunkColorMat = makeChunkMat(true);
// per chunk: rt = (elevation, normal.xyz), rtC = biome colour. Both are sampled by the chunk vertex shader; nothing is evaluated per frame.
export function bakeChunk(
  rt: THREE.WebGLRenderTarget,
  rtC: THREE.WebGLRenderTarget,
  i0: number,
  j0: number,
  face: number,
) {
  uCh.value.set(i0, j0, face);
  draw(rt, chunkNormalMat);
  draw(rtC, chunkColorMat);
}
const PV = `
varying vec4 vO;
uniform float uW, uH, uRes, uStep;
${TERRAIN_GLSL}
${BIOME_GLSL}
#if MODE == 4
attribute vec3 nrm;
attribute vec2 em;
#endif
float cg(vec3 n, vec3 u, vec3 v, float a, float b) {
  vec3 q = normalize(n + u * (2. * a / uRes - 1.) + v * (2. * b / uRes - 1.));
  return uR + e3(q, false) * uAmp - ${CFG.chunk.drop.toFixed(1)};
}
vec4 comp(vec3 d) {
#if MODE == 0
  return vec4(e3(d, false), pn(d * uFreq * 2.2 + vec3(30., 0., 0.), 1), 0., 0.);
#elif MODE == 1
  float e  = e3(d, true);
  float mo = pn(d * uFreq * 2.2 + vec3(30., 0., 0.), 1);
  vec3  c  = cross(d, vec3(0., 1., 0.));
  if (dot(c, c) < 1e-8) c = vec3(1., 0., 0.);
  vec3  t  = normalize(normalize(c) * .01 + d);
  return vec4(e, mo, treeDensity(d, mo), abs(uR + e3(t, true) * uAmp - (uR + e * uAmp)) / (.01 * uR));
#elif MODE == 3
  vec3 c = cross(d, vec3(0., 1., 0.));
  if (dot(c, c) < 1e-8) c = vec3(1., 0., 0.);
  vec3 t1 = normalize(c), t2 = cross(d, t1);
  vec3 d1 = normalize(d + t1 * uStep), d2 = normalize(d + t2 * uStep);
  vec3 p0 = d  * (uR + e3(d,  false) * uAmp);
  vec3 p1 = d1 * (uR + e3(d1, false) * uAmp);
  vec3 p2 = d2 * (uR + e3(d2, false) * uAmp);
  vec3 n  = normalize(cross(p1 - p0, p2 - p0));
  if (dot(n, d) < 0.) n = -n;
  return vec4(n, 0.);
#elif MODE == 4
  return vec4(biome(d, em.x, em.y, nrm), 1.);
#elif MODE == 5
  return vec4(pn(d * uFreq * 11. + vec3(0., 0., 77.), 1), 0., 0., 0.);
#else
  vec3  a  = abs(d);
  int   f  = (a.x >= a.y && a.x >= a.z) ? 0 : ((a.y >= a.z) ? 1 : 2);
  vec3  n  = vec3(0.);
  n[f] = d[f] < 0. ? -1. : 1.;
  vec3  u  = f == 1 ? vec3(1., 0., 0.) : vec3(0., 1., 0.);
  vec3  v  = cross(n, u);
  float dn = dot(d, n), N = uRes;
  float A   = ((dot(d, u) / dn + 1.) / 2.) * N;
  float B   = ((dot(d, v) / dn + 1.) / 2.) * N;
  float i   = min(N - 1., floor(A)), j = min(N - 1., floor(B));
  float fa  = A - i, fb = B - j;
  float r00 = cg(n, u, v, i, j);
  float r   = fa + fb <= 1.
    ? r00 + fa * (cg(n, u, v, i + 1., j) - r00) + fb * (cg(n, u, v, i, j + 1.) - r00)
    : cg(n, u, v, i + 1., j + 1.)
      + (1. - fa) * (cg(n, u, v, i, j + 1.) - cg(n, u, v, i + 1., j + 1.))
      + (1. - fb) * (cg(n, u, v, i + 1., j) - cg(n, u, v, i + 1., j + 1.));
  return vec4(r, 0., 0., 0.);
#endif
}
void main() {
  float id = float(gl_VertexID);
  float x  = mod(id, 2048.) + .5;
  float y  = floor(id / 2048.) + .5;
  vO = comp(position);
  gl_PointSize = 1.;
  gl_Position  = vec4(x / uW * 2. - 1., y / uH * 2. - 1., 0., 1.);
}`;
// Bulk point sampling with read-back. 0: base (elev, moisture) · 1: tree candidates (elev, moisture, tree density, slope) · 2: coarse-mesh radius · 3: base analytic normals · 4: base biome colours · 5: forest stand noise
export async function bakePoints(
  dirs: Float32Array,
  mode: number,
  extra?: { nrm: Float32Array; em: Float32Array },
): Promise<Float32Array> {
  const pointCount = dirs.length / 3,
    texWidth = 2048,
    texHeight = Math.max(1, Math.ceil(pointCount / texWidth)),
    rt = makeRT(texWidth, texHeight);
  const bakeMat = new THREE.ShaderMaterial({
    defines: { MODE: mode },
    depthTest: false,
    depthWrite: false,
    uniforms: {
      ...T,
      uW: { value: texWidth },
      uH: { value: texHeight },
      uRes: { value: S.resolution },
      uStep: { value: 1.57 / S.resolution },
    },
    vertexShader: PV,
    fragmentShader: "varying vec4 vO;void main(){gl_FragColor=vO;}",
  });
  const pointsGeo = new THREE.BufferGeometry().setAttribute(
    "position",
    new THREE.BufferAttribute(dirs, 3),
  );
  if (extra) {
    pointsGeo.setAttribute("nrm", new THREE.BufferAttribute(extra.nrm, 3));
    pointsGeo.setAttribute("em", new THREE.BufferAttribute(extra.em, 2));
  }
  const pointsMesh = new THREE.Points(pointsGeo, bakeMat),
    bakeScene = new THREE.Scene();
  pointsMesh.frustumCulled = false;
  bakeScene.add(pointsMesh);
  renderToTarget(rt, bakeScene);
  const results = new Float32Array(texWidth * texHeight * 4);
  const r: any = renderer!;
  if (typeof r.readRenderTargetPixelsAsync === "function")
    await r.readRenderTargetPixelsAsync(rt, 0, 0, texWidth, texHeight, results);
  else
    renderer!.readRenderTargetPixels(rt, 0, 0, texWidth, texHeight, results);
  rt.dispose();
  bakeMat.dispose();
  pointsGeo.dispose();
  return results;
}

// small texture read-back for CPU collision (async when the renderer supports it, so there is no pipeline stall)
export function readRT(
  renderTarget: THREE.WebGLRenderTarget,
  width: number,
  height: number,
  callback: (a: Float32Array) => void,
) {
  const pixelBuffer = new Float32Array(width * height * 4),
    rendererAny: any = renderer;
  if (typeof rendererAny.readRenderTargetPixelsAsync === "function")
    rendererAny
      .readRenderTargetPixelsAsync(renderTarget, 0, 0, width, height, pixelBuffer)
      .then(() => callback(pixelBuffer))
      .catch(() => {});
  else {
    renderer!.readRenderTargetPixels(
      renderTarget,
      0,
      0,
      width,
      height,
      pixelBuffer,
    );
    callback(pixelBuffer);
  }
}

// ---- Planet cube maps. The coarse planet mesh used to carry per-vertex colours/normals, which showed as a triangle grid, cube-face seams, a mismatch with the
// detailed chunks, and shimmering at altitude. Now normal+AO and biome colour are baked per pixel (512² per face, fine terrain function) into mip-mapped cube maps
// and sampled by direction: seamless, trilinear-filtered, identical in character to the chunks. Baked one face per frame (no hitch), then cross-faded in.
const atlasUniform = { value: new THREE.Vector2(0, 512) };
const ATFS = `
uniform vec2 uAt;
uniform samplerCube uSrcN;
${TERRAIN_GLSL}
${BIOME_GLSL}
vec3 faceDir(float f, vec2 s) {
  if (f < .5)  return vec3( 1., -s.y, -s.x);
  if (f < 1.5) return vec3(-1., -s.y,  s.x);
  if (f < 2.5) return vec3( s.x,  1.,  s.y);
  if (f < 3.5) return vec3( s.x, -1., -s.y);
  if (f < 4.5) return vec3( s.x, -s.y,  1.);
  return vec3(-s.x, -s.y, -1.);
}
void main() {
  vec2 st  = gl_FragCoord.xy / uAt.y * 2. - 1.;
  float da = 2. / uAt.y;
  vec3  d0 = normalize(faceDir(uAt.x, st));
#ifdef COL
  vec4  nn = textureLod(uSrcN, d0, 0.);
  float e  = e3(d0, true);
  gl_FragColor = vec4(biome(d0, e, pn(d0 * uFreq * 2.2 + vec3(30., 0., 0.), 1), normalize(nn.xyz)) * nn.w, e);
#else
  vec3  d1 = normalize(faceDir(uAt.x, st + vec2(da,  0.)));
  vec3  d2 = normalize(faceDir(uAt.x, st + vec2( 0., da)));
  vec3  d3 = normalize(faceDir(uAt.x, st - vec2(da,  0.)));
  vec3  d4 = normalize(faceDir(uAt.x, st - vec2( 0., da)));
  float e  = e3(d0, true);
  float ea = e3(d1, true), eb = e3(d2, true), ec = e3(d3, true), ed = e3(d4, true);
  vec3  p0 = d0 * (uR + e  * uAmp);
  vec3  p1 = d1 * (uR + ea * uAmp);
  vec3  p2 = d2 * (uR + eb * uAmp);
  vec3  n  = normalize(cross(p1 - p0, p2 - p0));
  if (dot(n, d0) < 0.) n = -n;
  float em = (ea + eb + ec + ed) * .25;
  float ao = 1. - clamp((em - e) * uAmp * .6, 0., .35) + clamp((e - em) * uAmp * .2, 0., .1);
  gl_FragColor = vec4(n, ao);
#endif
}`;
const makeAtlasMat = (isColor: boolean) =>
  new THREE.ShaderMaterial({
    defines: isColor ? { COL: "" } : {},
    uniforms: { ...T, uAt: atlasUniform, uSrcN: { value: null as any } },
    vertexShader: QUAD_VS,
    fragmentShader: ATFS,
  });
export class Atlas {
  rtN: THREE.WebGLCubeRenderTarget;
  rtC: THREE.WebGLCubeRenderTarget;
  face = 6;
  private normalAtlasMat = makeAtlasMat(false);
  private colorAtlasMat = makeAtlasMat(true);
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
    this.colorAtlasMat.uniforms.uSrcN.value = this.rtN.texture;
  }
  reset() {
    this.face = 0;
  }
  get done() {
    return this.face >= 6;
  }
  step() {
    if (this.done) return;
    const faceIndex = this.face++;
    atlasUniform.value.x = faceIndex;
    for (const [rt, mat] of [
      [this.rtN, this.normalAtlasMat],
      [this.rtC, this.colorAtlasMat],
    ] as [THREE.WebGLCubeRenderTarget, THREE.ShaderMaterial][]) {
      quad.material = mat;
      const prev = renderer!.getRenderTarget();
      renderer!.setRenderTarget(rt, faceIndex);
      renderer!.render(quadScene, quadCamera);
      renderer!.setRenderTarget(prev);
    }
  }
}
