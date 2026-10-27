import * as THREE from "three";
import type { Planet } from "./planet";
import { S, CFG } from "./config";
import { U } from "./fx";
import { gpuTier } from "./gputier";
import { rng } from "./noise";
import { RIVER_NAMES } from "./names";

// Chaikin corner-cutting: replaces each segment with two points at 1/4 and 3/4,
// preserving the first and last point so source/mouth stay in place.
function chaikin(pts: THREE.Vector3[], rounds: number): THREE.Vector3[] {
  let p = pts;
  for (let r = 0; r < rounds; r++) {
    // Pre-allocate: each round produces 2*(N-1)+2 points
    const out: THREE.Vector3[] = new Array(2 * (p.length - 1) + 2);
    out[0] = p[0];
    let wi = 1;
    for (let i = 0; i < p.length - 1; i++) {
      out[wi++] = p[i].clone().lerp(p[i + 1], 0.25);
      out[wi++] = p[i].clone().lerp(p[i + 1], 0.75);
    }
    out[wi] = p[p.length - 1];
    p = out;
  }
  return p;
}

// ---- Module-level scratch pools -----------------------------------------------
// Grouped by usage so it's obvious what each set is for.

// Path tracing (tracePath / tracePathToTarget inner loop)
const _scratch = {
  path: {
    up: new THREE.Vector3(),
    east: new THREE.Vector3(),
    north: new THREE.Vector3(),
    ref: new THREE.Vector3(),
    off: new THREE.Vector3(),
    nbr: new THREE.Vector3(),
  },
  // Tributary junction math (~7 allocs × 12 tributaries per build)
  trib: {
    jPt: new THREE.Vector3(),
    fPrev: new THREE.Vector3(),
    fNext: new THREE.Vector3(),
    fDir: new THREE.Vector3(),
    right: new THREE.Vector3(),
    start: new THREE.Vector3(),
  },
  // Source-finding loop (up to 500 attempts)
  src: new THREE.Vector3(),
  // addMeanders (one alloc per path point → now zero)
  meander: {
    sn: new THREE.Vector3(),
    tangent: new THREE.Vector3(),
    right: new THREE.Vector3(),
  },
  // _buildGeometry ribbon edges (two allocs per vertex → now zero)
  geo: {
    tangent: new THREE.Vector3(),
    normal: new THREE.Vector3(),
    right: new THREE.Vector3(),
    left: new THREE.Vector3(),
    rightPt: new THREE.Vector3(),
  },
};

// Sinusoidal lateral displacement to create natural meanders.
// Applied before Chaikin so the smoothing blends the curves naturally.
// Envelope fades in at source (t<0.2) and out at mouth (t>0.85).

function addMeanders(pts: THREE.Vector3[], rand: () => number, ampMul = 1): THREE.Vector3[] {
  if (pts.length < 4) return pts;
  const phase = rand() * Math.PI * 2;
  const phase2 = rand() * Math.PI * 2;
  const freq1 = 0.08 + rand() * 0.07; // primary wave — controls bend spacing in metres
  const ratio = 1.4 + rand() * 0.6; // item 9: secondary ratio varies 1.4–2.0× per river
  const freq2 = freq1 * ratio + rand() * 0.04;
  const amp = (5 + rand() * 6) * ampMul;

  // item 7: precompute arc lengths so bend frequency is consistent regardless of step density
  const arcLen: number[] = [0];
  for (let i = 1; i < pts.length; i++) arcLen.push(arcLen[i - 1] + pts[i].distanceTo(pts[i - 1]));
  const totalLen = arcLen[arcLen.length - 1] || 1;

  return pts.map((pt, i) => {
    const t = i / (pts.length - 1);
    const s = arcLen[i] / totalLen;
    // item 8: noise-based envelope — sin(s·π) naturally fades to 0 at both ends; second term
    // breaks the symmetric peak into irregular undulation without losing the end-fades.
    const env = Math.pow(Math.sin(s * Math.PI), 0.7) * (0.7 + 0.3 * Math.sin(s * Math.PI * 2.3 + 0.9));
    const terrainFactor = 0.4 + t * 0.6;
    const disp =
      (Math.sin(arcLen[i] * freq1 + phase) * 0.7 + Math.sin(arcLen[i] * freq2 + phase2) * 0.3) *
      amp *
      env *
      terrainFactor;
    if (Math.abs(disp) < 0.01) return pt;
    const { sn, tangent, right } = _scratch.meander;
    sn.copy(pt).normalize();
    const next = pts[Math.min(i + 1, pts.length - 1)];
    const prev = pts[Math.max(i - 1, 0)];
    tangent.copy(next).sub(prev).normalize();
    right.crossVectors(tangent, sn).normalize();
    return pt.clone().addScaledVector(right, disp);
  });
}

// Pick a river name seeded by path index + world seed so it's stable per planet
function riverName(index: number): string {
  return RIVER_NAMES[Math.abs(S.seed + index * 7) % RIVER_NAMES.length];
}

// Hoisted — rebuilt per call previously, wasting 1080+ short-lived arrays on a full planet build
const DIRS = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => (i * Math.PI) / 4);

const yieldFrame = () => new Promise<void>((r) => setTimeout(r));

type LakeDef = { center: THREE.Vector3; radius: number; aspect: number };

// ---- Shaders ------------------------------------------------------------------

const RIVER_VERT = `
varying vec2 vUv;
varying vec3 vWorldNormal;
varying vec3 vWorldPos;

void main() {
  vUv = uv;
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldPos = worldPos.xyz;
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}`;

const RIVER_FRAG = `
uniform float uTime;
uniform float uHighDetail;
uniform vec3 uSun;

varying vec2 vUv;
varying vec3 vWorldNormal;
varying vec3 vWorldPos;

void main() {
  bool isLake = vUv.y > 1.5;
  // lakeDist computed only for lake fragments — rivers skip the sqrt entirely.
  float lakeDist = 0.0;
  if (isLake) {
    lakeDist = length(cameraPosition - vWorldPos);
    if (lakeDist > 700.0) discard;
  }
  float edgeMask = smoothstep(0.0, 0.25, vUv.x) * (1.0 - smoothstep(0.75, 1.0, vUv.x));
  // item 12: centre flows faster than banks (natural hydraulics); lake speed unaffected
  float flowSpeed = mix(0.9, 0.2, clamp(vUv.y, 0.0, 1.0)) * (isLake ? 1.0 : 1.0 + edgeMask * 0.4);
  // Lake: expanding concentric ripple rings outward from centre (vUv.x=0.5→1.0).
  // River: normal downstream flow.
  float v = isLake
    ? fract((vUv.x - 0.5) * 7.0 - uTime * 0.5)
    : fract(vUv.y - uTime * flowSpeed);
  vec3 deepColor    = vec3(0.02, 0.10, 0.26);
  vec3 shallowColor = vec3(0.08, 0.50, 0.56);
  vec3 baseColor = mix(shallowColor, deepColor, edgeMask);

  vec3 viewDir = normalize(cameraPosition - vWorldPos);
  vec3 sunDir  = normalize(uSun);

  float fresnel = pow(1.0 - max(0.0, dot(viewDir, vWorldNormal)), 2.5);
  baseColor += vec3(0.18, 0.55, 0.68) * fresnel * 0.55;

  float sss = (1.0 - edgeMask) * max(0.0, dot(sunDir, -vWorldNormal)) * 0.35;
  baseColor += vec3(0.10, 0.55, 0.50) * sss;

  vec3 halfVec    = normalize(viewDir + sunDir);
  float NdotH     = max(0.0, dot(vWorldNormal, halfVec));
  float specBroad = pow(NdotH, 10.0) * 0.30;
  float specSharp = pow(NdotH, 72.0) * 1.00;
  baseColor += vec3(0.95, 0.98, 1.00) * (specBroad + specSharp);

  float shimmer = sin(v * 9.0 + uTime * 2.2) * 0.5 + 0.5;
  baseColor += vec3(0.04, 0.10, 0.16) * shimmer * 0.18;

  float foam = 0.0;
  // Lake foam skipped beyond 150 m — saves fill-rate when it's too small to see anyway.
  if (uHighDetail > 0.5 && (!isLake || lakeDist < 150.0)) {
    float r2 = sin(v * 5.5 - uTime * 1.6 + vUv.x * 3.5) * 0.5 + 0.5;
    baseColor += vec3(0.06, 0.14, 0.20) * (shimmer * r2) * 0.18;
    foam = smoothstep(0.76, 0.92, vUv.x) + smoothstep(0.24, 0.08, vUv.x);
    baseColor = mix(baseColor, vec3(0.90, 0.96, 0.99), foam * 0.60);
  }

  float alpha = mix(0.68, 0.92, edgeMask) + fresnel * 0.07 + foam * 0.08;
  // Lake: shore fade (vUv.x) × distance fade (500–700 m). River: source/mouth end fades.
  float endFade = isLake
    ? (1.0 - smoothstep(0.75, 1.0, vUv.x)) * (1.0 - smoothstep(500.0, 700.0, lakeDist))
    : smoothstep(0.0, 0.04, vUv.y) * smoothstep(1.0, 0.88, vUv.y);
  gl_FragColor = vec4(baseColor, clamp(alpha * endFade, 0.0, 0.96));
}`;

export class RiverSystem {
  mesh!: THREE.Mesh;
  paths!: THREE.Vector3[][];
  names!: string[];

  // Async factory — yields between sources so the browser can repaint during path generation
  static async build(planet: Planet): Promise<RiverSystem> {
    const rs = new RiverSystem();
    const { paths, scales, lakes } = await rs._generatePaths(planet);
    rs.paths = paths;
    rs.names = paths.map((_, i) => riverName(i));
    const geo = rs._buildGeometry(paths, scales, lakes);
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

  private async _generatePaths(
    planet: Planet
  ): Promise<{ paths: THREE.Vector3[][]; scales: number[]; lakes: LakeDef[] }> {
    const R = planet.radius;
    const cfg = CFG.river;
    // Reduce CPU path work on low-tier mobile (fewer rivers, shorter paths)
    const tierCount = gpuTier === "low" ? Math.max(2, Math.ceil(cfg.count / 2)) : cfg.count;
    const tierMaxSteps = gpuTier === "low" ? Math.ceil(cfg.maxSteps * 0.6) : cfg.maxSteps;
    const tierTributaries = gpuTier === "low" ? 1 : cfg.tributaries;
    const rand = rng(S.seed + 9999);
    const cosMin = Math.cos((cfg.minSourceSpacingDeg * Math.PI) / 180);

    // Time-based yielding: yield only when ≥4 ms has elapsed, same as findSpots.
    // Replaces 26 unconditional setTimeout calls (100–400 ms overhead on mobile).
    let _lastYield = performance.now();
    const mayYield = async () => {
      const t = performance.now();
      if (t - _lastYield >= 4) {
        await yieldFrame();
        _lastYield = performance.now();
      }
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
      _scratch.src.set(r * Math.cos(phi), u, r * Math.sin(phi));
      const elev = planet.elevationAt(_scratch.src.x, _scratch.src.y, _scratch.src.z, false);
      const moist = planet.moistureAt(_scratch.src);
      if (elev < cfg.sourceMinElev) continue;
      if (moist < cfg.sourceMinMoisture) continue;
      if (sources.some((s) => s.dot(_scratch.src) > cosMin)) continue;
      sources.push(_scratch.src.clone());
    }

    // River archetypes: stream = narrow/gentle, river = normal, wide = broad/meandering
    const ARCHETYPES = ["stream", "river", "river", "river", "wide"] as const;
    type Arch = (typeof ARCHETYPES)[number];
    const archW = (a: Arch) => (a === "stream" ? 0.38 : a === "wide" ? 1.45 : 1.0);
    const archM = (a: Arch) => (a === "stream" ? 0.25 : a === "wide" ? 1.9 : 1.0);

    const mainPaths: THREE.Vector3[][] = [];
    const mainScales: number[] = [],
      mainMeanders: number[] = [],
      mainArchetypes: string[] = [];
    const tribPaths: THREE.Vector3[][] = [];
    const tribScales: number[] = [],
      tribMeanders: number[] = [],
      tribArchetypes: string[] = [];
    // Tributaries use shorter paths — they're side branches, not full rivers
    const tribMaxSteps = Math.ceil(tierMaxSteps * 0.6);

    for (const src of sources) {
      await mayYield();
      const arch = ARCHETYPES[Math.floor(rand() * ARCHETYPES.length)];
      const ws = archW(arch),
        ms = archM(arch);
      const main = this._tracePath(src, planet, R, tierMaxSteps);
      if (main.length < 5) continue;
      mainPaths.push(main);
      mainScales.push(ws);
      mainMeanders.push(ms);
      mainArchetypes.push(arch);

      // Tributaries: evenly spread junctions across 20–65% of the main path
      for (let t = 0; t < tierTributaries; t++) {
        await mayYield();
        // Spread junctions evenly so tributaries don't all cluster at one point
        const frac = 0.2 + (t / Math.max(tierTributaries - 1, 1)) * 0.45 + (rand() - 0.5) * 0.08;
        const junctionIdx = Math.min(Math.floor(frac * main.length), main.length - 2);

        // Use the flow direction at the junction (not world-up) — works everywhere on sphere
        _scratch.trib.jPt.copy(main[junctionIdx]).normalize();
        _scratch.trib.fPrev.copy(main[Math.max(junctionIdx - 1, 0)]).normalize();
        _scratch.trib.fNext.copy(main[Math.min(junctionIdx + 1, main.length - 1)]).normalize();
        _scratch.trib.fDir.copy(_scratch.trib.fNext).sub(_scratch.trib.fPrev).normalize();
        _scratch.trib.right.crossVectors(_scratch.trib.fDir, _scratch.trib.jPt).normalize();

        // Alternate left/right, vary angle 15–30°
        const side = t % 2 === 0 ? 1 : -1;
        const angle = (15 + rand() * 15) * (Math.PI / 180) * side;
        // Step upstream and sideways from the junction to find a plausible tributary source
        _scratch.trib.start
          .copy(_scratch.trib.jPt)
          .addScaledVector(_scratch.trib.right, Math.sin(angle) * 0.18)
          .addScaledVector(_scratch.trib.fDir.negate(), 0.08) // negate in-place; _scratch.trib.fDir not used after
          .normalize();

        const tElev = planet.elevationAt(
          _scratch.trib.start.x,
          _scratch.trib.start.y,
          _scratch.trib.start.z,
          false
        );
        if (tElev > cfg.sourceMinElev * 0.4) {
          const trib = this._tracePathToTarget(
            _scratch.trib.start,
            main[junctionIdx],
            planet,
            R,
            tribMaxSteps
          );
          if (trib.length >= 4) {
            tribPaths.push(trib);
            tribScales.push(ws * 0.55); // tributaries narrower than their main river
            tribMeanders.push(ms * 0.7);
            tribArchetypes.push(arch);
          }
        }
      }
    }

    // Drop paths whose waypoints fall too close to an already-accepted path.
    // Uses distanceToSquared (no sqrt) with early-exit on first close point.
    // 16 m threshold = just wider than max ribbon half-width (9 m / 2 + margin).
    const thSq = 16 * 16;
    const overlaps = (candidate: THREE.Vector3[], pool: THREE.Vector3[][], maxFrac: number) => {
      let n = 0;
      for (const pt of candidate)
        if (pool.some((acc) => acc.some((op) => pt.distanceToSquared(op) < thSq))) n++;
      return n / candidate.length >= maxFrac;
    };

    // Main rivers: keep all; only cull a main if >50% of it duplicates an earlier main.
    const accepted: THREE.Vector3[][] = [];
    const acceptedScales: number[] = [],
      acceptedMeanders: number[] = [],
      acceptedArchetypes: string[] = [];
    for (let i = 0; i < mainPaths.length; i++) {
      if (!overlaps(mainPaths[i], accepted, 0.5)) {
        accepted.push(mainPaths[i]);
        acceptedScales.push(mainScales[i]);
        acceptedMeanders.push(mainMeanders[i]);
        acceptedArchetypes.push(mainArchetypes[i]);
      }
    }
    // Tributaries: stricter — cull if >40% overlaps any accepted path (main or trib).
    for (let i = 0; i < tribPaths.length; i++) {
      if (!overlaps(tribPaths[i], accepted, 0.4)) {
        accepted.push(tribPaths[i]);
        acceptedScales.push(tribScales[i]);
        acceptedMeanders.push(tribMeanders[i]);
        acceptedArchetypes.push(tribArchetypes[i]);
      }
    }

    // Lakes: 0–2 still water bodies in moist, low-lying depressions above sea level.
    // Skipped on low tier (no fancy shader there anyway).
    const lakes: LakeDef[] = [];
    if (gpuTier !== "low") {
      const lakeThSq = 120 * 120;
      let pa = 0;
      while (lakes.length < 2 && pa++ < 120) {
        const u2 = rand() * 2 - 1,
          phi2 = rand() * Math.PI * 2;
        const r2 = Math.sqrt(1 - u2 * u2);
        _scratch.src.set(r2 * Math.cos(phi2), u2, r2 * Math.sin(phi2));
        const elev = planet.elevationAt(_scratch.src.x, _scratch.src.y, _scratch.src.z, false);
        if (elev < 0.005 || elev > 0.07) continue;
        if (planet.moistureAt(_scratch.src) < 0.45) continue;
        const ctr = _scratch.src.clone().multiplyScalar(R);
        if (accepted.some((p) => p.some((pt) => ctr.distanceToSquared(pt) < lakeThSq))) continue;
        if (lakes.some((pd) => pd.center.distanceToSquared(ctr) < lakeThSq)) continue;
        lakes.push({ center: ctr, radius: 50 + rand() * 70, aspect: 0.55 + rand() * 0.9 });
      }
    }

    // Low tier: skip meanders + Chaikin (saves CPU + memory)
    // Medium/high: add sinusoidal meanders then smooth with Chaikin
    // item 11: streams get 3 Chaikin rounds for tighter curves; all others get 2
    // P7: yield between paths so this ~60k-operation synchronous block doesn't block the main thread
    if (gpuTier === "low") return { paths: accepted, scales: acceptedScales, lakes };
    const smoothed: THREE.Vector3[][] = [];
    for (let i = 0; i < accepted.length; i++) {
      await mayYield();
      smoothed.push(
        chaikin(addMeanders(accepted[i], rand, acceptedMeanders[i]), acceptedArchetypes[i] === "stream" ? 3 : 2)
      );
    }
    return { paths: smoothed, scales: acceptedScales, lakes };
  }

  private _tracePath(
    source: THREE.Vector3,
    planet: Planet,
    R: number,
    maxSteps: number = CFG.river.maxSteps
  ): THREE.Vector3[] {
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

      _scratch.path.up.copy(cur);
      if (Math.abs(_scratch.path.up.y) < 0.9) _scratch.path.ref.set(1, 0, 0);
      else _scratch.path.ref.set(0, 0, 1);
      _scratch.path.east.crossVectors(_scratch.path.up, _scratch.path.ref).normalize();
      _scratch.path.north.crossVectors(_scratch.path.east, _scratch.path.up).normalize();

      let bestScore = Infinity;
      let bestDir: THREE.Vector3 | null = null;
      for (const angle of DIRS) {
        _scratch.path.off
          .copy(_scratch.path.east)
          .multiplyScalar(Math.cos(angle) * stepRad)
          .addScaledVector(_scratch.path.north, Math.sin(angle) * stepRad);
        _scratch.path.nbr.copy(cur).add(_scratch.path.off).normalize();
        const nElev = planet.elevationAt(
          _scratch.path.nbr.x,
          _scratch.path.nbr.y,
          _scratch.path.nbr.z,
          false
        );
        // momentum: small bonus for continuing in the same direction, prevents zigzag on flat terrain
        const momentum = prevDir ? (1 - _scratch.path.nbr.dot(prevDir)) * 0.012 : 0;
        const score = nElev + momentum;
        if (score < bestScore) {
          bestScore = score;
          bestDir = _scratch.path.nbr.clone(); // clone only the winner
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
    maxSteps: number = CFG.river.maxSteps
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

      _scratch.path.up.copy(cur);
      if (Math.abs(_scratch.path.up.y) < 0.9) _scratch.path.ref.set(1, 0, 0);
      else _scratch.path.ref.set(0, 0, 1);
      _scratch.path.east.crossVectors(_scratch.path.up, _scratch.path.ref).normalize();
      _scratch.path.north.crossVectors(_scratch.path.east, _scratch.path.up).normalize();

      let bestScore = Infinity;
      let bestDir: THREE.Vector3 | null = null;
      for (const angle of DIRS) {
        _scratch.path.off
          .copy(_scratch.path.east)
          .multiplyScalar(Math.cos(angle) * stepRad)
          .addScaledVector(_scratch.path.north, Math.sin(angle) * stepRad);
        _scratch.path.nbr.copy(cur).add(_scratch.path.off).normalize();
        const nElev = planet.elevationAt(
          _scratch.path.nbr.x,
          _scratch.path.nbr.y,
          _scratch.path.nbr.z,
          false
        );
        const distToTarget = _scratch.path.nbr.distanceTo(targetN);
        const score = nElev * 0.7 + distToTarget * 0.3;
        if (score < bestScore) {
          bestScore = score;
          bestDir = _scratch.path.nbr.clone(); // clone only the winner
        }
      }

      if (!bestDir) break;
      cur = bestDir;
    }

    return path;
  }

  private _buildGeometry(
    paths: THREE.Vector3[][],
    scales: number[],
    lakes: LakeDef[]
  ): THREE.BufferGeometry {
    const cfg = CFG.river;
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    for (let pi = 0; pi < paths.length; pi++) {
      const path = paths[pi];
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
        // Taper from zero at source (first 15%) and back to zero at mouth (last 15%); widen quadratically between
        const taper = Math.min(t / 0.15, 1) * (t > 0.85 ? (1 - t) / 0.15 : 1);
        const width =
          (cfg.widthStart + (cfg.widthEnd - cfg.widthStart) * (t * t)) * taper * scales[pi];
        const halfW = width * 0.5;

        // Sphere normal = outward unit direction from centre
        _scratch.geo.normal.copy(path[i]).normalize();

        // Tangent: direction of flow
        if (i < N - 1)
          _scratch.geo.tangent
            .copy(path[i + 1])
            .sub(path[i])
            .normalize();
        else
          _scratch.geo.tangent
            .copy(path[i])
            .sub(path[i - 1])
            .normalize();

        // Ribbon right = tangent × sphereNormal (cross gives perpendicular on sphere surface)
        _scratch.geo.right.crossVectors(_scratch.geo.tangent, _scratch.geo.normal).normalize();

        // Left and right vertices (scratch — avoids two clone() allocs per vertex)
        _scratch.geo.left.copy(path[i]).addScaledVector(_scratch.geo.right, -halfW);
        _scratch.geo.rightPt.copy(path[i]).addScaledVector(_scratch.geo.right, halfW);

        const v = arcLen[i] / totalLen;

        // Left vertex
        positions.push(_scratch.geo.left.x, _scratch.geo.left.y, _scratch.geo.left.z);
        normals.push(_scratch.geo.normal.x, _scratch.geo.normal.y, _scratch.geo.normal.z);
        uvs.push(0, v);

        // Right vertex
        positions.push(_scratch.geo.rightPt.x, _scratch.geo.rightPt.y, _scratch.geo.rightPt.z);
        normals.push(_scratch.geo.normal.x, _scratch.geo.normal.y, _scratch.geo.normal.z);
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

    // Lake discs — flat fans on the sphere surface.
    // UVs: vUv.x = radial distance (0.5 centre → 1.0 edge) so edgeMask gives deep centre / shallow edges.
    // vUv.y = 2.0 signals the lake branch in the fragment shader (ripple + shore fade).
    const LAKE_SEGS = 48;
    for (const lake of lakes) {
      const norm = lake.center.clone().normalize();
      const ref = Math.abs(norm.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
      const east = new THREE.Vector3().crossVectors(norm, ref).normalize();
      const north = new THREE.Vector3().crossVectors(east, norm).normalize();

      const base = positions.length / 3;
      // Centre vertex
      positions.push(lake.center.x, lake.center.y, lake.center.z);
      normals.push(norm.x, norm.y, norm.z);
      uvs.push(0.5, 2.0);

      // Perimeter vertices — item 10: two non-integer sine terms displace radius for organic shorelines
      for (let i = 0; i < LAKE_SEGS; i++) {
        const a = (i / LAKE_SEGS) * Math.PI * 2;
        const noiseR = 1.0 + 0.12 * Math.sin(a * 3.7 + 0.5) + 0.07 * Math.sin(a * 7.1 + 1.8);
        const pt = lake.center
          .clone()
          .addScaledVector(east, Math.cos(a) * lake.radius * noiseR)
          .addScaledVector(north, Math.sin(a) * lake.radius * lake.aspect * noiseR);
        positions.push(pt.x, pt.y, pt.z);
        normals.push(norm.x, norm.y, norm.z);
        uvs.push(1.0, 2.0);
      }

      // Fan triangles: centre + consecutive perimeter pairs
      for (let i = 0; i < LAKE_SEGS; i++)
        indices.push(base, base + 1 + i, base + 1 + ((i + 1) % LAKE_SEGS));
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(normals), 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(uvs), 2));
    geo.setIndex(indices);
    return geo;
  }

  private _buildMaterial(): THREE.Material {
    if (gpuTier === "low") {
      return new THREE.MeshBasicMaterial({
        color: 0x4a7a9b,
        transparent: true,
        opacity: 0.7,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
    }

    const highDetail = gpuTier === "high" ? 1.0 : 0.0;

    return new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        uTime: U.uTime,
        uHighDetail: { value: highDetail },
        uSun: U.uSun,
      },
      vertexShader: RIVER_VERT,
      fragmentShader: RIVER_FRAG,
    });
  }
}
