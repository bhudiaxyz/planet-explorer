import * as THREE from "three";
import type { Planet } from "./planet";
import { S, CFG } from "./config";
import { U } from "./fx";
import { gpuTier } from "./gputier";
import { rng } from "./noise";
import { RIVER_NAMES } from "./landmarknames";

// Chaikin corner-cutting: replaces each segment with two points at 1/4 and 3/4,
// preserving the first and last point so source/mouth stay in place.
function chaikin(pts: THREE.Vector3[], rounds: number): THREE.Vector3[] {
  let p = pts;
  for (let r = 0; r < rounds; r++) {
    const out: THREE.Vector3[] = [p[0]];
    for (let i = 0; i < p.length - 1; i++) {
      out.push(p[i].clone().lerp(p[i + 1], 0.25));
      out.push(p[i].clone().lerp(p[i + 1], 0.75));
    }
    out.push(p[p.length - 1]);
    p = out;
  }
  return p;
}

// Sinusoidal lateral displacement to create natural meanders.
// Applied before Chaikin so the smoothing blends the curves naturally.
// Envelope fades in at source (t<0.2) and out at mouth (t>0.85).
// Scratch for addMeanders — avoids allocs per path point
const _mSn    = new THREE.Vector3();
const _mTangent = new THREE.Vector3();
const _mRight = new THREE.Vector3();

function addMeanders(pts: THREE.Vector3[], rand: () => number): THREE.Vector3[] {
  if (pts.length < 4) return pts;
  const phase  = rand() * Math.PI * 2;
  const phase2 = rand() * Math.PI * 2;
  const freq1  = 0.08 + rand() * 0.07; // primary wave — controls spacing
  const freq2  = freq1 * 1.7 + rand() * 0.04; // secondary wave — breaks uniformity
  const amp    = 5  + rand() * 6;      // max lateral offset in metres
  return pts.map((pt, i) => {
    const t   = i / (pts.length - 1);
    const env = Math.min(t / 0.20, 1) * Math.min((1 - t) / 0.15, 1); // fade at ends
    // Two overlapping frequencies → irregular natural bends; C2: amplitude rises near mouth
    const terrainFactor = 0.4 + t * 0.6;
    const disp = (Math.sin(i * freq1 + phase) * 0.7 + Math.sin(i * freq2 + phase2) * 0.3)
                  * amp * env * terrainFactor;
    if (Math.abs(disp) < 0.01) return pt;
    _mSn.copy(pt).normalize();
    const next = pts[Math.min(i + 1, pts.length - 1)];
    const prev = pts[Math.max(i - 1, 0)];
    _mTangent.copy(next).sub(prev).normalize();
    _mRight.crossVectors(_mTangent, _mSn).normalize();
    return pt.clone().addScaledVector(_mRight, disp);
  });
}

// Pick a river name seeded by path index + world seed so it's stable per planet
function riverName(index: number): string {
  return RIVER_NAMES[Math.abs(S.seed + index * 7) % RIVER_NAMES.length];
}

// Hoisted — rebuilt per call previously, wasting 1080+ short-lived arrays on a full planet build
const DIRS = [0, 1, 2, 3, 4, 5, 6, 7].map(i => (i * Math.PI) / 4);

const yieldFrame = () => new Promise<void>(r => setTimeout(r));

// Scratch vectors for path tracing — reused every step to avoid ~20k Vector3 allocations per build
const _s = {
  up:   new THREE.Vector3(),
  east: new THREE.Vector3(),
  north:new THREE.Vector3(),
  ref:  new THREE.Vector3(),
  off:  new THREE.Vector3(),
  nbr:  new THREE.Vector3(),
};
// Scratch for tributary junction math (~7 allocs × 12 tributaries per build)
const _tp = {
  jPt:   new THREE.Vector3(),
  fPrev: new THREE.Vector3(),
  fNext: new THREE.Vector3(),
  fDir:  new THREE.Vector3(),
  right: new THREE.Vector3(),
  start: new THREE.Vector3(),
};
// Scratch for source-finding loop (up to 500 attempts → was 500 allocs)
const _dirScratch = new THREE.Vector3();

export class RiverSystem {
  mesh!: THREE.Mesh;
  paths!: THREE.Vector3[][];
  names!: string[];

  // Async factory — yields between sources so the browser can repaint during path generation
  static async build(planet: Planet): Promise<RiverSystem> {
    const rs = new RiverSystem();
    const paths = await rs._generatePaths(planet);
    rs.paths = paths;
    rs.names = paths.map((_, i) => riverName(i));
    const geo = rs._buildGeometry(paths);
    const mat = rs._buildMaterial();
    rs.mesh = new THREE.Mesh(geo, mat);
    rs.mesh.frustumCulled = false;
    rs.mesh.renderOrder = 2;
    return rs;
  }

  dispose() {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.removeFromParent();
  }

  private async _generatePaths(planet: Planet): Promise<THREE.Vector3[][]> {
    const R = planet.radius;
    const cfg = CFG.river;
    // Reduce CPU path work on low-tier mobile (fewer rivers, shorter paths)
    const tierCount = gpuTier === 'low' ? Math.max(2, Math.ceil(cfg.count / 2)) : cfg.count;
    const tierMaxSteps = gpuTier === 'low' ? Math.ceil(cfg.maxSteps * 0.6) : cfg.maxSteps;
    const tierTributaries = gpuTier === 'low' ? 1 : cfg.tributaries;
    const rand = rng(S.seed + 9999);
    const cosMin = Math.cos((cfg.minSourceSpacingDeg * Math.PI) / 180);

    // Time-based yielding: yield only when ≥4 ms has elapsed, same as findSpots.
    // Replaces 26 unconditional setTimeout calls (100–400 ms overhead on mobile).
    let _lastYield = performance.now();
    const mayYield = async () => {
      const t = performance.now();
      if (t - _lastYield >= 4) { await yieldFrame(); _lastYield = performance.now(); }
    };

    // Find main river sources: high elevation, high moisture, well spaced
    const sources: THREE.Vector3[] = [];
    let attempts = 0;
    while (sources.length < tierCount && attempts < 500) {
      attempts++;
      await mayYield();
      // Random point on unit sphere — reuse scratch to avoid one alloc per attempt
      const u = rand() * 2 - 1;
      const phi = rand() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      _dirScratch.set(r * Math.cos(phi), u, r * Math.sin(phi));
      const elev = planet.elevationAt(_dirScratch.x, _dirScratch.y, _dirScratch.z, false);
      const moist = planet.moistureAt(_dirScratch);
      if (elev < cfg.sourceMinElev) continue;
      if (moist < cfg.sourceMinMoisture) continue;
      if (sources.some(s => s.dot(_dirScratch) > cosMin)) continue;
      sources.push(_dirScratch.clone());
    }

    const paths: THREE.Vector3[][] = [];
    // Tributaries use shorter paths — they're side branches, not full rivers
    const tribMaxSteps = Math.ceil(tierMaxSteps * 0.6);

    for (const src of sources) {
      await mayYield();
      const main = this._tracePath(src, planet, R, tierMaxSteps);
      if (main.length < 5) continue;
      paths.push(main);

      // Tributaries: evenly spread junctions across 20–65% of the main path
      for (let t = 0; t < tierTributaries; t++) {
        await mayYield();
        // Spread junctions evenly so tributaries don't all cluster at one point
        const frac = 0.20 + (t / Math.max(tierTributaries - 1, 1)) * 0.45 + (rand() - 0.5) * 0.08;
        const junctionIdx = Math.min(Math.floor(frac * main.length), main.length - 2);

        // Use the flow direction at the junction (not world-up) — works everywhere on sphere
        _tp.jPt.copy(main[junctionIdx]).normalize();
        _tp.fPrev.copy(main[Math.max(junctionIdx - 1, 0)]).normalize();
        _tp.fNext.copy(main[Math.min(junctionIdx + 1, main.length - 1)]).normalize();
        _tp.fDir.copy(_tp.fNext).sub(_tp.fPrev).normalize();
        _tp.right.crossVectors(_tp.fDir, _tp.jPt).normalize();

        // Alternate left/right, vary angle 15–30°
        const side  = t % 2 === 0 ? 1 : -1;
        const angle = (15 + rand() * 15) * (Math.PI / 180) * side;
        // Step upstream and sideways from the junction to find a plausible tributary source
        _tp.start.copy(_tp.jPt)
          .addScaledVector(_tp.right, Math.sin(angle) * 0.18)
          .addScaledVector(_tp.fDir.negate(), 0.08) // negate in-place; _tp.fDir not used after
          .normalize();

        const tElev = planet.elevationAt(_tp.start.x, _tp.start.y, _tp.start.z, false);
        if (tElev > cfg.sourceMinElev * 0.4) {
          const trib = this._tracePathToTarget(_tp.start, main[junctionIdx], planet, R, tribMaxSteps);
          if (trib.length >= 4) paths.push(trib);
        }
      }
    }

    // Low tier: skip meanders + Chaikin (saves CPU + memory)
    // Medium/high: add sinusoidal meanders then smooth with Chaikin
    if (gpuTier === 'low') return paths;
    const rounds = 2;
    return paths.map(p => chaikin(addMeanders(p, rand), rounds));
  }

  private _tracePath(source: THREE.Vector3, planet: Planet, R: number, maxSteps: number = CFG.river.maxSteps): THREE.Vector3[] {
    const cfg = CFG.river;
    const stepRad = cfg.stepSize / R;

    const path: THREE.Vector3[] = [];
    let cur = source.clone().normalize();
    let prevDir: THREE.Vector3 | null = null; // momentum: bias toward current direction

    for (let step = 0; step < maxSteps; step++) {
      const curElev = planet.elevationAt(cur.x, cur.y, cur.z, false);
      // Clamp to sea level so the ribbon doesn't sink below the ocean floor
      const surfElev = Math.max(0, curElev);
      path.push(cur.clone().multiplyScalar(R + surfElev * S.amplitude + cfg.surfaceOffset));

      if (curElev <= 0) break; // reached ocean/lake — stop here

      _s.up.copy(cur);
      if (Math.abs(_s.up.y) < 0.9) _s.ref.set(1, 0, 0); else _s.ref.set(0, 0, 1);
      _s.east.crossVectors(_s.up, _s.ref).normalize();
      _s.north.crossVectors(_s.east, _s.up).normalize();

      let bestScore = Infinity;
      let bestDir: THREE.Vector3 | null = null;
      for (const angle of DIRS) {
        _s.off.copy(_s.east).multiplyScalar(Math.cos(angle) * stepRad)
          .addScaledVector(_s.north, Math.sin(angle) * stepRad);
        _s.nbr.copy(cur).add(_s.off).normalize();
        const nElev = planet.elevationAt(_s.nbr.x, _s.nbr.y, _s.nbr.z, false);
        // momentum: small bonus for continuing in the same direction, prevents zigzag on flat terrain
        const momentum = prevDir ? (1 - _s.nbr.dot(prevDir)) * 0.012 : 0;
        const score = nElev + momentum;
        if (score < bestScore) {
          bestScore = score;
          bestDir = _s.nbr.clone(); // clone only the winner
        }
      }

      if (!bestDir) break;
      prevDir = bestDir;
      cur = bestDir;
    }

    return path;
  }

  private _tracePathToTarget(
    source: THREE.Vector3,
    target: THREE.Vector3,
    planet: Planet,
    R: number,
    maxSteps: number = CFG.river.maxSteps,
  ): THREE.Vector3[] {
    const cfg = CFG.river;
    const stepRad = cfg.stepSize / R;
    // Normalise target once; reused in distance check each step
    const targetN = target.clone().normalize();

    const path: THREE.Vector3[] = [];
    let cur = source.clone().normalize();

    for (let step = 0; step < maxSteps; step++) {
      const curElev = planet.elevationAt(cur.x, cur.y, cur.z, false);
      const surfElev = Math.max(0, curElev);
      path.push(cur.clone().multiplyScalar(R + surfElev * S.amplitude + cfg.surfaceOffset));

      if (cur.distanceTo(targetN) < stepRad * 3) break;
      if (curElev <= 0) break; // hit water — stop

      _s.up.copy(cur);
      if (Math.abs(_s.up.y) < 0.9) _s.ref.set(1, 0, 0); else _s.ref.set(0, 0, 1);
      _s.east.crossVectors(_s.up, _s.ref).normalize();
      _s.north.crossVectors(_s.east, _s.up).normalize();

      let bestScore = Infinity;
      let bestDir: THREE.Vector3 | null = null;
      for (const angle of DIRS) {
        _s.off.copy(_s.east).multiplyScalar(Math.cos(angle) * stepRad)
          .addScaledVector(_s.north, Math.sin(angle) * stepRad);
        _s.nbr.copy(cur).add(_s.off).normalize();
        const nElev = planet.elevationAt(_s.nbr.x, _s.nbr.y, _s.nbr.z, false);
        const distToTarget = _s.nbr.distanceTo(targetN);
        const score = nElev * 0.7 + distToTarget * 0.3;
        if (score < bestScore) {
          bestScore = score;
          bestDir = _s.nbr.clone(); // clone only the winner
        }
      }

      if (!bestDir) break;
      cur = bestDir;
    }

    return path;
  }

  private _buildGeometry(paths: THREE.Vector3[][]): THREE.BufferGeometry {
    const cfg = CFG.river;
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    const _bgTangent = new THREE.Vector3();
    const _bgNormal  = new THREE.Vector3();
    const _bgRight   = new THREE.Vector3();

    for (const path of paths) {
      if (path.length < 2) continue;
      const N = path.length;
      const baseVertex = positions.length / 3;

      // Compute arc-length for v coordinate
      const arcLen: number[] = [0];
      for (let i = 1; i < N; i++) {
        arcLen.push(arcLen[i - 1] + path[i].distanceTo(path[i - 1]));
      }
      const totalLen = arcLen[N - 1] || 1;

      for (let i = 0; i < N; i++) {
        const t = i / (N - 1);
        // Widen with quadratic ease-in, then taper fully to zero over the last 15%
        const taper = t > 0.85 ? 1.0 - (t - 0.85) / 0.15 : 1.0;
        const width = (cfg.widthStart + (cfg.widthEnd - cfg.widthStart) * (t * t)) * taper;
        const halfW = width * 0.5;

        // Sphere normal = outward unit direction from centre
        _bgNormal.copy(path[i]).normalize();

        // Tangent: direction of flow
        if (i < N - 1) _bgTangent.copy(path[i + 1]).sub(path[i]).normalize();
        else _bgTangent.copy(path[i]).sub(path[i - 1]).normalize();

        // Ribbon right = tangent × sphereNormal (cross gives perpendicular on sphere surface)
        _bgRight.crossVectors(_bgTangent, _bgNormal).normalize();

        // Left and right vertices
        const left = path[i].clone().addScaledVector(_bgRight, -halfW);
        const right3 = path[i].clone().addScaledVector(_bgRight, halfW);

        const v = arcLen[i] / totalLen;

        // Left vertex
        positions.push(left.x, left.y, left.z);
        normals.push(_bgNormal.x, _bgNormal.y, _bgNormal.z);
        uvs.push(0, v);

        // Right vertex
        positions.push(right3.x, right3.y, right3.z);
        normals.push(_bgNormal.x, _bgNormal.y, _bgNormal.z);
        uvs.push(1, v);
      }

      // Quad indices for this path
      for (let i = 0; i < N - 1; i++) {
        const a = baseVertex + i * 2;
        const b = a + 1;
        const c = a + 2;
        const d = a + 3;
        indices.push(a, b, c, b, d, c);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
    geo.setAttribute("normal",   new THREE.BufferAttribute(new Float32Array(normals), 3));
    geo.setAttribute("uv",       new THREE.BufferAttribute(new Float32Array(uvs), 2));
    geo.setIndex(indices);
    return geo;
  }

  private _buildMaterial(): THREE.Material {
    if (gpuTier === 'low') {
      return new THREE.MeshBasicMaterial({
        color: 0x4a7a9b,
        transparent: true,
        opacity: 0.7,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
    }

    const highDetail = gpuTier === 'high' ? 1.0 : 0.0;

    return new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        uTime: U.uTime,
        uHighDetail: { value: highDetail },
        uSun: U.uSun,
      },
      vertexShader: `
varying vec2 vUv;
varying vec3 vWorldNormal;
varying vec3 vWorldPos;

void main() {
  vUv = uv;
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldPos = worldPos.xyz;
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}`,
      fragmentShader: `
uniform float uTime;
uniform float uHighDetail;
uniform vec3 uSun;

varying vec2 vUv;
varying vec3 vWorldNormal;
varying vec3 vWorldPos;

void main() {
  // Flow speed: fast at source (vUv.y≈0, narrow), slow at mouth (vUv.y≈1, wide)
  float flowSpeed = mix(0.9, 0.2, vUv.y);
  float v = fract(vUv.y - uTime * flowSpeed);

  // Edge mask: centre=1, banks=0 — deep vs shallow colour
  float edgeMask = smoothstep(0.0, 0.25, vUv.x) * (1.0 - smoothstep(0.75, 1.0, vUv.x));
  vec3 deepColor    = vec3(0.02, 0.10, 0.26);  // rich deep blue
  vec3 shallowColor = vec3(0.08, 0.50, 0.56);  // bright teal at banks
  vec3 baseColor = mix(shallowColor, deepColor, edgeMask);

  vec3 viewDir = normalize(cameraPosition - vWorldPos);
  vec3 sunDir  = normalize(uSun);

  // Fresnel — brightens edges at grazing angles
  float fresnel = pow(1.0 - max(0.0, dot(viewDir, vWorldNormal)), 2.5);
  baseColor += vec3(0.18, 0.55, 0.68) * fresnel * 0.55;

  // Subsurface scatter fake: warm turquoise tint where shallow water is backlit
  float sss = (1.0 - edgeMask) * max(0.0, dot(sunDir, -vWorldNormal)) * 0.35;
  baseColor += vec3(0.10, 0.55, 0.50) * sss;

  // Dual-lobe specular: broad base gives water glow, sharp peak gives sun glint
  vec3 halfVec    = normalize(viewDir + sunDir);
  float NdotH     = max(0.0, dot(vWorldNormal, halfVec));
  float specBroad = pow(NdotH, 10.0) * 0.30;
  float specSharp = pow(NdotH, 72.0) * 1.00;
  baseColor += vec3(0.95, 0.98, 1.00) * (specBroad + specSharp);

  // Always-on shimmer: single cheap sin, gives medium tier some life
  float shimmer = sin(v * 9.0 + uTime * 2.2) * 0.5 + 0.5;
  baseColor += vec3(0.04, 0.10, 0.16) * shimmer * 0.18;

  // High-detail: second ripple frequency + bank foam
  float foam = 0.0;
  if (uHighDetail > 0.5) {
    float r2 = sin(v * 5.5 - uTime * 1.6 + vUv.x * 3.5) * 0.5 + 0.5;
    baseColor += vec3(0.06, 0.14, 0.20) * (shimmer * r2) * 0.18;
    // White foam at banks where water meets land
    foam = smoothstep(0.76, 0.92, vUv.x) + smoothstep(0.24, 0.08, vUv.x);
    baseColor = mix(baseColor, vec3(0.90, 0.96, 0.99), foam * 0.60);
  }

  float alpha = mix(0.68, 0.92, edgeMask) + fresnel * 0.07 + foam * 0.08;
  // Fade alpha at source (first 4%) and mouth (last 12%) — removes hard cut at both ends
  float endFade = smoothstep(0.0, 0.04, vUv.y) * smoothstep(1.0, 0.88, vUv.y);
  gl_FragColor = vec4(baseColor, clamp(alpha * endFade, 0.0, 0.96));
}`,
    });
  }
}
