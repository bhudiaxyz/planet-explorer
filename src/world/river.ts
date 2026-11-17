import * as THREE from "three";
import type { Planet } from "./planet";
import { S, CFG } from "../core/config";
import { U, WATER_DEEP, WATER_GRADE_GLSL, NOISE } from "../render/fx";
import { gpuTier } from "../render/gputier";
import { rng } from "../core/noise";
import { RIVER_NAMES } from "../core/names";

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
    const amp = (5 + rand() * 6) * ampMul * 1.25; // ×1.25: deeper bends (same draws, so each river keeps its course)

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

// center: unit-ish anchor at sea radius (for spacing tests) · radius: mesh extent (m) · level: water surface radius from the
// planet centre (m), the basin's spill height · seed: per-lake shoreline noise phase
type LakeDef = { center: THREE.Vector3; radius: number; level: number; seed: number };

// ---- Shaders ------------------------------------------------------------------

const RIVER_VERT = `
attribute float aSteep;
varying vec2 vUv;
varying vec3 vWorldNormal;
varying vec3 vWorldPos;
varying float vSteep;

void main() {
  vUv = uv;
  vSteep = aSteep;
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldPos = worldPos.xyz;
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}`;

const RIVER_FRAG = `
uniform float uTime;
uniform float uHighDetail;
uniform vec3 uSun;
uniform vec3 uWater; // palette water colour, shared with the ocean
${WATER_GRADE_GLSL}
#ifdef HI
${NOISE}
#endif

varying vec2 vUv;
varying vec3 vWorldNormal;
varying vec3 vWorldPos;
varying float vSteep; // bed steepness: 0 calm … 1 waterfall-grade drop (rapids / cascade)

void main() {
  bool isLake = vUv.y > 1.5;
  // lakeDist computed only for lake fragments — rivers skip the sqrt entirely.
  float lakeDist = 0.0;
  if (isLake) {
    lakeDist = length(cameraPosition - vWorldPos);
    if (lakeDist > 700.0) discard;
  }
  // Irregular banks (rivers): the water's edge wanders in and out by up to ~14 % of the width on each bank, with
  // world-position phases so the two banks and neighbouring rivers differ. Cheap sines on every tier; high adds noise.
  float bankL = 0.0, bankR = 1.0;
  if (!isLake) {
    vec3 bq = vWorldPos * 0.21;
    float wob = sin(bq.x + sin(bq.z * 1.3)) * 0.5 + sin(bq.z * 2.1 + bq.y * 1.7) * 0.3;
    float wob2 = sin(bq.z + sin(bq.x * 1.1 + 2.0)) * 0.5 + sin(bq.x * 1.9 - bq.y * 1.3) * 0.3;
#ifdef HI
    wob  += (vn(vWorldPos * 0.9) - 0.5) * 0.8;
    wob2 += (vn(vWorldPos * 0.9 + vec3(7.1, 3.3, 1.9)) - 0.5) * 0.8;
#endif
    bankL = 0.07 + 0.07 * wob;
    bankR = 0.93 - 0.07 * wob2;
    if (vUv.x < bankL || vUv.x > bankR) discard;
  }
  float ux = isLake ? vUv.x : (vUv.x - bankL) / (bankR - bankL); // across-stream 0..1 inside the wandering banks
  float edgeMask = smoothstep(0.0, 0.25, ux) * (1.0 - smoothstep(0.75, 1.0, ux));
  // item 12: centre flows faster than banks (natural hydraulics); lake speed unaffected
  float flowSpeed = mix(0.9, 0.2, clamp(vUv.y, 0.0, 1.0)) * (isLake ? 1.0 : 1.0 + edgeMask * 0.4);
  flowSpeed *= 1.0 + vSteep * 2.5; // steep reaches race
  // Lake: expanding concentric ripple rings outward from centre (vUv.x=0.5→1.0).
  // River: normal downstream flow.
  float v = isLake
    ? fract((vUv.x - 0.5) * 7.0 - uTime * 0.5)
    : fract(vUv.y - uTime * flowSpeed);
  // same palette-driven shades as the ocean (render/fx.ts waterFx), so rivers meet the sea without a colour step
  vec3 deepColor    = uWater * ${WATER_DEEP};
  vec3 shallowColor = uWater;
  vec3 baseColor = mix(shallowColor, deepColor, edgeMask);

  vec3 viewDir = normalize(cameraPosition - vWorldPos);
  vec3 sunDir  = normalize(uSun);

  float fresnel = pow(1.0 - max(0.0, dot(viewDir, vWorldNormal)), 2.5);
  baseColor += min(uWater * 2.2 + 0.02, vec3(1.0)) * fresnel * 0.45; // sky-lit sheen in the water's own hue

  float sss = (1.0 - edgeMask) * max(0.0, dot(sunDir, -vWorldNormal)) * 0.35;
  baseColor += min(uWater * 1.6, vec3(1.0)) * sss;

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
    // bank foam follows the wandering edge (ux); lakes get none — a fixed-radius foam ring would redraw the disc outline
    foam = isLake ? 0.0 : smoothstep(0.76, 0.92, ux) + smoothstep(0.24, 0.08, ux);
#ifdef HI
    if (!isLake) {
      // flow-aligned noise: bank foam breaks into drifting clumps, and long streaks trail down the centre
      float fn = vn(vec3(vUv.x * 6.0, vUv.y * 40.0 - uTime * flowSpeed * 1.5, uTime * 0.1));
      foam *= 0.45 + 0.9 * fn;
      foam += smoothstep(0.72, 0.9, fn) * (1.0 - edgeMask * 0.6) * 0.35;
      // shallow margins show a lighter, warmer bed through the water
      baseColor = mix(baseColor, baseColor * vec3(1.18, 1.12, 0.95), (1.0 - edgeMask) * 0.35);
    }
#endif
    baseColor = mix(baseColor, vec3(0.90, 0.96, 0.99), clamp(foam, 0.0, 1.0) * 0.60);
  }

  // Cascades: on steep reaches the whole width churns white — fast streaks stretched along the flow, broken up
  // across it, plus a bright crest where the slope peaks. Every non-low tier (low uses the basic material).
  float white = 0.0;
  if (vSteep > 0.02) {
    float s1 = fract(vUv.y * 46.0 - uTime * 3.4 + sin(vUv.x * 9.0) * 0.6);
    float s2 = fract(vUv.y * 71.0 - uTime * 5.1 + vUv.x * 4.3);
    float streak = smoothstep(0.55, 1.0, s1) + smoothstep(0.62, 1.0, s2) * 0.7;
    white = clamp(vSteep * (0.45 + streak * 0.7), 0.0, 1.0);
    baseColor = mix(baseColor, vec3(0.92, 0.96, 1.0), white);
  }

  float alpha = mix(0.68, 0.92, edgeMask) + fresnel * 0.07 + foam * 0.08 + white * 0.25;
  // Lake: shore fade (vUv.x) × distance fade (500–700 m). River: source/mouth end fades.
  // Lake: the shoreline is where the terrain rises through the level sheet, so only the sheet's own overshoot edge
  // (≥ 115 % of the basin radius, normally buried in the rim) fades, with a noisy fringe in case a rim gap exposes it.
  // River: soft bank lip inside the wandering edge, plus source/mouth end fades.
  float lip = isLake
    ? 1.0 - smoothstep(0.9 + 0.04 * sin(atan(vWorldPos.z, vWorldPos.x) * 23.0), 1.0, vUv.x)
    : smoothstep(0.0, 0.1, ux) * smoothstep(1.0, 0.9, ux);
  float endFade = isLake
    ? lip * (1.0 - smoothstep(500.0, 700.0, lakeDist))
    : lip * smoothstep(0.0, 0.04, vUv.y) * smoothstep(1.0, 0.88, vUv.y);
  // same final grade as the ocean (render/fx.ts waterGrade): rich palette-hued blue, foam and rapids stay white.
  // This ShaderMaterial writes linear colour (Three tone-maps / converts after main), so grade against linear uWater.
  baseColor = waterGrade(baseColor, uWater, clamp(max(foam * 0.6, white), 0.0, 1.0));
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
        // Longer rivers, with variety: move each source a random 0–25 steps (≤ 250 m) uphill toward the ranges, so most
        // rivers rise further from the coast; a random per-river step budget (0.85–1.6×) then lets some run on much
        // further than others. Own random stream: the draws above (and so which sources exist) are unchanged.
        const lenRand = rng(S.seed + 3131),
            riverSteps = new Map<THREE.Vector3, number>();
        for (const src of sources) {
            const before = src.clone();
            this._climb(src, planet, R, Math.floor(lenRand() * 26));
            // keep the 40° source spacing: a climb that drifts toward another source is undone
            if (sources.some((o) => o !== src && o.dot(src) > cosMin)) src.copy(before);
            riverSteps.set(src, Math.ceil(tierMaxSteps * (0.85 + lenRand() * 0.75)));
        }
        // Mountain streams (medium/high): extra sources high in the ranges, so uplands get running water of their own,
        // not just the top reaches of the 4 main rivers. Own random stream, so the main rivers keep their courses.
        const mountainSources: THREE.Vector3[] = [];
        if (gpuTier !== "low") {
            const mrand = rng(S.seed + 4242),
                cosMtn = Math.cos((18 * Math.PI) / 180); // closer spacing than main sources (40°): they are short
            for (let tries = 0; mountainSources.length < 3 && tries < 600; tries++) {
                await mayYield();
                const u = mrand() * 2 - 1,
                    phi = mrand() * Math.PI * 2,
                    r = Math.sqrt(1 - u * u);
                _scratch.src.set(r * Math.cos(phi), u, r * Math.sin(phi));
                const elev = planet.elevationAt(_scratch.src.x, _scratch.src.y, _scratch.src.z, false);
                if (elev < 0.3 || elev > 0.6) continue; // high ground, below the bare summits
                if (planet.moistureAt(_scratch.src) < cfg.sourceMinMoisture - 0.1) continue;
                if ([...sources, ...mountainSources].some((s) => s.dot(_scratch.src) > cosMtn)) continue;
                mountainSources.push(_scratch.src.clone());
            }
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
            const main = this._tracePath(src, planet, R, riverSteps.get(src) ?? tierMaxSteps);
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

        // Mountain streams join the tributary pool: the stricter overlap cull below drops any that just retrace an
        // existing river, and they never displace a main river. Narrow "stream" look, ≤ 40 % of a main river's length
        // (they spill into a larger river or a valley floor, not all the way to the sea).
        for (const src of mountainSources) {
            await mayYield();
            const p = this._tracePath(src, planet, R, Math.ceil(tierMaxSteps * 0.4));
            if (p.length < 6) continue;
            tribPaths.push(p);
            tribScales.push(archW("stream") * 1.1);
            tribMeanders.push(archM("stream") * 1.4);
            tribArchetypes.push("stream");
        }

        // Drop paths whose waypoints fall too close to an already-accepted path.
        // Uses distanceToSquared (no sqrt) with early-exit on first close point.
        // 16 m threshold = just wider than max ribbon half-width (9 m / 2 + margin).
        const thSq = 16 * 16;
        const overlaps = (candidate: THREE.Vector3[], pool: THREE.Vector3[][], maxFrac: number) => {
            let n = 0;
            for (const pt of candidate) if (pool.some((acc) => acc.some((op) => pt.distanceToSquared(op) < thSq))) n++;
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
            // Terminal lakes: a river that ends on land stopped in a real basin (_tracePath gives up after 6 stuck
            // steps), so pond the water there — the river then visibly flows into its lake instead of just stopping.
            // Checked first, so they take priority over the random lowland lakes; no random draws (sources unchanged).
            for (const p of accepted) {
                const end = p[p.length - 1].clone().normalize();
                if (planet.elevationAt(end.x, end.y, end.z, false) <= 0) continue; // reached the sea
                const basin = this._findBasin(end, planet, R, 35 + ((p.length * 7) % 30));
                if (!basin) continue;
                if (lakes.some((l) => l.center.clone().normalize().angleTo(basin.dir) < 120 / R)) continue;
                lakes.push({
                    center: basin.dir.clone().multiplyScalar(R),
                    radius: basin.radius,
                    level: basin.level,
                    seed: p.length * 13.7,
                });
                if (lakes.length >= 4) break;
            }
            let pa = 0;
            // basins are rarer than "any low moist spot": more tries (each is ~40 descent + 64 rim samples, still a few ms)
            const lowlandStart = lakes.length; // up to 2 lowland lakes of their own, whatever the terminal pass found
            while (lakes.length - lowlandStart < 2 && pa++ < 300) {
                await mayYield();
                const u2 = rand() * 2 - 1,
                    phi2 = rand() * Math.PI * 2;
                const r2 = Math.sqrt(1 - u2 * u2);
                _scratch.src.set(r2 * Math.cos(phi2), u2, r2 * Math.sin(phi2));
                const elev = planet.elevationAt(_scratch.src.x, _scratch.src.y, _scratch.src.z, false);
                if (elev < 0.005 || elev > 0.07) continue;
                if (planet.moistureAt(_scratch.src) < 0.45) continue;
                const basin = this._findBasin(_scratch.src, planet, R, 50 + rand() * 70);
                if (!basin) continue; // open or sloping ground: no depression to hold water
                const ctr = basin.dir.clone().multiplyScalar(R);
                if (accepted.some((p) => p.some((pt) => ctr.distanceToSquared(pt) < lakeThSq))) continue;
                if (lakes.some((pd) => pd.center.distanceToSquared(ctr) < lakeThSq)) continue;
                lakes.push({
                    center: ctr,
                    radius: basin.radius,
                    level: basin.level,
                    seed: rand() * 1000,
                });
            }
            // Mountain tarns: up to 3 small lakes in high hollows (cirques, saddles between ridges). Own random stream so
            // the lowland lakes above are unchanged. Same basin test — only real depressions hold water. Distances are
            // compared on the unit sphere: at altitude the river points sit 20–40 m above the sea-radius anchor.
            const trand = rng(S.seed + 5151),
                tarnSep = 90 / R, // angular separation (≈ 90 m) from rivers and other lakes
                farFrom = (d: THREE.Vector3, pts: THREE.Vector3[]) =>
                    pts.every((p) => d.angleTo(p) > tarnSep);
            let tarns = 0;
            for (let tries = 0; tarns < 3 && tries < 400; tries++) {
                await mayYield();
                const u2 = trand() * 2 - 1,
                    phi2 = trand() * Math.PI * 2,
                    r2 = Math.sqrt(1 - u2 * u2);
                _scratch.src.set(r2 * Math.cos(phi2), u2, r2 * Math.sin(phi2));
                const elev = planet.elevationAt(_scratch.src.x, _scratch.src.y, _scratch.src.z, false);
                if (elev < 0.22 || elev > 0.5) continue; // uplands → high ground, below bare summits
                const basin = this._findBasin(_scratch.src, planet, R, 25 + trand() * 30);
                if (!basin) continue;
                if (!farFrom(basin.dir, lakes.map((l) => l.center))) continue;
                if (!accepted.every((p) => farFrom(basin.dir, p))) continue;
                lakes.push({
                    center: basin.dir.clone().multiplyScalar(R),
                    radius: basin.radius,
                    level: basin.level,
                    seed: trand() * 1000,
                });
                tarns++;
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

    /** Move unit direction `d` (in place) up to `steps` × stepSize uphill — steepest ascent, stopping at a summit. */
    private _climb(d: THREE.Vector3, planet: Planet, R: number, steps: number) {
        const stepRad = CFG.river.stepSize / R,
            { up, ref, east, north, nbr } = _scratch.path;
        let h = planet.elevationAt(d.x, d.y, d.z, false);
        for (let s = 0; s < steps; s++) {
            up.copy(d);
            ref.set(Math.abs(up.y) < 0.9 ? 1 : 0, 0, Math.abs(up.y) < 0.9 ? 0 : 1);
            east.crossVectors(up, ref).normalize();
            north.crossVectors(east, up).normalize();
            let best = h,
                ba = -1;
            for (const a of DIRS) {
                nbr.copy(d)
                    .addScaledVector(east, Math.cos(a) * stepRad)
                    .addScaledVector(north, Math.sin(a) * stepRad)
                    .normalize();
                const hn = planet.elevationAt(nbr.x, nbr.y, nbr.z, false);
                if (hn > best) {
                    best = hn;
                    ba = a;
                }
            }
            if (ba < 0 || best > 0.6) break; // summit, or into the bare peaks (no springs up there)
            d.addScaledVector(east, Math.cos(ba) * stepRad).addScaledVector(north, Math.sin(ba) * stepRad).normalize();
            h = best;
        }
    }

    /**
     * Find a basin that can hold a lake near `start` (unit direction). Walks downhill to the local low point, then reads
     * the ground on a ring at the planned radius: the water level is the ring's lowest point (the spill height) less a
     * margin, so the lake fills the depression and its visible shore is the terrain's own contour line. Returns null
     * when the low point is too shallow (open or sloping ground would show a flat sheet cutting the hillside).
     */
    private _findBasin(
        start: THREE.Vector3,
        planet: Planet,
        R: number,
        radius: number
    ): { dir: THREE.Vector3; level: number; radius: number } | null {
        const amp = S.amplitude,
            hAt = (d: THREE.Vector3) => R + planet.elevationAt(d.x, d.y, d.z, false) * amp;
        // 1) descend to the local low point (8 directions, 6 m steps)
        const cur = start.clone().normalize(),
            step = 6 / R,
            nb = new THREE.Vector3(),
            up = new THREE.Vector3(),
            east = new THREE.Vector3(),
            north = new THREE.Vector3();
        let h = hAt(cur);
        for (let it = 0; it < 40; it++) {
            up.copy(cur);
            east.crossVectors(up, Math.abs(up.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).normalize();
            north.crossVectors(east, up);
            let best = h,
                bx = 0,
                by = 0;
            for (const a of DIRS) {
                nb.copy(cur)
                    .addScaledVector(east, Math.cos(a) * step)
                    .addScaledVector(north, Math.sin(a) * step)
                    .normalize();
                const hn = hAt(nb);
                if (hn < best) {
                    best = hn;
                    bx = Math.cos(a);
                    by = Math.sin(a);
                }
            }
            if (best >= h) break;
            cur.addScaledVector(east, bx * step).addScaledVector(north, by * step).normalize();
            h = best;
        }
        if (h - R < 0.4) return null; // at / below the sea: that is the ocean's job
        // 2) spill height: lowest ground on rings at 60 % and 100 % of the radius (a gap in either lets water out)
        up.copy(cur);
        east.crossVectors(up, Math.abs(up.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).normalize();
        north.crossVectors(east, up);
        let rim = Infinity;
        for (const f of [0.6, 1]) {
            for (let i = 0; i < 32; i++) {
                const a = (i / 32) * Math.PI * 2;
                nb.copy(cur)
                    .multiplyScalar(R)
                    .addScaledVector(east, Math.cos(a) * radius * f)
                    .addScaledVector(north, Math.sin(a) * radius * f)
                    .normalize();
                rim = Math.min(rim, hAt(nb));
            }
        }
        const level = rim - 0.25; // a little under the spill point so the shore never touches the rim
        if (level - h < 0.6) return null; // too shallow to read as a lake
        return { dir: cur, level, radius };
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
        // flow direction (tangent, unit) of the last step. Momentum used to compare *positions* (nbr · prev ≈ 1 for every
        // neighbour), so it never acted and rivers zig-zagged in place inside pits until maxSteps.
        const flow = new THREE.Vector3();
        let hasFlow = false,
            stuck = 0,
            seaSteps = 0;

        for (let step = 0; step < maxSteps; step++) {
            const curElev = planet.elevationAt(cur.x, cur.y, cur.z, false);
            // Clamp to sea level so the ribbon doesn't sink below the ocean floor
            const surfElev = Math.max(0, curElev);
            path.push(cur.clone().multiplyScalar(R + surfElev * S.amplitude + cfg.surfaceOffset));

            // Reached the sea: run 3 more steps out over the water so the ribbon's end fade happens on the sea, and the
            // river visibly pours into it instead of ending at the waterline.
            if (curElev <= 0 && ++seaSteps > 3) break;
            if (seaSteps > 0 && hasFlow) {
                cur = cur.clone().addScaledVector(flow, stepRad).normalize();
                continue;
            }

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
                const nElev = planet.elevationAt(_scratch.path.nbr.x, _scratch.path.nbr.y, _scratch.path.nbr.z, false);
                // momentum: small penalty for turning away from the current flow, prevents zigzag on flat terrain.
                // off is the step vector (tangent), so off·flow / stepRad is the cosine of the turn (1 straight, -1 back).
                const momentum = hasFlow ? (1 - _scratch.path.off.dot(flow) / stepRad) * 0.006 : 0;
                const score = nElev + momentum;
                if (score < bestScore) {
                    bestScore = score;
                    bestDir = _scratch.path.nbr.clone(); // clone only the winner
                }
            }

            if (!bestDir) break;
            // Pit: every neighbour is higher. Breach it by carrying on downstream (rivers cut through low saddles);
            // after 6 stuck steps it is a real basin, so the river ends there — a lake site (see _generatePaths).
            if (bestScore > curElev + 0.0005 && hasFlow) {
                if (++stuck > 6) break;
                bestDir = cur.clone().addScaledVector(flow, stepRad).normalize();
            } else stuck = 0;
            flow.copy(bestDir).sub(cur);
            flow.addScaledVector(cur, -flow.dot(cur)).normalize(); // keep it tangent to the sphere
            hasFlow = true;
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
                const nElev = planet.elevationAt(_scratch.path.nbr.x, _scratch.path.nbr.y, _scratch.path.nbr.z, false);
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

    private _buildGeometry(paths: THREE.Vector3[][], scales: number[], lakes: LakeDef[]): THREE.BufferGeometry {
        const cfg = CFG.river;
        const positions: number[] = [];
        const normals: number[] = [];
        const uvs: number[] = [];
        const steeps: number[] = [];
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
                const width = (cfg.widthStart + (cfg.widthEnd - cfg.widthStart) * (t * t)) * taper * scales[pi];
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
                // bed steepness over ±2 points (≈ ±20 m): drop / run, mapped so ≥ 0.3 (a waterfall-grade reach) is 1
                const a0 = Math.max(0, i - 2),
                    a1 = Math.min(N - 1, i + 2),
                    drop = path[a0].length() - path[a1].length(),
                    run = path[a0].distanceTo(path[a1]) || 1,
                    steep = THREE.MathUtils.smoothstep(drop / run, 0.08, 0.3);

                // Left vertex
                positions.push(_scratch.geo.left.x, _scratch.geo.left.y, _scratch.geo.left.z);
                normals.push(_scratch.geo.normal.x, _scratch.geo.normal.y, _scratch.geo.normal.z);
                uvs.push(0, v);
                steeps.push(steep);

                // Right vertex
                positions.push(_scratch.geo.rightPt.x, _scratch.geo.rightPt.y, _scratch.geo.rightPt.z);
                normals.push(_scratch.geo.normal.x, _scratch.geo.normal.y, _scratch.geo.normal.z);
                uvs.push(1, v);
                steeps.push(steep);
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

        // Lakes: a flat sheet at the basin's water level (a spherical cap, so it stays level on the curved planet). The
        // terrain rises through it around the edge, so the visible shoreline is the ground's own contour line — no
        // polygon outline. The sheet is a polar grid (RINGS × SEGS) so its edge is round, and the outer ring overshoots
        // into the rim, hidden under the ground. vUv.x: 0.5 centre → 1.0 edge (depth tint / ripples); vUv.y = 2 marks lakes.
        const SEGS = 96,
            RINGS = 6;
        for (const lake of lakes) {
            const norm = lake.center.clone().normalize();
            const ref = Math.abs(norm.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
            const east = new THREE.Vector3().crossVectors(norm, ref).normalize();
            const north = new THREE.Vector3().crossVectors(east, norm).normalize();
            const base = positions.length / 3,
                pt = new THREE.Vector3(),
                R = lake.center.length();
            const put = (rr: number, a: number) => {
                pt.copy(norm)
                    .multiplyScalar(R)
                    .addScaledVector(east, Math.cos(a) * rr)
                    .addScaledVector(north, Math.sin(a) * rr)
                    .normalize();
                normals.push(pt.x, pt.y, pt.z);
                pt.multiplyScalar(lake.level);
                positions.push(pt.x, pt.y, pt.z);
                uvs.push(0.5 + 0.5 * (rr / (lake.radius * 1.15)), 2.0);
                steeps.push(0);
            };
            put(0, 0);
            for (let r = 1; r <= RINGS; r++)
                for (let i = 0; i < SEGS; i++) put((r / RINGS) * lake.radius * 1.15, (i / SEGS) * Math.PI * 2);
            for (let i = 0; i < SEGS; i++) indices.push(base, base + 1 + i, base + 1 + ((i + 1) % SEGS));
            for (let r = 1; r < RINGS; r++)
                for (let i = 0; i < SEGS; i++) {
                    const a = base + 1 + (r - 1) * SEGS + i,
                        b = base + 1 + (r - 1) * SEGS + ((i + 1) % SEGS),
                        c = a + SEGS,
                        d = b + SEGS;
                    indices.push(a, c, b, b, c, d);
                }
        }

        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
        geo.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(normals), 3));
        geo.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(uvs), 2));
        geo.setAttribute("aSteep", new THREE.BufferAttribute(new Float32Array(steeps), 1));
        geo.setIndex(indices);
        return geo;
    }

    private _buildMaterial(): THREE.Material {
        if (gpuTier === "low") {
            const m = new THREE.MeshBasicMaterial({
                transparent: true,
                opacity: 0.7,
                depthWrite: false,
                side: THREE.DoubleSide,
            });
            m.color = U.uWater.value; // same colour object as the ocean: follows palette swaps
            return m;
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
                uWater: U.uWater,
                uN3: U.uN3,
            },
            defines: gpuTier === "high" ? { HI: "" } : {},
            vertexShader: RIVER_VERT,
            fragmentShader: RIVER_FRAG,
        });
    }
}
